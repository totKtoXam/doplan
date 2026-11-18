import { describe, expect, it } from 'vitest'
import {
  docContentHash,
  gltfDependencies,
  joinRel,
  originUrlFromGitConfig,
  pagesUrlOf,
  parseGithubRemote,
  parseViewerParams,
  planSite,
  planSlug,
  siteFileOf,
  siteUrlOf,
  viewerQuery,
  viewRepoName,
} from './pagesSite'

describe('siteFileOf', () => {
  it('maps the three asset hosts into the site folder, decoded, without the query', () => {
    expect(siteFileOf('doplan-asset://catalog/models/a%20b.glb?v=2')).toEqual({ host: 'catalog', rel: 'models/a b.glb', path: 'assets/c/models/a b.glb' })
    expect(siteFileOf('doplan-asset://library/materials/m/color.jpg')?.path).toBe('assets/l/materials/m/color.jpg')
    expect(siteFileOf('doplan-asset://project/abc.png')?.path).toBe('assets/p/abc.png')
  })
  it('rejects other URLs and paths that climb out', () => {
    expect(siteFileOf('https://example.com/a.glb')).toBeNull()
    expect(siteFileOf('doplan-asset://other/a.glb')).toBeNull()
    expect(siteFileOf('doplan-asset://catalog/../secret')).toBeNull()
    expect(siteFileOf('doplan-asset://catalog/a/%2e%2e/b')).toBeNull()
    expect(siteFileOf('doplan-asset://catalog/C:%5Cx')).toBeNull()
  })
  it('writes site URLs with encoded segments', () => {
    expect(siteUrlOf('assets/c/models/a b.glb')).toBe('./assets/c/models/a%20b.glb')
  })
})

describe('planSite', () => {
  const catalog = {
    version: 3,
    materials: [
      { id: 'oak', name: 'Oak', thumb: 'doplan-asset://catalog/t/oak.jpg', maps: { color: 'doplan-asset://catalog/materials/oak/c.jpg' } },
      { id: 'steel', name: 'Steel', maps: { color: 'doplan-asset://library/steel/c.png' } },
      { id: 'unused', name: 'Unused', maps: { color: 'doplan-asset://catalog/materials/unused/c.jpg' } },
      { id: 'white', name: 'White' },
    ],
    assets: [{ id: 'chair', name: 'Chair', src: 'doplan-asset://catalog/models/chair.glb', slots: { legs: 'steel' } }],
    hdris: [{ id: 'sky', name: 'Sky', url: 'https://example.com/sky.hdr', remote: true }],
  }
  const doc = { meta: { name: 'P' }, items: [{ assetId: 'chair', material: 'oak' }], env: { hdri: 'sky' }, wall: { material: 'white' }, underlay: 'doplan-asset://project/u.png' }

  it('takes only used entries (with model slot materials), not builtins, and rewrites every URL', () => {
    const site = planSite(doc, catalog, new Set(['white']))
    expect(site.catalog.materials.map((m) => (m as { id: string }).id).sort()).toEqual(['oak', 'steel'])
    expect(site.catalog.assets).toHaveLength(1)
    expect(site.catalog.hdris).toHaveLength(1)
    expect((site.doc as typeof doc).underlay).toBe('./assets/p/u.png')
    const oak = site.catalog.materials.find((m) => (m as { id: string }).id === 'oak') as Record<string, unknown>
    expect(oak.thumb).toBeUndefined()
    expect((oak.maps as { color: string }).color).toBe('./assets/c/materials/oak/c.jpg')
    expect(site.files.map((f) => f.path).sort()).toEqual(['assets/c/materials/oak/c.jpg', 'assets/c/models/chair.glb', 'assets/l/steel/c.png', 'assets/p/u.png'])
    expect(site.notDownloaded).toEqual(['sky'])
  })
  it('does not change the document it was given', () => {
    const copy = JSON.parse(JSON.stringify(doc))
    planSite(doc, catalog)
    expect(doc).toEqual(copy)
  })
})

describe('glTF dependencies', () => {
  it('lists relative buffers and images, not data: URIs', () => {
    const json = { buffers: [{ uri: 'scene.bin' }, { uri: 'data:application/octet-stream;base64,AA==' }], images: [{ uri: 'tex/a%20b.png' }, { uri: 'scene.bin' }] }
    expect(gltfDependencies(json)).toEqual(['scene.bin', 'tex/a b.png'])
    expect(gltfDependencies(null)).toEqual([])
  })
  it('joins relative paths and refuses to climb out of the root', () => {
    expect(joinRel('models/x/x.gltf', 'x.bin')).toBe('models/x/x.bin')
    expect(joinRel('models/x/x.gltf', '../tex/b.png')).toBe('models/tex/b.png')
    expect(joinRel('x.gltf', '../b.png')).toBeNull()
  })
})

describe('identity', () => {
  it('docContentHash ignores the modification stamp and key order', () => {
    const a = { meta: { name: 'A', modifiedAt: '1' }, walls: [1, 2] }
    const b = { walls: [1, 2], meta: { modifiedAt: '2', name: 'A' } }
    expect(docContentHash(a)).toBe(docContentHash(b))
    expect(docContentHash(a)).not.toBe(docContentHash({ ...a, walls: [1, 3] }))
  })
  it('planSlug is latin, short and keyed by id', () => {
    const s = planSlug('Наша квартира v2', 'id-1')
    expect(s).toMatch(/^nasha-kvartira-v2-[0-9a-f]{6}$/)
    expect(planSlug('Наша квартира v2', 'id-2')).not.toBe(s)
    expect(planSlug('', 'x')).toMatch(/^plan-/)
  })
})

describe('viewer URL parameters', () => {
  it('round-trips and falls back to the defaults', () => {
    expect(parseViewerParams('')).toEqual({ view: '3d', cam: 'orbit' })
    expect(parseViewerParams('?view=2d&level=L1')).toEqual({ view: '2d', cam: 'orbit', level: 'L1' })
    expect(parseViewerParams('?view=x&cam=fly')).toEqual({ view: '3d', cam: 'orbit' })
    expect(viewerQuery({ view: '3d', cam: 'orbit' })).toBe('')
    expect(viewerQuery({ view: '3d', cam: 'walk' })).toBe('?cam=walk')
    expect(viewerQuery({ view: '2d', cam: 'walk' })).toBe('?view=2d')
    const p = { view: '3d' as const, cam: 'top' as const, level: 'a b' }
    expect(parseViewerParams(viewerQuery(p))).toEqual(p)
  })
})

describe('GitHub repositories', () => {
  it('parses github.com remotes', () => {
    expect(parseGithubRemote('https://github.com/me/flat.git')).toEqual({ owner: 'me', repo: 'flat' })
    expect(parseGithubRemote('https://user@github.com/me/flat')).toEqual({ owner: 'me', repo: 'flat' })
    expect(parseGithubRemote('git@github.com:me/flat.git')).toEqual({ owner: 'me', repo: 'flat' })
    expect(parseGithubRemote('ssh://git@github.com/me/my.plan.git')).toEqual({ owner: 'me', repo: 'my.plan' })
    expect(parseGithubRemote('https://gitlab.com/me/flat.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/me/../x')).toBeNull()
  })
  it('reads the origin URL from a git config', () => {
    const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/a/b.git\n[remote "origin"]\n\turl = git@github.com:me/flat.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    expect(originUrlFromGitConfig(cfg)).toBe('git@github.com:me/flat.git')
    expect(originUrlFromGitConfig('[core]\n')).toBeNull()
  })
  it('builds Pages addresses and separate repository names', () => {
    expect(pagesUrlOf({ owner: 'Me', repo: 'flat' })).toBe('https://me.github.io/flat/')
    expect(pagesUrlOf({ owner: 'me', repo: 'me.github.io' })).toBe('https://me.github.io/')
    expect(viewRepoName('flat')).toBe('flat-view')
    expect(viewRepoName('  ')).toBe('plan-view')
  })
})
