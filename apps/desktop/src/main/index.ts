import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { AGENTS, agentInfo } from './agents'
import { ViewManager } from './viewManager'

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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  views = new ViewManager(win, AGENTS)

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
