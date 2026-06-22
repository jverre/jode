import { BrowserWindow, WebContentsView, session } from 'electron'
import type { AgentDef } from './agents'
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
type AuthStatus = 'signedOut' | 'signingIn' | 'signedIn'

/**
 * ONE shared persistent session partition for every agent pane.
 *
 * All three agents sit behind a SINGLE Cloudflare Access application (same
 * ACCESS_AUD / team domain over *.jode.jacquesverre.com — see each app's
 * wrangler.toml), so a single Access identity already authorizes all of them.
 * The only thing that was forcing a separate login per pane was giving each
 * WebContentsView its own cookie jar: the `*.cloudflareaccess.com` team-session
 * cookie — what lets Access silently mint a per-host token without re-prompting —
 * was siloed per pane.
 *
 * Sharing one jar fixes that: the first pane's login stores the team-session
 * cookie here; switching to another agent (a different jode subdomain) lets
 * Access reuse it and redirect straight back, no second prompt. Per-app web
 * sessions stay isolated regardless — cookies/localStorage are scoped by origin
 * within the partition, so claude.ai's, Codex's and OpenCode's sessions never
 * bleed into each other; only the common Access cookie is shared, which is the
 * intent (a single allowed identity gating all three).
 */
const SHARED_PARTITION = 'persist:jode'

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
 * the active sidebar tab merges into it. All views share ONE persistent session
 * partition (SHARED_PARTITION) so a single Cloudflare Access login covers every
 * agent; per-app web sessions stay isolated by origin within that jar.
 */
export class ViewManager {
  private views = new Map<string, WebContentsView>()
  private activeId: string | null = null
  private authWindow: BrowserWindow | null = null
  private authCompleted = false

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

  /** Start the single app-level Cloudflare Access sign-in flow. */
  signIn(url: string): void {
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      this.authWindow.focus()
      return
    }

    this.authCompleted = false
    this.emitAuth('signingIn')

    const appOrigin = new URL(url).origin
    const popup = new BrowserWindow({
      width: 520,
      height: 700,
      parent: this.win,
      title: 'Sign in to Jode',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: SHARED_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    this.authWindow = popup

    const completeIfAuthenticated = (navUrl: string): void => {
      if (sameOrigin(navUrl, appOrigin) && !isAccessLoginUrl(navUrl)) {
        this.authCompleted = true
        this.emitAuth('signedIn')
        popup.close()
      }
    }

    popup.webContents.on('did-navigate', (_e, navUrl) => completeIfAuthenticated(navUrl))
    popup.webContents.on('did-navigate-in-page', (_e, navUrl) => completeIfAuthenticated(navUrl))
    popup.webContents.on('did-finish-load', () => completeIfAuthenticated(popup.webContents.getURL()))
    popup.on('closed', () => {
      if (this.authWindow === popup) this.authWindow = null
      if (!this.authCompleted) this.emitAuth('signedOut')
    })

    void popup.loadURL(url)
  }

  private create(agent: AgentDef): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: SHARED_PARTITION,
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
      this.openAuthPopup(agent, url)
      return { action: 'deny' }
    })

    void wc.loadURL(agent.url)

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
   * Sign out. Because all panes share one Access identity (SHARED_PARTITION),
   * this is a single global sign-out: clear the shared cookie jar so the next
   * load hits Cloudflare Access fresh, then reload every live view so each rail
   * tab reflects the signed-out state (the `id` arg is kept for the IPC shape).
   */
  async signOut(_id: string): Promise<void> {
    await session.fromPartition(SHARED_PARTITION).clearStorageData({ storages: ['cookies'] })
    for (const view of this.views.values()) view.setVisible(false)
    this.emitAuth('signedOut')
    for (const view of this.views.values()) view.webContents.reload()
  }

  private classify(id: string, url: string): void {
    if (isAccessLoginUrl(url)) this.emit(id, 'login')
  }

  /** Open an OAuth/Access popup in a child window sharing the agent partition. */
  private openAuthPopup(agent: AgentDef, url: string): void {
    const appOrigin = new URL(agent.url).origin
    const popup = new BrowserWindow({
      width: 480,
      height: 660,
      parent: this.win,
      title: `Sign in — ${agent.name}`,
      webPreferences: {
        partition: SHARED_PARTITION,
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

  private emitAuth(status: AuthStatus): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.send('auth:state', status)
  }
}

function sameOrigin(rawUrl: string, expectedOrigin: string): boolean {
  try {
    return new URL(rawUrl).origin === expectedOrigin
  } catch {
    return false
  }
}
