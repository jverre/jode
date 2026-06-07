// The agents jode hosts. For now Claude Code + Codex + OpenCode. Each agent's
// hosted web UI lives at a Cloudflare Worker URL (see apps/claude-code); set it
// per-agent via an env var so it's not hardcoded to one deployment:
//
//   JODE_CLAUDE_CODE_URL=https://jode-claude-code.<subdomain>.workers.dev
//
// An agent with no resolved `url` renders the local placeholder. When a URL is
// set, the same WebContentsView loads the real app and drives the Cloudflare
// Access login in-pane. This list will eventually move to packages/agents.

export interface AgentDef {
  /** Stable id; also used as the persistent session partition key. */
  id: string
  /** Display name (tooltip). */
  name: string
  /** 1–2 char badge shown in the rail. */
  shortLabel: string
  /** Accent colour for the rail badge. */
  accent: string
  /** Cloudflare Worker URL of the hosted agent UI. Undefined → placeholder. */
  url?: string
}

/** Resolve a per-agent Worker URL from `JODE_<ID>_URL` (id uppercased, `-`→`_`). */
function resolveUrl(id: string): string | undefined {
  const key = `JODE_${id.replace(/-/g, '_').toUpperCase()}_URL`
  const value = process.env[key]?.trim()
  return value ? value : undefined
}

export const AGENTS: AgentDef[] = [
  { id: 'claude-code', name: 'Claude Code', shortLabel: 'CC', accent: '#D97757' },
  { id: 'codex', name: 'Codex', shortLabel: 'Cx', accent: '#10A37F' },
  { id: 'opencode', name: 'OpenCode', shortLabel: 'OC', accent: '#7C5CFF' }
].map((a) => ({ ...a, url: resolveUrl(a.id) }))

/** Shape sent to the renderer (no internals beyond what the rail needs). */
export function agentInfo(a: AgentDef) {
  return { id: a.id, name: a.name, shortLabel: a.shortLabel, accent: a.accent, hosted: !!a.url }
}
