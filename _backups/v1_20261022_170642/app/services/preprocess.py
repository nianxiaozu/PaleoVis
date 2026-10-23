"""时序预处理：去趋势、标准化、Butterworth 滤波。

所有函数接收一维序列，返回处理后的数组与元信息，供图表视图与分析视图共用，
保证「图表里看到的曲线」与「分析用的数据」完全一致。
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import signal

from app.core.errors import AnalysisError
from app.core.ncutils import clean_series

FILTER_KINDS = ("none", "lowpass", "highpass", "bandpass")


def apply_preprocess(
    values: Any,
    spec: dict[str, Any] | None,
    *,
    dt: float = 1.0,
) -> tuple[np.ndarray, dict[str, Any]]:
    """按 spec 依次执行 去趋势 → 滤波 → 标准化。

    参数
    ----
    values : 原始序列（可含缺测）
    spec   : {detrend, standardize, filter, filter_period_min, filter_period_max, order}
    dt     : 采样步长（与序列单位一致，用于把「周期」换算成频率）

    返回 (处理后的数组, 处理说明)
    """
    arr = clean_series(values)
    if arr.size == 0:
        return arr, {"applied": False, "steps": [], "reason": "序列为空"}

    spec = spec or {}
    notes: dict[str, Any] = {"applied": False, "steps": []}

    # 全缺测（如海洋数据的陆地点）直接返回，避免对 NaN 做无意义计算
    if not np.isfinite(arr).any():
        notes["reason"] = "该位置全为缺测值（可能位于陆地或掩膜区）"
        return arr, notes

    detrend_mode = str(spec.get("detrend") or "none").lower()
    if detrend_mode in ("linear", "mean"):
        arr = _detrend(arr, detrend_mode)
        notes["steps"].append(f"去趋势({detrend_mode})")

    filter_kind = str(spec.get("filter") or "none").lower()
    if filter_kind not in FILTER_KINDS:
        raise AnalysisError(f"未知的滤波类型：{filter_kind}")
    if filter_kind != "none":
        arr = _filter(
            arr,
            filter_kind,
            dt=dt,
            period_min=_as_float(spec.get("filter_period_min")),
            period_max=_as_float(spec.get("filter_period_max")),
            order=int(spec.get("order") or 4),
        )
        notes["steps"].append(f"滤波({filter_kind})")

    if bool(spec.get("standardize")):
        finite = arr[np.isfinite(arr)]
        std = float(np.std(finite)) if finite.size else 0.0
        if std > 0:
            arr = (arr - float(np.mean(finite))) / std
            notes["steps"].append("标准化(z-score)")
        else:
            notes["reason"] = "序列方差为 0，已跳过标准化"

    notes["applied"] = bool(notes["steps"])
    return arr, notes


def _detrend(arr: np.ndarray, mode: str) -> np.ndarray:
    if mode == "mean":
        return arr - float(np.mean(arr))
    x = np.arange(arr.size, dtype=float)
    slope, intercept = np.polyfit(x, arr, 1)
    return arr - (slope * x + intercept)


def _filter(
    arr: np.ndarray,
    kind: str,
    *,
    dt: float,
    period_min: float | None,
    period_max: float | None,
    order: int,
) -> np.ndarray:
    """按「周期」做零相位滤波（filtfilt，不引入相位偏移）。"""
    n = arr.size
    if n < 12:
        raise AnalysisError("序列过短，无法滤波（至少需要 12 个时次）")

    nyquist = 0.5 / dt  # 奈奎斯特频率（Hz）
    order = int(max(1, min(order, 8)))

    def to_freq(period: float | None) -> float | None:
        """周期 -> 归一化频率（相对奈奎斯特，取值 0~1）。"""
        if period is None or period <= 0:
            return None
        return (1.0 / (period * dt)) / nyquist

    fmin = to_freq(period_min)  # 短周期 -> 高频
    fmax = to_freq(period_max)  # 长周期 -> 低频

    if kind == "lowpass":
        # 保留长周期（低频），截止 = 最短周期的频率
        cutoff = fmin if fmin is not None else 0.5
        cutoff = _clamp_cutoff(cutoff, nyquist, arr)
        b, a = signal.butter(order, cutoff, btype="lowpass")
    elif kind == "highpass":
        # 保留短周期（高频），截止 = 最长周期的频率
        cutoff = fmax if fmax is not None else 0.5
        cutoff = _clamp_cutoff(cutoff, nyquist, arr)
        b, a = signal.butter(order, cutoff, btype="highpass")
    else:  # bandpass
        if fmin is None or fmax is None:
            raise AnalysisError("带通滤波需要同时给出最短周期与最长周期")
        low, high = sorted([fmin, fmax])
        low = _clamp_cutoff(low, nyquist, arr)
        high = _clamp_cutoff(high, nyquist, arr)
        if not (0 < low < high < 1):
            raise AnalysisError("带通范围无效：请确保 最短周期 < 最长周期，且都在可分辨范围内")
        b, a = signal.butter(order, [low, high], btype="bandpass")

    # filtfilt 需要足够长的数据，否则退化为 sosfilt
    padlen = 3 * max(len(a), len(b))
    if n <= padlen:
        return signal.filtfilt(b, a, arr, padlen=n - 1)
    return signal.filtfilt(b, a, arr)


def _clamp_cutoff(value: float, nyquist: float, arr: np.ndarray) -> float:
    """把归一化截止频率限制在 (0, 1) 开区间内。"""
    # value 已是相对奈奎斯特的归一化频率
    eps = 1e-6
    if not np.isfinite(value) or value <= 0:
        return eps
    return float(min(max(value, eps), 1.0 - eps))


def _as_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        out = float(value)
        return out if np.isfinite(out) else None
    except (TypeError, ValueError):
        return None
