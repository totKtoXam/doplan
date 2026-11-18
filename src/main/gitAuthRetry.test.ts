/**
 * git with gh's token as a header (github.gitCredentials): curl sends a header of its own over
 * anything a credential helper answers, so a token that changed since it was read can only be
 * recovered by reading it again and repeating the command — once (git.runNet, pagesGit.run).
 * A local HTTP server stands in for GitHub and accepts only the newer header.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const { gitCredentials, tokenHeaderFits } = await import('./github')
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

// real git processes: slow on a loaded computer
describe('addresses as git will use them (the global url.*.insteadOf / pushInsteadOf, pushurl)', { timeout: 60_000 }, () => {
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
    expect(await gitEffectiveUrls(null, [plain])).toEqual([plain])
    expect(await gitRemoteAddresses(root)).toEqual({ urls: [plain], effective: [plain] })
  })

  it("a global rule that adds the user's own token: no gh header (Pages and the project)", async () => {
    globalConfig('[url "https://x-access-token:PAT@github.com/"]\n\tinsteadOf = https://github.com/\n')
    const urls = await gitEffectiveUrls(null, [plain])
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

  it('no header: no helper either — the user’s own credentials answer, gh is not asked', async () => {
    // whatever gh would say: no flags, no environment for a user-named address
    expect(await gitCredentials(['https://work-acct@github.com/anna/flat.git'])).toEqual({ config: [], env: {} })
    expect(await gitCredentials(['https://gitlab.com/anna/flat.git'])).toEqual({ config: [], env: {} })
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
})
