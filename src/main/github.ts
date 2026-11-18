/**
 * GitHub through the official `gh` CLI: is it installed, who is signed in, sign-in with a one-time
 * code shown in the app (`gh auth login --web`, device flow), creating repositories, and the git
 * credential flags that let doplan's git use gh's sign-in. Reusable: the project sync (githubSync.ts)
 * and the GitHub Pages publishing both build on it.
 *
 * doplan never stores a password or token: gh keeps its token in the system keychain; doplan reads it
 * from gh (cached in memory) and hands it to its own git commands through their environment, with
 * `gh auth git-credential` as the fallback helper (`gitCredentials`). Nothing is written to the user's
 * or the repository's git config, and the token is never logged or put on a command line.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { app, net, shell } from 'electron'
import {
  classifyError,
  errorText,
  firstErrorLine,
  secretScanDetail,
  ghInstallHint,
  type GhLoginEvent,
  type GhStatus,
  type GithubRepoRef,
  parseDeviceCode,
  isValidRepoName,
} from '../shared/github'
import { killTree } from './aichat/detect'
import { terminalCommandLine } from './aichat/login'
import { msg, uiLang } from './settings'

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Where gh may be: absolute PATH entries, then the places its installers use (a gh installed while
 * doplan runs is found without a restart, though PATH of this process is old). Never the bare name:
 * on Windows a gh.exe in the current folder would win.
 */
export function ghCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const win = platform === 'win32'
  const exe = win ? 'gh.exe' : 'gh'
  const list: string[] = []
  for (const raw of (env['PATH'] ?? env['Path'] ?? '').split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (dir && isAbsolute(dir)) list.push(join(dir, exe))
  }
  if (win) {
    for (const pf of [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)']]) if (pf) list.push(join(pf, 'GitHub CLI', exe))
    if (env['LOCALAPPDATA']) {
      list.push(join(env['LOCALAPPDATA'], 'Programs', 'GitHub CLI', exe))
      list.push(join(env['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Links', exe))
    }
    if (env['USERPROFILE']) list.push(join(env['USERPROFILE'], 'scoop', 'shims', exe))
  } else {
    list.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', '/snap/bin/gh')
  }
  return [...new Set(list)].filter((p) => isAbsolute(p))
}

let ghPath: string | null = null

/** absolute path of gh, or null; looked up again while it is missing */
export function findGh(): string | null {
  if (ghPath && isFile(ghPath)) return ghPath
  ghPath = ghCandidates().find(isFile) ?? null
  return ghPath
}

/** a folder of doplan's own: gh never runs inside a project folder (no repository context, no planted files) */
function neutralDir(): string {
  const dir = join(app.getPath('userData'), 'gh-work')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* exists */
  }
  return dir
}

function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // a repository named by the environment would change what `gh repo create` does
  delete env['GH_REPO']
  delete env['ELECTRON_RUN_AS_NODE']
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_SPINNER_DISABLED: '1' }
}

export interface GhResult {
  code: number
  stdout: string
  stderr: string
  /** killed after `timeout`: says nothing about the answer (a slow machine, an antivirus scan of gh.exe) */
  timedOut?: boolean
}

/** runs gh with arguments doplan chose (no shell) in doplan's own folder */
export function runGh(args: string[], timeout = 60_000): Promise<GhResult> {
  const exe = findGh()
  if (!exe) return Promise.reject(new GithubError('ghMissing', ghMissingText()))
  return new Promise((resolve) => {
    execFile(exe, args, { cwd: neutralDir(), env: ghEnv(), windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0
      const timedOut = !!err && (err as { killed?: boolean }).killed === true
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut })
    })
  })
}

/** an error with a kind the caller may act on; its message is for the user */
export class GithubError extends Error {
  constructor(
    readonly kind: 'ghMissing' | 'ghLogin' | ReturnType<typeof classifyError>,
    message: string,
  ) {
    super(message)
  }
}

const lang = () => uiLang()

export function ghMissingText(): string {
  return msg(
    'Не найдена программа GitHub CLI (gh). Она нужна, чтобы doplan мог войти в GitHub и создать репозиторий. Установите её в окне GitHub.',
    'GitHub CLI (gh) was not found. doplan needs it to sign in to GitHub and create a repository. Install it from the GitHub window.',
  )
}

export function ghLoginText(): string {
  return msg('Сначала войдите в GitHub (кнопка «Войти в GitHub»).', 'Sign in to GitHub first (“Sign in to GitHub”).')
}

export function ghSlowText(): string {
  return msg(
    'GitHub CLI (gh) долго не отвечает — компьютер сейчас сильно загружен (например, антивирус проверяет файлы). Подождите немного и нажмите ещё раз: повторный вход не нужен.',
    'GitHub CLI (gh) is taking too long to answer — the computer is very busy right now (e.g. an antivirus scan). Wait a little and try again: there is no need to sign in again.',
  )
}

/** a gh/git failure as a GithubError with plain words */
export function humanError(output: string): GithubError {
  const kind = classifyError(output)
  // GitHub refused the sign-in: the remembered state and token are out of date
  if (kind === 'auth') forgetGhStatus()
  return new GithubError(kind, errorText(kind, lang(), kind === 'secretFound' ? secretScanDetail(output) : firstErrorLine(output)))
}

// ───────────── status ─────────────

function wingetPath(): string | null {
  if (process.platform !== 'win32' || !process.env['LOCALAPPDATA']) return null
  const dir = join(process.env['LOCALAPPDATA'], 'Microsoft', 'WindowsApps')
  try {
    // an app execution alias: listed, but stat cannot open it
    return readdirSync(dir).some((n) => n.toLowerCase() === 'winget.exe') ? join(dir, 'winget.exe') : null
  } catch {
    return null
  }
}

/*
 * Every start of gh.exe can take 10–20 s on a loaded computer (an antivirus scans it each time), so
 * doplan starts it once per session: `gh auth token`, a local read of the keychain. The token stays in
 * this process's memory (never on disk, never in a log); everything else goes straight to GitHub's
 * REST API with it (a fraction of a second, independent requests at once), and git gets it through
 * its environment. A 401 means the token changed: it is read from gh once more and the request
 * repeated, and only a second 401 means "sign in". A gh that did not answer in time is never
 * "signed out".
 */
const TOKEN_TIMEOUT = 60_000
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/
const API = 'https://api.github.com'

/** what `gh auth token` said: a token, none (not signed in), or no answer in time */
export type TokenState = { kind: 'token'; token: string } | { kind: 'none' } | { kind: 'slow' }

let tokenState: TokenState | null = null
let tokenRun: Promise<TokenState> | null = null
let statusCache: GhStatus | null = null
let statusRun: Promise<GhStatus> | null = null
/** the signed-in account as GitHub described it (GET /user) */
let account: { login: string; plan: string | null; token: string } | null = null

export function tokenFrom(r: GhResult): TokenState {
  if (r.timedOut) return { kind: 'slow' }
  const token = r.code === 0 ? r.stdout.trim() : ''
  return TOKEN_RE.test(token) ? { kind: 'token', token } : { kind: 'none' }
}

/** `gh auth token`, the one gh start of a session; callers at once share it; "no answer" is not kept */
function readToken(): Promise<TokenState> {
  tokenRun ??= runGh(['auth', 'token', '--hostname', 'github.com'], TOKEN_TIMEOUT)
    .then(tokenFrom, (): TokenState => ({ kind: 'none' }))
    .then((s) => {
      if (s.kind !== 'slow') tokenState = s
      return s
    })
    .finally(() => (tokenRun = null))
  return tokenRun
}

const tokenNow = (): Promise<TokenState> => (tokenState ? Promise.resolve(tokenState) : readToken())

/** gh's token for github.com (memory only), null when not signed in or gh did not answer */
export async function ghToken(): Promise<string | null> {
  const s = await tokenNow()
  return s.kind === 'token' ? s.token : null
}

export function forgetGhStatus(): void {
  statusCache = null
  tokenState = null
  account = null
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let testFetch: Fetch | null = null
/** test hook: a stand-in for GitHub's API */
export function setGithubFetch(f: Fetch | null): void {
  testFetch = f
}

function apiFetch(url: string, init: RequestInit): Promise<Response> {
  if (testFetch) return testFetch(url, init)
  // Chromium's network stack: the system proxy and certificates, as in the browser
  let nf: Fetch | undefined
  try {
    nf = typeof net?.fetch === 'function' ? (net.fetch.bind(net) as Fetch) : undefined
  } catch {
    nf = undefined
  }
  return (nf ?? fetch)(url, init)
}

export interface ApiResponse {
  status: number
  json: unknown
  text: string
}

/**
 * One request to GitHub's REST API as the gh account. Resolves with any answer but 401; a 401 reads
 * gh's token again and repeats once, a second one is "sign in". No answer: offline or timeout.
 */
export async function githubApi(method: string, path: string, opts: { body?: unknown; accept?: string; timeout?: number } = {}): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    const s = attempt === 0 ? await tokenNow() : await readToken()
    if (s.kind === 'slow') throw new GithubError('timeout', ghSlowText())
    if (s.kind === 'none') throw findGh() ? new GithubError('ghLogin', ghLoginText()) : new GithubError('ghMissing', ghMissingText())
    let res: Response
    try {
      res = await apiFetch(`${API}/${path.replace(/^\/+/, '')}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.token}`,
          Accept: opts.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'doplan',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeout ?? 30_000),
      })
    } catch (err) {
      const name = (err as { name?: string } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') throw new GithubError('timeout', errorText('timeout', lang()))
      throw new GithubError('offline', errorText('offline', lang()))
    }
    const text = await res.text().catch(() => '')
    if (res.status === 401) {
      forgetGhStatus()
      if (attempt === 0) continue
      throw new GithubError('ghLogin', ghLoginText())
    }
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }
}

/** an API refusal in plain words */
export function apiError(res: ApiResponse): GithubError {
  const j = res.json as { message?: unknown; errors?: { message?: unknown }[] } | null
  const detail = [j?.message, ...(Array.isArray(j?.errors) ? j.errors.map((e) => e?.message) : [])].filter((v): v is string => typeof v === 'string' && !!v).join(': ')
  const kind =
    /name already exists/i.test(detail) ? 'nameTaken' : res.status === 404 ? 'notFound' : res.status === 403 && !/rate limit/i.test(detail) ? 'forbidden' : 'unknown'
  return new GithubError(kind, errorText(kind, lang(), `HTTP ${res.status}${detail ? `: ${detail}` : ''}`.slice(0, 300)))
}

export function ghOfflineText(): string {
  return msg(
    'Не удалось связаться с GitHub, чтобы проверить вход. Проверьте подключение к интернету и попробуйте ещё раз: повторный вход не нужен.',
    'Could not reach GitHub to check the sign-in. Check your internet connection and try again: there is no need to sign in again.',
  )
}

let statusFresh = false

/**
 * Is gh installed and signed in to github.com. Kept for the session; `fresh` (the user's "check
 * again", "refresh") asks gh again too, one more `gh auth token`, so a sign-in, sign-out or account
 * switch made in a terminal is seen. Callers at once share one check.
 */
export async function ghStatus(fresh = false): Promise<GhStatus> {
  if (!fresh && statusCache && statusCache.installed === !!findGh()) return statusCache
  // a fresh question is not answered by a check that started from the remembered token
  if (statusRun && (statusFresh || !fresh)) return statusRun
  const run = checkGh(fresh).finally(() => {
    if (statusRun === run) statusRun = null
  })
  statusRun = run
  statusFresh = fresh
  return run
}

async function checkGh(fresh: boolean): Promise<GhStatus> {
  const install = ghInstallHint(process.platform, !!wingetPath())
  if (!findGh()) {
    forgetGhStatus()
    return { installed: false, loggedIn: false, install }
  }
  const prev = statusCache
  // fresh: gh's token now (a slow gh keeps the one in memory: readToken never forgets on "no answer")
  const s = fresh ? await readToken() : await tokenNow()
  // gh did not answer: the last known state, or "slow" — never "signed out", and not remembered
  if (s.kind === 'slow') return prev ?? { installed: true, loggedIn: false, slow: true, install }
  if (s.kind === 'none') {
    account = null
    return (statusCache = { installed: true, loggedIn: false, install })
  }
  try {
    const res = await githubApi('GET', 'user', { timeout: 15_000 })
    const j = res.json as { login?: unknown; plan?: { name?: unknown } } | null
    if (res.status === 200 && typeof j?.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(j.login)) {
      account = { login: j.login, plan: typeof j.plan?.name === 'string' ? j.plan.name.toLowerCase() : null, token: s.token }
      return (statusCache = { installed: true, loggedIn: true, user: j.login, install })
    }
  } catch (err) {
    if (err instanceof GithubError && err.kind === 'ghLogin') return (statusCache = { installed: true, loggedIn: false, install })
    if (err instanceof GithubError && err.kind === 'timeout' && !tokenState) return prev ?? { installed: true, loggedIn: false, slow: true, install }
  }
  // GitHub did not answer (or answered oddly): the sign-in confirmed earlier with this token, or
  // "could not check" — never "sign in" (a new sign-in would not help); asked again next time
  if (prev?.loggedIn && prev.user && account?.token === s.token && account.login === prev.user) return prev
  return { installed: true, loggedIn: false, offline: true, install }
}

/** what git needs to reach github.com as the gh account: `-c` flags and environment variables */
export interface GitCredentials {
  config: string[]
  env: Record<string, string>
  /**
   * Present when the token went as a header: GitHub refused it (changed since it was read), so gh's
   * token is read once more for the same command (git.runNet, pagesGit.run). curl sends a header of
   * its own over anything a credential helper answers, so the helper alone could not recover.
   */
  refresh?: () => Promise<Omit<GitCredentials, 'refresh'>>
}

/**
 * The token header may go along: every address is https://github.com/… without credentials of its
 * own (a token clone keeps its own; another host never sees gh's token).
 */
export function tokenHeaderFits(urls: readonly string[]): boolean {
  return (
    urls.length > 0 &&
    urls.every((u) => {
      try {
        const x = new URL(u)
        return x.protocol === 'https:' && x.hostname.toLowerCase() === 'github.com' && (x.port === '' || x.port === '443') && !x.username && !x.password
      } catch {
        return false
      }
    })
  )
}

/**
 * The token as an HTTP header for https://github.com/ only, through git's environment
 * (GIT_CONFIG_COUNT, git 2.31+): never on a command line, never written to a config file.
 */
export function tokenEnv(token: string): Record<string, string> {
  if (!TOKEN_RE.test(token)) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

/** the `-c` flags of the fallback helper: gh is asked only for `get` (a store or erase never starts it) */
export function ghHelperArgs(exe: string): string[] {
  // git runs the helper through sh: forward slashes, single quotes (a path with a quote is not used)
  const p = exe.replace(/\\/g, '/')
  if (/['\0\r\n]/.test(p)) return []
  return ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!f() { if [ "$1" = get ]; then '${p}' auth git-credential get; fi; }; f`]
}

/**
 * Credentials for git network commands to `remotes` (every address git may use: git.gitRemoteAddresses).
 * gh signed in and every address plain https://github.com (tokenHeaderFits): gh's token as a header
 * (no gh started per command) and gh's helper for github.com (the helper list reset first, so no other
 * helper is asked or stores anything), which answers alone while gh is slow; a refused header is read
 * again once (`refresh`). Any other address (credentials or a user name of its own, an insteadOf rule
 * adding them, another host) or not signed in: nothing at all, the user's own credentials and
 * credential manager answer, as with plain git.
 */
export async function gitCredentials(remotes: readonly string[] = []): Promise<GitCredentials> {
  const exe = findGh()
  if (!exe) return { config: [], env: {} }
  return credentialsOf(exe, await tokenNow(), tokenHeaderFits(remotes))
}

function credentialsOf(exe: string, s: TokenState, header: boolean): GitCredentials {
  // the user's own account for that address (e.g. user@github.com in GCM): gh must not replace it
  if (s.kind === 'none' || !header) return { config: [], env: {} }
  const config = ghHelperArgs(exe)
  if (s.kind !== 'token') return { config, env: {} }
  return {
    config,
    env: tokenEnv(s.token),
    refresh: async () => {
      // the token in memory is still the refused one: gh is asked again (not when another call already did)
      if (tokenState?.kind === 'token' && tokenState.token === s.token) forgetGhStatus()
      const { config: c, env } = credentialsOf(exe, await tokenNow(), header)
      return { config: c, env }
    },
  }
}

// ───────────── install ─────────────

/** opens a console window that installs gh (Windows, winget); false where doplan cannot do it */
export function installGh(): boolean {
  const winget = wingetPath()
  if (!winget) return false
  const line = terminalCommandLine(winget, [], ['install', '--id', 'GitHub.cli', '-e'])
  if (!line) return false
  try {
    spawn('cmd.exe', [line], { cwd: neutralDir(), windowsHide: false, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

// ───────────── sign-in ─────────────

let login: ChildProcess | null = null

export function cancelGhLogin(): void {
  if (login) killTree(login)
  login = null
}

/**
 * `gh auth login --web` without a terminal: gh prints a one-time code and waits until the user
 * enters it on github.com/login/device, then stores its token in the system keychain. The code goes
 * to `emit`; doplan opens the page when the user asks (openGithubPage('device')).
 */
export function startGhLogin(emit: (ev: GhLoginEvent) => void): void {
  cancelGhLogin()
  const exe = findGh()
  if (!exe) {
    emit({ type: 'done', ok: false, error: ghMissingText() })
    return
  }
  let child: ChildProcess
  try {
    child = spawn(exe, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], {
      cwd: neutralDir(),
      env: { ...ghEnv(), GH_PROMPT_DISABLED: '' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    emit({ type: 'done', ok: false, error: (e as Error).message })
    return
  }
  login = child
  let out = ''
  let sent = false
  const onData = (d: Buffer | string) => {
    out = (out + String(d)).slice(-8000)
    if (!sent) {
      const code = parseDeviceCode(out)
      if (code) {
        sent = true
        emit({ type: 'code', code, url: 'https://github.com/login/device' })
      }
    }
    // "Press Enter to open github.com in your browser…": doplan opens the page itself
    if (/press enter/i.test(String(d))) child.stdin?.write('\n')
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', (e) => {
    out += `\n${e.message}`
  })
  // never left waiting longer than GitHub keeps a device code (15 min)
  const timer = setTimeout(() => killTree(child), 16 * 60_000)
  child.on('close', async (code) => {
    clearTimeout(timer)
    const mine = login === child
    if (mine) login = null
    forgetGhStatus()
    const st = await ghStatus(true).catch(() => null)
    if (st?.loggedIn) emit({ type: 'done', ok: true, user: st.user })
    else if (!mine) emit({ type: 'done', ok: false, error: msg('Вход отменён', 'Sign-in cancelled') })
    // gh did not answer the check in time: the sign-in itself may well have worked, do not send the user to sign in again
    else if (st?.slow) emit({ type: 'done', ok: false, error: ghSlowText() })
    // signed in (gh said so and holds the token, kept in memory) but GitHub did not answer the check:
    // done — the dialog's next look shows "could not reach GitHub", never "sign in" again
    else if (code === 0 && st?.offline) emit({ type: 'done', ok: true })
    else emit({ type: 'done', ok: false, error: code === 0 ? ghLoginText() : humanError(out).message })
  })
}

// ───────────── repositories ─────────────

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

function repoSlug(owner: string, repo: string): string {
  if (!OWNER_NAME.test(owner) || !isValidRepoName(repo)) throw new GithubError('notFound', msg('Недопустимое имя репозитория', 'Invalid repository name'))
  return `${owner}/${repo}`
}

/** creates a repository on the signed-in account (GitHub's API); resolves with its address */
export async function createRepo(name: string, isPrivate: boolean, description = ''): Promise<GithubRepoRef> {
  if (!isValidRepoName(name)) throw new GithubError('unknown', msg('Недопустимое имя репозитория: только латинские буквы, цифры, «-», «_» и «.», и не с «-» в начале.', 'Invalid repository name: Latin letters, digits, “-”, “_” and “.” only, not starting with “-”.'))
  if (!findGh()) throw new GithubError('ghMissing', ghMissingText())
  // a timeout: GitHub may have made it anyway, creating again finds it and connects (createAndConnect)
  const res = await githubApi('POST', 'user/repos', {
    body: { name, private: isPrivate, description: description.replace(/[\r\n]+/g, ' ').slice(0, 300), auto_init: false },
    timeout: 60_000,
  })
  if (res.status !== 201) throw apiError(res)
  const j = res.json as { name?: unknown; owner?: { login?: unknown } } | null
  const owner = typeof j?.owner?.login === 'string' ? j.owner.login : account?.login
  const repo = typeof j?.name === 'string' ? j.name : name
  if (!owner || !OWNER_NAME.test(owner) || !isValidRepoName(repo)) throw new GithubError('unknown', msg('GitHub не сообщил адрес нового репозитория', 'GitHub did not report the new repository address'))
  return { owner, repo, ssh: false }
}

export type RepoVisibility = 'public' | 'private' | 'internal'

export interface RepoInfo {
  visibility: RepoVisibility
  defaultBranch: string | null
  /** ADMIN / MAINTAIN / WRITE / TRIAGE / READ, or null */
  permission: string | null
}

/** visibility, default branch and the signed-in account's permission on a repository */
export async function repoInfo(owner: string, repo: string): Promise<RepoInfo> {
  const res = await githubApi('GET', `repos/${repoSlug(owner, repo)}`)
  if (res.status !== 200) throw apiError(res)
  const j = (res.json ?? {}) as { visibility?: unknown; private?: unknown; default_branch?: unknown; permissions?: Record<string, unknown> }
  const v = String(j.visibility ?? (j.private ? 'private' : 'public')).toLowerCase()
  const p = j.permissions ?? {}
  return {
    visibility: v === 'public' || v === 'internal' ? v : 'private',
    defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? j.default_branch : null,
    permission: p.admin ? 'ADMIN' : p.maintain ? 'MAINTAIN' : p.push ? 'WRITE' : p.triage ? 'TRIAGE' : p.pull ? 'READ' : null,
  }
}

/** makes a repository public or private (the caller asks the user first) */
export async function setRepoVisibility(owner: string, repo: string, visibility: 'public' | 'private'): Promise<void> {
  const res = await githubApi('PATCH', `repos/${repoSlug(owner, repo)}`, { body: { visibility } })
  if (res.status !== 200) throw apiError(res)
}

/**
 * The signed-in account's GitHub plan ('free', 'pro', …), or null when GitHub does not say (from the
 * sign-in check, no request of its own). GitHub Pages of a private repository needs a paid plan; on
 * 'free' Pages works for public ones only.
 */
export async function accountPlan(): Promise<string | null> {
  if (!account) await ghStatus()
  return account?.plan ?? null
}

/** the pages doplan opens in the browser: only GitHub's own */
export async function openGithubUrl(url: string): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/^(github\.com|cli\.github\.com)$/i.test(u.hostname)) throw new Error('not a GitHub page')
  await shell.openExternal(u.toString())
}
