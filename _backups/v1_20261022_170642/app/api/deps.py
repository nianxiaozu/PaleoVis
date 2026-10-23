"""FastAPI 依赖：打开数据集、抽取序列。"""
from __future__ import annotations

from typing import Iterator

import numpy as np

from app.core.errors import AnalysisError
from app.core.ncutils import jsonable, time_axis_numeric
from app.services.nc_processor import NCDataset
from app.services.preprocess import apply_preprocess
from app.services.storage import storage


def open_dataset(file_id: str) -> Iterator[NCDataset]:
    record = storage.get(file_id)
    dataset = NCDataset(record.path, file_id=record.id, name=record.name)
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
    if getattr(request, "lat", None) is not None and getattr(request, "lon", None) is not None:
        return dataset.point_series(
            request.variable,
            float(request.lat),
            float(request.lon),
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
