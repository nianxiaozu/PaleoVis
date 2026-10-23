"""FastAPI 依赖：打开数据集、抽取序列。"""
from __future__ import annotations

from typing import Iterator

import numpy as np
from fastapi import Request

from app.core.errors import AnalysisError
from app.core.ncutils import jsonable, time_axis_numeric
from app.services.nc_processor import NCDataset
from app.services.preprocess import apply_preprocess
from app.services.storage import storage


def open_dataset(file_id: str, request: Request = None) -> Iterator[NCDataset]:
    """打开数据集。

    支持通过查询参数临时覆盖坐标轴识别结果：
      ?axis_time=time&axis_lat=latitude&axis_lon=longitude
    用于自动识别失败的数据集（用户在前端手动指定）。
    """
    record = storage.get(file_id)
    overrides: dict[str, str | None] = {}
    if request is not None:
        params = request.query_params
        for key, param in (("time", "axis_time"), ("lat", "axis_lat"), ("lon", "axis_lon")):
            value = params.get(param)
            if value:
                overrides[key] = value

    dataset = NCDataset(
        record.path,
        file_id=record.id,
        name=record.name,
        axis_overrides=overrides or None,
    )
    try:
        yield dataset
    finally:
        dataset.close()


def time_range_of(dataset: NCDataset, start: int | None, end: int | None) -> tuple[int, int] | None:
    if start is None and end is None:
        return None
    size = int(dataset.time_values.size)
    if size == 0:
        return None
    a = 0 if start is None else max(0, min(int(start), size - 1))
    b = size - 1 if end is None else max(0, min(int(end), size - 1))
    if b < a:
        a, b = b, a
    return (a, b)


def extract_series(dataset: NCDataset, request) -> dict:
    """按 Selector 抽取点位或区域平均序列（原始值，未预处理）。"""
    if dataset.time_values.size == 0:
        raise AnalysisError("该变量没有时间维度，无法进行时序分析")

    t_range = time_range_of(dataset, request.start, request.end)

    # 单轴数据（time-lat / time-lon）：给出对应轴的坐标即按点位查询
    lat = getattr(request, "lat", None)
    lon = getattr(request, "lon", None)
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

    if is_point:
        return dataset.point_series(
            request.variable,
            float(lat) if lat is not None else None,
            float(lon) if lon is not None else None,
            time_range=t_range,
            level_index=request.level_index,
        )
    return dataset.area_mean_series(
        request.variable,
        getattr(request, "lat_pair", None),
        getattr(request, "lon_pair", None),
        time_range=t_range,
        level_index=request.level_index,
    )


def extract_series_preprocessed(dataset: NCDataset, request) -> dict:
    """抽取序列并应用请求中的预处理配置。

    返回体在原始 payload 基础上追加：
      raw_values  原始值（便于前端对比）
      preprocess  处理步骤说明
      values      已替换为处理后的值
    """
    payload = extract_series(dataset, request)
    raw = np.asarray(payload.get("values") or [], dtype=float)

    spec = getattr(request, "preprocess", None)
    spec_dict = spec.model_dump() if hasattr(spec, "model_dump") else (spec or {})

    dt = estimate_dt(dataset, getattr(request, "dt", None))
    processed, notes = apply_preprocess(raw, spec_dict, dt=dt)

    payload["raw_values"] = payload.get("values")
    payload["values"] = [jsonable(v) for v in processed.tolist()]
    payload["stats"] = _stats(processed)
    payload["preprocess"] = {
        "applied": notes.get("applied", False),
        "steps": notes.get("steps", []),
        "spec": spec_dict,
        "dt": dt,
    }
    return payload


def _stats(values: np.ndarray) -> dict:
    arr = np.asarray(values, dtype=float)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return {"n": int(arr.size), "min": None, "max": None, "mean": None, "std": None, "nan_count": int(arr.size)}
    return {
        "n": int(arr.size),
        "min": float(finite.min()),
        "max": float(finite.max()),
        "mean": float(finite.mean()),
        "std": float(finite.std()),
        "median": float(np.median(finite)),
        "nan_count": int(arr.size - finite.size),
    }


def estimate_dt(dataset: NCDataset, explicit: float | None) -> float:
    """推断时间步长（用于频率/周期换算）。

    cftime 等对象型时间轴会被换算成天数；日尺度数据统一折算成年，
    这样功率谱/小波给出的周期就是「年」而不是「天」。
    """
    if explicit:
        return float(explicit)
    values = time_axis_numeric(dataset.time_values)
    if values.size < 2:
        return 1.0
    diffs = np.diff(values)
    diffs = diffs[np.isfinite(diffs) & (diffs != 0)]
    if diffs.size == 0:
        return 1.0
    step = float(np.median(diffs))
    # 日尺度（1~366 天）折算为年，月尺度（28~31 天）同样折算
    if 20 <= step <= 400:
        return step / 365.25
    return step
