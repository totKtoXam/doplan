/**
 * git with gh's token as a header (github.gitCredentials): curl sends a header of its own over
 * anything a credential helper answers, so a token that changed since it was read can only be
 * recovered by reading it again and repeating the command — once (git.runNet, pagesGit.run).
 * A local HTTP server stands in for GitHub and accepts only the newer header.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const base = mkdtempSync(join(tmpdir(), 'doplan-gitauth-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => base, getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}))

// the developer's own global git config stays out (gitEnv keeps HOME/USERPROFILE): a home of the test's
const home = join(base, 'home')
mkdirSync(home, { recursive: true })
const savedEnv = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] }
process.env['HOME'] = home
process.env['USERPROFILE'] = home
delete process.env['XDG_CONFIG_HOME']
const globalConfig = (text: string) => (text ? writeFileSync(join(home, '.gitconfig'), text) : rmSync(join(home, '.gitconfig'), { force: true }))

const { findGit, gitEffectiveUrls, gitRemoteAddresses, gitRemoteHeads, netTestConfig } = await import('./git')
const { tokenHeaderFits } = await import('./github')
const { pushSite } = await import('./pagesGit')

const OLD = 'Basic ' + Buffer.from('x-access-token:old').toString('base64')
const NEW = 'Basic ' + Buffer.from('x-access-token:new').toString('base64')
const seen: string[] = []
let server: Server
let url = ''

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    seen.push(auth === OLD ? 'old' : auth === NEW ? 'new' : auth ? 'other' : 'none')
    if (auth !== NEW) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end('Bad credentials')
      return
    }
    const service = new URL(req.url ?? '/', 'http://x').searchParams.get('service')
    if (service === 'git-upload-pack') {
      // an empty repository
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' })
      res.end(pkt('# service=git-upload-pack\n') + '0000' + '0000')
      return
    }
    // sending: refused for another reason (not a sign-in problem), so no second retry
    res.writeHead(403).end('Forbidden')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anna/flat.git`
  netTestConfig.push('-c', 'protocol.http.allow=always')
})

afterAll(() => {
  server.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  seen.length = 0
})

// the token header as gitCredentials makes it, for the test server; no credential helper at all
const creds = (h: string) => ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: ${h}`]

/**
 * Rules in the system config (git's own installation) are read too and the test's home cannot hide
 * them: the exact expectations below hold only where it has none.
 */
function systemRules(): boolean {
  try {
    const out = execFileSync('git', ['config', '--system', '--get-regexp', '^(url\\..*\\.(push)?insteadof|credential(\\..*)?\\.username|remote\\.origin\\.(url|pushurl))$'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString().trim() !== ''
  } catch {
    // exit 1: nothing found (or no system config at all)
    return false
  }
}
const systemHasRules = systemRules()
if (systemHasRules) console.warn('gitAuthRetry: the system git config has url.*.insteadOf, credential.*.username or remote.origin rules — the address tests are skipped')

// real git processes: slow on a loaded computer
// skipped where git's system config has such rules of its own: they would change every expectation here
describe.skipIf(systemHasRules)('addresses as git will use them (the global url.*.insteadOf / pushInsteadOf, pushurl, credential.username)', { timeout: 60_000 }, () => {
  const plain = 'https://github.com/anna/flat.git'
  let root = ''
  beforeAll(() => {
    root = join(base, 'rules')
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q', root], { windowsHide: true })
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', plain], { windowsHide: true })
  })
  beforeEach(() => globalConfig(''))
  afterAll(() => globalConfig(''))

  it('no rules: the address as written, the header fits', async () => {
    expect(await gitEffectiveUrls(null, [plain])).toEqual({ effective: [plain], ownAccount: false })
    expect(await gitRemoteAddresses(root)).toMatchObject({ urls: [plain], push: [], effective: [plain], ownAccount: false })
  })

  it("a global rule that adds the user's own token: no gh header (Pages and the project)", async () => {
    globalConfig('[url "https://x-access-token:PAT@github.com/"]\n\tinsteadOf = https://github.com/\n')
    const urls = (await gitEffectiveUrls(null, [plain])).effective
    expect(urls).toContain('https://x-access-token:PAT@github.com/anna/flat.git')
    expect(tokenHeaderFits(urls)).toBe(false)
    expect(tokenHeaderFits((await gitRemoteAddresses(root)).effective)).toBe(false)
  })

  it('a global push rule with a user name (an account in the credential manager): no header', async () => {
    globalConfig('[url "https://work-acct@github.com/"]\n\tpushInsteadOf = https://github.com/\n')
    const a = await gitRemoteAddresses(root)
    expect(a.urls).toEqual([plain])
    expect(a.effective).toContain('https://work-acct@github.com/anna/flat.git')
    expect(tokenHeaderFits(a.effective)).toBe(false)
  })

  it('a pushurl with credentials in the global config: no header', async () => {
    globalConfig('[remote "origin"]\n\tpushurl = https://me:tok@github.com/anna/flat.git\n')
    const a = await gitRemoteAddresses(root)
    expect(a.urls).toEqual([plain])
    expect(a.effective).toEqual([plain, 'https://me:tok@github.com/anna/flat.git'])
    expect(tokenHeaderFits(a.effective)).toBe(false)
  })

  it('an account named for github.com in the credential config (several in the credential manager): gh stays out', async () => {
    globalConfig('[credential "https://github.com"]\n\tusername = work-acct\n')
    expect(await gitRemoteAddresses(root)).toMatchObject({ urls: [plain], effective: [plain], ownAccount: true })
    expect((await gitEffectiveUrls(null, [plain])).ownAccount).toBe(true)
    // without a scheme, as some guides write it
    globalConfig('[credential "github.com"]\n\tusername = work-acct\n')
    expect((await gitRemoteAddresses(root)).ownAccount).toBe(true)
    // one user name for every host
    globalConfig('[credential]\n\tusername = work-acct\n')
    expect((await gitRemoteAddresses(root)).ownAccount).toBe(true)
    expect((await gitEffectiveUrls(null, [plain])).ownAccount).toBe(true)
  })

  it('a user name for one owner\'s path (credential.https://github.com/work-org) counts only under that path', async () => {
    globalConfig('[credential "https://github.com/work-org"]\n\tusername = work-acct\n')
    const a = await gitRemoteAddresses(root)
    expect(a.ownAccount).toBe(false)
    expect((await gitEffectiveUrls(null, [plain])).ownAccount).toBe(false)
    expect((await gitEffectiveUrls(null, ['https://github.com/work-org/site.git'])).ownAccount).toBe(true)
    expect((await gitEffectiveUrls(null, ['https://github.com/work-org2/site.git'])).ownAccount).toBe(false)
  })

  // forward slashes: git reads the include paths and patterns
  const slashed = (p: string) => realpathSync.native(p).replace(/\\/g, '/')

  it('an include that depends on the remote (includeIf "hasconfig:remote.*.url:…"): counts once the remote is set', async () => {
    writeFileSync(join(home, 'work.gitconfig'), '[credential "https://github.com"]\n\tusername = work-acct\n')
    globalConfig(`[includeIf "hasconfig:remote.*.url:https://github.com/work-org/**"]\n\tpath = ${slashed(home)}/work.gitconfig\n`)
    const fresh = join(base, 'rules-include')
    mkdirSync(fresh, { recursive: true })
    execFileSync('git', ['init', '-q', fresh], { windowsHide: true })
    expect((await gitRemoteAddresses(fresh)).ownAccount).toBe(false)
    execFileSync('git', ['-C', fresh, 'remote', 'add', 'origin', 'https://github.com/work-org/site.git'], { windowsHide: true })
    expect((await gitRemoteAddresses(fresh)).ownAccount).toBe(true)
    // moved to another owner: the include is off again
    execFileSync('git', ['-C', fresh, 'remote', 'set-url', 'origin', 'https://github.com/anna/site.git'], { windowsHide: true })
    expect((await gitRemoteAddresses(fresh)).ownAccount).toBe(false)
  })

  it('an include for the folder the push runs in (includeIf "gitdir:…"): read in that repository, not outside', async () => {
    writeFileSync(join(home, 'personal.gitconfig'), '[credential "https://github.com"]\n\tusername = personal\n')
    const sites = join(base, 'sites')
    const site = join(sites, 'one')
    mkdirSync(site, { recursive: true })
    execFileSync('git', ['init', '-q', site], { windowsHide: true })
    globalConfig(`[includeIf "gitdir/i:${slashed(sites)}/"]\n\tpath = ${slashed(home)}/personal.gitconfig\n`)
    expect((await gitEffectiveUrls(null, [plain])).ownAccount).toBe(false)
    expect((await gitEffectiveUrls(site, [plain])).ownAccount).toBe(true)
  })

  /**
   * Comparisons with git itself, each case in a config file of its own included by `-c include.path`
   * (the same file syntax as the global config): the cases run side by side, a few git processes at a
   * time, so a loaded computer makes them slower but never wrong.
   */
  const cases = join(base, 'credential-cases')
  mkdirSync(cases, { recursive: true })
  let caseNo = 0
  function caseConfig(text: string): string {
    const file = join(cases, `${++caseNo}.gitconfig`)
    writeFileSync(file, text)
    return `include.path=${slashed(file)}`
  }

  // git's own answer: the user name `git credential fill` ends up with (a helper that names none: "none")
  const HELPER = '!f() { u=; while read l; do case "$l" in username=*) u=1;; esac; done; [ -z "$u" ] && echo username=none; echo password=p; }; f'
  function gitUserFor(include: string, target: string): Promise<string> {
    return new Promise((ok, fail) => {
      const child = execFile(
        'git',
        ['-c', include, '-c', 'credential.helper=', '-c', `credential.helper=${HELPER}`, 'credential', 'fill'],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true },
        (err, out) => (err ? fail(err) : ok(/^username=(.*)$/m.exec(String(out))?.[1] ?? '')),
      )
      child.stdin?.end(`url=${target}\n\n`)
    })
  }

  /** ours: configMatching copies netTestConfig before its first await, so the include reaches this call only */
  function ownAccountWith(include: string, target: string): Promise<boolean> {
    netTestConfig.push('-c', include)
    const read = gitEffectiveUrls(null, [target])
    netTestConfig.splice(netTestConfig.length - 2, 2)
    return read.then((a) => a.ownAccount)
  }

  /** `fn` over `items`, at most `limit` at a time, results in order */
  async function pooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
  }

  /** each [config text, target] compared with git: what git applies and what ownAccount says */
  function compare(list: { label: Record<string, unknown>; text: string; target: string }[]) {
    return pooled(list, 8, async ({ label, text, target }) => {
      const include = caseConfig(text)
      const [git, own] = await Promise.all([gitUserFor(include, target), ownAccountWith(include, target)])
      return { ...label, target, git: git === 'acct', own }
    })
  }

  it('a context git cannot normalise (no host, %XX in the host, "://host"): never "not the user\'s" where git applies it', { timeout: 300_000 }, async () => {
    const odd = ['https:///anna/flat.git', 'https:////anna/flat.git', 'https:///anna', 'https://github%2Ecom/anna%2Fflat.git', 'https://github%2Ecom//anna/flat.git', 'https://github.com:x', '://github.com', '://github.com/anna/flat.git']
    const targets = [plain, 'https://github.com/anna/flat.git/', 'https://github.com/work-org/site.git']
    const list = odd.flatMap((ctx) => targets.map((target) => ({ label: { ctx }, text: `[credential "${ctx}"]\n\tusername = acct\n`, target })))
    const results = await compare(list)
    // an extra "yes" only keeps gh out; a "no" where git uses the user's account would send gh's token
    expect(results.filter((r) => r.git && !r.own)).toEqual([])
  })

  it('a user name counts exactly where git itself applies it (git credential fill)', { timeout: 300_000 }, async () => {
    const table: [string, string][] = [
      ['https://github.com/work-org', 'https://github.com/work-org/repo.git'],
      ['https://github.com/work-org', 'https://github.com/anna/flat.git'],
      ['https://github.com/work-org', 'https://github.com/work-org2/repo.git'],
      ['https://github.com/work-org/', 'https://github.com/work-org/repo.git'],
      ['https://github.com/Work-Org', 'https://github.com/work-org/repo.git'],
      ['https://github.com/an%6Ea', 'https://github.com/anna/flat.git'],
      ['https://github.com/anna/flat', 'https://github.com/anna/flat.git'],
      ['https://github.com/anna/flat.git/', 'https://github.com/anna/flat.git'],
      ['https://github.com/', 'https://github.com/anna/flat.git'],
      ['https://GitHub.com', 'https://github.com/anna/flat.git'],
      ['https://github.com:443', 'https://github.com/anna/flat.git'],
      ['http://github.com', 'https://github.com/anna/flat.git'],
      ['https://me@github.com', 'https://github.com/anna/flat.git'],
      ['https://*.github.com', 'https://github.com/anna/flat.git'],
      ['https://*.github.com', 'https://gist.github.com/anna/flat.git'],
      ['github.com', 'https://github.com/anna/flat.git'],
      ['github.com/anna', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat.git', 'https://github.com/anna/flat.git'],
      // a context without a scheme: git decodes it all (%2F too) and drops leading and trailing "/"
      ['github.com/anna/flat.git/', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat.git//', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat', 'https://github.com/anna/flat/'],
      ['github.com/anna/flat.git', 'https://github.com/anna/flat.git/'],
      ['github.com/anna/flat.git', 'https://github.com//anna/flat.git'],
      ['github.com//anna/flat.git', 'https://github.com/anna/flat.git'],
      ['github.com/anna%2Fflat.git', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat.git', 'https://github.com/anna%2Fflat.git'],
      ['github.com/anna/fl%61t.git', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat.git?x', 'https://github.com/anna/flat.git'],
      ['github.com/anna/flat.git#x', 'https://github.com/anna/flat.git'],
      ['github.com/an na/flat.git', 'https://github.com/an%20na/flat.git'],
      // …and its host with the port as written, case-sensitive
      ['github.com:443', 'https://github.com:443/anna/flat.git'],
      ['github.com:443', 'https://github.com/anna/flat.git'],
      ['github.com', 'https://github.com:443/anna/flat.git'],
      ['GitHub.com', 'https://github.com/anna/flat.git'],
      ['github.com', 'https://GitHub.com/anna/flat.git'],
      // a context with a scheme: the url's path as git reads it (decoded, no leading or trailing "/")
      ['https://github.com/anna', 'https://github.com/anna%2Fflat.git'],
      ['https://github.com/anna', 'https://github.com//anna/flat.git'],
      ['https://github.com/anna/flat.git', 'https://github.com/anna/flat.git/'],
      ['https://github.com/anna/flat.git/', 'https://github.com/anna/flat.git//'],
      ['https://github.com/anna%2Fflat.git', 'https://github.com/anna/flat.git'],
      ['https://github.com/anna/flat.git', 'https://github.com/anna/flat.git?x=1'],
      ['https://github.com/anna?x', 'https://github.com/anna/flat.git'],
      ['https://github.com/an na', 'https://github.com/an%20na/flat.git'],
      ['https://github.com.', 'https://github.com/anna/flat.git'],
      ['https://github.com', 'https://github.com./anna/flat.git'],
    ]
    const list = [false, true].flatMap((useHttpPath) =>
      table.map(([ctx, target]) => ({ label: { ctx, useHttpPath }, text: `[credential]\n\tuseHttpPath = ${useHttpPath}\n[credential "${ctx}"]\n\tusername = acct\n`, target })),
    )
    const results = await compare(list)
    expect(results.filter((r) => r.git !== r.own)).toEqual([])
    // the comparison saw both answers
    expect(results.some((r) => r.git)).toBe(true)
    expect(results.some((r) => !r.git)).toBe(true)
  })

  it('an address git cannot be asked about safely (a stray % in its user name) never breaks the read', async () => {
    globalConfig('[credential "me@github.com"]\n\tusername = acct\n')
    const odd = 'https://a%ZZ@github.com/anna/flat.git'
    expect((await gitEffectiveUrls(null, [odd])).ownAccount).toBe(false)
    globalConfig('[credential "https://me@github.com"]\n\tusername = acct\n')
    expect((await gitEffectiveUrls(null, [odd])).ownAccount).toBe(false)
  })

  it('a user name for another host does not count', async () => {
    globalConfig('[credential "https://gitlab.com"]\n\tusername = work-acct\n[credential "https://github.com.evil.example"]\n\tusername = x\n')
    expect((await gitRemoteAddresses(root)).ownAccount).toBe(false)
    expect((await gitEffectiveUrls(null, [plain])).ownAccount).toBe(false)
  })
})

describe('a refused token header is read again once', { timeout: 60_000 }, () => {
  it('project sync (git.runNet): the command repeats with the new header and succeeds', async () => {
    expect(await findGit()).toBeTruthy()
    const root = join(base, 'project')
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q', root], { windowsHide: true })
    const refresh = vi.fn(async () => ({ config: creds(NEW), env: {} }))
    const net = { config: creds(OLD), env: {}, interactive: false, refresh }
    expect(await gitRemoteHeads(root, net, url)).toEqual({ empty: true, head: null, branches: [] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(seen).toContain('old')
    expect(seen[seen.length - 1]).toBe('new')
    // the later commands of the action use the new header; no second refresh
    expect(net.refresh).toBeUndefined()
    seen.length = 0
    await gitRemoteHeads(root, net, url)
    expect(seen).not.toContain('old')
  })

  it('refused again after the refresh: an error, not a loop', async () => {
    const root = join(base, 'project')
    const refresh = vi.fn(async () => ({ config: creds(OLD), env: {} }))
    await expect(gitRemoteHeads(root, { config: creds(OLD), env: {}, interactive: false, refresh }, url)).rejects.toThrow()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('no refresh (a header-less remote): no repeat', async () => {
    const root = join(base, 'project')
    await expect(gitRemoteHeads(root, { config: creds(OLD), env: {}, interactive: false }, url)).rejects.toThrow()
    expect(seen.every((s) => s === 'old' || s === 'none')).toBe(true)
  })

  it('Pages (pagesGit.run): the push repeats with the new header', async () => {
    const git = (await findGit())!
    const site = join(base, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'index.html'), '<p>plan</p>')
    const hooks = join(base, 'hooks')
    mkdirSync(hooks, { recursive: true })
    const refresh = vi.fn(async () => ({ config: [...creds(NEW), '-c', 'protocol.http.allow=always'], env: {} }))
    const runner = { git, hooksDir: hooks, config: [...creds(OLD), '-c', 'protocol.http.allow=always'], env: {}, refresh }
    // the test server refuses the send itself with 403: the point is which header reached it
    await expect(pushSite(runner, site, url, 'gh-pages', 'test', null)).rejects.toThrow(/403/)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(seen).toContain('old')
    expect(seen[seen.length - 1]).toBe('new')
  })

  it('Pages: the credentials are read inside the site\'s repository once it exists, and used for the push', async () => {
    const git = (await findGit())!
    const site = join(base, 'site2')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'index.html'), '<p>plan</p>')
    const hooks = join(base, 'hooks')
    mkdirSync(hooks, { recursive: true })
    const where: boolean[] = []
    const credentials = vi.fn(async (dir: string) => {
      where.push(existsSync(join(dir, '.git')))
      return { config: [...creds(NEW), '-c', 'protocol.http.allow=always'], env: {} }
    })
    const runner = { git, hooksDir: hooks, config: [...creds(OLD), '-c', 'protocol.http.allow=always'], env: {}, credentials }
    await expect(pushSite(runner, site, url, 'gh-pages', 'test', null)).rejects.toThrow(/403/)
    expect(credentials).toHaveBeenCalledTimes(1)
    expect(credentials).toHaveBeenCalledWith(site)
    expect(where).toEqual([true])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s === 'new')).toBe(true)
  })
})
