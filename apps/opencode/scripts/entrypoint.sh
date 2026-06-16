#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Container supervisor for the OpenCode remote environment.
#
#   boot      → FUSE-mount the SHARED jode filesystem (one R2 bucket for all
#               tools — claude-code, opencode, codex) at /workspace
#   serve     → `opencode serve` on :4096 (UI + API + WebSocket, all one origin)
#   shutdown  → unmount so tigrisfs flushes its write-back cache
#
# The mount is live — no snapshots, no checkpoint loops. If R2 creds are absent
# /workspace is a plain local dir and the server still runs (ephemeral).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

log() { echo "[entrypoint] $*"; }

WORKSPACE=/workspace
PORT="${OPENCODE_PORT:-4096}"
mkdir -p "$WORKSPACE"

/opt/jode/mount-workspace.sh || true

# --hostname 0.0.0.0 so the Worker proxy can reach it from outside the container.
log "starting opencode serve on 0.0.0.0:${PORT}"
opencode serve --hostname 0.0.0.0 --port "$PORT" &
SERVER=$!

shutdown() {
  log "signal received; stopping server and unmounting workspace"
  kill -TERM "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  fusermount -u "$WORKSPACE" 2>/dev/null || umount "$WORKSPACE" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait "$SERVER"
