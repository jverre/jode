#!/bin/bash
set -euo pipefail

mkdir -p /tmp/claude-rehost
touch /tmp/claude-rehost/electron.exit
XSTARTUP_LOG=/tmp/claude-rehost/xstartup.log
PHASE_LOG=/tmp/claude-rehost/phases.log
exec > >(tee -a "${XSTARTUP_LOG}") 2>&1

log() {
  echo "[xstartup] $*"
}

phase() {
  local name="$1"
  shift || true
  printf '%s\t%s\t%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "${name}" "$*" | tee -a "${PHASE_LOG}"
}

cd "${REHOST_ROOT}"
ELECTRON_BIN_PATH="$(readlink -f ./node_modules/.bin/electron 2>/dev/null || echo missing)"
ELECTRON_PKG_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || echo missing)"
APP_PKG_VERSION="$(node -p "require('./app/package.json').version" 2>/dev/null || echo missing)"
phase "xstartup:start" "starting headless Electron bridge"
log "pwd=$(pwd)"
log "display=${DISPLAY:-unset}"
log "rehost_root=${REHOST_ROOT}"
log "electron_log=${REHOST_LOG}"
log "electron_pid_file=${REHOST_PID}"
log "node=$(node -v)"
log "electron_cli=${ELECTRON_BIN_PATH}"
log "electron_pkg_version=${ELECTRON_PKG_VERSION}"
log "app_pkg_version=${APP_PKG_VERSION}"
log "bootstrap_exists=$(test -f ./bootstrap.cjs && echo yes || echo no)"
log "main_exists=$(test -f ./app/.vite/build/index.pre.js && echo yes || echo no)"
log "renderer_exists=$(test -f ./app/resources/ion-dist/index.html && echo yes || echo no)"
phase "xstartup:preflight" "recorded binary and bundle state"

{
  echo "[xstartup] electron --version"
  ./node_modules/.bin/electron --version
} >>/tmp/claude-rehost/electron-version.log 2>&1 || true

{
  echo "[xstartup] ldd electron"
  ldd "$(readlink -f ./node_modules/electron/dist/electron)" || true
} >/tmp/claude-rehost/electron-ldd.log 2>&1

{
  echo "[xstartup] env"
  env | sort
} >/tmp/claude-rehost/environment.log 2>&1

trap 'EXIT_CODE=$?; echo "${EXIT_CODE}" > /tmp/claude-rehost/electron.exit; phase "xstartup:exit" "code=${EXIT_CODE}"; log "electron wrapper exiting with code ${EXIT_CODE}"; exit "${EXIT_CODE}"' EXIT

# --js-flags=--jitless is OFF by default: Cloudflare's firecracker runtime
# supports JIT, and jitless cripples renderer JS (every keystroke re-renders
# React interpreted) which dominates typing latency. Set CLAUDE_REHOST_JITLESS=1
# to re-enable as a fallback if CF boot regresses.
JS_FLAGS=""
if [ "${CLAUDE_REHOST_JITLESS:-0}" = "1" ]; then
  JS_FLAGS="--js-flags=--jitless"
fi

# Anti-throttling flags: in a headless/Xvfb display Chromium otherwise treats
# the window as backgrounded/occluded and throttles the renderer + timers, which
# reads as sluggish typing/echo. Keep the renderer at full speed.
ANTI_THROTTLE_FLAGS="--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling"

# Pin Electron's profile (userData) to a FIXED, known path so creds-sync.sh can
# snapshot/restore it across container reboots — the claude.ai session lives in
# this profile's session.defaultSession cookie store (see bridge.cjs). Electron
# honors the --user-data-dir Chromium switch regardless of the main script.
# On restore the stale, IP-bound cf_clearance is harmless: bridge.cjs re-clears
# Turnstile from the new container IP on boot and overwrites it, while the durable
# claude.ai/claude.com session cookie persists → already logged in.
PROFILE_DIR="${CLAUDE_PROFILE_DIR:-/root/.jode-profile}"
mkdir -p "${PROFILE_DIR}"
PROFILE_FLAG="--user-data-dir=${PROFILE_DIR}"

log "electron flags: ${PROFILE_FLAG} --no-sandbox --disable-dev-shm-usage --disable-gpu ${ANTI_THROTTLE_FLAGS} ${JS_FLAGS:-<jit-enabled>}"
log "bridge entry: /opt/bridge/bridge.cjs (UI/server split — exposes eipc handlers over WS on :${BRIDGE_PORT:-8787})"
# UI/server split: run the bridge server (real Electron main headless under the
# Xvfb display) instead of a VNC-rendered app. bridge.cjs requires
# bootstrap.cjs from REHOST_ROOT and hosts HTTP /healthz + WS /bridge on 8787.
# shellcheck disable=SC2086
./node_modules/.bin/electron /opt/bridge/bridge.cjs "${PROFILE_FLAG}" --no-sandbox --disable-dev-shm-usage --disable-gpu ${ANTI_THROTTLE_FLAGS} ${JS_FLAGS} >"${REHOST_LOG}" 2>&1 &
ELECTRON_PID=$!
echo "${ELECTRON_PID}" > "${REHOST_PID}"
phase "xstartup:electron-spawned" "pid=${ELECTRON_PID}"
log "spawned electron pid=${ELECTRON_PID}"
wait "${ELECTRON_PID}"
EXIT_CODE=$?
echo "${EXIT_CODE}" > /tmp/claude-rehost/electron.exit
echo "[xstartup] electron exited with code ${EXIT_CODE}" >> "${REHOST_LOG}"
exit "${EXIT_CODE}"
