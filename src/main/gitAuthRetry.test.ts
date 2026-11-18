/**
 * git with gh's token as a header (github.gitCredentials): curl sends a header of its own over
 * anything a credential helper answers, so a token that changed since it was read can only be
 * recovered by reading it again and repeating the command — once (git.runNet, pagesGit.run).
 * A local HTTP server stands in for GitHub and accepts only the newer header.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

const { findGit, gitEffectiveUrls, gitRemoteHeads, gitRemoteNetUrls, netTestConfig } = await import('./git')
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
})

beforeEach(() => {
  seen.length = 0
})

// the token header as gitCredentials makes it, for the test server; no credential helper at all
const creds = (h: string) => ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: ${h}`]

// real git processes: slow on a loaded computer
describe('addresses as git will use them (url.*.insteadOf / pushInsteadOf)', () => {
  const PAT = 'https://x-access-token:PAT@github.com/'
  const plain = 'https://github.com/anna/flat.git'
  const without = (flag: string) => {
    const i = netTestConfig.indexOf(flag)
    if (i > 0) netTestConfig.splice(i - 1, 2)
  }

  it('a global rule that adds the user\'s own token: no gh header', async () => {
    const rule = `url.${PAT}.insteadOf=https://github.com/`
    netTestConfig.push('-c', rule)
    try {
      const urls = await gitEffectiveUrls(null, [plain])
      expect(urls).toContain('https://x-access-token:PAT@github.com/anna/flat.git')
      expect(tokenHeaderFits(urls)).toBe(false)
    } finally {
      without(rule)
    }
    expect(tokenHeaderFits(await gitEffectiveUrls(null, [plain]))).toBe(true)
  })

  it('a global push rule counts for the project remote too', async () => {
    const root = join(base, 'rules')
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q', root], { windowsHide: true })
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', plain], { windowsHide: true })
    expect(tokenHeaderFits(await gitRemoteNetUrls(root))).toBe(true)
    // a global push rule (a folder's own url.* rules: doplan does not run git there at all)
    const rule = `url.${PAT}.pushInsteadOf=https://github.com/`
    netTestConfig.push('-c', rule)
    try {
      expect(tokenHeaderFits(await gitRemoteNetUrls(root))).toBe(false)
    } finally {
      without(rule)
    }
    expect(await gitRemoteNetUrls(root)).toEqual([plain])
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
