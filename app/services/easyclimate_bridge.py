"""easyclimate 集成层：把第三方库的能力接到项目分析服务上。

设计原则（与需求一致）：不复制第三方库源码，所有高级时序算法都通过
import easyclimate 调用其官方实现。本模块只做三件事：

1. 延迟导入并缓存模块对象（easyclimate 首次导入约 3 秒，避免拖慢服务启动）；
2. 把 numpy 一维序列包装成 xarray.DataArray，再把返回的 xr.Dataset
   摊平成 numpy 数组；
3. 统一异常：第三方库抛出的任何异常都翻译成项目的 AnalysisError。

对外提供的函数：

* time_spectrum —— 经典周期图（easyclimate.filter.spectrum.calc_time_spectrum）
* redfit —— REDFIT / WOSA 红噪声谱，支持红噪声检验与蒙特卡洛检验
* wavelet_transform —— Morlet 连续小波变换（功率谱 / 显著性 / 全局谱 / 影响锥）
* eemd_imfs —— 集合经验模态分解
* mann_kendall_test —— Mann-Kendall 趋势检验与 Sen 斜率
"""
from __future__ import annotations

import os
import re
import threading
from typing import Any, Sequence

import numpy as np

from app.core.config import settings
from app.core.errors import AnalysisError

#: 可复现的 EEMD 白噪声种子（与 easyclimate 的 noise_seed 参数对应）
EEMD_SEED = 20240521

#: 小波母函数（与 easyclimate.filter.wavelet 一致）
WAVELET_MOTHERS = ("morlet", "paul", "dog")

#: 小波显著性检验方式（与 easyclimate.filter.wavelet 一致）
WAVELET_SIGTESTS = (
    "regular chi-square test",
    "time-average test",
    "scale-average test",
)

_lock = threading.Lock()
_modules: dict[str, Any] = {}


def _load(name: str) -> Any:
    """延迟导入 easyclimate 子模块并缓存（线程安全）。"""
    cached = _modules.get(name)
    if cached is not None:
        return cached
    with _lock:
        cached = _modules.get(name)
        if cached is not None:
            return cached
        try:
            if name == "filter":
                import easyclimate.filter as module
            elif name == "spectrum":
                import easyclimate.filter.spectrum as module
            elif name == "redfit":
                import easyclimate.filter.redfit as module
            elif name == "mk_test":
                import easyclimate.core.mk_test as module
            else:  # pragma: no cover - 内部调用保证只有这几种取值
                raise ImportError(name)
        except ImportError as exc:  # pragma: no cover - 依赖缺失时给出明确提示
            raise AnalysisError(
                "未安装 easyclimate，无法进行该分析；请先执行 pip install easyclimate"
            ) from exc
        _modules[name] = module
        return module


def warmup() -> None:
    """预热 easyclimate（供应用启动时的后台线程调用，失败不影响服务）。"""
    try:
        _load("filter")
        _load("spectrum")
        _load("redfit")
        _load("mk_test")
    except Exception:  # pragma: no cover - 预热失败只影响首次调用耗时
        pass


def _series_dataarray(values: Sequence[float], dt: float = 1.0, time: Sequence[float] | None = None) -> Any:
    """把一维序列包装成带 time 坐标的 DataArray。"""
    import xarray as xr
    arr = np.asarray(values, dtype=float).ravel()
    coords = np.arange(arr.size, dtype=float) * float(dt) if time is None else np.asarray(time, dtype=float)
    return xr.DataArray(arr, dims=("time",), coords={"time": coords}, name="value")


def lag1_autocorrelation(values: Sequence[float]) -> float:
    """lag-1 自相关（偏置估计），作为 AR(1) 红噪声的 rho 传给 easyclimate。"""
    z = np.asarray(values, dtype=float).ravel()
    z = z - z.mean()
    denom = float(np.dot(z, z))
    if denom <= 0.0:
        return 0.0
    return float(np.clip(np.dot(z[:-1], z[1:]) / denom, -0.999, 0.999))


#: calc_redfit 在进程当前工作目录写固定名临时文件（tmp_real.output 等），
#: 因此必须串行执行并切换到一个可写目录。
_REDFIT_LOCK = threading.Lock()
_REDFIT_WORKDIR_NAME = "_redfit"

#: calc_redfit 的 attrs['Results'] 文本里可解析出的量
_RESULT_PATTERNS = {
    "rho": re.compile(r"rho\s*=\s*([-+0-9.eE]+)"),
    "dof": re.compile(r"Degrees of freedom\s*=\s*([-+0-9.eE]+)"),
    "bandwidth": re.compile(r"6-dB Bandwidth\s*=\s*([-+0-9.eE]+)"),
}

#: 置信水平 -> REDFIT 输出的阈值列（解析法 / 蒙特卡洛法）
_CHI_COLUMNS = {80: "chi2_80", 90: "chi2_90", 95: "chi2_95", 99: "chi2_99"}
_CI_COLUMNS = {80: "ci80", 90: "ci90", 95: "ci95", 99: "ci99"}


def _to_array(value: Any) -> np.ndarray:
    """把 DataNode / DataArray / list 统一成 float 数组。"""
    if hasattr(value, "values"):
        return np.asarray(value.values, dtype=float)
    return np.asarray(value, dtype=float)


def _fill_nan(values: np.ndarray) -> np.ndarray:
    """用最近的有效值填补 NaN（REDFIT 在 f→0 的首点会给出 NaN）。"""
    arr = np.asarray(values, dtype=float).copy()
    bad = ~np.isfinite(arr)
    if not bad.any():
        return arr
    if bad.all():
        return np.zeros_like(arr)
    index = np.arange(arr.size)
    arr[bad] = np.interp(index[bad], index[~bad], arr[~bad])
    return arr


def _confidence_column(confidence: float, columns: dict[int, str]) -> tuple[int, str]:
    """把任意置信水平映射到 REDFIT 提供的 80/90/95/99 四档。"""
    target = float(confidence) * 100.0
    level = min(columns, key=lambda item: abs(item - target))
    return level, columns[level]


def time_spectrum(
    values: Sequence[float],
    *,
    dt: float = 1.0,
) -> dict[str, Any]:
    """经典周期图（easyclimate.filter.spectrum.calc_time_spectrum）。

    该函数内部把时间轴当作等间隔采样（dt 恒为 1），因此这里把返回的频率轴
    乘上 1/dt 还原成「周期/年」；功率谱的绝对量纲与阈值无关（阈值按 AR(1)
    红噪声谱的整体功率重新标定），无需额外换算。
    """
    module = _load("spectrum")
    arr = np.asarray(values, dtype=float).ravel()
    dt = float(dt) if dt and dt > 0 else 1.0
    try:
        node = module.calc_time_spectrum(_series_dataarray(arr, dt), time_dim="time", inv=False)
    except AnalysisError:
        raise
    except Exception as exc:  # pragma: no cover - 依赖库内部错误
        raise AnalysisError("周期图计算失败：" + str(exc)) from exc

    freq = _to_array(node["freq"]) / dt
    power = _to_array(node["spectrum_freq"])
    return {"frequency": freq, "power": power, "n": int(arr.size)}


def redfit(
    values: Sequence[float],
    time: Sequence[float | int] | None = None,
    *,
    dt: float = 1.0,
    nsim: int = 1000,
    mctest: bool = False,
    window: str = "rectangular",
    ofac: float = 2.0,
    hifac: float = 1.0,
    n50: int = 2,
    confidence: float = 0.95,
) -> dict[str, Any]:
    """REDFIT 红噪声谱（easyclimate.filter.redfit.calc_redfit）。

    两种显著性检验方式：

    * mctest=False：解析法，用 AR(1) 红噪声谱 + 卡方分布给出阈值（chi2_* 列）；
    * mctest=True：蒙特卡洛法，对红噪声谱做 nsim 次模拟取分位数（ci* 列），
      必须提供真实的时间序列，否则模拟的时间结构无从谈起。

    timearray 统一用「年」为单位传入：calc_redfit 会按平均采样间隔重标定
    频率轴与带宽，因此返回的 period = 1/freq 直接就是年。
    """
    module = _load("redfit")
    arr = np.asarray(values, dtype=float).ravel()
    n = int(arr.size)
    dt = float(dt) if dt and dt > 0 else 1.0
    if time is not None and len(time) == n:
        timearray = np.asarray(time, dtype=float).ravel()
    else:
        timearray = np.arange(n, dtype=float) * dt

    level, column = _confidence_column(confidence, _CHI_COLUMNS)
    _, mc_column = _confidence_column(confidence, _CI_COLUMNS)

    workdir = settings.temp_dir / _REDFIT_WORKDIR_NAME
    workdir.mkdir(parents=True, exist_ok=True)
    cwd = os.getcwd()
    with _REDFIT_LOCK:
        os.chdir(workdir)
        try:
            result = module.calc_redfit(
                data=_series_dataarray(arr, dt, timearray),
                timearray=timearray,
                nsim=int(nsim),
                mctest=bool(mctest),
                ofac=float(ofac),
                hifac=float(hifac),
                n50=int(n50),
                iwin=str(window),
            )
        except AnalysisError:
            raise
        except Exception as exc:  # pragma: no cover - 依赖库内部错误
            raise AnalysisError("REDFIT 计算失败：" + str(exc)) from exc
        finally:
            os.chdir(cwd)

    freq = _to_array(result["freq"])
    power = _fill_nan(_to_array(result["gxx"]))
    red_noise = _fill_nan(_to_array(result["gred"])) if "gred" in result else None
    red_noise_th = _fill_nan(_to_array(result["gred_th"])) if "gred_th" in result else None
    ci = None
    if mctest:
        try:
            ci = _fill_nan(_to_array(result[mc_column]))
        except Exception:  # pragma: no cover - 老版本库没有 ci 列
            ci = None
    # 蒙特卡洛检验的显著性阈值取自模拟得到的分位数列（ci*），
    # 解析检验才用卡方列（chi2_*）；模拟列缺失时退回卡方列。
    if ci is not None and np.any(ci > 0):
        threshold = ci
    else:
        threshold = _fill_nan(_to_array(result[column]))

    results_text = str(result.attrs.get("Results", ""))
    parsed: dict[str, float] = {}
    for name, pattern in _RESULT_PATTERNS.items():
        match = pattern.search(results_text)
        if match:
            try:
                parsed[name] = float(match.group(1))
            except ValueError:  # pragma: no cover - 文本异常时忽略
                pass

    return {
        "frequency": freq,
        "power": power,
        "threshold": threshold,
        "red_noise": red_noise,
        "red_noise_threshold": red_noise_th,
        "confidence_interval": ci,
        "rho": parsed.get("rho"),
        "dof": parsed.get("dof"),
        "bandwidth": parsed.get("bandwidth"),
        "confidence": float(confidence),
        "confidence_level": level,
        "mctest": bool(mctest),
        "nsim": int(nsim),
        "window": str(window),
        "n": n,
    }


def wavelet_transform(
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
    """连续小波变换（easyclimate.filter.calc_timeseries_wavelet_transform）。

    参数与 easyclimate 一一对应：

    * max_scale 是项目口径的「最大尺度（采样点数）」，仅在 j1_n_div_dj 未显式
      给出时用于推导八度数 log2(max_scale / 2)。
    * j1_n_div_dj 是「多少个 2 的幂」，easyclimate 内部取 j1 = j1_n_div_dj / dj，
      尺度序列为 s0 * 2^(j*dj), j = 0..j1。
    * s0 缺省为 2*dt；lag1 缺省时按序列自算（避免 easyclimate 打印日志）。
    """
    module = _load("filter")
    series = np.asarray(values, dtype=float).ravel()
    n = int(series.size)
    dt = float(dt) if dt and dt > 0 else 1.0

    mother_name = str(mother or "morlet").lower()
    if mother_name not in WAVELET_MOTHERS:
        raise AnalysisError("未知的小波母函数：" + str(mother))
    if sigtest_wavelet not in WAVELET_SIGTESTS:
        raise AnalysisError("未知的小波显著性检验方式：" + str(sigtest_wavelet))
    if sigtest_global not in WAVELET_SIGTESTS:
        raise AnalysisError("未知的全局谱显著性检验方式：" + str(sigtest_global))
    # easyclimate 的 wave_signif 在 sigtest=1（时间平均）时按 len(scale)-1 造 dof 数组，
    # 与 scale 长度不一致会抛 broadcast 错误；sigtest=2 需要显式尺度区间，也未暴露。
    # 二维功率场的逐点检验因此只能走卡方检验。
    if sigtest_wavelet != "regular chi-square test":
        raise AnalysisError(
            "小波功率场的显著性检验目前只支持 regular chi-square test"
            "（easyclimate 的时间平均 / 尺度平均检验需要额外自由度参数）"
        )
    if sigtest_global == "scale-average test":
        raise AnalysisError(
            "全局小波谱不支持 scale-average test（需要指定平均的尺度区间）"
        )

    dj_value = float(dj) if dj and float(dj) > 0 else 0.25
    s0_value = float(s0) if s0 and float(s0) > 0 else 2.0 * dt
    if j1_n_div_dj is None or float(j1_n_div_dj) <= 0:
        j1_value = float(np.log2(max(float(max_scale), 4.0) / 2.0))
    else:
        j1_value = float(j1_n_div_dj)
    lag1_value = (
        float(lag1)
        if lag1 is not None and np.isfinite(float(lag1))
        else lag1_autocorrelation(series)
    )
    param_value = float(mother_param) if mother_param is not None else None

    try:
        result = module.calc_timeseries_wavelet_transform(
            _series_dataarray(series, dt),
            dt=dt,
            pad=float(pad),
            dj=dj_value,
            j1_n_div_dj=j1_value,
            s0=s0_value,
            lag1=lag1_value,
            mother=mother_name,
            mother_param=param_value,
            sigtest_wavelet=sigtest_wavelet,
            sigtest_global=sigtest_global,
            significance_level=float(confidence),
        )
    except AnalysisError:
        raise
    except Exception as exc:  # pragma: no cover - 依赖库内部错误
        raise AnalysisError("小波变换失败：" + str(exc)) from exc

    def _array(name: str) -> np.ndarray:
        return np.asarray(result[name].values, dtype=float)

    period = _array("period")
    coi = _array("coi")
    coi = np.nan_to_num(coi, nan=0.0, posinf=float(period[-1]), neginf=0.0)
    return {
        "period": period,
        "power": _array("power"),
        "ratio": _array("sig"),
        "global_ws": _array("global_ws"),
        "global_signif": _array("global_signif"),
        "coi": coi,
        "lag1": lag1_value,
        "s0": s0_value,
        "j1": j1_value,
        "dj": dj_value,
        "pad": float(pad),
        "mother": mother_name,
        "mother_param": param_value if param_value is not None else -1.0,
        "sigtest_wavelet": sigtest_wavelet,
        "sigtest_global": sigtest_global,
        "n": n,
    }


def eemd_imfs(
    values: Sequence[float],
    *,
    trials: int = 60,
    noise_ratio: float = 0.2,
    noise_seed: int | None = None,
) -> tuple[list[np.ndarray], float]:
    """集合经验模态分解（easyclimate.filter.filter_eemd）。

    easyclimate 的 noise_width 是相对于序列极差的比例（sigma = noise_width·|max-min|），
    而接口里的 noise 是相对标准差的倍数，这里做一次换算。
    返回 (imfs, noise_width)，IMF 按频率从高到低排列。
    """
    module = _load("filter")
    arr = np.asarray(values, dtype=float).ravel()
    span = float(arr.max() - arr.min())
    std = float(np.std(arr))
    if span <= 0.0 or std == 0.0:
        raise AnalysisError("序列方差为 0，无法分解")
    noise_width = float(np.clip(float(noise_ratio) * std / span, 1e-6, 1.0))

    try:
        result = module.filter_eemd(
            _series_dataarray(arr),
            1.0,
            time_array=np.arange(arr.size, dtype=float),
            trials=int(trials),
            noise_width=noise_width,
            noise_seed=EEMD_SEED if noise_seed is None else int(noise_seed),
        )
    except AnalysisError:
        raise
    except Exception as exc:  # pragma: no cover - 依赖库内部错误
        raise AnalysisError("EEMD 分解失败：" + str(exc)) from exc

    names = [name for name in result.data_vars if str(name).startswith("eimf")]
    names.sort(key=lambda name: int(str(name)[4:]))
    imfs = [np.asarray(result[name].values, dtype=float) for name in names]
    return imfs, noise_width


def mann_kendall_test(values: Sequence[float]) -> dict[str, Any]:
    """Mann-Kendall 趋势检验 + Sen 斜率（easyclimate.core.mk_test）。"""
    module = _load("mk_test")
    series = np.asarray(values, dtype=float).ravel()
    data = _series_dataarray(series)
    try:
        result = module.original_test(data, dim="time")
    except AnalysisError:
        raise
    except Exception as exc:  # pragma: no cover - 依赖库内部错误
        raise AnalysisError("Mann-Kendall 检验失败：" + str(exc)) from exc

    def _value(name: str) -> float:
        return float(np.asarray(result[name].values, dtype=float).ravel()[0])

    code = int(round(_value("trend")))
    trend = {1: "上升", -1: "下降"}.get(code, "不显著")
    z = _value("z")
    return {
        "trend": trend,
        "trend_code": code,
        "z": z,
        "p_value": _value("p"),
        "tau": _value("Tau"),
        "s": _value("s"),
        "var_s": _value("var_s"),
        "slope": _value("slope"),
        "intercept": _value("intercept"),
        "significant": bool(abs(z) >= 1.96),
    }
