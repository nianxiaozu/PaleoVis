#!/usr/bin/env bash
# 启动古气候数据分析可视化系统（Linux / macOS）
set -e

PYTHON="python3"
if [ -x ".venv/bin/python" ]; then
  PYTHON=".venv/bin/python"
fi

if [ ! -f "data/samples/sample_climate.nc" ]; then
  echo "生成示例数据..."
  "$PYTHON" scripts/make_sample_data.py
fi

echo "启动服务: http://127.0.0.1:8000/"
exec "$PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
