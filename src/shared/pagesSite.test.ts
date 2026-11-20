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
  canPublishInto,
  markerId,
  migrateRecordKey,
  markerDoc,
  docTag,
  pagesMarker,
  pagesNeedsChoice,
  pagesOwnership,
  publicationKeys,
  viewDoc,
  viewRepoCandidate,
  visibleUnderlayCount,
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

  it('a library material or model keeps only what the viewer renders with: no product card, tags or estimate specs', () => {
    const product = { vendor: 'ShopX', sku: 'A-1', url: 'https://shop.example/a1', price: 12345, priceUnit: 'м²', note: 'discount via Ivan' }
    const lib = {
      materials: [
        {
          id: 'm_lib', name: 'Tile', category: 'tile', color: '#eee', roughness: 0.4, metalness: 0, maps: { color: 'doplan-asset://library/materials/m_lib/color.png' },
          sizeMm: [600, 600], product, wallpaper: { rollWidthMm: 530 }, paint: { coats: 2 }, colorCode: { system: 'RAL', code: '9010' }, tags: ['bath'], custom: true, thumb: 'x', licence: 'CC0',
        },
      ],
      assets: [{ id: 'a_lib', name: 'Sofa', kind: 'model', src: 'doplan-asset://library/models/a_lib/m.glb', size: { w: 1, d: 1, h: 1 }, mount: 'floor', product, tags: ['x'], custom: true, author: 'Me' }],
      hdris: [],
    }
    const site = planSite(viewDoc({ meta: { name: 'P' }, walls: { w1: { finishA: { materialId: 'm_lib' } } }, items: { i: { assetId: 'a_lib' } } }, { underlays: false }), lib)
    const m = site.catalog.materials[0] as Record<string, unknown>
    expect(Object.keys(m).sort()).toEqual(['category', 'color', 'custom', 'id', 'licence', 'maps', 'metalness', 'name', 'roughness', 'sizeMm'])
    expect((m.maps as { color: string }).color).toBe('./assets/l/materials/m_lib/color.png')
    const a = site.catalog.assets[0] as Record<string, unknown>
    expect(Object.keys(a).sort()).toEqual(['author', 'custom', 'id', 'kind', 'mount', 'name', 'size', 'src'])
    expect(JSON.stringify(site.catalog)).not.toMatch(/ShopX|12345|shop\.example|Ivan|A-1|bath|RAL/)
  })

  it('keeps the render flags: custom (tinted user textures, whole user models) and remote (placeholder, no requests)', () => {
    const cat = {
      materials: [{ id: 'm2', name: 'M', maps: { color: 'doplan-asset://library/m2/c.jpg' }, remote: true }],
      assets: [{ id: 'a2', name: 'A', src: 'doplan-asset://library/a2/m.glb', remote: true, custom: true, slots: { s: 'm2' } }],
      hdris: [{ id: 'h2', name: 'H', src: 'doplan-asset://library/h2.hdr', remote: true }],
    }
    const site = planSite({ items: { i: { assetId: 'a2' } }, env: { hdri: 'h2' } }, cat)
    expect(site.catalog.assets[0]).toMatchObject({ remote: true, custom: true })
    expect(site.catalog.materials[0]).toMatchObject({ remote: true })
    expect(site.catalog.hdris[0]).toMatchObject({ remote: true })
    expect(site.notDownloaded.sort()).toEqual(['a2', 'h2', 'm2'])
    // nothing to copy (the files are not on this computer): reported once, as not downloaded, never as missing
    expect(site.files).toEqual([])
    expect((site.catalog.assets[0] as { src: string }).src).toMatch(/^\.\/assets\//)
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

describe('what of the document goes public (viewDoc)', () => {
  const doc = {
    version: 3,
    meta: { name: 'Flat', id: 'p_secretid', createdAt: '2020-01-01', modifiedAt: '2020-02-02', app: 'doplan' },
    walls: { w: { id: 'w', dims: { left: { source: 'tape', note: 'measured by Ivan', value: 3000 } } } },
    underlays: {
      shown: { id: 'shown', src: 'doplan-asset://project/plan.png', visible: true },
      hidden: { id: 'hidden', src: 'doplan-asset://project/bti.png', visible: false },
      inline: { id: 'inline', src: 'data:image/png;base64,AAAA', visible: false },
    },
    annotations: { a: { id: 'a', points: [] } },
    source: { kind: 'bti', labelledTotalArea: 54 },
    design: { styleId: 'loft', currency: 'KZT', priceList: { oak: { price: 100 } } },
    materials: { m: { id: 'm', color: '#fff', product: { vendor: 'shop', price: 5 } } },
    assets: { x: { id: 'x', src: 'doplan-asset://project/x.glb', product: { price: 9 } } },
    electrical: { e: { id: 'e', kind: 'socket', comment: 'fridge, circuit 3' } },
    variants: { activeId: 'v1', order: ['v1', 'v2'], records: { v2: { stash: { collections: { items: { i: { assetId: 'secret-sofa' } } } } } } },
    items: { i: { id: 'i', assetId: 'sofa' } },
  }

  it('drops hidden underlays, annotations, traced-plan data, prices, notes, ids and inactive variants', () => {
    const v = viewDoc(doc, { underlays: false }) as typeof doc & Record<string, unknown>
    expect(v.meta).toEqual({ name: 'Flat', app: 'doplan' })
    expect(v.underlays).toEqual({})
    for (const k of ['annotations', 'source', 'variants']) expect(v[k]).toBeUndefined()
    expect(v.design).toEqual({ styleId: 'loft' })
    expect(v.materials.m.product).toBeUndefined()
    expect(v.materials.m.color).toBe('#fff')
    expect(v.assets.x.product).toBeUndefined()
    expect(v.electrical.e).toEqual({ id: 'e', kind: 'socket' })
    expect(v.walls.w.dims.left).toEqual({ source: 'tape', value: 3000 })
    expect(v.items).toEqual(doc.items)
    // the document itself is untouched
    expect(doc.underlays.hidden.src).toBe('doplan-asset://project/bti.png')
    expect(doc.walls.w.dims.left.note).toBe('measured by Ivan')

    const files = planSite(v, { materials: [], assets: [], hdris: [] }).files.map((f) => f.path)
    expect(files).toEqual(['assets/p/x.glb'])
    expect(JSON.stringify(v)).not.toMatch(/bti\.png|secret|Ivan|fridge|KZT/)
  })

  it('publishes only the visible underlays, and only when asked', () => {
    expect(visibleUnderlayCount(doc)).toBe(1)
    const v = viewDoc(doc, { underlays: true }) as { underlays: Record<string, unknown> }
    expect(Object.keys(v.underlays)).toEqual(['shown'])
    const files = planSite(v, { materials: [], assets: [], hdris: [] }).files.map((f) => f.path)
    expect(files).toContain('assets/p/plan.png')
    expect(files).not.toContain('assets/p/bti.png')
  })
})

describe('whose a gh-pages branch and a Pages site are', () => {
  const sha = 'a'.repeat(40)
  const site = { buildType: 'legacy', branch: 'gh-pages', path: '/' }

  it('reads only doplan markers', () => {
    expect(markerId(pagesMarker('pub1'))).toBe('pub1')
    for (const t of [null, '', 'docs', '{"id":"pub1"}', '{"doplan":"other","id":"pub1"}', '{"doplan":"pages","id":""}']) expect(markerId(t)).toBeNull()
  })

  it('a marker carries the tag of its document, not the id itself', () => {
    const m = pagesMarker('pub1', docTag('p_abc'))
    expect(markerId(m)).toBe('pub1')
    expect(markerDoc(m)).toBe(docTag('p_abc'))
    expect(m).not.toContain('p_abc')
    expect(docTag('p_abc')).not.toBe(docTag('p_abd'))
    expect(markerDoc(pagesMarker('pub1'))).toBeNull()
    expect(markerDoc('{"doplan":"other","id":"x","doc":"t"}')).toBeNull()
  })

  it('is ours only with our marker; any other branch or site is foreign', () => {
    expect(pagesOwnership({ branchSha: null, marker: null, pages: null }, 'pub1', false)).toEqual({ branch: 'none', site: 'none' })
    expect(pagesOwnership({ branchSha: sha, marker: pagesMarker('pub1'), pages: site }, 'pub1', false)).toEqual({ branch: 'ours', site: 'ours' })
    // the user's own docs branch, another plan's branch, an unknown publication id
    expect(pagesOwnership({ branchSha: sha, marker: null, pages: null }, 'pub1', false).branch).toBe('foreign')
    expect(pagesOwnership({ branchSha: sha, marker: pagesMarker('pub2'), pages: null }, 'pub1', false).branch).toBe('foreign')
    expect(pagesOwnership({ branchSha: sha, marker: pagesMarker('pub1'), pages: null }, undefined, false).branch).toBe('foreign')
    // a site from main:/docs or from Actions
    expect(pagesOwnership({ branchSha: null, marker: null, pages: { buildType: 'legacy', branch: 'main', path: '/docs' } }, 'pub1', false).site).toBe('foreign')
    expect(pagesOwnership({ branchSha: sha, marker: pagesMarker('pub1'), pages: { buildType: 'workflow' } }, 'pub1', false).site).toBe('foreign')
    // a gh-pages site whose branch is someone else's
    expect(pagesOwnership({ branchSha: sha, marker: null, pages: site }, 'pub1', true).site).toBe('foreign')
    // our recorded site whose branch was deleted meanwhile
    expect(pagesOwnership({ branchSha: null, marker: null, pages: site }, 'pub1', true).site).toBe('ours')
    expect(pagesOwnership({ branchSha: null, marker: null, pages: site }, 'pub1', false).site).toBe('foreign')
    expect(canPublishInto({ branch: 'ours', site: 'none' })).toBe(true)
    expect(canPublishInto({ branch: 'none', site: 'foreign' })).toBe(false)
  })

  it('asks about a private repository unless its owner pays; an unknown plan counts as free', () => {
    expect(pagesNeedsChoice(false, undefined)).toBe(false)
    expect(pagesNeedsChoice(true, undefined)).toBe(true)
    expect(pagesNeedsChoice(true, 'Free')).toBe(true)
    expect(pagesNeedsChoice(true, 'team')).toBe(false)
  })

  it('numbers the separate repository when the name is taken', () => {
    expect(viewRepoCandidate('flat', 1)).toBe('flat-view')
    expect(viewRepoCandidate('flat', 3)).toBe('flat-view-3')
  })
})

describe('publication keys', () => {
  const T = '2020-01-01T00:00:00.000Z'

  it('keys a file without an id by its file: a renamed plan keeps the key, a copy on disk gets its own', () => {
    const a = publicationKeys({ name: 'Foo', createdAt: T }, 'C:\\plans\\flat.doplan')
    expect(a.key).toMatch(/^file:/)
    expect(publicationKeys({ name: 'Bar', createdAt: T }, 'c:/plans/flat.doplan').key).toBe(a.key)
    expect(publicationKeys({ name: 'Foo', createdAt: T }, 'C:\\plans\\flat-v2.doplan').key).not.toBe(a.key)
  })

  it('a Save As copy (new id at a new path) does not take over the original publication', () => {
    const original = publicationKeys({ name: 'Flat', createdAt: T }, '/p/flat.doplan')
    const copy = publicationKeys({ id: 'p_copy', name: 'Flat', createdAt: T }, '/p/flat copy.doplan')
    const records: Record<string, { repo: string }> = { [original.key]: { repo: 'flat-view' } }
    expect(copy.aliases).not.toContain(original.key)
    expect(migrateRecordKey(records, copy.key, copy.aliases)).toBe(false)
    expect(records).toEqual({ [original.key]: { repo: 'flat-view' } })
  })

  it('moves the record to the id the first save gives the file at the same path', () => {
    const before = publicationKeys({ name: 'Foo', createdAt: T }, '/p/foo.doplan')
    const after = publicationKeys({ id: 'p_new', name: 'Foo', createdAt: T }, '/p/foo.doplan')
    expect(after.key).toBe('p_new')
    expect(after.aliases).toContain(before.key)
    const records: Record<string, { repo: string }> = { [before.key]: { repo: 'foo-view' } }
    expect(migrateRecordKey(records, after.key, after.aliases)).toBe(true)
    expect(records).toEqual({ p_new: { repo: 'foo-view' } })
    // nothing to move, or the new key already has its own record
    expect(migrateRecordKey(records, after.key, after.aliases)).toBe(false)
    expect(migrateRecordKey({ a: 1, b: 2 }, 'a', ['b'])).toBe(false)
  })
})
