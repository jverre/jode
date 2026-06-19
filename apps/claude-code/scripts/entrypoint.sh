#!/bin/bash
set -euo pipefail

mkdir -p /tmp/claude-rehost
touch /tmp/claude-rehost/electron.exit
ENTRYPOINT_LOG=/tmp/claude-rehost/entrypoint.log
PHASE_LOG=/tmp/claude-rehost/phases.log
STATUS_JSON=/tmp/claude-rehost/status.json
exec > >(tee -a "${ENTRYPOINT_LOG}") 2>&1

log() {
  echo "[entrypoint] $*"
}

phase() {
  local name="$1"
  shift || true
  printf '%s\t%s\t%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "${name}" "$*" | tee -a "${PHASE_LOG}"
}

write_status() {
  cat >"${STATUS_JSON}" <<EOF
{
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "display": "${DISPLAY}",
  "geometry": "${SCREEN_GEOMETRY}",
  "healthPort": "${HEALTH_PORT}",
  "bridgePort": "${BRIDGE_PORT}",
  "rehostRoot": "${REHOST_ROOT}"
}
EOF
}

phase "entrypoint:start" "booting container supervisor"
write_status
ELECTRON_BIN_PATH="$(readlink -f "${REHOST_ROOT}/node_modules/.bin/electron" 2>/dev/null || echo missing)"
ELECTRON_PKG_VERSION="$(node -p "require('${REHOST_ROOT}/node_modules/electron/package.json').version" 2>/dev/null || echo missing)"
APP_PKG_VERSION="$(node -p "require('${REHOST_ROOT}/app/package.json').version" 2>/dev/null || echo missing)"
log "uname=$(uname -a)"
log "node=$(node -v) npm=$(npm -v)"
log "pwd=$(pwd)"
log "rehost_root=${REHOST_ROOT}"
log "display=${DISPLAY} geometry=${SCREEN_GEOMETRY} health_port=${HEALTH_PORT} bridge_port=${BRIDGE_PORT}"
log "electron shim path=${ELECTRON_BIN_PATH}"
log "electron package version=${ELECTRON_PKG_VERSION}"
log "app package version=${APP_PKG_VERSION}"
phase "entrypoint:environment" "versions recorded"

# Mount the SHARED jode filesystem (one R2 bucket, FUSE) at /workspace — all
# tools (claude-code, opencode, codex) see the same live files. No-op (local
# ephemeral dir) when R2 creds are absent.
phase "entrypoint:workspace:mount" "mounting shared R2 filesystem"
MOUNT_LOG_DIR=/tmp/claude-rehost /opt/cloudflare/mount-workspace.sh || true
phase "entrypoint:workspace:done" "mount-workspace finished"

# Restore the persisted Electron profile (the claude.ai session cookies live in
# its session.defaultSession — see bridge.cjs) from the shared workspace (R2) so
# a still-valid login is reused instead of forcing re-auth every boot. MUST run
# before xstartup launches Electron with --user-data-dir on the same path.
# Best-effort: a missing/corrupt snapshot must never block boot. A background
# watcher keeps it fresh; cleanup() takes a final snapshot on shutdown.
phase "entrypoint:creds:restore" "restoring persisted credentials"
/opt/cloudflare/creds-sync.sh restore || true
/opt/cloudflare/creds-sync.sh watch >/tmp/claude-rehost/creds-sync.log 2>&1 &
CREDS_PID=$!
echo "${CREDS_PID}" >/tmp/claude-rehost/creds-sync.pid
phase "entrypoint:creds:watch" "pid=${CREDS_PID}"

log "starting health server"
phase "entrypoint:health-server:start" "launching health server"
node /opt/cloudflare/health-server.mjs >/tmp/claude-rehost/health-server.log 2>&1 &
HEALTH_PID=$!
echo "${HEALTH_PID}" >/tmp/claude-rehost/health-server.pid
log "health server pid=${HEALTH_PID}"
phase "entrypoint:health-server:ready" "pid=${HEALTH_PID}"

# Xvfb: a throwaway in-memory X display so headless Electron can create its
# BrowserWindow (Chromium aborts on Linux with no $DISPLAY). We never read or
# stream these pixels — the bridge relays eipc over WS on :${BRIDGE_PORT} and the
# user's real browser renders the SPA. (Replaced KasmVNC's Xvnc + VNC server.)
log "starting Xvfb on ${DISPLAY} (${SCREEN_GEOMETRY}x24)"
phase "entrypoint:xvfb:start" "launching virtual framebuffer"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}x24" -nolisten tcp >/tmp/claude-rehost/xvfb.log 2>&1 &
XVFB_PID=$!
echo "${XVFB_PID}" >/tmp/claude-rehost/xvfb.pid
log "xvfb pid=${XVFB_PID}"

# Wait for the X socket before launching Electron, else it can race the display.
for _ in $(seq 1 100); do
  [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done
if [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  phase "entrypoint:xvfb:ready" "display ${DISPLAY} up"
else
  phase "entrypoint:xvfb:timeout" "display ${DISPLAY} socket never appeared"
  log "WARNING: Xvfb socket for ${DISPLAY} not found after 10s; launching anyway"
fi

log "starting Electron bridge"
phase "entrypoint:bridge:start" "launching headless Electron + bridge"
/opt/cloudflare/xstartup.sh &
BRIDGE_PID=$!
echo "${BRIDGE_PID}" >/tmp/claude-rehost/bridge.pid
log "bridge pid=${BRIDGE_PID}"
phase "entrypoint:bridge:spawned" "pid=${BRIDGE_PID}"

cleanup() {
  phase "entrypoint:cleanup" "stopping child processes"
  # Final credential snapshot WHILE the mount is still up, then stop the watcher.
  /opt/cloudflare/creds-sync.sh save || true
  kill "${HEALTH_PID}" "${XVFB_PID}" "${BRIDGE_PID}" "${CREDS_PID:-}" 2>/dev/null || true
  # Unmount the shared filesystem so tigrisfs flushes the snapshot we just wrote.
  fusermount -u /workspace 2>/dev/null || umount /workspace 2>/dev/null || true
}

trap cleanup EXIT INT TERM

log "container supervisor running"
phase "entrypoint:supervisor" "waiting on bridge"
while true; do
  if ! kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    set +e
    wait "${BRIDGE_PID}"
    EXIT_CODE=$?
    set -e
    phase "entrypoint:bridge:exit" "code=${EXIT_CODE}"
    echo "[entrypoint] bridge exited with code ${EXIT_CODE}" | tee -a /tmp/claude-rehost/xstartup.log
    # Keep the container alive so logs/diagnostics stay inspectable.
    sleep infinity
  fi
  if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
    phase "entrypoint:xvfb:exit" "Xvfb died — Electron lost its display"
    echo "[entrypoint] Xvfb died; bridge will likely fail" | tee -a /tmp/claude-rehost/xvfb.log
    sleep infinity
  fi
  phase "entrypoint:heartbeat" "bridge-alive"
  sleep 3600
done
