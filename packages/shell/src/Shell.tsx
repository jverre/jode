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
import type { AgentInfo, AgentStatus, AuthStatus, ShellHost } from './types'

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
  const [authStatus, setAuthStatus] = useState<AuthStatus>(
    host.signIn && host.onAuthState ? 'signedOut' : 'signedIn'
  )

  useEffect(() => {
    let cancelled = false
    host.listAgents().then((list) => {
      if (cancelled) return
      setAgents(list)
      if (authStatus === 'signedIn' && list.length > 0) select(list[0].id)
    })

    const unsubscribe = host.onAgentState((s) => {
      setStatus((prev) => ({ ...prev, [s.id]: s.status }))
    })

    const unsubscribeAuth = host.onAuthState?.((next) => {
      setAuthStatus(next)
      if (next !== 'signedIn') setActiveId(null)
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeAuth?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (authStatus !== 'signedIn' || activeId || agents.length === 0) return
    select(agents[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, activeId, agents])

  function select(id: string): void {
    if (authStatus !== 'signedIn') return
    setActiveId(id)
    void host.switchAgent(id)
  }

  function signIn(): void {
    void host.signIn?.()
  }

  const active = agents.find((a) => a.id === activeId) ?? null

  if (authStatus !== 'signedIn') {
    return (
      <LoginScreen
        status={authStatus}
        onSignIn={signIn}
      />
    )
  }

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

interface LoginScreenProps {
  status: AuthStatus
  onSignIn: () => void
}

function LoginScreen({ status, onSignIn }: LoginScreenProps): JSX.Element {
  const signingIn = status === 'signingIn'

  return (
    <div className="relative grid h-screen w-screen place-items-center overflow-hidden bg-[#f5f5f4] text-[#171717]">
      <div
        className="region-drag absolute left-0 top-0"
        style={{ right: 0, height: TITLEBAR_HEIGHT }}
      />

      <form
        className="region-no-drag rounded-[8px] border border-[#dedede] bg-white p-6 shadow-sm"
        style={{ width: 'min(calc(100% - 32px), 360px)' }}
        onSubmit={(event) => {
          event.preventDefault()
          onSignIn()
        }}
      >
        <h1 className="mb-2 text-2xl font-bold tracking-normal">Sign in to Jode</h1>
        <p className="mb-6 text-sm leading-6 text-[#666666]">
          Use your Cloudflare Access one-time PIN to unlock all products.
        </p>
        <button
          type="submit"
          disabled={signingIn}
          className="h-11 w-full rounded-[8px] bg-[#171717] px-4 text-sm font-semibold text-white transition hover:bg-[#2f2f2f] disabled:cursor-default disabled:bg-[#8a8a8a]"
        >
          {signingIn ? 'Waiting for PIN' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
