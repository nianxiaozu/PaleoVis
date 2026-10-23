"""时序分析算法：功率谱、小波、周期、突变、交叉谱、EEMD、相关与对比。

所有函数接收一维等间隔序列，返回可直接 JSON 序列化的字典。
"""
from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np
from scipy import signal, stats

from app.core.errors import AnalysisError
from app.core.ncutils import clean_series, jsonable


def _prepare(values: Sequence[float], *, min_length: int = 8) -> np.ndarray:
    arr = clean_series(values)
    arr = np.asarray(arr, dtype=float).ravel()
    arr = arr[np.isfinite(arr)]
    if arr.size < min_length:
        raise AnalysisError(f"序列长度不足（需要至少 {min_length} 个有效值，当前 {arr.size} 个）")
    if float(np.nanstd(arr)) == 0.0:
        raise AnalysisError("序列为常数，无法进行该分析")
    return arr


def _detrend(arr: np.ndarray, mode: str) -> np.ndarray:
    if mode in (None, "", "none"):
        return arr - arr.mean()
    if mode == "linear":
        x = np.arange(arr.size, dtype=float)
        slope, intercept = np.polyfit(x, arr, 1)
        return arr - (slope * x + intercept)
    if mode == "mean":
        return arr - arr.mean()
    raise AnalysisError(f"未知的去趋势方式：{mode}")


# ---------------------------------------------------------------------- 功率谱
def power_spectrum(
    values: Sequence[float],
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    window: str = "hann",
    max_periods: int = 200,
) -> dict[str, Any]:
    """经典周期图 + Welch 平均，双对数坐标给出周期与功率。"""
    arr = _prepare(values)
    n = arr.size
    series = _detrend(arr, detrend)
    if window == "hann":
        series = series * signal.windows.hann(n, sym=False)

    freqs, power = signal.periodogram(series, fs=1.0 / dt, window="boxcar", detrend=False)
    mask = freqs > 0
    freqs, power = freqs[mask], power[mask]
    if freqs.size == 0:
        raise AnalysisError("序列过短，无法计算功率谱")

    # 红噪声显著性阈值（AR(1) 基准）
    lag1 = float(np.corrcoef(arr[:-1], arr[1:])[0, 1]) if n > 2 else 0.0
    lag1 = min(max(lag1, 0.0), 0.95)
    dof = 2
    red = _red_noise_threshold(freqs, power, lag1, dof)

    order = np.argsort(freqs)
    freqs, power, red = freqs[order], power[order], red[order]

    # 抽稀，保证前端图表不至于过密
    if freqs.size > max_periods:
        step = int(math.ceil(freqs.size / max_periods))
        freqs, power, red = freqs[::step], power[::step], red[::step]

    periods = 1.0 / freqs
    return {
        "type": "power-spectrum",
        "n": int(n),
        "dt": float(dt),
        "detrend": detrend,
        "window": window,
        "frequency": [jsonable(v) for v in freqs.tolist()],
        "period": [jsonable(v) for v in periods.tolist()],
        "power": [jsonable(v) for v in power.tolist()],
        "threshold": [jsonable(v) for v in red.tolist()],
        "peaks": _top_periods(periods, power, red, top=6),
        "meta": {"lag1": lag1, "confidence": 0.95},
    }


def _red_noise_threshold(freqs: np.ndarray, power: np.ndarray, lag1: float, dof: int) -> np.ndarray:
    """基于 AR(1) 红噪声谱的 95% 显著性阈值（Torrence & Compo, 1998）。"""
    mean_power = float(np.mean(power))
    base = mean_power * (1.0 - lag1**2) / (1.0 + lag1**2 - 2.0 * lag1 * np.cos(2.0 * np.pi * freqs))
    chi2 = stats.chi2.ppf(0.95, dof) / dof
    return base * chi2


def _top_periods(periods: np.ndarray, power: np.ndarray, threshold: np.ndarray, top: int = 6) -> list[dict]:
    if power.size == 0:
        return []
    idx = np.argsort(power)[::-1][: max(top * 4, 12)]
    peaks: list[dict] = []
    seen: list[float] = []
    for i in idx:
        p = float(periods[i])
        if any(abs(math.log(p) - math.log(s)) < 0.08 for s in seen):
            continue
        seen.append(p)
        peaks.append(
            {
                "period": p,
                "power": float(power[i]),
                "threshold": float(threshold[i]),
                "significant": bool(power[i] > threshold[i]),
            }
        )
        if len(peaks) >= top:
            break
    return peaks


# ---------------------------------------------------------------------- 小波
def wavelet_analysis(
    values: Sequence[float],
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    max_scale: int = 64,
) -> dict[str, Any]:
    """Morlet 连续小波变换，输出功率谱与全局小波谱。"""
    arr = _prepare(values, min_length=16)
    n = arr.size
    series = _detrend(arr, detrend)

    # 若 scipy 提供 morlet2 则使用，否则回退到复 Morlet
    mother = None
    try:  # SciPy < 1.15
        from scipy.signal import morlet2 as mother  # type: ignore[attr-defined]
    except ImportError:
        try:  # SciPy >= 1.15 移到了 windows 子模块
            from scipy.signal.windows import morlet2 as mother  # type: ignore[attr-defined]
        except ImportError:  # pragma: no cover
            mother = None

    min_scale = 2
    max_scale = int(min(max_scale, max(min_scale + 2, n // 2)))
    widths = np.arange(min_scale, max_scale + 1)
    if mother is not None:
        cwt = signal.cwt(series, mother, widths, w=5.0)
    else:  # pragma: no cover
        cwt = _manual_cwt(series, widths)

    power = np.abs(cwt) ** 2
    scales = widths.astype(float)
    periods = scales * dt
    global_spectrum = power.mean(axis=1)

    # 影响锥：边界处能量不可靠
    cone = _cone_of_influence(n, scales)

    # 抽稀时间轴用于前端渲染
    time_step = max(1, n // 160)
    power_out = power[:, ::time_step]

    return {
        "type": "wavelet",
        "n": int(n),
        "dt": float(dt),
        "detrend": detrend,
        "period": [jsonable(p) for p in periods.tolist()],
        "time_index": [int(i) for i in range(0, n, time_step)],
        "power": [[jsonable(v) for v in row] for row in power_out.tolist()],
        "global": [jsonable(v) for v in global_spectrum.tolist()],
        "cone": [int(c) for c in cone.tolist()],
        "peaks": _top_periods(periods, global_spectrum, np.zeros_like(global_spectrum), top=5),
        "meta": {"mother": "morlet", "w": 5.0, "scale_range": [min_scale, max_scale]},
    }


def _manual_cwt(series: np.ndarray, widths: np.ndarray) -> np.ndarray:  # pragma: no cover
    """纯 numpy 的 Morlet 连续小波变换（SciPy 未提供 morlet2 时使用）。"""
    n = series.size
    out = np.zeros((widths.size, n), dtype=complex)
    for i, width in enumerate(widths):
        half = int(3 * width)
        t = np.arange(-half, half + 1)
        wavelet = np.exp(2j * np.pi * t / width) * np.exp(-(t**2) / (2 * width**2))
        full = np.convolve(series, wavelet, mode="full")
        start = half
        out[i] = full[start : start + n]
    return out


def _cone_of_influence(n: int, scales: np.ndarray) -> np.ndarray:
    centre = np.arange(n)
    distance = np.minimum(centre, n - 1 - centre)
    cone = np.full(n, n // 2)
    for i, scale in enumerate(scales):
        reach = int(math.ceil(math.sqrt(2) * scale))
        cone = np.minimum(cone, np.where(distance < reach, distance, n // 2))
    return cone


# ---------------------------------------------------------------------- 周期
def period_analysis(
    values: Sequence[float],
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    max_period: int | None = None,
) -> dict[str, Any]:
    """自相关 + 最大熵谱（Burg）联合周期识别。"""
    arr = _prepare(values)
    n = arr.size
    series = _detrend(arr, detrend)

    max_lag = int(min(n - 2, max(10, n // 3)))
    acf = _autocorrelation(series, max_lag)
    acf_periods = _acf_peaks(acf, dt)

    # 最大熵谱
    order = int(min(20, max(4, n // 10)))
    freqs, psd = _burg_psd(series, order, dt)
    periods = 1.0 / freqs
    peaks = _top_periods(periods, psd, np.zeros_like(psd), top=6)

    if max_period:
        keep = [p for p in peaks if p["period"] <= max_period]
        peaks = keep or peaks

    step = max(1, len(freqs) // 300)
    return {
        "type": "period",
        "n": int(n),
        "dt": float(dt),
        "detrend": detrend,
        "acf": {
            "lag": [jsonable(v) for v in (np.arange(acf.size) * dt).tolist()],
            "value": [jsonable(v) for v in acf.tolist()],
            "peaks": acf_periods,
            "confidence": float(1.96 / math.sqrt(n)),
        },
        "spectrum": {
            "period": [jsonable(v) for v in periods[::step].tolist()],
            "power": [jsonable(v) for v in psd[::step].tolist()],
        },
        "peaks": peaks,
        "meta": {"method": "burg", "order": order},
    }


def _autocorrelation(series: np.ndarray, max_lag: int) -> np.ndarray:
    s = series - series.mean()
    denom = float(np.dot(s, s)) or 1.0
    return np.array([float(np.dot(s[: s.size - lag], s[lag:]) / denom) for lag in range(max_lag + 1)])


def _acf_peaks(acf: np.ndarray, dt: float) -> list[dict]:
    peaks: list[dict] = []
    conf = 1.96 / math.sqrt(max(2, acf.size))
    for i in range(2, acf.size - 1):
        if acf[i] > acf[i - 1] and acf[i] > acf[i + 1] and acf[i] > 0.1:
            peaks.append({"lag": float(i * dt), "value": float(acf[i]), "significant": bool(acf[i] > conf)})
    peaks.sort(key=lambda item: item["value"], reverse=True)
    return peaks[:5]


def _burg_psd(series: np.ndarray, order: int, dt: float) -> tuple[np.ndarray, np.ndarray]:
    """Burg 最大熵谱估计（Maximum Entropy Method）。

    返回 (频率, 功率谱密度)，频率单位为 1/(dt 单位)。
    """
    x = np.asarray(series, dtype=float) - float(np.mean(series))
    n = x.size
    order = int(min(max(1, order), max(1, n - 2)))

    ef = x.copy()  # 前向预测误差
    eb = x.copy()  # 后向预测误差
    a = np.zeros((order + 1, order + 1))
    a[0, 0] = 1.0
    power = float(np.dot(x, x) / n) or 1.0

    for m in range(1, order + 1):
        ef_seg = ef[m:n]
        eb_seg = eb[m - 1 : n - 1]
        den = float(np.dot(ef_seg, ef_seg) + np.dot(eb_seg, eb_seg))
        num = -2.0 * float(np.dot(ef_seg, eb_seg))
        k = num / den if den > 0 else 0.0

        # 反射系数更新预测误差滤波器系数
        prev = a[m - 1, :].copy()
        a[m, :] = prev
        for i in range(1, m + 1):
            a[m, i] = prev[i] + k * prev[m - i]
        a[m, m] = k

        power *= 1.0 - k * k
        if m < order:
            ef_new = ef.copy()
            eb_new = eb.copy()
            ef_new[m:n] = ef[m:n] + k * eb[m - 1 : n - 1]
            eb_new[m:n] = eb[m - 1 : n - 1] + k * ef[m:n]
            ef, eb = ef_new, eb_new

    power = max(power, 1e-18)
    nfreq = max(256, min(2048, n * 4))
    freqs = np.linspace(1.0 / (nfreq * dt), 0.5 / dt, nfreq // 2)
    z = np.exp(-2j * np.pi * np.outer(freqs * dt, np.arange(order + 1)))
    denom = np.abs(z @ a[order, :]) ** 2
    psd = (power * dt) / np.maximum(denom, 1e-12)
    return freqs, psd


# ---------------------------------------------------------------------- 突变
def abrupt_change(
    values: Sequence[float],
    *,
    method: str = "mann-kendall",
    window: int = 10,
) -> dict[str, Any]:
    """突变检测：Mann-Kendall 检验、滑动 t 检验、Pettitt 检验。"""
    arr = _prepare(values)
    n = arr.size
    method = (method or "mann-kendall").lower()
    result: dict[str, Any] = {"type": "abrupt-change", "method": method, "n": int(n)}

    if method in ("mann-kendall", "mk", "all"):
        result["mann_kendall"] = _mann_kendall(arr)
    if method in ("sliding-t", "ttest", "t", "all"):
        result["sliding_t"] = _sliding_t(arr, window)
    if method in ("pettitt", "all"):
        result["pettitt"] = _pettitt(arr)
    if method not in ("mann-kendall", "mk", "sliding-t", "ttest", "t", "pettitt", "all"):
        raise AnalysisError(f"未知的突变检测方法：{method}")
    return result


def _mann_kendall(arr: np.ndarray) -> dict[str, Any]:
    n = arr.size
    s = np.zeros(n)
    uf = np.zeros(n)
    ub = np.zeros(n)
    for k in range(1, n):
        s[k] = s[k - 1] + np.sum(np.sign(arr[k] - arr[:k]))
    var = np.array([k * (k + 1) * (2 * k + 5) / 72.0 for k in range(n)])
    with np.errstate(divide="ignore", invalid="ignore"):
        uf = np.where(var > 0, (s - np.array([k * (k - 1) / 4.0 for k in range(n)])) / np.sqrt(var), 0.0)
    rev = arr[::-1]
    s2 = np.zeros(n)
    for k in range(1, n):
        s2[k] = s2[k - 1] + np.sum(np.sign(rev[k] - rev[:k]))
    with np.errstate(divide="ignore", invalid="ignore"):
        ub_rev = np.where(var > 0, (s2 - np.array([k * (k - 1) / 4.0 for k in range(n)])) / np.sqrt(var), 0.0)
    ub = ub_rev[::-1]

    critical = 1.96
    crossings = [i for i in range(1, n) if (uf[i - 1] - critical) * (uf[i] - critical) < 0]
    return {
        "uf": [jsonable(v) for v in uf.tolist()],
        "ub": [jsonable(v) for v in ub.tolist()],
        "critical": critical,
        "crossings": crossings[:20],
        "trend": "上升" if uf[-1] > critical else ("下降" if uf[-1] < -critical else "不显著"),
        "final_z": float(uf[-1]),
    }


def _sliding_t(arr: np.ndarray, window: int) -> dict[str, Any]:
    n = arr.size
    window = int(max(3, min(window, n // 2)))
    stats_out: list[float | None] = []
    for i in range(window, n - window + 1):
        a = arr[i - window : i]
        b = arr[i : i + window]
        va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
        denom = math.sqrt(va / window + vb / window)
        if denom == 0:
            stats_out.append(None)
            continue
        stats_out.append(float((a.mean() - b.mean()) / denom))

    finite = [(i + window, v) for i, v in enumerate(stats_out) if v is not None]
    critical = float(stats.t.ppf(0.975, 2 * window - 2))
    extremes = sorted(finite, key=lambda item: abs(item[1]), reverse=True)[:6]
    return {
        "t": [jsonable(v) for v in stats_out],
        "window": window,
        "critical": critical,
        "extremes": [{"index": int(i), "t": float(v), "significant": bool(abs(v) > critical)} for i, v in extremes],
    }


def _pettitt(arr: np.ndarray) -> dict[str, Any]:
    n = arr.size
    u = np.zeros(n)
    for t in range(1, n):
        u[t] = u[t - 1] + np.sum(np.sign(arr[t] - arr[:t]))
    k = int(np.argmax(np.abs(u)))
    p_value = min(1.0, 2.0 * math.exp((-6.0 * u[k] ** 2) / (n**3 + n**2)))
    return {
        "index": k,
        "statistic": float(u[k]),
        "p_value": float(p_value),
        "significant": bool(p_value < 0.05),
        "u": [jsonable(v) for v in u.tolist()],
    }


# ---------------------------------------------------------------------- 交叉谱
def cross_spectrum(
    values_a: Sequence[float],
    values_b: Sequence[float],
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    max_periods: int = 200,
) -> dict[str, Any]:
    """相干谱与相位谱。"""
    a = _prepare(values_a)
    b = _prepare(values_b)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    a = _detrend(a, detrend)
    b = _detrend(b, detrend)

    seg = int(min(256, max(32, n // 4)))
    noverlap = seg // 2
    if n < seg:
        seg, noverlap = n, 0
    freqs, pxx = signal.welch(a, fs=1.0 / dt, nperseg=seg, noverlap=noverlap, detrend=False)
    _, pyy = signal.welch(b, fs=1.0 / dt, nperseg=seg, noverlap=noverlap, detrend=False)
    _, pxy = signal.csd(a, b, fs=1.0 / dt, nperseg=seg, noverlap=noverlap, detrend=False)

    mask = freqs > 0
    freqs = freqs[mask]
    pxx, pyy, pxy = pxx[mask], pyy[mask], pxy[mask]

    coherence = np.abs(pxy) ** 2 / np.maximum(pxx * pyy, 1e-18)
    phase = np.degrees(np.angle(pxy))
    coh_phase = np.cos(np.angle(pxy))

    if freqs.size > max_periods:
        step = int(math.ceil(freqs.size / max_periods))
        freqs, coherence, phase, coh_phase = freqs[::step], coherence[::step], phase[::step], coh_phase[::step]

    periods = 1.0 / freqs
    r, p_value = stats.pearsonr(a, b)
    return {
        "type": "cross-spectrum",
        "n": int(n),
        "dt": float(dt),
        "period": [jsonable(v) for v in periods.tolist()],
        "coherence": [jsonable(v) for v in coherence.tolist()],
        "phase": [jsonable(v) for v in phase.tolist()],
        "cosine": [jsonable(v) for v in coh_phase.tolist()],
        "correlation": {"r": float(r), "p": float(p_value)},
        "peaks": _top_periods(periods, coherence, np.zeros_like(coherence), top=5),
    }


# ---------------------------------------------------------------------- EEMD
def eemd_decompose(
    values: Sequence[float],
    *,
    max_imfs: int = 6,
    noise: float = 0.2,
    trials: int = 60,
) -> dict[str, Any]:
    """集合经验模态分解（自实现，不依赖 PyEMD）。"""
    arr = _prepare(values, min_length=16)
    arr = arr - arr.mean()
    n = arr.size
    std = float(np.std(arr))
    if std == 0:
        raise AnalysisError("序列方差为 0，无法分解")

    max_imfs = int(max(2, min(max_imfs, 8)))
    trials = int(max(5, min(trials, 200)))
    rng = np.random.default_rng(20240521)

    accum = np.zeros((max_imfs, n))
    counts = np.zeros(max_imfs)
    for _ in range(trials):
        noisy = arr + rng.normal(0.0, noise * std, n)
        imfs, _residue = _emd(noisy, max_imfs)
        for i, imf in enumerate(imfs[:max_imfs]):
            accum[i] += imf
            counts[i] += 1

    imfs = [accum[i] / max(counts[i], 1) for i in range(max_imfs) if counts[i] > 0]
    residue = arr - np.sum(imfs, axis=0)
    variances = [float(np.var(imf)) for imf in imfs]
    total = sum(variances) or 1.0
    return {
        "type": "eemd",
        "n": int(n),
        "imf_count": len(imfs),
        "imfs": [[jsonable(v) for v in imf.tolist()] for imf in imfs],
        "residue": [jsonable(v) for v in residue.tolist()],
        "variance_ratio": [float(v / total) for v in variances],
        "meta": {"noise": noise, "trials": trials},
    }


def _emd(signal_in: np.ndarray, max_imfs: int) -> tuple[list[np.ndarray], np.ndarray]:
    residue = signal_in.astype(float).copy()
    imfs: list[np.ndarray] = []
    for _ in range(max_imfs):
        imf = _sift(residue)
        if imf is None:
            break
        imfs.append(imf)
        residue = residue - imf
        if np.allclose(residue, 0, atol=1e-10):
            break
    return imfs, residue


def _sift(x: np.ndarray, max_iter: int = 8, tol: float = 0.05) -> np.ndarray | None:
    h = x.copy()
    idx = np.arange(x.size)
    for _ in range(max_iter):
        max_pos, max_val = _local_extrema(h, idx, "max")
        min_pos, min_val = _local_extrema(h, idx, "min")
        if max_pos.size < 2 or min_pos.size < 2:
            return None
        upper = np.interp(idx, max_pos, max_val)
        lower = np.interp(idx, min_pos, min_val)
        mean = (upper + lower) / 2.0
        h = h - mean
        amp = np.max(np.abs(upper - lower))
        if amp == 0 or np.sum(np.abs(mean)) / (np.sum(np.abs(h)) + 1e-12) < tol:
            break
    return h


def _local_extrema(y: np.ndarray, idx: np.ndarray, mode: str) -> tuple[np.ndarray, np.ndarray]:
    if mode == "max":
        mask = np.r_[False, (y[1:-1] > y[:-2]) & (y[1:-1] > y[2:]), False]
    else:
        mask = np.r_[False, (y[1:-1] < y[:-2]) & (y[1:-1] < y[2:]), False]
    positions = idx[mask]
    values = y[mask]
    if positions.size == 0 or positions[0] != 0:
        positions = np.r_[0, positions]
        values = np.r_[y[0], values]
    if positions[-1] != y.size - 1:
        positions = np.r_[positions, y.size - 1]
        values = np.r_[values, y[-1]]
    return positions.astype(float), values.astype(float)


# ---------------------------------------------------------------------- 相关
def correlation(
    values_a: Sequence[float],
    values_b: Sequence[float],
    *,
    max_lag: int = 20,
    method: str = "pearson",
) -> dict[str, Any]:
    a = _prepare(values_a)
    b = _prepare(values_b)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]

    if method == "spearman":
        r, p = stats.spearmanr(a, b)
    elif method == "kendall":
        r, p = stats.kendalltau(a, b)
    else:
        r, p = stats.pearsonr(a, b)

    lag_limit = int(min(max_lag, n // 3))
    lags = list(range(-lag_limit, lag_limit + 1))
    lags = [lag for lag in lags if lag != 0]
    values = []
    for lag in lags:
        if lag > 0:
            x, y = a[lag:], b[: n - lag]
        else:
            x, y = a[: n + lag], b[-lag:]
        if x.size < 4:
            values.append(None)
            continue
        try:
            values.append(float(np.corrcoef(x, y)[0, 1]))
        except Exception:
            values.append(None)

    best_lag = None
    finite = [(lag, v) for lag, v in zip(lags, values) if v is not None]
    if finite:
        best_lag = max(finite, key=lambda item: abs(item[1]))

    # 线性拟合
    slope, intercept = np.polyfit(a, b, 1)
    return {
        "type": "correlation",
        "method": method,
        "n": int(n),
        "r": float(r),
        "p": float(p),
        "r2": float(r * r),
        "lag": {"lags": lags, "values": [jsonable(v) for v in values], "best": best_lag},
        "fit": {"slope": float(slope), "intercept": float(intercept)},
        "scatter": {
            "x": [jsonable(v) for v in a.tolist()],
            "y": [jsonable(v) for v in b.tolist()],
        },
    }


def compare_series(
    series: dict[str, Sequence[float]],
    *,
    normalize: bool = True,
) -> dict[str, Any]:
    """多序列对比：标准化曲线 + 相关矩阵 + 统计摘要。"""
    prepared: dict[str, np.ndarray] = {}
    for name, values in series.items():
        arr = np.asarray(values, dtype=float).ravel()
        if arr.size < 2:
            continue
        prepared[name] = arr

    if len(prepared) < 1:
        raise AnalysisError("至少需要一条有效序列")

    length = min(arr.size for arr in prepared.values())
    prepared = {name: arr[:length] for name, arr in prepared.items()}

    labels = list(prepared)
    matrix = []
    for i, name_a in enumerate(labels):
        row = []
        for j, name_b in enumerate(labels):
            if i == j:
                row.append(1.0)
                continue
            try:
                row.append(float(np.corrcoef(prepared[name_a], prepared[name_b])[0, 1]))
            except Exception:
                row.append(None)
        matrix.append(row)

    curves = {}
    for name, arr in prepared.items():
        if normalize:
            std = float(np.std(arr)) or 1.0
            curves[name] = [jsonable(v) for v in ((arr - arr.mean()) / std).tolist()]
        else:
            curves[name] = [jsonable(v) for v in arr.tolist()]

    summary = {
        name: {
            "mean": float(np.mean(arr)),
            "std": float(np.std(arr)),
            "min": float(np.min(arr)),
            "max": float(np.max(arr)),
            "n": int(arr.size),
        }
        for name, arr in prepared.items()
    }

    return {
        "type": "compare",
        "n": int(length),
        "labels": labels,
        "curves": curves,
        "matrix": matrix,
        "summary": summary,
        "normalize": bool(normalize),
    }
