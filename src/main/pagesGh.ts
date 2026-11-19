/**
 * The GitHub Pages calls of "publish for viewing", over the shared GitHub layer (src/main/github.ts:
 * gh's token read once, GitHub's REST API, creating repositories, visibility, the account plan).
 */
import { shell } from 'electron'
import type { PagesConfig, PagesInspection, RepoRef } from '@shared/pagesSite'
import { PAGES_BRANCH, PAGES_MARKER, pagesUrlOf } from '@shared/pagesSite'
import { accountPlan, apiError, createRepo, githubApi, setRepoVisibility, type ApiResponse } from './github'
import { PagesGhError } from './pagesError'
import { msg } from './settings'

/**
 * An API refusal of a Pages call in plain words, with its kind. A 403 is "no admin rights" only when
 * GitHub says so: a rate limit or a token without the permission is not the user's access to the
 * repository (the caller retries later, or signs in again, and keeps its record).
 */
export function pagesError(r: ApiResponse, what: string): PagesGhError {
  const j = r.json as { message?: unknown } | null
  const detail = typeof j?.message === 'string' ? j.message : r.text.slice(0, 300)
  if (r.status === 429 || (r.status === 403 && /rate limit/i.test(detail)))
    return new PagesGhError(
      msg(`${what}: GitHub временно ограничил число запросов. Попробуйте через несколько минут.`, `${what}: GitHub is limiting requests for now. Try again in a few minutes.`),
      'limited',
      r.status,
    )
  if (r.status === 403 && /Resource not accessible by (integration|personal access token)/i.test(detail))
    return new PagesGhError(
      msg(
        `${what}: у токена GitHub нет нужного разрешения. Войдите в GitHub заново (gh auth login) с доступом к репозиториям.`,
        `${what}: the GitHub token lacks the permission. Sign in to GitHub again (gh auth login) with access to repositories.`,
      ),
      'token',
      r.status,
    )
  if (r.status === 403)
    return new PagesGhError(
      msg(`${what}: у этой учётной записи GitHub нет прав администратора репозитория.`, `${what}: this GitHub account has no admin rights on the repository.`),
      'forbidden',
      r.status,
    )
  return new PagesGhError(`${what}: ${apiError(r).message}`, r.status === 404 ? 'notFound' : 'unknown', r.status)
}

const repoPath = (ref: RepoRef) => `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`

// ───────────── repositories ─────────────

export interface RepoState {
  exists: boolean
  isPrivate: boolean
  /** the signed-in user can push to it (write or admin access) */
  canPush?: boolean
  /** the signed-in user administers it (may turn Pages on and off) */
  admin?: boolean
  /** its default branch (GitHub refuses to delete it) */
  defaultBranch?: string
}

export async function repoState(ref: RepoRef): Promise<RepoState> {
  const r = await githubApi('GET', repoPath(ref))
  if (r.status === 404) return { exists: false, isPrivate: false }
  if (r.status !== 200) throw pagesError(r, msg('Не удалось узнать о репозитории', 'Could not read the repository'))
  const j = (r.json ?? {}) as { private?: unknown; default_branch?: unknown; permissions?: { push?: unknown; admin?: unknown } }
  const admin = j.permissions?.admin === true
  return {
    exists: true,
    isPrivate: j.private === true,
    canPush: j.permissions?.push === true || admin,
    admin,
    ...(typeof j.default_branch === 'string' && j.default_branch ? { defaultBranch: j.default_branch } : {}),
  }
}

/**
 * The plan of the account that owns the repository: the user's own for their repositories, the
 * organisation's for an organisation's (GitHub shows it to its owners only). undefined when unknown.
 */
export async function ownerPlan(owner: string, login: string | undefined): Promise<string | undefined> {
  if (login && owner.toLowerCase() === login.toLowerCase()) return (await accountPlan().catch(() => null)) ?? undefined
  const r = await githubApi('GET', `orgs/${encodeURIComponent(owner)}`).catch(() => null)
  const name = r?.status === 200 ? (r.json as { plan?: { name?: unknown } } | null)?.plan?.name : undefined
  return typeof name === 'string' && name ? name.toLowerCase() : undefined
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

const siteUrl = (ref: RepoRef, url: string | undefined) => (url && /^https:\/\//.test(url) ? (url.endsWith('/') ? url : `${url}/`) : pagesUrlOf(ref))

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** the Pages setup of a repository, null when Pages are off */
export async function pagesConfig(ref: RepoRef): Promise<PagesConfig | null> {
  const r = await githubApi('GET', `${repoPath(ref)}/pages`)
  if (r.status === 404) return null
  if (r.status !== 200) throw pagesError(r, msg('Не удалось прочитать настройки Pages', 'Could not read the Pages settings'))
  const j = r.json as { build_type?: unknown; source?: { branch?: unknown; path?: unknown }; html_url?: unknown } | null
  if (!j || typeof j !== 'object') throw new Error(msg('GitHub вернул непонятные настройки Pages', 'GitHub returned unreadable Pages settings'))
  return { buildType: str(j.build_type), branch: str(j.source?.branch), path: str(j.source?.path), url: str(j.html_url) }
}

/** what the repository has in the way of a gh-pages branch, its doplan marker and a Pages site (asked at once) */
export async function inspectPages(ref: RepoRef): Promise<PagesInspection> {
  const branch = async (): Promise<{ branchSha: string | null; marker: string | null }> => {
    const head = await githubApi('GET', `${repoPath(ref)}/git/ref/heads/${PAGES_BRANCH}`)
    // 404: no such branch; 409: an empty repository (no branches at all)
    if (head.status === 404 || head.status === 409) return { branchSha: null, marker: null }
    if (head.status !== 200) throw pagesError(head, msg('Не удалось прочитать ветку gh-pages', 'Could not read the gh-pages branch'))
    const sha = str((head.json as { object?: { sha?: unknown } } | null)?.object?.sha)
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return { branchSha: null, marker: null }
    const m = await githubApi('GET', `${repoPath(ref)}/contents/${PAGES_MARKER}?ref=${sha}`, { accept: 'application/vnd.github.raw' })
    if (m.status === 404) return { branchSha: sha, marker: null }
    if (m.status !== 200) throw pagesError(m, msg('Не удалось прочитать ветку gh-pages', 'Could not read the gh-pages branch'))
    return { branchSha: sha, marker: m.text.slice(0, 4096) }
  }
  const [b, pages] = await Promise.all([branch(), pagesConfig(ref)])
  return { ...b, pages }
}

/**
 * Turns Pages on for the gh-pages branch when they are off (`current` null); a site that is already
 * there (doplan's own, see pagesOwnership) is left as it is. Resolves with the site address.
 */
export async function enablePages(ref: RepoRef, current: PagesConfig | null): Promise<string> {
  if (current) return siteUrl(ref, current.url)
  const res = await githubApi('POST', `${repoPath(ref)}/pages`, { body: { source: { branch: PAGES_BRANCH, path: '/' } } })
  // a POST that races GitHub turning Pages on by itself after the push: 409 means "already on"
  if (res.status === 201 || res.status === 200) return siteUrl(ref, str((res.json as { html_url?: unknown } | null)?.html_url))
  if (res.status !== 409) throw pagesError(res, msg('Не удалось включить GitHub Pages', 'Could not turn on GitHub Pages'))
  const after = await pagesConfig(ref).catch(() => null)
  return siteUrl(ref, after?.url)
}

/** turns Pages off; resolves false when they were not on */
export async function disablePages(ref: RepoRef): Promise<boolean> {
  const r = await githubApi('DELETE', `${repoPath(ref)}/pages`)
  if (r.status === 204 || r.status === 200) return true
  if (r.status === 404) return false
  throw pagesError(r, msg('Не удалось выключить GitHub Pages', 'Could not turn off GitHub Pages'))
}

/** opens a published *.github.io site or a github.com page in the system browser */
export async function openPagesUrl(url: string): Promise<void> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/^(github\.com|[a-z0-9-]+\.github\.io)$/i.test(u.hostname)) throw new Error('not a GitHub page')
  await shell.openExternal(u.toString())
}
