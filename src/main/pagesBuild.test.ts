import { execFileSync } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planSite } from '@shared/pagesSite'
import { buildSite } from './pagesBuild'
import { deleteRemoteBranch, pushSite } from './pagesGit'

let tmp: string

beforeAll(async () => {
  tmp = await fsp.mkdtemp(join(tmpdir(), 'doplan-pages-'))
})

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function write(path: string, data: string | Buffer) {
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, data)
}

/** a viewer build, asset roots and a plan using a .glb, a .gltf with a buffer and a texture, and a missing file */
async function fixture(dir: string) {
  const viewerDir = join(dir, 'viewer')
  await write(join(viewerDir, 'viewer.html'), '<!doctype html><title>v</title>')
  await write(join(viewerDir, 'favicon.ico'), 'ico')
  await write(join(viewerDir, 'viewer', 'index-abc.js'), 'console.log(1)')
  const roots = { catalog: join(dir, 'catalog'), library: join(dir, 'library'), project: join(dir, 'project') }
  await write(join(roots.catalog, 'models', 'chair.glb'), Buffer.alloc(64))
  await write(join(roots.library, 'lamp', 'lamp.gltf'), JSON.stringify({ buffers: [{ uri: 'lamp.bin' }], images: [{ uri: '../tex/glow.png' }] }))
  await write(join(roots.library, 'lamp', 'lamp.bin'), Buffer.alloc(32))
  await write(join(roots.library, 'tex', 'glow.png'), Buffer.alloc(16))
  await write(join(roots.project, 'u.png'), Buffer.alloc(8))
  const catalog = {
    materials: [],
    assets: [
      { id: 'chair', src: 'doplan-asset://catalog/models/chair.glb' },
      { id: 'lamp', src: 'doplan-asset://library/lamp/lamp.gltf' },
      { id: 'ghost', src: 'doplan-asset://catalog/models/ghost.glb' },
    ],
    hdris: [],
  }
  const doc = { meta: { name: 'P' }, items: ['chair', 'lamp', 'ghost'], underlay: 'doplan-asset://project/u.png' }
  return { viewerDir, roots, content: planSite(doc, catalog) }
}

const info = { title: 'P', publishedAt: '2026-01-01T00:00:00.000Z', contentHash: 'h', app: 'doplan test' }

describe('buildSite', () => {
  it('writes the viewer as index.html, the data, the assets with glTF dependencies and .nojekyll', async () => {
    const dir = join(tmp, 'build')
    const { viewerDir, roots, content } = await fixture(dir)
    const out = join(dir, 'site')
    await write(join(out, 'stale.txt'), 'old')
    const r = await buildSite({ outDir: out, viewerDir, content, info, roots })

    expect(existsSync(join(out, 'stale.txt'))).toBe(false)
    expect(await fsp.readFile(join(out, 'index.html'), 'utf8')).toContain('<title>v</title>')
    expect(existsSync(join(out, 'viewer.html'))).toBe(false)
    expect(existsSync(join(out, 'viewer', 'index-abc.js'))).toBe(true)
    expect(existsSync(join(out, '.nojekyll'))).toBe(true)
    for (const f of ['assets/c/models/chair.glb', 'assets/l/lamp/lamp.gltf', 'assets/l/lamp/lamp.bin', 'assets/l/tex/glow.png', 'assets/p/u.png']) expect(existsSync(join(out, f)), f).toBe(true)
    expect(r.missing).toEqual(['assets/c/models/ghost.glb'])
    expect(r.tooLarge).toEqual([])

    const plan = JSON.parse(await fsp.readFile(join(out, 'plan.json'), 'utf8'))
    expect(plan.underlay).toBe('./assets/p/u.png')
    const cat = JSON.parse(await fsp.readFile(join(out, 'catalog.json'), 'utf8'))
    expect(cat.assets.map((a: { src: string }) => a.src)).toContain('./assets/l/lamp/lamp.gltf')
    expect(JSON.parse(await fsp.readFile(join(out, 'site.json'), 'utf8'))).toEqual(info)
    expect(r.files).toBe(3 + 3 + 5 + 1)
    expect(r.bytes).toBeGreaterThan(64 + 32 + 16 + 8)
  })

  it('never reads outside the asset roots', async () => {
    const dir = join(tmp, 'escape')
    const { viewerDir, roots } = await fixture(dir)
    await write(join(dir, 'secret.txt'), 'secret')
    const content = { doc: {}, catalog: { version: 1, materials: [], assets: [], hdris: [] }, notDownloaded: [], files: [{ host: 'catalog' as const, rel: '../secret.txt', path: 'assets/c/secret.txt' }, { host: 'nope' as never, rel: 'a', path: 'assets/x/a' }] }
    const out = join(dir, 'site')
    const r = await buildSite({ outDir: out, viewerDir, content, info, roots })
    expect(r.missing).toEqual(['assets/c/secret.txt', 'assets/x/a'])
    expect(existsSync(join(out, 'assets', 'c', 'secret.txt'))).toBe(false)
  })
})

function gitExe(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(cmd, ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null
  } catch {
    return null
  }
}

const git = gitExe()

describe.skipIf(!git)('pushSite', () => {
  it('force-pushes the site as the only commit of gh-pages and deletes the branch again', async () => {
    const dir = join(tmp, 'push')
    const bare = join(dir, 'remote.git')
    await fsp.mkdir(bare, { recursive: true })
    execFileSync(git as string, ['init', '-q', '--bare', bare])
    const hooksDir = join(dir, 'hooks')
    await fsp.mkdir(hooksDir, { recursive: true })
    const runner = { git: git as string, hooksDir, config: ['-c', 'protocol.file.allow=always'] }
    const site = join(dir, 'site')
    const remote = bare.replace(/\\/g, '/')

    await write(join(site, 'index.html'), 'v1')
    await write(join(site, '.nojekyll'), '')
    await pushSite(runner, site, remote, 'gh-pages', 'first')
    await write(join(site, 'index.html'), 'v2')
    await write(join(site, 'assets', 'c', 'a b.glb'), Buffer.alloc(4))
    const sha = await pushSite(runner, site, remote, 'gh-pages', 'second')

    const log = execFileSync(git as string, ['--git-dir', bare, 'log', '--format=%H %an <%ae> %s', 'gh-pages'], { encoding: 'utf8' }).trim().split('\n')
    expect(log).toHaveLength(1)
    expect(log[0]).toBe(`${sha} doplan <doplan@users.noreply.github.com> second`)
    const files = execFileSync(git as string, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'gh-pages'], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(files).toEqual(['.nojekyll', 'assets/c/a b.glb', 'index.html'])
    expect(execFileSync(git as string, ['--git-dir', bare, 'show', 'gh-pages:index.html'], { encoding: 'utf8' })).toBe('v2')
    // the site folder keeps no repository of its own
    expect(existsSync(join(site, '.git'))).toBe(false)

    expect(await deleteRemoteBranch(runner, join(dir, 'work'), remote, 'gh-pages')).toBe(true)
    expect(execFileSync(git as string, ['--git-dir', bare, 'branch', '--list'], { encoding: 'utf8' }).trim()).toBe('')
    expect(await deleteRemoteBranch(runner, join(dir, 'work'), remote, 'gh-pages')).toBe(false)
  }, 60_000)

  it('refuses a remote URL with credentials in it', async () => {
    const runner = { git: git as string, hooksDir: tmp }
    await expect(pushSite(runner, join(tmp, 'none'), 'https://user:token@github.com/a/b.git', 'gh-pages', 'x')).rejects.toThrow(/credentials/)
  })
})
