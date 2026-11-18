/**
 * A thin wrapper over GitHub CLI (gh) for publishing plans on GitHub Pages.
 *
 * TEMPORARY: the github-sync module (src/main/github.ts) brings the same basics — findGh / runGh /
 * ghStatus / gitCredentialArgs / createRepo — under the same names; once it lands, these move over to
 * it and only the Pages calls below stay here.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { app, shell } from 'electron'
import type { RepoRef } from '@shared/pagesSite'
import { isValidRepoName, PAGES_BRANCH, pagesUrlOf } from '@shared/pagesSite'
import { msg } from './settings'

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** where gh may be: absolute PATH entries, then its installers' folders (never the bare name) */
function ghCandidates(): string[] {
  const env = process.env
  const win = process.platform === 'win32'
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

export function findGh(): string | null {
  if (ghPath && isFile(ghPath)) return ghPath
  ghPath = ghCandidates().find(isFile) ?? null
  return ghPath
}

/** a folder of doplan's own: gh never runs inside a project folder */
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
  delete env['GH_REPO']
  delete env['ELECTRON_RUN_AS_NODE']
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_SPINNER_DISABLED: '1' }
}

export interface GhResult {
  code: number
  stdout: string
  stderr: string
}

export function runGh(args: string[], timeout = 60_000): Promise<GhResult> {
  const exe = findGh()
  if (!exe) return Promise.reject(new Error(ghMissingText()))
  return new Promise((resolve) => {
    execFile(exe, args, { cwd: neutralDir(), env: ghEnv(), windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export function ghMissingText(): string {
  return msg(
    'Не найдена программа GitHub CLI (gh). Установите её (https://cli.github.com) и войдите командой «gh auth login».',
    'GitHub CLI (gh) was not found. Install it (https://cli.github.com) and sign in with “gh auth login”.',
  )
}

export function ghLoginText(): string {
  return msg('Сначала войдите в GitHub: «gh auth login».', 'Sign in to GitHub first: “gh auth login”.')
}

/** a gh failure in plain words */
export function ghError(r: GhResult, what: string): Error {
  const out = `${r.stderr}\n${r.stdout}`
  if (/HTTP 401|authentication|not logged in|auth login/i.test(out)) return new Error(ghLoginText())
  if (/HTTP 403|must have admin|Resource not accessible/i.test(out))
    return new Error(msg(`${what}: у этой учётной записи GitHub нет прав администратора репозитория.`, `${what}: this GitHub account has no admin rights on the repository.`))
  if (/could not resolve host|timed out|network|ECONN/i.test(out)) return new Error(msg(`${what}: нет связи с GitHub.`, `${what}: cannot reach GitHub.`))
  const line =
    out
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return new Error(`${what}: ${line.slice(0, 300)}`)
}

export interface GhStatus {
  installed: boolean
  loggedIn: boolean
  user?: string
}

let statusCache: { at: number; value: GhStatus } | null = null

export async function ghStatus(fresh = false): Promise<GhStatus> {
  if (!fresh && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value
  if (!findGh()) {
    statusCache = null
    return { installed: false, loggedIn: false }
  }
  const r = await runGh(['api', 'user', '--jq', '.login'], 20_000)
  const user = r.code === 0 ? r.stdout.trim() : ''
  const value: GhStatus = { installed: true, loggedIn: !!user, ...(user ? { user } : {}) }
  statusCache = { at: Date.now(), value }
  return value
}

/** `-c` flags for git push: github.com credentials from `gh auth git-credential`, for this command only */
export async function gitCredentialArgs(): Promise<string[]> {
  const st = await ghStatus()
  const exe = findGh()
  if (!st.loggedIn || !exe) return []
  const p = exe.replace(/\\/g, '/')
  if (/['\0\r\n]/.test(p)) return []
  return ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!'${p}' auth git-credential`]
}

// ───────────── repositories ─────────────

export interface RepoState {
  exists: boolean
  isPrivate: boolean
}

export async function repoState(ref: RepoRef): Promise<RepoState> {
  const r = await runGh(['api', `repos/${ref.owner}/${ref.repo}`, '--jq', '.private'], 30_000)
  if (r.code !== 0) {
    if (/HTTP 404|Not Found/i.test(r.stderr)) return { exists: false, isPrivate: false }
    throw ghError(r, msg('Не удалось узнать о репозитории', 'Could not read the repository'))
  }
  return { exists: true, isPrivate: r.stdout.trim() === 'true' }
}

/** the GitHub plan of the signed-in account ('free', 'pro', …), or undefined */
export async function userPlan(): Promise<string | undefined> {
  const r = await runGh(['api', 'user', '--jq', '.plan.name // empty'], 20_000)
  const name = r.code === 0 ? r.stdout.trim().toLowerCase() : ''
  return name || undefined
}

export async function makePublic(ref: RepoRef): Promise<void> {
  const r = await runGh(['repo', 'edit', `${ref.owner}/${ref.repo}`, '--visibility', 'public', '--accept-visibility-change-consequences'], 60_000)
  if (r.code !== 0) throw ghError(r, msg('Не удалось сделать репозиторий публичным', 'Could not make the repository public'))
}

/** creates a public repository on the signed-in account */
export async function createPublicRepo(name: string, description: string): Promise<RepoRef> {
  if (!isValidRepoName(name)) throw new Error(msg(`Недопустимое имя репозитория: ${name}`, `Invalid repository name: ${name}`))
  const st = await ghStatus(true)
  if (!st.installed) throw new Error(ghMissingText())
  if (!st.loggedIn || !st.user) throw new Error(ghLoginText())
  const r = await runGh(['repo', 'create', name, '--public', '--description', description.replace(/[\r\n]+/g, ' ').slice(0, 300)], 60_000)
  if (r.code !== 0) throw ghError(r, msg('Не удалось создать репозиторий', 'Could not create the repository'))
  return { owner: st.user, repo: name }
}

// ───────────── Pages ─────────────

/** turns Pages on for the gh-pages branch (or points it there); resolves with the site address */
export async function enablePages(ref: RepoRef): Promise<string> {
  const api = `repos/${ref.owner}/${ref.repo}/pages`
  const source = ['-f', `source[branch]=${PAGES_BRANCH}`, '-f', 'source[path]=/']
  const cur = await runGh(['api', api], 30_000)
  let res: GhResult
  if (cur.code !== 0 && /HTTP 404|Not Found/i.test(cur.stderr)) {
    res = await runGh(['api', '-X', 'POST', api, ...source], 30_000)
  } else if (cur.code !== 0) {
    throw ghError(cur, msg('Не удалось прочитать настройки Pages', 'Could not read the Pages settings'))
  } else {
    res = await runGh(['api', '-X', 'PUT', api, ...source], 30_000)
  }
  // a POST that races GitHub turning Pages on by itself after the push: 409 means "already on"
  if (res.code !== 0 && !/HTTP 409|already exists/i.test(res.stderr)) throw ghError(res, msg('Не удалось включить GitHub Pages', 'Could not turn on GitHub Pages'))
  const after = await runGh(['api', api, '--jq', '.html_url'], 30_000)
  const url = after.code === 0 ? after.stdout.trim() : ''
  return /^https:\/\//.test(url) ? (url.endsWith('/') ? url : `${url}/`) : pagesUrlOf(ref)
}

/** turns Pages off; resolves false when they were not on */
export async function disablePages(ref: RepoRef): Promise<boolean> {
  const r = await runGh(['api', '-X', 'DELETE', `repos/${ref.owner}/${ref.repo}/pages`], 30_000)
  if (r.code === 0) return true
  if (/HTTP 404|Not Found/i.test(r.stderr)) return false
  throw ghError(r, msg('Не удалось выключить GitHub Pages', 'Could not turn off GitHub Pages'))
}

/** opens a github.com page or a published *.github.io site in the system browser */
export async function openPagesUrl(url: string): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/^(github\.com|[a-z0-9-]+\.github\.io)$/i.test(u.hostname)) throw new Error('not a GitHub page')
  await shell.openExternal(u.toString())
}
