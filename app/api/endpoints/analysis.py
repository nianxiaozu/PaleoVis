"""时序分析接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import estimate_dt, extract_series, extract_series_preprocessed, open_dataset
from app.api.schemas import (
    AbruptRequest,
    CompareRequest,
    CorrelationRequest,
    CrossRequest,
    EemdRequest,
    PeriodRequest,
    Selector,
    SpectrumRequest,
    WaveletRequest,
)
from app.core.errors import AnalysisError
from app.services import analysis
from app.services.nc_processor import NCDataset

router = APIRouter()


def _pair_series(dataset: NCDataset, request, variable: str, time_range) -> dict:
    """取单个变量的序列，并按请求中的 preprocess 处理（双变量分析共用）。"""
    is_point = request.lat is not None and request.lon is not None
    selector = Selector(
        variable=variable,
        lat=request.lat if is_point else None,
        lon=request.lon if is_point else None,
        lat_range=None if is_point else request.lat_range,
        lon_range=None if is_point else request.lon_range,
        level_index=request.level_index,
    )
    spec = getattr(request, "preprocess", None)
    if spec is not None:
        selector = selector.model_copy(update={"preprocess": spec})
        payload = extract_series_preprocessed(dataset, selector)
    else:
        payload = extract_series(dataset, selector)

    if time_range is not None:
        # 已按索引切片，这里只做一致性标记
        payload.setdefault("time_range", list(time_range))
    return payload


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


@router.post("/{file_id}/power-spectrum", summary="功率谱分析")
def power_spectrum(
    file_id: str,
    request: SpectrumRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    base = _payload(dataset, request)
    out = analysis.power_spectrum(
        base["values"],
        dt=base["source"]["dt"],
        detrend=request.detrend,
        window=request.window,
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
        detrend=request.detrend,
        max_scale=request.max_scale,
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
        detrend=request.detrend,
        max_period=request.max_period,
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
        noise=request.noise,
        trials=request.trials,
    )
    base.update(out)
    return base


@router.post("/{file_id}/cross-spectrum", summary="交叉谱分析")
def cross(
    file_id: str,
    request: CrossRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    variables = dataset.data_vars
    if len(variables) < 2 and (not request.variable_a or not request.variable_b):
        raise AnalysisError("交叉谱分析需要文件内至少包含两个变量，或显式指定两个变量")

    a_name = request.variable_a or variables[0]
    b_name = request.variable_b or variables[1]
    if a_name == b_name:
        raise AnalysisError("请选择两个不同的变量进行交叉谱分析")

    time_range = (
        (request.start, request.end)
        if request.start is not None and request.end is not None
        else None
    )
    a = _pair_series(dataset, request, a_name, time_range)
    b = _pair_series(dataset, request, b_name, time_range)

    dt = estimate_dt(dataset, request.dt)
    out = analysis.cross_spectrum(a["values"], b["values"], dt=dt, detrend=request.detrend)
    out["source"] = {
        "variable_a": a_name,
        "variable_b": b_name,
        "units_a": a.get("units", ""),
        "units_b": b.get("units", ""),
        "dt": dt,
        "n": out["n"],
        "time": a["time"][: out["n"]],
    }
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
    return analysis.compare_series(request.series, normalize=request.normalize)


@router.post("/{file_id}/correlation", summary="同一文件内两个变量的相关性")
def correlation_in_file(
    file_id: str,
    request: CrossRequest,
    dataset: NCDataset = Depends(open_dataset),
) -> dict:
    variables = dataset.data_vars
    a_name = request.variable_a or variables[0]
    b_name = request.variable_b or (variables[1] if len(variables) > 1 else variables[0])
    time_range = (
        (request.start, request.end)
        if request.start is not None and request.end is not None
        else None
    )
    a = _pair_series(dataset, request, a_name, time_range)
    b = _pair_series(dataset, request, b_name, time_range)
    out = analysis.correlation(a["values"], b["values"])
    out["source"] = {
        "variable_a": a_name,
        "variable_b": b_name,
        "units_a": a.get("units", ""),
        "units_b": b.get("units", ""),
        "time": a["time"][: out["n"]],
    }
    return out
