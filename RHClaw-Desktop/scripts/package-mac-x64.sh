#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── FULL-OFFLINE 输入物料缓存检查 ─────────────────────────────────────────
# 缓存命中条件：manifest 存在 + 所有文件在磁盘上存在 + openclaw/Channel 版本与当前最新一致。
# 设置 RHOPENCLAW_FORCE_REBUILD_OFFLINE=1 可强制跳过缓存直接重建。
FULL_OFFLINE_MANIFEST="release/openclaw-bootstrap/full-offline-only/macos-x64/manifests/full-offline-materials.json"
FULL_OFFLINE_ROOT="release/openclaw-bootstrap/full-offline-only/macos-x64"
CHANNEL_PACKAGE_JSON="${RHOPENCLAW_CHANNEL_PACKAGE_JSON_PATH:-}"
if [[ -z "$CHANNEL_PACKAGE_JSON" && -n "${RHOPENCLAW_CHANNEL_ROOT:-}" ]]; then
  CHANNEL_PACKAGE_JSON="${RHOPENCLAW_CHANNEL_ROOT%/}/package.json"
fi
FORCE_REBUILD="${RHOPENCLAW_FORCE_REBUILD_OFFLINE:-0}"

check_full_offline_up_to_date() {
  [[ -f "$FULL_OFFLINE_MANIFEST" ]] || return 1

  local marker
  marker="$(node -e "const m=require('./"$FULL_OFFLINE_MANIFEST"'); process.stdout.write(m.marker||'')" 2>/dev/null)" || return 1
  [[ "$marker" == 'FULL-OFFLINE-ONLY' ]] || return 1

  # 验证所有引用文件存在
  local missing
  missing="$(node -e "
    const fs=require('node:fs');
    const m=JSON.parse(fs.readFileSync('$FULL_OFFLINE_MANIFEST','utf8'));
    const root='$FULL_OFFLINE_ROOT';
    const missing=(m.files||[]).filter(p=>!fs.existsSync(require('node:path').join(root,p)));
    process.stdout.write(String(missing.length));
  " 2>/dev/null)" || return 1
  [[ "$missing" == '0' ]] || { echo "[INFO] 缓存文件缺失 ${missing} 项"; return 1; }

  # 比对 Channel 版本（本地读取，无网络）
  if [[ -f "$CHANNEL_PACKAGE_JSON" ]]; then
    local cached_channel local_channel
    cached_channel="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('$FULL_OFFLINE_MANIFEST','utf8')).channelVersion||'')" 2>/dev/null)"
    local_channel="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('$CHANNEL_PACKAGE_JSON','utf8')).version||'')" 2>/dev/null)"
    if [[ "$cached_channel" != "$local_channel" ]]; then
      echo "[INFO] Channel 版本变化: 缓存=${cached_channel} 当前=${local_channel}"
      return 1
    fi
  elif [[ -n "${RHOPENCLAW_CHANNEL_PACKAGE_PATH:-}" ]]; then
    echo "[INFO] 已通过 RHOPENCLAW_CHANNEL_PACKAGE_PATH 提供预打包 Channel，跳过 package.json 版本缓存校验"
  fi

  # 比对 openclaw 最新版本（npmmirror，网络失败则信任缓存）
  local cached_openclaw latest_openclaw
  cached_openclaw="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('$FULL_OFFLINE_MANIFEST','utf8')).openclawVersion||'')" 2>/dev/null)"
  latest_openclaw="$(npm --silent view 'openclaw@latest' version --registry https://registry.npmmirror.com 2>/dev/null)" || true
  if [[ -n "$latest_openclaw" && "$cached_openclaw" != "$latest_openclaw" ]]; then
    echo "[INFO] openclaw 版本变化: 缓存=${cached_openclaw} 最新=${latest_openclaw}"
    return 1
  fi

  return 0
}

if [[ "$FORCE_REBUILD" != '1' ]] && check_full_offline_up_to_date; then
  echo "[INFO] FULL-OFFLINE 输入物料已是最新，跳过重建。（强制重建: RHOPENCLAW_FORCE_REBUILD_OFFLINE=1）"
else
  echo "[INFO] 生成 macOS x64 FULL-OFFLINE 输入物料..."
  node scripts/build-full-offline-materials.mjs --platform=darwin --arch=x64 --full-platform-label=macos-x64
fi

bash scripts/package-mac.sh x86_64-apple-darwin x64
