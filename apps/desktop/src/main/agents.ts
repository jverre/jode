// The agents jode hosts. For now Claude Code + Codex, each with no `url`
// (so they render a local placeholder). When the Cloudflare-hosted web UI
// exists, set `url` to the agent's Worker URL and the same WebContentsView
// will load the real app. This list will eventually move to packages/agents.

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

export const AGENTS: AgentDef[] = [
  { id: 'claude-code', name: 'Claude Code', shortLabel: 'CC', accent: '#D97757' },
  { id: 'codex', name: 'Codex', shortLabel: 'Cx', accent: '#10A37F' },
  { id: 'opencode', name: 'OpenCode', shortLabel: 'OC', accent: '#7C5CFF' }
]

/** Shape sent to the renderer (no internals beyond what the rail needs). */
export function agentInfo(a: AgentDef) {
  return { id: a.id, name: a.name, shortLabel: a.shortLabel, accent: a.accent }
}
