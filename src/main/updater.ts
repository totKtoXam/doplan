/**
 * Updates from GitHub Releases (totKtoXam/doplan) via electron-updater.
 *
 * - installed (NSIS) build: checks ~10 s after start and every 6 h, downloads in the background,
 *   installs on «Перезапустить и установить» or silently on the next quit;
 * - portable exe: electron-updater cannot replace it, so it only checks and the UI links to the release;
 * - dev run (`!app.isPackaged`): disabled.
 *
 * Never throws into the app: every failure becomes an `error` state (offline → quiet) and a log line.
 * The feed comes from resources/app-update.yml, written by electron-builder from `publish:`.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { app, shell } from 'electron'
import { autoUpdater, type AppUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import {
  clampPercent,
  detectUpdateMode,
  errorStatus,
  isBusy,
  releaseNotesText,
  releasePageUrl,
  type UpdateState,
  type UpdateStatus,
} from '../shared/updater'
import { CH } from './channels'
import { handleIpc } from './ipc'
import { spawnRelaunchWatcher } from './relaunch'
import { allowQuitWithoutPrompt, sendToRenderer } from './window'

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const LOG_MAX_BYTES = 512 * 1024

/** %APPDATA%\doplan\logs\updater.log — shared with the relaunch watcher; null until initUpdater() */
let logFile: string | null = null

function toFile(level: string, a: unknown[]): void {
  if (!logFile) return
  try {
    let size = 0
    try {
      size = statSync(logFile).size
    } catch {
      /* new file */
    }
    const line = `${new Date().toISOString()} ${level} ${format(...a)}\n`
    if (size > LOG_MAX_BYTES) writeFileSync(logFile, line)
    else appendFileSync(logFile, line)
  } catch {
    /* logging never breaks updates */
  }
}

const log = {
  info: (...a: unknown[]) => (console.log('[doplan:update]', ...a), toFile('info', a)),
  warn: (...a: unknown[]) => (console.warn('[doplan:update]', ...a), toFile('warn', a)),
  error: (...a: unknown[]) => (console.error('[doplan:update]', ...a), toFile('error', a)),
  debug: () => {},
}

/** the installer electron-updater will run (from 'update-downloaded') */
let downloadedFile: string | undefined

let state: UpdateState = { mode: 'disabled', current: '0.0.0', status: { kind: 'idle' } }
let updater: AppUpdater | null = null
let checking: Promise<void> | null = null
/** quitAndInstall is under way; an 'error' now means the installer did not start */
let installing = false

const listeners = new Set<(s: UpdateState) => void>()

function setStatus(status: UpdateStatus): void {
  state = { ...state, status }
  sendToRenderer(CH.evUpdateState, state)
  for (const l of listeners) {
    try {
      l(state)
    } catch (err) {
      log.error(err)
    }
  }
}

export function getUpdateState(): UpdateState {
  return state
}

/** main-side subscribers (the Help menu enables «Перезапустить и установить» from this) */
export function onUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function infoFields(info: UpdateInfo): { version: string; notes: string; releaseUrl: string } {
  return { version: info.version, notes: releaseNotesText(info.releaseNotes), releaseUrl: releasePageUrl(info.version) }
}

function runCheck(): Promise<void> {
  const up = updater
  if (!up) return Promise.resolve()
  if (checking) return checking
  if (isBusy(state.status)) return Promise.resolve()
  checking = (async () => {
    try {
      const r = await up.checkForUpdates()
      // download failures also arrive as the 'error' event; keep the promise from going unhandled
      void r?.downloadPromise?.catch(() => {})
      if (!r && state.status.kind === 'checking') setStatus({ kind: 'idle' })
    } catch (err) {
      // electron-updater has already emitted 'error' (→ state); this only covers a silent rejection
      if (state.status.kind === 'checking') setStatus(errorStatus(state.status, err))
    } finally {
      checking = null
    }
  })()
  return checking
}

function wire(up: AppUpdater, mode: UpdateState['mode']): void {
  up.logger = log
  up.autoDownload = mode === 'auto'
  up.autoInstallOnAppQuit = mode === 'auto'
  up.autoRunAppAfterInstall = true
  up.allowPrerelease = false
  up.allowDowngrade = false
  // full NSIS installers only (no nsis-web target)
  up.disableWebInstaller = true

  up.on('checking-for-update', () => setStatus({ kind: 'checking' }))
  up.on('update-available', (info: UpdateInfo) => setStatus({ kind: 'available', ...infoFields(info) }))
  up.on('update-not-available', (info: UpdateInfo) => setStatus({ kind: 'not-available', version: info?.version ?? state.current }))
  up.on('download-progress', (p: ProgressInfo) => {
    const s = state.status
    const version = s.kind === 'available' || s.kind === 'progress' ? s.version : ''
    setStatus({
      kind: 'progress',
      version,
      percent: clampPercent(p.percent),
      transferred: p.transferred ?? 0,
      total: p.total ?? 0,
      bytesPerSecond: p.bytesPerSecond ?? 0,
    })
  })
  up.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    downloadedFile = info.downloadedFile
    setStatus({ kind: 'downloaded', ...infoFields(info) })
  })
  up.on('error', (err: Error) => {
    if (installing) {
      installing = false
      allowQuitWithoutPrompt(false)
    }
    const next = errorStatus(state.status, err)
    if (next.kind === 'error' && next.offline) log.warn('нет связи:', next.message)
    else log.error(err)
    setStatus(next)
  })
}

function check(): Promise<UpdateState> {
  if (!updater) return Promise.resolve(state)
  return runCheck().then(() => state)
}

function install(): void {
  const up = updater
  if (!up || state.mode !== 'auto' || state.status.kind !== 'downloaded') throw new Error('Обновление ещё не скачано')
  log.info('quitAndInstall', state.status.version)
  // the renderer has already settled unsaved changes: skip the close handshake
  installing = true
  allowQuitWithoutPrompt(true)
  // the installer's own relaunch (--force-run) fails when the install dir needs admin rights; the watcher
  // starts the new version once the install is done, unless the installer already did
  if (logFile) {
    const started = spawnRelaunchWatcher(
      { parentPid: process.pid, exePath: process.execPath, version: state.status.version, installerFile: downloadedFile, logPath: logFile },
      (err) => log.error('relaunch watcher:', err),
    )
    log.info(`relaunch watcher ${started ? 'started' : 'not started'}`)
  }
  // silent: the assisted NSIS wizard would otherwise reappear on every update; keeps the install dir.
  // A failure to start the installer is reported synchronously through 'error' (see wire()).
  up.quitAndInstall(true, true)
}

export async function openReleasePage(version: unknown): Promise<void> {
  const v = typeof version === 'string' && /^v?\d+\.\d+\.\d+[\w.+-]*$/.test(version) ? version : undefined
  await shell.openExternal(releasePageUrl(v))
}

/** after `app.whenReady()` and `registerIpc()` */
export function initUpdater(): void {
  const mode = detectUpdateMode(app.isPackaged, process.env)
  state = { mode, current: app.getVersion(), status: { kind: 'idle' } }

  handleIpc(CH.updatesGet, () => state)
  handleIpc(CH.updatesCheck, () => check())
  handleIpc(CH.updatesInstall, () => install())
  handleIpc(CH.updatesOpenRelease, (version: unknown) => openReleasePage(version))

  if (mode === 'disabled') return
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'updater.log')
  } catch {
    logFile = null
  }
  try {
    updater = autoUpdater
    wire(updater, mode)
  } catch (err) {
    updater = null
    log.error('updater unavailable:', err)
    state = { ...state, mode: 'disabled' }
    return
  }
  log.info(`mode=${mode} current=${state.current}`)
  setTimeout(() => void runCheck(), FIRST_CHECK_MS).unref?.()
  setInterval(() => void runCheck(), CHECK_EVERY_MS).unref?.()
}
