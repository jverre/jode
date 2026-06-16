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
COPY scripts/install-electron-linux.sh /opt/cloudflare/install-electron-linux.sh

RUN chmod +x /opt/cloudflare/install-electron-linux.sh \
  && npm install --omit=optional \
  && /opt/cloudflare/install-electron-linux.sh /opt/codex-rehost \
  && find node_modules/electron/dist/locales -type f ! -name 'en-US.pak' -delete \
  && npm cache clean --force

# Build toolchain for native modules, in its own layer (keeps the big apt layer
# cached; that layer's ca-certificates postinst SIGILLs under QEMU if rebuilt).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Native modules (better-sqlite3, node-pty): the extracted app.asar.unpacked only
# carries macOS prebuilts (Mach-O), so rebuild both for the Linux Electron 42 ABI.
# Recipe ported from ilysenko/codex-desktop-linux (the project that runs this app
# on Linux): install FRESH sources at the versions the app bundles, PATCH
# better-sqlite3 for V8 14's external-pointer API (released versions don't compile
# against Electron 42 otherwise), then build with @electron/rebuild.
ENV ELECTRON_TARGET=42.1.0
COPY scripts/patch-better-sqlite3.cjs /opt/cloudflare/patch-better-sqlite3.cjs
RUN set -eux; cd /tmp && mkdir -p natbuild && cd natbuild && echo '{"private":true}' > package.json \
  && BS3_VER="$(node -p "require('/opt/codex-rehost/app/node_modules/better-sqlite3/package.json').version")" \
  && NPTY_VER="$(node -p "require('/opt/codex-rehost/app/node_modules/node-pty/package.json').version")" \
  && echo "[native] target electron=${ELECTRON_TARGET} better-sqlite3=${BS3_VER} node-pty=${NPTY_VER}" \
  && npm install "electron@${ELECTRON_TARGET}" "@electron/rebuild@4.0.4" "node-abi@^4.31.0" --save-dev --ignore-scripts 2>&1 | tail -3 \
  && npm install "better-sqlite3@${BS3_VER}" "node-pty@${NPTY_VER}" --ignore-scripts 2>&1 | tail -3 \
  && node /opt/cloudflare/patch-better-sqlite3.cjs /tmp/natbuild/node_modules/better-sqlite3 \
  && node node_modules/@electron/rebuild/lib/cli.js -v "${ELECTRON_TARGET}" --force \
       --dist-url https://electronjs.org/headers 2>&1 | tail -15 \
  && for name in better-sqlite3 node-pty; do \
       find "node_modules/${name}" -name '*.node' | grep -q . || { echo "[native] ${name} produced NO .node"; exit 1; }; \
       rm -rf "/opt/codex-rehost/app/node_modules/${name}"; \
       cp -r "node_modules/${name}" "/opt/codex-rehost/app/node_modules/${name}"; \
       find "/opt/codex-rehost/app/node_modules/${name}/build" -type f ! -name '*.node' -delete 2>/dev/null || true; \
       echo "[native] ${name} OK:"; find "/opt/codex-rehost/app/node_modules/${name}" -name '*.node'; \
     done \
  && rm -rf /tmp/natbuild

# FUSE + tigrisfs for the SHARED jode filesystem (one R2 bucket mounted live at
# /workspace by every tool — see mount-workspace.sh). Its own late layer: does
# NOT touch the big cached apt layer (whose ca-certificates postinst SIGILLs
# under QEMU if re-run). Cloudflare Containers support FUSE natively.
ARG TIGRISFS_VERSION=1.2.1
RUN apt-get update \
  && wget -qO /tmp/tigrisfs.deb "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.deb" \
  && apt-get install -y --no-install-recommends fuse3 /tmp/tigrisfs.deb \
  && rm -f /tmp/tigrisfs.deb \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
  && tigrisfs --version

# Runtime scripts in a LATE layer — iterating on the supervisor/bridge must not
# invalidate the npm/electron/native-rebuild layers above.
COPY scripts/entrypoint.sh /opt/cloudflare/entrypoint.sh
COPY scripts/xstartup.sh /opt/cloudflare/xstartup.sh
COPY scripts/health-server.mjs /opt/cloudflare/health-server.mjs
COPY scripts/login-callback-proxy.mjs /opt/cloudflare/login-callback-proxy.mjs
COPY scripts/mount-workspace.sh /opt/cloudflare/mount-workspace.sh
RUN chmod +x /opt/cloudflare/entrypoint.sh /opt/cloudflare/xstartup.sh /opt/cloudflare/mount-workspace.sh

# Bridge server last — iterating on it must not invalidate the npm/electron layer.
# Codex bundles `ws` into its vite build, so it's not a standalone module in the
# payload — install it alongside the bridge (bridge.cjs requires it from here).
COPY bridge/ /opt/bridge/
RUN cd /opt/bridge && npm init -y >/dev/null 2>&1 && npm install ws@8 >/dev/null 2>&1 \
  && node -e "require('/opt/bridge/node_modules/ws'); console.log('[bridge] ws installed')"

ENV CODEX_REHOST_FORCE_PLATFORM=linux
ENV CODEX_LINUX_REHOST=1
# The app resolves its agent backend (the codex rust app-server) via CODEX_CLI_PATH.
# Point it at the native binary inside the globally-installed @openai/codex package
# (the `codex` on PATH is only a JS wrapper). Without this the app shows
# "Codex failed to start. Unable to locate the Codex CLI binary."
ENV CODEX_CLI_PATH=/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
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
ENV CODEX_BOOT_MODE=bridge
ENV BRIDGE_PORT=8787
ENV BRIDGE_APP_HOST=chatgpt.com
ENV BRIDGE_SENDER_URL=https://chatgpt.com/

# 1456 = OAuth login-callback forwarder (publish as -p 1455:1456 so the ChatGPT
# sign-in redirect to http://localhost:1455/auth/callback reaches the app-server).
EXPOSE 6901 8080 8787 1456

CMD ["/opt/cloudflare/entrypoint.sh"]
