FROM --platform=linux/amd64 node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ARG KASMVNC_VERSION=1.4.0

# Same proven base as @jode/claude-code: KasmVNC's Xvnc provides the X display the
# headless Electron needs. We do NOT serve VNC pixels (port 6901 unexposed) — the
# bridge serves eipc over WS on 8787 and the browser renders the SPA (webview/).
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  dbus-x11 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatspi2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnss3 \
  libpangocairo-1.0-0 \
  libsecret-1-0 \
  libx11-xcb1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  unzip \
  wget \
  xauth \
  && wget -qO /tmp/kasmvncserver.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb" \
  && apt-get install -y /tmp/kasmvncserver.deb \
  && rm -f /tmp/kasmvncserver.deb \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/info/* /usr/share/man/* /usr/share/locale/*

# git for local coding sessions, in its OWN layer so the big apt layer above stays
# cached (rebuilding it under QEMU re-triggers a ca-certificates dpkg
# Illegal-instruction failure). ca-certificates is already configured, so this
# small install avoids that postinst.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# The codex CLI (rust). The Codex desktop app spawns `codex` as its "app-server"
# (the app.asar references bin/codex / app-server / codex-cli), so it must be on
# PATH. Installed via npm so the version is pinnable; non-fatal if it fails so the
# rest of the image still builds (the app boot can be diagnosed independently).
RUN npm install -g @openai/codex@latest 2>&1 | tail -5 \
  && (codex --version || echo "[codex-cli] not runnable yet — verify at boot") \
  || echo "[codex-cli] INSTALL FAILED (will diagnose at boot)"

WORKDIR /opt/codex-rehost

COPY payload/linux-rehost/package.json ./package.json
COPY payload/linux-rehost/ ./
COPY scripts/entrypoint.sh /opt/cloudflare/entrypoint.sh
COPY scripts/health-server.mjs /opt/cloudflare/health-server.mjs
COPY scripts/install-electron-linux.sh /opt/cloudflare/install-electron-linux.sh
COPY scripts/xstartup.sh /opt/cloudflare/xstartup.sh

RUN chmod +x /opt/cloudflare/entrypoint.sh /opt/cloudflare/install-electron-linux.sh /opt/cloudflare/xstartup.sh \
  && npm install --omit=optional \
  && /opt/cloudflare/install-electron-linux.sh /opt/codex-rehost \
  && find node_modules/electron/dist/locales -type f ! -name 'en-US.pak' -delete \
  && npm cache clean --force

# Build toolchain for native modules, in its own layer (keeps the big apt layer
# cached; that layer's ca-certificates postinst SIGILLs under QEMU if rebuilt).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Native modules: the extracted app.asar.unpacked carries macOS prebuilts for
# node-pty + better-sqlite3. Rebuild both fresh against Electron 42.1.0's ABI for
# linux-x64. The extracted packages may lack source (prebuilt-only), so reinstall
# from the registry and copy the freshly built binary into the payload's
# node_modules. Non-fatal: a build failure must not block diagnosing the app boot.
ENV ELECTRON_TARGET=42.1.0
RUN mkdir -p /tmp/natbuild && cd /tmp/natbuild && npm init -y >/dev/null 2>&1 \
  && for pkg in "node-pty@1.1.0-beta34" "better-sqlite3@12.9.0"; do \
       name="${pkg%@*}"; \
       echo "[native] building ${pkg} for electron ${ELECTRON_TARGET}"; \
       (HOME=/root npm_config_runtime=electron npm_config_target="${ELECTRON_TARGET}" npm_config_arch=x64 \
          npm_config_disturl=https://electronjs.org/headers \
          npm install --build-from-source "${pkg}"; \
        if [ -d "node_modules/${name}" ] && find "node_modules/${name}" -name '*.node' | grep -q .; then \
          rm -rf "/opt/codex-rehost/app/node_modules/${name}"; \
          cp -r "node_modules/${name}" "/opt/codex-rehost/app/node_modules/${name}"; \
          echo "[native] ${name} OK:"; find "/opt/codex-rehost/app/node_modules/${name}" -name '*.node'; \
        else \
          echo "[native] ${name} BUILD FAILED — leaving existing module in place (lazy-loaded; diagnose separately)"; \
        fi) \
       || echo "[native] ${name} step errored (non-fatal)"; \
     done

# Bridge server last — iterating on it must not invalidate the npm/electron layer.
# NOTE: bridge/bridge.cjs is currently the Claude relay; for Codex the default
# boot mode launches the app DIRECTLY (CODEX_BOOT_MODE=direct) to prove the
# headless boot first. The bridge relay for Codex's webview/app-server IPC is a
# follow-up (see plan 04 / apps/codex/README.md).
COPY bridge/ /opt/bridge/

ENV CODEX_REHOST_FORCE_PLATFORM=linux
ENV CODEX_LINUX_REHOST=1
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=true
ENV KASMVNC_PORT=6901
ENV KASMVNC_DISPLAY=:1
ENV KASMVNC_GEOMETRY=1440x960
ENV KASMVNC_USER=codex
ENV KASMVNC_PASSWORD=codex123
ENV HEALTH_PORT=8080
ENV REHOST_ROOT=/opt/codex-rehost
ENV REHOST_LOG=/tmp/codex-rehost/electron.log
ENV REHOST_PID=/tmp/codex-rehost/electron.pid
# Boot mode: "direct" launches `electron .` (bootstrap.cjs → Codex main) to verify
# the headless boot. "bridge" launches the WS relay (Codex bridge — WIP).
ENV CODEX_BOOT_MODE=direct
ENV BRIDGE_PORT=8787
ENV BRIDGE_APP_HOST=chatgpt.com
ENV BRIDGE_SENDER_URL=https://chatgpt.com/

EXPOSE 6901 8080 8787

CMD ["/opt/cloudflare/entrypoint.sh"]
