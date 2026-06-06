# 03 — Electron App (Desktop Shell)

## Goal

The desktop application the user installs. It unifies the AI coding agents (Claude Code first; Codex and OpenCode later) into one window with a fast workspace switcher. Each agent is a **web UI served from Cloudflare** (`02-cloudflare-claude-code.md`); the desktop app **renders that web UI in an embedded web view**, authenticated via Cloudflare Access. It also hosts the local half of file sync so the user edits project files locally while agents run remotely.

Lives in `apps/desktop/` (see `01-repo-architecture.md`).

## The core idea: a browser shell around remote agent UIs

Each agent already runs as a hosted web app on Cloudflare (real renderer SPA in the container, bridged to a headless Electron main process). So jode's desktop app is essentially a **focused, multi-workspace browser shell**: each workspace is a web view pointed at an agent's Worker URL, with a Franz/Slack-style rail to switch between them. The heavy lifting (the agent, its IPC, its files) is all remote — the desktop app renders and orchestrates.

This is why there is **no terminal/PTY in the desktop app** — the agent UI is a web page, not a shell.

## Why Electron

A web view that can host a full remote SPA (with cookies, WebSocket, OAuth-style login), plus a Node-capable main process for the local sync daemon and secure token storage, cross-platform installers, native rail/tray. Matches the reference prototypes and the `linux-rehost` packaging know-how. Tauri is a lighter alternative but adds unknowns; default to Electron.

## Process model

```
┌──────────────────────────────────────────────────────────────────┐
│ Electron app                                                        │
│                                                                     │
│  main process (Node)                                                │
│    ├─ window & lifecycle, tray, deep-link handler                   │
│    ├─ auth: Cloudflare Access login flow + secure token storage     │
│    ├─ local sync daemon  (packages/sync, local adapter)             │
│    └─ session/workspace registry                                    │
│         │  contextBridge (preload)                                  │
│  shell renderer (React + TS) — the chrome                           │
│    ├─ workspace rail / switcher                                     │
│    ├─ sync status UI, command palette                               │
│    └─ hosts ↓                                                       │
│  WebContentsView per workspace — the remote agent UI                │
│    └─ loads the agent's Cloudflare Worker URL                       │
│       (SPA ↔ /bridge WS ↔ headless Electron in the container)       │
└──────────────────────────────────────────────────────────────────┘
```

- **main** does privileged work: the Cloudflare Access login, secure token storage, the local file-sync daemon, window/view orchestration.
- **shell renderer** is the app chrome — the rail, status, palette. It does *not* render agent content.
- **each agent UI is a `WebContentsView`** (Electron's modern `BrowserView` successor) pointed at that agent's Worker URL. Switching workspaces swaps which view is visible. Each view holds its own session (cookies, WS) and keeps running in the background when not visible.

## Auth: how the web views get past Cloudflare Access

The Worker sits behind Cloudflare Access (per `02`). The web view must present a valid Access identity:
- Drive the Access login once (Access serves its login page; the user authenticates with the single allowed email via one-time PIN or OAuth). Access sets its `CF_Authorization` cookie on the Worker's domain.
- That cookie lives in the web view's session partition, so subsequent loads and the `/bridge` WebSocket upgrade carry it automatically.
- Persist the session partition to disk so reopening jode stays logged in (pairs with session durability in `02`).
- Use a **persistent `session` partition per agent** so each agent's auth/cookies are isolated and durable.

No bespoke token plumbing into the page is needed — Access cookies on the Worker domain do the work. The main process only needs to manage secure storage if we add token-based flows later.

## UX

- **Workspace rail** (left edge): one entry per agent instance — Franz/Slack-style. Click to switch visible `WebContentsView`; background agents keep running.
- **Add agent:** pick Claude Code / Codex / OpenCode (each maps to a Worker URL / hosted payload), optionally bind to a project/workspace.
- **Per-agent status:** loaded / loading / needs-attention / disconnected (derived from the view's load + bridge state).
- **Sync status:** synced / syncing / offline / conflict, with conflict resolution affordance.
- **Command palette:** keyboard switching across agents and workspaces.
- **Reconnect on reopen:** persisted sessions + persisted partitions mean reopening jode reloads straight into the running, logged-in agent UIs ("close the lid, keep the work").

## Components

### 1. Auth & session manager (main)
- Drives the Cloudflare Access login flow; ensures each agent's `WebContentsView` uses a persistent, isolated session partition holding the Access cookie. Surfaces logged-in/out state to the shell.

### 2. Workspace/view manager (main + shell renderer)
- Creates a `WebContentsView` per agent instance pointed at its Worker URL; shows/hides on switch; tracks load and bridge-connection state for the rail.
- Agent definitions (URL, display, icon, capabilities) come from `packages/agents` — adding Codex/OpenCode is data, not code.

### 3. Local sync daemon (main, `packages/sync` local adapter)
- Watches the local project mirror, applies inbound remote changes, emits local changes over an authenticated channel to the container's sync agent. Surfaces status/conflicts to the shell. (This is the one piece independent of the web-view rendering path.)

### 4. Session/workspace registry (main)
- Tracks each agent instance: Worker URL, session partition, bound workspace, last state. Persisted (e.g. `electron-store`) so reopening reattaches.

## Packaging

- Build with `electron-vite` (or electron-forge, consistent with the rehost). React + TS shell renderer.
- Cross-platform installers (macOS first; Linux/Windows follow). macOS code-signing/notarization before external distribution.
- Auto-update later; not v1-critical.

## Build order

1. **Shell skeleton** — main + preload + shell renderer; window boots to an empty workspace rail.
2. **One agent web view + Access login** — a `WebContentsView` that loads the Claude Code Worker URL, authenticates through Cloudflare Access, and renders the live agent UI. **First usable slice** (depends on `02` steps 1–2).
3. **Workspace switcher + registry** — multiple views, persistent sessions/partitions, reconnect-on-reopen.
4. **Local sync daemon + sync status UI** — wire `packages/sync`; show state and conflicts.
5. **Codex + OpenCode views** — additive via `packages/agents`.

## Risks

- **Embedding a full remote SPA in `WebContentsView`** — must support the SPA's WebSocket bridge, cookies, and Access login redirects. Verify the partition/cookie + Access flow early.
- **Session persistence across restarts** — relies on persistent partitions on disk; pairs with `02`'s session-durability work.
- **Renderer security** — agent views load remote content; keep them in isolated partitions with no Node integration, and keep all privilege in main behind the preload surface.
- **Secret handling** — any tokens in the OS keychain only; never renderer-accessible.

## Definition of done

Install jode → authenticate via Cloudflare Access → the **Claude Code web UI renders inside the app** (served from Cloudflare) → switch between multiple agent workspaces from the rail → edit project files locally and have the remote agent see them → close and reopen the app and land back in the running, logged-in agent UIs.
