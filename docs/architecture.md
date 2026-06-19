# Jode Production Architecture

Jode has two client surfaces, one root selector, and three hosted Cloudflare agent apps:

- `apps/desktop`: Electron shell with one native `WebContentsView` per agent.
- `apps/selector`: tiny Access-gated product selector at `jode.jacquesverre.com`.
- `apps/claude-code`: Claude Code Electron rehost behind Cloudflare Access.
- `apps/codex`: Codex Electron rehost behind Cloudflare Access.
- `apps/opencode`: authenticated reverse proxy to `opencode serve`.

Browser access starts at `jode.jacquesverre.com`. The selector renders static
HTML and redirects `/claude`, `/codex`, and `/opencode` to the hosted agent URLs:
`claude.jode.jacquesverre.com`, `codex.jode.jacquesverre.com`, and
`opencode.jode.jacquesverre.com`. There is no iframe shell or shared web app
runtime.

## Shared Packages

- `@jode/agents` is the single agent registry. Agent URLs are required; production does not have a placeholder-agent mode.
- `@jode/edge` is the Worker-facing edge package. It owns Cloudflare Access enforcement, Durable Object lookup helpers, no-store responses, and shared workspace env validation.
- `@jode/auth` is low-level Cloudflare Access JWT verification used by `@jode/edge`.
- `@jode/container-runtime` stores shared container runtime scripts. `tools/sync-runtime.mjs` materializes app-local `.runtime/` copies before deploy and dry-run.

## Development Flow

- `npm run dev` is cloud-backed: it deploys the selector and hosted agent apps, then starts the local desktop shell against the hosted agent URLs.
- Set `JODE_SKIP_DEPLOY=1` to start the local desktop against the currently deployed hosted stack.

## Production Invariants

- Every request to the selector and agent Workers is gated by Cloudflare Access.
- Claude Code, Codex, and OpenCode each run in their own Durable Object-backed container.
- All agent containers mount the same R2 bucket at `/workspace` through `tigrisfs`.
- Production must not silently run with an ephemeral `/workspace`. Missing R2 config, missing FUSE, missing `tigrisfs`, or mount failure prevents the container from starting successfully.

## Agent Boundaries

- Claude Code owns Claude-specific upstream tunneling, browser bridge behavior, and filtered durable cookie persistence.
- Codex owns Codex-specific preload/MessagePort bridge behavior, the Codex CLI runtime, and Codex credential persistence.
- OpenCode owns only its container runtime and reverse proxy path because OpenCode already serves its own web UI.
