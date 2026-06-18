import type { AgentInfo, ShellHost } from '@jode/shell'
import { AGENTS, agentInfo } from '@jode/agents'

/** The rail's agents, from the shared registry. */
const WEB_AGENTS: AgentInfo[] = AGENTS.map(agentInfo)

/** The hosted Worker URL to frame for a given agent id. */
export function agentUrl(id: string): string | undefined {
  return AGENTS.find((a) => a.id === id)?.url
}

/**
 * Web pane host: panes are <iframe>s pointing at each agent's hosted Worker —
 * the same origins the desktop app frames natively. Selection lives in the
 * Shell, so `switchAgent` is a no-op (the Panes component derives the visible
 * iframe from the active agent). There's no live per-agent state on web yet; a
 * later pass could surface load / Access-redirect events as status dots.
 */
export const iframeHost: ShellHost = {
  listAgents: async () => WEB_AGENTS,
  switchAgent: () => {},
  onAgentState: () => () => {}
}
