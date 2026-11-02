"""把「提取 + 预处理」后的序列（或 EEMD 分量）写入数据文件。

设计要点
--------
* 属性一律用 **ASCII 键 + 中文值**：中文值便于人读，ASCII 键则保证
  CDO / NCO / ncdump 等外部工具读取时不出现编码问题。
* 描述信息全部由调用方传入的键值对（`attributes`）决定，新增预处理时
  只要在调用方补一条描述即可，本模块无需改动。
* 写入的文件会注册进「数据文件」列表，前端可像普通文件一样继续分析。
"""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from app.core.config import settings
from app.services import nc_processor
from app.services.storage import storage

#: 区域处理方式 -> 中文说明（与 nc_processor.AREA_METHOD_LABELS 保持一致）
AREA_LABELS = nc_processor.AREA_METHOD_LABELS

#: 数据来源方式 -> 中文说明
MODE_LABELS = {
    "point": "单点序列",
    "area_mean": "区域序列",
    "timeseries": "单站/纯时间序列",
}


def _fmt_range(values: Any, digits: int = 3) -> str | None:
    """把 [min, max] 或单个数值格式化成可读文本。"""
    if values is None:
        return None
    if isinstance(values, (int, float)):
        return f"{float(values):.{digits}f}"
    try:
        items = [float(v) for v in values]
    except (TypeError, ValueError):
        return str(values)
    if not items:
        return None
    if len(items) == 1:
        return f"{items[0]:.{digits}f}"
    return f"{items[0]:.{digits}f} ~ {items[-1]:.{digits}f}"


def describe_source(series: Mapping[str, Any], *, source_file: str | None = None) -> dict[str, str]:
    """根据取数结果生成「数据来源 + 区域处理」描述。"""
    attrs: dict[str, str] = {}
    variable = series.get("variable")
    mode = str(series.get("mode") or "point")
    attrs["variable"] = str(variable or "")
    units = series.get("units") or ""
    if units:
        attrs["units"] = str(units)
    long_name = series.get("long_name")
    if long_name:
        attrs["long_name"] = str(long_name)

    if source_file:
        attrs["source_file"] = str(source_file)
    attrs["data_mode"] = MODE_LABELS.get(mode, mode)

    if mode == "area_mean":
        method = str(series.get("area_method") or "mean")
        label = AREA_LABELS.get(method, method)
        lat_range = _fmt_range((series.get("extent") or {}).get("lat"))
        lon_range = _fmt_range((series.get("extent") or {}).get("lon"))
        area = ""
        if lat_range:
            area += f"纬度 {lat_range}°"
        if lon_range:
            area += ("，" if area else "") + f"经度 {lon_range}°"
        attrs["area_method"] = label
        if area:
            attrs["area_extent"] = area
        origin = f"由 {variable} 空间场经{label}"
        if area:
            origin += f"（{area}）"
        attrs["data_source"] = origin + "计算得到"
    elif mode == "point":
        requested = series.get("requested") or {}
        lat = requested.get("lat")
        lon = requested.get("lon")
        where = []
        if lat is not None:
            where.append(f"纬度 {float(lat):.2f}°")
        if lon is not None:
            where.append(f"经度 {float(lon):.2f}°")
        attrs["data_source"] = "由 {} 在 {}{} 处的格点值提取".format(
            variable, "，".join(where) if where else "指定位置",
            "" if not series.get("grid") else "（最近邻格点）",
        )
    else:
        attrs["data_source"] = f"变量 {variable} 的原始时间序列"
    return attrs


def describe_preprocess(preprocess: Mapping[str, Any] | None) -> dict[str, str]:
    """把预处理信息转成属性；没有做预处理时也明确写出「未预处理」。"""
    attrs: dict[str, str] = {}
    if not preprocess:
        attrs["preprocess"] = "未做预处理（原始序列）"
        return attrs
    steps = [str(s) for s in (preprocess.get("steps") or [])]
    applied = bool(preprocess.get("applied"))
    if applied and steps:
        attrs["preprocess"] = " → ".join(steps)
        attrs["preprocess_steps"] = "; ".join(steps)
    else:
        reason = preprocess.get("reason")
        attrs["preprocess"] = "未做预处理（原始序列）"
        if reason:
            attrs["preprocess_note"] = str(reason)
    spec = preprocess.get("spec")
    if spec:
        try:
            compact = {k: v for k, v in dict(spec).items() if v not in (None, "", False)}
            if compact:
                attrs["preprocess_spec"] = json.dumps(compact, ensure_ascii=False)
        except (TypeError, ValueError):
            pass
    dt = preprocess.get("dt")
    if dt:
        attrs["dt"] = f"{float(dt):g}"
    return attrs


def describe_eemd(
    *,
    component: str,
    variance_ratio: float | None = None,
    trials: int | None = None,
    noise_ratio: float | None = None,
    noise_seed: int | None = None,
    imf_count: int | None = None,
) -> dict[str, str]:
    """EEMD 分量的描述：哪个分量、解释方差多少、分解参数。"""
    name = str(component or "")
    if name.lower().startswith("residue"):
        attrs = {"eemd_component": "残差（趋势项）"}
    else:
        attrs = {"eemd_component": f"IMF {name}" if not name.upper().startswith("IMF") else name.upper()}
    if variance_ratio is not None:
        attrs["eemd_variance_ratio"] = f"{float(variance_ratio) * 100:.2f}%"
        attrs["eemd_explained"] = (
            f"该分量解释了去趋势序列方差的 {float(variance_ratio) * 100:.2f}%"
        )
    if trials is not None:
        attrs["eemd_trials"] = str(int(trials))
    if noise_ratio is not None:
        attrs["eemd_noise_ratio"] = f"{float(noise_ratio):g}"
    if noise_seed is not None:
        attrs["eemd_noise_seed"] = str(int(noise_seed))
    if imf_count is not None:
        attrs["eemd_imf_count"] = str(int(imf_count))
    attrs["eemd_method"] = "集合经验模态分解（EEMD，噪声辅助）"
    return attrs


def build_attributes(
    *,
    title: str,
    series: Mapping[str, Any],
    source_file: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """汇总全部描述属性。extra 里同名的键会覆盖自动生成的键。"""
    attrs: dict[str, str] = {
        "title": title,
        "Conventions": "CF-1.8",
        "created_by": "PaleoVis",
        "created_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    attrs.update(describe_source(series, source_file=source_file))
    attrs.update(describe_preprocess(series.get("preprocess")))
    n = series.get("values")
    if n is not None:
        attrs["n_samples"] = str(len(n))
    if series.get("time"):
        labels = series["time"]
        attrs["time_start"] = str(labels[0])
        attrs["time_end"] = str(labels[-1])
    if extra:
        for key, value in dict(extra).items():
            if value is None:
                continue
            attrs[str(key)] = str(value)
    return attrs


def safe_stem(name: str) -> str:
    stem = Path(str(name or "series")).name
    return Path(stem).stem or "series"


def write_series_file(
    series: Mapping[str, Sequence[float]],
    *,
    filename: str,
    time_labels: Sequence[str] | None = None,
    attributes: Mapping[str, str] | None = None,
    register: bool = True,
) -> dict[str, Any]:
    """把序列写成 NetCDF 并（可选）注册进数据文件列表。

    返回 {file_id, name, path, size, record}。
    """
    stem = safe_stem(filename)
    out_name = f"{stem}.nc"
    temp_path = settings.temp_dir / out_name
    nc_processor.series_to_netcdf(
        dict(series), temp_path, time_labels=time_labels, attrs=dict(attributes or {})
    )
    content = temp_path.read_bytes()
    temp_path.unlink(missing_ok=True)

    if not register:
        target = settings.temp_dir / out_name
        target.write_bytes(content)
        return {"file_id": None, "name": out_name, "path": str(target), "size": len(content)}

    record = storage.save_upload(out_name, content, source="derived")
    return {
        "file_id": record.id,
        "name": record.name,
        "path": record.path,
        "size": record.size,
        "record": record.public(),
    }
