"""全局配置。

所有路径都以项目根目录为基准解析，避免在不同工作目录下启动时路径错乱。
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent


def _env_path(name: str, default: Path) -> Path:
    """允许用环境变量覆盖默认路径。"""
    raw = os.getenv(name)
    return Path(raw).expanduser().resolve() if raw else default


class Settings:
    # ---- 基本信息 ----
    project_name: str = "古气候数据分析可视化系统"
    description: str = "基于 FastAPI 的古气候 NetCDF 数据分析与可视化平台"
    version: str = "1.0.0"
    api_prefix: str = "/api"

    # ---- 目录 ----
    base_dir: Path = BASE_DIR
    static_dir: Path = BASE_DIR / "static"
    data_dir: Path = _env_path("PALEOVIS_DATA_DIR", BASE_DIR / "data")
    upload_dir: Path = data_dir / "uploads"
    cache_dir: Path = data_dir / "cache"
    preview_dir: Path = cache_dir / "previews"
    temp_dir: Path = data_dir / "temp"

    # ---- 上传限制 ----
    max_upload_mb: int = int(os.getenv("PALEOVIS_MAX_UPLOAD_MB", "1024"))
    allowed_suffixes: tuple[str, ...] = (".nc", ".nc4", ".cdf", ".netcdf", ".grd")

    # ---- 预览图 ----
    preview_dpi: int = 110
    preview_max_size_mb: float = 4.0

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.upload_dir, self.cache_dir, self.preview_dir, self.temp_dir):
            path.mkdir(parents=True, exist_ok=True)


settings = Settings()
