# 启动古气候数据分析可视化系统（Windows PowerShell）
$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) {
    Write-Host "未检测到 .venv，使用当前 Python 环境" -ForegroundColor Yellow
}

$python = "python"
if (Test-Path ".venv\Scripts\python.exe") { $python = ".venv\Scripts\python.exe" }

if (-not (Test-Path "data\samples\sample_climate.nc")) {
    Write-Host "生成示例数据..." -ForegroundColor Cyan
    & $python "scripts\make_sample_data.py"
}

Write-Host "启动服务: http://127.0.0.1:8000/" -ForegroundColor Green
& $python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
