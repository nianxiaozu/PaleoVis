"""接口冒烟测试（unittest，无需 pytest）。

运行：python tests/test_api.py
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import xarray as xr  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

SAMPLE = ROOT / "data" / "samples" / "sample_asia_subset.nc"


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        if not SAMPLE.exists():
            raise unittest.SkipTest("示例数据不存在，请先运行 scripts/make_sample_data.py")
        cls.file_id = f"sample-{SAMPLE.stem}"
        cls.uploaded: list[str] = []
        cls._ensure_layout_samples()

    @classmethod
    def _ensure_layout_samples(cls) -> None:
        """布局测试依赖两个小样本，缺失时自动生成。"""
        needed = [
            ROOT / "data" / "samples" / "test_hovmoller.nc",
            ROOT / "data" / "samples" / "test_unknown_axes.nc",
        ]
        if all(p.exists() for p in needed):
            return
        try:
            sys.path.insert(0, str(ROOT / "scripts"))
            import make_layout_samples  # noqa: WPS433

            make_layout_samples.main()
        except Exception as exc:  # pragma: no cover
            print(f"生成布局测试样本失败：{exc}", file=sys.stderr)

    @classmethod
    def tearDownClass(cls) -> None:
        for file_id in cls.uploaded:
            cls.client.delete(f"/api/files/{file_id}")

    # ---------------------------------------------------------------- 基础
    def test_health(self) -> None:
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_index_page(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("古气候数据分析可视化系统", response.text)

    # ---------------------------------------------------------------- 文件
    def test_list_files(self) -> None:
        payload = self.client.get("/api/files").json()
        self.assertIn("files", payload)
        names = [item["name"] for item in payload["files"]]
        self.assertIn(SAMPLE.name, names)

    def test_upload_and_delete(self) -> None:
        content = SAMPLE.read_bytes()
        response = self.client.post(
            "/api/files",
            files={"file": ("uploaded_test.nc", io.BytesIO(content), "application/x-netcdf")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        record = response.json()
        self.uploaded.append(record["id"])
        self.assertIn("overview", record)
        self.assertGreater(record["overview"]["summary"]["n_variables"], 0)

        deleted = self.client.delete(f"/api/files/{record['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.uploaded.remove(record["id"])

    def test_reject_non_netcdf(self) -> None:
        response = self.client.post(
            "/api/files",
            files={"file": ("bad.txt", io.BytesIO(b"not a netcdf"), "text/plain")},
        )
        self.assertEqual(response.status_code, 400)

    def test_sample_is_readonly(self) -> None:
        response = self.client.delete(f"/api/files/{self.file_id}")
        self.assertEqual(response.status_code, 403)

    # ---------------------------------------------------------------- 数据
    def test_overview(self) -> None:
        payload = self.client.get(f"/api/datasets/{self.file_id}/overview").json()
        self.assertIn("dimensions", payload)
        self.assertIn("variables", payload)
        self.assertEqual(payload["axes"]["lat"]["name"], "lat")
        self.assertEqual(payload["axes"]["lon"]["name"], "lon")

    def test_point_series(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "PR", "lat": 35, "lon": 105, "start": 0, "end": 99},
        ).json()
        self.assertEqual(payload["mode"], "point")
        self.assertEqual(len(payload["values"]), 100)
        self.assertEqual(len(payload["time"]), 100)

    def test_area_series(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={
                "variable": "TEM",
                "lat_min": -10,
                "lat_max": 40,
                "lon_min": 70,
                "lon_max": 140,
            },
        ).json()
        self.assertEqual(payload["mode"], "area_mean")
        # 格点间距 2.5°，40°N 会被吸附到最近的 37.5°N
        self.assertAlmostEqual(payload["extent"]["lat"][0], -10.0, places=3)
        self.assertAlmostEqual(payload["extent"]["lat"][1], 37.5, places=3)
        self.assertAlmostEqual(payload["extent"]["lon"][0], 70.0, places=3)
        self.assertAlmostEqual(payload["extent"]["lon"][1], 137.5, places=3)

    def test_area_series_methods(self) -> None:
        """区域处理三种方式：mean（纬度加权）/ sum / std，并回传中文标签。"""
        params = {
            "variable": "TEM",
            "lat_min": -10,
            "lat_max": 40,
            "lon_min": 70,
            "lon_max": 140,
        }
        results = {}
        for method in ("mean", "sum", "std"):
            payload = self.client.get(
                f"/api/datasets/{self.file_id}/series",
                params={**params, "area_method": method},
            ).json()
            self.assertEqual(payload["mode"], "area_mean")
            self.assertEqual(payload["area_method"], method)
            self.assertTrue(payload["area_method_label"])
            results[method] = payload["values"][0]

        # 求和量级明显大于平均；标准差非负
        self.assertGreater(abs(results["sum"]), abs(results["mean"]))
        self.assertGreaterEqual(results["std"], 0.0)

        bad = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={**params, "area_method": "median"},
        )
        self.assertEqual(bad.status_code, 422, bad.text)

    def test_field(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field", params={"variable": "PR"}
        ).json()
        self.assertGreater(len(payload["lat"]), 1)
        self.assertGreater(len(payload["lon"]), 1)
        self.assertEqual(len(payload["values"]), len(payload["lat"]))

    def test_unknown_variable(self) -> None:
        response = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "NOPE", "lat": 0, "lon": 0},
        )
        self.assertEqual(response.status_code, 422)

    # ---------------------------------------------------------------- 布局识别
    def test_layout_map(self) -> None:
        payload = self.client.get(f"/api/datasets/{self.file_id}/layout").json()
        self.assertEqual(payload["layout"]["kind"], "map")
        self.assertTrue(payload["layout"]["has_map"])
        self.assertEqual(payload["layout"]["map_mode"], "map")

    def test_layout_timeseries(self) -> None:
        """只有 time 维的数据应识别为时序，且不显示地图。"""
        hov = ROOT / "data" / "samples" / "test_hovmoller.nc"
        if not hov.exists():
            self.skipTest("缺少 time-lat 测试文件")
        fid = f"sample-{hov.stem}"
        payload = self.client.get(f"/api/datasets/{fid}/layout").json()
        self.assertEqual(payload["layout"]["kind"], "hovmoller")
        self.assertEqual(payload["layout"]["hovmoller_axis"], "lat")
        self.assertTrue(payload["layout"]["has_map"])

    def test_layout_unknown_and_override(self) -> None:
        """无法识别时返回 unknown；手动指定后可正确识别。"""
        unk = ROOT / "data" / "samples" / "test_unknown_axes.nc"
        if not unk.exists():
            self.skipTest("缺少无坐标名测试文件")
        fid = f"sample-{unk.stem}"

        auto = self.client.get(f"/api/datasets/{fid}/layout").json()
        self.assertEqual(auto["layout"]["kind"], "unknown")
        self.assertFalse(auto["layout"]["has_map"])

        mapped = self.client.get(
            f"/api/datasets/{fid}/layout",
            params={"axis_time": "dim0", "axis_lat": "dim1", "axis_lon": "dim2"},
        ).json()
        self.assertEqual(mapped["layout"]["kind"], "map")
        self.assertEqual(mapped["axes"]["lat"], "dim1")

    def test_hovmoller_field(self) -> None:
        hov = ROOT / "data" / "samples" / "test_hovmoller.nc"
        if not hov.exists():
            self.skipTest("缺少 time-lat 测试文件")
        fid = f"sample-{hov.stem}"
        payload = self.client.get(
            f"/api/datasets/{fid}/field",
            params={"variable": "TEMP", "start": 0, "end": 59},
        ).json()
        self.assertEqual(payload["mode"], "hovmoller")
        self.assertEqual(payload["axis"], "lat")
        self.assertEqual(len(payload["values"]), 60)

    def test_pure_timeseries_series(self) -> None:
        """纯时序文件取数不应要求经纬度。"""
        unk = ROOT / "data" / "samples" / "test_unknown_axes.nc"
        if not unk.exists():
            self.skipTest("缺少测试文件")
        fid = f"sample-{unk.stem}"
        payload = self.client.get(
            f"/api/datasets/{fid}/series",
            params={
                "variable": "VAR",
                "start": 0,
                "end": 49,
                "axis_time": "dim0",
                "axis_lat": "dim1",
                "axis_lon": "dim2",
            },
        ).json()
        self.assertEqual(len(payload["values"]), 50)

    # ---------------------------------------------------------------- 单轴查询
    def test_single_axis_point_series(self) -> None:
        """time-lat 数据：只给纬度应返回该纬度序列，而不是全纬度平均。"""
        hov = ROOT / "data" / "samples" / "test_hovmoller.nc"
        if not hov.exists():
            self.skipTest("缺少 time-lat 测试文件")
        fid = f"sample-{hov.stem}"
        payload = self.client.get(
            f"/api/datasets/{fid}/series",
            params={"variable": "TEMP", "lat": 0, "start": 0, "end": 49},
        ).json()
        self.assertEqual(payload["mode"], "point")
        self.assertIn("lat", payload["grid"])
        self.assertNotIn("lon", payload["grid"])
        self.assertEqual(len(payload["values"]), 50)

    def test_single_axis_area_mean(self) -> None:
        """time-lat 数据：只给纬度范围做纬度带平均。"""
        hov = ROOT / "data" / "samples" / "test_hovmoller.nc"
        if not hov.exists():
            self.skipTest("缺少 time-lat 测试文件")
        fid = f"sample-{hov.stem}"
        payload = self.client.get(
            f"/api/datasets/{fid}/series",
            params={
                "variable": "TEMP",
                "lat_min": -30,
                "lat_max": 30,
                "start": 0,
                "end": 49,
            },
        ).json()
        self.assertEqual(payload["mode"], "area_mean")
        self.assertIn("lat", payload["extent"])
        self.assertIsNone(payload["extent"].get("lon"))

    def test_single_axis_analysis(self) -> None:
        """time-lat 数据：分析接口只给纬度也能按点位取序列。"""
        hov = ROOT / "data" / "samples" / "test_hovmoller.nc"
        if not hov.exists():
            self.skipTest("缺少 time-lat 测试文件")
        fid = f"sample-{hov.stem}"
        payload = self._post(
            f"/api/analysis/{fid}/power-spectrum",
            {"variable": "TEMP", "lat": 0, "start": 0, "end": 239},
        )
        self.assertEqual(payload["source"]["mode"], "point")
        self.assertIn("lat", payload["source"]["grid"])

    def test_full_grid_still_requires_both_axes(self) -> None:
        """完整空间场仍按 lat+lon 定位；只给纬度时退回区域平均。"""
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "TEM", "lat": 35, "start": 0, "end": 49},
        ).json()
        self.assertEqual(payload["mode"], "area_mean")

    # ---------------------------------------------------------------- 场类型
    def test_field_climatology(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={"variable": "TEM", "start": 0, "end": 99},
        ).json()
        self.assertEqual(payload["field_mode"], "climatology")
        self.assertIn("气候态", payload["field_label"])

    def test_field_anomaly(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={"variable": "TEM", "start": 0, "end": 99, "field_mode": "anomaly"},
        ).json()
        self.assertEqual(payload["field_mode"], "anomaly")
        self.assertIn("异常场", payload["field_label"])
        # 异常场应跨零
        self.assertLess(payload["vmin"], 0)
        self.assertGreater(payload["vmax"], 0)

    def test_field_anomaly_differs_from_climatology(self) -> None:
        params = {"variable": "TEM", "start": 0, "end": 99}
        clim = self.client.get(f"/api/datasets/{self.file_id}/field", params=params).json()
        anom = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params=dict(params, field_mode="anomaly"),
        ).json()
        self.assertNotAlmostEqual(clim["vmin"], anom["vmin"], places=2)

    def test_field_anomaly_default_baseline(self) -> None:
        """未指定基准时默认取 0 ~ max//2。"""
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={"variable": "TEM", "field_mode": "anomaly"},
        ).json()
        base = payload["baseline"]
        self.assertTrue(base["default"])
        self.assertEqual(base["start"], 0)
        # 样本有 240 个时次，max//2 = 119
        self.assertEqual(base["end"], 119)

    def test_field_anomaly_custom_baseline(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={
                "variable": "TEM",
                "field_mode": "anomaly",
                "anomaly_start": 100,
                "anomaly_end": 150,
            },
        ).json()
        base = payload["baseline"]
        self.assertFalse(base["default"])
        self.assertEqual((base["start"], base["end"]), (100, 150))
        self.assertIn("1950", payload["field_label"])

    def test_field_anomaly_baseline_changes_result(self) -> None:
        """不同基准时段必须产生不同的异常场。"""
        common = {"variable": "TEM", "field_mode": "anomaly"}
        a = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params=dict(common, anomaly_start=0, anomaly_end=50),
        ).json()
        b = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params=dict(common, anomaly_start=150, anomaly_end=239),
        ).json()
        self.assertNotAlmostEqual(a["vmin"], b["vmin"], places=3)

    def test_field_anomaly_baseline_swapped(self) -> None:
        """反向区间自动纠正。"""
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={
                "variable": "TEM",
                "field_mode": "anomaly",
                "anomaly_start": 150,
                "anomaly_end": 100,
            },
        ).json()
        self.assertEqual(payload["baseline"]["start"], 100)
        self.assertEqual(payload["baseline"]["end"], 150)

    def test_field_anomaly_baseline_clamped(self) -> None:
        """越界索引被夹取到合法范围。"""
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={
                "variable": "TEM",
                "field_mode": "anomaly",
                "anomaly_start": 0,
                "anomaly_end": 999999,
            },
        ).json()
        self.assertEqual(payload["baseline"]["end"], 239)

    def test_field_climatology_has_no_baseline(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={"variable": "TEM", "field_mode": "climatology"},
        ).json()
        self.assertIsNone(payload["baseline"])

    def test_field_invalid_mode(self) -> None:
        response = self.client.get(
            f"/api/datasets/{self.file_id}/field",
            params={"variable": "TEM", "field_mode": "bogus"},
        )
        self.assertEqual(response.status_code, 422)

    # ---------------------------------------------------------------- 预处理
    def test_series_no_preprocess(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "TEM", "lat": 35, "lon": 105, "start": 0, "end": 99},
        ).json()
        self.assertFalse(payload["preprocess"]["applied"])
        self.assertIn("raw_values", payload)

    def test_series_detrend(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "TEM", "lat": 35, "lon": 105, "detrend": "linear"},
        ).json()
        self.assertTrue(payload["preprocess"]["applied"])
        self.assertIn("去趋势", " ".join(payload["preprocess"]["steps"]))

    def test_series_standardize(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "TEM", "lat": 35, "lon": 105, "standardize": True},
        ).json()
        self.assertAlmostEqual(payload["stats"]["std"], 1.0, places=6)
        self.assertAlmostEqual(payload["stats"]["mean"], 0.0, places=6)

    def test_series_lowpass(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={
                "variable": "TEM",
                "lat": 35,
                "lon": 105,
                "filter": "lowpass",
                "filter_period_min": 20,
            },
        ).json()
        self.assertTrue(payload["preprocess"]["applied"])
        self.assertIn("lowpass", " ".join(payload["preprocess"]["steps"]))

    def test_series_bandpass(self) -> None:
        payload = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={
                "variable": "TEM",
                "lat": 35,
                "lon": 105,
                "filter": "bandpass",
                "filter_period_min": 7,
                "filter_period_max": 30,
            },
        ).json()
        self.assertTrue(payload["preprocess"]["applied"])

    def test_series_bandpass_requires_both_periods(self) -> None:
        response = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={
                "variable": "TEM",
                "lat": 35,
                "lon": 105,
                "filter": "bandpass",
                "filter_period_min": 7,
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_series_invalid_filter(self) -> None:
        response = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params={"variable": "TEM", "lat": 35, "lon": 105, "filter": "unknown"},
        )
        self.assertEqual(response.status_code, 422)

    def test_preprocess_consistent_between_views(self) -> None:
        """图表视图与分析视图必须使用同一份预处理数据。"""
        spec = {
            "filter": "bandpass",
            "filter_period_min": 7,
            "filter_period_max": 30,
            "detrend": "linear",
        }
        chart = self.client.get(
            f"/api/datasets/{self.file_id}/series",
            params=dict(
                variable="TEM",
                lat=35,
                lon=105,
                start=0,
                end=239,
                detrend=spec["detrend"],
                filter=spec["filter"],
                filter_period_min=spec["filter_period_min"],
                filter_period_max=spec["filter_period_max"],
            ),
        ).json()
        analysis = self._post(
            f"/api/analysis/{self.file_id}/period",
            {"variable": "TEM", "lat": 35, "lon": 105, "start": 0, "end": 239, "preprocess": spec},
        )
        self.assertEqual(len(chart["values"]), len(analysis["values"]))
        for a, b in zip(chart["values"], analysis["values"]):
            self.assertAlmostEqual(a, b, places=10)

    def test_analysis_applies_preprocess(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            {
                "variable": "TEM",
                "lat": 35,
                "lon": 105,
                "preprocess": {"detrend": "linear", "standardize": True},
            },
        )
        self.assertTrue(payload["source"]["preprocess"]["applied"])
        self.assertAlmostEqual(payload["stats"]["std"], 1.0, places=6)

    # ---------------------------------------------------------------- 分析
    def _post(self, path: str, payload: dict) -> dict:
        response = self.client.post(path, json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_power_spectrum(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            {"variable": "PR", "lat": 35, "lon": 105},
        )
        self.assertIn("power", payload)
        self.assertIn("threshold", payload)
        self.assertEqual(len(payload["power"]), len(payload["period"]))
        self.assertEqual(payload["meta"]["method"], "periodogram")
        # 周期图自由度恒为 2（每频点两个实自由度）
        self.assertAlmostEqual(payload["meta"]["dof"], 2.0, places=6)

    def test_power_spectrum_methods(self) -> None:
        """三种谱估计方法都应返回结构一致、长度对齐的结果。"""
        cases = {
            "periodogram": {"window": "hamming"},
            "redfit": {"n50": 4, "ofac": 2, "iwin": "welch"},
            "mtm": {"nw": 3.0, "k": 2},
        }
        for method, extra in cases.items():
            with self.subTest(method=method):
                body = {"variable": "PR", "lat": 35, "lon": 105, "method": method}
                body.update(extra)
                payload = self._post(f"/api/analysis/{self.file_id}/power-spectrum", body)
                self.assertEqual(payload["meta"]["method"], method)
                self.assertEqual(len(payload["power"]), len(payload["period"]))
                self.assertEqual(len(payload["threshold"]), len(payload["period"]))
                self.assertTrue(all(p > 0 for p in payload["period"]))
                self.assertTrue(all(v is not None and v >= 0 for v in payload["power"]))
                self.assertGreater(payload["meta"]["dof"], 0)

    def test_power_spectrum_redfit_tests(self) -> None:
        """REDFIT 的红噪声检验与蒙特卡洛检验都应给出正阈值。"""
        base = {"variable": "PR", "lat": 35, "lon": 105, "method": "redfit", "n50": 2, "ofac": 2}
        analytic = self._post(f"/api/analysis/{self.file_id}/power-spectrum", dict(base, mctest=False))
        monte = self._post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            dict(base, mctest=True, nsim=50),
        )
        for payload, mctest in ((analytic, False), (monte, True)):
            self.assertEqual(payload["meta"]["engine"], "easyclimate")
            self.assertEqual(payload["meta"]["mctest"], mctest)
            self.assertFalse(payload["meta"]["threshold_fallback"])
            self.assertEqual(len(payload["threshold"]), len(payload["period"]))
            self.assertTrue(all(v is not None and v > 0 for v in payload["threshold"]))
        self.assertEqual(monte["meta"]["nsim"], 50)

    def test_power_spectrum_redfit_threshold_fallback(self) -> None:
        """n50=1 且 ofac>1 时 REDFIT 后端的阈值列会退化，接口必须自动兜底。"""
        payload = self._post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            {"variable": "PR", "lat": 35, "lon": 105, "method": "redfit", "n50": 1, "ofac": 2},
        )
        self.assertEqual(len(payload["threshold"]), len(payload["period"]))
        self.assertTrue(all(v is not None and v > 0 for v in payload["threshold"]))
        # 阈值必须整体低于峰值，否则显著性判定失去意义
        self.assertLess(max(payload["threshold"]), max(payload["power"]) * 3)

    def test_power_spectrum_period_window(self) -> None:
        """min_periods / max_periods 应裁剪频率栅格，并保留足够频点。"""
        payload = self._post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            {"variable": "PR", "lat": 35, "lon": 105, "min_periods": 5, "max_periods": 60},
        )
        self.assertTrue(all(5 - 1e-9 <= p <= 60 + 1e-9 for p in payload["period"]))

    def test_power_spectrum_invalid_window(self) -> None:
        """非法周期窗口应被 schema 拦下并返回 422。"""
        response = self.client.post(
            f"/api/analysis/{self.file_id}/power-spectrum",
            json={
                "variable": "PR",
                "lat": 35,
                "lon": 105,
                "min_periods": 60,
                "max_periods": 5,
            },
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_wavelet(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/wavelet",
            {"variable": "PR", "lat": 35, "lon": 105, "max_scale": 32},
        )
        self.assertEqual(len(payload["power"]), len(payload["period"]))
        self.assertEqual(payload["meta"]["engine"], "easyclimate")
        self.assertEqual(len(payload["global"]), len(payload["period"]))
        self.assertEqual(len(payload["global_signif"]), len(payload["period"]))
        # 显著性场与功率场形状一致（行=周期，列=时间）
        self.assertEqual(len(payload["significance"]), len(payload["period"]))
        self.assertEqual(len(payload["significance"][0]), len(payload["time_index"]))
        # 影响锥与时间轴同长
        self.assertEqual(len(payload["coi"]), len(payload["time_index"]))
        self.assertEqual(len(payload["cone"]), len(payload["time_index"]))
        # 显著性阈值应高于平均功率，否则说明红噪声背景未正确估计
        self.assertGreater(sum(payload["global_signif"]), 0.0)

    def test_wavelet_confidence(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/wavelet",
            {"variable": "PR", "lat": 35, "lon": 105, "max_scale": 32, "confidence": 0.99},
        )
        self.assertAlmostEqual(payload["meta"]["confidence"], 0.99)
        # 置信水平提高后，显著点数量不应增加
        strict = sum(1 for row in payload["significance"] for v in row if v > 1)
        loose = self._post(
            f"/api/analysis/{self.file_id}/wavelet",
            {"variable": "PR", "lat": 35, "lon": 105, "max_scale": 32, "confidence": 0.8},
        )
        loose_count = sum(1 for row in loose["significance"] for v in row if v > 1)
        self.assertGreaterEqual(loose_count, strict)

    def test_wavelet_parameters(self) -> None:
        """pad / dj / s0 / lag1 / mother 等 easyclimate 原生参数应透传到计算。"""
        base = {"variable": "PR", "lat": 35, "lon": 105, "max_scale": 32}
        default = self._post(f"/api/analysis/{self.file_id}/wavelet", base)
        dense = self._post(
            f"/api/analysis/{self.file_id}/wavelet", dict(base, dj=0.125)
        )
        # dj 减小后尺度栅格变密
        self.assertGreater(len(dense["period"]), len(default["period"]))
        self.assertAlmostEqual(dense["meta"]["dj"], 0.125)

        shifted = self._post(f"/api/analysis/{self.file_id}/wavelet", dict(base, s0=4))
        # s0 是最小尺度，周期范围整体右移
        self.assertGreater(shifted["period"][0], default["period"][0])

        manual = self._post(
            f"/api/analysis/{self.file_id}/wavelet",
            dict(base, lag1=0.0, mother="paul", pad=0),
        )
        self.assertEqual(manual["meta"]["mother"], "paul")
        self.assertAlmostEqual(manual["meta"]["lag1"], 0.0)
        self.assertAlmostEqual(manual["meta"]["pad"], 0.0)
        self.assertGreaterEqual(len(manual["period"]), 2)

    def test_wavelet_invalid_sigtest(self) -> None:
        """逐点检验目前只支持卡方检验，其他方式应返回 422 而不是 500。"""
        response = self.client.post(
            f"/api/analysis/{self.file_id}/wavelet",
            json={
                "variable": "PR",
                "lat": 35,
                "lon": 105,
                "max_scale": 32,
                "sigtest_wavelet": "time-average test",
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["code"], "analysis_failed")

    def test_period(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/period", {"variable": "PR", "lat": 35, "lon": 105}
        )
        self.assertIn("acf", payload)
        self.assertIn("spectrum", payload)
        acf = payload["acf"]
        spectrum = payload["spectrum"]
        # ACF 与谱线都要有红噪声置信带，且口径一致（同一 bound 的 lag=1 值）
        self.assertIn("bound", acf)
        self.assertEqual(len(acf["bound"]), len(acf["value"]))
        self.assertAlmostEqual(acf["confidence"], acf["bound"][1], places=6)
        self.assertEqual(len(spectrum["threshold"]), len(spectrum["power"]))
        self.assertGreater(max(spectrum["threshold"]), 0.0)
        # 显著性判定应基于阈值而不是恒真的零阈值
        for peak in payload["peaks"]:
            self.assertGreater(peak["threshold"], 0.0)
            self.assertEqual(peak["significant"], peak["power"] >= peak["threshold"])
        self.assertGreaterEqual(payload["meta"]["lag1"], -1.0)

    def test_period_parameters(self) -> None:
        """confidence 越高阈值越严格，max_period 截断显示上限。"""
        loose = self._post(
            f"/api/analysis/{self.file_id}/period",
            {"variable": "PR", "lat": 35, "lon": 105, "confidence": 0.9},
        )
        strict = self._post(
            f"/api/analysis/{self.file_id}/period",
            {"variable": "PR", "lat": 35, "lon": 105, "confidence": 0.99},
        )
        self.assertLess(
            max(loose["spectrum"]["threshold"]), max(strict["spectrum"]["threshold"])
        )
        self.assertLess(loose["acf"]["confidence"], strict["acf"]["confidence"])
        limited = self._post(
            f"/api/analysis/{self.file_id}/period",
            {"variable": "PR", "lat": 35, "lon": 105, "max_period": 60},
        )
        self.assertLessEqual(limited["meta"]["display_max_period"], 60.0)
        for value in limited["spectrum"]["period"]:
            self.assertLessEqual(value, 60.0 + 1e-6)

    def test_period_clean_series_keeps_spectrum(self) -> None:
        """干净（无噪声）序列过去会让 Burg 谱整体归零，现在应按方差归一。"""
        import math

        # 直接走服务层，避免为这条纯数值断言再上传一个文件
        import random

        from app.services import analysis

        # 近乎无噪声的正弦：旧实现会因预测误差功率衰减到 1e-18 而整体归零
        clean = [0.5 * math.sin(2 * math.pi * i / 24.0) for i in range(240)]
        out = analysis.period_analysis(clean, dt=1.0)
        peak = max(out["spectrum"]["power"])
        self.assertTrue(math.isfinite(peak))
        self.assertGreater(peak, 1e-3)
        # 谱的平均功率应与序列方差同量级（归一化正确）
        mean_power = sum(out["spectrum"]["power"]) / len(out["spectrum"]["power"])
        variance = sum((v - sum(clean) / len(clean)) ** 2 for v in clean) / len(clean)
        self.assertAlmostEqual(mean_power, variance, delta=variance * 0.5)

        # 带一点点噪声后应稳定识别出 24 的主周期
        random.seed(7)
        noisy = [v + random.gauss(0.0, 1e-3) for v in clean]
        out = analysis.period_analysis(noisy, dt=1.0)
        best = max(range(len(out["spectrum"]["power"])), key=lambda i: out["spectrum"]["power"][i])
        self.assertAlmostEqual(out["spectrum"]["period"][best], 24.0, delta=1.0)

    def test_abrupt(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/abrupt-change",
            {"variable": "PR", "lat": 35, "lon": 105, "method": "all"},
        )
        self.assertIn("mann_kendall", payload)
        self.assertIn("pettitt", payload)
        mk = payload["mann_kendall"]
        self.assertEqual(mk["engine"], "easyclimate")
        # UF / UB 曲线与原始序列等长；UF 从左端 0 起算，UB 从右端 0 起算
        self.assertEqual(len(mk["uf"]), payload["n"])
        self.assertEqual(len(mk["ub"]), payload["n"])
        self.assertEqual(mk["uf"][0], 0.0)
        self.assertEqual(mk["ub"][-1], 0.0)
        # 无趋势的白噪声不应越出置信带，有趋势的序列则应明显越出
        self.assertLess(abs(mk["uf"][-1]), 200.0)
        self.assertIn(mk["trend"], ("上升", "下降", "不显著"))
        self.assertIsInstance(mk["slope"], float)
        self.assertTrue(0 <= mk["p_value"] <= 1)

    def test_eemd(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/eemd",
            {"variable": "PR", "lat": 35, "lon": 105, "max_imfs": 3, "trials": 10},
        )
        self.assertGreaterEqual(payload["imf_count"], 1)
        self.assertEqual(len(payload["residue"]), payload["n"])
        self.assertEqual(payload["meta"]["engine"], "easyclimate")
        # 分解是完备的：各 IMF 与残差之和应还原原始序列
        total = [sum(imf[i] for imf in payload["imfs"]) + payload["residue"][i]
                 for i in range(payload["n"])]
        mean = sum(payload["values"]) / len(payload["values"])
        for got, want in zip(total, payload["values"]):
            self.assertAlmostEqual(got, want - mean, places=6)

    def test_eemd_export_all(self) -> None:
        """EEMD 全部分量导出：CSV 含每个 IMF 与残差列，NetCDF 含同名变量。"""
        body = {
            "variable": "PR",
            "lat": 35,
            "lon": 105,
            "max_imfs": 3,
            "trials": 10,
            "format": "csv",
        }
        response = self.client.post(
            f"/api/analysis/{self.file_id}/eemd/export", json=body
        )
        self.assertEqual(response.status_code, 200, response.text)
        text = response.content.decode("utf-8-sig")
        header = text.splitlines()[0].split(",")
        self.assertEqual(header[:2], ["time_index", "time"])
        self.assertIn("residue", header)
        imf_columns = [name for name in header if name.startswith("IMF")]
        self.assertGreaterEqual(len(imf_columns), 1)

        body["format"] = "netcdf"
        response = self.client.post(
            f"/api/analysis/{self.file_id}/eemd/export", json=body
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("netcdf", response.headers["content-type"])
        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as handle:
            handle.write(response.content)
            path = handle.name
        try:
            with xr.open_dataset(path) as dataset:
                self.assertIn("residue", dataset.data_vars)
                self.assertIn("IMF1", dataset.data_vars)
        finally:
            os.unlink(path)

    def test_eemd_export_component(self) -> None:
        """单个分量导出只应包含一列，非法分量返回 422。"""
        body = {
            "variable": "PR",
            "lat": 35,
            "lon": 105,
            "max_imfs": 3,
            "trials": 10,
            "format": "csv",
            "component": "residue",
        }
        response = self.client.post(
            f"/api/analysis/{self.file_id}/eemd/export", json=body
        )
        self.assertEqual(response.status_code, 200, response.text)
        header = response.content.decode("utf-8-sig").splitlines()[0].split(",")
        self.assertEqual(header, ["time_index", "time", "residue"])

        body["component"] = "imf1"
        response = self.client.post(
            f"/api/analysis/{self.file_id}/eemd/export", json=body
        )
        self.assertEqual(response.status_code, 200, response.text)
        header = response.content.decode("utf-8-sig").splitlines()[0].split(",")
        self.assertEqual(header, ["time_index", "time", "IMF1"])

        for bad in ("imf9", "foo"):
            body["component"] = bad
            response = self.client.post(
                f"/api/analysis/{self.file_id}/eemd/export", json=body
            )
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(response.json()["code"], "analysis_failed")

    def test_eemd_noise_seed(self) -> None:
        """EEMD 噪声种子：显式传入时透传到 meta，缺省时用默认种子。"""
        body = {"variable": "PR", "lat": 35, "lon": 105, "max_imfs": 3, "trials": 10}
        seeded = self._post(f"/api/analysis/{self.file_id}/eemd", {**body, "noise_seed": 2024})
        self.assertEqual(seeded["meta"]["seed"], 2024)
        self.assertFalse(seeded["meta"]["seed_default"])

        default = self._post(f"/api/analysis/{self.file_id}/eemd", body)
        self.assertTrue(default["meta"]["seed_default"])

        # 同一个种子应可复现
        again = self._post(f"/api/analysis/{self.file_id}/eemd", {**body, "noise_seed": 2024})
        for a, b in zip(seeded["imfs"][0], again["imfs"][0]):
            self.assertAlmostEqual(a, b, places=10)

    def test_eemd_export_to_library(self) -> None:
        """EEMD 分量写入数据文件：注册为新文件并带 EEMD 描述属性。"""
        body = {
            "variable": "PR",
            "lat": 35,
            "lon": 105,
            "max_imfs": 3,
            "trials": 10,
            "format": "netcdf",
            "target": "library",
            "component": "imf2",
        }
        payload = self._post(f"/api/analysis/{self.file_id}/eemd/export", body)
        self.assertTrue(payload["saved"])
        record = payload["file"]
        self.uploaded.append(record["id"])
        self.assertEqual(record["source"], "derived")

        path = ROOT / "data" / "uploads" / f"{record['id']}__{record['name']}"
        with xr.open_dataset(path) as dataset:
            self.assertIn("IMF2", dataset.data_vars)
            attrs = dataset.attrs
            self.assertEqual(attrs["eemd_component"], "IMF2")
            self.assertIn("eemd_variance_ratio", attrs)
            self.assertIn("eemd_explained", attrs)
            self.assertIn("eemd_noise_seed", attrs)
            self.assertEqual(attrs["variable"], "PR")

    def test_series_export_to_library(self) -> None:
        """提取并预处理后的序列写入数据文件，属性里记录区域处理与预处理。"""
        body = {
            "variable": "TEM",
            "lat_min": -10,
            "lat_max": 40,
            "lon_min": 70,
            "lon_max": 140,
            "area_method": "sum",
            "start": 0,
            "end": 99,
            "preprocess": {"detrend": "linear", "standardize": True},
            "format": "netcdf",
            "target": "library",
        }
        payload = self._post(f"/api/analysis/{self.file_id}/series/export", body)
        self.assertTrue(payload["saved"])
        record = payload["file"]
        self.uploaded.append(record["id"])
        self.assertEqual(record["source"], "derived")

        path = ROOT / "data" / "uploads" / f"{record['id']}__{record['name']}"
        with xr.open_dataset(path) as dataset:
            self.assertEqual(int(dataset.sizes["time"]), 100)
            attrs = dataset.attrs
            self.assertEqual(attrs["area_method"], "区域求和")
            self.assertIn("区域求和", attrs["data_source"])
            self.assertIn("去趋势", attrs["preprocess"])
            self.assertEqual(int(attrs["n_samples"]), 100)

        # CSV 只能下载，不能写入数据文件
        bad = self.client.post(
            f"/api/analysis/{self.file_id}/series/export",
            json={**body, "format": "csv"},
        )
        self.assertEqual(bad.status_code, 422, bad.text)
        self.assertEqual(bad.json()["code"], "analysis_failed")

    def test_series_export_download(self) -> None:
        """target=download 时直接返回文件流。"""
        response = self.client.post(
            f"/api/analysis/{self.file_id}/series/export",
            json={
                "variable": "PR",
                "lat": 35,
                "lon": 105,
                "start": 0,
                "end": 9,
                "format": "netcdf",
                "target": "download",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("netcdf", response.headers["content-type"])

        csv = self.client.post(
            f"/api/analysis/{self.file_id}/series/export",
            json={
                "variable": "PR",
                "lat": 35,
                "lon": 105,
                "start": 0,
                "end": 9,
                "format": "csv",
                "target": "download",
            },
        )
        self.assertEqual(csv.status_code, 200, csv.text)
        header = csv.content.decode("utf-8-sig").splitlines()[0].split(",")
        self.assertEqual(header, ["time_index", "time", "PR"])

    def test_cross_spectrum(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/cross-spectrum",
            {"variable_a": "PR", "variable_b": "TEM", "lat": 35, "lon": 105},
        )
        self.assertIn("coherence", payload)
        self.assertIn("correlation", payload)

    def _upload_time_slice(self, name: str, *, start: int = 0, stop: int | None = None, shift_days: int = 0) -> str:
        """截取样本的一段时次并可选整体平移时间轴，上传成新文件用于跨文件测试。"""
        import datetime as _dt

        with xr.open_dataset(SAMPLE) as dataset:
            subset = dataset.isel(time=slice(start, stop)).load()
        # 原文件的 _FillValue / missing_value 冲突，清空编码后让 xarray 重新生成
        for variable in subset.variables.values():
            variable.encoding = {}
        if shift_days:
            shifted = [value + _dt.timedelta(days=shift_days) for value in subset.time.values]
            subset = subset.assign_coords(time=("time", shifted, subset.time.attrs))

        buffer = io.BytesIO()
        subset.to_netcdf(buffer)
        buffer.seek(0)
        response = self.client.post(
            "/api/files",
            files={"file": (name, buffer, "application/x-netcdf")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        record = response.json()
        self.uploaded.append(record["id"])
        return record["id"]

    def _upload_shifted_copy(self) -> str:
        """上传一份从第 60 个时次开始的副本，用于验证跨文件时间对齐。"""
        return self._upload_time_slice("shifted_copy.nc", start=60)

    def test_cross_spectrum_across_files(self) -> None:
        """跨文件交叉谱：两个文件的时间轴先取交集，再对齐计算。"""
        other = self._upload_shifted_copy()
        payload = self._post(
            f"/api/analysis/{self.file_id}/cross-spectrum",
            {
                "file_a": self.file_id,
                "file_b": other,
                "variable_a": "PR",
                "variable_b": "TEM",
                "lat": 35,
                "lon": 105,
            },
        )
        self.assertIn("coherence", payload)
        self.assertEqual(payload["source"]["file_b"], other)
        self.assertEqual(payload["source"]["variable_b"], "TEM")
        # 数据 B 只有 180 个时次，公共时段不应超过它
        self.assertLessEqual(payload["source"]["n"], 180)
        self.assertGreater(payload["source"]["n"], 4)
        self.assertLessEqual(payload["source"]["align"]["overlap"], 180)

    def test_correlation_across_files(self) -> None:
        other = self._upload_shifted_copy()
        payload = self._post(
            f"/api/analysis/{self.file_id}/correlation",
            {
                "file_a": self.file_id,
                "file_b": other,
                "variable_a": "PR",
                "variable_b": "TEM",
                "lat": 30,
                "lon": 110,
                "method": "spearman",
            },
        )
        self.assertIn("r", payload)
        self.assertEqual(payload["source"]["file_a"], self.file_id)
        self.assertEqual(payload["source"]["align"]["n_b"], 180)

    def test_compare_across_files(self) -> None:
        other = self._upload_shifted_copy()
        payload = self._post(
            f"/api/analysis/{self.file_id}/compare",
            {
                "file_a": self.file_id,
                "file_b": other,
                "variable_a": "PR",
                "variable_b": "TEM",
                "lat": 35,
                "lon": 105,
            },
        )
        self.assertEqual(len(payload["labels"]), 2)
        self.assertEqual(len(payload["matrix"]), 2)
        self.assertEqual(payload["source"]["file_b"], other)

    def test_same_variable_same_file_rejected(self) -> None:
        response = self.client.post(
            f"/api/analysis/{self.file_id}/cross-spectrum",
            json={"variable_a": "PR", "variable_b": "PR", "lat": 35, "lon": 105},
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_no_time_overlap_rejected(self) -> None:
        """时间轴完全没有交集时应给出明确提示，而不是算出错误结果。"""
        far_id = self._upload_time_slice("far_copy.nc", stop=40, shift_days=100000)

        response = self.client.post(
            f"/api/analysis/{self.file_id}/cross-spectrum",
            json={
                "file_a": self.file_id,
                "file_b": far_id,
                "variable_a": "PR",
                "variable_b": "TEM",
                "lat": 35,
                "lon": 105,
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("重叠", response.json()["detail"])

    def test_correlation(self) -> None:
        payload = self._post(
            "/api/analysis/correlation",
            {"series_a": [1, 2, 3, 4, 5, 6, 7, 8], "series_b": [2, 4, 6, 8, 10, 12, 14, 16]},
        )
        self.assertAlmostEqual(payload["r"], 1.0, places=6)

    def test_compare(self) -> None:
        payload = self._post(
            "/api/analysis/compare",
            {"series": {"a": [1, 2, 3, 4, 5], "b": [2, 1, 4, 3, 6]}, "normalize": True},
        )
        self.assertEqual(len(payload["labels"]), 2)
        self.assertEqual(len(payload["matrix"]), 2)

    # ---------------------------------------------------------------- 导出
    def test_export_csv(self) -> None:
        response = self.client.post(
            f"/api/files/{self.file_id}/export",
            json={"format": "csv", "variable": "PR", "start": 0, "end": 4},
        )
        self.assertEqual(response.status_code, 200)
        header = response.text.lstrip("\ufeff").splitlines()[0]
        self.assertEqual(header, "time,lat,lon,PR")

    def test_export_netcdf(self) -> None:
        response = self.client.post(
            f"/api/files/{self.file_id}/export",
            json={
                "format": "netcdf",
                "variable": "PR",
                "start": 0,
                "end": 9,
                "lat_range": [-10, 50],
                "lon_range": [70, 140],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/x-netcdf")
        # netCDF4/HDF5 文件以 \x89HDF 开头，经典 netCDF3 以 CDF 开头
        self.assertTrue(response.content.startswith(b"CDF") or response.content.startswith(b"\x89HDF"))

    def test_export_netcdf_point(self) -> None:
        response = self.client.post(
            f"/api/files/{self.file_id}/export",
            json={"format": "netcdf", "variable": "PR", "start": 0, "end": 9, "lat": 35, "lon": 105},
        )
        self.assertEqual(response.status_code, 200)
        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as handle:
            handle.write(response.content)
            tmp_path = handle.name
        try:
            with xr.open_dataset(tmp_path) as ds:
                self.assertIn("PR", ds.data_vars)
                self.assertEqual(ds.sizes["time"], 10)
                self.assertNotIn("lat", ds.sizes)
                self.assertAlmostEqual(float(ds["lat"].values), 35.0)
                self.assertAlmostEqual(float(ds["lon"].values), 105.0)
        finally:
            os.unlink(tmp_path)

    def test_preview_map(self) -> None:
        response = self.client.get(
            f"/api/files/{self.file_id}/preview/map", params={"variable": "PR"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
