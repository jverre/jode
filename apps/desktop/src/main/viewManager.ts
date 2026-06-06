import { BrowserWindow, WebContentsView } from 'electron'
import type { AgentDef } from './agents'
import { placeholderDataUrl } from './placeholder'

// NOTE: these MUST match src/renderer/src/layout.ts.
/** Sidebar width = RAIL_INSET (10) + ICON_CELL (44). */
export const SIDEBAR_WIDTH = 54
/** Draggable title-bar strip above the pane so it clears the traffic lights. */
export const TITLEBAR_HEIGHT = 32
/** Gap between the agent pane and the window edge on the right / bottom. */
export const MARGIN = 12
/** Width of the renderer-drawn frame border the pane is inset within. */
export const BORDER = 1
/** Square pane corners (matches FRAME_RADIUS = 0 in the renderer). */
export const PANE_RADIUS = 0
/** Content surface colour (= shadcn light --background) shown while loading. */
const SURFACE = '#ffffff'

type AgentStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Owns one WebContentsView per agent. Views are created lazily on first switch,
 * kept alive in the background, shown/hidden on switch, and floated as a rounded
 * "card" inset from the window edges — flush against the sidebar on the left so
 * the active sidebar tab merges into it. Each view gets its own persistent
 * session partition so an agent's cookies/login survive restarts and stay
 * isolated.
 */
export class ViewManager {
  private views = new Map<string, WebContentsView>()
  private activeId: string | null = null

  constructor(
    private readonly win: BrowserWindow,
    private readonly agents: AgentDef[]
  ) {
    win.on('resize', () => this.layout())
    win.on('enter-full-screen', () => this.layout())
    win.on('leave-full-screen', () => this.layout())
  }

  /** Show the given agent, creating its view on first use. */
  switch(id: string): void {
    const agent = this.agents.find((a) => a.id === id)
    if (!agent) return
    if (!this.views.has(id)) this.create(agent)

    this.activeId = id
    for (const [vid, view] of this.views) view.setVisible(vid === id)
    this.layout()
  }

  private create(agent: AgentDef): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:agent-${agent.id}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    view.setBackgroundColor(SURFACE)
    view.setBorderRadius(PANE_RADIUS)

    const wc = view.webContents
    wc.on('did-start-loading', () => this.emit(agent.id, 'loading'))
    wc.on('did-finish-load', () => this.emit(agent.id, 'ready'))
    wc.on('did-fail-load', () => this.emit(agent.id, 'error'))

    // Real hosted UI when a Worker URL is configured; placeholder until then.
    void wc.loadURL(agent.url ?? placeholderDataUrl(agent))

    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.views.set(agent.id, view)
    return view
  }

  private layout(): void {
    if (!this.activeId) return
    const view = this.views.get(this.activeId)
    if (!view) return
    // Inset 1px inside the renderer-drawn bordered frame so its border shows
    // as a ring around the pane.
    const [width, height] = this.win.getContentSize()
    const x = SIDEBAR_WIDTH + BORDER
    const y = TITLEBAR_HEIGHT + BORDER
    view.setBounds({
      x,
      y,
      width: Math.max(0, width - MARGIN - BORDER - x),
      height: Math.max(0, height - MARGIN - BORDER - y)
    })
  }

  private emit(id: string, status: AgentStatus): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.send('agent:state', { id, status })
  }
}
