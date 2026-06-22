export interface AgentInfo {
  id: string
  name: string
  shortLabel: string
  accent: string
  /** Hosted Worker URL for the agent UI. */
  url: string
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
      signIn(): Promise<void>
      reloadAgent(id: string): Promise<void>
      signOutAgent(id: string): Promise<void>
      onAgentState(cb: (state: AgentState) => void): () => void
      onAuthState(cb: (status: 'signedOut' | 'signingIn' | 'signedIn') => void): () => void
    }
  }
}

export {}
