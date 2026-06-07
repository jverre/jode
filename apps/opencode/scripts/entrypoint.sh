#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Container supervisor for the OpenCode remote environment.
#
#   boot      → if a snapshot exists in R2, hydrate it into /workspace
#   running   → checkpoint /workspace to R2 every CHECKPOINT_INTERVAL seconds
#   shutdown  → on SIGTERM/SIGINT, do a final checkpoint, then stop the server
#   serve     → `opencode serve` on :4096 (UI + API + WebSocket, all one origin)
#
# R2 is reached over its S3-compatible API with rclone, configured entirely from
# env vars injected by the Worker (see src/index.ts). If R2 creds are absent the
# workspace is simply ephemeral and the server still runs.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

log() { echo "[entrypoint] $*"; }

WORKSPACE=/workspace
PORT="${OPENCODE_PORT:-4096}"
mkdir -p "$WORKSPACE"

r2_enabled() { [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_ENDPOINT:-}" ]; }

# rclone reads these RCLONE_CONFIG_R2_* env vars as a remote named "R2" — no
# config file needed.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENV_AUTH=false
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-}"
export RCLONE_CONFIG_R2_ACL=private

SNAPSHOT="R2:${R2_BUCKET:-jode-opencode-workspace}/${WORKSPACE_KEY:-default/workspace.tar.zst}"

hydrate() {
  if ! r2_enabled; then log "R2 not configured; ephemeral workspace"; return 0; fi
  if rclone lsf "$SNAPSHOT" >/dev/null 2>&1; then
    log "hydrating workspace from $SNAPSHOT"
    if rclone cat "$SNAPSHOT" | tar -I zstd -xf - -C "$WORKSPACE"; then
      log "hydrate ok"
    else
      log "hydrate failed (continuing with empty workspace)"
    fi
  else
    log "no snapshot at $SNAPSHOT; starting fresh"
  fi
}

checkpoint() {
  r2_enabled || return 0
  log "checkpointing workspace -> $SNAPSHOT"
  # Stream tar|zstd straight into R2; avoids needing 2x disk for a temp file.
  if tar -I zstd -cf - -C "$WORKSPACE" . | rclone rcat "$SNAPSHOT"; then
    log "checkpoint ok"
  else
    log "checkpoint failed"
  fi
}

hydrate

# Periodic checkpoint loop in the background.
INTERVAL="${CHECKPOINT_INTERVAL:-300}"
( while true; do sleep "$INTERVAL"; checkpoint; done ) &
CHECKPOINTER=$!

# --hostname 0.0.0.0 so the Worker proxy can reach it from outside the container.
log "starting opencode serve on 0.0.0.0:${PORT}"
opencode serve --hostname 0.0.0.0 --port "$PORT" &
SERVER=$!

shutdown() {
  log "signal received; final checkpoint then stop"
  kill "$CHECKPOINTER" 2>/dev/null || true
  checkpoint
  kill -TERM "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait "$SERVER"
