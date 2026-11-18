/**
 * The GitHub layer (github.ts, pagesGh.ts) on a computer where every start of gh takes 10–20 s: gh is
 * started once per session (`gh auth token`), everything else goes to GitHub's REST API with that
 * token, a 401 reads the token once more, and a gh that did not answer is never "signed out".
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'doplan-ghauth-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => base, getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
  net: {},
}))

// a gh that is found (a file on PATH) and answers `gh auth token` as the test says
const bin = join(base, 'bin')
mkdirSync(bin, { recursive: true })
writeFileSync(join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh'), '')
process.env['PATH'] = `${bin}${delimiter}${process.env['PATH'] ?? ''}`

const TOKEN = 'gho_' + 'a'.repeat(36)
const TOKEN2 = 'gho_' + 'b'.repeat(36)
const gh = { calls: [] as string[][], answer: 'token' as 'token' | 'token2' | 'none' | 'slow' }
vi.mock('node:child_process', async (orig) => {
  const real = (await orig()) as typeof import('node:child_process')
  return {
    ...real,
    execFile: (_exe: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      gh.calls.push(args)
      setTimeout(() => {
        if (gh.answer === 'slow') cb(Object.assign(new Error('killed'), { killed: true, code: null }), '', '')
        else if (gh.answer === 'none') cb(Object.assign(new Error('exit 1'), { code: 1 }), '', 'no oauth token found for github.com')
        else cb(null, `${gh.answer === 'token' ? TOKEN : TOKEN2}\n`, '')
      }, 5)
      return {} as never
    },
  }
})

const github = await import('./github')
const pagesGh = await import('./pagesGh')

/** GitHub's API as the test describes it: accepts TOKEN2 only after `rotate`, counts requests */
const api = { requests: [] as { method: string; path: string; auth: string; body?: unknown }[], valid: new Set([TOKEN]), down: false, odd: false, repos: new Set<string>() }
function reply(status: number, json?: unknown): Response {
  return new Response(json === undefined ? null : JSON.stringify(json), { status })
}
github.setGithubFetch(async (url, init) => {
  if (api.down) throw Object.assign(new Error('fetch failed'), { name: 'TypeError' })
  const path = url.replace('https://api.github.com/', '')
  const auth = String((init.headers as Record<string, string>).Authorization ?? '')
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  api.requests.push({ method: String(init.method), path, auth, body })
  if (![...api.valid].some((t) => auth === `Bearer ${t}`)) return reply(401, { message: 'Bad credentials' })
  if (api.odd && path === 'user') return reply(503, { message: 'Service Unavailable' })
  // the account of each token: a switch in a terminal shows as another login
  if (path === 'user') return reply(200, { login: auth.includes(TOKEN2) ? 'boris' : 'anna', plan: { name: 'Free' } })
  if (init.method === 'POST' && path === 'user/repos') {
    if (api.repos.has(body.name)) return reply(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] })
    api.repos.add(body.name)
    return reply(201, { name: body.name, owner: { login: 'anna' }, private: body.private })
  }
  const repo = /^repos\/anna\/([^/]+)$/.exec(path)
  if (repo) return api.repos.has(repo[1]) ? reply(200, { private: true, visibility: 'private', default_branch: 'main', permissions: { admin: true, push: true } }) : reply(404, { message: 'Not Found' })
  if (/\/pages$/.test(path)) return reply(404, { message: 'Not Found' })
  if (/\/git\/ref\/heads\//.test(path)) return reply(404, { message: 'Not Found' })
  return reply(404, { message: 'Not Found' })
})

beforeEach(() => {
  github.forgetGhStatus()
  gh.calls.length = 0
  gh.answer = 'token'
  api.requests.length = 0
  api.valid = new Set([TOKEN])
  api.down = false
  api.odd = false
})

describe('gh is started once per session', () => {
  it('status, create, credentials for git, repository and Pages checks: one gh start in all', async () => {
    const st = await github.ghStatus()
    expect(st).toMatchObject({ installed: true, loggedIn: true, user: 'anna' })
    // the dialog opens again: the state doplan knows, nothing asked
    await github.ghStatus()
    const ref = await github.createRepo('flat', true, 'doplan project')
    expect(ref).toEqual({ owner: 'anna', repo: 'flat', ssh: false })
    const cred = await github.gitCredentials(['https://github.com/anna/flat.git'])
    expect(cred.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(await pagesGh.repoState({ owner: 'anna', repo: 'flat' })).toEqual({ exists: true, isPrivate: true, canPush: true })
    expect(await pagesGh.ownerPlan('anna', 'anna')).toBe('free')
    expect(await pagesGh.inspectPages({ owner: 'anna', repo: 'flat' })).toEqual({ branchSha: null, marker: null, pages: null })
    expect(await github.repoInfo('anna', 'flat')).toEqual({ visibility: 'private', defaultBranch: 'main', permission: 'ADMIN' })
    expect(gh.calls).toEqual([['auth', 'token', '--hostname', 'github.com']])
    // the token goes as a header, never in a path or a body
    expect(api.requests.every((r) => r.auth === `Bearer ${TOKEN}` && !r.path.includes(TOKEN) && !JSON.stringify(r.body ?? '').includes(TOKEN))).toBe(true)
  })

  it('callers at once share one gh start', async () => {
    await Promise.all([github.ghStatus(true), github.ghStatus(), github.gitCredentials(), github.ghToken()])
    expect(gh.calls).toHaveLength(1)
  })

  it('a taken name is "name taken", not a sign-in problem', async () => {
    api.repos.add('taken')
    await expect(github.createRepo('taken', true)).rejects.toMatchObject({ kind: 'nameTaken' })
  })
})

describe('"check again" asks gh again (a sign-in or switch made in a terminal)', () => {
  it("not signed in, then gh auth login in a terminal: the dialog's \"check again\" sees it", async () => {
    gh.answer = 'none'
    expect(await github.ghStatus()).toMatchObject({ installed: true, loggedIn: false })
    gh.answer = 'token'
    // opening a dialog again uses what doplan knows…
    expect(await github.ghStatus()).toMatchObject({ loggedIn: false })
    expect(gh.calls).toHaveLength(1)
    // …the button asks gh: one more gh start, and the request to GitHub goes out
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: true, user: 'anna' })
    expect(gh.calls).toHaveLength(2)
    expect(await github.ghToken()).toBe(TOKEN)
  })

  it('gh auth switch in a terminal: "refresh" shows the other account and git gets its token', async () => {
    expect(await github.ghStatus()).toMatchObject({ user: 'anna' })
    api.valid = new Set([TOKEN, TOKEN2])
    gh.answer = 'token2'
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: true, user: 'boris' })
    const cred = await github.gitCredentials(['https://github.com/boris/flat.git'])
    expect(Buffer.from(cred.env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString()).toBe(`x-access-token:${TOKEN2}`)
  })

  it('signed out in a terminal: "check again" says so', async () => {
    await github.ghStatus()
    gh.answer = 'none'
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: false })
    expect(await github.ghToken()).toBeNull()
    expect(await github.gitCredentials(['https://github.com/anna/flat.git'])).toEqual({ config: [], env: {} })
  })

  it('a check that started from the remembered token does not answer a "check again" asked meanwhile', async () => {
    gh.answer = 'none'
    await github.ghStatus()
    github.forgetGhStatus()
    const first = github.ghStatus()
    gh.answer = 'token'
    const again = github.ghStatus(true)
    await first
    expect(await again).toMatchObject({ loggedIn: true })
  })
})

describe('401: the token is read once more', () => {
  it('a token changed meanwhile (signed in again in a terminal): one more gh start, the request repeated', async () => {
    await github.ghStatus(true)
    api.valid = new Set([TOKEN2])
    gh.answer = 'token2'
    expect((await github.createRepo('after-rotate', true)).repo).toBe('after-rotate')
    expect(gh.calls).toHaveLength(2)
    expect(api.requests.filter((r) => r.path === 'user/repos').map((r) => r.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN2}`])
  })

  it('refused twice: "sign in" (and only then)', async () => {
    api.valid = new Set()
    await expect(github.createRepo('nope', true)).rejects.toMatchObject({ kind: 'ghLogin' })
    expect(gh.calls).toHaveLength(2)
    expect(await github.ghStatus(true)).toMatchObject({ installed: true, loggedIn: false })
  })

  it('no token at all: not signed in, no request to GitHub', async () => {
    gh.answer = 'none'
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: false })
    expect(api.requests).toHaveLength(0)
  })
})

describe('slow is not "signed out" (the 0.15.0 bug)', () => {
  it('gh did not answer in time: "slow", never a sign-in, and asked again next time', async () => {
    gh.answer = 'slow'
    const st = await github.ghStatus(true)
    expect(st).toMatchObject({ installed: true, loggedIn: false, slow: true })
    await expect(github.createRepo('slow', true)).rejects.toMatchObject({ kind: 'timeout' })
    gh.answer = 'token'
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: true, user: 'anna' })
  })

  it('signed in before, gh slow now: the last known state stays', async () => {
    await github.ghStatus(true)
    api.valid = new Set()
    gh.answer = 'slow'
    // 401, then gh does not answer the second read: not "signed out"
    const st = await github.ghStatus(true)
    expect(st.slow || st.loggedIn).toBe(true)
  })

  it('GitHub out of reach after a confirmed sign-in: still signed in, the error says "no connection"', async () => {
    await github.ghStatus(true)
    api.down = true
    expect(await github.ghStatus(true)).toMatchObject({ loggedIn: true, user: 'anna' })
    await expect(github.createRepo('offline', true)).rejects.toMatchObject({ kind: 'offline' })
  })

  it('GitHub out of reach at the first check: "could not check", not "sign in", and asked again next time', async () => {
    api.down = true
    const st = await github.ghStatus()
    expect(st).toMatchObject({ installed: true, loggedIn: false, offline: true })
    expect(st.slow).toBeUndefined()
    // not remembered: the next look asks GitHub again (and not gh)
    api.down = false
    expect(await github.ghStatus()).toMatchObject({ loggedIn: true, user: 'anna' })
    expect(await github.ghStatus()).not.toHaveProperty('offline')
    expect(gh.calls).toHaveLength(1)
  })

  it('an odd answer to the check (GitHub 503) is "could not check" too', async () => {
    api.odd = true
    expect(await github.ghStatus()).toMatchObject({ loggedIn: false, offline: true })
  })
})

describe('the token for git', () => {
  it('goes to github.com only, as an environment header', () => {
    const env = github.tokenEnv(TOKEN)
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString()).toBe(`x-access-token:${TOKEN}`)
  })

  it('refuses anything that is not a token (no header injection)', () => {
    expect(github.tokenEnv('abc')).toEqual({})
    expect(github.tokenEnv(`${TOKEN}\nX-Evil: 1`)).toEqual({})
  })

  it('git reads the header from its environment', () => {
    const out = execFileSync('git', ['config', '--get', 'http.https://github.com/.extraheader'], { cwd: base, encoding: 'utf8', env: { ...process.env, ...github.tokenEnv(TOKEN) }, windowsHide: true })
    expect(out.trim()).toMatch(/^Authorization: Basic /)
  })

  it('the fallback helper starts gh for "get" only, and resets other helpers first', () => {
    const args = github.ghHelperArgs('C:\\Program Files\\GitHub CLI\\gh.exe')
    expect(args.slice(0, 2)).toEqual(['-c', 'credential.https://github.com.helper='])
    expect(args[3]).toContain('if [ "$1" = get ]')
    expect(args[3]).toContain("'C:/Program Files/GitHub CLI/gh.exe' auth git-credential get")
    expect(github.ghHelperArgs("C:\\it's\\gh.exe")).toEqual([])
  })

  it('the header goes only with plain https://github.com addresses', () => {
    expect(github.tokenHeaderFits(['https://github.com/anna/flat.git'])).toBe(true)
    expect(github.tokenHeaderFits(['https://GitHub.com/anna/flat'])).toBe(true)
    // a token clone keeps its own credentials; another host or ssh never gets gh's token
    expect(github.tokenHeaderFits(['https://user:ghp_x@github.com/other/repo.git'])).toBe(false)
    expect(github.tokenHeaderFits(['https://user@github.com/other/repo.git'])).toBe(false)
    expect(github.tokenHeaderFits(['https://gitlab.com/anna/flat.git'])).toBe(false)
    expect(github.tokenHeaderFits(['https://github.com.evil.example/anna/flat.git'])).toBe(false)
    expect(github.tokenHeaderFits(['git@github.com:anna/flat.git'])).toBe(false)
    expect(github.tokenHeaderFits(['https://github.com/a/b.git', 'https://x:y@github.com/a/b.git'])).toBe(false)
    expect(github.tokenHeaderFits([])).toBe(false)
  })

  it('a remote with its own credentials: no header (gh helper only), and nothing to refresh', async () => {
    const cred = await github.gitCredentials(['https://user:ghp_x@github.com/other/repo.git'])
    expect(cred.env).toEqual({})
    expect(cred.config[1]).toBe('credential.https://github.com.helper=')
    expect(cred.refresh).toBeUndefined()
  })

  it('a refused header: refresh drops the token, reads gh again once and hands the new one', async () => {
    const cred = await github.gitCredentials(['https://github.com/anna/flat.git'])
    expect(cred.refresh).toBeTypeOf('function')
    gh.answer = 'token2'
    const next = await cred.refresh!()
    expect(Buffer.from(next.env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString()).toBe(`x-access-token:${TOKEN2}`)
    expect(gh.calls).toHaveLength(2)
    // the token was already read again by someone else (an API 401): no third gh start
    const again = await cred.refresh!()
    expect(again.env.GIT_CONFIG_VALUE_0).toBe(next.env.GIT_CONFIG_VALUE_0)
    expect(gh.calls).toHaveLength(2)
  })

  it('not signed in: no header, no helper (the user’s own credential manager answers)', async () => {
    gh.answer = 'none'
    expect(await github.gitCredentials()).toEqual({ config: [], env: {} })
  })
})
