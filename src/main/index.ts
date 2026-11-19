/**
 * doplan main process: thin — windows, protocols, IPC router, menus, settings, file IO.
 * Everything that must happen before `ready` (switches, privileged schemes, single-instance lock)
 * runs synchronously at module top level.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as nodeModule from 'node:module'
import { app, BrowserWindow, session } from 'electron'
import { grantPath } from './access'
import { ensureLibrary } from './catalog'
import { buildMenu, showTextContextMenu } from './menu'
import { paths } from './paths'
import { initProjectStore, projectFileFromArgv } from './project'
import { registerProtocolHandlers, registerSchemes } from './protocol'
import { registerIpc } from './ipc'
// ── ai-chat block ──
import { registerAiChat, shutdownAiChat } from './aichat'
import { registerGithubIpc, shutdownGithub } from './githubSync'
// ── end ai-chat block ──
import { getSettings, onSettingsChanged } from './settings'
import { getUpdateState, initUpdater, onUpdateState, openReleasePage } from './updater'
import { registerPages } from './pages'
import { registerRecentIpc } from './recent'
import { updateMenuAction } from '../shared/updater'
import { closeWasConfirmed, createMainWindow, getMainWindow, isTrustedUrl, requestOpenFile } from './window'

// ───────────── pre-ready ─────────────

try {
  const enable = (nodeModule as unknown as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache
  enable?.(paths.v8Cache)
} catch {
  /* compile cache is an optimisation only */
}

const safeMode = process.argv.includes('--safe-mode') || process.env['DOPLAN_SAFE_MODE'] === '1'
if (safeMode) {
  app.disableHardwareAcceleration()
} else {
  app.commandLine.appendSwitch('force_high_performance_gpu')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-features', 'WebGPUDeveloperFeatures')
}

registerSchemes()

if (process.platform === 'win32') app.setAppUserModelId('com.doplan.app')

const gotLock = app.requestSingleInstanceLock()

function resolveArgFile(argv: string[], cwd?: string): string | null {
  const f = projectFileFromArgv(argv)
  if (!f) return null
  const candidates = cwd ? [f, join(cwd, f)] : [f]
  return candidates.find((c) => existsSync(c)) ?? null
}

function openFromArgv(argv: string[], cwd?: string): void {
  const file = resolveArgFile(argv, cwd)
  if (!file) return
  grantPath(file)
  requestOpenFile(file)
}

let menuArgs: { lang: 'ru' | 'en'; recent: { path: string; name: string }[] } | null = null

function rebuildMenu(lang: 'ru' | 'en', recent: { path: string; name: string }[]): void {
  menuArgs = { lang, recent }
  buildMenu(
    lang,
    recent,
    (p) => {
      grantPath(p)
      requestOpenFile(p)
    },
    updateMenuAction(getUpdateState()),
    (v) => void openReleasePage(v),
  )
}

function hardenSessions(): void {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(allowed.has(permission) && isTrustedUrl(wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return allowed.has(permission) && isTrustedUrl(origin)
  })
}

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const w = getMainWindow()
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
    openFromArgv(argv, cwd)
  })

  // macOS-style open-file (also harmless elsewhere)
  app.on('open-file', (e, path) => {
    e.preventDefault()
    grantPath(path)
    requestOpenFile(path)
  })

  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') console.error('[doplan] GPU process gone:', details.reason, details.exitCode)
  })

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault())
    wc.on('context-menu', (_ev, params) => showTextContextMenu(wc, params))
  })

  app.whenReady().then(async () => {
    hardenSessions()
    registerProtocolHandlers()
    registerIpc()
    registerAiChat() // ai-chat
    registerGithubIpc() // github
    initUpdater()
    registerPages()
    registerRecentIpc() // welcome screen
    await Promise.all([initProjectStore(), ensureLibrary()])

    const s = await getSettings()
    rebuildMenu(s.lang, s.recent)
    onSettingsChanged((next) => rebuildMenu(next.lang, next.recent))
    // progress events are frequent: rebuild only when the Help menu's update item changes
    let menuKey = JSON.stringify(updateMenuAction(getUpdateState()))
    onUpdateState((st) => {
      const key = JSON.stringify(updateMenuAction(st))
      if (key === menuKey || !menuArgs) return
      menuKey = key
      rebuildMenu(menuArgs.lang, menuArgs.recent)
    })

    createMainWindow()
    openFromArgv(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // a confirmed close means the user saved or discarded: the crash-recovery snapshot is obsolete
  app.on('will-quit', () => {
    shutdownAiChat() // ai-chat: stop agents, kill their processes
    shutdownGithub() // github: stop a pending sign-in
    if (!closeWasConfirmed()) return
    try {
      rmSync(join(paths.recovery, 'recovery.json'), { force: true })
    } catch {
      /* ignore */
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
