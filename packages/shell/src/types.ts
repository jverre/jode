// Shell types. The shell renders the rail + window chrome and is deliberately
// host-agnostic: it never imports Electron or touches `window.jode` directly.
// A host supplies the agent list, switching, and state.

export interface AgentInfo {
  id: string
  name: string
  /** 1–2 char badge shown in the rail. */
  shortLabel: string
  /** Accent colour for the rail badge. */
  accent: string
  /** Hosted Worker URL for the agent UI. */
  url: string
}

export type AgentStatus = 'idle' | 'loading' | 'ready' | 'login' | 'error'

export interface AgentState {
  id: string
  /** 'login' = the hosted UI is on the Cloudflare Access sign-in page. */
  status: AgentStatus
}

/**
 * The seam between the shared shell and its environment. Desktop implements this
 * over `window.jode` (IPC -> native WebContentsView panes). The rail only ever
 * talks to a `ShellHost`.
 */
export interface ShellHost {
  /** The agents to show in the rail, in order. */
  listAgents(): Promise<AgentInfo[]>
  /** Make `id` the active agent (show its pane). */
  switchAgent(id: string): void | Promise<void>
  /** Subscribe to per-agent load-state changes. Returns an unsubscribe fn. */
  onAgentState(cb: (state: AgentState) => void): () => void
}
