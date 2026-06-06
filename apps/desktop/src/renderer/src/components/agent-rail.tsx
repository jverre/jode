import { cn } from '@/lib/utils'
import { LOGOS } from '@/logos'
import { ICON_CELL, ICON_SIZE, RAIL_INSET } from '@/layout'
import type { AgentState } from '@/jode'

interface AgentItemProps {
  id: string
  name: string
  active: boolean
  status?: AgentState['status']
  onSelect: (id: string) => void
}

/**
 * A single workspace in the rail: a square selector (ICON_CELL) holding a
 * centered icon (ICON_SIZE). The icon sits at a constant position in both
 * states. When active, the square's surface extends 1px past the sidebar to
 * overlap the pane's frame border and is bordered on its three outer sides, so
 * the pane's border wraps around it and it merges into the content — that merge
 * is the only selection indicator. Unselected items have no border.
 */
export function AgentItem({ id, name, active, status, onSelect }: AgentItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      title={name}
      aria-label={name}
      aria-pressed={active}
      style={{
        marginLeft: RAIL_INSET,
        height: ICON_CELL,
        // +1 only when active: overlaps the frame border for a seamless merge,
        // without visibly changing the square's size.
        width: active ? ICON_CELL + 1 : ICON_CELL
      }}
      className={cn(
        'region-no-drag relative flex shrink-0 items-center justify-start self-start transition-colors',
        active
          ? 'z-10 rounded-l-[12px] border border-r-0 bg-background'
          : 'rounded-[12px] hover:bg-accent'
      )}
    >
      <span
        style={{ width: ICON_CELL, height: ICON_CELL }}
        className="flex shrink-0 items-center justify-center"
      >
        <img
          src={LOGOS[id]}
          alt={name}
          draggable={false}
          style={{ width: ICON_SIZE, height: ICON_SIZE }}
          className={cn('select-none object-contain', status === 'loading' && 'animate-pulse')}
        />
      </span>
    </button>
  )
}
