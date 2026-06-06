# 01 — Repo Folder Architecture

How the jode codebase is laid out. jode has three moving parts that share types and tooling: an **Electron desktop app**, a **Cloudflare remote environment** that hosts the coding agents, and a **file-sync layer** that spans both. A monorepo keeps the shared contracts (RPC messages, sync protocol, auth claims) in one place so the client and server can't drift.

## Top-level layout

```
jode/
├── README.md
├── package.json                # workspace root (npm/pnpm workspaces)
├── pnpm-workspace.yaml          # or workspaces field in package.json
├── tsconfig.base.json           # shared compiler options, path aliases
├── .github/workflows/           # CI: lint, typecheck, test, build, deploy
├── plans/                       # planning docs (this folder)
│
├── apps/
│   ├── desktop/                 # the Electron app  → see 03-electron-app.md
│   └── cloudflare/              # the remote env on Cloudflare → see 02-cloudflare.md
│
├── packages/
│   ├── protocol/                # shared wire contracts (single source of truth)
│   ├── sync/                    # file-sync engine (shared local + remote logic)
│   ├── agents/                  # agent adapter definitions (Claude Code, Codex, OpenCode)
│   ├── auth/                    # Cloudflare Access JWT verification + identity types
│   └── tsconfig/                # shared tsconfig presets (optional)
│
└── tools/                       # repo scripts (asset gen, payload sync, release)
```

## `apps/` — deployable units

### `apps/desktop/` (Electron)
The desktop shell the user installs. Owns nothing the server needs to import. Detailed in `03-electron-app.md`. Internal shape:
```
apps/desktop/
├── package.json
├── electron.vite.config.ts      # or electron-forge config
├── src/
│   ├── main/                    # Electron main process (windows, lifecycle, IPC host)
│   ├── preload/                 # contextBridge surface
│   └── renderer/                # React UI: workspace rail, agent panes, sync status
└── resources/                   # icons, tray assets
```

### `apps/cloudflare/` (remote environment)
The Worker + Durable Object + Container stack, derived from the `cloudflare-split` prototype. Detailed in `02-cloudflare.md`. Internal shape:
```
apps/cloudflare/
├── wrangler.toml                # Worker + Container + DO bindings
├── Dockerfile                   # container image: agents + node-pty + sync agent
├── src/                         # Worker code (edge router + auth gate)
├── container/                   # in-container services (bridge, sync agent, supervisor)
├── payload/                     # rehosted agent runtime(s) baked into the image
└── scripts/                     # entrypoint.sh, health server, asset/payload sync
```

## `packages/` — shared libraries

The point of the monorepo. Each is its own workspace package, imported by `apps/*` via path aliases.

| Package | Owns | Imported by |
|---------|------|-------------|
| **`protocol`** | TypeScript types + (de)serialization for every message crossing the wire: bridge RPC envelopes, PTY frames, sync events, error shapes. The contract both ends compile against. | desktop, cloudflare, sync |
| **`sync`** | The file-sync engine — watchers, hashing, diff/patch, reconciler, ignore rules. Platform-neutral core with thin local/remote adapters. | desktop (local daemon), cloudflare (remote agent) |
| **`agents`** | Declarative agent adapters: how to launch Claude Code / Codex / OpenCode, how their PTY/IO is shaped, capabilities. Config-driven so adding an agent is data, not code. | desktop (connectors), cloudflare (launcher) |
| **`auth`** | Cloudflare Access JWT verification (signature, `aud`, email claim) + the shared identity type. One implementation, used at the edge and referenced by the client. | cloudflare (Worker gate), desktop (login state) |

### Dependency direction (no cycles)
```
apps/desktop ─┐
              ├─▶ packages/protocol ◀─┐
apps/cloudflare┘                       │
   │  │                                │
   │  └─▶ packages/sync ──────────────┤
   │  └─▶ packages/agents ────────────┤
   └────▶ packages/auth ──────────────┘
packages/* never import from apps/*
```

## Conventions

- **Language:** TypeScript everywhere (matches both prototypes). One `tsconfig.base.json`; each package extends it. Path aliases (`@jode/protocol`, `@jode/sync`, …) instead of relative `../../..`.
- **Package manager:** pnpm workspaces (fast, strict, good monorepo hoisting). npm workspaces is an acceptable fallback.
- **Build:** each app owns its build; packages are consumed as source (or a light `tsc` build) — no publishing.
- **Boundaries enforced:** lint rule forbidding `apps/*` imports from another app, and `packages/*` imports from `apps/*`. Cross-cutting contracts live in `protocol`.
- **Tests:** colocated `*.test.ts`; the `sync` package gets the heaviest coverage (it's the data-loss-risk surface).

## Why this shape

- **Shared contracts can't drift.** The client and the remote compile against the same `protocol`/`sync`/`auth` packages — a breaking change fails CI on both sides at once.
- **The two deployables stay independent.** `apps/desktop` ships as an installer; `apps/cloudflare` ships via `wrangler deploy`. Neither imports the other.
- **The risky logic is isolated and testable.** Sync lives in one package with no Electron or Worker dependencies, so it can be fuzzed/tested in plain Node.
- **Adding an agent is additive.** New entry in `packages/agents`; both ends pick it up.

## First commits (scaffold order)

1. Workspace root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, CI skeleton.
2. `packages/protocol` with a minimal message set; `packages/auth` with the identity type.
3. `apps/cloudflare` seeded from the `cloudflare-split` prototype.
4. `apps/desktop` Electron skeleton.
5. `packages/sync` and `packages/agents` as their milestones begin.
