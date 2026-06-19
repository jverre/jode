#!/bin/bash
set -uo pipefail

log() { echo "[mount-workspace] $*"; }

WORKSPACE="${JODE_WORKSPACE_ROOT:-/workspace}"
LOG_DIR="${MOUNT_LOG_DIR:-/tmp}"
mkdir -p "$WORKSPACE" "$LOG_DIR"

fatal() {
  local reason="$1"
  log "FATAL: ${reason}; refusing to run without mounted /workspace"
  exit 1
}

if [ -z "${R2_ENDPOINT:-}" ] || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  fatal "R2 workspace config is incomplete"
fi
if ! command -v tigrisfs >/dev/null 2>&1; then
  fatal "tigrisfs is not installed"
fi
if [ ! -e /dev/fuse ]; then
  fatal "no /dev/fuse available"
fi
if grep -qs "$WORKSPACE fuse" /proc/mounts; then
  log "already mounted"
  exit 0
fi

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

log "mounting ${R2_BUCKET} at ${WORKSPACE} (endpoint ${R2_ENDPOINT})"
tigrisfs --endpoint "$R2_ENDPOINT" --stat-cache-ttl 5s -f "$R2_BUCKET" "$WORKSPACE" >"$LOG_DIR/tigrisfs.log" 2>&1 &
echo $! >"$LOG_DIR/tigrisfs.pid"

for _ in $(seq 1 20); do
  if grep -qs "$WORKSPACE" /proc/mounts; then
    log "mounted (pid $(cat "$LOG_DIR/tigrisfs.pid"))"
    exit 0
  fi
  kill -0 "$(cat "$LOG_DIR/tigrisfs.pid")" 2>/dev/null || break
  sleep 0.5
done

fatal "mount failed ($(tail -2 "$LOG_DIR/tigrisfs.log" 2>/dev/null | tr '\n' ' '))"
