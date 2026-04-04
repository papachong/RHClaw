#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm 未安装，请先安装 Node.js (包含 npm)。" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "[INFO] 未检测到 node_modules，正在执行 npm install..."
  npm install
fi

echo "[INFO] 启动 RHOpenClaw-Desktop 开发模式 (tauri:dev)..."
npm run tauri:dev
