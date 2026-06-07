FROM --platform=linux/amd64 oven/bun:1-debian

# Runtime deps for the agent: ripgrep (opencode's fast search), git (repo ops),
# ca-certificates, plus zstd + rclone for the R2 workspace sync in entrypoint.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      ripgrep \
      rclone \
      tar \
      zstd \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# The published opencode CLI. Its release binary has the web UI embedded at build
# time (build.ts bakes packages/app/dist into the binary), so this image serves
# UI + API + WebSocket itself — nothing is fetched from app.opencode.ai.
RUN bun add -g opencode-ai@latest
ENV PATH="/root/.bun/bin:${PATH}"
RUN opencode --version

# Project files the agent operates on. Persisted to R2 by the entrypoint.
WORKDIR /workspace

COPY scripts/entrypoint.sh /opt/jode/entrypoint.sh
RUN chmod +x /opt/jode/entrypoint.sh

# opencode serve binds here; the Worker proxies to it.
ENV OPENCODE_PORT=4096
EXPOSE 4096

CMD ["/opt/jode/entrypoint.sh"]
