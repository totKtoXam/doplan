/**
 * The GitHub Pages calls of "publish for viewing", over the shared GitHub CLI layer (src/main/github.ts:
 * finding and running gh, the sign-in state, creating repositories, visibility, the account plan).
 */
import { shell } from 'electron'
import type { PagesConfig, PagesInspection, RepoRef } from '@shared/pagesSite'
import { PAGES_BRANCH, PAGES_MARKER, pagesUrlOf } from '@shared/pagesSite'
import { accountPlan, createRepo, runGh, setRepoVisibility, type GhResult } from './github'
import { msg } from './settings'

/** a gh failure in plain words (the Pages calls: "no admin rights" is the usual refusal) */
export function ghError(r: GhResult, what: string): Error {
  const out = `${r.stderr}\n${r.stdout}`
  if (/HTTP 401|authentication|not logged in|auth login/i.test(out)) return new Error(msg('Сначала войдите в GitHub.', 'Sign in to GitHub first.'))
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

// ───────────── repositories ─────────────

export interface RepoState {
  exists: boolean
  isPrivate: boolean
  /** the signed-in user can push to it (write or admin access) */
  canPush?: boolean
}

export async function repoState(ref: RepoRef): Promise<RepoState> {
  const jq = '"\\(.private) \\((.permissions.push // false) or (.permissions.admin // false))"'
  const r = await runGh(['api', `repos/${ref.owner}/${ref.repo}`, '--jq', jq], 30_000)
  if (r.code !== 0) {
    if (/HTTP 404|Not Found/i.test(r.stderr)) return { exists: false, isPrivate: false }
    throw ghError(r, msg('Не удалось узнать о репозитории', 'Could not read the repository'))
  }
  const [priv, push] = r.stdout.trim().split(/\s+/)
  return { exists: true, isPrivate: priv === 'true', canPush: push === 'true' }
}

/**
 * The plan of the account that owns the repository: the user's own for their repositories, the
 * organisation's for an organisation's (GitHub shows it to its owners only). undefined when unknown.
 */
export async function ownerPlan(owner: string, login: string | undefined): Promise<string | undefined> {
  if (login && owner.toLowerCase() === login.toLowerCase()) return (await accountPlan().catch(() => null)) ?? undefined
  const r = await runGh(['api', `orgs/${owner}`, '--jq', '.plan.name // empty'], 20_000)
  const name = r.code === 0 ? r.stdout.trim().toLowerCase() : ''
  return name || undefined
}

export async function makePublic(ref: RepoRef): Promise<void> {
  await setRepoVisibility(ref.owner, ref.repo, 'public')
}

/** creates a public repository on the signed-in account */
export async function createPublicRepo(name: string, description: string): Promise<RepoRef> {
  const r = await createRepo(name, false, description)
  return { owner: r.owner, repo: r.repo }
}

// ───────────── Pages ─────────────

const notFound = (r: GhResult) => /HTTP 404|Not Found/i.test(r.stderr)

const siteUrl = (ref: RepoRef, url: string | undefined) => (url && /^https:\/\//.test(url) ? (url.endsWith('/') ? url : `${url}/`) : pagesUrlOf(ref))

/** the Pages setup of a repository, null when Pages are off */
export async function pagesConfig(ref: RepoRef): Promise<PagesConfig | null> {
  const r = await runGh(['api', `repos/${ref.owner}/${ref.repo}/pages`], 30_000)
  if (r.code !== 0) {
    if (notFound(r)) return null
    throw ghError(r, msg('Не удалось прочитать настройки Pages', 'Could not read the Pages settings'))
  }
  let j: { build_type?: unknown; source?: { branch?: unknown; path?: unknown }; html_url?: unknown }
  try {
    j = JSON.parse(r.stdout) as typeof j
  } catch {
    throw new Error(msg('GitHub вернул непонятные настройки Pages', 'GitHub returned unreadable Pages settings'))
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return { buildType: s(j.build_type), branch: s(j.source?.branch), path: s(j.source?.path), url: s(j.html_url) }
}

/** what the repository has in the way of a gh-pages branch, its doplan marker and a Pages site */
export async function inspectPages(ref: RepoRef): Promise<PagesInspection> {
  const base = `repos/${ref.owner}/${ref.repo}`
  const head = await runGh(['api', `${base}/git/ref/heads/${PAGES_BRANCH}`, '--jq', '.object.sha'], 30_000)
  let branchSha: string | null = null
  if (head.code === 0) branchSha = head.stdout.trim() || null
  // 409: an empty repository (no branches at all)
  else if (!notFound(head) && !/HTTP 409/i.test(head.stderr)) throw ghError(head, msg('Не удалось прочитать ветку gh-pages', 'Could not read the gh-pages branch'))
  let marker: string | null = null
  if (branchSha) {
    const m = await runGh(['api', '-H', 'Accept: application/vnd.github.raw', `${base}/contents/${PAGES_MARKER}?ref=${branchSha}`], 30_000)
    if (m.code === 0) marker = m.stdout.slice(0, 4096)
    else if (!notFound(m)) throw ghError(m, msg('Не удалось прочитать ветку gh-pages', 'Could not read the gh-pages branch'))
  }
  return { branchSha, marker, pages: await pagesConfig(ref) }
}

/**
 * Turns Pages on for the gh-pages branch when they are off (`current` null); a site that is already
 * there (doplan's own, see pagesOwnership) is left as it is. Resolves with the site address.
 */
export async function enablePages(ref: RepoRef, current: PagesConfig | null): Promise<string> {
  if (current) return siteUrl(ref, current.url)
  const api = `repos/${ref.owner}/${ref.repo}/pages`
  const res = await runGh(['api', '-X', 'POST', api, '-f', `source[branch]=${PAGES_BRANCH}`, '-f', 'source[path]=/'], 30_000)
  // a POST that races GitHub turning Pages on by itself after the push: 409 means "already on"
  if (res.code !== 0 && !/HTTP 409|already exists/i.test(res.stderr)) throw ghError(res, msg('Не удалось включить GitHub Pages', 'Could not turn on GitHub Pages'))
  const after = await runGh(['api', api, '--jq', '.html_url'], 30_000)
  return siteUrl(ref, after.code === 0 ? after.stdout.trim() : undefined)
}

/** turns Pages off; resolves false when they were not on */
export async function disablePages(ref: RepoRef): Promise<boolean> {
  const r = await runGh(['api', '-X', 'DELETE', `repos/${ref.owner}/${ref.repo}/pages`], 30_000)
  if (r.code === 0) return true
  if (/HTTP 404|Not Found/i.test(r.stderr)) return false
  throw ghError(r, msg('Не удалось выключить GitHub Pages', 'Could not turn off GitHub Pages'))
}

/** opens a published *.github.io site or a github.com page in the system browser */
export async function openPagesUrl(url: string): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/^(github\.com|[a-z0-9-]+\.github\.io)$/i.test(u.hostname)) throw new Error('not a GitHub page')
  await shell.openExternal(u.toString())
}
