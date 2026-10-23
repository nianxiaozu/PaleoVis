"""数据集「数据布局」识别。

根据变量的维度组合判断该数据集属于哪种类型，前端据此决定：
  * 是否显示地图视图
  * 数据查询面板长什么样
  * 地图视图渲染什么图

布局类型
--------
`timeseries`  只有时间维（time），如 AMV(time)
`hovmoller`   时间 + 一个空间维（time-lat 或 time-lon），画 Hovmöller 图
`map`         时间 + 经纬度（time-lat-lon），画空间分布
`profile`     只有一个空间维（lat 或 lon），画剖面曲线
`grid`        只有经纬度（lat-lon），画静态场
`unknown`     无法识别
"""
from __future__ import annotations

from typing import Any, Iterable

import numpy as np

from app.core.ncutils import detect_lat_name, detect_lon_name, detect_time_name


def classify_layout(
    dims: Iterable[str],
    *,
    time_name: str | None,
    lat_name: str | None,
    lon_name: str | None,
) -> dict[str, Any]:
    """判断一组维度属于哪种数据布局。

    参数
    ----
    dims      : 变量的维度名列表
    time_name : 已识别的时间维名（可为 None）
    lat_name  : 已识别的纬度维名
    lon_name  : 已识别的经度维名

    返回
    ----
    包含 kind / dims / time / lat / lon / has_map / map_mode / label 的字典。
    """
    dims = [str(d) for d in dims]
    dim_set = set(dims)

    has_time = bool(time_name and time_name in dim_set)
    has_lat = bool(lat_name and lat_name in dim_set)
    has_lon = bool(lon_name and lon_name in dim_set)

    result: dict[str, Any] = {
        "kind": "unknown",
        "dims": dims,
        "time": time_name if has_time else None,
        "lat": lat_name if has_lat else None,
        "lon": lon_name if has_lon else None,
        "has_map": False,
        "map_mode": None,
        "hovmoller_axis": None,
        "label": "",
    }

    # ---- 时间 + 经纬度：标准空间场 ----
    if has_time and has_lat and has_lon:
        result.update(
            kind="map",
            has_map=True,
            map_mode="map",
            label="时空场（时间 × 纬度 × 经度）",
        )
        return result

    # ---- 时间 + 单个空间维：Hovmöller 图 ----
    if has_time and (has_lat or has_lon) and not (has_lat and has_lon):
        axis = "lat" if has_lat else "lon"
        result.update(
            kind="hovmoller",
            has_map=True,
            map_mode="hovmoller",
            hovmoller_axis=axis,
            label="时间-纬度图" if axis == "lat" else "时间-经度图",
        )
        return result

    # ---- 只有时间：纯时序 ----
    if has_time and not has_lat and not has_lon:
        result.update(kind="timeseries", label="时间序列")
        return result

    # ---- 只有经纬度：静态场 ----
    if has_lat and has_lon and not has_time:
        result.update(kind="grid", has_map=True, map_mode="map", label="空间分布（静态场）")
        return result

    # ---- 只有一个空间维：剖面 ----
    if (has_lat or has_lon) and not has_time:
        axis = "lat" if has_lat else "lon"
        result.update(
            kind="profile",
            hovmoller_axis=axis,
            label="纬度剖面" if axis == "lat" else "经度剖面",
        )
        return result

    result["label"] = "未识别的维度组合"
    return result


def describe_axes(dims: Iterable[str], *, attrs_of=None) -> dict[str, Any]:
    """从一组维度名里识别时间/纬度/经度，用于「用户手动指定」场景。"""
    dims = [str(d) for d in dims]
    return {
        "time": detect_time_name(dims, attrs_of),
        "lat": detect_lat_name(dims, attrs_of),
        "lon": detect_lon_name(dims, attrs_of),
        "candidates": dims,
    }


def summarize_coords(coord_names: Iterable[str], values_of) -> list[dict[str, Any]]:
    """给每个坐标生成一份描述，供前端手动指定时展示。"""
    out: list[dict[str, Any]] = []
    for name in coord_names:
        try:
            values = np.asarray(values_of(name))
        except Exception:
            continue
        entry: dict[str, Any] = {
            "name": str(name),
            "size": int(values.size),
            "dtype": str(values.dtype),
        }
        if values.dtype.kind in "fiu" and values.size:
            finite = values[np.isfinite(values)]
            if finite.size:
                entry["min"] = _num(finite.min())
                entry["max"] = _num(finite.max())
        out.append(entry)
    return out


def _num(value: Any) -> float | None:
    try:
        out = float(value)
        return out if np.isfinite(out) else None
    except (TypeError, ValueError):
        return None
