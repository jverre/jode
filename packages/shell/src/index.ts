// @jode/shell — the shared jode UI shell (rail + window chrome), rendered
// identically by host apps. Pane content is supplied by the host so everything
// except the panes is one codebase.

export { Shell, type ShellProps } from './Shell'
export { AgentItem } from './AgentRail'
export type { AgentInfo, AgentState, AgentStatus, ShellHost } from './types'
export * from './layout'
export { LOGOS } from './logos'
