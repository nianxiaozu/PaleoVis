"""数据集内容接口：概览、点位序列、区域平均、空间场。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.api.deps import extract_series_preprocessed, open_dataset, time_range_of
from app.api.schemas import PreprocessSpec, Selector
from app.services.nc_processor import NCDataset

router = APIRouter()


@router.get("/{file_id}/overview", summary="数据集概览")
def overview(file_id: str, dataset: NCDataset = Depends(open_dataset)) -> dict:
    return dataset.overview()


@router.get("/{file_id}/layout", summary="数据布局识别结果")
def layout(file_id: str, dataset: NCDataset = Depends(open_dataset)) -> dict:
    """返回数据集的布局类型与坐标轴识别结果。

    前端据此决定：是否显示地图视图、地图画什么、数据查询面板怎么布局。
    """
    overview = dataset.overview()
    return {
        "layout": overview["layout"],
        "axes": {
            "time": dataset.time_name,
            "lat": dataset.lat_name,
            "lon": dataset.lon_name,
            "level": dataset.level_name,
        },
        "axis_candidates": overview["axis_candidates"],
        "axis_overrides": overview["axis_overrides"],
        "variables": {
            name: {
                "layout": meta["layout"],
                "dimensions": meta["dimensions"],
                "units": meta["units"],
                "long_name": meta["long_name"],
            }
            for name, meta in overview["variables"].items()
        },
    }


@router.get("/{file_id}/variables", summary="变量列表")
def variables(file_id: str, dataset: NCDataset = Depends(open_dataset)) -> dict:
    return {
        "variables": [dataset.variable_meta(name) for name in dataset.data_vars],
        "coords": dataset.coord_names,
        "axes": {
            "lat": dataset.lat_name,
            "lon": dataset.lon_name,
            "time": dataset.time_name,
            "level": dataset.level_name,
        },
    }


@router.get("/{file_id}/series", summary="点位 / 区域平均时间序列（支持预处理）")
def series(
    file_id: str,
    variable: str | None = Query(default=None),
    lat: float | None = Query(default=None, ge=-90, le=90),
    lon: float | None = Query(default=None, ge=-180, le=360),
    lat_min: float | None = Query(default=None),
    lat_max: float | None = Query(default=None),
    lon_min: float | None = Query(default=None),
    lon_max: float | None = Query(default=None),
    start: int | None = Query(default=None, ge=0),
    end: int | None = Query(default=None, ge=0),
    level_index: int | None = Query(default=None, ge=0),
    area_method: Literal["mean", "sum", "std"] = Query(
        default="mean", description="区域处理方式：mean=纬度加权平均 / sum=求和 / std=标准差"
    ),
    detrend: Literal["none", "linear", "mean"] = Query(default="none"),
    standardize: bool = Query(default=False),
    filter: Literal["none", "lowpass", "highpass", "bandpass"] = Query(
        default="none", description="none / lowpass / highpass / bandpass"
    ),
    filter_period_min: float | None = Query(default=None, gt=0),
    filter_period_max: float | None = Query(default=None, gt=0),
    filter_order: int = Query(default=4, ge=1, le=8),
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    """取序列并可选地做预处理。

    预处理参数走 query string，前端可直接拼 URL，也便于脚本调用；
    返回体包含 raw_values（原始）与 values（处理后），便于对比。
    """
    # 单轴数据（time-lat / time-lon）只要给出对应轴，就按点位查询
    has_lat = dataset.lat_name is not None
    has_lon = dataset.lon_name is not None
    if has_lat and has_lon:
        is_point = lat is not None and lon is not None
    elif has_lat:
        is_point = lat is not None
    elif has_lon:
        is_point = lon is not None
    else:
        is_point = False

    request = Selector(
        variable=variable,
        lat=lat if is_point else None,
        lon=lon if is_point else None,
        lat_range=(lat_min, lat_max) if lat_min is not None and lat_max is not None else None,
        lon_range=(lon_min, lon_max) if lon_min is not None and lon_max is not None else None,
        start=start,
        end=end,
        level_index=level_index,
        area_method=area_method,
        preprocess=PreprocessSpec(
            detrend=detrend,
            standardize=standardize,
            filter=filter,
            filter_period_min=filter_period_min,
            filter_period_max=filter_period_max,
            order=filter_order,
        ),
    )
    payload = extract_series_preprocessed(dataset, request)
    payload["mode"] = "point" if is_point else "area_mean"
    return payload


@router.get("/{file_id}/field", summary="空间场（时间平均）")
def field(
    file_id: str,
    variable: str | None = Query(default=None),
    start: int | None = Query(default=None, ge=0),
    end: int | None = Query(default=None, ge=0),
    lat_min: float | None = Query(default=None),
    lat_max: float | None = Query(default=None),
    lon_min: float | None = Query(default=None),
    lon_max: float | None = Query(default=None),
    level_index: int | None = Query(default=None, ge=0),
    field_mode: Literal["climatology", "anomaly"] = Query(
        default="climatology", description="climatology=气候态，anomaly=异常场"
    ),
    anomaly_start: int | None = Query(
        default=None, ge=0, description="异常场基准起始时次，缺省为 0"
    ),
    anomaly_end: int | None = Query(
        default=None, ge=0, description="异常场基准结束时次，缺省为全长的一半"
    ),
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    time_range = time_range_of(dataset, start, end)
    return dataset.mean_field(
        variable,
        time_range=time_range,
        lat_range=(lat_min, lat_max) if lat_min is not None and lat_max is not None else None,
        lon_range=(lon_min, lon_max) if lon_min is not None and lon_max is not None else None,
        level_index=level_index,
        field_mode=field_mode,
        anomaly_start=anomaly_start,
        anomaly_end=anomaly_end,
    )


@router.post("/{file_id}/selector-series", summary="用请求体指定选取条件取序列")
def selector_series(
    file_id: str,
    request: Selector,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    time_range = time_range_of(dataset, request.start, request.end)
    if request.is_point:
        payload = dataset.point_series(
            request.variable,
            float(request.lat),
            float(request.lon),
            time_range=time_range,
            level_index=request.level_index,
        )
        payload["mode"] = "point"
        return payload
    return dataset.area_mean_series(
        request.variable,
        request.lat_pair,
        request.lon_pair,
        time_range=time_range,
        level_index=request.level_index,
        area_method=request.area_method,
    )
