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

# Mount the SHARED jode filesystem (one R2 bucket, FUSE) at /workspace BEFORE
# anything launches. This must succeed.
phase "entrypoint:workspace:mount" "mounting shared R2 filesystem"
MOUNT_LOG_DIR=/tmp/codex-rehost /opt/cloudflare/mount-workspace.sh
phase "entrypoint:workspace:done" "mount-workspace finished"

# Restore persisted auth (~/.codex) from the shared workspace (R2) so a still-valid
# ChatGPT sign-in is reused instead of forcing re-auth every boot. Best-effort: a
# missing/corrupt snapshot must never block boot. A background watcher keeps the
# snapshot fresh; cleanup() takes a final one on clean shutdown.
phase "entrypoint:creds:restore" "restoring persisted credentials"
/opt/cloudflare/creds-sync.sh restore || true
/opt/cloudflare/creds-sync.sh watch >/tmp/codex-rehost/creds-sync.log 2>&1 &
CREDS_PID=$!
echo "${CREDS_PID}" >/tmp/codex-rehost/creds-sync.pid
phase "entrypoint:creds:watch" "pid=${CREDS_PID}"

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
JODE_REHOST_TMP=/tmp/codex-rehost \
JODE_HEALTH_PROCESS_PATTERN="electron|xstartup|kasm|vnc|health-server|node" \
JODE_HEALTH_PIDS="kasmvnc:kasmvnc.pid" \
JODE_HEALTH_LOGS="kasmvnc:kasmvnc.log,kasmUserSetup:kasm-user.log" \
JODE_HEALTH_FILE_CHECKS="appMain:app/.vite/build/bootstrap.js,rendererIndex:app/webview/index.html" \
node /opt/cloudflare/health-server.mjs >/tmp/codex-rehost/health-server.log 2>&1 &
HEALTH_PID=$!
echo "${HEALTH_PID}" >/tmp/codex-rehost/health-server.pid
log "health server pid=${HEALTH_PID}"
phase "entrypoint:health-server:ready" "pid=${HEALTH_PID}"

# OAuth login-callback forwarder: 0.0.0.0:1456 → 127.0.0.1:1455 (the app-server's
# one-shot ChatGPT login server binds loopback only). See login-callback-proxy.mjs.
log "starting login-callback proxy"
node /opt/cloudflare/login-callback-proxy.mjs >/tmp/codex-rehost/login-callback-proxy.log 2>&1 &
LOGIN_PROXY_PID=$!
echo "${LOGIN_PROXY_PID}" >/tmp/codex-rehost/login-callback-proxy.pid
log "login-callback proxy pid=${LOGIN_PROXY_PID}"
phase "entrypoint:login-proxy:ready" "pid=${LOGIN_PROXY_PID}"

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
  # Final credential snapshot WHILE the mount is still up, then stop the watcher.
  /opt/cloudflare/creds-sync.sh save || true
  kill "${HEALTH_PID}" "${KASMVNC_PID}" "${LOGIN_PROXY_PID}" "${CREDS_PID:-}" 2>/dev/null || true
  # Unmount the shared filesystem so tigrisfs flushes its write-back cache.
  fusermount -u /workspace 2>/dev/null || umount /workspace 2>/dev/null || true
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
    if [ "${EXIT_CODE}" -eq 0 ]; then EXIT_CODE=1; fi
    exit "${EXIT_CODE}"
  fi
  phase "entrypoint:heartbeat" "kasmvnc-alive"
  sleep 3600
done
