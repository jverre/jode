# jode

One workspace for Claude Code, Codex, and OpenCode running in Cloudflare containers.

Jode gives each agent its own hosted URL behind Cloudflare Access. The browser starts at `jode.jacquesverre.com` and picks an agent. The desktop app opens the same hosted agents in native panes. All agent containers mount one persisted `/workspace` from R2 through `tigrisfs`.

## Why

Using multiple coding agents today usually means separate apps, terminals, sessions, and local setup. Jode turns them into one cloud-backed workspace:

- one desktop rail for Claude Code, Codex, and OpenCode
- one Cloudflare Access login for every agent
- one shared `/workspace` that persists across container restarts
- agents run remotely, so long tasks do not depend on your laptop
- browser access starts from one simple product selector

## Architecture

```text
Browser
   |
   v
jode.jacquesverre.com
Product Selector Worker
   |
   +--> claude.jode.jacquesverre.com   -> Claude Worker   -> DO -> Container -> /workspace
   +--> codex.jode.jacquesverre.com    -> Codex Worker    -> DO -> Container -> /workspace
   +--> opencode.jode.jacquesverre.com -> OpenCode Worker -> DO -> Container -> /workspace

Desktop app
native rail
   |
   +--> same three hosted agent URLs

/workspace = one R2 bucket mounted in every container with tigrisfs
```

## Commands

```bash
npm run dev              # deploy selector + hosted agents, then launch desktop
JODE_SKIP_DEPLOY=1 npm run dev
npm run dry-run          # validate selector + hosted agents
npm run deploy           # deploy selector + hosted agents
npm run build            # build desktop app
```

## Repo

```text
apps/desktop       Electron shell
apps/selector      Root product selector Worker
apps/claude-code   Claude Code Worker + container
apps/codex         Codex Worker + container
apps/opencode      OpenCode Worker + container
packages/edge      shared Worker auth/runtime helpers
packages/agents    shared agent registry
packages/container-runtime
                   shared container scripts
packages/shell     shared desktop shell UI
```

See [docs/architecture.md](./docs/architecture.md) for production invariants and boundaries.
