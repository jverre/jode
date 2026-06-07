import type { WebContents } from 'electron'

const normalized = new WeakSet<WebContents>()

/**
 * Force DevTools to open detached (in their own window) for this webContents.
 *
 * The agent panes are native `WebContentsView`s positioned with absolute
 * `setBounds`, and a native view draws on top of a BrowserWindow's *docked*
 * DevTools — so docked DevTools end up hidden behind the pane (the overlap).
 * Electron exposes no size for docked DevTools, so we can't resize the pane
 * around them; detaching is the standard fix.
 *
 * Electron remembers the last dock state per webContents, so this one-time
 * reopen makes every later open detached too — at most one brief flash, the
 * first time DevTools are opened. The `normalized` guard prevents the
 * close→reopen from looping on its own `devtools-opened` event.
 */
export function preferDetachedDevTools(wc: WebContents): void {
  wc.on('devtools-opened', () => {
    if (normalized.has(wc)) return
    normalized.add(wc)
    wc.closeDevTools()
    wc.openDevTools({ mode: 'detach' })
  })
}
