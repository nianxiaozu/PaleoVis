"""文件仓库：上传、列表、删除、示例数据。"""
from __future__ import annotations

import datetime as _dt
import json
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.core.config import settings
from app.core.errors import InvalidFileError, NotFoundError, PaleoVisError

_SAFE_NAME = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")
_UPLOAD_ID = re.compile(r"^(?P<id>[0-9a-f]{12})__(?P<rest>.+)$")


@dataclass
class FileRecord:
    id: str
    name: str
    size: int
    uploaded_at: str
    source: str = "upload"  # upload | sample
    suffix: str = ".nc"
    path: str = ""
    readonly: bool = False  # 数据是否为只读

    def public(self) -> dict:
        data = asdict(self)
        data.pop("path", None)
        return data


def _safe_filename(name: str) -> str:
    base = Path(name or "dataset.nc").name
    stem = _SAFE_NAME.sub("_", Path(base).stem)[:80] or "dataset"
    suffix = Path(base).suffix.lower() or ".nc"
    return f"{stem}{suffix}"


def _now() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


class StorageService:
    """负责 uploads / samples 两个目录的读写。"""

    def __init__(self) -> None:
        self.upload_dir = settings.upload_dir
        self.sample_dir = settings.data_dir / "samples"
        settings.ensure_dirs()
        self.sample_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 查询
    def list_records(self) -> list[FileRecord]:
        records: list[FileRecord] = []
        records.extend(self._scan_uploads())
        records.extend(self._scan_samples())
        records.sort(key=lambda r: r.uploaded_at, reverse=True)
        return records

    def get(self, file_id: str) -> FileRecord:
        for record in self.list_records():
            if record.id == file_id:
                return record
        raise NotFoundError(f"文件不存在：{file_id}")

    def path_of(self, file_id: str) -> Path:
        record = self.get(file_id)
        path = Path(record.path)
        if not path.exists():
            raise NotFoundError(f"文件已被移除：{record.name}")
        return path

    # ------------------------------------------------------------------ 写入
    def save_upload(
        self, filename: str, content: bytes, *, source: str = "upload"
    ) -> FileRecord:
        if not content:
            raise InvalidFileError("上传内容为空")
        if len(content) > settings.max_upload_bytes:
            raise InvalidFileError(f"文件超过上限 {settings.max_upload_mb} MB")

        safe = _safe_filename(filename)
        suffix = Path(safe).suffix.lower()
        if suffix not in settings.allowed_suffixes:
            raise InvalidFileError(
                f"不支持的文件类型 {suffix or '(无后缀)'}，仅支持 {', '.join(settings.allowed_suffixes)}"
            )

        file_id = uuid.uuid4().hex[:12]
        stored = self.upload_dir / f"{file_id}__{safe}"
        stored.write_bytes(content)

        record = FileRecord(
            id=file_id,
            name=safe,
            size=len(content),
            uploaded_at=_now(),
            source=source,
            suffix=suffix,
            path=str(stored),
        )
        self._write_sidecar(record)
        return record

    def save_stream(self, filename: str, stream) -> FileRecord:
        """流式写入，避免一次性读入超大文件。"""
        safe = _safe_filename(filename)
        suffix = Path(safe).suffix.lower()
        if suffix not in settings.allowed_suffixes:
            raise InvalidFileError(
                f"不支持的文件类型 {suffix or '(无后缀)'}，仅支持 {', '.join(settings.allowed_suffixes)}"
            )
        file_id = uuid.uuid4().hex[:12]
        stored = self.upload_dir / f"{file_id}__{safe}"
        size = 0
        try:
            with stored.open("wb") as handle:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise InvalidFileError(f"文件超过上限 {settings.max_upload_mb} MB")
                    handle.write(chunk)
        except Exception:
            stored.unlink(missing_ok=True)
            raise

        if size == 0:
            stored.unlink(missing_ok=True)
            raise InvalidFileError("上传内容为空")

        record = FileRecord(
            id=file_id,
            name=safe,
            size=size,
            uploaded_at=_now(),
            source="upload",
            suffix=suffix,
            path=str(stored),
        )
        self._write_sidecar(record)
        return record

    def delete(self, file_id: str) -> None:
        record = self.get(file_id)
        if record.readonly:
            raise PaleoVisError("示例数据为只读，不能删除", status_code=403, code="readonly")
        path = Path(record.path)
        resolved = path.resolve()
        if self.upload_dir.resolve() not in resolved.parents:
            raise PaleoVisError("非法的文件路径", status_code=400, code="invalid_path")
        resolved.unlink(missing_ok=True)
        self._sidecar_path(file_id).unlink(missing_ok=True)

    def clear_cache(self) -> None:
        if settings.cache_dir.exists():
            shutil.rmtree(settings.cache_dir, ignore_errors=True)
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        settings.preview_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 内部
    def _sidecar_path(self, file_id: str) -> Path:
        return self.upload_dir / f"{file_id}.json"

    def _write_sidecar(self, record: FileRecord) -> None:
        payload = record.public()
        payload["path"] = record.path
        self._sidecar_path(record.id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _scan_uploads(self) -> list[FileRecord]:
        records: list[FileRecord] = []
        if not self.upload_dir.exists():
            return records
        for path in self.upload_dir.iterdir():
            if not path.is_file() or path.suffix.lower() in {".json", ".part"}:
                continue
            match = _UPLOAD_ID.match(path.name)
            if not match:
                continue
            file_id = match.group("id")
            sidecar = self._sidecar_path(file_id)
            meta: dict = {}
            if sidecar.exists():
                try:
                    meta = json.loads(sidecar.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    meta = {}
            stat = path.stat()
            records.append(
                FileRecord(
                    id=file_id,
                    name=meta.get("name") or match.group("rest"),
                    size=stat.st_size,
                    uploaded_at=meta.get("uploaded_at")
                    or _dt.datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
                    source=meta.get("source") or "upload",
                    suffix=path.suffix.lower(),
                    path=str(path),
                )
            )
        return records

    def _scan_samples(self) -> list[FileRecord]:
        records: list[FileRecord] = []
        if not self.sample_dir.exists():
            return records
        for path in sorted(self.sample_dir.iterdir()):
            if not path.is_file() or path.suffix.lower() not in settings.allowed_suffixes:
                continue
            stat = path.stat()
            records.append(
                FileRecord(
                    id=f"sample-{path.stem}"[:40],
                    name=path.name,
                    size=stat.st_size,
                    uploaded_at=_dt.datetime.fromtimestamp(stat.st_mtime)
                    .astimezone()
                    .isoformat(timespec="seconds"),
                    source="sample",
                    suffix=path.suffix.lower(),
                    path=str(path),
                    readonly=True,   # 示例文件只读
                )
            )
        return records


storage = StorageService()
