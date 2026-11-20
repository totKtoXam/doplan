/**
 * The publish / update / unpublish flow against a fake GitHub (gh and git mocked): doplan only ever
 * touches a gh-pages branch with its own marker and a Pages site serving it, updates go to the
 * recorded repository, the Pages rule follows the repository owner's plan, a failed Pages switch takes
 * the new branch back, and a record follows its document when the file gets an id.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PagesConfig, PagesPublishRequest, RepoRef } from '@shared/pagesSite'
import { docTag, markerDoc, markerId, pagesMarker } from '@shared/pagesSite'

const base = mkdtempSync(join(tmpdir(), 'doplan-pages-flow-'))
const userData = join(base, 'userData')
const project = join(base, 'project')
mkdirSync(join(base, 'viewer'), { recursive: true })
writeFileSync(join(base, 'viewer', 'viewer.html'), '<!doctype html>')
mkdirSync(join(project, '.git'), { recursive: true })

interface FakeRepo {
  private: boolean
  branchSha: string | null
  marker: string | null
  pages: PagesConfig | null
  /** the signed-in user may push (default true) */
  push?: boolean
  /** the signed-in user may change the Pages settings (default: push) */
  admin?: boolean
  /** a custom role that may manage Pages: allowed, but the permissions show write access only */
  customPages?: boolean
  /** default 'main'; a repository doplan creates starts empty, so its first branch gh-pages is the default */
  defaultBranch?: string
}

const gh = {
  repos: new Map<string, FakeRepo>(),
  userPlan: 'free' as string | undefined,
  orgPlans: {} as Record<string, string | undefined>,
  failEnable: false,
  failPush: 0,
  /** the open project's sync: origin URLs and upstream branch */
  syncUrls: [] as string[],
  syncBranch: null as string | null,
  calls: [] as string[],
  seq: 0,
}
const k = (r: RepoRef) => `${r.owner}/${r.repo}`
const fromRemote = (url: string) => /github\.com\/(.+)\.git$/.exec(url)?.[1] ?? url
const repo = (key: string) => {
  const r = gh.repos.get(key)
  if (!r) throw new Error(`no repo ${key}`)
  return r
}
const fresh = (over: Partial<FakeRepo> = {}): FakeRepo => ({ private: false, branchSha: null, marker: null, pages: null, ...over })
const nextSha = () => (++gh.seq).toString(16).padStart(40, '0')

vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '0.0.0-test' } }))
vi.mock('./paths', () => ({ mainDir: join(base, 'main'), paths: { userData, catalogRoot: join(base, 'c'), library: join(base, 'l'), projectAssets: join(base, 'p') } }))
vi.mock('./settings', () => ({ msg: (ru: string) => ru }))
vi.mock('./ipc', () => ({ handleIpc: () => undefined }))
vi.mock('./window', () => ({ sendToRenderer: () => undefined }))
vi.mock('./git', () => ({
  findGit: async () => 'git',
  gitEffectiveUrls: async (_root: unknown, urls: string[]) => ({ effective: urls, ownAccount: false }),
  gitInit: async () => undefined,
  gitRemoteUrls: async () => gh.syncUrls,
  gitUpstreamBranch: async () => gh.syncBranch,
  // only deletes here (the site itself goes up through pagesGit.pushSite)
  gitPushRef: async (_root: string, net: { config?: string[] }, src: string | null, _branch: string, opts: { remote: string; expected?: string }) => {
    if (src !== null || !opts.expected) throw new Error('pages: a delete with the checked head only')
    if (!net.config?.includes('credential.helper=gh')) throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled")
    const key = fromRemote(opts.remote)
    gh.calls.push(`delete ${key}`)
    const r = repo(key)
    if (r.branchSha !== opts.expected) throw new Error('stale info')
    if ((r.defaultBranch ?? 'main') === 'gh-pages') throw Object.assign(new Error('git push: error: failed to push some refs'), { stderr: 'deletion of the current branch prohibited' })
    r.branchSha = null
    r.marker = null
  },
}))
vi.mock('./github', () => ({
  ghStatus: async () => ({ installed: true, loggedIn: true, user: 'me' }),
  ghMissingText: () => 'gh missing',
  ghLoginText: () => 'gh login',
  ghSlowText: () => 'gh slow',
  ghOfflineText: () => 'gh offline',
  // gh's token for git: without it a push fails (signed in through gh only, no git credential)
  gitCredentials: async () => ({ config: ['-c', 'credential.helper=gh'], env: {} }),
}))
vi.mock('./projectFolder', () => ({ getProjectRoot: () => project }))
vi.mock('./pagesBuild', () => ({
  buildSite: async ({ outDir }: { outDir: string }) => {
    mkdirSync(outDir, { recursive: true })
    return { bytes: 10, files: 3, missing: [], tooLarge: [] }
  },
}))
vi.mock('./pagesGh', () => ({
  openPagesUrl: async () => undefined,
  repoState: async (ref: RepoRef) => {
    const r = gh.repos.get(k(ref))
    return r
      ? { exists: true, isPrivate: r.private, canPush: r.push !== false, managesPages: (r.admin ?? r.push) !== false, defaultBranch: r.defaultBranch ?? 'main' }
      : { exists: false, isPrivate: false }
  },
  ownerPlan: async (owner: string, login: string | undefined) => (owner === login ? gh.userPlan : gh.orgPlans[owner]),
  inspectPages: async (ref: RepoRef) => {
    const r = repo(k(ref))
    return { branchSha: r.branchSha, marker: r.branchSha ? r.marker : null, pages: r.pages }
  },
  makePublic: async (ref: RepoRef) => {
    gh.calls.push(`public ${k(ref)}`)
    repo(k(ref)).private = false
  },
  createPublicRepo: async (name: string) => {
    gh.calls.push(`create me/${name}`)
    gh.repos.set(`me/${name}`, fresh({ defaultBranch: 'gh-pages' }))
    return { owner: 'me', repo: name }
  },
  enablePages: async (ref: RepoRef, current: PagesConfig | null) => {
    gh.calls.push(`pages ${k(ref)} ${current ? 'keep' : 'new'}`)
    if (gh.failEnable) throw new Error('HTTP 422: plan does not support Pages')
    const r = repo(k(ref))
    if (!current) r.pages = { buildType: 'legacy', branch: 'gh-pages', path: '/', url: `https://${ref.owner}.github.io/${ref.repo}/` }
    return r.pages?.url ?? ''
  },
  disablePages: async (ref: RepoRef) => {
    gh.calls.push(`nopages ${k(ref)}`)
    // what pagesGh.pagesError makes of GitHub's 403 'Must have admin rights to Repository.': translated text, typed kind
    const { PagesGhError } = await import('./pagesError')
    if ((repo(k(ref)).admin ?? repo(k(ref)).push) === false && !repo(k(ref)).customPages)
      throw new PagesGhError('Не удалось выключить GitHub Pages: у этой учётной записи GitHub нет прав администратора репозитория.', 'forbidden', 403)
    repo(k(ref)).pages = null
    return true
  },
}))
vi.mock('./pagesGit', () => ({
  pushSite: async (
    runner: { config?: string[]; credentials?: (dir: string) => Promise<{ config: string[] }> },
    siteDir: string,
    remote: string,
    _b: string,
    _m: string,
    expected: string | null,
  ) => {
    const key = fromRemote(remote)
    gh.calls.push(`push ${key}`)
    // as pagesGit does: the credentials are read inside the site's repository
    const net = runner.credentials ? await runner.credentials(siteDir) : runner
    if (!net.config?.includes('credential.helper=gh')) throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled")
    if (gh.failPush > 0) {
      gh.failPush--
      throw new Error('could not resolve host: github.com')
    }
    const r = repo(key)
    if (r.push === false) throw new Error('remote: Permission to x denied. The requested URL returned error: 403')
    if (r.branchSha !== expected) throw new Error('stale info')
    r.branchSha = nextSha()
    r.marker = readFileSync(join(siteDir, '.doplan-pages.json'), 'utf8')
    return r.branchSha
  },
}))

const { pagesStatus, publishPlan, unpublishPlan } = await import('./pages')

// every test runs whole publish flows (files, JSON records): under load 5 s is not enough, and a test
// cut off by its timeout leaves its publish running into the next one ("publishing is already running")
vi.setConfig({ testTimeout: 60_000 })

const setOrigin = (url: string | null) =>
  writeFileSync(join(project, '.git', 'config'), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n` : '[core]\n\tbare = false\n')

function req(over: Partial<PagesPublishRequest> = {}): PagesPublishRequest {
  return {
    docId: 'doc1',
    content: { doc: {}, catalog: { version: 1, materials: [], assets: [], hdris: [] }, files: [], notDownloaded: [] },
    info: { title: 'Flat', publishedAt: '2026-01-01T00:00:00.000Z', contentHash: 'h1', app: 'doplan test' },
    target: 'project',
    ...over,
  }
}

const status = (docId = 'doc1', aliases?: string[]) => pagesStatus({ docId, contentHash: 'h1', name: 'Flat', ...(aliases ? { aliases } : {}) })

beforeEach(() => {
  gh.repos.clear()
  gh.calls = []
  gh.syncUrls = []
  gh.syncBranch = null
  gh.userPlan = 'free'
  gh.orgPlans = {}
  gh.failEnable = false
  gh.failPush = 0
  rmSync(join(userData, 'pages.json'), { force: true })
  rmSync(join(userData, 'pages-repos.json'), { force: true })
  setOrigin('https://github.com/me/flat.git')
})

describe('publishing never takes over what doplan did not make', () => {
  it('leaves a foreign gh-pages branch alone and offers a separate repository; a taken -view name gets a number', async () => {
    gh.repos.set('me/flat', fresh({ branchSha: 'f'.repeat(40), marker: null }))
    gh.repos.set('me/flat-view', fresh()) // someone's repository with that name
    const st = await status()
    expect(st.project?.occupied).toBe('branch')
    expect(st.separateName).toBe('flat-view-2')

    await expect(publishPlan(req())).rejects.toThrow(/gh-pages/)
    expect(gh.calls).toEqual([])

    const res = await publishPlan(req({ target: 'separate' }))
    expect(res.record).toMatchObject({ owner: 'me', repo: 'flat-view-2', separate: true })
    expect(gh.calls).toEqual(['create me/flat-view-2', 'push me/flat-view-2', 'pages me/flat-view-2 new'])
    expect(repo('me/flat').branchSha).toBe('f'.repeat(40))
    expect(repo('me/flat-view').branchSha).toBeNull()
  })

  it('does not re-point or turn off a Pages site of the repository (main:/docs, Actions)', async () => {
    for (const pages of [
      { buildType: 'legacy', branch: 'main', path: '/docs', url: 'https://me.github.io/flat/' },
      { buildType: 'workflow', url: 'https://me.github.io/flat/' },
    ]) {
      gh.repos.set('me/flat', fresh({ pages }))
      gh.calls = []
      expect((await status()).project?.occupied).toBe('site')
      await expect(publishPlan(req())).rejects.toThrow(/GitHub Pages/)
      expect(gh.calls).toEqual([])
      expect(repo('me/flat').pages).toEqual(pages)
    }
  })

  it('publishes with its marker, keeps its own site on update and unpublishes only its own', async () => {
    gh.repos.set('me/flat', fresh())
    const first = await publishPlan(req())
    expect(markerId(repo('me/flat').marker)).toBe(first.record.pubId)
    const again = await publishPlan(req())
    expect(again.record.pubId).toBe(first.record.pubId)
    expect(gh.calls).toEqual(['push me/flat', 'pages me/flat new', 'push me/flat', 'pages me/flat keep'])

    await unpublishPlan('doc1')
    // the branch goes first, Pages are turned off after it (an emptying push may turn them on again)
    expect(gh.calls.slice(4)).toEqual(['delete me/flat', 'nopages me/flat'])
    expect((await status()).record).toBeNull()

    // published again, then someone replaced the branch with their own: unpublish leaves both alone
    await publishPlan(req())
    const r = repo('me/flat')
    r.branchSha = 'e'.repeat(40)
    r.marker = null
    gh.calls = []
    await unpublishPlan('doc1')
    expect(gh.calls).toEqual([])
    expect(r.branchSha).toBe('e'.repeat(40))
    expect(r.pages).not.toBeNull()
  })
})

describe('updates go to the recorded repository', () => {
  it('pushes to the recorded repository after the origin moved, and unpublishes there', async () => {
    gh.repos.set('a/flat', fresh())
    gh.repos.set('b/flat2', fresh())
    setOrigin('https://github.com/a/flat.git')
    await publishPlan(req())
    setOrigin('git@github.com:b/flat2.git')
    const res = await publishPlan(req())
    expect(res.record).toMatchObject({ owner: 'a', repo: 'flat' })
    expect(gh.calls.filter((c) => c.startsWith('push'))).toEqual(['push a/flat', 'push a/flat'])
    await unpublishPlan('doc1')
    expect(repo('a/flat').branchSha).toBeNull()
    expect(repo('b/flat2').branchSha).toBeNull()
    expect(gh.calls.some((c) => c.includes('b/flat2'))).toBe(false)
  })

  it('offers the choice again when the recorded repository turned private on Free, and moves to a separate one', async () => {
    gh.repos.set('me/flat', fresh())
    await publishPlan(req())
    repo('me/flat').private = true
    const st = await status()
    expect(st.recordTarget?.needsChoice).toBe(true)
    await expect(publishPlan(req())).rejects.toThrow(/приватный/)

    gh.calls = []
    const res = await publishPlan(req({ privateChoice: 'separate' }))
    expect(res.record).toMatchObject({ owner: 'me', repo: 'flat-view', separate: true })
    // the old site in the now private repository is taken down
    expect(gh.calls).toEqual(['create me/flat-view', 'push me/flat-view', 'pages me/flat-view new', 'delete me/flat', 'nopages me/flat'])
    expect((await status()).record?.repo).toBe('flat-view')
  })

  it('makes the recorded repository public again only when asked to', async () => {
    gh.repos.set('me/flat', fresh())
    await publishPlan(req())
    repo('me/flat').private = true
    gh.calls = []
    await publishPlan(req({ privateChoice: 'makePublic' }))
    expect(gh.calls).toEqual(['public me/flat', 'push me/flat', 'pages me/flat keep'])
  })
})

describe('the Pages rule follows the repository owner', () => {
  it('asks about a private organisation repository even when the user pays, and does not push', async () => {
    setOrigin('https://github.com/acme/plans.git')
    gh.repos.set('acme/plans', fresh({ private: true }))
    gh.userPlan = 'pro'
    expect((await status()).project).toMatchObject({ isPrivate: true, needsChoice: true })
    await expect(publishPlan(req())).rejects.toThrow(/приватный/)
    expect(gh.calls).toEqual([])

    gh.orgPlans.acme = 'team'
    expect((await status()).project?.needsChoice).toBe(false)
    await publishPlan(req())
    expect(gh.calls).toEqual(['push acme/plans', 'pages acme/plans new'])
  })

  it('takes a new branch back when GitHub refuses Pages, and saves no record', async () => {
    gh.repos.set('me/flat', fresh())
    gh.failEnable = true
    await expect(publishPlan(req())).rejects.toThrow(/422/)
    expect(gh.calls).toEqual(['push me/flat', 'pages me/flat new', 'delete me/flat'])
    expect(repo('me/flat').branchSha).toBeNull()
    expect((await status()).record).toBeNull()
  })
})

describe('the record follows its document', () => {
  it('finds a record kept under the file key once the file has an id, and reuses its repository', async () => {
    setOrigin(null)
    await publishPlan(req({ docId: 'file:abc', target: 'separate' }))
    expect(gh.calls[0]).toMatch(/^create me\/flat-[0-9a-f]{6}-view$/)
    const name = gh.calls[0].slice('create me/'.length)

    expect((await status('p_newid')).record).toBeNull()
    const st = await status('p_newid', ['file:abc'])
    expect(st.record?.repo).toBe(name)
    gh.calls = []
    await publishPlan(req({ docId: 'p_newid', aliases: ['file:abc'], target: 'separate' }))
    expect(gh.calls).toEqual([`push me/${name}`, `pages me/${name} keep`])
    expect((await status('file:abc')).record).toBeNull()
    // the marker now carries the new key's tag
    expect(markerDoc(repo(`me/${name}`).marker)).toBe(docTag('p_newid'))
  })

  it('without a local record (another computer, a lost pages.json) recognises its own site and updates it', async () => {
    gh.repos.set('me/flat', fresh())
    const first = await publishPlan(req())
    expect(markerDoc(repo('me/flat').marker)).toBe(docTag('doc1'))
    rmSync(join(userData, 'pages.json'), { force: true })

    const st = await status()
    expect(st.record).toMatchObject({ owner: 'me', repo: 'flat', separate: false, pubId: first.record.pubId, url: 'https://me.github.io/flat/' })
    expect(st.outdated).toBe(true)
    expect(st.project).toBeNull()
    gh.calls = []
    const res = await publishPlan(req())
    expect(res.record).toMatchObject({ owner: 'me', repo: 'flat', pubId: first.record.pubId })
    expect(gh.calls).toEqual(['push me/flat', 'pages me/flat keep'])

    // and when the record is lost again it can be unpublished from here
    rmSync(join(userData, 'pages.json'), { force: true })
    await status()
    await unpublishPlan('doc1')
    expect(repo('me/flat').branchSha).toBeNull()
    expect(repo('me/flat').pages).toBeNull()
  })

  it('the same for a separate repository: found by its marker, no second -view', async () => {
    setOrigin(null)
    await publishPlan(req({ target: 'separate' }))
    const name = gh.calls[0].slice('create me/'.length)
    rmSync(join(userData, 'pages.json'), { force: true })
    rmSync(join(userData, 'pages-repos.json'), { force: true })
    gh.calls = []
    expect((await status()).record).toMatchObject({ repo: name, separate: true })
    rmSync(join(userData, 'pages.json'), { force: true })
    await publishPlan(req({ target: 'separate' }))
    expect(gh.calls.filter((c) => c.startsWith('create'))).toEqual([])
    expect(gh.calls.filter((c) => c.startsWith('push'))).toEqual([`push me/${name}`])
  })

  it('unpublishing a separate repository (gh-pages is its default branch): Pages off, the site emptied, the record gone for good', async () => {
    setOrigin(null)
    const first = await publishPlan(req({ target: 'separate' }))
    const ref = `me/${first.record.repo}`
    gh.calls = []
    await unpublishPlan('doc1')
    // the default branch cannot be deleted: one commit with only the marker replaces the site
    expect(gh.calls).toEqual([`push ${ref}`, `nopages ${ref}`])
    expect(repo(ref).pages).toBeNull()
    expect(markerId(repo(ref).marker)).toBe(first.record.pubId)
    expect(readFileSync(join(userData, 'pages.json'), 'utf8')).not.toContain('doc1')
    // not taken back as a live publication of this document, and publishing again reuses the repository
    expect((await status()).record).toBeNull()
    const again = await publishPlan(req({ target: 'separate' }))
    expect(again.record.repo).toBe(first.record.repo)
    expect(gh.calls.filter((c) => c.startsWith('create'))).toEqual([])
  })

  it('never publishes into, nor takes down, the gh-pages branch the open project syncs with', async () => {
    setOrigin(null)
    const first = await publishPlan(req({ target: 'separate' }))
    const ref = `me/${first.record.repo}`
    gh.syncUrls = [`https://github.com/${ref}.git`]
    gh.syncBranch = 'gh-pages'
    gh.calls = []
    await expect(publishPlan(req({ target: 'separate', info: { ...req().info, contentHash: 'h2' } }))).rejects.toThrow(/синхронизируется/)
    await expect(unpublishPlan('doc1')).rejects.toThrow(/синхронизируется/)
    expect(gh.calls.filter((c) => c.startsWith('push') || c.startsWith('delete'))).toEqual([])
    // another branch of the same repository, or another repository: no objection
    gh.syncBranch = 'main'
    await unpublishPlan('doc1')
  })

  it('a request made for another project folder (opened meanwhile) is refused before anything happens', async () => {
    setOrigin('https://github.com/me/flat.git')
    gh.repos.set('me/flat', fresh())
    gh.calls = []
    const other = join(base, 'another-project')
    await expect(pagesStatus({ docId: 'doc1', contentHash: 'h1', name: 'Flat', root: other })).rejects.toThrow(/другой проект/)
    await expect(publishPlan(req({ root: other }))).rejects.toThrow(/другой проект/)
    await expect(publishPlan(req({ root: null }))).rejects.toThrow(/другой проект/)
    expect(gh.calls).toEqual([])
    expect((await status()).record).toBeNull()
    // the same folder, however it is spelled, is this project
    const res = await publishPlan(req({ root: `${project}${process.platform === 'win32' ? '\\' : '/'}` }))
    expect(res.record).toMatchObject({ owner: 'me', repo: 'flat' })
  })

  it("a clone of someone else's project: their site of the same document is not taken as the user's", async () => {
    setOrigin('https://github.com/alice/flat.git')
    const pages = { buildType: 'legacy', branch: 'gh-pages', path: '/', url: 'https://alice.github.io/flat/' }
    gh.repos.set('alice/flat', fresh({ push: false, branchSha: 'a'.repeat(40), marker: pagesMarker('alicePub', docTag('doc1')), pages }))
    const st = await status()
    expect(st.record).toBeNull()
    expect(st.project?.occupied).toBe('plan')
    expect(st.separateName).toBe('flat-view')
    const res = await publishPlan(req({ target: 'separate' }))
    expect(res.record).toMatchObject({ owner: 'me', repo: 'flat-view' })
    expect(gh.calls.some((c) => c.includes('alice/'))).toBe(false)
  })

  it('unpublish where the user lost write access: nothing is touched there, the record goes, the plan can be published again', async () => {
    setOrigin('https://github.com/acme/plans.git')
    gh.repos.set('acme/plans', fresh())
    await publishPlan(req())
    repo('acme/plans').push = false
    gh.calls = []
    await expect(unpublishPlan('doc1')).rejects.toThrow(/Нет прав/)
    expect(gh.calls).toEqual([])
    expect((await status()).record).toBeNull()
  })

  it('a collaborator (may push, not administer): updates the site of the project repository, and is told plainly that only an admin or maintainer takes it down', async () => {
    setOrigin('https://github.com/acme/plans.git')
    gh.repos.set('acme/plans', fresh())
    await publishPlan(req())
    // the same project on a teammate's computer: no record there, write access only
    rmSync(join(userData, 'pages.json'), { force: true })
    repo('acme/plans').admin = false
    const st = await status()
    expect(st.record).toMatchObject({ owner: 'acme', repo: 'plans' })
    expect(st.project?.occupied).toBeUndefined()
    gh.calls = []
    const res = await publishPlan(req())
    expect(res.record).toMatchObject({ owner: 'acme', repo: 'plans', separate: false })
    expect(gh.calls).toEqual(['push acme/plans', 'pages acme/plans keep'])

    // unpublishing: GitHub refuses to turn Pages off before anything else is touched, the record and the site stay
    const sha = repo('acme/plans').branchSha
    gh.calls = []
    await expect(unpublishPlan('doc1')).rejects.toThrow(/только его администратор/)
    expect(gh.calls).toEqual(['nopages acme/plans'])
    expect(repo('acme/plans').branchSha).toBe(sha)
    expect(repo('acme/plans').pages).not.toBeNull()
    expect((await status()).record).toMatchObject({ owner: 'acme', repo: 'plans' })

    // a custom role that may manage Pages looks like write access: GitHub lets it, and it comes down
    repo('acme/plans').customPages = true
    gh.calls = []
    await unpublishPlan('doc1')
    expect(gh.calls[0]).toBe('nopages acme/plans')
    expect(repo('acme/plans').pages).toBeNull()
    expect(repo('acme/plans').branchSha).toBeNull()
    expect((await status()).record).toBeNull()

    // published again by the collaborator, then taken down with admin access
    repo('acme/plans').customPages = false
    repo('acme/plans').admin = true
    await publishPlan(req())

    // with maintain or admin access given, it comes down
    repo('acme/plans').admin = true
    await unpublishPlan('doc1')
    expect(repo('acme/plans').pages).toBeNull()
    expect((await status()).record).toBeNull()
  })

  it('another plan published into the project repository is called that, not "not made by doplan"', async () => {
    gh.repos.set('me/flat', fresh())
    await publishPlan(req({ docId: 'other' }))
    const st = await status('doc1')
    expect(st.record).toBeNull()
    expect(st.project?.occupied).toBe('plan')
    await expect(publishPlan(req())).rejects.toThrow(/уже опубликован план doplan/)
  })

  it('an id-less file renamed or moved on disk keeps its publication; a copy whose original is still there does not take it', async () => {
    setOrigin(null)
    const created = 'created:abc123'
    const original = join(base, 'plans', 'flat.doplan')
    mkdirSync(join(base, 'plans'), { recursive: true })
    writeFileSync(original, 'x')
    const first = await publishPlan(req({ docId: 'file:old', target: 'separate', file: { path: original, created } }))

    // a copy next to it: the original is still there
    const copy = await pagesStatus({ docId: 'file:copy', contentHash: 'h1', name: 'Flat', file: { path: join(base, 'plans', 'flat (2).doplan'), created } })
    expect(copy.record).toBeNull()
    expect((await status('file:old')).record?.repo).toBe(first.record.repo)

    // the original renamed: its record follows the file
    rmSync(original)
    const moved = await pagesStatus({ docId: 'file:new', contentHash: 'h1', name: 'Flat', file: { path: join(base, 'plans', 'our flat.doplan'), created } })
    expect(moved.record?.repo).toBe(first.record.repo)
    gh.calls = []
    await publishPlan(req({ docId: 'file:new', target: 'separate', file: { path: join(base, 'plans', 'our flat.doplan'), created } }))
    expect(gh.calls).toEqual([`push me/${first.record.repo}`, `pages me/${first.record.repo} keep`])
  })
})

describe('doplan reuses the separate repository it made', () => {
  it('a failed push leaves the new repository written down, and the retry goes into it', async () => {
    setOrigin(null)
    gh.failPush = 1
    await expect(publishPlan(req({ target: 'separate' }))).rejects.toThrow(/resolve host/)
    const name = gh.calls[0].slice('create me/'.length)
    expect((await status()).separateName).toBe(name)
    gh.calls = []
    const res = await publishPlan(req({ target: 'separate' }))
    expect(res.record.repo).toBe(name)
    expect(gh.calls).toEqual([`push me/${name}`, `pages me/${name} new`])
    expect([...gh.repos.keys()]).toEqual([`me/${name}`])
  })

  it('GitHub refusing Pages: the branch is taken back and the retry reuses the repository', async () => {
    setOrigin(null)
    gh.failEnable = true
    await expect(publishPlan(req({ target: 'separate' }))).rejects.toThrow(/422/)
    gh.failEnable = false
    gh.calls = []
    await publishPlan(req({ target: 'separate' }))
    expect(gh.calls.filter((c) => c.startsWith('create'))).toEqual([])
    expect(gh.repos.size).toBe(1)
  })

  // 21 cycles: one more than the 20 names a fresh -view-N per cycle would run out of
  it('unpublish and publish again, many times: always the same repository and link', { timeout: 60_000 }, async () => {
    setOrigin(null)
    const first = await publishPlan(req({ target: 'separate' }))
    for (let i = 0; i < 21; i++) {
      await unpublishPlan('doc1')
      expect((await status()).separateName).toBe(first.record.repo)
      const res = await publishPlan(req({ target: 'separate' }))
      expect(res.record.url).toBe(first.record.url)
    }
    expect(gh.repos.size).toBe(1)
    expect(gh.calls.filter((c) => c.startsWith('create'))).toHaveLength(1)
  })

  it('an empty -view repository doplan made for another plan is not taken', async () => {
    gh.repos.set('me/flat', fresh({ branchSha: 'f'.repeat(40) }))
    const first = await publishPlan(req({ target: 'separate' }))
    expect(first.record.repo).toBe('flat-view')
    await unpublishPlan('doc1')
    // another plan of the same project: flat-view is empty now, but it is doc1's
    expect((await status('doc2')).separateName).toBe('flat-view-2')
    const other = await publishPlan(req({ docId: 'doc2', target: 'separate' }))
    expect(other.record.repo).toBe('flat-view-2')
    // doc1 goes back into its own
    expect((await publishPlan(req({ target: 'separate' }))).record.repo).toBe('flat-view')
  })
})
