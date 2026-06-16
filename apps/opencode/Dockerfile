FROM --platform=linux/amd64 oven/bun:1-debian

# Runtime deps for the agent: ripgrep (opencode's fast search), git (repo ops),
# ca-certificates, plus fuse3 + tigrisfs for the SHARED jode filesystem (one R2
# bucket FUSE-mounted at /workspace by every tool — see mount-workspace.sh).
ARG TIGRISFS_VERSION=1.2.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fuse3 \
      git \
      ripgrep \
      tar \
  && curl -fsSL -o /tmp/tigrisfs.deb "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.deb" \
  && apt-get install -y --no-install-recommends /tmp/tigrisfs.deb \
  && rm -f /tmp/tigrisfs.deb \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
  && tigrisfs --version

# The published opencode CLI. Its release binary has the web UI embedded at build
# time (build.ts bakes packages/app/dist into the binary), so this image serves
# UI + API + WebSocket itself — nothing is fetched from app.opencode.ai.
RUN bun add -g opencode-ai@latest
ENV PATH="/root/.bun/bin:${PATH}"
RUN opencode --version

# Project files the agent operates on — the shared R2 filesystem mounts here.
WORKDIR /workspace

COPY scripts/entrypoint.sh /opt/jode/entrypoint.sh
COPY scripts/mount-workspace.sh /opt/jode/mount-workspace.sh
RUN chmod +x /opt/jode/entrypoint.sh /opt/jode/mount-workspace.sh

# opencode serve binds here; the Worker proxies to it.
ENV OPENCODE_PORT=4096
EXPOSE 4096

CMD ["/opt/jode/entrypoint.sh"]
