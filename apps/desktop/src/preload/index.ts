import { contextBridge, ipcRenderer } from 'electron'

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

// The only surface the renderer can touch. No Node, no direct ipcRenderer.
const api = {
  listAgents: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:list'),
  switchAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:switch', id),
  /** Reload an agent's web view (reconnect). */
  reloadAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:reload', id),
  /** Sign out: clear the agent's Access cookies and return to the login page. */
  signOutAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:signOut', id),
  /** Subscribe to agent load-state changes. Returns an unsubscribe fn. */
  onAgentState: (cb: (state: AgentState) => void): (() => void) => {
    const listener = (_e: unknown, state: AgentState) => cb(state)
    ipcRenderer.on('agent:state', listener)
    return () => ipcRenderer.removeListener('agent:state', listener)
  }
}

contextBridge.exposeInMainWorld('jode', api)

export type JodeApi = typeof api
