"""NetCDF 通用小工具：坐标识别、时间解码、JSON 安全转换。"""
from __future__ import annotations

import datetime as _dt
import math
from typing import Any, Iterable, Sequence

import numpy as np

# 纬度 / 经度 / 时间维度的候选名称（统一小写比较）
LAT_NAMES = ("lat", "latitude", "lats", "nav_lat", "y", "rlat", "gridlat", "yc")
LON_NAMES = ("lon", "longitude", "lons", "nav_lon", "x", "rlon", "gridlon", "xc")
TIME_NAMES = ("time", "t", "date", "dates", "times", "time_counter", "month")
LEVEL_NAMES = ("lev", "level", "plev", "depth", "height", "altitude", "z", "sigma", "layer")

_LAT_UNITS = ("degrees_north", "degree_north", "degrees_n", "degree_n", "degreesn", "lat")
_LON_UNITS = ("degrees_east", "degree_east", "degrees_e", "degree_e", "degreese", "lon")


def find_name(candidates: Iterable[str], available: Iterable[str]) -> str | None:
    """在 available 里找出与 candidates 匹配的名字（大小写不敏感，允许前缀/后缀差异）。"""
    lookup = {str(name).lower(): str(name) for name in available}
    for cand in candidates:
        if cand in lookup:
            return lookup[cand]
    for cand in candidates:
        for low, original in lookup.items():
            if low.startswith(cand) or low.endswith(cand):
                return original
    return None


def detect_lat_name(names: Iterable[str], attrs_of=None) -> str | None:
    names = list(names)
    hit = find_name(LAT_NAMES, names)
    if hit:
        return hit
    if attrs_of is not None:
        for name in names:
            attrs = attrs_of(name) or {}
            units = str(attrs.get("units", "")).lower()
            if units in _LAT_UNITS:
                return name
    return None


def detect_lon_name(names: Iterable[str], attrs_of=None) -> str | None:
    names = list(names)
    hit = find_name(LON_NAMES, names)
    if hit:
        return hit
    if attrs_of is not None:
        for name in names:
            attrs = attrs_of(name) or {}
            units = str(attrs.get("units", "")).lower()
            if units in _LON_UNITS:
                return name
    return None


def detect_time_name(names: Iterable[str], attrs_of=None) -> str | None:
    names = list(names)
    hit = find_name(TIME_NAMES, names)
    if hit:
        return hit
    if attrs_of is not None:
        for name in names:
            attrs = attrs_of(name) or {}
            units = str(attrs.get("units", "")).lower()
            if "since" in units:
                return name
    return None


def detect_level_name(names: Iterable[str], attrs_of=None) -> str | None:
    names = list(names)
    hit = find_name(LEVEL_NAMES, names)
    if hit:
        return hit
    if attrs_of is not None:
        for name in names:
            attrs = attrs_of(name) or {}
            units = str(attrs.get("units", "")).lower()
            positive = str(attrs.get("positive", "")).lower()
            if positive in ("up", "down") or units in ("pa", "hpa", "mbar", "m", "km"):
                return name
    return None


def normalize_longitudes(lon: np.ndarray) -> np.ndarray:
    """把经度统一到 [-180, 180)。"""
    lon = np.asarray(lon, dtype=float)
    out = ((lon + 180.0) % 360.0) - 180.0
    out = np.where(np.isclose(out, -180.0), 180.0, out)
    return out


def is_longitude_like(values: np.ndarray) -> bool:
    values = np.asarray(values, dtype=float)
    return values.size > 1 and float(np.nanmax(values)) > 180.0 and float(np.nanmin(values)) >= -0.5


def decode_time(values: np.ndarray, units: str | None, calendar: str | None = None) -> list[str]:
    """把数值时间轴解码成可读字符串；解码失败时退回原始数值。"""
    values = np.asarray(values)
    if values.dtype.kind in "Mm":
        return [np.datetime_as_string(v, unit="s") for v in values]

    # cftime 对象数组（noleap / 360_day 等非标准日历解码后就是 object dtype）
    if values.dtype == object and values.size and hasattr(values.ravel()[0], "strftime"):
        return [_fmt_cftime(v) for v in values]

    if units:
        try:
            import cftime

            decoded = cftime.num2date(
                values,
                units,
                calendar=calendar or "standard",
                only_use_cftime_datetimes=True,
            )
            return [_fmt_cftime(v) for v in decoded]
        except Exception:
            pass

        try:
            import pandas as pd

            decoded = pd.to_datetime(values, unit=_unit_from_cf(units), origin=_origin_from_cf(units))
            return [ts.strftime("%Y-%m-%d") for ts in decoded]
        except Exception:
            pass

    # 没有 units 时：整数且范围像年份就当作年份
    if values.dtype.kind in "iu":
        finite = values[np.isfinite(values)] if values.size else values
        if finite.size and 0 <= float(finite.min()) and float(finite.max()) <= 3000:
            return [str(int(v)) for v in values]

    return [(_fmt_number(v)) for v in values]


def _fmt_cftime(value: Any) -> str:
    """把 cftime 对象格式化成 ISO 日期（整日时省略时间部分）。"""
    if not hasattr(value, "strftime"):
        return str(value)
    has_time = any(getattr(value, key, 0) for key in ("hour", "minute", "second"))
    try:
        return value.strftime("%Y-%m-%d %H:%M" if has_time else "%Y-%m-%d")
    except Exception:
        return str(value)


def _unit_from_cf(units: str) -> str:
    unit = units.strip().lower().split(" ")[0]
    return {
        "seconds": "s", "second": "s", "secs": "s", "sec": "s", "s": "s",
        "minutes": "m", "minute": "m", "min": "m", "mins": "m",
        "hours": "h", "hour": "h", "hr": "h", "hrs": "h",
        "days": "D", "day": "D", "d": "D",
        "months": "D", "month": "D", "years": "D", "year": "D",
    }.get(unit, "D")


def _origin_from_cf(units: str) -> str:
    try:
        return units.split("since", 1)[1].strip()
    except IndexError:
        return "1970-01-01"


def jsonable(value: Any) -> Any:
    """把 numpy / bytes / datetime 等对象转成可 JSON 序列化的结构。"""
    if isinstance(value, (np.generic,)):
        value = value.item()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:
            return str(value)
    if isinstance(value, (np.ndarray, list, tuple)):
        return [jsonable(v) for v in np.asarray(value).ravel().tolist()]
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (int, str, bool)) or value is None:
        return value
    return str(value)


def attrs_to_dict(attrs: Any) -> dict[str, Any]:
    return {str(k): jsonable(v) for k, v in dict(attrs or {}).items()}


def array_summary(values: np.ndarray, *, head: int = 5, tail: int = 3) -> list[Any]:
    """数组预览：短数组直接给全部值，长数组给首尾并用 '...' 省略。"""
    flat = np.asarray(values).ravel()
    if flat.size == 0:
        return []
    if flat.size <= head + tail + 1:
        return [jsonable(v) for v in flat.tolist()]
    preview = [jsonable(v) for v in flat[:head].tolist()]
    preview.append("...")
    preview.extend(jsonable(v) for v in flat[-tail:].tolist())
    return preview


def _fmt_number(value: Any) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    if math.isnan(num):
        return "nan"
    if num.is_integer():
        return str(int(num))
    return f"{num:g}"


def time_axis_numeric(values: np.ndarray) -> np.ndarray:
    """把时间轴统一成数值（天）。cftime / datetime 对象转成相对首值的天数。"""
    arr = np.asarray(values)
    if arr.size == 0:
        return np.array([])
    if arr.dtype.kind in "iu f".split():
        return arr.astype("float64")
    if arr.dtype.kind == "M":
        return arr.astype("datetime64[s]").astype("int64").astype("float64") / 86400.0

    first = arr.ravel()[0]
    if hasattr(first, "toordinal"):
        ordinals = np.array([v.toordinal() + (getattr(v, "hour", 0) or 0) / 24.0 for v in arr.ravel()])
        return ordinals.astype("float64")
    try:
        return np.asarray([float(v) for v in arr.ravel()], dtype="float64")
    except (TypeError, ValueError):
        return np.arange(arr.size, dtype="float64")


def nearest_index(values: np.ndarray, target: float) -> int:
    arr = np.asarray(values, dtype=float)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError("坐标轴为空，无法定位")
    return int(np.nanargmin(np.abs(arr - float(target))))


def clean_series(values: Sequence[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float).ravel()
    if arr.size == 0:
        return arr
    if not np.all(np.isfinite(arr)):
        idx = np.arange(arr.size)
        mask = np.isfinite(arr)
        if not mask.any():
            return np.full(arr.size, np.nan)
        arr = np.interp(idx, idx[mask], arr[mask])
    return arr
