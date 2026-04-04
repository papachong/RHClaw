#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-}"
ARCH_LABEL="${2:-}"

if [[ -z "$TARGET" || -z "$ARCH_LABEL" ]]; then
  echo "[ERROR] 用法: bash scripts/package-mac.sh <rust-target> <arch-label>" >&2
  echo "[ERROR] 示例: bash scripts/package-mac.sh aarch64-apple-darwin arm64" >&2
  exit 1
fi

BUNDLE_DIR="src-tauri/target/${TARGET}/release/bundle"
OFFLINE_ROOT="release/openclaw-bootstrap"
RELEASE_REPORT="release/release-validation-report.json"
FULL_OFFLINE_ISOLATION_DIR=""
FULL_OFFLINE_ISOLATION_ROOT=""

resolve_rust_host_target() {
  local host
  host="$(rustc -vV 2>/dev/null | awk '/^host: /{print $2}')"
  printf '%s' "$host"
}

select_manifest_file_path() {
  local manifest_path="$1"
  local required_prefix="$2"
  local contains_text="${3:-}"

  node -e "const fs=require('node:fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const requiredPrefix=process.argv[2]; const containsText=process.argv[3]; const candidates=(manifest.files||[]).filter((item)=>typeof item==='string' && item.startsWith(requiredPrefix) && (!containsText || item.includes(containsText))); if(candidates.length!==1){console.error('[ERROR] full-offline manifest 条目匹配失败: prefix='+requiredPrefix+', contains='+(containsText||'<empty>')+', matches='+candidates.length); process.exit(1);} process.stdout.write(candidates[0]);" "$manifest_path" "$required_prefix" "$contains_text"
}

restore_non_target_full_offline_dirs() {
  set +e

  if [[ -n "$FULL_OFFLINE_ISOLATION_DIR" && -d "$FULL_OFFLINE_ISOLATION_DIR" && -n "$FULL_OFFLINE_ISOLATION_ROOT" && -d "$FULL_OFFLINE_ISOLATION_ROOT" ]]; then
    shopt -s dotglob nullglob
    local entries=("$FULL_OFFLINE_ISOLATION_DIR"/*)
    shopt -u dotglob nullglob
    if [[ ${#entries[@]} -gt 0 ]]; then
      mv "${entries[@]}" "$FULL_OFFLINE_ISOLATION_ROOT"/
    fi
    rm -rf "$FULL_OFFLINE_ISOLATION_DIR"
  fi

  FULL_OFFLINE_ISOLATION_DIR=""
  FULL_OFFLINE_ISOLATION_ROOT=""
  return 0
}

isolate_non_target_full_offline_dirs() {
  local expected_platform="macos-${ARCH_LABEL}"
  local full_offline_base="${OFFLINE_ROOT}/full-offline-only"

  [[ -d "$full_offline_base" ]] || return 0

  FULL_OFFLINE_ISOLATION_ROOT="$full_offline_base"
  FULL_OFFLINE_ISOLATION_DIR="$(mktemp -d)"

  while IFS= read -r entry; do
    mv "$entry" "$FULL_OFFLINE_ISOLATION_DIR"/
  done < <(find "$full_offline_base" -mindepth 1 -maxdepth 1 ! -name "$expected_platform" -print)

  echo "[INFO] 已临时隔离非目标平台 full-offline 目录，仅打包 ${expected_platform}"
}

validate_full_offline_materials() {
  local expected_platform="macos-${ARCH_LABEL}"
  local full_offline_root="${OFFLINE_ROOT}/full-offline-only/${expected_platform}"
  local readme_path="${full_offline_root}/README_FULL_OFFLINE_ONLY.txt"
  local full_manifest_path="${full_offline_root}/manifests/full-offline-materials.json"
  if [[ ! -f "$readme_path" ]]; then
    echo "[ERROR] 未找到 FULL-OFFLINE-ONLY 标记文件: ${readme_path}" >&2
    exit 1
  fi

  if [[ ! -f "$full_manifest_path" ]]; then
    echo "[ERROR] 未找到 FULL-OFFLINE-ONLY manifest: ${full_manifest_path}。请先执行 full-offline 输入物料准备脚本。" >&2
    exit 1
  fi

  local manifest_platform
  manifest_platform="$(node -e "const fs=require('node:fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(manifest.platform||''));" "$full_manifest_path")"
  if [[ "$manifest_platform" != "$expected_platform" ]]; then
    echo "[ERROR] FULL-OFFLINE-ONLY manifest 平台不匹配: 期望 ${expected_platform}，实际 ${manifest_platform:-<empty>}。请先重新生成当前平台输入物料。" >&2
    exit 1
  fi

  local full_openclaw_relative
  full_openclaw_relative="$(select_manifest_file_path "$full_manifest_path" 'packages/openclaw/' '.tgz')"
  local full_node_relative
  full_node_relative="$(select_manifest_file_path "$full_manifest_path" 'packages/node/' "darwin-${ARCH_LABEL}")"
  local full_channel_relative
  full_channel_relative="$(select_manifest_file_path "$full_manifest_path" 'packages/rhclaw-channel/' '.tgz')"

  if ! node -e "const fs=require('node:fs'); const path=require('node:path'); const root=process.argv[1]; const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const missing=(manifest.files||[]).filter((item)=>!fs.existsSync(path.join(root,item))); if(missing.length){console.error(missing.join('\n')); process.exit(1);}" "$full_offline_root" "$full_manifest_path"; then
    echo "[ERROR] FULL-OFFLINE-ONLY manifest 引用的输入物料文件不存在，请先重新生成当前平台输入物料。" >&2
    exit 1
  fi

  echo "[INFO] FULL-OFFLINE 输入物料已就绪: ${full_offline_root}"
  echo "[INFO] OpenClaw 包: ${full_openclaw_relative}"
  echo "[INFO] Node 包: ${full_node_relative}"
  echo "[INFO] RHClaw-Channel 包: ${full_channel_relative}"
}

print_installer_paths() {
  local bundle_dir="$1"
  local -a installers=()

  if [[ -d "$bundle_dir/dmg" ]]; then
    while IFS= read -r file; do
      installers+=("$file")
    done < <(find "$bundle_dir/dmg" -maxdepth 1 -type f -name '*.dmg' | sort)
  fi

  if [[ -d "$bundle_dir/macos" ]]; then
    while IFS= read -r file; do
      installers+=("$file")
    done < <(find "$bundle_dir/macos" -maxdepth 1 -type f -name '*.app.tar.gz' | sort)
  fi

  if [[ ${#installers[@]} -gt 0 ]]; then
    echo "[INFO] 新安装包位置:"
    for file in "${installers[@]}"; do
      echo "[INFO] ${ROOT_DIR}/${file}"
    done
  else
    echo "[WARN] 未在 bundle 目录中检测到安装包文件"
  fi
}

trap 'restore_non_target_full_offline_dirs' EXIT

export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
export http_proxy="${http_proxy:-http://127.0.0.1:7890}"
export all_proxy="${all_proxy:-socks5://127.0.0.1:7890}"

if [[ -n "${RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH:-}" && ! -f "$RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH" ]]; then
  echo "[ERROR] RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH 指向的文件不存在: ${RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH}" >&2
  exit 1
fi

if [[ -n "${RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH:-}" && ! -f "$RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH" ]]; then
  echo "[ERROR] RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH 指向的文件不存在: ${RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH}" >&2
  exit 1
fi

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
  echo "[ERROR] TAURI_SIGNING_PRIVATE_KEY_PATH 指向的文件不存在: ${TAURI_SIGNING_PRIVATE_KEY_PATH}" >&2
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm 未安装，请先安装 Node.js (包含 npm)。" >&2
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "[WARN] 未配置 Tauri updater 私钥；公开仓默认不再提供私有默认密钥路径。若当前构建需要签名，请设置 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH。"
fi

if [[ ! -d node_modules ]]; then
  echo "[INFO] 未检测到 node_modules，正在执行 npm install..."
  npm install
fi

RUST_HOST_TARGET="$(resolve_rust_host_target)"
if command -v rustup >/dev/null 2>&1; then
  echo "[INFO] 安装 Rust 目标: ${TARGET}"
  rustup target add "$TARGET"

  # Ensure tauri/cargo use rustup-managed toolchain binaries instead of Homebrew rust.
  RUSTUP_CARGO_BIN="$(dirname "$(rustup which cargo)")"
  if [[ -d "$RUSTUP_CARGO_BIN" ]]; then
    export PATH="$RUSTUP_CARGO_BIN:$PATH"
  fi
elif [[ "$TARGET" == "$RUST_HOST_TARGET" ]]; then
  echo "[WARN] 未检测到 rustup，当前仅按本机原生 Rust 目标继续构建: ${TARGET}"
else
  echo "[ERROR] 未检测到 rustup，无法安装交叉编译目标 ${TARGET}（当前主机目标: ${RUST_HOST_TARGET:-unknown}）。" >&2
  exit 1
fi

validate_full_offline_materials

echo "[INFO] 执行 Tauri 工具链预检..."
npm run tauri:doctor

echo "[INFO] 开始构建 macOS ${ARCH_LABEL} 安装包..."
isolate_non_target_full_offline_dirs
npm run tauri:build -- --target "$TARGET"
restore_non_target_full_offline_dirs
RHOPENCLAW_BUNDLE_DIR="$BUNDLE_DIR" npm run release:bundle-extras
npm run release:normalize
npm run release:manifest -- --artifact-root="src-tauri/target/${TARGET}"
npm run release:verify

MISSING_COUNT="$(node -e "const fs=require('node:fs'); const report=JSON.parse(fs.readFileSync('${RELEASE_REPORT}','utf8')); process.stdout.write(String(report?.coverage?.missingCount ?? 1));")"
if [[ "$MISSING_COUNT" == "0" ]]; then
  if [[ -n "${RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    npm run release:gate -- --require-signature=true
  else
    npm run release:gate
  fi
else
  echo "[INFO] 当前仅完成单平台产物构建，兼容矩阵仍缺少 ${MISSING_COUNT} 项，跳过 release:gate。"
fi

echo "[INFO] 构建完成，产物目录: ${BUNDLE_DIR}"
if [[ -d "$BUNDLE_DIR/dmg" ]]; then
  echo "[INFO] DMG 文件:"
  ls -lh "$BUNDLE_DIR/dmg"
fi
if [[ -d "$BUNDLE_DIR/macos" ]]; then
  echo "[INFO] APP 文件:"
  ls -lh "$BUNDLE_DIR/macos"
fi

print_installer_paths "$BUNDLE_DIR"