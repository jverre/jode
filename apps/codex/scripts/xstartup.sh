#!/bin/bash
set -euo pipefail

mkdir -p /tmp/codex-rehost
touch /tmp/codex-rehost/electron.exit
XSTARTUP_LOG=/tmp/codex-rehost/xstartup.log
PHASE_LOG=/tmp/codex-rehost/phases.log
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
phase "xstartup:start" "starting Claude app under KasmVNC"
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
} >>/tmp/codex-rehost/electron-version.log 2>&1 || true

{
  echo "[xstartup] ldd electron"
  ldd "$(readlink -f ./node_modules/electron/dist/electron)" || true
} >/tmp/codex-rehost/electron-ldd.log 2>&1

{
  echo "[xstartup] env"
  env | sort
} >/tmp/codex-rehost/environment.log 2>&1

trap 'EXIT_CODE=$?; echo "${EXIT_CODE}" > /tmp/codex-rehost/electron.exit; phase "xstartup:exit" "code=${EXIT_CODE}"; log "electron wrapper exiting with code ${EXIT_CODE}"; exit "${EXIT_CODE}"' EXIT

# --js-flags=--jitless is OFF by default: Cloudflare's firecracker runtime
# supports JIT, and jitless cripples renderer JS (every keystroke re-renders
# React interpreted) which dominates typing latency. Set CODEX_REHOST_JITLESS=1
# only for explicit runtime diagnostics.
JS_FLAGS=""
if [ "${CODEX_REHOST_JITLESS:-0}" = "1" ]; then
  JS_FLAGS="--js-flags=--jitless"
fi

# Anti-throttling flags: in a headless/KasmVNC display Chromium otherwise treats
# the window as backgrounded/occluded and throttles the renderer + timers, which
# reads as sluggish typing/echo. Keep the renderer at full speed.
ANTI_THROTTLE_FLAGS="--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling"

# Software GL (swiftshader) instead of --disable-gpu: Codex's webview probes the
# GPU and busy-loops if GPU access is fully disabled with no rasterizer. swiftshader
# gives a CPU GL implementation so the compositor/WebGL succeed headless.
# CODEX_GL overrides the default (e.g. "disabled" uses --disable-gpu).
case "${CODEX_GL:-swiftshader}" in
  disabled) GL_FLAGS="--disable-gpu" ;;
  *)        GL_FLAGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --disable-gpu-sandbox" ;;
esac
COMMON_FLAGS="--no-sandbox --disable-dev-shm-usage ${GL_FLAGS} ${ANTI_THROTTLE_FLAGS} ${JS_FLAGS}"
log "electron flags: ${COMMON_FLAGS:-<jit-enabled>}"

# Boot mode:
#   bridge → production path: launch the WS relay (/opt/bridge/bridge.cjs).
#   direct → debug only, and requires JODE_DEBUG_BOOT=1.
# shellcheck disable=SC2086
BOOT_MODE="${CODEX_BOOT_MODE:-bridge}"
if [ "${BOOT_MODE}" = "bridge" ]; then
  log "boot mode: bridge — entry /opt/bridge/bridge.cjs (WS /bridge on :${BRIDGE_PORT:-8787})"
  ./node_modules/.bin/electron /opt/bridge/bridge.cjs ${COMMON_FLAGS} >"${REHOST_LOG}" 2>&1 &
else
  if [ "${BOOT_MODE}" != "direct" ] || [ "${JODE_DEBUG_BOOT:-0}" != "1" ]; then
    log "unsupported boot mode '${BOOT_MODE}' (direct requires JODE_DEBUG_BOOT=1)"
    exit 64
  fi
  log "boot mode: direct — launching the Codex app headless (electron . → bootstrap.cjs)"
  ./node_modules/.bin/electron . ${COMMON_FLAGS} >"${REHOST_LOG}" 2>&1 &
fi
ELECTRON_PID=$!
echo "${ELECTRON_PID}" > "${REHOST_PID}"
phase "xstartup:electron-spawned" "pid=${ELECTRON_PID}"
log "spawned electron pid=${ELECTRON_PID}"
wait "${ELECTRON_PID}"
EXIT_CODE=$?
echo "${EXIT_CODE}" > /tmp/codex-rehost/electron.exit
echo "[xstartup] electron exited with code ${EXIT_CODE}" >> "${REHOST_LOG}"
exit "${EXIT_CODE}"
