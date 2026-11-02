"""时序分析接口。"""
from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, Response

from app.api.deps import (
    dataset_from_id,
    estimate_dt,
    extract_series,
    extract_series_preprocessed,
    open_dataset,
)
from app.api.schemas import (
    AbruptRequest,
    CompareRequest,
    CorrelationRequest,
    CrossFileRequest,
    EemdExportRequest,
    EemdRequest,
    PeriodRequest,
    Selector,
    SeriesExportRequest,
    SpectrumRequest,
    WaveletRequest,
)
from app.core.config import settings
from app.core.errors import AnalysisError
from app.core.ncutils import clean_series, time_axis_numeric
from app.services.preprocess import apply_preprocess
from app.services import analysis, nc_processor, series_export, time_align
from app.services.nc_processor import NCDataset

router = APIRouter()


def _payload(dataset: NCDataset, request, **kwargs) -> dict:
    """构造分析入参。

    若请求里带 preprocess，则先按同一套规则处理序列，
    保证「分析用的数据」与「图表视图看到的曲线」完全一致。
    """
    spec = getattr(request, "preprocess", None)
    if spec is not None:
        series = extract_series_preprocessed(dataset, request)
    else:
        series = extract_series(dataset, request)

    dt = estimate_dt(dataset, getattr(request, "dt", None))
    result = {
        "source": {
            "variable": series["variable"],
            "units": series.get("units", ""),
            "mode": series.get("mode", "point"),
            "area_method": series.get("area_method"),
            "area_method_label": series.get("area_method_label"),
            "grid": series.get("grid"),
            "extent": series.get("extent"),
            "dt": dt,
            "n": len(series["values"]),
            "time": series["time"],
            "preprocess": series.get("preprocess"),
        },
        "values": series["values"],
        "raw_values": series.get("raw_values"),
        "stats": series["stats"],
    }
    result.update(kwargs)
    return result


def _raw_series(dataset: NCDataset, request, variable: str, time_range) -> dict:
    """只取原始序列，不做预处理（跨文件分析要先对齐时间轴再统一处理）。"""
    is_point = request.lat is not None and request.lon is not None
    start, end = (time_range if time_range else (None, None))
    selector = Selector(
        variable=variable,
        lat=request.lat if is_point else None,
        lon=request.lon if is_point else None,
        lat_range=None if is_point else request.lat_range,
        lon_range=None if is_point else request.lon_range,
        start=start,
        end=end,
        level_index=request.level_index,
        area_method=getattr(request, "area_method", "mean") or "mean",
    )
    return extract_series(dataset, selector)


def _apply_spec(values, spec, dt: float) -> tuple[np.ndarray, dict]:
    """按请求里的预处理配置处理一段序列。"""
    spec_dict = spec.model_dump() if hasattr(spec, "model_dump") else (spec or {})
    processed, notes = apply_preprocess(values, spec_dict, dt=dt)
    return processed, {
        "applied": notes.get("applied", False),
        "steps": notes.get("steps", []),
        "spec": spec_dict,
        "dt": dt,
    }


def _series_refs(request: CrossFileRequest, path_file_id: str) -> list[tuple[str, str | None]]:
    """把请求里的 A / B / extras 展开成有序的「文件 id, 变量名」列表。"""
    file_a = request.file_a or path_file_id
    file_b = request.file_b or file_a
    refs: list[tuple[str, str | None]] = [
        (file_a, request.variable_a),
        (file_b, request.variable_b),
    ]
    for extra in request.extras or []:
        refs.append((extra.file or file_a, extra.variable))
    return refs


def _aligned_many(
    request: CrossFileRequest,
    path_file_id: str,
    http_request: Request | None,
    *,
    min_overlap: int = 4,
) -> dict:
    """取 N 个「数据 - 变量」的序列，按时间轴交集对齐后再做预处理。

    file_a 缺省用路径上的 file_id；file_b 缺省与 file_a 相同（即同一文件内
    两个变量，行为与旧端点一致）；extras 是多序列对比追加的第 3 个及以后的
    组合。start/end 只作用于第一个组合，之后与其余序列取时间交集，因此无论
    各序列范围如何，最终都只对公共时段做计算。
    """
    refs = _series_refs(request, path_file_id)
    time_range = (
        (request.start, request.end)
        if request.start is not None and request.end is not None
        else None
    )

    opened: dict[str, NCDataset] = {}
    try:
        series: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for index, (file_id, variable) in enumerate(refs):
            dataset = opened.get(file_id)
            if dataset is None:
                dataset = dataset_from_id(file_id, http_request)
                opened[file_id] = dataset
            if not dataset.data_vars:
                raise AnalysisError("所选数据文件中没有可分析的变量")
            name = variable or dataset.data_vars[0]
            if name not in dataset.data_vars:
                raise AnalysisError(f"文件 {getattr(dataset, 'name', file_id)} 中不存在变量 {name}")
            key = (file_id, name)
            if key in seen:
                raise AnalysisError("请选择不同的变量或数据文件进行分析")
            seen.add(key)
            payload = _raw_series(dataset, request, name, time_range if index == 0 else None)
            series.append(
                {
                    "file": file_id,
                    "name": getattr(dataset, "name", file_id),
                    "variable": name,
                    "payload": payload,
                    "times": time_align.numeric_times(dataset, payload),
                }
            )

        aligned = time_align.align_many([item["times"] for item in series])
        overlap = int(aligned["common"].size)
        if overlap < min_overlap:
            sizes = [int(item["times"].size) for item in series]
            raise AnalysisError(
                "所选数据的时间范围没有足够的重叠时段"
                f"（各序列时次依次为 {' / '.join(str(s) for s in sizes)}，"
                f"公共时次仅 {overlap} 个，至少需要 {min_overlap} 个）"
            )

        dt = float(request.dt) if request.dt else time_align.step_dt(aligned["common"])
        for item, mapping in zip(series, aligned["mappings"]):
            raw = np.asarray(item["payload"]["values"], dtype="float64")[mapping]
            values, pre = _apply_spec(raw, request.preprocess, dt)
            item["raw"] = raw
            item["values"] = values
            item["preprocess"] = pre

        first = series[0]
        labels = first["payload"].get("time") or []
        time_labels = (
            [labels[int(i)] for i in aligned["mappings"][0]]
            if labels
            else [str(i) for i in range(overlap)]
        )
        return {
            "series": series,
            "dt": dt,
            "time": time_labels,
            "align": {
                "n_a": int(series[0]["times"].size),
                "n_b": int(series[1]["times"].size),
                "overlap": overlap,
                "tolerance": float(aligned["tolerance"]),
                "start": time_labels[0] if time_labels else "",
                "end": time_labels[-1] if time_labels else "",
                "sizes": [int(item["times"].size) for item in series],
            },
        }
    finally:
        for dataset in opened.values():
            dataset.close()


def _aligned_pair(
    request: CrossFileRequest,
    path_file_id: str,
    http_request: Request | None,
    *,
    min_overlap: int = 4,
) -> dict:
    """两个「数据 - 变量」的对齐结果（`_aligned_many` 的前两项）。"""
    many = _aligned_many(
        request, path_file_id, http_request, min_overlap=min_overlap
    )
    a, b = many["series"][0], many["series"][1]
    return {
        "file_a": a["file"],
        "file_b": b["file"],
        "name_a": a["name"],
        "name_b": b["name"],
        "variable_a": a["variable"],
        "variable_b": b["variable"],
        "units_a": a["payload"].get("units", ""),
        "units_b": b["payload"].get("units", ""),
        "mode_a": a["payload"].get("mode"),
        "mode_b": b["payload"].get("mode"),
        "area_method_a": a["payload"].get("area_method"),
        "area_method_b": b["payload"].get("area_method"),
        "area_method_label_a": a["payload"].get("area_method_label"),
        "area_method_label_b": b["payload"].get("area_method_label"),
        "values_a": a["values"],
        "values_b": b["values"],
        "raw_values_a": a["raw"],
        "raw_values_b": b["raw"],
        "preprocess_a": a["preprocess"],
        "preprocess_b": b["preprocess"],
        "dt": many["dt"],
        "time": many["time"],
        "align": many["align"],
    }


@router.post("/{file_id}/power-spectrum", summary="功率谱分析")
def power_spectrum(
    file_id: str,
    request: SpectrumRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.power_spectrum(
        base["values"],
        time=request.timeRange,
        dt=base["source"]["dt"],
        detrend=request.detrend,
        method=request.method,
        window=request.window,
        min_periods=request.min_periods,
        max_periods=request.max_periods,
        ofac=request.ofac,
        hifac=request.hifac,
        n50=request.n50,
        iwin=request.iwin,
        nw=request.nw,
        k=request.k,
        confidence=request.confidence,
        mctest=request.mctest,
        nsim=request.nsim,
    )
    base.update(out)
    return base


@router.post("/{file_id}/wavelet", summary="小波分析")
def wavelet(
    file_id: str,
    request: WaveletRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.wavelet_analysis(
        base["values"],
        dt=base["source"]["dt"],
        max_scale=request.max_scale,
        confidence=request.confidence,
        pad=request.pad,
        dj=request.dj,
        j1_n_div_dj=request.j1_n_div_dj,
        s0=request.s0,
        lag1=request.lag1,
        mother=request.mother,
        mother_param=request.mother_param,
        sigtest_wavelet=request.sigtest_wavelet,
        sigtest_global=request.sigtest_global,
    )
    base.update(out)
    return base


@router.post("/{file_id}/period", summary="周期分析")
def period(
    file_id: str,
    request: PeriodRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.period_analysis(
        base["values"],
        dt=base["source"]["dt"],
        max_period=request.max_period,
        confidence=request.confidence,
        max_lag=request.max_lag,
        order=request.order,
    )
    base.update(out)
    return base


@router.post("/{file_id}/abrupt-change", summary="突变分析")
def abrupt(
    file_id: str,
    request: AbruptRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.abrupt_change(base["values"], method=request.method, window=request.window)
    base.update(out)
    return base


@router.post("/{file_id}/eemd", summary="经验模态分解 (EEMD)")
def eemd(
    file_id: str,
    request: EemdRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.eemd_decompose(
        base["values"],
        max_imfs=request.max_imfs,
        noise=request.noise_ratio,
        trials=request.trials,
        noise_seed=request.noise_seed,
    )
    base.update(out)
    return base


@router.post("/{file_id}/eemd/export", summary="导出 EEMD 分量（单个或全部）")
def eemd_export(
    file_id: str,
    request: EemdExportRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> Any:
    base = _payload(dataset, request)
    out = analysis.eemd_decompose(
        base["values"],
        max_imfs=request.max_imfs,
        noise=request.noise_ratio,
        trials=request.trials,
        noise_seed=request.noise_seed,
    )
    imfs = out["imfs"]
    series: dict[str, Any] = {}
    wanted = (request.component or "").strip().lower()
    if wanted in ("", "all"):
        for index, values in enumerate(imfs):
            series[f"IMF{index + 1}"] = values
        series["residue"] = out["residue"]
        stem = "eemd_all"
    elif wanted in ("residue", "trend"):
        series["residue"] = out["residue"]
        stem = "eemd_residue"
    else:
        digits = "".join(ch for ch in wanted if ch.isdigit())
        if not digits:
            raise AnalysisError(f"无法识别的分量：{request.component}")
        index = int(digits)
        if index < 1 or index > len(imfs):
            raise AnalysisError(f"IMF 序号超出范围：{request.component}（共 {len(imfs)} 个）")
        series[f"IMF{index}"] = imfs[index - 1]
        stem = f"eemd_imf{index}"

    source_name = Path(str(base["source"].get("variable") or "series")).stem
    labels = base["source"].get("time")

    # 分量描述：哪个分量 + 解释方差 + 分解参数
    component_name = next(iter(series.keys())) if len(series) == 1 else "all"
    ratio = None
    if len(series) == 1:
        if component_name.lower().startswith("imf"):
            digits = "".join(ch for ch in component_name if ch.isdigit())
            index = int(digits) - 1 if digits else -1
            ratios = out.get("variance_ratio") or []
            if 0 <= index < len(ratios):
                ratio = ratios[index]
        elif component_name.lower().startswith("residue"):
            ratio = float(1.0 - sum(out.get("variance_ratio") or []))
    eemd_attrs = series_export.describe_eemd(
        component=component_name if len(series) == 1 else "全部分量",
        variance_ratio=ratio,
        trials=request.trials,
        noise_ratio=request.noise_ratio,
        noise_seed=out.get("meta", {}).get("seed"),
        imf_count=out.get("imf_count"),
    )
    attrs = series_export.build_attributes(
        title=f"{source_name} EEMD 分量（{component_name}）",
        series={**base["source"], "values": base["values"]},
        source_file=file_id,
        extra=eemd_attrs,
    )
    out_stem = f"{source_name}_{stem}"

    if request.format == "netcdf":
        if request.target == "library":
            saved = series_export.write_series_file(
                series,
                filename=out_stem,
                time_labels=labels,
                attributes=attrs,
                register=True,
            )
            return {
                "saved": True,
                "file": saved["record"],
                "message": f"已写入数据文件：{saved['name']}",
            }
        path = settings.temp_dir / f"{out_stem}.nc"
        nc_processor.series_to_netcdf(series, path, time_labels=labels, attrs=attrs)
        return FileResponse(
            path,
            media_type="application/x-netcdf",
            filename=f"{out_stem}.nc",
        )

    text = nc_processor.series_to_csv(series, time_labels=labels)
    filename = urllib.parse.quote(f"{out_stem}.csv")
    return Response(
        content=text.encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.post("/{file_id}/series/export", summary="把提取后的序列写入数据文件 / 下载")
def series_export_endpoint(
    file_id: str,
    request: SeriesExportRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> Any:
    """把「按当前选取条件提取 + 预处理后」的序列写成 NetCDF。

    * target=library：写入数据文件列表，返回新文件记录；
    * target=download：直接下载。
    NetCDF 全局属性里带上数据来源、区域处理方式、预处理步骤等描述，
    request.attributes 可以追加或覆盖任意键值对。
    """
    series = extract_series_preprocessed(dataset, request)
    values = [float(v) if v is not None else None for v in series.get("values") or []]
    if not values:
        raise AnalysisError("没有可导出的序列")

    variable = str(series.get("variable") or "series")
    stem = series_export.safe_stem(request.filename or f"{variable}_series")
    attrs = series_export.build_attributes(
        title=f"{variable} 序列（{series_export.MODE_LABELS.get(str(series.get('mode')), series.get('mode'))}）",
        series=series,
        source_file=file_id,
        extra=request.attributes,
    )
    labels = series.get("time")

    if request.format == "csv":
        text = nc_processor.series_to_csv({variable: values}, time_labels=labels)
        if request.target == "library":
            raise AnalysisError("数据文件仅支持 NetCDF 格式，CSV 请选择下载")
        filename = urllib.parse.quote(f"{stem}.csv")
        return Response(
            content=text.encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )

    if request.target == "library":
        saved = series_export.write_series_file(
            {variable: values},
            filename=stem,
            time_labels=labels,
            attributes=attrs,
            register=True,
        )
        return {
            "saved": True,
            "file": saved["record"],
            "message": f"已写入数据文件：{saved['name']}",
        }

    path = settings.temp_dir / f"{stem}.nc"
    nc_processor.series_to_netcdf({variable: values}, path, time_labels=labels, attrs=attrs)
    return FileResponse(
        path, media_type="application/x-netcdf", filename=f"{stem}.nc"
    )


def _series_labels(series: list[dict]) -> list[str]:
    """给每条序列起一个可读标签；同名时用序号区分。"""
    labels: list[str] = []
    for item in series:
        label = f"{item['variable']}（{item['name']}）"
        if label in labels:
            label = f"{item['variable']}（{item['name']}）· {len(labels) + 1}"
        labels.append(label)
    return labels


def _many_source(many: dict, n: int, labels: list[str]) -> dict:
    """把 N 条序列的对齐结果整理成前端使用的 source 元信息。"""
    series = many["series"]
    source = {
        "file_a": series[0]["file"],
        "file_b": series[1]["file"],
        "file_name_a": series[0]["name"],
        "file_name_b": series[1]["name"],
        "variable_a": series[0]["variable"],
        "variable_b": series[1]["variable"],
        "units_a": series[0]["payload"].get("units", ""),
        "units_b": series[1]["payload"].get("units", ""),
        "mode_a": series[0]["payload"].get("mode"),
        "mode_b": series[1]["payload"].get("mode"),
        "area_method_label_a": series[0]["payload"].get("area_method_label"),
        "area_method_label_b": series[1]["payload"].get("area_method_label"),
        "preprocess_a": series[0]["preprocess"],
        "preprocess_b": series[1]["preprocess"],
        "dt": many["dt"],
        "n": int(n),
        "time": many["time"][:n],
        "align": many["align"],
        "count": len(series),
        "series": [
            {
                "label": labels[index],
                "file": item["file"],
                "file_name": item["name"],
                "variable": item["variable"],
                "units": item["payload"].get("units", ""),
                "mode": item["payload"].get("mode"),
                "area_method_label": item["payload"].get("area_method_label"),
                "preprocess": item["preprocess"],
            }
            for index, item in enumerate(series)
        ],
    }
    return source


def _pair_source(pair: dict, n: int) -> dict:
    """把两条序列的对齐结果整理成前端使用的 source 元信息。"""
    return {
        "file_a": pair["file_a"],
        "file_b": pair["file_b"],
        "file_name_a": pair["name_a"],
        "file_name_b": pair["name_b"],
        "variable_a": pair["variable_a"],
        "variable_b": pair["variable_b"],
        "units_a": pair["units_a"],
        "units_b": pair["units_b"],
        "mode_a": pair["mode_a"],
        "mode_b": pair["mode_b"],
        "area_method_label_a": pair["area_method_label_a"],
        "area_method_label_b": pair["area_method_label_b"],
        "preprocess_a": pair["preprocess_a"],
        "preprocess_b": pair["preprocess_b"],
        "dt": pair["dt"],
        "n": int(n),
        "time": pair["time"][:n],
        "align": pair["align"],
    }


@router.post("/{file_id}/cross-spectrum", summary="交叉谱分析（可跨文件）")
def cross(
    file_id: str,
    request: CrossFileRequest,
    http_request: Request = None, # type: ignore
) -> dict:
    pair = _aligned_pair(request, file_id, http_request)
    out = analysis.cross_spectrum(
        pair["values_a"],
        pair["values_b"],
        dt=pair["dt"],
        max_period=request.max_period,
    )
    out["source"] = _pair_source(pair, out["n"])
    return out


@router.post("/correlation", summary="相关性分析（两序列）")
def correlation(request: CorrelationRequest) -> dict:
    return analysis.correlation(
        request.series_a,
        request.series_b,
        max_lag=request.max_lag,
        method=request.method,
    )


@router.post("/compare", summary="多序列对比")
def compare(request: CompareRequest) -> dict:
    return analysis.compare_series(request.series, normalize=request.normalize) # type: ignore


@router.post("/{file_id}/correlation", summary="两个变量的相关性（可跨文件）")
def correlation_in_file(
    file_id: str,
    request: CrossFileRequest,
    http_request: Request = None,
) -> dict:
    pair = _aligned_pair(request, file_id, http_request)
    out = analysis.correlation(
        pair["values_a"],
        pair["values_b"],
        max_lag=request.max_lag,
        method=request.method,
    )
    out["source"] = _pair_source(pair, out["n"])
    return out


@router.post("/{file_id}/compare", summary="两个序列的对比（可跨文件）")
def compare_in_file(
    file_id: str,
    request: CrossFileRequest,
    http_request: Request = None,
) -> dict:
    """取 N 个「数据 - 变量」的序列，对齐时间轴后做标准化对比与相关矩阵。"""
    many = _aligned_many(request, file_id, http_request)
    labels = _series_labels(many["series"])
    mapping = {
        labels[index]: item["values"]
        for index, item in enumerate(many["series"])
    }
    out = analysis.compare_series(mapping, normalize=request.normalize)
    out["source"] = _many_source(many, out["n"], labels)
    out["series_meta"] = {
        labels[index]: {
            "units": item["payload"].get("units", ""),
            "file": item["name"],
        }
        for index, item in enumerate(many["series"])
    }
    return out
