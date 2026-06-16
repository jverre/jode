import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { AGENTS, agentInfo } from './agents'
import { ViewManager, TITLEBAR_HEIGHT } from './viewManager'
import { preferDetachedDevTools } from './devtools'

let win: BrowserWindow | null = null
let views: ViewManager | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#fafafa',
    show: false,
    // macOS: hide the title bar but keep the native traffic lights, dragging the
    // custom strip via `-webkit-app-region: drag` (see App.tsx). Use 'hidden',
    // NOT 'hiddenInset': hiddenInset + a child WebContentsView is a confirmed
    // Electron bug (electron#26114) where the drag region kills the child view's
    // clicks. With 'hidden' the traffic lights sit at the very top-left, so nudge
    // them down to stay centred in our TITLEBAR_HEIGHT strip.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 12, y: Math.round((TITLEBAR_HEIGHT - 14) / 2) }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  views = new ViewManager(win, AGENTS)

  // Shell DevTools detached too, else the agent pane covers them when docked.
  preferDetachedDevTools(win.webContents)

  win.once('ready-to-show', () => win?.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
    views = null
  })
}

app.whenReady().then(() => {
  ipcMain.handle('agents:list', () => AGENTS.map(agentInfo))
  ipcMain.handle('agents:switch', (_event, id: string) => {
    views?.switch(id)
  })
  ipcMain.handle('agents:reload', (_event, id: string) => {
    views?.reload(id)
  })
  ipcMain.handle('agents:signOut', (_event, id: string) => views?.signOut(id))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
