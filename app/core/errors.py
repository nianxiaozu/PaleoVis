"""统一的业务异常与错误响应。"""
from __future__ import annotations


class PaleoVisError(Exception):
    """业务层可预期的异常，会被转换成 4xx 响应。"""

    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


class NotFoundError(PaleoVisError):
    status_code = 404
    code = "not_found"


class InvalidFileError(PaleoVisError):
    status_code = 400
    code = "invalid_file"


class AnalysisError(PaleoVisError):
    status_code = 422
    code = "analysis_failed"
