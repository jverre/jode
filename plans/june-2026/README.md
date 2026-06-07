# jode — Implementation Plans (June 2026)

Four plans, in dependency order:

| Plan | Covers |
|------|--------|
| [`01-repo-architecture.md`](./01-repo-architecture.md) | Monorepo layout — `apps/desktop`, `apps/cloudflare`, and shared `packages/` (protocol, sync, agents, auth) |
| [`02-cloudflare-claude-code.md`](./02-cloudflare-claude-code.md) | Claude Code served as a **web UI** from Cloudflare — Worker + Durable Object + Container, headless-Electron relay bridge, Zero Trust single-email auth |
| [`03-electron-app.md`](./03-electron-app.md) | The desktop shell — a browser shell that **renders each agent's remote web UI in a web view**, with a workspace switcher, Access login, and local sync daemon |
| [`04-cloudflare-codex.md`](./04-cloudflare-codex.md) | The **Codex** desktop app hosted on Cloudflare via the **same rehost path as Claude Code** (headless Electron + `/bridge` relay + SPA injection), plus the OpenAI-specific swaps (upstream, auth, the `codex` CLI runtime dep) and R2-persisted `/workspace` |

## The serving model (important)

The agent runs headless in the Cloudflare container; its **real renderer UI is served as a web SPA** and wired back to the real IPC handlers over a WebSocket "relay" bridge. The desktop app **embeds that web UI in a `WebContentsView`** — it is *not* a terminal/PTY. This is already built in the `cloudflare-split` prototype.

## Reference prototypes these build on

- **`/Users/jacquesverre/Documents/claude-desktop-linux-lab/cloudflare-split`** — working Cloudflare Worker→DO→Container stack that serves a headless Linux Electron app's UI to the browser via the relay bridge. Reused wholesale in plan 02. *Caveat: its auth is a hardcoded shared key, not Zero Trust — the single-email gate is net-new.*
- **`/Users/jacquesverre/Documents/claude-desktop-linux-lab/work/linux-rehost/app`** — Linux rehost of the Claude Desktop Electron app (macOS native-module shims). It's the packaging technique for running the app headless in the container; it contains **no file-sync code**.

## Suggested build order

`01` (scaffold) → `02` (remote + auth) → `03` (desktop client). Within `02`, stand up the prototype, then add Zero Trust auth before anything else. `node-pty` is **not** on the critical path — the agent UI is the web SPA, so PTY only matters later for in-app integrated-terminal features.
