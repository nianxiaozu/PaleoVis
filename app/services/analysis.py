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
from app.services import easyclimate_bridge


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
        return arr
    if mode == "linear":
        x = np.arange(arr.size, dtype=float)
        slope, intercept = np.polyfit(x, arr, 1)
        return arr - (slope * x + intercept)
    if mode == "mean":
        return arr - arr.mean()
    raise AnalysisError(f"未知的去趋势方式：{mode}")


# ---------------------------------------------------------------------- 功率谱
#: 周期图 / MTM 可用的窗函数
SPECTRUM_WINDOWS = ("none", "boxcar", "hann", "hamming", "blackman", "bartlett")
#: REDFIT（SPECTRUM 程序）的窗函数（对应 iwin = 0..4）
REDFIT_WINDOWS = ("rectangular", "welch", "hanning", "triangular", "blackmanharris")
#: 支持的功率谱计算方法
SPECTRUM_METHODS = ("periodogram", "redfit", "mtm")


def _spectrum_window(name: str, n: int) -> np.ndarray:
    """周期图 / MTM 用的窗（周期窗，适配 FFT）。"""
    key = (name or "none").strip().lower()
    if key in ("none", "boxcar", "rectangular", "square"):
        return np.ones(n, dtype=float)
    if key == "hann":
        return signal.windows.hann(n, sym=False)
    if key == "hamming":
        return signal.windows.hamming(n, sym=False)
    if key == "blackman":
        return signal.windows.blackman(n, sym=False)
    if key == "bartlett":
        return signal.windows.bartlett(n)
    raise AnalysisError("未知的窗函数：" + str(name) + "（可选 " + ", ".join(SPECTRUM_WINDOWS) + "）")


def _ar1_rho(arr: np.ndarray) -> float:
    """线性去趋势后的 lag-1 自相关（偏置估计，与 REDFIT 的 rho 口径一致）。"""
    resid = _detrend(arr, "linear")
    denom = float(np.dot(resid, resid))
    if denom <= 0.0:
        return 0.0
    return float(np.clip(np.dot(resid[:-1], resid[1:]) / denom, -0.999, 0.999))


def _ar1_spectrum(freqs: np.ndarray, rho: float, fnyq: float) -> np.ndarray:
    """AR(1) 红噪声理论功率谱（未归一化）。"""
    safe = max(float(fnyq), 1e-12)
    return (1.0 - rho**2) / (1.0 - 2.0 * rho * np.cos(np.pi * freqs / safe) + rho**2)


def power_spectrum(
    values: Sequence[float],
    time: Sequence[float | int] | None = None,
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    method: str = "periodogram",
    window: str = "hann",
    min_periods: float | None = None,
    max_periods: float | None = None,
    ofac: float = 2.0,
    hifac: float = 1.0,
    n50: int = 2,
    iwin: str = "rectangular",
    nw: float = 4.0,
    k: int | None = None,
    confidence: float = 0.95,
    mctest: bool = False,
    nsim: int = 1000,
) -> dict[str, Any]:
    """功率谱分析，支持三种计算方法。

    * periodogram：经典周期图（easyclimate 的 calc_time_spectrum），自由度 2；
    * redfit：Schulz & Mudelsee (2002) 的 REDFIT / WOSA 估计
      （easyclimate 的 calc_redfit），用 AR(1) 红噪声 + 卡方检验给出阈值；
      打开 mctest 时改由蒙特卡洛模拟（nsim 次）给出阈值；
    * mtm：多窗谱（Thomson 1982），DPSS 锥形窗平均，自由度 2K。

    三种方法都返回同一套字段：period / power / threshold / peaks，
    前端只需切换 x 轴比例，不必区分算法。
    """
    arr = _prepare(values)
    n = arr.size

    key = (method or "periodogram").strip().lower()
    if key not in SPECTRUM_METHODS:
        raise AnalysisError(
            "未知的功率谱方法：" + str(method) + "（可选 " + ", ".join(SPECTRUM_METHODS) + "）"
        )

    fnyq = 0.5 / dt
    rho = _ar1_rho(arr)
    detrended = _detrend(arr, detrend)
    extra: dict[str, Any] = {}
    #: redfit 分支由 easyclimate 直接给出阈值数组，其余方法用 AR(1) 红噪声自算
    threshold_full: np.ndarray | None = None

    if key == "periodogram":
        # easyclimate 的 calc_time_spectrum 不支持加窗，这里先乘窗再送进去；
        # 它的功率是 |ifft|²，换算成谱密度需要乘 n·dt / mean(w²)（与
        # scipy.signal.periodogram(scaling="density") 的归一化一致）。
        win = _spectrum_window(window, n)
        out = easyclimate_bridge.time_spectrum(detrended * win, dt=dt)
        freqs = np.asarray(out["frequency"], dtype=float)
        power = np.asarray(out["power"], dtype=float)
        power = power * (n * dt / (float(np.mean(win**2)) or 1.0))
        dof = 2.0
        bandwidth = 1.0 / (n * dt)
        extra = {"engine": "easyclimate"}
    elif key == "redfit":
        n50 = max(1, int(n50))
        seg = int(round(n / (1.0 + (n50 - 1) / 2.0)))
        if seg > n:
            seg = n
        if seg < 8:
            raise AnalysisError(
                "REDFIT 分段长度过短（" + str(seg) + " 点）：请减小分段数 n50 或使用更长的序列"
            )
        out = easyclimate_bridge.redfit(
            detrended,
            time,
            dt=dt,
            nsim=nsim,
            mctest=mctest,
            window=iwin,
            ofac=ofac,
            hifac=hifac,
            n50=n50,
            confidence=confidence,
        )
        freqs = np.asarray(out["frequency"], dtype=float)
        power = np.asarray(out["power"], dtype=float)
        threshold_full = np.asarray(out["threshold"], dtype=float)
        # REDFIT 后端的阈值列在部分参数组合（如 n50=1 且 ofac>1、n50=3）下会整列
        # 退化成 0 或 NaN，此时丢掉该列、改由下面的 AR(1) 红噪声路径自算阈值。
        fallback = (
            threshold_full.size != power.size
            or not np.all(np.isfinite(threshold_full))
            or not np.any(threshold_full > 0)
        )
        if fallback:
            threshold_full = None
        if out.get("dof"):
            dof = float(out["dof"])
        else:  # pragma: no cover - 极端情况下文本解析失败
            dof = 4.0 * n50**2 / (3.0 * n50 - 1.0)
        bandwidth = float(out.get("bandwidth") or 1.21 / (seg * dt))
        extra = {
            "engine": "easyclimate",
            "segments": n50,
            "segment_length": int(seg),
            "iwin": iwin,
            "mctest": bool(mctest),
            "nsim": int(nsim) if mctest else 0,
            "threshold_fallback": bool(fallback),
        }

    else:  # mtm
        nw = float(nw)
        if nw * 2.0 >= n:
            raise AnalysisError(
                "MTM 时间带宽积过大（nw=" + str(nw) + "），序列至少需要 " + str(int(nw * 2) + 2) + " 个点"
            )
        # 默认只取 3 个锥形窗：窗数越多谱越平滑，短序列上会把窄峰抹平，
        # 实测 3 个窗在 120~960 点、6~100 周期的合成信号上主峰定位最稳。
        kk = int(k) if k else min(3, max(1, int(round(2.0 * nw - 1))))
        kk = max(1, min(kk, int(2.0 * nw)))
        tapers = signal.windows.dpss(n, NW=nw, Kmax=kk, norm=2)
        freqs = np.fft.rfftfreq(n, d=dt)
        power = np.zeros(freqs.size, dtype=float)
        for taper in tapers:
            spec = np.fft.rfft(detrended * taper)
            power += np.abs(spec) ** 2 * dt
        power /= float(tapers.shape[0])
        dof = 2.0 * kk
        bandwidth = 2.0 * nw / (n * dt)
        extra = {"nw": nw, "tapers": kk}

    freqs = np.asarray(freqs, dtype=float)
    power = np.asarray(power, dtype=float)

    # 只保留正频率，并按用户给定的周期窗口裁剪
    keep = freqs > 0
    if min_periods:
        keep &= freqs <= 1.0 / float(min_periods)
    if max_periods:
        keep &= freqs >= 1.0 / float(max_periods)
    freqs, power = freqs[keep], power[keep]
    if freqs.size < 3:
        raise AnalysisError("周期范围过窄或序列过短，无法计算功率谱")

    periods = 1.0 / freqs

    chi_factor = float(stats.chi2.ppf(confidence, dof) / dof)
    if threshold_full is not None and threshold_full.size == keep.size:
        # REDFIT 的阈值列已经是「红噪声谱 × 卡方因子」的最终阈值，
        # 与 gxx 同一套归一化，直接裁剪即可，不必再自己标定幅度。
        threshold = np.asarray(threshold_full, dtype=float)[keep]
    else:  # pragma: no cover - 只有 redfit 分支会给 threshold_full
        # 其余方法：AR(1) 红噪声谱按实测谱的整体功率标定幅度后乘卡方因子
        gred = _ar1_spectrum(freqs, rho, fnyq)
        mean_gred = float(np.mean(gred))
        scale = (float(np.mean(power)) / mean_gred) if mean_gred > 0 else 1.0
        threshold = gred * scale * chi_factor

    meta = {
        "method": key,
        "window": window if key == "periodogram" else (iwin if key == "redfit" else "dpss"),
        "lag1": rho,
        "confidence": float(confidence),
        "dof": float(dof),
        "bandwidth": float(bandwidth),
        "fnyquist": float(fnyq),
        "ofac": float(ofac),
        "hifac": float(hifac),
        "chi2_factor": chi_factor,
        "detrend": detrend,
    }
    meta.update(extra)

    return {
        "type": "power-spectrum",
        "n": int(n),
        "dt": float(dt),
        "detrend": detrend,
        "frequency": [jsonable(v) for v in freqs.tolist()],
        "period": [jsonable(v) for v in periods.tolist()],
        "power": [jsonable(v) for v in power.tolist()],
        "threshold": [jsonable(v) for v in threshold.tolist()],
        "peaks": _top_periods(periods, power, threshold, top=6),
        "meta": meta,
    }


# periodogram方法的功率谱计算,用于计算ar1（时间序列的一阶自相关系数）
def calculate_ar1_coefficient(time_series):
    """
    使用自相关系数法计算 AR(1) 模型的系数 alpha
    :param time_series: 输入的时间序列
    :return: AR(1) 系数 lag1
    """
    time_series = np.asarray(time_series)
    n = len(time_series)
    mean = np.mean(time_series)
    var_0 = np.sum((time_series - mean) ** 2) / n
    cov_1 = np.sum((time_series[:-1] - mean) *
                   (time_series[1:] - mean)) / (n - 1)
    autocorr_1 = cov_1 / var_0
    return autocorr_1


def _top_periods(periods: np.ndarray, power: np.ndarray, threshold: np.ndarray, top: int = 6,) -> list[dict]:
    candidate_limit = max(top * 4, 12)
    # 1. 划分显著与非显著点索引
    is_sig = power >= threshold
    sig_indices = np.where(is_sig)[0]
    nonsig_indices = np.where(~is_sig)[0]
    # 2. 各自按功率从大到小排序
    sig_sorted = sig_indices[np.argsort(power[sig_indices])[::-1]]
    nonsig_sorted = nonsig_indices[np.argsort(power[nonsig_indices])[::-1]]
    # 3. 候选池筛选：先显著周期，不足 top * 4 时用非显著周期的最大功率补充
    if len(sig_sorted) >= candidate_limit:
        candidate_indices = sig_sorted[:candidate_limit]
    else:
        needed = candidate_limit - len(sig_sorted)
        candidate_indices = np.concatenate(
            [sig_sorted, nonsig_sorted[:needed]])
    # 4. 遍历候选集（先显著再非显著，且各自按功率降序排列），进行邻近去重
    peaks: list[dict] = []
    seen: list[float] = []

    for i in candidate_indices:
        p = float(periods[i])
        # 避免邻近相似周期重复选取（对数距离小于 0.1）
        if any(abs(math.log(p) - math.log(s)) < 0.1 for s in seen):
            continue

        seen.append(p)
        peaks.append(
            {
                "period": p,
                "power": float(power[i]),
                "threshold": float(threshold[i]),
                "significant": bool(power[i] >= threshold[i]),
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
    max_scale: int = 64,
    confidence: float = 0.95,
    pad: float = 1.0,
    dj: float = 0.25,
    j1_n_div_dj: float | None = None,
    s0: float | None = None,
    lag1: float | None = None,
    mother: str = "morlet",
    mother_param: float | None = None,
    sigtest_wavelet: str = "regular chi-square test",
    sigtest_global: str = "time-average test",
) -> dict[str, Any]:
    """连续小波变换，输出功率谱、显著性、全局小波谱与影响锥。

    核心算法由 easyclimate.filter.calc_timeseries_wavelet_transform 提供（Torrence &
    Compo 1998 方案：复 Morlet 母小波、AR(1) 红噪声背景、卡方显著性检验），本函数只负责
    预处理、抽稀与结构化输出。参数名与 easyclimate 保持一致，便于前端直接透传。
    """
    series = _prepare(values, min_length=16)
    n = series.size

    # 小波尺度上限不超过序列长度的一半，否则边缘效应吞掉全部有效信息
    max_scale = int(min(max(max_scale, 4), max(4, n // 2)))
    result = easyclimate_bridge.wavelet_transform(
        series,
        dt=dt,
        max_scale=max_scale,
        confidence=confidence,
        pad=pad,
        dj=dj,
        j1_n_div_dj=j1_n_div_dj,
        s0=s0,
        lag1=lag1,
        mother=mother,
        mother_param=mother_param,
        sigtest_wavelet=sigtest_wavelet,
        sigtest_global=sigtest_global,
    )

    periods = result["period"]
    power = result["power"]
    ratio = result["ratio"]
    global_ws = result["global_ws"]
    global_signif = result["global_signif"]
    coi = result["coi"]
    nscale = int(periods.size)

    # 影响锥：每个时刻仍处于可信范围内的最大尺度索引
    cone = np.clip(np.searchsorted(periods, coi, side="right") - 1, 0, nscale - 1)

    # 抽稀时间轴用于前端渲染（功率场与显著性场保持同一抽稀步长）
    time_step = max(1, n // 160)
    power_out = power[:, ::time_step]
    ratio_out = ratio[:, ::time_step]

    return {
        "type": "wavelet",
        "n": int(n),
        "dt": float(dt),
        "period": [jsonable(p) for p in periods.tolist()],
        "time_index": [int(i) for i in range(0, n, time_step)],
        "power": [[jsonable(v) for v in row] for row in power_out.tolist()],
        "significance": [[jsonable(v) for v in row] for row in ratio_out.tolist()],
        "global": [jsonable(v) for v in global_ws.tolist()],
        "global_signif": [jsonable(v) for v in global_signif.tolist()],
        "coi": [jsonable(v) for v in coi[::time_step].tolist()],
        "cone": [int(c) for c in cone[::time_step].tolist()],
        "peaks": _top_periods(periods, global_ws, global_signif, top=5),
        "meta": {
            "mother": str(result["mother"]),
            "mother_param": float(result["mother_param"]),
            "engine": "easyclimate",
            "confidence": float(confidence),
            "lag1": float(result["lag1"]),
            "s0": float(result["s0"]),
            "dj": float(result["dj"]),
            "pad": float(result["pad"]),
            "j1": float(result["j1"]),
            "j1_n_div_dj": float(result["j1"]) * float(result["dj"]),
            "sigtest_wavelet": str(result["sigtest_wavelet"]),
            "sigtest_global": str(result["sigtest_global"]),
            "scale_range": [float(periods[0]), float(periods[-1])],
            "n_scales": nscale,
            "n_significant": int(np.count_nonzero(ratio > 1)),
            "significant_ratio": float(np.count_nonzero(ratio > 1) / ratio.size) if ratio.size else 0.0,
        },
    }



# ---------------------------------------------------------------------- 周期
def _confidence_z(confidence: float) -> float:
    """双侧置信水平对应的标准正态分位数（0.90→1.645，0.95→1.96，0.99→2.576）。"""
    level = float(np.clip(confidence, 0.5, 0.9999))
    return float(stats.norm.ppf(0.5 + level / 2.0))


def _acf_standard_error(rho: float, n: int, lag: int) -> float:
    """Bartlett 公式：AR(1) 红噪声背景下样本自相关的标准误。

    推导自 Bartlett (1946) 的大样本方差
        Var(r_k) ≈ (1/n) Σ_v [ρ_v² + ρ_{v+k}·ρ_{v-k} − 2ρ_k·ρ_v·ρ_{v+k}]
    其中 ρ_v = ρ^|v| 为 AR(1) 的理论自相关。ρ=0 时退化为白噪声的 1/√n。
    """
    rho = float(np.clip(rho, -0.999, 0.999))
    vmax = int(max(200, 20 * math.sqrt(max(n, 1))))
    v = np.arange(-vmax, vmax + 1, dtype=float)
    g = rho ** np.abs(v)
    g_plus = rho ** np.abs(v + lag)
    g_minus = rho ** np.abs(v - lag)
    total = np.sum(g**2 + g_plus * g_minus - 2.0 * (rho**lag) * g_plus * g_minus)
    return float(math.sqrt(max(float(total), 0.0) / max(int(n), 1)))


def period_analysis(
    values: Sequence[float],
    *,
    dt: float = 1.0,
    detrend: str = "linear",
    max_period: float | None = None,
    confidence: float = 0.95,
    max_lag: int | None = None,
    order: int | None = None,
) -> dict[str, Any]:
    """自相关 + 最大熵谱（Burg）联合周期识别。

    显著性统一以 AR(1) 红噪声为背景：
      * 自相关用 Bartlett 标准误给出逐滞后的置信带；
      * 最大熵谱用同一条红噪声谱乘卡方分位数得到阈值。
    """
    arr = _prepare(values)
    n = arr.size
    series = _detrend(arr, detrend)
    level = float(np.clip(confidence, 0.5, 0.999))
    z = _confidence_z(level)
    # 与功率谱 / REDFIT 同口径的 AR(1) 系数
    rho = _ar1_rho(arr)
    fnyq = 0.5 / dt

    # ---- 自相关及其红噪声置信带 ----
    lag_limit = int(min(n - 2, max(10, n // 3)))
    if max_lag:
        lag_limit = int(min(lag_limit, max(2, int(max_lag))))
    acf = _autocorrelation(series, lag_limit)
    lags = np.arange(acf.size, dtype=float)
    acf_se = np.array([_acf_standard_error(rho, n, int(k)) for k in lags])
    acf_bound = np.clip(z * acf_se, 0.0, 1.0)
    acf_periods = _acf_peaks(acf, dt, acf_bound, acf_se)

    # ---- 最大熵谱及其红噪声阈值 ----
    spectrum_order = int(min(20, max(4, n // 10)))
    if order:
        spectrum_order = int(min(spectrum_order, max(1, int(order))))
    freqs, psd = _burg_psd(series, spectrum_order, dt)
    periods = 1.0 / freqs
    red = _ar1_spectrum(freqs, rho, fnyq)
    red_mean = float(np.mean(red)) or 1.0
    psd_mean = float(np.mean(psd)) or 1.0
    # 把理论红噪声谱标定到与实测谱同一量级，再乘卡方分位数（每频点 2 个自由度）
    threshold = red * (psd_mean / red_mean) * float(stats.chi2.ppf(level, 2.0) / 2.0)
    peaks = _top_periods(periods, psd, threshold, top=6)

    if max_period:
        keep = [p for p in peaks if p["period"] <= max_period]
        peaks = keep or peaks

    # 频率升序 → 周期降序；绘图时按周期升序排，横轴才从左到右递增
    step = max(1, len(freqs) // 300)
    periods_plot = periods[::step][::-1]
    psd_plot = psd[::step][::-1]
    threshold_plot = threshold[::step][::-1]
    # 超过序列长度的周期是外推出来的，谱值没有实际分辨率，默认裁掉以免横轴被拉长
    display_max = float(max_period) if max_period else float(n * dt)
    visible = periods_plot <= display_max
    if visible.sum() >= 8:
        periods_plot = periods_plot[visible]
        psd_plot = psd_plot[visible]
        threshold_plot = threshold_plot[visible]
    return {
        "type": "period",
        "n": int(n),
        "dt": float(dt),
        "detrend": detrend,
        "acf": {
            "lag": [jsonable(v) for v in (np.arange(acf.size) * dt).tolist()],
            "value": [jsonable(v) for v in acf.tolist()],
            "peaks": acf_periods,
            # 兼容字段：lag-1 处的置信界，前端指标卡直接显示它
            "confidence": float(acf_bound[1]) if acf_bound.size > 1 else float(acf_bound[0]),
            "bound": [jsonable(v) for v in acf_bound.tolist()],
            "se": [jsonable(v) for v in acf_se.tolist()],
            "z": float(z),
            "level": level,
            "rho": float(rho),
            "max_lag": int(lag_limit),
        },
        "spectrum": {
            "period": [jsonable(v) for v in periods_plot.tolist()],
            "power": [jsonable(v) for v in psd_plot.tolist()],
            "threshold": [jsonable(v) for v in threshold_plot.tolist()],
        },
        "peaks": peaks,
        "meta": {
            "method": "burg",
            "order": spectrum_order,
            "display_max_period": display_max,
            "confidence": level,
            "lag1": float(rho),
            "dof": 2.0,
            "acf_max_lag": int(lag_limit),
        },
    }


def _autocorrelation(series: np.ndarray, max_lag: int) -> np.ndarray:
    s = series - series.mean()
    denom = float(np.dot(s, s)) or 1.0
    return np.array([float(np.dot(s[: s.size - lag], s[lag:]) / denom) for lag in range(max_lag + 1)])


def _acf_peaks(
    acf: np.ndarray,
    dt: float,
    bound: np.ndarray,
    se: np.ndarray | None = None,
) -> list[dict]:
    """自相关的局部极大值；显著性用逐滞后的红噪声置信界判定。"""
    peaks: list[dict] = []
    for i in range(2, acf.size - 1):
        if acf[i] > acf[i - 1] and acf[i] > acf[i + 1] and acf[i] > 0.05:
            limit = float(bound[i]) if i < bound.size else 0.0
            peaks.append(
                {
                    "lag": float(i * dt),
                    "value": float(acf[i]),
                    "threshold": limit,
                    "se": float(se[i]) if se is not None and i < se.size else None,
                    "significant": bool(acf[i] > limit),
                }
            )
    peaks.sort(key=lambda item: item["value"], reverse=True)
    return peaks[:5]


def _burg_psd(series: np.ndarray, order: int, dt: float) -> tuple[np.ndarray, np.ndarray]:
    """Burg 最大熵谱估计（Maximum Entropy Method）。

    返回 (频率, 功率谱密度)，频率单位为 1/(dt 单位)。
    谱的量级按序列方差标定：Burg 递推得到的预测误差功率在近确定性序列上会衰减到
    1e-18 量级（反射系数趋近 ±1），直接乘到谱上会让整条谱归零，因此这里不直接用
    预测误差功率，而是用序列方差除以归一化后的预测误差滤波器分母。
    """
    x = np.asarray(series, dtype=float) - float(np.mean(series))
    n = x.size
    order = int(min(max(1, order), max(1, n - 2)))
    variance = float(np.var(x)) or 1.0

    ef = x.copy()  # 前向预测误差
    eb = x.copy()  # 后向预测误差
    a = np.zeros((order + 1, order + 1))
    a[0, 0] = 1.0

    for m in range(1, order + 1):
        ef_seg = ef[m:n]
        eb_seg = eb[m - 1: n - 1]
        den = float(np.dot(ef_seg, ef_seg) + np.dot(eb_seg, eb_seg))
        num = -2.0 * float(np.dot(ef_seg, eb_seg))
        k = num / den if den > 0 else 0.0

        # 反射系数更新预测误差滤波器系数
        prev = a[m - 1, :].copy()
        a[m, :] = prev
        for i in range(1, m + 1):
            a[m, i] = prev[i] + k * prev[m - i]
        a[m, m] = k

        if m < order:
            ef_new = ef.copy()
            eb_new = eb.copy()
            ef_new[m:n] = ef[m:n] + k * eb[m - 1: n - 1]
            eb_new[m:n] = eb[m - 1: n - 1] + k * ef[m:n]
            ef, eb = ef_new, eb_new

    nfreq = max(256, min(2048, n * 4))
    freqs = np.linspace(1.0 / (nfreq * dt), 0.5 / dt, nfreq // 2)
    z = np.exp(-2j * np.pi * np.outer(freqs * dt, np.arange(order + 1)))
    denom = np.maximum(np.abs(z @ a[order, :]) ** 2, 1e-12)
    # 让 1/denom 在整个频段上的均值为 1，谱的平均功率即等于序列方差
    denom_mean = float(np.mean(1.0 / denom)) or 1.0
    psd = (variance * dt) / (denom * denom_mean)
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
    result: dict[str, Any] = {
        "type": "abrupt-change", "method": method, "n": int(n)}

    if method in ("mann-kendall", "mk", "all"):
        result["mann_kendall"] = _mann_kendall(arr)
    if method in ("sliding-t", "ttest", "t", "all"):
        result["sliding_t"] = _sliding_t(arr, window)
    if method in ("pettitt", "all"):
        result["pettitt"] = _pettitt(arr)
    if method not in ("mann-kendall", "mk", "sliding-t", "ttest", "t", "pettitt", "all"):
        raise AnalysisError(f"未知的突变检测方法：{method}")
    return result


def _mk_curve(arr: np.ndarray) -> np.ndarray:
    """Mann-Kendall 顺序统计量曲线：第 m 个点的 S 标准化为 UF。

    对第 m 个点（m 从 1 计数），S_m = sum_{j<m} sign(x_m - x_j)，
    Var(S_m) = m(m-1)(2m+5)/18，UF_m = S_m / sqrt(Var(S_m))。
    该曲线在趋势显著时单调越出 ±1.96 置信线。
    """
    n = arr.size
    uf = np.zeros(n, dtype=float)
    total = 0.0
    for m in range(1, n + 1):
        # 第 m 个点与前面 m-1 个点逐一比较
        total += float(np.sum(np.sign(arr[m - 1] - arr[: m - 1])))
        if m < 2:
            continue
        var = m * (m - 1) * (2 * m + 5) / 18.0
        if var > 0:
            uf[m - 1] = total / math.sqrt(var)
    return uf



def _mann_kendall(arr: np.ndarray) -> dict[str, Any]:
    """Mann-Kendall 突变检验：UF/UB 曲线自算，趋势与显著性由 easyclimate 给出。

    UF 为顺序统计量曲线，UB 为逆序曲线取负（两者在突变点附近相交）。
    趋势判定、Z 值、P 值、Sen 斜率调用 easyclimate.core.mk_test。
    """
    n = arr.size
    uf = _mk_curve(arr)
    ub = -_mk_curve(arr[::-1])[::-1]
    
    # 寻找uf与近似95%置信线相交的位置
    critical = 1.96
    crossings = [i for i in range(1, n) if (uf[i - 1] - critical) * (uf[i] - critical) < 0]
    crossings += [i for i in range(1, n) if (uf[i - 1] + critical) * (uf[i] + critical) < 0]
    crossings.sort()
    # 保证相邻穿越点索引差 >= n//20，避免过密、重复或语义相近的穿越点
    min_gap = n // 50
    if min_gap > 0:
        filtered: list[int] = []
        for c in crossings:
            if not filtered:
                filtered.append(c)
                continue
            if c - filtered[-1] >= min_gap:
                filtered.append(c)
            else:
                # 与上一个保留点距离不足：保留 |UF| 更大者（越界更强、更可信）
                if abs(uf[c]) > abs(uf[filtered[-1]]):
                    filtered[-1] = c
        crossings = filtered

    # 突变点：UF 与 UB 在置信带内最接近的位置
    gap = np.abs(uf - ub)
    inside = np.where(np.abs(uf) < critical)[0]
    mutation = int(inside[np.argmin(gap[inside])]) if inside.size else int(np.argmin(gap))

    try:
        test = easyclimate_bridge.mann_kendall_test(arr)
    except AnalysisError:
        test = {}

    return {
        "uf": [jsonable(v) for v in uf.tolist()],
        "ub": [jsonable(v) for v in ub.tolist()],
        "critical": critical,
        "crossings": crossings,
        "mutation_index": mutation,
        "trend": test.get("trend", "不显著"),
        "final_z": float(test.get("z", uf[-1])),
        "p_value": jsonable(test.get("p_value")),
        "tau": jsonable(test.get("tau")),
        "s": jsonable(test.get("s")),
        "slope": jsonable(test.get("slope")),
        "significant": bool(test.get("significant", abs(uf[-1]) > critical)),
        "engine": "easyclimate" if test else "internal",
    }


def _sliding_t(arr: np.ndarray, window: int) -> dict[str, Any]:
    n = arr.size
    window = int(max(3, min(window, n // 2)))
    stats_out: list[float | None] = []
    for i in range(window, n - window + 1):
        a = arr[i - window: i]
        b = arr[i: i + window]
        va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
        denom = math.sqrt(va / window + vb / window)
        if denom == 0:
            stats_out.append(None)
            continue
        stats_out.append(float((a.mean() - b.mean()) / denom))

    finite = [(i + window, v) for i, v in enumerate(stats_out) if v is not None]
    critical = float(stats.t.ppf(0.975, 2 * window - 2))
    ranked = sorted(finite, key=lambda item: abs(item[1]), reverse=True)

    # extremes 内部任意两个 index 的间距 >= n//50
    min_gap = n // 50
    selected: list[tuple[int, float]] = []
    for idx, v in ranked:
        if all(abs(idx - prev_idx) >= min_gap for prev_idx, _ in selected):
            selected.append((idx, v))
    extremes = selected

    
    return {
        "t": [jsonable(v) for v in stats_out],
        "window": window,
        "critical": critical,
        "extremes": [{"index": int(i), "t": float(v), "significant": bool(abs(v) > critical)} for i, v in extremes],
    }


def _pettitt(arr: np.ndarray) -> dict[str, Any]:
    n = arr.size
    if n < 2:
        return {
            "index": 0, "statistic": 0.0, "p_value": 1.0,
            "significant": False, "u": [0.0] * n,
        }

    # d_i = sum_j sgn(x_i - x_j)，O(n^2)
    d = np.array([np.sum(np.sign(arr[i] - arr)) for i in range(n)])
    u = np.cumsum(d)  # u[t] = U_{t,N}，u[-1] 必为 0

    # 候选 t 为 1..n-1（0-based 索引 0..n-2），排除 U_N=0 的端点
    u_abs = np.abs(u[:-1])
    k = int(np.argmax(u_abs))
    K = float(u_abs[k])
    p_value = min(1.0, 2.0 * math.exp(-6.0 * K ** 2 / (n ** 3 + n ** 2)))

    return {
        "index": k,              # 0-based，表示前 k+1 个点构成第一段
        "statistic": float(u[k]),# 带符号，u[k]<0 表示 t 之后整体变大
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
    max_periods: int = 200,
) -> dict[str, Any]:
    """相干谱与相位谱。"""
    a = _prepare(values_a)
    b = _prepare(values_b)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]

    seg = int(min(256, max(32, n // 4)))
    noverlap = seg // 2
    if n < seg:
        seg, noverlap = n, 0
    freqs, pxx = signal.welch(a, fs=1.0 / dt, nperseg=seg,
                        noverlap=noverlap, detrend=False) # type: ignore
    _, pyy = signal.welch(b, fs=1.0 / dt, nperseg=seg,
                        noverlap=noverlap, detrend=False) # type: ignore
    _, pxy = signal.csd(a, b, fs=1.0 / dt, nperseg=seg,
                        noverlap=noverlap, detrend=False) # type: ignore

    mask = freqs > 0
    freqs = freqs[mask]
    pxx, pyy, pxy = pxx[mask], pyy[mask], pxy[mask]

    coherence = np.abs(pxy) ** 2 / np.maximum(pxx * pyy, 1e-18)
    phase = np.degrees(np.angle(pxy))
    coh_phase = np.cos(np.angle(pxy))

    if freqs.size > max_periods:
        step = int(math.ceil(freqs.size / max_periods))
        freqs, coherence, phase, coh_phase = freqs[::
                                                   step], coherence[::step], phase[::step], coh_phase[::step]

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
    noise_seed: int | None = None,
) -> dict[str, Any]:
    """集合经验模态分解。

    分解由 easyclimate.filter.filter_eemd（Wu & Huang 2009 的噪声辅助方案）完成，
    本函数只负责去均值、参数换算与结果整理。
    """
    arr = _prepare(values, min_length=16)
    arr = arr - arr.mean()
    n = arr.size

    max_imfs = int(max(2, min(max_imfs, 8)))
    trials = int(max(5, min(trials, 200)))
    imfs, noise_width = easyclimate_bridge.eemd_imfs(
        arr, trials=trials, noise_ratio=noise, noise_seed=noise_seed
    )
    if not imfs:
        raise AnalysisError("EEMD 未能分解出本征模态函数")

    # 只保留前 max_imfs 个高频 IMF，剩余部分并入残差
    imfs = [np.asarray(imf, dtype=float) for imf in imfs[:max_imfs]]
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
        "meta": {
            "engine": "easyclimate",
            "noise": float(noise),
            "noise_width": float(noise_width),
            "trials": trials,
            "seed": easyclimate_bridge.EEMD_SEED if noise_seed is None else int(noise_seed),
            "seed_default": noise_seed is None,
        },
    }


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
                row.append(
                    float(np.corrcoef(prepared[name_a], prepared[name_b])[0, 1]))
            except Exception:
                row.append(None)
        matrix.append(row)

    curves = {}
    for name, arr in prepared.items():
        if normalize:
            std = float(np.std(arr)) or 1.0
            curves[name] = [jsonable(v) for v in (
                (arr - arr.mean()) / std).tolist()]
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
