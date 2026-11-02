"""FastAPI 应用入口。

启动：uvicorn app.main:app --reload
文档：http://127.0.0.1:8000/docs
页面：http://127.0.0.1:8000/

uvicorn启动 → app实例
├─ lifespan：启动创建目录、退出清理临时目录
├─ CORS中间件：解决跨域
├─ 全局异常捕获：统一格式化报错返回
├─ 注册业务路由：files / datasets / analysis
├─ 挂载静态文件：前端js/css，关闭缓存
├─ 系统接口：健康检查、前端配置
└─ 首页路由：返回前端index.html或者欢迎json
"""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.endpoints import analysis, datasets, files
from app.core.config import settings
from app.core.errors import PaleoVisError
from app.services import easyclimate_bridge
from app.services.storage import storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("paleovis")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ===========服务启动时执行==============
    settings.ensure_dirs()
    logger.info("数据目录：%s", settings.data_dir)
    logger.info("已加载文件：%d 个", len(storage.list_records()))
    # easyclimate 首次导入约需数秒，放到后台线程预热，避免拖慢首屏
    threading.Thread(target=easyclimate_bridge.warmup, daemon=True).start()
    yield
    # ===========服务关闭退出时执行==============
    # 清理临时目录，保留用户上传的数据
    import shutil

    if settings.temp_dir.exists():
        shutil.rmtree(settings.temp_dir, ignore_errors=True)


app = FastAPI(
    title=settings.project_name,
    description=settings.description,
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 自定义异常
@app.exception_handler(PaleoVisError)
async def paleovis_error_handler(request: Request, exc: PaleoVisError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "code": exc.code},
    )


# 请求参数校验异常
def _jsonable_errors(errors: list[dict]) -> list[dict]:
    """把 pydantic 的校验错误转成可 JSON 序列化的结构。

    model_validator 抛出的 ValueError 会原样放进 ctx["error"]，
    直接交给 JSONResponse 会触发 "Object of type ValueError is not JSON serializable"。
    """
    out: list[dict] = []
    for item in errors:
        clean = {k: v for k, v in item.items() if k != "ctx"}
        ctx = item.get("ctx")
        if ctx:
            clean["ctx"] = {k: str(v) for k, v in ctx.items()}
        out.append(clean)
    return out


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "detail": "请求参数有误",
            "code": "validation_error",
            "errors": _jsonable_errors(exc.errors()),
        },
    )


app.include_router(files.router, prefix=f"{settings.api_prefix}/files", tags=["文件管理"])
app.include_router(datasets.router, prefix=f"{settings.api_prefix}/datasets", tags=["数据查询"])
app.include_router(analysis.router, prefix=f"{settings.api_prefix}/analysis", tags=["时序分析"])

class NoCacheStaticFiles(StaticFiles):
    """静态资源禁用强缓存，避免前端改了代码浏览器仍用旧版本。

    index.html 中已给脚本加上 ?v= 版本号，这里再补一层 Cache-Control，
    确保升级后刷新页面一定能拿到最新 JS / CSS。
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


if settings.static_dir.exists():
    app.mount("/static", NoCacheStaticFiles(directory=str(settings.static_dir)), name="static")


@app.get("/api/health", tags=["系统"], summary="健康检查")
def health() -> dict:
    return {
        "status": "ok",
        "project": settings.project_name,
        "version": settings.version,
        "files": len(storage.list_records()),
    }


@app.get("/api/config", tags=["系统"], summary="前端运行配置")
def runtime_config() -> dict:
    return {
        "project_name": settings.project_name,
        "description": settings.description,
        "version": settings.version,
        "api_prefix": settings.api_prefix,
        "max_upload_mb": settings.max_upload_mb,
        "allowed_suffixes": list(settings.allowed_suffixes),
    }


@app.get("/", include_in_schema=False)
def index():
    index_file = settings.static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers={"Cache-Control": "no-cache, must-revalidate"})
    return JSONResponse(
        {
            "message": f"Welcome to {settings.project_name}",
            "docs": "/docs",
            "api": settings.api_prefix,
        }
    )
