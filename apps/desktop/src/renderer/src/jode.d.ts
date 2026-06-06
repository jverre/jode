export interface AgentInfo {
  id: string
  name: string
  shortLabel: string
  accent: string
}

export interface AgentState {
  id: string
  status: 'idle' | 'loading' | 'ready' | 'error'
}

declare global {
  interface Window {
    jode: {
      listAgents(): Promise<AgentInfo[]>
      switchAgent(id: string): Promise<void>
      onAgentState(cb: (state: AgentState) => void): () => void
    }
  }
}

export {}
