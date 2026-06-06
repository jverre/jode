# 02 — Claude Code App Running on Cloudflare

## Goal

Run the Claude Code app on a managed remote environment hosted on Cloudflare, **served as a web UI** that the jode desktop app renders in a web view. Reachable only by a single authorized email (`jacques@comet.com`) via Cloudflare Zero Trust. The app's working files live in the container's `/workspace` and are synced to the laptop.

Claude Code is the **first** agent; the stack is designed so Codex and OpenCode slot in later as additional hosted apps, not a rebuild.

## Reference prototype — this is already built

`/Users/jacquesverre/Documents/claude-desktop-linux-lab/cloudflare-split` already implements the whole hosting-and-serving model and runs it live. The serving mechanism is the key thing — **it serves the real app's UI as a web SPA in the browser, not a terminal.** We lift this into `apps/cloudflare/` and change two things: **the auth model** (Zero Trust, not a shared key) and **add a sync agent**.

### How it serves the UI (the "relay" / split architecture)

```
jode web view  ──HTTPS──▶  Worker serves the SPA (the real app's renderer bundle)
   (browser)                  │
       │  WebSocket /bridge    │
       └──────────────────────▶ Worker  ──▶ Durable Object ── Container
                                                 Firecracker Linux box:
                                                   ├─ headless Electron MAIN process
                                                   │    (real app, no pixels)
                                                   ├─ relay webContents @ app origin
                                                   │    → real IPC handlers register here
                                                   ├─ bridge server :8787 (WS RPC relay)
                                                   ├─ /workspace (canonical files)
                                                   └─ health server :8080
```

- The browser/web view loads the **real renderer SPA**. The SPA's IPC calls (`ipcRenderer`) are transported over the **`/bridge` WebSocket** to the bridge server, which relays them to the **real Electron main process** running headless in the container.
- A synthetic **relay webContents** loads at the app's origin inside the container so the real IPC handlers register naturally — yielding **100% authentic IPC with no reimplementation** (the prototype's core insight).
- `/api/*` calls are **tunneled through the container's authenticated context** so the SPA inherits a valid upstream session.

**Net: the agent UI renders in a normal web view. jode's desktop app embeds that web view (see `03-electron-app.md`). No terminal, no PTY for rendering.**

### What the prototype already gives us
- Worker → Durable Object → Container topology via `@cloudflare/containers`, deployed with `wrangler`.
- The headless-Electron + relay-webContents serving model (the Linux-rehost packaging from `linux-rehost`).
- The `/bridge` WebSocket relay with request/response correlation, including `sendSync` handling via a cached store snapshot.
- `/api/*` tunneling through the container's authenticated renderer.
- Container image, `entrypoint.sh` supervision, health server, `wrangler tail` observability.

### What is net-new for jode (the real work)
1. **Zero Trust single-email auth** — the prototype uses a hardcoded `split-bridge-key-v1` shared key plus claude.ai cookie tunneling. Replace the key with Cloudflare Access; gate every request and the WS upgrade by verified identity.
2. **Remote sync agent** — the in-container half of the file-sync layer, exposed over the auth-gated bridge.
3. **Persistent `/workspace` + durable session** — the prototype wipes state on boot; jode needs the environment to feel durable.
4. **Generalize to multiple agents** — Claude Code first; Codex/OpenCode as additional hosted apps later (additional payloads + routes).

> `node-pty` (terminal spawning) was flagged unresolved in the rehost notes. It is **not** on the critical path for serving the UI — the UI is the web SPA. It only matters if/when an agent needs an in-app integrated terminal feature. Treat it as secondary, not a blocker.

## Components

### 1. Worker — edge router + auth gate (`apps/cloudflare/src/`)
Extends the prototype's `src/index.ts`.
- **Auth gate (new, first priority):** every request — including the `/bridge` WebSocket *upgrade* — must carry a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`). Verify signature against the team's public keys (`/cdn-cgi/access/certs`), check `aud` (the Access app audience tag), check the email claim equals the allowlisted address. Reject everything else at the edge. Logic lives in `packages/auth`.
- **Serving:** serve the SPA renderer bundle + injected bridge client; route `/bridge` (WS) to the container; tunnel `/api/*`; serve the sync endpoint over the authenticated bridge.
- **Remove the shared bridge key entirely** — identity comes from the verified Access JWT.

### 2. Cloudflare Access application + policy
- An Access application fronting the Worker's hostname.
- Policy: **allow exactly one email**, via an identity provider (one-time PIN email is lowest-friction for a single user; OAuth also fine).
- The Access app's audience tag (`aud`) and team domain become Worker secrets used by `packages/auth`.

### 3. Container image (`apps/cloudflare/Dockerfile` + `container/`)
Extends the prototype's Dockerfile.
- Base Linux + Node + headless Electron, with the **Claude Code app payload** baked in (the rehosted bundle).
- The **bridge server** (`container/`, from the prototype's `bridge.cjs`): WS RPC relay, relay-webContents lifecycle, `/api` tunnel, and the sync endpoint.
- The **remote sync agent** (from `packages/sync`): watches `/workspace`, applies inbound changes, emits outbound changes.
- `entrypoint.sh` supervises: health server (:8080) → bridge server (:8787) → headless Electron + relay webContents.

### 4. Persistence & lifecycle
- **`/workspace` durability:** must survive container restarts — persistent volume, R2-backed snapshot, or the laptop's synced mirror as backstop (re-sync on boot). Decide with the sync design.
- **Session durability:** the prototype deletes auth cookies on boot (fresh login each time). jode wants sessions to persist so reopening lands you back in a logged-in app. Persist the renderer session/cookies in durable storage.
- **Lifecycle:** start **always-on** (`max_instances = 1`) for predictable latency; revisit sleep/wake + checkpointing for cost later.
- **Scope:** single user / single email / single container. Multi-tenancy out of scope.

## Build order

1. **Deploy the prototype unchanged** on jode's Cloudflare account; confirm the app renders in a browser and the bridge works. Baseline.
2. **Cloudflare Access in front of the Worker**, policy = single email; Worker verifies the Access JWT on every request **including the WS upgrade**; delete the shared key. *(Security before anything else — the prototype's own remaining-work note insists on this.)*
3. **Session persistence** — keep the user logged in across container restarts.
4. **Remote sync agent** in-container over the auth-gated bridge (co-designed with the sync engine).
5. **Persistent `/workspace`** surviving restart; confirm always-on lifecycle.
6. **(Later)** add Codex / OpenCode as additional hosted payloads.

## Risks

- **Access JWT verification correctness**, especially on the WebSocket upgrade path — a mistake defeats the entire security model. Test rejection paths explicitly.
- **`cf_clearance` / upstream session tunneling** — the prototype tunnels `/api/*` through the container's renderer because the clearance is IP/UA-bound. Preserve this; it's load-bearing.
- **Container networking** may only expose the Worker surface (no raw TCP) — constrains how the sync transport reaches the box; verify before committing.
- **Cost of an always-on container** — accept for v1's single user; revisit later.

## Definition of done

Open the jode desktop app → authenticate as the single allowed email via Cloudflare Access → the **Claude Code web UI renders** (served from Cloudflare, backed by the headless Electron main process in the container) → `/workspace` is available for sync and survives container restarts → the session stays logged in across restarts. Any other identity is rejected at the edge.
