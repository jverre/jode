# @jode/opencode — remote environment for OpenCode (plan 02)

Worker → Durable Object → Container stack that runs **OpenCode** in a Cloudflare
container and serves its web UI to the browser. Sibling of
[`@jode/claude-code`](../claude-code) (which does the same for Claude Code) and the
same Zero Trust model. See
[`../../plans/june-2026/02-cloudflare-claude-code.md`](../../plans/june-2026/02-cloudflare-claude-code.md).

## Why this one is simpler than the Claude Code app

Claude Code has no headless server, so `@jode/claude-code` rehosts the **Electron
desktop app** under KasmVNC and relays its renderer over a `/bridge` WebSocket.

OpenCode is the opposite: `opencode serve` is a **real headless server** that
serves its own web UI, JSON API, and terminal WebSocket on **one port (4096)**,
and the production UI auto-connects to `location.origin`. So there is **no
payload, no SPA injection, no bridge, no VNC**. The Worker is a *pure
authenticated reverse proxy* to the container.

```
Browser ──HTTPS/WSS──▶ Worker (verify Access JWT) ──▶ Durable Object ──▶ Container
                                                                          │ opencode serve :4096
                                                                          │  (UI + API + WS)
                                                                          ▼ /workspace ◀─sync─▶ R2
```

## Layout

```
apps/opencode/
├── src/index.ts          # Worker — Access gate + reverse proxy; OpencodeContainer DO
├── Dockerfile            # container image: opencode-ai CLI + rclone/zstd for R2 sync
├── scripts/entrypoint.sh # supervisor: hydrate /workspace from R2, checkpoint, serve
├── wrangler.toml         # Worker + Container + DO + R2 bindings
└── .dev.vars.example     # local dev secrets template
```

## Deploy

```bash
npm install   # from repo root (workspaces)

# 1. Create the workspace bucket
npx wrangler r2 bucket create jode-opencode-workspace

# 2. Secrets (the non-secret Access + R2 config is already in wrangler.toml [vars])
npx wrangler secret put ANTHROPIC_API_KEY        # model provider key
npx wrangler secret put R2_ENDPOINT              # https://<ACCOUNT_ID>.r2.cloudflarestorage.com
npx wrangler secret put R2_ACCESS_KEY_ID         # R2 → Manage API Tokens
npx wrangler secret put R2_SECRET_ACCESS_KEY

# 3. Deploy (wrangler builds the Dockerfile, pushes the image, rolls out the Worker)
npm run deploy        # or, from repo root: npm run oc:deploy
npm run dry-run       # no-publish check
```

Open the Worker hostname and the OpenCode UI loads and connects to its backend
automatically (same origin → no CORS, no manual server URL).

## Authentication — Cloudflare Access (single email)

Identical to `@jode/claude-code`. The container runs arbitrary commands, so the
only door is the Worker, and it is gated by **Cloudflare Access**:

1. **Cloudflare Access** fronts the Worker hostname (policy = one allowed email).
2. **The Worker verifies the Access JWT** (`@jode/auth` → `verifyAccessJwt`) on
   *every* request including the terminal WebSocket upgrade — RS256 against the
   team JWKS, plus `iss`/`aud`/`exp`/`email`. Fails closed.

### One-time setup

```bash
# 1. Create a self-hosted Access application over the Worker's hostname, policy
#    allowing exactly your email. Copy the Application Audience (AUD) tag.
# 2. Put the non-secret config in wrangler.toml [vars]:
#      ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
#      ACCESS_AUD         = "<the AUD tag>"
#      ALLOWED_EMAIL      = "you@example.com"
# 3. Deploy.
```

For local `wrangler dev`, copy `.dev.vars.example` → `.dev.vars`.

## Workspace persistence (R2)

`/workspace` lives on the container's ephemeral disk and is snapshotted to R2 by
`scripts/entrypoint.sh`: hydrated on boot, checkpointed every
`CHECKPOINT_INTERVAL` seconds (default 300) and on SIGTERM, as a single
`tar.zst` object. A Worker R2 binding can't reach inside a container, so the sync
uses R2's **S3 API** (rclone) with the `R2_*` secrets.

**Caveat (same as any container):** this is snapshot-based, not a live volume.
Edits between checkpoints can be lost on a hard crash, and waking from sleep
re-hydrates the last snapshot. Treat the container as a cache and R2 as the
durable store; for anything important, have the agent `git push`. The continuous
local↔remote sync described in the jode README is a later step (`@jode/sync`),
which will supersede this coarse snapshotting.

## Known gaps / later steps

- **Single shared workspace** (`max_instances = 1`, DO id `"default"`). Multi-tenant
  = key the DO id off the verified Access email in `src/index.ts` and namespace the
  `WORKSPACE_KEY` per user → one container + one R2 snapshot each.
- **Cold starts:** after `sleepAfter` (30m) the next request wakes the container and
  re-hydrates from R2, so the first load after idle is slow.
- **Continuous file sync** (the real two-way laptop↔remote sync) is `@jode/sync`,
  not this snapshotting.
