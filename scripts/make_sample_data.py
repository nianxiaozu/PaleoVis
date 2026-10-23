"""生成演示用的示例 NetCDF 数据（无需外部下载）。

用法：
    python scripts/make_sample_data.py
输出目录：data/samples/
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "samples"


def build_dataset(seed: int, variables: dict[str, dict], *, years: int, title: str) -> xr.Dataset:
    rng = np.random.default_rng(seed)
    lat = np.linspace(-90, 90, 73)
    lon = np.arange(0, 360, 2.5)
    time = np.arange(years)

    t = np.arange(years, dtype=float)
    lat_grid = lat[:, None]
    lon_grid = lon[None, :]

    data_vars: dict[str, tuple] = {}
    for name, spec in variables.items():
        base = spec["base"]
        seasonal = spec.get("seasonal", 0.0)
        spatial = spec.get("spatial", 1.0)
        noise = spec.get("noise", 0.1)

        # 纬向基态 + 年际波动 + 空间纹理
        lat_pattern = np.cos(np.deg2rad(lat_grid)) * spatial
        lon_pattern = 0.35 * np.sin(np.deg2rad(lon_grid * 2.0))
        temporal = (
            seasonal * np.sin(2 * np.pi * t / 22.0)
            + 0.4 * seasonal * np.sin(2 * np.pi * t / 7.0 + 1.1)
            + 0.25 * seasonal * np.sin(2 * np.pi * t / 3.5 + 0.4)
        )
        field = (
            base
            + lat_pattern[None, :, :]
            + lon_pattern[None, :, :]
            + temporal[:, None, None]
            + rng.normal(0, noise, (years, lat.size, lon.size))
        )
        data_vars[name] = (
            ("time", "lat", "lon"),
            field.astype("float32"),
            {
                "units": spec["units"],
                "long_name": spec["long_name"],
                "standard_name": spec.get("standard_name", name),
                "missing_value": np.float32(-9999.0),
            },
        )

    ds = xr.Dataset(
        data_vars,
        coords={
            "time": ("time", (time * 365).astype("int32"), {
                "units": "days since 1850-01-01 00:00:00",
                "calendar": "noleap",
                "long_name": "time",
                "axis": "T",
            }),
            "lat": ("lat", lat.astype("float64"), {
                "units": "degrees_north",
                "long_name": "latitude",
                "standard_name": "latitude",
                "axis": "Y",
            }),
            "lon": ("lon", lon.astype("float64"), {
                "units": "degrees_east",
                "long_name": "longitude",
                "standard_name": "longitude",
                "axis": "X",
            }),
        },
        attrs={
            "title": title,
            "institution": "PaleoVis Demo",
            "source": "synthetic reconstruction for demonstration",
            "Conventions": "CF-1.8",
            "history": "created by scripts/make_sample_data.py",
        },
    )
    return ds


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    climate = build_dataset(
        20240521,
        {
            "PR": {
                "base": 2.6,
                "units": "mm/day",
                "long_name": "precipitation rate",
                "standard_name": "precipitation_flux",
                "seasonal": 0.45,
                "spatial": 1.6,
                "noise": 0.18,
            },
            "TEM": {
                "base": 12.0,
                "units": "degC",
                "long_name": "surface air temperature",
                "standard_name": "air_temperature",
                "seasonal": 0.9,
                "spatial": 12.0,
                "noise": 0.35,
            },
        },
        years=240,
        title="PaleoVis 示例：过去 240 年降水与气温合成场",
    )
    climate_path = OUT_DIR / "sample_climate.nc"
    climate.to_netcdf(climate_path, encoding={name: {"zlib": True, "complevel": 4} for name in climate.data_vars})
    print(f"written: {climate_path}  ({climate_path.stat().st_size / 1024 / 1024:.2f} MB)")

    # 区域子集示例，便于快速预览
    subset = climate.sel(lat=slice(-30, 60), lon=slice(60, 180))
    subset_path = OUT_DIR / "sample_asia_subset.nc"
    subset.to_netcdf(subset_path, encoding={name: {"zlib": True, "complevel": 4} for name in subset.data_vars})
    print(f"written: {subset_path}  ({subset_path.stat().st_size / 1024 / 1024:.2f} MB)")

    climate.close()
    subset.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
