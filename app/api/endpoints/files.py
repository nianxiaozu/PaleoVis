"""文件管理接口：上传、列表、详情、删除、预览、下载、导出。"""
from __future__ import annotations

import io
import urllib.parse
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.api.deps import open_dataset
from app.api.schemas import ExportRequest
from app.core.config import settings
from app.core.errors import NotFoundError
from app.services.nc_processor import NCDataset
from app.services.storage import storage

router = APIRouter()


def _record(file_id: str):
    return storage.get(file_id)


@router.get("", summary="列出已加载的数据文件")
def list_files() -> dict:
    records = storage.list_records()
    return {
        "total": len(records),
        "files": [record.public() for record in records],
        "limits": {
            "max_upload_mb": settings.max_upload_mb,
            "allowed_suffixes": list(settings.allowed_suffixes),
        },
    }


@router.post("", summary="上传 NetCDF 文件")
async def upload_file(file: UploadFile = File(...)) -> dict:
    record = storage.save_stream(file.filename or "dataset.nc", file.file)
    payload = record.public()
    # 上传后立即解析一次，若无法打开则回滚，避免留下坏文件
    try:
        dataset = NCDataset(record.path, file_id=record.id, name=record.name)
        try:
            overview = dataset.overview(file_size=record.size)
        finally:
            dataset.close()
    except Exception as exc:
        storage.delete(record.id)
        raise HTTPException(status_code=400, detail=f"文件解析失败：{exc}") from exc
    payload["overview"] = overview
    return payload


@router.get("/{file_id}", summary="文件元信息（xarray 风格）")
def file_detail(file_id: str) -> dict:
    record = _record(file_id)
    dataset = NCDataset(record.path, file_id=record.id, name=record.name)
    try:
        return dataset.overview(file_size=record.size)
    finally:
        dataset.close()


@router.delete("/{file_id}", summary="删除文件")
def delete_file(file_id: str) -> dict:
    storage.delete(file_id)
    return {"deleted": True, "id": file_id}


@router.get("/{file_id}/download", summary="下载原始文件")
def download_file(file_id: str) -> FileResponse:
    record = _record(file_id)
    path = Path(record.path)
    if not path.exists():
        raise NotFoundError("文件不存在")
    return FileResponse(path, filename=record.name, media_type="application/x-netcdf")


@router.get("/{file_id}/preview/map", summary="空间分布预览图 (PNG)")
def preview_map(
    file_id: str,
    variable: str | None = Query(default=None),
    start: int | None = Query(default=None, ge=0),
    end: int | None = Query(default=None, ge=0),
    lat_min: float | None = Query(default=None),
    lat_max: float | None = Query(default=None),
    lon_min: float | None = Query(default=None),
    lon_max: float | None = Query(default=None),
    cmap: str | None = Query(default=None),
    refresh: bool = Query(default=False),
):
    record = _record(file_id)
    if refresh:
        for stale in settings.preview_dir.glob("*.png"):
            stale.unlink(missing_ok=True)
    dataset = NCDataset(record.path, file_id=record.id, name=record.name)
    try:
        path = dataset.render_map(
            variable,
            time_range=(start, end) if start is not None and end is not None else None,
            lat_range=(lat_min, lat_max) if lat_min is not None and lat_max is not None else None,
            lon_range=(lon_min, lon_max) if lon_min is not None and lon_max is not None else None,
            cmap=cmap,
        )
    finally:
        dataset.close()
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.get("/{file_id}/preview/series", summary="时序曲线预览图 (PNG)")
def preview_series(
    file_id: str,
    variable: str | None = Query(default=None),
    lat: float | None = Query(default=None),
    lon: float | None = Query(default=None),
    start: int | None = Query(default=None, ge=0),
    end: int | None = Query(default=None, ge=0),
):
    record = _record(file_id)
    dataset = NCDataset(record.path, file_id=record.id, name=record.name)
    try:
        path = dataset.render_series(
            variable,
            lat=lat,
            lon=lon,
            time_range=(start, end) if start is not None and end is not None else None,
        )
    finally:
        dataset.close()
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.post("/{file_id}/export", summary="导出子集（CSV / NetCDF）")
def export_subset(file_id: str, request: ExportRequest) -> Response:
    record = _record(file_id)
    dataset = NCDataset(record.path, file_id=record.id, name=record.name)
    try:
        time_range = (
            (request.start, request.end)
            if request.start is not None and request.end is not None
            else None
        )
        if request.format == "netcdf":
            path = dataset.export_netcdf(
                request.variable,
                time_range=time_range,
                lat_range=request.lat_pair,
                lon_range=request.lon_pair,
                level_index=request.level_index,
                lat_point=request.lat,
                lon_point=request.lon,
            )
            stem = Path(record.name).stem
            return FileResponse(
                path,
                media_type="application/x-netcdf",
                filename=f"{stem}_subset.nc",
            )

        subset = dataset.subset_dataset(
            request.variable,
            time_range=time_range,
            lat_range=request.lat_pair,
            lon_range=request.lon_pair,
            level_index=request.level_index,
            lat_point=request.lat,
            lon_point=request.lon,
        )
        csv_text = subset.to_dataframe().reset_index().to_csv(index=False)
    finally:
        dataset.close()

    stem = Path(record.name).stem
    filename = urllib.parse.quote(f"{stem}_subset.csv")
    return Response(
        content=csv_text.encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.get("/{file_id}/bundle", summary="打包下载当前文件与预览图")
def download_bundle(file_id: str) -> StreamingResponse:
    record = _record(file_id)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(record.path, arcname=record.name)
        dataset = NCDataset(record.path, file_id=record.id, name=record.name)
        try:
            map_path = dataset.render_map(None)
            archive.write(map_path, arcname="preview_map.png")
        finally:
            dataset.close()
    buffer.seek(0)
    stem = Path(record.name).stem
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={stem}.zip"},
    )
