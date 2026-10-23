"""接口冒烟测试（unittest，无需 pytest）。

运行：python tests/test_api.py
"""
from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

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

    def test_wavelet(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/wavelet",
            {"variable": "PR", "lat": 35, "lon": 105, "max_scale": 32},
        )
        self.assertEqual(len(payload["power"]), len(payload["period"]))

    def test_period(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/period", {"variable": "PR", "lat": 35, "lon": 105}
        )
        self.assertIn("acf", payload)
        self.assertIn("spectrum", payload)

    def test_abrupt(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/abrupt-change",
            {"variable": "PR", "lat": 35, "lon": 105, "method": "all"},
        )
        self.assertIn("mann_kendall", payload)
        self.assertIn("pettitt", payload)

    def test_eemd(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/eemd",
            {"variable": "PR", "lat": 35, "lon": 105, "max_imfs": 3, "trials": 10},
        )
        self.assertGreaterEqual(payload["imf_count"], 1)
        self.assertEqual(len(payload["residue"]), payload["n"])

    def test_cross_spectrum(self) -> None:
        payload = self._post(
            f"/api/analysis/{self.file_id}/cross-spectrum",
            {"variable_a": "PR", "variable_b": "TEM", "lat": 35, "lon": 105},
        )
        self.assertIn("coherence", payload)
        self.assertIn("correlation", payload)

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

    def test_preview_map(self) -> None:
        response = self.client.get(
            f"/api/files/{self.file_id}/preview/map", params={"variable": "PR"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
