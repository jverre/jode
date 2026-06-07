export interface AgentInfo {
  id: string
  name: string
  shortLabel: string
  accent: string
  /** Whether this agent has a hosted Worker URL (vs. the local placeholder). */
  hosted: boolean
}

export interface AgentState {
  id: string
  /** 'login' = the hosted UI is on the Cloudflare Access sign-in page. */
  status: 'idle' | 'loading' | 'ready' | 'login' | 'error'
}

declare global {
  interface Window {
    jode: {
      listAgents(): Promise<AgentInfo[]>
      switchAgent(id: string): Promise<void>
      reloadAgent(id: string): Promise<void>
      signOutAgent(id: string): Promise<void>
      onAgentState(cb: (state: AgentState) => void): () => void
    }
  }
}

export {}
