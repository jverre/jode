import { BrowserWindow, WebContentsView, session } from 'electron'
import type { AgentDef } from './agents'
import { placeholderDataUrl } from './placeholder'
import { preferDetachedDevTools } from './devtools'

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

/**
 * The genuine Claude Desktop user-agent. The hosted claude.ai SPA picks
 * desktop-vs-web mode from `navigator.userAgent` (`/\b(?:Claude|Electron)\//i`)
 * AND gates the desktop Chat/Cowork surface behind appVersion-targeted statsig
 * flags — so the version tokens must match a real desktop build, not jode's own
 * Electron. The in-page bridge-client only spoofs this when the UA lacks
 * `Electron/`; jode's WebContentsView already carries `Electron/<jode>`, which
 * trips that guard and skips the spoof, leaving the SPA in web mode (the
 * "Download Desktop app" page). Setting it here forces desktop rendering
 * independent of that guard. Keep in lockstep with bridge-client.js's
 * spoofDesktopUserAgent().
 */
const CLAUDE_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Claude/1.10628.0 Chrome/146.0.7680.216 Electron/41.6.1 Safari/537.36'

type AgentStatus = 'idle' | 'loading' | 'ready' | 'login' | 'error'

/** Partition name for an agent's persistent, isolated session (cookies/login). */
const partitionFor = (id: string): string => `persist:agent-${id}`

/**
 * True when the web view is sitting on a Cloudflare Access login surface — the
 * team's `*.cloudflareaccess.com` pages or the `/cdn-cgi/access/` flow on the
 * app's own domain. Used to surface a "needs sign-in" state in the rail.
 */
function isAccessLoginUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    return u.hostname.endsWith('.cloudflareaccess.com') || u.pathname.startsWith('/cdn-cgi/access/')
  } catch {
    return false
  }
}

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
        partition: partitionFor(agent.id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    view.setBackgroundColor(SURFACE)
    view.setBorderRadius(PANE_RADIUS)

    const wc = view.webContents
    // Force the genuine Claude Desktop UA so the hosted SPA renders the desktop
    // app, not the web "Download Desktop app" page (see CLAUDE_DESKTOP_UA). Set
    // on the webContents so it applies to every navigation in this view,
    // including the Cloudflare Access login chain.
    wc.setUserAgent(CLAUDE_DESKTOP_UA)
    // Inspecting an agent pane: keep its DevTools detached so they don't end up
    // hidden behind this native view.
    preferDetachedDevTools(wc)
    wc.on('did-start-loading', () => this.emit(agent.id, 'loading'))
    // The Cloudflare Access login runs as a chain of top-level navigations inside
    // this same view (Access redirects the Worker URL → its login page → back).
    // Classify each landing so the rail reflects "signed-in" vs "needs sign-in".
    wc.on('did-navigate', (_e, url) => this.classify(agent.id, url))
    wc.on('did-navigate-in-page', (_e, url) => this.classify(agent.id, url))
    wc.on('did-finish-load', () =>
      this.emit(agent.id, isAccessLoginUrl(wc.getURL()) ? 'login' : 'ready')
    )
    // -3 (ERR_ABORTED) is the normal signal for an Access redirect superseding an
    // in-flight load — not an error.
    wc.on('did-fail-load', (_e, code) => {
      if (code !== -3) this.emit(agent.id, 'error')
    })

    // Some IdPs (OAuth) open the login in a popup rather than redirecting in
    // place. Route those into a child window that shares this agent's partition,
    // so the Access cookie it sets is visible to the main view on completion.
    wc.setWindowOpenHandler(({ url }) => {
      if (agent.url) this.openAuthPopup(agent, url)
      return { action: 'deny' }
    })

    // Real hosted UI when a Worker URL is configured; placeholder until then.
    void wc.loadURL(agent.url ?? placeholderDataUrl(agent))

    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.views.set(agent.id, view)
    return view
  }

  /** Reload an agent view (used for reconnect after a drop). */
  reload(id: string): void {
    this.views.get(id)?.webContents.reload()
  }

  /**
   * Sign out of a hosted agent: clear its partition's cookies so the next load
   * hits Cloudflare Access fresh, then reload (which lands on the login page).
   */
  async signOut(id: string): Promise<void> {
    const view = this.views.get(id)
    if (!view) return
    await session.fromPartition(partitionFor(id)).clearStorageData({ storages: ['cookies'] })
    view.webContents.reload()
  }

  private classify(id: string, url: string): void {
    if (isAccessLoginUrl(url)) this.emit(id, 'login')
  }

  /** Open an OAuth/Access popup in a child window sharing the agent partition. */
  private openAuthPopup(agent: AgentDef, url: string): void {
    const appOrigin = (() => {
      try {
        return new URL(agent.url as string).origin
      } catch {
        return null
      }
    })()
    const popup = new BrowserWindow({
      width: 480,
      height: 660,
      parent: this.win,
      title: `Sign in — ${agent.name}`,
      webPreferences: {
        partition: partitionFor(agent.id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    void popup.loadURL(url)
    // When the popup returns to the app origin, Access has set the cookie in the
    // shared partition — close it and reload the agent view to pick it up.
    popup.webContents.on('did-navigate', (_e, navUrl) => {
      if (appOrigin && navUrl.startsWith(appOrigin)) popup.close()
    })
    popup.on('closed', () => this.views.get(agent.id)?.webContents.reload())
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
