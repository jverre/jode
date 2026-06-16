#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# mount-workspace.sh — mount the SHARED jode filesystem at /workspace.
#
# ONE REMOTE COMPUTER: every jode tool (claude-code, opencode, codex) FUSE-mounts
# the SAME R2 bucket at /workspace, so the user sees the same live files in every
# agent. No snapshots, no sync loops — the bucket IS the filesystem (tigrisfs).
#
# Cloud: Cloudflare Containers support FUSE natively (see
# developers.cloudflare.com/containers/examples/r2-fuse-mount/). Creds arrive as
# Worker-injected env vars (R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
# / R2_BUCKET).
# Local dev, standalone docker (the dev-proxy flow): works against MinIO or real
# R2 — the container needs `--device /dev/fuse --cap-add SYS_ADMIN`.
# Local dev, `wrangler dev`: FUSE does NOT work — wrangler launches local
# containers without /dev/fuse or SYS_ADMIN and offers no way to pass docker
# flags. This script detects that and degrades to a local ephemeral /workspace.
#
# If creds are absent, /workspace is just a local (ephemeral) directory and the
# app still runs. Identical copies of this script live in apps/{claude-code,
# opencode,codex}/scripts/ — keep them in sync.
#
# Write-back caveat: tigrisfs flushes asynchronously. A clean unmount (the
# entrypoints do this on SIGTERM) flushes everything; a hard kill can drop the
# last few seconds of writes.
#
# Caveat: object storage is not POSIX — fine for repos/files, but don't put
# sqlite databases or lock-heavy workloads on it (app state stays on local disk).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

log() { echo "[mount-workspace] $*"; }

WORKSPACE=/workspace
mkdir -p "$WORKSPACE"

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_ENDPOINT:-}" ]; then
  log "R2 not configured; /workspace is local and ephemeral"
  exit 0
fi
if ! command -v tigrisfs >/dev/null 2>&1; then
  log "tigrisfs not installed; /workspace is local and ephemeral"
  exit 0
fi
if [ ! -e /dev/fuse ]; then
  log "no /dev/fuse — under \`wrangler dev\` FUSE is unavailable (no SYS_ADMIN/device passthrough); /workspace is local and ephemeral. Use the standalone docker flow (--device /dev/fuse --cap-add SYS_ADMIN) or deploy."
  exit 0
fi
if grep -qs "$WORKSPACE fuse" /proc/mounts; then
  log "already mounted"
  exit 0
fi

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
BUCKET="${R2_BUCKET:-jode-workspace}"

log "mounting ${BUCKET} at ${WORKSPACE} (endpoint ${R2_ENDPOINT})"
# -f keeps tigrisfs in the foreground so the supervisor sees it die; backgrounded
# here, its log goes to the container log dir.
# --stat-cache-ttl 5s (default 1m): several tools mount this bucket at once —
# short metadata caching keeps another tool's writes visible within seconds.
LOG_DIR="${MOUNT_LOG_DIR:-/tmp}"
tigrisfs --endpoint "$R2_ENDPOINT" --stat-cache-ttl 5s -f "$BUCKET" "$WORKSPACE" >"$LOG_DIR/tigrisfs.log" 2>&1 &
echo $! >"$LOG_DIR/tigrisfs.pid"

for i in $(seq 1 20); do
  if grep -qs "$WORKSPACE" /proc/mounts; then
    log "mounted (pid $(cat "$LOG_DIR/tigrisfs.pid"))"
    exit 0
  fi
  kill -0 "$(cat "$LOG_DIR/tigrisfs.pid")" 2>/dev/null || break
  sleep 0.5
done
log "MOUNT FAILED — /workspace is local and ephemeral ($(tail -2 "$LOG_DIR/tigrisfs.log" 2>/dev/null | tr '\n' ' '))"
exit 0
