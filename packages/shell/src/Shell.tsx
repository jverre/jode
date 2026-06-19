import { useEffect, useState, type ReactNode } from 'react'
import { AgentItem } from './AgentRail'
import {
  BORDER,
  FIRST_ITEM_TOP,
  FRAME_RADIUS,
  MARGIN,
  SIDEBAR_WIDTH,
  TITLEBAR_HEIGHT
} from './layout'
import type { AgentInfo, AgentStatus, ShellHost } from './types'

export interface ShellProps {
  /** Wires the rail to a pane implementation. */
  host: ShellHost
  /**
   * Renders the active agent's pane content inside the framed slot. Desktop
   * returns `null` because a native WebContentsView floats over the slot.
   */
  renderPane?: (active: AgentInfo | null, agents: AgentInfo[]) => ReactNode
}

/**
 * The shared jode shell: the rail + window chrome.
 * It owns selection/state and delegates only the pane content to the host.
 */
export function Shell({ host, renderPane }: ShellProps): JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, AgentStatus>>({})

  useEffect(() => {
    let cancelled = false
    host.listAgents().then((list) => {
      if (cancelled) return
      setAgents(list)
      if (list.length > 0) select(list[0].id)
    })

    const unsubscribe = host.onAgentState((s) => {
      setStatus((prev) => ({ ...prev, [s.id]: s.status }))
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function select(id: string): void {
    setActiveId(id)
    void host.switchAgent(id)
  }

  const active = agents.find((a) => a.id === activeId) ?? null

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Draggable title-bar strip across the very top: `-webkit-app-region: drag`
          lets the window be moved on desktop (no-op in a browser). Height =
          TITLEBAR_HEIGHT so it never overlaps a pane (their y-origin starts here).
          Safe because the window uses `titleBarStyle: 'hidden'`, not 'hiddenInset'
          — the latter + a child WebContentsView is electron#26114, which made the
          agent panes unclickable. */}
      <div
        className="region-drag absolute left-0 top-0"
        style={{ right: 0, height: TITLEBAR_HEIGHT }}
      />

      {/* Bordered frame for the agent pane. The pane is
          inset BORDER px inside it, so only this frame's border shows — a light
          ring around the pane that the active tab merges into. */}
      <div
        className="region-no-drag absolute border bg-background"
        style={{
          left: SIDEBAR_WIDTH,
          top: TITLEBAR_HEIGHT,
          right: MARGIN,
          bottom: MARGIN,
          borderRadius: FRAME_RADIUS
        }}
      />

      {/* Pane slot — same geometry as ViewManager's native bounds (inset BORDER
          inside the frame). Desktop leaves it empty; a native view floats here. */}
      <div
        className="region-no-drag absolute overflow-hidden"
        style={{
          left: SIDEBAR_WIDTH + BORDER,
          top: TITLEBAR_HEIGHT + BORDER,
          right: MARGIN + BORDER,
          bottom: MARGIN + BORDER
        }}
      >
        {renderPane?.(active, agents)}
      </div>

      <aside className="absolute left-0 top-0 flex h-full flex-col" style={{ width: SIDEBAR_WIDTH }}>
        {/* title-bar strip: clears the traffic lights and the pane's rounded
            top corner so the first item merges into the pane's straight edge */}
        <div className="shrink-0" style={{ height: FIRST_ITEM_TOP }} />

        <nav className="flex flex-1 flex-col gap-1.5">
          {agents.map((a) => (
            <AgentItem
              key={a.id}
              id={a.id}
              name={a.name}
              active={a.id === activeId}
              status={status[a.id]}
              onSelect={select}
            />
          ))}
        </nav>
      </aside>
    </div>
  )
}
