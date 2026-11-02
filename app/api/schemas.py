"""请求体模型。"""
from __future__ import annotations

from typing import Literal, Sequence

from pydantic import AliasChoices, BaseModel, Field, model_validator


class Selector(BaseModel):
    """数据选取条件：点位 或 区域。"""

    variable: str | None = Field(default=None, description="变量名，缺省时自动选择")
    lat: float | None = Field(default=None, ge=-90, le=90, description="点位纬度")
    lon: float | None = Field(default=None, ge=-180, le=360, description="点位经度")
    lat_range: tuple[float, float] | None = Field(default=None, description="区域纬度范围 [南, 北]")
    lon_range: tuple[float, float] | None = Field(default=None, description="区域经度范围 [西, 东]")
    start: int | None = Field(default=None, ge=0, description="起始时间索引（含）")
    end: int | None = Field(default=None, ge=0, description="结束时间索引（含）")
    level_index: int | None = Field(default=None, ge=0, description="层次索引")
    area_method: Literal["mean", "sum", "std"] = Field(
        default="mean",
        description="区域处理方式：mean=纬度加权平均 / sum=区域求和 / std=区域标准差",
    )
    preprocess: "PreprocessSpec | None" = Field(default=None, description="预处理配置")

    @model_validator(mode="after")
    def _check(self) -> "Selector":
        # 注意：允许只给纬度（或只给经度）——单轴数据（time-lat / time-lon）
        # 本来就是按单个空间轴查询的，这里不能把坐标清空。
        for attr in ("lat_range", "lon_range"):
            pair = getattr(self, attr)
            if pair is not None and pair[0] > pair[1]:
                setattr(self, attr, (pair[1], pair[0]))
        return self

    @property
    def is_point(self) -> bool:
        # 单轴数据只需一个坐标即可定位
        return self.lat is not None or self.lon is not None

    @property
    def lat_pair(self) -> tuple[float, float] | None:
        if self.lat_range is None:
            return None
        return (float(self.lat_range[0]), float(self.lat_range[1]))

    @property
    def lon_pair(self) -> tuple[float, float] | None:
        if self.lon_range is None:
            return None
        return (float(self.lon_range[0]), float(self.lon_range[1]))


class AxisMapping(BaseModel):
    """用户手动指定的坐标轴映射（自动识别失败时使用）。"""

    time: str | None = Field(default=None, description="时间维名")
    lat: str | None = Field(default=None, description="纬度维名")
    lon: str | None = Field(default=None, description="经度维名")


class PreprocessSpec(BaseModel):
    """序列预处理配置（图表视图与分析视图共用）。"""

    detrend: Literal["none", "linear", "mean"] = "none"
    standardize: bool = False
    filter: Literal["none", "lowpass", "highpass", "bandpass"] = Field(
        default="none", description="none / lowpass / highpass / bandpass"
    )
    filter_period_min: float | None = Field(default=None, gt=0, description="最短周期（高频端）")
    filter_period_max: float | None = Field(default=None, gt=0, description="最长周期（低频端）")
    order: int = Field(default=4, ge=1, le=8, description="Butterworth 阶数")


class SeriesRequest(Selector):
    detrend: Literal["none", "linear", "mean"] = "none"
    dt: float | None = Field(default=None, gt=0, description="采样步长，缺省时自动推断")
    preprocess: PreprocessSpec | None = Field(default=None, description="预处理配置")


class SpectrumRequest(SeriesRequest):
    """功率谱请求：三种计算方法共用一套参数，按 method 取用。"""
    timeRange: Sequence[float | int] | None = Field(default=None, description="序列时间轴")
    method: Literal["periodogram", "redfit", "mtm"] = Field(
        default="periodogram", description="周期图 / REDFIT / 多窗谱"
    )
    # 周期图
    window: Literal["none", "boxcar", "hann", "hamming", "blackman", "bartlett"] = "hann"
    # 共同：显示的周期窗口（与时间轴同单位），None 表示不裁剪
    min_periods: float | None = Field(default=None, gt=0, description="最短周期（高频端）")
    max_periods: float | None = Field(default=None, gt=0, description="最长周期（低频端）")
    # REDFIT（SPECTRUM 程序参数）
    ofac: float = Field(default=2.0, ge=1.0, le=8.0, description="过采样因子")
    hifac: float = Field(default=1.0, gt=0.0, le=1.0, description="最高频率 = hifac × Nyquist")
    n50: int = Field(default=2, ge=1, le=32, description="WOSA 分段数（50% 重叠）")
    iwin: Literal["rectangular", "welch", "hanning", "triangular", "blackmanharris"] = (
        "rectangular"
    )
    mctest: bool = Field(default=False, description="显著性检验：False 为红噪声解析检验，True 为蒙特卡洛模拟")
    nsim: int = Field(default=1000, ge=10, le=10000, description="蒙特卡洛模拟次数（仅 mctest=True 时生效）")
    # MTM
    nw: float = Field(default=4.0, gt=0.0, le=20.0, description="时间带宽积")
    k: int | None = Field(default=None, ge=1, le=20, description="锥形窗个数，缺省取 3（上限 2·nw）")
    # 共同：置信水平
    confidence: float = Field(default=0.95, gt=0.5, lt=1.0)

    @model_validator(mode="after")
    def _check_periods(self) -> "SpectrumRequest":
        if (
            self.min_periods is not None
            and self.max_periods is not None
            and self.min_periods >= self.max_periods
        ):
            raise ValueError("min_periods 必须小于 max_periods")
        return self


class WaveletRequest(SeriesRequest):
    max_scale: int = Field(default=64, ge=4, le=512)
    confidence: float = Field(default=0.95, gt=0.5, lt=1.0)
    # ---- 与 easyclimate.filter.calc_timeseries_wavelet_transform 对齐的参数 ----
    pad: float = Field(default=1.0, ge=0, le=1, description="1=补零到 2 的幂，0=不补零")
    dj: float = Field(default=0.25, gt=0, le=1, description="尺度间隔，越小尺度越密")
    j1_n_div_dj: float | None = Field(
        default=None, gt=0, le=64, description="多少个 2 的幂（留空由 max_scale 推导）"
    )
    s0: float | None = Field(default=None, gt=0, description="最小尺度，留空为 2·dt")
    lag1: float | None = Field(default=None, ge=-0.999, le=0.999, description="AR(1) 系数，留空自动估计")
    mother: Literal["morlet", "paul", "dog"] = "morlet"
    mother_param: float | None = Field(default=None, description="母小波参数，留空用库默认值")
    sigtest_wavelet: Literal[
        "regular chi-square test", "time-average test", "scale-average test"
    ] = "regular chi-square test"
    sigtest_global: Literal[
        "regular chi-square test", "time-average test", "scale-average test"
    ] = "time-average test"


class PeriodRequest(SeriesRequest):
    max_period: float | None = Field(default=None, ge=2, description="最长显示周期（留空按序列长度）")
    confidence: float = Field(default=0.95, gt=0.5, lt=0.9999, description="红噪声显著性水平")
    max_lag: int | None = Field(default=None, ge=2, le=5000, description="自相关最大滞后（留空自动）")
    order: int | None = Field(default=None, ge=1, le=60, description="最大熵阶数（留空自动）")


class AbruptRequest(SeriesRequest):
    method: Literal["mann-kendall", "sliding-t", "pettitt", "all"] = "mann-kendall"
    window: int = Field(default=100, ge=3)


class EemdRequest(SeriesRequest):
    max_imfs: int = Field(default=6, ge=2, le=10)
    noise_ratio: float = Field(
        default=0.2,
        gt=0,
        le=1,
        validation_alias=AliasChoices("noise_ratio", "noise"),
        description="噪声幅度（相对序列标准差），兼容旧字段名 noise",
    )
    noise_seed: int | None = Field(
        default=None, description="噪声随机种子，留空使用默认种子（结果可复现）"
    )
    trials: int = Field(default=100, ge=5, le=300)


class EemdExportRequest(EemdRequest):
    """EEMD 结果导出：component 为空或 all 表示导出全部 IMF + 残差。"""

    format: Literal["netcdf", "csv"] = "csv"
    component: str | None = Field(
        default=None,
        description="imf0 / imf1 … 或 residue；留空表示全部",
    )
    target: Literal["download", "library"] = Field(
        default="download",
        description="download=浏览器下载 / library=写入数据文件列表",
    )


class CrossRequest(BaseModel):
    variable_a: str | None = None
    variable_b: str | None = None
    area_method: Literal["mean", "sum", "std"] = "mean"
    preprocess: PreprocessSpec | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=360)
    lat_range: tuple[float, float] | None = None
    lon_range: tuple[float, float] | None = None
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    level_index: int | None = Field(default=None, ge=0)
    dt: float | None = Field(default=None, gt=0)
    detrend: Literal["none", "linear", "mean"] = "linear"


class SeriesRef(BaseModel):
    """多序列对比里的一个「数据文件 + 变量」组合。"""

    file: str | None = Field(default=None, description="数据文件 id；留空沿用数据 A 的文件")
    variable: str | None = Field(default=None, description="变量名；留空取该文件第一个变量")


class CrossFileRequest(BaseModel):
    """跨文件（或同文件）两个「数据 - 变量」的分析请求。

    file_a / file_b 缺省时由路径参数或当前文件兜底；两者相同即退回
    「同一文件内两个变量」的分析。两个文件的时间轴由后端取交集后对齐，
    只对重叠时段做计算。

    `extras` 只用于多序列对比：在 A、B 之外追加的第 3 个及以后的组合。
    """

    file_a: str | None = None
    file_b: str | None = None
    extras: list[SeriesRef] = Field(default_factory=list, description="多序列对比的附加序列")
    variable_a: str | None = None
    variable_b: str | None = None
    area_method: Literal["mean", "sum", "std"] = "mean"
    preprocess: PreprocessSpec | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=360)
    lat_range: tuple[float, float] | None = None
    lon_range: tuple[float, float] | None = None
    start: int | None = Field(default=None, ge=0, description="数据 A 的起始时次")
    end: int | None = Field(default=None, ge=0, description="数据 A 的结束时次")
    level_index: int | None = Field(default=None, ge=0)
    dt: float | None = Field(default=None, gt=0)
    detrend: Literal["none", "linear", "mean"] = "linear"
    method: Literal["pearson", "spearman", "kendall"] = "pearson"
    max_lag: int = Field(default=20, ge=0, le=200)
    normalize: bool = True
    max_period: float | None = Field(
        default=None, gt=0, description="交叉谱显示的最长周期；留空取全部频段"
    )


class CorrelationRequest(BaseModel):
    series_a: list[float]
    series_b: list[float]
    method: Literal["pearson", "spearman", "kendall"] = "pearson"
    max_lag: int = Field(default=20, ge=0, le=200)


class CompareRequest(BaseModel):
    series: dict[str, list[float]]
    normalize: bool = True


class ExportRequest(Selector):
    format: Literal["netcdf", "csv"] = "csv"


class SeriesExportRequest(SeriesRequest):
    """把「提取 + 预处理」后的序列写入数据文件（或下载）。

    预处理描述、区域处理描述都由服务端按请求内容自动生成，并可通过
    attributes 追加/覆盖任意键值对，方便前端把 state 里的信息直接带过来。
    """

    format: Literal["netcdf", "csv"] = "netcdf"
    target: Literal["library", "download"] = "library"
    filename: str | None = Field(default=None, description="写入数据文件时的文件名")
    attributes: dict[str, str] | None = Field(
        default=None, description="追加到 NetCDF 全局属性的键值对（覆盖同名键）"
    )
