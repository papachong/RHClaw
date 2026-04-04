#!/usr/bin/env bash
set -euo pipefail

MIRROR_BASE_URL="${RHOPENCLAW_MIRROR_BASE_URL:-}"
PRIMARY_INSTALL_URL="${RHOPENCLAW_OPENCLAW_INSTALL_SCRIPT_MIRROR_URL:-}"
if [[ -z "$PRIMARY_INSTALL_URL" && -n "$MIRROR_BASE_URL" ]]; then
  PRIMARY_INSTALL_URL="${MIRROR_BASE_URL%/}/mirrors/openclaw/install.sh"
fi
PRIMARY_INSTALL_URL="${PRIMARY_INSTALL_URL:-https://openclaw.ai/install.sh}"
SERVER_API_BASE_URL="${RHOPENCLAW_SERVER_API_BASE_URL:-http://127.0.0.1:3000/api/v1}"
SKILLHUB_INSTALLER_URL="${RHOPENCLAW_SKILLHUB_INSTALLER_URL:-https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh}"
OFFLINE_BUNDLE_DIR="${RHOPENCLAW_OFFLINE_BUNDLE_DIR:-}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

DESKTOP_SKILLS_FILE="${TMP_DIR}/desktop-install-skills.txt"
SKILLHUB_SKILLS_DIR="${HOME}/.openclaw/skills"

export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
export NODEJS_ORG_MIRROR="${NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"
export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"
export HOMEBREW_BREW_GIT_REMOTE="${HOMEBREW_BREW_GIT_REMOTE:-https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git}"
export HOMEBREW_CORE_GIT_REMOTE="${HOMEBREW_CORE_GIT_REMOTE:-https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git}"
export HOMEBREW_API_DOMAIN="${HOMEBREW_API_DOMAIN:-https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api}"
export HOMEBREW_BOTTLE_DOMAIN="${HOMEBREW_BOTTLE_DOMAIN:-https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles}"
export NO_PROMPT="${NO_PROMPT:-1}"
export OPENCLAW_NO_ONBOARD="${OPENCLAW_NO_ONBOARD:-1}"
export OPENCLAW_NPM_LOGLEVEL="${OPENCLAW_NPM_LOGLEVEL:-error}"
export PATH="${HOME}/.local/bin:${HOME}/bin:${PATH}"

log() {
  printf '[install-cn] %s\n' "$*"
}

write_default_desktop_skills() {
  cat >"$DESKTOP_SKILLS_FILE" <<'EOF'
1password
apple-notes
apple-reminders
api-gateway
agent-browser
akshare-finance
ai-ppt-generator
auto-updater
automation-workflows
byterover
brave-search
canvas
clawdhub
clawddocs
find-skills
free-ride
frontend-design
gmail
github
gog
humanizer
himalaya
healthcheck
model-usage
memory-manager
n8n-workflow-automation
obsidian
openai-whisper
pdf
proactive-agent
session-logs
self-improving
skill-creator
stock-analysis
summarize
stripe-api
tmux
tavily-search
ui-ux-pro-max
video-frames
weather
xurl
acp-router
prose
feishu-doc
feishu-drive
feishu-wiki
code
edge-tts
mbti
EOF
}

download_file() {
  local url="$1"
  local output="$2"
  curl -fsSL --connect-timeout 5 --retry 1 --retry-delay 1 -o "$output" "$url"
}

fetch_desktop_install_skills_config() {
  local payload_file="${TMP_DIR}/desktop-install-skills.json"
  local parsed_dir="${TMP_DIR}/desktop-install-skills"
  local config_url="${SERVER_API_BASE_URL%/}/desktop/install/skills"

  : >"$DESKTOP_SKILLS_FILE"

  if ! download_file "$config_url" "$payload_file"; then
    log "无法获取 Desktop skills 配置，回退到默认推荐 skills。"
    write_default_desktop_skills
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    log '未检测到 python3，回退到默认推荐 skills。'
    write_default_desktop_skills
    return 0
  fi

  mkdir -p "$parsed_dir"
  if ! python3 - "$payload_file" "$parsed_dir" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
out_dir = pathlib.Path(sys.argv[2])
skillhub = payload.get('skillhub') or {}
skills = [str(item).strip() for item in payload.get('skills') or [] if str(item).strip()]

(out_dir / 'installer').write_text(str(skillhub.get('installerUrl') or '').strip(), encoding='utf-8')
(out_dir / 'skills').write_text('\n'.join(skills), encoding='utf-8')
PY
  then
    log '解析 Desktop skills 配置失败，回退到默认推荐 skills。'
    write_default_desktop_skills
    return 0
  fi

  if [[ -f "$parsed_dir/installer" ]]; then
    local installer_override
    installer_override="$(tr -d '\r' < "$parsed_dir/installer")"
    if [[ -n "$installer_override" ]]; then
      SKILLHUB_INSTALLER_URL="$installer_override"
    fi
  fi

  if [[ -f "$parsed_dir/skills" ]]; then
    cp "$parsed_dir/skills" "$DESKTOP_SKILLS_FILE"
  fi

  if [[ ! -s "$DESKTOP_SKILLS_FILE" ]]; then
    write_default_desktop_skills
  fi
}

install_skillhub_cli_if_needed() {
  if command -v skillhub >/dev/null 2>&1; then
    return 0
  fi

  log "安装 SkillHub CLI: $SKILLHUB_INSTALLER_URL"
  curl -fsSL "$SKILLHUB_INSTALLER_URL" | bash -s -- --no-skills
  command -v skillhub >/dev/null 2>&1
}

skill_is_listed() {
  local slug="$1"
  local list_file="$2"
  grep -Eiq "(^|[^[:alnum:]_-])${slug}([^[:alnum:]_-]|$)" "$list_file"
}

append_openclaw_available_skills_snapshot() {
  local output_file="$1"
  local payload_file="${TMP_DIR}/openclaw-skills.json"

  if ! command -v openclaw >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  if ! openclaw skills list --json >"$payload_file" 2>/dev/null; then
    return 0
  fi

  if ! python3 - "$payload_file" >>"$output_file" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
items = payload if isinstance(payload, list) else (
    payload.get('items') or payload.get('data') or payload.get('skills') or []
)

for item in items:
    if isinstance(item, str):
        slug = item.strip()
        if slug:
            print(slug)
        continue

    if not isinstance(item, dict):
        continue

    slug = str(item.get('slug') or item.get('id') or item.get('name') or '').strip()
    source = str(item.get('source') or '').strip()
    available = bool(item.get('installed')) \
        or bool(item.get('bundled')) \
        or bool(str(item.get('path') or '').strip()) \
        or bool(str(item.get('installPath') or '').strip()) \
        or source.startswith('openclaw-')
    if slug and available:
        print(slug)
PY
  then
    return 0
  fi

  sort -fu "$output_file" -o "$output_file" 2>/dev/null || true
}

install_configured_skills() {
  fetch_desktop_install_skills_config

  install_skillhub_cli_if_needed

  mkdir -p "$SKILLHUB_SKILLS_DIR"

  if [[ ! -s "$DESKTOP_SKILLS_FILE" ]]; then
    write_default_desktop_skills
  fi

  local installed_snapshot="${TMP_DIR}/skillhub-installed.txt"
  local install_failures=()
  local skillhub_cmd=(skillhub --dir "$SKILLHUB_SKILLS_DIR")
  "${skillhub_cmd[@]}" list >"$installed_snapshot" 2>/dev/null || :
  append_openclaw_available_skills_snapshot "$installed_snapshot"

  while IFS= read -r slug; do
    slug="${slug## }"
    slug="${slug%% }"
    if [[ "$slug" == *":"* ]]; then
      slug="${slug##*: }"
    fi
    if [[ -z "$slug" ]]; then
      continue
    fi

    if skill_is_listed "$slug" "$installed_snapshot"; then
      log "推荐 skill 已存在，跳过安装: $slug"
      continue
    fi

    log "安装推荐 skill: $slug"
    if command -v timeout >/dev/null 2>&1; then
      if ! timeout 20 "${skillhub_cmd[@]}" install "$slug"; then
        log "推荐 skill 安装失败或超时，后续继续安装其他项: $slug"
        install_failures+=("$slug")
      fi
    else
      if ! "${skillhub_cmd[@]}" install "$slug"; then
        log "推荐 skill 安装失败，后续继续安装其他项: $slug"
        install_failures+=("$slug")
      fi
    fi
  done < "$DESKTOP_SKILLS_FILE"

  "${skillhub_cmd[@]}" list >"$installed_snapshot" 2>/dev/null || :
  append_openclaw_available_skills_snapshot "$installed_snapshot"
  local total_count=0
  local missing_count=0
  local missing_slugs=()
  while IFS= read -r slug; do
    slug="${slug## }"
    slug="${slug%% }"
    if [[ "$slug" == *":"* ]]; then
      slug="${slug##*: }"
    fi
    if [[ -z "$slug" ]]; then
      continue
    fi
    total_count=$((total_count + 1))

    if ! skill_is_listed "$slug" "$installed_snapshot"; then
      missing_count=$((missing_count + 1))
      missing_slugs+=("$slug")
    fi
  done < "$DESKTOP_SKILLS_FILE"

  if [[ $missing_count -gt 0 ]]; then
    if [[ $missing_count -eq $total_count ]]; then
      log "推荐 skills 校验失败，全部缺失: ${missing_slugs[*]}"
      return 1
    fi

    log "部分推荐 skills 安装失败，将继续主流程。缺失: ${missing_slugs[*]}"
    if [[ ${#install_failures[@]} -gt 0 ]]; then
      log "skills 安装失败项: ${install_failures[*]}"
    fi
  fi
}

resolve_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) return 1 ;;
  esac
}

resolve_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x64' ;;
    *) return 1 ;;
  esac
}

normalize_openclaw_version() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr -d '\r')"
  raw="${raw#OpenClaw }"
  raw="${raw#v}"
  raw="${raw%% *}"
  printf '%s' "$raw"
}

version_at_least() {
  local left right
  left="$(normalize_openclaw_version "${1:-}")"
  right="$(normalize_openclaw_version "${2:-}")"

  if [[ -z "$left" || -z "$right" ]]; then
    return 1
  fi

  local IFS=.
  local -a left_parts=()
  local -a right_parts=()
  read -r -a left_parts <<< "$left"
  read -r -a right_parts <<< "$right"

  local max_len="${#left_parts[@]}"
  if (( ${#right_parts[@]} > max_len )); then
    max_len="${#right_parts[@]}"
  fi

  local index left_value right_value
  for (( index=0; index<max_len; index++ )); do
    left_value="${left_parts[index]:-0}"
    right_value="${right_parts[index]:-0}"

    if (( 10#$left_value > 10#$right_value )); then
      return 0
    fi
    if (( 10#$left_value < 10#$right_value )); then
      return 1
    fi
  done

  return 0
}

detect_installed_openclaw_version() {
  if ! command -v openclaw >/dev/null 2>&1; then
    return 1
  fi

  local raw_version
  raw_version="$(openclaw --version 2>/dev/null | head -n 1)"
  raw_version="$(normalize_openclaw_version "$raw_version")"
  if [[ -z "$raw_version" ]]; then
    return 1
  fi

  printf '%s' "$raw_version"
}

detect_target_openclaw_version() {
  if [[ -n "$OFFLINE_BUNDLE_DIR" && -d "$OFFLINE_BUNDLE_DIR" ]]; then
    local tgz_path tgz_name tgz_version
    tgz_path="$(find "$OFFLINE_BUNDLE_DIR/packages/openclaw" -maxdepth 1 -type f -name 'openclaw-*.tgz' | head -n 1)"
    if [[ -n "$tgz_path" ]]; then
      tgz_name="$(basename "$tgz_path")"
      tgz_version="${tgz_name#openclaw-}"
      tgz_version="${tgz_version%.tgz}"
      tgz_version="$(normalize_openclaw_version "$tgz_version")"
      if [[ -n "$tgz_version" ]]; then
        printf '%s' "$tgz_version"
        return 0
      fi
    fi
  fi

  return 1
}

# ------------------------------------------------------------------
# ensure_openclaw_package_templates <npm_prefix> <tgz_path>
# 检查全局安装的 openclaw 包中 docs/reference/templates/ 是否存在，
# 若缺失则从离线 tgz 中补全（npm install -g 某些环境不释放该目录）。
# ------------------------------------------------------------------
ensure_openclaw_package_templates() {
  local npm_prefix="${1:-}"
  local tgz_path="${2:-}"

  if [[ -z "$npm_prefix" || -z "$tgz_path" ]]; then
    return 0
  fi

  local openclaw_pkg_dir="$npm_prefix/lib/node_modules/openclaw"
  local sentinel="$openclaw_pkg_dir/docs/reference/templates/AGENTS.md"

  if [[ -f "$sentinel" ]]; then
    return 0
  fi

  log "检测到 openclaw 包缺少 docs/reference/templates/，正在从离线包补全..."
  if tar xzf "$tgz_path" --strip-components=1 -C "$openclaw_pkg_dir" 'package/docs/reference/templates/' 2>/dev/null; then
    if [[ -f "$sentinel" ]]; then
      log "docs/reference/templates/ 目录已补全。"
    else
      log "[WARN] 从 tgz 中提取 templates 后仍未找到 AGENTS.md 哨兵文件。"
    fi
  else
    log "[WARN] 从 tgz 中提取 templates 目录失败，Gateway 可能无法正常 dispatch 消息。"
  fi
}

verify_installed_openclaw_version() {
  local target_version="${1:-}"
  local installed_version=""

  installed_version="$(detect_installed_openclaw_version || true)"
  if [[ -z "$installed_version" ]]; then
    log '离线安装执行后仍未检测到 openclaw 版本。'
    return 1
  fi

  if [[ -n "$target_version" ]] && ! version_at_least "$installed_version" "$target_version"; then
    log "离线安装后检测到的 openclaw 版本 ${installed_version} 仍低于目标版本 ${target_version}。"
    return 1
  fi

  if ! verify_installed_openclaw_runtime_assets; then
    return 1
  fi

  return 0
}

detect_installed_openclaw_package_dir() {
  local npm_root=""
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$npm_root" && -d "$npm_root/openclaw" ]]; then
    printf '%s' "$npm_root/openclaw"
    return 0
  fi

  return 1
}

verify_installed_openclaw_runtime_assets() {
  local package_dir=""
  local template_path=""

  package_dir="$(detect_installed_openclaw_package_dir || true)"
  if [[ -z "$package_dir" ]]; then
    log '离线安装完成后未找到全局 openclaw 包目录。'
    return 1
  fi

  template_path="$package_dir/docs/reference/templates/AGENTS.md"
  if [[ ! -f "$template_path" ]]; then
    log "离线安装产物缺少关键模板文件: $template_path"
    return 1
  fi

  return 0
}

node_meets_minimum_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  local raw_version
  raw_version="$(node -v 2>/dev/null | tr -d '\r')"
  raw_version="${raw_version#v}"
  if [[ -z "$raw_version" ]]; then
    return 1
  fi

  local major="${raw_version%%.*}"
  local rest="${raw_version#*.}"
  local minor="${rest%%.*}"
  major="${major:-0}"
  minor="${minor:-0}"

  if (( major > 22 )); then
    return 0
  fi
  if (( major == 22 && minor >= 12 )); then
    return 0
  fi
  return 1
}

activate_bundled_node() {
  if command -v npm >/dev/null 2>&1 && node_meets_minimum_version; then
    return 0
  fi

  if [[ -z "$OFFLINE_BUNDLE_DIR" || ! -d "$OFFLINE_BUNDLE_DIR" ]]; then
    return 1
  fi

  local platform
  local arch
  platform="$(resolve_platform)" || return 1
  arch="$(resolve_arch)" || return 1

  local archive
  archive="$(find "$OFFLINE_BUNDLE_DIR/packages/node" -maxdepth 1 -type f -name "node-v*-${platform}-${arch}.tar.gz" | head -n 1)"
  if [[ -z "$archive" ]]; then
    return 1
  fi

  local extract_dir="$HOME/.openclaw/tooling/node"
  mkdir -p "$extract_dir"

  local archive_name
  archive_name="$(basename "$archive")"
  local node_dir_name="${archive_name%.tar.gz}"
  if [[ ! -d "$extract_dir/$node_dir_name" ]]; then
    tar -xzf "$archive" -C "$extract_dir"
  fi

  local node_dir
  node_dir="$(find "$extract_dir" -maxdepth 1 -type d -name "node-v*-${platform}-${arch}" | head -n 1)"
  if [[ -z "$node_dir" ]]; then
    return 1
  fi

  export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.openclaw/tooling/npm-global}"
  mkdir -p "$NPM_CONFIG_PREFIX/bin"
  export PATH="$node_dir/bin:$NPM_CONFIG_PREFIX/bin:$PATH"
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

install_from_offline_bundle() {
  if [[ -z "$OFFLINE_BUNDLE_DIR" || ! -d "$OFFLINE_BUNDLE_DIR" ]]; then
    return 1
  fi

  activate_bundled_node || true
  if ! command -v npm >/dev/null 2>&1; then
    log '检测到离线包，但当前机器没有可用的 npm，转入脚本安装回退。'
    return 1
  fi

  local tgz_path tgz_name tgz_version
  tgz_path="$(find "$OFFLINE_BUNDLE_DIR/packages/openclaw" -maxdepth 1 -type f -name 'openclaw-*.tgz' | head -n 1)"
  if [[ -z "$tgz_path" ]]; then
    return 1
  fi

  tgz_name="$(basename "$tgz_path")"
  tgz_version="${tgz_name#openclaw-}"
  tgz_version="${tgz_version%.tgz}"
  tgz_version="$(normalize_openclaw_version "$tgz_version")"

  log "使用离线 npm 包安装 OpenClaw CLI: $tgz_path"
  if ! npm install -g --force --ignore-scripts "$tgz_path"; then
    log "离线 npm 包安装失败: $tgz_path"
    return 1
  fi

  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$npm_prefix" && -d "$npm_prefix/bin" ]]; then
    export PATH="$npm_prefix/bin:$PATH"
  fi

  # npm install -g 在某些环境下不会释放 docs/reference/templates/ 目录，
  # 但 gateway 的 workspace-templates 模块在 dispatch 时需要该目录中的
  # AGENTS.md 等模板文件，缺失会导致消息处理失败。
  ensure_openclaw_package_templates "$npm_prefix" "$tgz_path"

  verify_installed_openclaw_version "$tgz_version"
}

main() {
  local installed_version=""
  local target_version=""
  installed_version="$(detect_installed_openclaw_version || true)"
  target_version="$(detect_target_openclaw_version || true)"

  if [[ -n "$installed_version" ]]; then
    if [[ -n "$target_version" ]]; then
      if version_at_least "$installed_version" "$target_version"; then
        log "openclaw 已存在，当前版本 ${installed_version} 已满足目标版本 ${target_version}，跳过 OpenClaw 安装。"
        install_configured_skills
        exit 0
      fi

      log "openclaw 已存在，但当前版本 ${installed_version} 低于目标版本 ${target_version}，继续执行升级安装。"
    else
      log "openclaw 已存在，当前版本 ${installed_version}；未检测到离线目标版本，默认跳过 OpenClaw 安装。"
      install_configured_skills
      exit 0
    fi
  fi

  if install_from_offline_bundle "$@"; then
    log '离线包安装完成，继续安装服务端推荐 skills。'
    install_configured_skills
    exit 0
  fi

  log "下载 OpenClaw 安装脚本: $PRIMARY_INSTALL_URL"
  if download_file "$PRIMARY_INSTALL_URL" "$TMP_DIR/install.sh"; then
    if bash "$TMP_DIR/install.sh" "$@"; then
      log '脚本安装完成。'
      install_configured_skills
      exit 0
    fi
    log "脚本执行失败: $PRIMARY_INSTALL_URL"
  else
    log "下载失败: $PRIMARY_INSTALL_URL"
  fi

  log '在线脚本与离线安装源均失败。'
  exit 1
}

main "$@"