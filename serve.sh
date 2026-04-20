#!/usr/bin/env bash
# ローカル検証用サーバ。
#   bash serve.sh           # :8765 で起動
#   bash serve.sh 8000      # 任意ポートを指定
# 起動後: http://localhost:8765/ を開く
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "[serve] http://localhost:${PORT}/"
py -m http.server "${PORT}"
