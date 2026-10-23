"""请求体模型。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


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
    window: Literal["hann", "boxcar"] = "hann"


class WaveletRequest(SeriesRequest):
    max_scale: int = Field(default=64, ge=4, le=512)


class PeriodRequest(SeriesRequest):
    max_period: int | None = Field(default=None, ge=2)


class AbruptRequest(SeriesRequest):
    method: Literal["mann-kendall", "sliding-t", "pettitt", "all"] = "mann-kendall"
    window: int = Field(default=10, ge=3, le=200)


class EemdRequest(SeriesRequest):
    max_imfs: int = Field(default=6, ge=2, le=10)
    noise: float = Field(default=0.2, gt=0, le=1)
    trials: int = Field(default=60, ge=5, le=300)


class CrossRequest(BaseModel):
    variable_a: str | None = None
    variable_b: str | None = None
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
