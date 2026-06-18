import { useEffect, useState } from 'react'
import type { AgentInfo } from '@jode/shell'
import { agentUrl } from './iframe-host'

/**
 * The web pane area: one <iframe> per agent. An agent's iframe is mounted lazily
 * on first activation and then kept alive — only its visibility toggles — so
 * switching agents never reloads or re-authenticates a pane. This mirrors the
 * desktop's lazy WebContentsView create + setVisible behaviour.
 */
export function Panes({
  active,
  agents
}: {
  active: AgentInfo | null
  agents: AgentInfo[]
}): JSX.Element {
  const [mounted, setMounted] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!active) return
    setMounted((prev) => (prev.has(active.id) ? prev : new Set(prev).add(active.id)))
  }, [active?.id])

  return (
    <>
      {agents
        .filter((a) => a.hosted && mounted.has(a.id))
        .map((a) => (
          <iframe
            key={a.id}
            src={agentUrl(a.id)}
            title={a.name}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 0,
              display: a.id === active?.id ? 'block' : 'none'
            }}
          />
        ))}
    </>
  )
}
