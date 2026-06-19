# Full (non-slim) bookworm: it ships `ca-certificates` already configured by the
# image publisher (built on real amd64). The slim base does not, so our build had
# to install it — and its postinst's openssl rehash SIGILLs ("Illegal
# instruction") when this image is built under emulated linux/amd64 on an arm64
# host (local `wrangler dev`). Using the full base means we never reconfigure
# ca-certificates, sidestepping that crash while still building cleanly on
# Cloudflare's native amd64 builders.
FROM --platform=linux/amd64 node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Headless Electron is Chromium: it can't create its BrowserWindow on Linux
# without an X display. Xvfb is a throwaway in-memory framebuffer that satisfies
# that — no pixels are ever read or streamed. The bridge serves eipc over WS on
# 8787 and the user's real browser renders the SPA. (Replaced KasmVNC, whose VNC
# server + auth we never used — we only ever needed the display.)
#
# NB: `ca-certificates` is intentionally NOT listed — it comes pre-configured in
# the full base (see FROM note). Adding it back here re-runs its postinst, which
# SIGILLs under the emulated amd64 build.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
  libx11-xcb1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  unzip \
  wget \
  xauth \
  xvfb \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/info/* /usr/share/man/* /usr/share/locale/*

# git for local coding sessions. Kept in its OWN layer so iterating on it doesn't
# invalidate the big X-libs layer above (cache hygiene). The full base may already
# include git, in which case this is a near no-op.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

WORKDIR /opt/claude-rehost

COPY payload/linux-rehost/package.json ./package.json
COPY payload/linux-rehost/ ./
COPY scripts/entrypoint.sh /opt/cloudflare/entrypoint.sh
COPY scripts/health-server.mjs /opt/cloudflare/health-server.mjs
COPY scripts/install-electron-linux.sh /opt/cloudflare/install-electron-linux.sh
COPY scripts/xstartup.sh /opt/cloudflare/xstartup.sh

RUN chmod +x /opt/cloudflare/entrypoint.sh /opt/cloudflare/install-electron-linux.sh /opt/cloudflare/xstartup.sh \
  && npm install --omit=optional \
  && /opt/cloudflare/install-electron-linux.sh /opt/claude-rehost \
  && find node_modules/electron/dist/locales -type f ! -name 'en-US.pak' -delete \
  && npm cache clean --force

# Build toolchain for native modules, in its own layer (cache hygiene — keeps the
# big X-libs layer above from being invalidated when the toolchain changes).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# node-pty terminal (#5): the extracted prebuilt pty.node is Mach-O (macOS). The
# bridge runs node-pty inside the Electron MAIN process, so rebuild it against
# Electron 41's ABI for linux-x64. Non-fatal: a build failure must not break the
# rest of the split (login/bootstrap/session validation still work).
# node-pty (#5): the EXTRACTED package has no source (no binding.gyp/scripts —
# only the macOS prebuilt), so neither `npm rebuild` nor node-gyp can build it.
# Reinstall node-pty fresh (full source) and compile against Electron 41's ABI.
# Non-fatal so a build failure can't break the rest of the split.
RUN mkdir -p /tmp/ptybuild && cd /tmp/ptybuild && npm init -y >/dev/null 2>&1 \
  && (HOME=/root npm_config_runtime=electron npm_config_target=41.6.1 npm_config_arch=x64 \
      npm_config_disturl=https://electronjs.org/headers \
      npm install node-pty@1.1.0-beta34 2>&1 | tail -30 \
      && rm -rf /opt/claude-rehost/app/node_modules/node-pty \
      && cp -r node_modules/node-pty /opt/claude-rehost/app/node_modules/node-pty \
      && echo "[node-pty] built; binary dir:" \
      && (ls -la /opt/claude-rehost/app/node_modules/node-pty/build/Release/ 2>/dev/null \
          || ls -laR /opt/claude-rehost/app/node_modules/node-pty/prebuilds/ 2>/dev/null \
          || echo "NO BINARY")) \
  || echo "[node-pty] INSTALL/BUILD FAILED (terminal unavailable; rest of split unaffected)"

# FUSE + tigrisfs for the SHARED jode filesystem (one R2 bucket mounted live at
# /workspace by every tool — see mount-workspace.sh). Late layer: does NOT touch
# the big cached apt layer (QEMU-fragile — see the ca-certificates note above).
ARG TIGRISFS_VERSION=1.2.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends fuse3 curl \
  && curl -fsSL -o /tmp/tigrisfs.deb "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.deb" \
  && apt-get install -y --no-install-recommends /tmp/tigrisfs.deb \
  && rm -f /tmp/tigrisfs.deb \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
  && tigrisfs --version
COPY scripts/mount-workspace.sh /opt/cloudflare/mount-workspace.sh
RUN chmod +x /opt/cloudflare/mount-workspace.sh

# Bridge server last — iterating on it must not invalidate the npm/electron layer.
# Bump JODE_BRIDGE_REV whenever bridge/ changes must force a new image: wrangler's
# build cache keys off the Dockerfile, so a COPY'd-file edit alone can be reused
# as an unchanged image and never roll the running container. This ENV makes the
# change visible to that cache. (keyless = removed the BRIDGE_KEY gate.)
ENV JODE_BRIDGE_REV=keyless-1
COPY bridge/ /opt/bridge/

ENV CLAUDE_REHOST_FORCE_PLATFORM=linux
ENV CLAUDE_LINUX_REHOST=1
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=true
# NOTE: claude.ai auth is NOT persisted to R2. Persisting the Electron profile
# re-injected a stale session (incl. the IP-bound cf_clearance) on boot, which
# the Worker attached to proxied requests → claude.ai login failures. Correct
# persistence here needs cookie-level filtering (drop cf_clearance + Turnstile,
# keep only the durable session cookie) — deferred. codex/opencode still persist.
# Xvfb virtual display for headless Electron (see entrypoint.sh). DISPLAY is the
# X display number; SCREEN_GEOMETRY sizes the in-memory framebuffer (WxH).
ENV DISPLAY=:1
ENV SCREEN_GEOMETRY=1440x960
ENV HEALTH_PORT=8080
ENV REHOST_ROOT=/opt/claude-rehost
ENV REHOST_LOG=/tmp/claude-rehost/electron.log
ENV REHOST_PID=/tmp/claude-rehost/electron.pid
# Bridge server (UI/server split). No bridge key: the bridge is reachable only
# via the Worker's private DO binding, and the Worker verifies Cloudflare Access
# on every request before relaying — so a separate key was redundant (removed).
ENV BRIDGE_PORT=8787
ENV BRIDGE_APP_HOST=claude.ai
ENV BRIDGE_SENDER_URL=https://claude.ai/

EXPOSE 8080 8787

CMD ["/opt/cloudflare/entrypoint.sh"]
