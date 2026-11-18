/**
 * GitHub through the official `gh` CLI: is it installed, who is signed in, sign-in with a one-time
 * code shown in the app (`gh auth login --web`, device flow), creating repositories, and the git
 * credential flags that let doplan's git use gh's sign-in. Reusable: the project sync (githubSync.ts)
 * and the GitHub Pages publishing both build on it.
 *
 * doplan never sees or stores a password or token: gh keeps its token in the system keychain, and git
 * asks `gh auth git-credential` for it per command (`gitCredentialArgs`), nothing is written to the
 * user's or the repository's git config.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { app, shell } from 'electron'
import {
  classifyError,
  errorText,
  firstErrorLine,
  ghInstallHint,
  type GhLoginEvent,
  type GhStatus,
  type GithubRepoRef,
  parseCreatedRepoUrl,
  parseDeviceCode,
  parseGhAuthStatus,
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
}

/** runs gh with arguments doplan chose (no shell) in doplan's own folder */
export function runGh(args: string[], timeout = 60_000): Promise<GhResult> {
  const exe = findGh()
  if (!exe) return Promise.reject(new GithubError('ghMissing', ghMissingText()))
  return new Promise((resolve) => {
    execFile(exe, args, { cwd: neutralDir(), env: ghEnv(), windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
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

/** a gh/git failure as a GithubError with plain words */
export function humanError(output: string): GithubError {
  const kind = classifyError(output)
  return new GithubError(kind, errorText(kind, lang(), firstErrorLine(output)))
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

let statusCache: { at: number; value: GhStatus } | null = null

/** is gh installed and signed in to github.com (cached for a minute; `fresh` asks again) */
export async function ghStatus(fresh = false): Promise<GhStatus> {
  if (!fresh && statusCache && Date.now() - statusCache.at < 60_000 && statusCache.value.installed === !!findGh()) return statusCache.value
  const install = ghInstallHint(process.platform, !!wingetPath())
  if (!findGh()) {
    statusCache = null
    return { installed: false, loggedIn: false, install }
  }
  const [ver, st] = await Promise.all([runGh(['--version'], 15_000), runGh(['auth', 'status', '--hostname', 'github.com'], 20_000)])
  const version = /gh version (\S+)/.exec(ver.stdout)?.[1]
  const auth = parseGhAuthStatus(`${st.stdout}\n${st.stderr}`)
  const value: GhStatus = { installed: true, version, loggedIn: auth.loggedIn && st.code === 0, user: auth.user, install }
  statusCache = { at: Date.now(), value }
  return value
}

export function forgetGhStatus(): void {
  statusCache = null
}

/**
 * `-c` flags for git network commands: with gh signed in, github.com credentials come from
 * `gh auth git-credential` for this command only (the helper list for github.com is reset first, so
 * no other helper is asked or stores anything). Otherwise none: the user's own git credential manager
 * answers, as with plain git.
 */
export async function gitCredentialArgs(): Promise<string[]> {
  const st = await ghStatus()
  const exe = findGh()
  if (!st.loggedIn || !exe) return []
  // git runs the helper through sh: forward slashes, single quotes (a path with a quote is not used)
  const p = exe.replace(/\\/g, '/')
  if (/['\0\r\n]/.test(p)) return []
  return ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!'${p}' auth git-credential`]
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
    else emit({ type: 'done', ok: false, error: code === 0 ? ghLoginText() : humanError(out).message })
  })
}

// ───────────── repositories ─────────────

/** creates a repository on the signed-in account; resolves with its address */
export async function createRepo(name: string, isPrivate: boolean, description = ''): Promise<GithubRepoRef> {
  if (!isValidRepoName(name)) throw new GithubError('unknown', msg('Недопустимое имя репозитория: только латинские буквы, цифры, «-», «_» и «.».', 'Invalid repository name: Latin letters, digits, “-”, “_” and “.” only.'))
  const st = await ghStatus(true)
  if (!st.installed) throw new GithubError('ghMissing', ghMissingText())
  if (!st.loggedIn) throw new GithubError('ghLogin', ghLoginText())
  const args = ['repo', 'create', name, isPrivate ? '--private' : '--public']
  if (description) args.push('--description', description.replace(/[\r\n]+/g, ' ').slice(0, 300))
  const r = await runGh(args, 60_000)
  const out = `${r.stdout}\n${r.stderr}`
  if (r.code !== 0) throw humanError(out)
  const ref = parseCreatedRepoUrl(out) ?? (st.user ? { owner: st.user, repo: name, ssh: false } : null)
  if (!ref) throw new GithubError('unknown', msg('GitHub не сообщил адрес нового репозитория', 'GitHub did not report the new repository address'))
  return ref
}

export type RepoVisibility = 'public' | 'private' | 'internal'

export interface RepoInfo {
  visibility: RepoVisibility
  defaultBranch: string | null
  /** ADMIN / MAINTAIN / WRITE / TRIAGE / READ, or null */
  permission: string | null
}

function repoSlug(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !isValidRepoName(repo)) throw new GithubError('notFound', msg('Недопустимое имя репозитория', 'Invalid repository name'))
  return `${owner}/${repo}`
}

async function requireGh(): Promise<void> {
  const st = await ghStatus()
  if (!st.installed) throw new GithubError('ghMissing', ghMissingText())
  if (!st.loggedIn) throw new GithubError('ghLogin', ghLoginText())
}

/** visibility, default branch and the signed-in account's permission on a repository (gh) */
export async function repoInfo(owner: string, repo: string): Promise<RepoInfo> {
  const slug = repoSlug(owner, repo)
  await requireGh()
  const r = await runGh(['repo', 'view', slug, '--json', 'visibility,defaultBranchRef,viewerPermission'], 30_000)
  if (r.code !== 0) throw humanError(`${r.stdout}\n${r.stderr}`)
  const j = JSON.parse(r.stdout) as { visibility?: string; defaultBranchRef?: { name?: string } | null; viewerPermission?: string | null }
  const v = String(j.visibility ?? '').toLowerCase()
  return {
    visibility: v === 'public' || v === 'internal' ? v : 'private',
    defaultBranch: j.defaultBranchRef?.name || null,
    permission: j.viewerPermission ?? null,
  }
}

/** makes a repository public or private (gh; the caller asks the user first) */
export async function setRepoVisibility(owner: string, repo: string, visibility: 'public' | 'private'): Promise<void> {
  const slug = repoSlug(owner, repo)
  await requireGh()
  const r = await runGh(['repo', 'edit', slug, '--visibility', visibility, '--accept-visibility-change-consequences'], 60_000)
  if (r.code !== 0) throw humanError(`${r.stdout}\n${r.stderr}`)
}

/**
 * The signed-in account's GitHub plan ('free', 'pro', …), or null when GitHub does not say.
 * GitHub Pages of a private repository needs a paid plan; on 'free' Pages works for public ones only.
 */
export async function accountPlan(): Promise<string | null> {
  await requireGh()
  const r = await runGh(['api', 'user', '--jq', '.plan.name // ""'], 30_000)
  if (r.code !== 0) throw humanError(`${r.stdout}\n${r.stderr}`)
  return r.stdout.trim().toLowerCase() || null
}

/** the pages doplan opens in the browser: only GitHub's own */
export async function openGithubUrl(url: string): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/^(github\.com|cli\.github\.com)$/i.test(u.hostname)) throw new Error('not a GitHub page')
  await shell.openExternal(u.toString())
}
