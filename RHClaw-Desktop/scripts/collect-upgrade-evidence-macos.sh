#!/usr/bin/env bash
set -euo pipefail

STAGE="${1:-}"

if [[ -z "$STAGE" ]]; then
  echo "usage: bash scripts/collect-upgrade-evidence-macos.sh <before|after-upgrade|after-rollback>" >&2
  exit 1
fi

case "$STAGE" in
  before|after-upgrade|after-rollback)
    ;;
  *)
    echo "unsupported stage: $STAGE" >&2
    exit 1
    ;;
esac

EVIDENCE_DIR="${RHOPENCLAW_EVIDENCE_DIR:-$HOME/Desktop/rhclaw-desktop-rollback-evidence/macos}"
DATA_DIR="${RHOPENCLAW_DATA_DIR:-$HOME/Library/Application Support/RHOpenClaw}"
APP_PATH="${RHOPENCLAW_DESKTOP_APP_PATH:-/Applications/RHOpenClaw Desktop.app}"

mkdir -p "$EVIDENCE_DIR"

capture_command() {
  local output_file="$1"
  shift

  if "$@" >"$output_file" 2>&1; then
    return 0
  fi

  {
    echo '{'
    echo '  "ok": false,'
    printf '  "command": %q,\n' "$*"
    echo '  "note": "command failed; see captured stderr above"'
    echo '}'
  } >>"$output_file"
}

if [[ "$STAGE" == "before" || ! -f "$EVIDENCE_DIR/machine-info.txt" ]]; then
  {
    echo '=== collected_at ==='
    date -u '+%Y-%m-%dT%H:%M:%SZ'
    echo
    echo '=== sw_vers ==='
    sw_vers
    echo
    echo '=== uname -a ==='
    uname -a
    echo
    echo '=== arch ==='
    uname -m
  } >"$EVIDENCE_DIR/machine-info.txt"
fi

if [[ -d "$APP_PATH" ]]; then
  APP_VERSION="$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  APP_BUILD="$(defaults read "$APP_PATH/Contents/Info" CFBundleVersion 2>/dev/null || true)"
else
  APP_VERSION="missing"
  APP_BUILD="missing"
fi

{
  echo "stage=$STAGE"
  echo "collected_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "app_path=$APP_PATH"
  echo "app_version=$APP_VERSION"
  echo "app_build=$APP_BUILD"
  echo "data_dir=$DATA_DIR"
} >"$EVIDENCE_DIR/$STAGE-desktop-version.txt"

if [[ -d "$DATA_DIR" ]]; then
  find "$DATA_DIR" -maxdepth 4 -print | sort >"$EVIDENCE_DIR/$STAGE-files.txt"
else
  printf 'missing data dir: %s\n' "$DATA_DIR" >"$EVIDENCE_DIR/$STAGE-files.txt"
fi

capture_command "$EVIDENCE_DIR/$STAGE-runtime-health.json" curl --noproxy '*' -sS http://127.0.0.1:18789/health

if command -v openclaw >/dev/null 2>&1; then
  capture_command "$EVIDENCE_DIR/$STAGE-gateway-status.json" openclaw gateway status --json
else
  printf '{\n  "ok": false,\n  "note": "openclaw command not found"\n}\n' >"$EVIDENCE_DIR/$STAGE-gateway-status.json"
fi

echo "collected evidence for stage '$STAGE' into $EVIDENCE_DIR"