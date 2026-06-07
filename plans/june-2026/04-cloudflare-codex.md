# 04 — Codex App Running on Cloudflare (rehost path)

## Goal

Host the **OpenAI Codex desktop app** on Cloudflare the **same way we host Claude
Code** ([`02-cloudflare-claude-code.md`](./02-cloudflare-claude-code.md), built in
[`apps/claude-code`](../../apps/claude-code)): run the real Electron app headless
in a container, **serve its real renderer SPA** to the browser, and wire the
SPA's IPC back to the headless Electron main process over a `/bridge` WebSocket
relay. Gated by Cloudflare Access to the single allowed email. Lands as
`apps/codex/`, the third agent in the rail (the `codex` entry already exists in
`apps/desktop/src/main/agents.ts`, with a logo and accent).

**This is the rehost path, not the OpenCode reverse-proxy path.** OpenCode could
be a pure proxy because `opencode serve` ships its own headless web server. The
Codex *app* is the opposite — like Claude Desktop, it's an Electron app with no
headless web server — so we reuse the Claude Code machinery (payload build →
headless Electron under KasmVNC → bridge relay → SPA injection), not the
`apps/opencode` machinery.

## Why the rehost path fits Codex

The Codex app (launched Feb 2026, `chatgpt.com/codex`) is **built with Electron +
Node.js** for macOS (Apple Silicon + Intel) and Windows. That's the one
precondition the Claude Code technique needs: an Electron desktop bundle whose
`app.asar` we can extract, shim for Linux, and boot headless. It's already been
done in the open — [`ilysenko/codex-desktop-linux`](https://github.com/ilysenko/codex-desktop-linux)
converts the upstream `Codex.dmg` into a runnable Linux Electron app (patched
webview, managed Node runtime, platform-check patches). That repo is to Codex
what the `linux-rehost` lab was to Claude Desktop: the source of the Linux shims.

Two Codex-specific facts shape the work:

1. **Upstream is OpenAI, not Anthropic.** Where the Claude Code Worker tunnels
   `/api/*` through the container's authenticated `claude.ai` renderer, the Codex
   app talks to OpenAI's backend (`chatgpt.com` / the Codex backend). The upstream
   origin, API path prefixes, and auth headers all change.
2. **The Codex app drives the `codex` CLI at runtime.** The desktop app shells out
   to the Codex CLI for the actual agent work (and uses git worktrees). The
   container must therefore also have the `codex` CLI installed and on `PATH`, and
   `/workspace` must persist (worktrees + repos).

## What we reuse from `apps/claude-code` (≈80% verbatim)

The whole serving model transfers. We copy `apps/claude-code/` to `apps/codex/`
and parameterize the app-specific bits:

| File | Reuse | What changes for Codex |
|------|-------|------------------------|
| `src/index.ts` (Worker) | Structure verbatim — Access gate, SPA injection, `/bridge` + `/healthz` to container, `/__bridge/*` assets, `/api/*` tunnel | `UPSTREAM_ORIGIN` → OpenAI host; `PROXY_PATH_PREFIXES` / `LOCAL_ASSET_PREFIXES` to match Codex's bundle; forwarded auth headers (the `anthropic-*` allowlist → OpenAI's `openai-*`/session headers); challenge-redirect helpers likely droppable |
| `bridge/bridge.cjs` | Verbatim — WS RPC relay, relay-webContents lifecycle, `sendSync` snapshot, `/proxy` tunnel, `/session`, `/boot`, `/debug-*` | `BRIDGE_APP_HOST` → `chatgpt.com`; `BRIDGE_SENDER_URL` → the Codex app origin |
| `scripts/gen-assets.mjs` | Verbatim — bundles `index.html` + `bridge-client` + `mainView` into `src/generated-assets.ts` | Asset entry-point names if Codex's bundle differs |
| `scripts/build-payload.mjs` | Same pipeline — extract `app.asar`, merge `app.asar.unpacked`, apply Linux shims | Source app `/Applications/Codex.app`; **shims sourced from `codex-desktop-linux`** instead of the Claude-swift/helper shims; platform-check patch points differ |
| `Dockerfile` | Same base — KasmVNC Xvnc + headless Electron + bridge, native-module rebuild for Electron's ABI | **+ install the `codex` CLI** (`npm i -g @openai/codex`); Electron version to match the Codex bundle; node-pty rebuild kept |
| `scripts/entrypoint.sh`, `xstartup.sh`, `health-server.mjs` | Verbatim supervisor (health → KasmVNC → xstartup → headless Electron + bridge) | env var names only |
| `wrangler.toml` | Same shape — Worker + Container + DO + `[assets]` `run_worker_first` + Access `[vars]` | `name = jode-codex`; new DO class `CodexBridgeContainer`; **add R2 workspace persistence** (copy from `apps/opencode`) |
| `packages/auth` | **Verbatim, unchanged** — the Access JWT gate is already shared | nothing |

## Findings from the installed app (2026-06-07 — verified against `/Applications/Codex.app`)

Inspecting the real bundle confirmed the rehost is viable and pinned the facts —
and corrected one optimistic assumption below (the bridge is **not** an ~80%
parameter-swap of Claude's).

- **Electron 42.1.0**, `com.openai.codex` v26.527.60818. Bundle uses a custom
  "owl" runtime name but is stock-Electron-shaped. Main entry: `.vite/build/bootstrap.js`.
- **Renderer** is `webview/index.html` + `webview/assets/*` **inside** app.asar
  (Claude's lived outside it). `index.html` carries `PROD_BASE_TAG_HERE` /
  `PROD_CSP_TAG_HERE` placeholders the main process fills at load — the SPA
  injection step must reproduce the `<base>` + CSP injection.
- **Native modules:** `objc-js` (macOS Obj-C bridge — physically stubbed in the
  payload), `node-pty` + `better-sqlite3` (rebuilt against Electron 42's ABI in
  the Dockerfile), `@worklouder/device-kit-oai` (hardware kit, ships Linux
  prebuilds — left as-is, likely lazy/optional in a container).
- **The agent backend:** the app spawns the **`codex` rust CLI as an "app-server"**
  (refs to `bin/codex` / `app-server` / `codex-cli`); it is **not** bundled, so the
  Dockerfile installs `@openai/codex` on PATH. Model traffic goes to
  `https://chatgpt.com/backend-api`.
- **THE BRIDGE IS HARDER THAN ASSUMED.** Codex's renderer↔main is **not** Claude's
  request/response `eipc`. The preload exposes `electronBridge` + a handful of
  discrete `codex_desktop:*` channels (easy to relay), but the **bulk of app data
  flows over a transferred `MessagePort`**: the renderer opens a `MessageChannel`
  and hands one port to main via `ipcRenderer.postMessage('codex_desktop:connect-app-host', …, [port])`,
  and the main wires it to the app-server (capnweb RPC). So the `/bridge` relay
  must tunnel a **MessagePort message stream** over the WebSocket (browser-side
  `MessageChannel` ↔ WS ↔ container-side `MessagePortMain`), in addition to the
  discrete channels. This is real engineering, not a config swap — it is the
  central work of the "Adapt Worker + bridge" step.

## What is net-new (the real work)

1. **The Codex payload build.** Get the Linux shims right so the extracted
   `Codex.app` boots headless under forced-Linux Electron. This is the hard,
   iterative part — exactly as it was for Claude Desktop. Mine
   `codex-desktop-linux` for: the patched webview, the macOS-native-module stubs,
   the managed-Node-runtime trick, and the platform-check patches. Translate them
   into `build-payload.mjs` shim steps (the analog of Claude's `@ant/claude-swift`
   stub + helper shims + `bootstrap.cjs`).
2. **The `codex` CLI in the image + on `PATH`.** The desktop app delegates agent
   work to it. Install it in the Dockerfile and confirm the app finds it.
3. **OpenAI auth + upstream tunneling.** Repoint the Worker's `/api/*` tunnel and
   the bridge's app host at OpenAI's backend; forward the right session/auth
   headers; decide the login model (see below). This is the analog of Claude
   Code's "auth model A" cookie-tunneling and is the second-hardest part.
4. **Persistent `/workspace`.** Codex uses git worktrees/repos — the workspace must
   survive restarts. Lift the R2 snapshot machinery from `apps/opencode`
   (`entrypoint.sh` hydrate/checkpoint via rclone+zstd, `WORKSPACE` R2 bucket,
   `R2_*` secrets). Eventually superseded by `@jode/sync`.

## Auth model — decide early

Codex signs in two ways: **ChatGPT account** (OAuth) or **OpenAI API key**. Two
options, in increasing fidelity:

- **API key (simplest v1).** Set `OPENAI_API_KEY` as a Worker secret, inject into
  the container via `envVars` (the `apps/opencode` pattern). The `codex` CLI and
  app use it directly; no session tunneling. Recommended first cut.
- **ChatGPT OAuth (full app fidelity).** Mirror Claude Code's "auth model A":
  authenticate inside the container's renderer, persist the session, and tunnel
  `/api/*` through it so the browser inherits a cleared, authenticated session.
  Codex CLI's `login --device-auth` (headless device flow) is the natural fit for
  doing the login inside the box. Persist `~/.codex/auth.json` to R2 alongside the
  workspace so it survives restarts.

Both still sit behind the same Cloudflare Access edge gate — this is *model
provider* auth, orthogonal to *who may reach the Worker at all*.

## Components (mirrors plan 02)

```
apps/codex/
├── src/index.ts             # Worker — Access gate, SPA injection, /bridge, /api tunnel → OpenAI
├── src/generated-assets.ts  # GENERATED by gen-assets.mjs
├── bridge/bridge.cjs        # in-container WS RPC relay (runs in Electron main)
├── browser-bridge/          # bridge-client.js injected into the served SPA
├── scripts/
│   ├── build-payload.mjs    # extract /Applications/Codex.app + apply Linux shims
│   ├── gen-assets.mjs        # bundle SPA assets
│   ├── entrypoint.sh         # supervisor: health → KasmVNC → xstartup (+ R2 hydrate/checkpoint)
│   ├── xstartup.sh           # launch headless Electron + bridge under the X display
│   ├── install-electron-linux.sh
│   └── health-server.mjs
├── Dockerfile               # KasmVNC + headless Electron + bridge + codex CLI + rclone/zstd
├── wrangler.toml            # Worker + Container(CodexBridgeContainer) + DO + R2 + Access vars
├── .dev.vars.example
└── payload/linux-rehost/    # GENERATED, gitignored — the rehosted Codex bundle
```

## Build order

1. **Local rehost first (off Cloudflare).** Get `/Applications/Codex.app` →
   `build-payload.mjs` → booting headless under forced-Linux Electron with the
   `codex-desktop-linux` shims, locally. This de-risks the single hardest unknown
   before any container/Worker work. *(Mirror of how the Claude payload was proven
   in the `linux-rehost` lab.)*
2. **Copy `apps/claude-code` → `apps/codex`** and parameterize: names, DO class,
   `wrangler.toml`, dev ports. Deploy the bridge + KasmVNC + headless Codex with
   the SPA served and `/bridge` WS connected — UI renders, even if API calls 401.
3. **Wire model-provider auth.** API key first (quickest path to a working agent);
   repoint the `/api/*` tunnel + bridge app host at OpenAI; forward correct
   headers. Then (optional) ChatGPT OAuth via `codex login --device-auth` with
   persisted `~/.codex`.
4. **Install + verify the `codex` CLI** in the image; confirm the app drives it
   and a real task runs end-to-end.
5. **Persistent `/workspace`** — lift R2 snapshotting from `apps/opencode`.
   Worktrees/repos survive restart.
6. **Desktop wiring** (small, mostly done — see below).

## Desktop + repo wiring (small)

The desktop already knows about Codex; only plumbing remains:

- `tools/dev.mjs` — add a third `WORKERS` entry: `codex`, `@jode/codex`,
  `apps/codex`, `http://localhost:8789`, env `JODE_CODEX_URL` (Claude=8787,
  OpenCode=8788, so Codex=8789). `agents.ts` already reads `JODE_CODEX_URL`.
- Root `package.json` — add `cx:build-payload` / `cx:gen` / `cx:deploy` /
  `cx:dry-run` scripts mirroring the `cc:*` set.
- Production: set `JODE_CODEX_URL=https://jode-codex.<subdomain>.workers.dev`.
- Nothing in `agents.ts`, `logos.ts`, or `agent-rail.tsx` needs changing — the
  `codex` id, `codex.svg`, accent `#10A37F`, and `login`/`error` status dots are
  already there.

## Risks

- **Payload boot under Linux is the big unknown** (same risk class as the Claude
  rehost). The Codex app is newer and may have native deps (Computer Use, git
  integration) beyond what `codex-desktop-linux` covers. Budget iteration here;
  prove it locally (step 1) before container work.
- **OpenAI upstream/auth tunneling.** The exact backend origin, API path
  prefixes, and required session headers are unconfirmed — capture them from the
  real app (DevTools/network) the way the Claude tunnel headers were captured.
  Bot-challenge/clearance behavior (the Claude Code `cf_clearance` IP/UA binding
  and last-good stabilization) may or may not apply to OpenAI; verify.
- **`codex` CLI ↔ app version coupling.** The app expects a compatible CLI; pin
  versions in the Dockerfile.
- **Electron version match.** Native-module rebuilds (node-pty, plus any Codex
  natives) must target the Codex bundle's Electron ABI — confirm the version, as
  `build-payload.mjs`'s `ELECTRON_VERSION` is Claude-specific (41.6.1).
- **Workspace durability** is snapshot-based (R2), not a live volume — same caveat
  as `apps/opencode`; lean on `git push` until `@jode/sync` lands.
- **macOS-only source app.** `build-payload.mjs` needs `Codex.app` present on the
  build machine (Apple Silicon/Intel build), same constraint as the Claude path.

## Definition of done

Open jode → authenticate as the single allowed email via Cloudflare Access → the
**Codex app's web UI renders in the pane** (served from Cloudflare, backed by the
headless Electron main process + `codex` CLI in the container) → sign in to OpenAI
→ run a real Codex task against a repo in `/workspace` → `/workspace` (worktrees,
repos) survives a container restart. Any other identity is rejected at the edge.
```
