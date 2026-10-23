"""NetCDF 数据集封装：元信息、点序列、区域统计、平均场与出图。"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import xarray as xr

from app.core.config import settings
from app.core.errors import AnalysisError, InvalidFileError
from app.core.layout import classify_layout, summarize_coords
from app.core.plotting import configure_matplotlib
from app.core.ncutils import (
    array_summary,
    attrs_to_dict,
    clean_series,
    decode_time,
    detect_lat_name,
    detect_lon_name,
    detect_level_name,
    detect_time_name,
    jsonable,
    nearest_index,
    normalize_longitudes,
)


class NCDataset:
    """一次请求内打开一个 NetCDF 文件，提供各类分析所需的取数方法。"""

    def __init__(
        self,
        path: str | Path,
        *,
        file_id: str | None = None,
        name: str | None = None,
        axis_overrides: dict[str, str | None] | None = None,
    ):
        self.path = Path(path)
        self.file_id = file_id or self.path.stem
        self.name = name or self.path.name
        try:
            self.ds = xr.open_dataset(self.path, decode_times=True)
        except Exception:
            # 时间轴无法解码（缺少 cftime、非标准 calendar 等）时退回数值时间轴
            try:
                self.ds = xr.open_dataset(self.path, decode_times=False)
            except Exception as exc:  # 损坏文件 / 不支持的格式
                raise InvalidFileError(f"无法解析 NetCDF 文件：{exc}") from exc

        self.axis_overrides = {k: v for k, v in (axis_overrides or {}).items() if v}
        self._detect_axes()

    # ------------------------------------------------------------------ 基础
    def close(self) -> None:
        try:
            self.ds.close()
        except Exception:
            pass

    def __enter__(self) -> "NCDataset":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _detect_axes(self) -> None:
        coords = list(self.ds.coords)
        dims = list(self.ds.dims)

        def attrs_of(name: str) -> dict:
            """坐标的属性。

            注意：xarray 解码时间轴后会把 units/calendar 移到 encoding，
            因此需要合并两者，否则识别不出「days since ...」这类时间轴。
            """
            try:
                obj = self.ds[name]
            except (KeyError, ValueError):
                return {}
            merged = dict(obj.attrs)
            for key, value in dict(getattr(obj, "encoding", {}) or {}).items():
                if key in ("units", "calendar", "positive", "long_name", "standard_name", "axis"):
                    merged.setdefault(key, value)
            return merged

        candidates = coords + [d for d in dims if d not in coords]
        self.lat_name = detect_lat_name(candidates, attrs_of)
        self.lon_name = detect_lon_name(candidates, attrs_of)
        self.time_name = detect_time_name(candidates, attrs_of)
        self.level_name = detect_level_name(candidates, attrs_of)

        # 没有显式坐标时，退化为同名维度
        for attr, dim in (("lat_name", "lat"), ("lon_name", "lon"), ("time_name", "time")):
            if getattr(self, attr) is None and dim in dims:
                setattr(self, attr, dim)

        # 用户手动指定的坐标轴优先（用于自动识别失败的数据）
        for attr, key in (("lat_name", "lat"), ("lon_name", "lon"), ("time_name", "time")):
            override = self.axis_overrides.get(key)
            if override and override in self.ds.dims:
                setattr(self, attr, override)

        self.lat_values = self._coord_values(self.lat_name)
        self.lon_values = self._coord_values(self.lon_name)
        self.time_values = self._coord_values(self.time_name)
        self.level_values = self._coord_values(self.level_name)
        self.time_labels = self._build_time_labels()

        self.data_vars = list(self.ds.data_vars)
        self.coord_names = coords

    def _coord_values(self, name: str | None) -> np.ndarray:
        if not name:
            return np.array([])
        try:
            obj = self.ds[name]
        except KeyError:
            return np.array([])
        values = np.asarray(obj.values)
        if values.ndim != 1:
            values = values.ravel()
        return values

    def _build_time_labels(self) -> list[str]:
        if self.time_name is None or self.time_values.size == 0:
            return []
        obj = self.ds[self.time_name]
        units = obj.attrs.get("units")
        calendar = obj.attrs.get("calendar")
        return decode_time(self.time_values, units, calendar)

    # ------------------------------------------------------------------ 选择
    def resolve_variable(self, name: str | None) -> str:
        if not self.data_vars:
            raise AnalysisError("该文件中没有可分析的数据变量")
        if name:
            if name in self.ds.data_vars:
                return name
            # 显式指定的变量不存在时直接报错，避免静默回退到别的变量
            raise AnalysisError(
                f"文件中不存在变量 {name}，可选变量：{', '.join(map(str, self.data_vars))}"
            )
        # 优先选择带时间维的变量
        for candidate in self.data_vars:
            if self.time_name and self.time_name in self.ds[candidate].dims:
                return candidate
        return self.data_vars[0]

    def variable_meta(self, name: str) -> dict[str, Any]:
        var = self.ds[name]
        attrs = attrs_to_dict(var.attrs)
        return {
            "name": name,
            "dtype": str(var.dtype),
            "shape": list(var.shape),
            "dimensions": list(var.dims),
            "units": str(attrs.get("units", "") or ""),
            "long_name": str(attrs.get("long_name") or attrs.get("standard_name") or name),
            "attributes": attrs,
        }

    def _time_index_range(self, start: int | None, end: int | None) -> tuple[int, int]:
        size = int(self.time_values.size)
        if size == 0:
            return 0, -1
        a = 0 if start is None else max(0, min(int(start), size - 1))
        b = size - 1 if end is None else max(0, min(int(end), size - 1))
        if b < a:
            a, b = b, a
        return a, b

    def _coord_index_range(
        self,
        values: np.ndarray,
        lo: float | None,
        hi: float | None,
        *,
        is_lon: bool = False,
    ) -> tuple[int, int]:
        size = int(values.size)
        if size == 0:
            return 0, -1
        if lo is None and hi is None:
            return 0, size - 1
        vmin = float(np.nanmin(values))
        vmax = float(np.nanmax(values))

        # 经度轴为 0~360 时，把 -180~180 的输入换算到同一约定
        if is_lon and vmax > 180.0:
            if lo is not None and lo < 0:
                lo = float(lo) % 360.0
            if hi is not None and hi < 0:
                hi = float(hi) % 360.0
            # 跨 180 经线的范围（如 170 → -170）退化为全轴，避免取到空区间
            if lo is not None and hi is not None and lo > hi:
                lo, hi = min(lo, hi), max(lo, hi)

        lo = vmin if lo is None else float(lo)
        hi = vmax if hi is None else float(hi)
        if hi < lo:
            lo, hi = hi, lo
        i = nearest_index(values, lo)
        j = nearest_index(values, hi)
        if i > j:
            i, j = j, i
        return i, j

    def _slice_var(
        self,
        var: xr.DataArray,
        *,
        time_range: tuple[int, int] | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        level_index: int | None = None,
    ) -> xr.DataArray:
        indexers: dict[str, Any] = {}
        dims = var.dims

        if self.time_name in dims and time_range is not None and self.time_values.size:
            # time_range 为闭区间 [start, end]，isel 需要右端 +1
            indexers[self.time_name] = slice(time_range[0], time_range[1] + 1)
        if self.lat_name in dims and self.lat_values.size:
            if lat_range is not None:
                i, j = self._coord_index_range(self.lat_values, lat_range[0], lat_range[1])
                indexers[self.lat_name] = slice(i, j)
        if self.lon_name in dims and self.lon_values.size:
            if lon_range is not None:
                i, j = self._coord_index_range(
                    self.lon_values, lon_range[0], lon_range[1], is_lon=True
                )
                indexers[self.lon_name] = slice(i, j)
        if self.level_name in dims and level_index is not None:
            indexers[self.level_name] = int(level_index)

        return var.isel(indexers) if indexers else var

    # ------------------------------------------------------------------ 元信息
    def overview(self, *, file_size: int | None = None) -> dict[str, Any]:
        dims_info: dict[str, Any] = {}
        for dim, size in self.ds.sizes.items():
            entry: dict[str, Any] = {"size": int(size)}
            if dim in self.ds.coords:
                values = np.asarray(self.ds[dim].values)
                entry["preview"] = array_summary(values)
                entry["has_index"] = True
            else:
                entry["preview"] = []
                entry["has_index"] = False
            dims_info[str(dim)] = entry

        coords_info: dict[str, Any] = {}
        for cname in self.ds.coords:
            coord = self.ds[cname]
            values = np.asarray(coord.values)
            coords_info[str(cname)] = {
                "dtype": str(coord.dtype),
                "shape": list(coord.shape),
                "dimensions": list(coord.dims),
                "attributes": attrs_to_dict(coord.attrs),
                "preview": array_summary(values, head=4, tail=3),
                "range": _range_of(values),
            }

        vars_info: dict[str, Any] = {}
        for vname in self.ds.data_vars:
            meta = self.variable_meta(str(vname))
            meta["stats"] = self._variable_stats(str(vname))
            # 每个变量单独判断布局（同一文件里可能既有 time 序列又有 time-lat-lon 场）
            meta["layout"] = classify_layout(
                meta["dimensions"],
                time_name=self.time_name,
                lat_name=self.lat_name,
                lon_name=self.lon_name,
            )
            vars_info[str(vname)] = meta

        # 数据集整体布局：取第一个数据变量（无变量时按坐标推断）
        if self.data_vars:
            primary_layout = vars_info[str(self.data_vars[0])]["layout"]
        else:
            primary_layout = classify_layout(
                list(self.ds.dims),
                time_name=self.time_name,
                lat_name=self.lat_name,
                lon_name=self.lon_name,
            )

        axes = {
            "lat": self._axis_payload(self.lat_name, self.lat_values),
            "lon": self._axis_payload(self.lon_name, self.lon_values),
            "time": self._axis_payload(self.time_name, self.time_values),
            "level": self._axis_payload(self.level_name, self.level_values),
        }
        if axes["time"]["name"]:
            axes["time"]["labels"] = self.time_labels
            axes["time"]["label_preview"] = array_summary(np.array(self.time_labels, dtype=object), head=4, tail=2)

        return {
            "file": {
                "id": self.file_id,
                "name": self.name,
                "size": int(file_size if file_size is not None else self.path.stat().st_size),
                "path_name": self.path.name,
            },
            "dimensions": dims_info,
            "coords": coords_info,
            "variables": vars_info,
            "attributes": attrs_to_dict(self.ds.attrs),
            "axes": axes,
            "data_var_names": [str(v) for v in self.ds.data_vars],
            "layout": primary_layout,
            "axis_overrides": self.axis_overrides,
            "axis_candidates": summarize_coords(list(self.ds.coords), lambda n: self.ds[n].values),
            "summary": {
                "n_dimensions": len(self.ds.sizes),
                "n_coords": len(self.ds.coords),
                "n_variables": len(self.ds.data_vars),
                "total_cells": int(np.prod(list(self.ds.sizes.values()))) if self.ds.sizes else 0,
            },
        }

    def _axis_payload(self, name: str | None, values: np.ndarray) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": name,
            "size": int(values.size),
            "values": [jsonable(v) for v in values.tolist()] if values.size <= 4000 else [],
            "range": _range_of(values),
        }
        if name:
            attrs = attrs_to_dict(self.ds[name].attrs)
            payload["units"] = str(attrs.get("units", "") or "")
            payload["long_name"] = str(attrs.get("long_name") or attrs.get("standard_name") or name)
            if values.size > 4000:
                payload["preview"] = array_summary(values, head=4, tail=2)
        return payload

    def _variable_stats(self, name: str, *, max_steps: int = 24) -> dict[str, Any]:
        var = self.ds[name]
        try:
            subset = var
            if self.time_name in var.dims and var.sizes.get(self.time_name, 0) > max_steps:
                step = max(1, var.sizes[self.time_name] // max_steps)
                subset = var.isel({self.time_name: slice(0, None, step)})
            data = np.asarray(subset.values, dtype="float64")
            finite = data[np.isfinite(data)]
            if finite.size == 0:
                return {"min": None, "max": None, "mean": None, "nan_count": int(data.size)}
            return {
                "min": float(finite.min()),
                "max": float(finite.max()),
                "mean": float(finite.mean()),
                "std": float(finite.std()),
                "nan_count": int(data.size - finite.size),
                "sampled": bool(subset is not var),
            }
        except Exception:
            return {"min": None, "max": None, "mean": None, "nan_count": 0}

    # ------------------------------------------------------------------ 取数
    def _pure_timeseries(
        self,
        name: str,
        var: xr.DataArray,
        *,
        time_range: tuple[int, int] | None = None,
        level_index: int | None = None,
    ) -> dict[str, Any]:
        """纯时序变量（只有 time 维）的取数，忽略经纬度参数。"""
        subset = self._slice_var(var, time_range=time_range, level_index=level_index)
        extra_dims = [d for d in subset.dims if d != self.time_name]
        if extra_dims:
            subset = subset.isel({d: 0 for d in extra_dims})

        values = np.asarray(subset.values, dtype="float64").ravel()
        labels = self.time_labels
        if labels and time_range is not None:
            labels = labels[time_range[0] : time_range[1] + 1]
        if not labels or len(labels) != values.size:
            labels = [str(v) for v in np.arange(values.size).tolist()]

        return {
            "variable": name,
            "units": str(self.ds[name].attrs.get("units", "") or ""),
            "long_name": str(self.ds[name].attrs.get("long_name") or name),
            "requested": {},
            "grid": {},
            "mode": "timeseries",
            "time": labels,
            "time_index": list(range(time_range[0], time_range[1] + 1)) if time_range else list(range(values.size)),
            "values": [jsonable(v) for v in values.tolist()],
            "stats": _series_stats(values),
        }

    def point_series(
        self,
        variable: str | None,
        lat: float | None = None,
        lon: float | None = None,
        *,
        time_range: tuple[int, int] | None = None,
        level_index: int | None = None,
    ) -> dict[str, Any]:
        """点位序列。

        lat / lon 都可为 None：单轴数据（time-lat 或 time-lon）只需给出对应的那一个。
        """
        name = self.resolve_variable(variable)
        var = self.ds[name]

        # 纯时序数据（只有 time）：直接取整条序列，忽略经纬度
        if self.lat_name not in var.dims and self.lon_name not in var.dims:
            return self._pure_timeseries(name, var, time_range=time_range, level_index=level_index)

        lon_used = float(lon) if lon is not None else None
        if lon_used is not None and self.lon_values.size:
            if float(np.nanmax(self.lon_values)) > 180.0 and lon_used < 0:
                lon_used = float(lon_used % 360.0)

        subset = self._slice_var(var, time_range=time_range, level_index=level_index)
        selector: dict[str, int] = {}
        grid: dict[str, Any] = {}
        if self.lat_name in var.dims and self.lat_values.size and lat is not None:
            i = nearest_index(self.lat_values, lat)
            selector[self.lat_name] = i
            grid["lat"] = float(self.lat_values[i])
            grid["lat_index"] = int(i)
        if self.lon_name in var.dims and self.lon_values.size and lon_used is not None:
            j = nearest_index(self.lon_values, lon_used)
            selector[self.lon_name] = j
            grid["lon"] = float(self.lon_values[j])
            grid["lon_index"] = int(j)
        if selector:
            subset = subset.isel(selector)

        # 处理剩余维度（如多个 level）
        extra_dims = [d for d in subset.dims if d not in (self.time_name,)]
        if extra_dims:
            subset = subset.isel({d: 0 for d in extra_dims})

        values = np.asarray(subset.values, dtype="float64").ravel()
        labels = self.time_labels
        if labels and time_range is not None:
            labels = labels[time_range[0] : time_range[1] + 1]
        if not labels or len(labels) != values.size:
            labels = [str(v) for v in np.arange(values.size).tolist()]

        return {
            "variable": name,
            "units": str(self.ds[name].attrs.get("units", "") or ""),
            "long_name": str(self.ds[name].attrs.get("long_name") or name),
            "requested": {
                "lat": float(lat) if lat is not None else None,
                "lon": float(lon) if lon is not None else None,
            },
            "grid": grid,
            "mode": "point",
            "time": labels,
            "time_index": list(range(time_range[0], time_range[1] + 1)) if time_range else list(range(values.size)),
            "values": [jsonable(v) for v in values.tolist()],
            "stats": _series_stats(values),
        }

    def area_mean_series(
        self,
        variable: str | None,
        lat_range: tuple[float, float] | None,
        lon_range: tuple[float, float] | None,
        *,
        time_range: tuple[int, int] | None = None,
        level_index: int | None = None,
    ) -> dict[str, Any]:
        name = self.resolve_variable(variable)
        var = self.ds[name]

        # 纯时序数据没有可平均的空间维，直接返回整条序列
        if self.lat_name not in var.dims and self.lon_name not in var.dims:
            return self._pure_timeseries(name, var, time_range=time_range, level_index=level_index)

        subset = self._slice_var(
            var, time_range=time_range, lat_range=lat_range, lon_range=lon_range, level_index=level_index
        )
        # 只丢弃额外的维度（层次、成员等），经纬度与时间必须保留
        keep = {self.time_name, self.lat_name, self.lon_name}
        extra_dims = [d for d in subset.dims if d not in keep]
        if extra_dims:
            subset = subset.isel({d: 0 for d in extra_dims})

        # 在求平均前记录实际参与计算的范围（求平均后坐标会被压缩成标量）
        extent = {
            "lat": _coord_extent(subset, self.lat_name),
            "lon": _coord_extent(subset, self.lon_name),
        }
        mean = subset.mean(dim=[d for d in subset.dims if d != self.time_name], skipna=True)
        values = np.asarray(mean.values, dtype="float64").ravel()
        labels = self.time_labels
        if labels and time_range is not None:
            labels = labels[time_range[0] : time_range[1] + 1]
        if not labels or len(labels) != values.size:
            labels = [str(v) for v in np.arange(values.size).tolist()]

        return {
            "variable": name,
            "units": str(self.ds[name].attrs.get("units", "") or ""),
            "long_name": str(self.ds[name].attrs.get("long_name") or name),
            "mode": "area_mean",
            "extent": extent,
            "time": labels,
            "time_index": list(range(time_range[0], time_range[1] + 1)) if time_range else list(range(values.size)),
            "values": [jsonable(v) for v in values.tolist()],
            "stats": _series_stats(values),
        }

    def mean_field(
        self,
        variable: str | None,
        *,
        time_range: tuple[int, int] | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        level_index: int | None = None,
        max_grid: int = 240,
        field_mode: str = "climatology",
        anomaly_start: int | None = None,
        anomaly_end: int | None = None,
    ) -> dict[str, Any]:
        """二维场，供前端热力图使用。

        field_mode
        ----------
        climatology  气候态：所选时段的时间平均（默认）
        anomaly      异常场：所选时段平均减去「基准时段」的气候态

        anomaly_start / anomaly_end
        ---------------------------
        基准时段（闭区间索引）。两者都不给时默认取序列前半段
        （0 ~ max_time // 2），这是古气候研究里常用的参考期。
        """
        name = self.resolve_variable(variable)
        var = self.ds[name]
        mode = (field_mode or "climatology").lower()
        if mode not in ("climatology", "anomaly"):
            raise AnalysisError(f"未知的场类型：{field_mode}")

        # 时间 + 单个空间维：返回 Hovmöller 场（时间 × 纬度/经度）
        has_lat = self.lat_name in var.dims
        has_lon = self.lon_name in var.dims
        if self.time_name in var.dims and (has_lat or has_lon) and not (has_lat and has_lon):
            return self.hovmoller_field(
                name,
                time_range=time_range,
                level_index=level_index,
                max_grid=max_grid,
                field_mode=mode,
                anomaly_start=anomaly_start,
                anomaly_end=anomaly_end,
            )
        if not (has_lat and has_lon):
            raise AnalysisError(
                f"变量 {name} 没有可绘制的空间维（需要经纬度，或时间+单个空间维）"
            )

        def _prepare(sub_range: tuple[int, int] | None) -> xr.DataArray:
            sub = self._slice_var(
                var,
                time_range=sub_range,
                lat_range=lat_range,
                lon_range=lon_range,
                level_index=level_index,
            )
            extra = [d for d in sub.dims if d not in (self.time_name, self.lat_name, self.lon_name)]
            if extra:
                sub = sub.isel({d: 0 for d in extra})
            return sub

        subset = _prepare(time_range)

        if mode == "anomaly":
            base_range, base_label, base_default = self._resolve_baseline(anomaly_start, anomaly_end)
            base_da = _prepare(base_range)
            if self.time_name in base_da.dims:
                base_da = base_da.mean(dim=self.time_name, skipna=True)

            target = subset.mean(dim=self.time_name, skipna=True) if self.time_name in subset.dims else subset
            field_da = target - base_da
            field_label = "异常场（相对 " + base_label + "）"
            base_meta = {
                "start": base_range[0],
                "end": base_range[1],
                "label": base_label,
                "default": base_default,
            }
        else:
            field_da = subset.mean(dim=self.time_name, skipna=True) if self.time_name in subset.dims else subset
            field_label = "气候态（时间平均）"
            base_meta = None

        lats = np.asarray(field_da[self.lat_name].values, dtype=float)
        lons = np.asarray(field_da[self.lon_name].values, dtype=float)
        grid = np.asarray(field_da.values, dtype=float)

        if lons.size and float(np.nanmax(lons)) > 180.0:
            lons = normalize_longitudes(lons)
            order = np.argsort(lons)
            lons = lons[order]
            grid = grid[:, order]

        # 抽稀，避免前端传输过大
        lat_step = max(1, int(math.ceil(lats.size / max_grid)))
        lon_step = max(1, int(math.ceil(lons.size / max_grid)))
        lats = lats[::lat_step]
        lons = lons[::lon_step]
        grid = grid[::lat_step, ::lon_step]

        return {
            "variable": name,
            "units": str(self.ds[name].attrs.get("units", "") or ""),
            "long_name": str(self.ds[name].attrs.get("long_name") or name),
            "field_mode": mode,
            "field_label": field_label,
            "baseline": base_meta,
            "lat": [jsonable(v) for v in lats.tolist()],
            "lon": [jsonable(v) for v in lons.tolist()],
            "values": [[jsonable(v) for v in row] for row in grid.tolist()],
            "vmin": float(np.nanmin(grid)) if np.isfinite(grid).any() else None,
            "vmax": float(np.nanmax(grid)) if np.isfinite(grid).any() else None,
            "time_range": list(time_range) if time_range else None,
            "labels": self._time_range_labels(time_range),
        }

    def _resolve_baseline(
        self,
        start: int | None,
        end: int | None,
    ) -> tuple[tuple[int, int], str, bool]:
        """解析异常场的基准时段。

        未给出时默认取序列前半段（0 ~ max_time // 2）。
        返回 (闭区间索引, 可读标签, 是否使用了默认值)。
        """
        size = int(self.time_values.size)
        if size == 0:
            return (0, 0), "无时间轴", True

        max_index = size - 1
        default_end = max_index // 2
        used_default = start is None and end is None

        # 只填一端时，另一端取自然边界（起点默认 0，终点默认序列末端），
        # 而不是回落到「默认基准」的中点，避免出现反直觉的区间。
        if start is None and end is None:
            a, b = 0, default_end
        elif start is None:
            a, b = 0, int(end)
        elif end is None:
            a, b = int(start), max_index
        else:
            a, b = int(start), int(end)
        a = max(0, min(a, max_index))
        b = max(0, min(b, max_index))
        if b < a:
            a, b = b, a

        if self.time_labels and len(self.time_labels) > b:
            label = self.time_labels[a] + " ~ " + self.time_labels[b]
        else:
            label = f"第 {a} ~ {b} 个时次"
        return (a, b), label, used_default

    def hovmoller_field(
        self,
        variable: str | None,
        *,
        time_range: tuple[int, int] | None = None,
        level_index: int | None = None,
        max_grid: int = 240,
        field_mode: str = "climatology",
        anomaly_start: int | None = None,
        anomaly_end: int | None = None,
    ) -> dict[str, Any]:
        """时间 × 纬度（或经度）的 Hovmöller 场。

        行 = 时间，列 = 空间轴；前端用热力图渲染。
        field_mode="anomaly" 时，每个时次减去沿时间轴的均值（即异常场）。
        """
        name = self.resolve_variable(variable)
        var = self.ds[name]
        if self.time_name not in var.dims:
            raise AnalysisError(f"变量 {name} 没有时间维，无法绘制时间-空间图")

        has_lat = self.lat_name in var.dims
        has_lon = self.lon_name in var.dims
        if has_lat and has_lon:
            raise AnalysisError("该变量是完整空间场，请使用空间分布图")
        if not (has_lat or has_lon):
            raise AnalysisError(f"变量 {name} 没有空间维，无法绘制时间-空间图")

        axis_name = self.lat_name if has_lat else self.lon_name
        axis_kind = "lat" if has_lat else "lon"

        subset = self._slice_var(var, time_range=time_range, level_index=level_index)
        extra_dims = [d for d in subset.dims if d not in (self.time_name, axis_name)]
        if extra_dims:
            subset = subset.isel({d: 0 for d in extra_dims})

        axis_values = np.asarray(subset[axis_name].values, dtype=float)
        time_values = np.asarray(subset[self.time_name].values)
        grid = np.asarray(subset.transpose(self.time_name, axis_name).values, dtype=float)

        mode = (field_mode or "climatology").lower()
        base_meta = None
        if mode == "anomaly":
            # 逐格点减去「基准时段」的均值 -> 异常场
            base_range, base_label, base_default = self._resolve_baseline(anomaly_start, anomaly_end)
            base_meta = {
                "start": base_range[0],
                "end": base_range[1],
                "label": base_label,
                "default": base_default,
            }
            # 基准在「未按 time_range 裁剪」的整段数据上计算，索引是全局时次。
            # 注意 subset 已被 time_range 裁剪，不能直接拿它切片。
            full_var = self._slice_var(var, level_index=level_index)
            full_extra = [d for d in full_var.dims if d not in (self.time_name, axis_name)]
            if full_extra:
                full_var = full_var.isel({d: 0 for d in full_extra})
            full = np.asarray(
                full_var.transpose(self.time_name, axis_name).values, dtype=float
            )
            base_slice = full[base_range[0] : base_range[1] + 1, :]
            baseline = np.nanmean(base_slice, axis=0, keepdims=True)
            grid = grid - baseline

        # 抽稀：时间方向最多 400 行，空间方向最多 400 列
        t_step = max(1, int(math.ceil(grid.shape[0] / 400)))
        s_step = max(1, int(math.ceil(grid.shape[1] / max_grid)))
        grid = grid[::t_step, ::s_step]
        axis_values = axis_values[::s_step]
        time_values = time_values[::t_step]

        labels = self.time_labels
        if labels and time_range is not None:
            labels = labels[time_range[0] : time_range[1] + 1]
        time_labels = [labels[i] for i in range(0, len(labels), t_step)] if labels else [
            str(v) for v in time_values.tolist()
        ]
        if len(time_labels) != grid.shape[0]:
            time_labels = [str(i) for i in range(grid.shape[0])]

        return {
            "variable": name,
            "units": str(self.ds[name].attrs.get("units", "") or ""),
            "long_name": str(self.ds[name].attrs.get("long_name") or name),
            "mode": "hovmoller",
            "field_mode": mode,
            "field_label": (
                "异常场（相对 " + base_meta["label"] + "）" if mode == "anomaly" else "原始场"
            ),
            "baseline": base_meta,
            "axis": axis_kind,
            "axis_name": axis_name,
            "axis_label": "纬度" if axis_kind == "lat" else "经度",
            "x": [jsonable(v) for v in axis_values.tolist()],
            "y": [jsonable(v) for v in time_values.tolist()],
            "y_labels": time_labels,
            "values": [[jsonable(v) for v in row] for row in grid.tolist()],
            "vmin": float(np.nanmin(grid)) if np.isfinite(grid).any() else None,
            "vmax": float(np.nanmax(grid)) if np.isfinite(grid).any() else None,
            "time_range": list(time_range) if time_range else None,
            "labels": self._time_range_labels(time_range),
        }

    def _time_range_labels(self, time_range: tuple[int, int] | None) -> dict[str, str | None]:
        if not self.time_labels:
            return {"start": None, "end": None}
        if time_range is None:
            return {"start": self.time_labels[0], "end": self.time_labels[-1]}
        return {
            "start": self.time_labels[time_range[0]],
            "end": self.time_labels[time_range[1]],
        }

    # ------------------------------------------------------------------ 出图
    def render_map(
        self,
        variable: str | None,
        *,
        time_range: tuple[int, int] | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        level_index: int | None = None,
        cmap: str | None = None,
        dpi: int | None = None,
    ) -> Path:
        configure_matplotlib()
        import matplotlib.pyplot as plt

        field = self.mean_field(
            variable,
            time_range=time_range,
            lat_range=lat_range,
            lon_range=lon_range,
            level_index=level_index,
        )
        lats = np.asarray(field["lat"], dtype=float)
        lons = np.asarray(field["lon"], dtype=float)
        grid = np.asarray(field["values"], dtype=float)
        if grid.size == 0:
            raise AnalysisError("所选范围内没有可用数据")

        key = _cache_key(
            self.file_id,
            field["variable"],
            time_range,
            lat_range,
            lon_range,
            level_index,
            cmap,
            dpi,
        )
        out_path = settings.preview_dir / f"{key}.png"
        if out_path.exists() and out_path.stat().st_size > 0:
            return out_path

        palette = cmap or _pick_cmap(field["variable"], grid)
        fig = plt.figure(figsize=(7.6, 4.4), dpi=dpi or settings.preview_dpi)
        ax = fig.add_subplot(111)

        try:
            import cartopy.crs as ccrs
            import cartopy.feature as cfeature

            ax.remove()
            ax = fig.add_subplot(111, projection=ccrs.PlateCarree())
            ax.set_global()
            try:
                ax.add_feature(cfeature.COASTLINE.with_scale("110m"), linewidth=0.45, edgecolor="#4b5563")
                ax.add_feature(cfeature.BORDERS.with_scale("110m"), linewidth=0.25, edgecolor="#9ca3af")
            except Exception:
                pass
            try:
                ax.add_feature(cfeature.LAND.with_scale("110m"), facecolor="#f3f4f6", zorder=0)
            except Exception:
                pass
            ax.set_extent(_extent(lons, lats), crs=ccrs.PlateCarree())
            ax.gridlines(draw_labels=True, linewidth=0.3, color="#cbd5e1", alpha=0.7)
            transform = ccrs.PlateCarree()
            ax.set_facecolor("#eef6fb")
        except Exception:
            ax.set_facecolor("#eef6fb")
            ax.grid(True, linewidth=0.3, color="#e2e8f0")
            ax.set_xlabel("经度 (°E)", fontsize=8)
            ax.set_ylabel("纬度 (°N)", fontsize=8)
            transform = None

        mesh = ax.pcolormesh(
            lons,
            lats,
            np.ma.masked_invalid(grid),
            cmap=palette,
            shading="auto",
            transform=transform,
        )
        cbar = fig.colorbar(mesh, ax=ax, orientation="horizontal", pad=0.08, fraction=0.05, aspect=40)
        units = field["units"] or ""
        cbar.set_label(f"{field['long_name']} ({units})" if units else field["long_name"], fontsize=8)
        cbar.ax.tick_params(labelsize=7)

        labels = field.get("labels") or {}
        period = ""
        if labels.get("start"):
            period = f"   {labels['start']} ~ {labels['end']}"
        ax.set_title(f"{field['variable']} 时间平均场{period}", fontsize=10, pad=6)

        for spine in ax.spines.values():
            spine.set_linewidth(0.4)

        fig.tight_layout()
        settings.preview_dir.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_path, bbox_inches="tight")
        plt.close(fig)
        return out_path

    def render_series(
        self,
        variable: str | None,
        *,
        lat: float | None = None,
        lon: float | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        time_range: tuple[int, int] | None = None,
        dpi: int | None = None,
    ) -> Path:
        """服务端渲染时序图（用于报告导出）。"""
        configure_matplotlib()
        import matplotlib.pyplot as plt

        if lat is not None and lon is not None:
            payload = self.point_series(variable, lat, lon, time_range=time_range)
            title = f"{payload['variable']} 点位序列 ({payload['grid']['lat']:.2f}°N, {payload['grid']['lon']:.2f}°E)"
        else:
            payload = self.area_mean_series(variable, lat_range, lon_range, time_range=time_range)
            title = f"{payload['variable']} 区域平均序列"

        values = np.asarray(payload["values"], dtype=float)
        labels = payload["time"]
        x = np.arange(values.size)

        key = _cache_key(self.file_id, "series", lat, lon, lat_range, lon_range, time_range, variable)
        out_path = settings.preview_dir / f"{key}.png"
        if out_path.exists() and out_path.stat().st_size > 0:
            return out_path

        fig, ax = plt.subplots(figsize=(8.0, 3.2), dpi=dpi or settings.preview_dpi)
        ax.plot(x, values, color="#667eea", linewidth=1.1)
        ax.fill_between(x, values, np.nanmin(values), color="#667eea", alpha=0.12)
        ax.set_xlim(0, max(1, values.size - 1))
        ax.set_ylabel(payload["units"] or payload["variable"], fontsize=8)
        ax.set_title(title, fontsize=9)
        ax.grid(True, linewidth=0.3, color="#e2e8f0")
        tick_count = min(8, max(2, values.size // 40 or 2))
        ticks = np.linspace(0, values.size - 1, num=tick_count).astype(int) if values.size > 1 else [0]
        ax.set_xticks(ticks)
        ax.set_xticklabels([labels[i] for i in ticks], rotation=20, ha="right", fontsize=7)
        ax.tick_params(axis="y", labelsize=7)
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)
        fig.tight_layout()
        settings.preview_dir.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_path)
        plt.close(fig)
        return out_path

    # ------------------------------------------------------------------ 导出
    def subset_dataset(
        self,
        variable: str | None,
        *,
        time_range: tuple[int, int] | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        level_index: int | None = None,
    ) -> xr.Dataset:
        name = self.resolve_variable(variable)
        var = self._slice_var(
            self.ds[name],
            time_range=time_range,
            lat_range=lat_range,
            lon_range=lon_range,
            level_index=level_index,
        )
        subset = var.to_dataset(name=name)
        subset.attrs = dict(self.ds.attrs)
        subset.attrs["history"] = f"Subset exported by PaleoVis at {_timestamp()}"
        return subset

    def export_netcdf(
        self,
        variable: str | None,
        *,
        time_range: tuple[int, int] | None = None,
        lat_range: tuple[float, float] | None = None,
        lon_range: tuple[float, float] | None = None,
        level_index: int | None = None,
    ) -> Path:
        subset = self.subset_dataset(
            variable,
            time_range=time_range,
            lat_range=lat_range,
            lon_range=lon_range,
            level_index=level_index,
        )
        name = self.resolve_variable(variable)
        key = _cache_key(self.file_id, "export", name, time_range, lat_range, lon_range, level_index)
        out_path = settings.cache_dir / f"{key}.nc"
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        subset.to_netcdf(out_path)
        return out_path


# ---------------------------------------------------------------------- 工具函数
def _coord_extent(subset: xr.DataArray, name: str | None) -> list[float] | None:
    """取子集在某坐标维度上的实际范围。"""
    if not name:
        return None
    try:
        coord = subset[name]
    except (KeyError, ValueError):
        return None
    values = np.asarray(coord.values, dtype="float64").ravel()
    values = values[np.isfinite(values)]
    if values.size == 0:
        return None
    return [float(values.min()), float(values.max())]


def _range_of(values: np.ndarray) -> dict[str, float] | None:
    if values.size == 0:
        return None
    try:
        arr = np.asarray(values, dtype="float64")
    except (TypeError, ValueError):
        return None
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return None
    return {"min": float(finite.min()), "max": float(finite.max())}


def _series_stats(values: np.ndarray) -> dict[str, Any]:
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


def _pick_cmap(name: str, grid: np.ndarray) -> str:
    low = name.lower()
    if any(k in low for k in ("temp", "tas", "ts", "sst", "t2m", "air")):
        return "RdBu_r"
    if any(k in low for k in ("pr", "prec", "rain", "precip")):
        return "YlGnBu"
    if np.nanmin(grid) < 0 < np.nanmax(grid):
        return "RdBu_r"
    return "viridis"


def _extent(lons: np.ndarray, lats: np.ndarray) -> tuple[float, float, float, float]:
    x0 = float(np.nanmin(lons)) if lons.size else -180.0
    x1 = float(np.nanmax(lons)) if lons.size else 180.0
    y0 = float(np.nanmin(lats)) if lats.size else -90.0
    y1 = float(np.nanmax(lats)) if lats.size else 90.0
    if x1 - x0 < 1.0:
        x0, x1 = x0 - 1.0, x1 + 1.0
    if y1 - y0 < 1.0:
        y0, y1 = y0 - 1.0, y1 + 1.0
    return (max(-180.0, x0), min(180.0, x1), max(-90.0, y0), min(90.0, y1))


def _cache_key(*parts: Any) -> str:
    raw = "|".join(repr(p) for p in parts)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:20]


def _timestamp() -> str:
    import datetime as dt

    return dt.datetime.now().astimezone().isoformat(timespec="seconds")
