import { contextBridge, ipcRenderer } from 'electron'

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

// The only surface the renderer can touch. No Node, no direct ipcRenderer.
const api = {
  listAgents: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:list'),
  switchAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:switch', id),
  /** Subscribe to agent load-state changes. Returns an unsubscribe fn. */
  onAgentState: (cb: (state: AgentState) => void): (() => void) => {
    const listener = (_e: unknown, state: AgentState) => cb(state)
    ipcRenderer.on('agent:state', listener)
    return () => ipcRenderer.removeListener('agent:state', listener)
  }
}

contextBridge.exposeInMainWorld('jode', api)

export type JodeApi = typeof api
