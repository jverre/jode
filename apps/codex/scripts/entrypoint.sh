#!/bin/bash
set -euo pipefail

mkdir -p /tmp/codex-rehost
touch /tmp/codex-rehost/electron.exit
ENTRYPOINT_LOG=/tmp/codex-rehost/entrypoint.log
PHASE_LOG=/tmp/codex-rehost/phases.log
STATUS_JSON=/tmp/codex-rehost/status.json
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
  "display": "${KASMVNC_DISPLAY}",
  "geometry": "${KASMVNC_GEOMETRY}",
  "healthPort": "${HEALTH_PORT}",
  "kasmPort": "${KASMVNC_PORT}",
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
log "display=${KASMVNC_DISPLAY} geometry=${KASMVNC_GEOMETRY} health_port=${HEALTH_PORT} kasm_port=${KASMVNC_PORT}"
log "electron shim path=${ELECTRON_BIN_PATH}"
log "electron package version=${ELECTRON_PKG_VERSION}"
log "app package version=${APP_PKG_VERSION}"
phase "entrypoint:environment" "versions recorded"

mkdir -p /root/.vnc
chmod 700 /root/.vnc

cat >/root/.vnc/kasmvnc.yaml <<EOF
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${KASMVNC_PORT}
  use_ipv4: true
  use_ipv6: false
  ssl:
    require_ssl: false
desktop:
  resolution:
    width: ${KASMVNC_GEOMETRY%x*}
    height: ${KASMVNC_GEOMETRY#*x}
  allow_resize: true
  pixel_depth: 24
runtime_configuration:
  allow_client_to_override_kasm_server_settings: true
server:
  auto_shutdown:
    no_user_session_timeout: never
    active_user_session_timeout: never
    inactive_user_session_timeout: never
command_line:
  prompt: false
EOF
phase "entrypoint:kasm-config" "wrote /root/.vnc/kasmvnc.yaml"

if [ ! -f /root/.kasmpasswd ]; then
  printf '%s\n%s\n' "${KASMVNC_PASSWORD}" "${KASMVNC_PASSWORD}" | vncpasswd -u "${KASMVNC_USER}" -ow >/tmp/codex-rehost/kasm-user.log 2>&1
fi
phase "entrypoint:kasm-auth" "credentials prepared for ${KASMVNC_USER}"

log "starting health server"
phase "entrypoint:health-server:start" "launching health server"
node /opt/cloudflare/health-server.mjs >/tmp/codex-rehost/health-server.log 2>&1 &
HEALTH_PID=$!
echo "${HEALTH_PID}" >/tmp/codex-rehost/health-server.pid
log "health server pid=${HEALTH_PID}"
phase "entrypoint:health-server:ready" "pid=${HEALTH_PID}"

log "starting KasmVNC session"
phase "entrypoint:kasmvnc:start" "launching VNC server"
vncserver "${KASMVNC_DISPLAY}" \
  -fg \
  -autokill \
  -geometry "${KASMVNC_GEOMETRY}" \
  -depth 24 \
  -FrameRate "${KASMVNC_FRAMERATE:-60}" \
  -xstartup /opt/cloudflare/xstartup.sh >/tmp/codex-rehost/kasmvnc.log 2>&1 &
KASMVNC_PID=$!
echo "${KASMVNC_PID}" >/tmp/codex-rehost/kasmvnc.pid
log "kasmvnc pid=${KASMVNC_PID}"
phase "entrypoint:kasmvnc:spawned" "pid=${KASMVNC_PID}"

cleanup() {
  phase "entrypoint:cleanup" "stopping child processes"
  kill "${HEALTH_PID}" "${KASMVNC_PID}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

log "container supervisor running"
phase "entrypoint:supervisor" "waiting on kasmvnc"
while true; do
  if ! kill -0 "${KASMVNC_PID}" 2>/dev/null; then
    set +e
    wait "${KASMVNC_PID}"
    EXIT_CODE=$?
    set -e
    phase "entrypoint:kasmvnc:exit" "code=${EXIT_CODE}"
    echo "[entrypoint] kasmvnc exited with code ${EXIT_CODE}" | tee -a /tmp/codex-rehost/kasmvnc.log
    sleep infinity
  fi
  phase "entrypoint:heartbeat" "kasmvnc-alive"
  sleep 3600
done
