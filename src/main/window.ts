import { app, BrowserWindow, shell } from 'electron'
import { CH, VERSION_ARG } from './channels'
import { APP_ORIGIN } from './protocol'
import { paths } from './paths'

let mainWindow: BrowserWindow | null = null
let allowClose = false
let rendererReady = false
const pendingOpen: string[] = []

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined

/** origins whose frames may call IPC */
export function trustedOrigins(): string[] {
  const list = [APP_ORIGIN]
  if (devUrl) {
    try {
      list.push(new URL(devUrl).origin)
    } catch {
      /* ignore */
    }
  }
  return list
}

export function isTrustedUrl(url: string | undefined | null): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const origin = u.protocol === 'app:' ? `app://${u.host}` : u.origin
    return trustedOrigins().includes(origin)
  } catch {
    return false
  }
}

/** «Вид» menu of the header: full screen; reload and devtools only in a dev run, as in the native menu */
export function runWindowCommand(cmd: unknown): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (cmd === 'fullscreen') win.setFullScreen(!win.isFullScreen())
  else if (app.isPackaged) return
  else if (cmd === 'reload') win.webContents.reload()
  else if (cmd === 'devtools') win.webContents.toggleDevTools()
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const w = getMainWindow()
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

/** queue a file for the renderer (delivered after the page has loaded) */
export function requestOpenFile(path: string): void {
  if (rendererReady) sendToRenderer(CH.evOpenFile, path)
  else pendingOpen.push(path)
  const w = getMainWindow()
  if (w) {
    if (w.isMinimized()) w.restore()
    w.focus()
  }
}

export function confirmClose(): void {
  const w = getMainWindow()
  if (!w) return
  allowClose = true
  w.close()
}

/** the app is about to quit for an update install: let the window close without asking the renderer */
export function allowQuitWithoutPrompt(on: boolean): void {
  allowClose = on
}

export function setWindowTitle(title: unknown, dirty: unknown): void {
  const w = getMainWindow()
  if (!w) return
  const t = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Без названия'
  w.setTitle(`${dirty ? '● ' : ''}${t} — doplan`)
  w.setDocumentEdited(!!dirty)
}

const reloadHooks: (() => void)[] = []
/** the renderer starts (re)loading: whatever it held in memory (a running agent turn, its open question) is gone */
export function onRendererReload(cb: () => void): void {
  reloadHooks.push(cb)
}

export function createMainWindow(): BrowserWindow {
  allowClose = false
  rendererReady = false
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'doplan',
    backgroundColor: '#16181d',
    // packaged builds take the icon embedded in doplan.exe; unpackaged runs would show Electron's own
    ...(paths.devIcon ? { icon: paths.devIcon } : {}),
    autoHideMenuBar: false,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments: [`${VERSION_ARG}${app.getVersion()}`],
    },
  })
  mainWindow = win
  // the app has its own menus in the header; the native one (Windows/Linux) stays hidden — Alt does not
  // bring it back, it is a modifier on the plan — but its accelerators keep working
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)

  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  win.webContents.on('did-finish-load', () => {
    rendererReady = true
    while (pendingOpen.length) win.webContents.send(CH.evOpenFile, pendingOpen.shift())
  })
  win.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  // the page itself is replaced (a reload, a crash recovery); not a frame inside it nor an in-page jump
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) for (const cb of reloadHooks) cb()
  })

  // navigation lock-down
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault()
  })
  win.webContents.on('will-redirect', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      // web links only (product pages in the estimate may be plain http)
      if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.toString())
    } catch {
      /* ignore */
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  // close-confirmation handshake: renderer answers with confirmClose()
  win.on('close', (e) => {
    if (allowClose) return
    const wc = win.webContents
    if (wc.isDestroyed() || wc.isCrashed() || !rendererReady) return
    e.preventDefault()
    wc.send(CH.evCloseRequest)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[doplan] renderer gone:', details.reason, details.exitCode)
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      rendererReady = false
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload()
      }, 500)
    }
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)

  return win
}

/** true once the renderer confirmed closing (user saved or discarded changes) */
export function closeWasConfirmed(): boolean {
  return allowClose
}
