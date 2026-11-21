/**
 * Auto-update contract shared by main (src/main/updater.ts, electron-updater over GitHub Releases)
 * and the renderer (update notice, «Проверить обновления»). Pure: no electron imports, unit-tested.
 */

export const UPDATE_REPO = { owner: 'totKtoXam', repo: 'doplan' } as const

/**
 * - `auto`     — installed (NSIS) build: checks, downloads in the background, installs on restart/quit
 * - `portable` — portable exe: electron-updater cannot replace it, so only checks and links to the release
 * - `disabled` — dev run (`!app.isPackaged`) or web fallback: no checks at all
 */
export type UpdateMode = 'auto' | 'portable' | 'disabled'

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes: string; releaseUrl: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'progress'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string; notes: string; releaseUrl: string }
  | { kind: 'error'; offline: boolean; message: string; version?: string }

export interface UpdateState {
  mode: UpdateMode
  /** running app version */
  current: string
  status: UpdateStatus
}

/** `window.doplan.updates` */
export interface UpdatesApi {
  get(): Promise<UpdateState>
  /** manual «Проверить обновления»: resolves with the state once the check itself is over */
  check(): Promise<UpdateState>
  /** «Перезапустить и установить» (auto mode, after `downloaded`). The renderer settles unsaved changes first. */
  install(): Promise<void>
  /** opens the GitHub release page of `version` (or the releases list) in the browser */
  openReleasePage(version?: string): Promise<void>
  onState(cb: (s: UpdateState) => void): () => void
}

/** portable-target exes are unpacked to a temp dir; electron-builder's launcher sets this variable */
export function detectUpdateMode(isPackaged: boolean, env: Record<string, string | undefined>): UpdateMode {
  if (!isPackaged) return 'disabled'
  return env['PORTABLE_EXECUTABLE_DIR'] ? 'portable' : 'auto'
}

export function releasePageUrl(version?: string): string {
  const base = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`
  if (!version) return base
  const tag = version.startsWith('v') ? version : `v${version}`
  return `${base}/tag/${encodeURIComponent(tag)}`
}

const OFFLINE_RE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_|ERR_CONNECTION_|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_|ERR_TIMED_OUT|ERR_NETWORK_IO_SUSPENDED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|net::/i

/** true when the error means "no connection" (shown quietly), not a broken release or feed */
export function isOfflineError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  const text = `${typeof e?.code === 'string' ? e.code : ''} ${typeof e?.message === 'string' ? e.message : String(err)}`
  return OFFLINE_RE.test(text)
}

/** short, single-line error text for the UI (electron-updater errors carry whole HTTP dumps) */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  const first = raw.split(/\r?\n/).find((l) => l.trim()) ?? raw
  const s = first.trim()
  return s.length > 200 ? `${s.slice(0, 199)}…` : s || 'Неизвестная ошибка'
}

/** electron-updater gives notes as GitHub HTML or as a per-version list; the UI wants plain text */
export function releaseNotesText(notes: unknown): string {
  if (typeof notes === 'string') return htmlToText(notes)
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        const r = n as { version?: unknown; note?: unknown }
        const body = typeof r.note === 'string' ? htmlToText(r.note) : ''
        return typeof r.version === 'string' && body ? `${r.version}\n${body}` : body
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A check is pointless (and would restart the flow) while one runs or a download is under way. A
 * downloaded update does not block it: a newer release may have come out since (the ready one stays
 * installable when the check finds nothing newer or fails).
 */
export function isBusy(s: UpdateStatus): boolean {
  return s.kind === 'checking' || s.kind === 'progress'
}

/**
 * A status reached by a background check that the user should see without asking. Failed checks
 * stay quiet (offline, no release yet); a failed download of a known version is shown.
 */
export function isNoteworthy(s: UpdateStatus): boolean {
  return s.kind === 'available' || s.kind === 'progress' || s.kind === 'downloaded' || (s.kind === 'error' && !!s.version)
}

/** the release version a status is about (not the running one) */
export function statusVersion(s: UpdateStatus): string | null {
  if (s.kind === 'available' || s.kind === 'progress' || s.kind === 'downloaded') return s.version || null
  if (s.kind === 'error') return s.version ?? null
  return null
}

/** what the update notice card shows, or null when hidden (`dismissed` = version closed with «Позже») */
export function noticeFor(state: UpdateState, dismissed: string | null): UpdateStatus | null {
  const s = state.status
  if (state.mode === 'disabled' || !isNoteworthy(s)) return null
  const v = statusVersion(s)
  if (v && dismissed === v) return null
  return s
}

/** what the Help menu offers next to «Проверить обновления…» */
export type UpdateMenuAction =
  | { kind: 'install'; enabled: boolean; version?: string }
  | { kind: 'download-page'; enabled: boolean; version?: string }

export function updateMenuAction(state: UpdateState): UpdateMenuAction {
  const s = state.status
  if (state.mode === 'portable') {
    const v = s.kind === 'available' ? s.version : undefined
    return v ? { kind: 'download-page', enabled: true, version: v } : { kind: 'download-page', enabled: false }
  }
  return state.mode === 'auto' && s.kind === 'downloaded' ? { kind: 'install', enabled: true, version: s.version } : { kind: 'install', enabled: false }
}

/** the status after electron-updater reports an error while in `prev` */
export function errorStatus(prev: UpdateStatus, err: unknown): UpdateStatus {
  const version = prev.kind === 'available' || prev.kind === 'progress' || prev.kind === 'downloaded' ? prev.version : undefined
  const base = { kind: 'error' as const, offline: isOfflineError(err), message: errorMessage(err) }
  return version ? { ...base, version } : base
}

export function clampPercent(p: unknown): number {
  const n = typeof p === 'number' && Number.isFinite(p) ? p : 0
  return Math.max(0, Math.min(100, n))
}
