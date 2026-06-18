// @jode/shell — the shared jode UI shell (rail + window chrome), rendered
// identically by the desktop app and the web app. Pane content is supplied by
// the host (native WebContentsViews on desktop, <iframe>s on web) so everything
// except the panes is one codebase.

export { Shell, type ShellProps } from './Shell'
export { AgentItem } from './AgentRail'
export type { AgentInfo, AgentState, AgentStatus, ShellHost } from './types'
export * from './layout'
export { LOGOS } from './logos'
