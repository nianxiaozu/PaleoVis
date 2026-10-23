"""生成布局测试用的示例数据。

用法：
    python scripts/make_layout_samples.py

生成两个文件（仅用于测试，不会自动被应用加载）：
  data/samples/test_hovmoller.nc    time × lat  （Hovmöller 图）
  data/samples/test_unknown_axes.nc dim0 × dim1 × dim2（坐标名无法识别）
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "samples"


def make_hovmoller(path: Path) -> None:
    t = np.arange(240)
    lat = np.linspace(-90, 90, 37)
    rng = np.random.default_rng(0)
    field = (
        np.sin(2 * np.pi * t[:, None] / 22) * np.cos(np.deg2rad(lat)[None, :])
        + rng.normal(0, 0.1, (240, 37))
    )
    ds = xr.Dataset(
        {
            "TEMP": (
                ("time", "lat"),
                field.astype("float32"),
                {"units": "degC", "long_name": "zonal mean temperature"},
            )
        },
        coords={
            "time": ("time", (t * 365).astype("int32"), {
                "units": "days since 1850-01-01",
                "calendar": "noleap",
            }),
            "lat": ("lat", lat, {"units": "degrees_north", "long_name": "latitude"}),
        },
        attrs={"title": "Hovmoller test (time-lat)"},
    )
    ds.to_netcdf(path)
    ds.close()


def make_unknown_axes(path: Path) -> None:
    t = np.arange(120)
    a = np.linspace(-60, 60, 25)
    b = np.linspace(0, 350, 36)
    rng = np.random.default_rng(1)
    field = (
        np.sin(2 * np.pi * t[:, None, None] / 20) * np.cos(np.deg2rad(a)[None, :, None])
        + rng.normal(0, 0.05, (120, 25, 36))
    )
    ds = xr.Dataset(
        {
            "VAR": (
                ("dim0", "dim1", "dim2"),
                field.astype("float32"),
                {"long_name": "unknown axis variable"},
            )
        },
        coords={
            "dim0": ("dim0", t.astype("int32")),
            "dim1": ("dim1", a),
            "dim2": ("dim2", b),
        },
        attrs={"title": "unknown axis names, no units"},
    )
    ds.to_netcdf(path)
    ds.close()


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        (OUT_DIR / "test_hovmoller.nc", make_hovmoller),
        (OUT_DIR / "test_unknown_axes.nc", make_unknown_axes),
    ]
    for path, builder in targets:
        builder(path)
        print(f"written: {path}  ({path.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
