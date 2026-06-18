import { Shell, type ShellHost } from '@jode/shell'

/**
 * Desktop pane host: the shared rail drives native WebContentsView panes over
 * IPC (`window.jode`, see preload). `renderPane` is intentionally omitted — on
 * desktop a native view floats over the shell's empty pane slot, so the shell
 * draws only the chrome. (Web supplies an <iframe> renderPane instead.)
 */
const nativeHost: ShellHost = {
  listAgents: () => window.jode.listAgents(),
  switchAgent: (id) => window.jode.switchAgent(id),
  onAgentState: (cb) => window.jode.onAgentState(cb)
}

export function App(): JSX.Element {
  return <Shell host={nativeHost} />
}
