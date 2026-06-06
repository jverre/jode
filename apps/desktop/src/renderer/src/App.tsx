import { useEffect, useState } from 'react'
import { AgentItem } from '@/components/agent-rail'
import { FIRST_ITEM_TOP, FRAME_RADIUS, MARGIN, SIDEBAR_WIDTH, TITLEBAR_HEIGHT } from '@/layout'
import type { AgentInfo, AgentState } from '@/jode'

export function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, AgentState['status']>>({})

  useEffect(() => {
    let cancelled = false
    window.jode.listAgents().then((list) => {
      if (cancelled) return
      setAgents(list)
      if (list.length > 0) select(list[0].id)
    })

    const unsubscribe = window.jode.onAgentState((s) => {
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
    void window.jode.switchAgent(id)
  }

  return (
    <div className="region-drag relative h-screen w-screen overflow-hidden">
      {/* Bordered frame for the agent pane. The native WebContentsView floats 1px
          inside it, so only this frame's border shows — a light ring around the
          pane that the active tab merges into. */}
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
