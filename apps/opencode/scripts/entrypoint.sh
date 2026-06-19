#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Container supervisor for the OpenCode remote environment.
#
#   boot      → FUSE-mount the SHARED jode filesystem (one R2 bucket for all
#               tools — claude-code, opencode, codex) at /workspace
#   serve     → `opencode serve` on :4096 (UI + API + WebSocket, all one origin)
#   shutdown  → unmount so tigrisfs flushes its write-back cache
#
# The mount is live — no snapshots, no checkpoint loops. The container fails if
# the mount cannot start.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

log() { echo "[entrypoint] $*"; }

WORKSPACE=/workspace
PORT="${OPENCODE_PORT:-4096}"
mkdir -p "$WORKSPACE"

/opt/jode/mount-workspace.sh

# Restore persisted opencode auth (~/.local/share/opencode) from the shared
# workspace (R2) so credentials survive container recycling instead of forcing a
# re-login every boot. Best-effort — a missing/corrupt snapshot must not block
# boot. A background watcher keeps it fresh; shutdown() takes a final snapshot.
/opt/jode/creds-sync.sh restore || true
/opt/jode/creds-sync.sh watch >/tmp/creds-sync.log 2>&1 &
CREDS=$!

# --hostname 0.0.0.0 so the Worker proxy can reach it from outside the container.
log "starting opencode serve on 0.0.0.0:${PORT}"
opencode serve --hostname 0.0.0.0 --port "$PORT" &
SERVER=$!

shutdown() {
  log "signal received; stopping server and unmounting workspace"
  # Final credential snapshot WHILE the mount is still up, then stop the watcher.
  /opt/jode/creds-sync.sh save || true
  kill "$CREDS" 2>/dev/null || true
  kill -TERM "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  fusermount -u "$WORKSPACE" 2>/dev/null || umount "$WORKSPACE" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait "$SERVER"
