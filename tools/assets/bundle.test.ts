import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CATALOG_PATH, PACK_JSON, bundledPaths, gltfDependencies, safeEntryName, zipLevel, type PackInfo } from './bundle'
import { checkBundledAssets } from './check'

describe('bundledPaths', () => {
  it('collects bundled paths of non-remote entries only, skipping download urls', () => {
    const paths = bundledPaths({
      materials: [
        { id: 'm1', maps: { color: 'materials/a/color.jpg', normal: 'materials/a/normal.jpg' }, thumb: 'thumbs/m1.webp' },
        { id: 'm2', remote: true, maps: { color: 'materials/b/color.jpg' } },
      ],
      assets: [
        { id: 'a1', src: 'models/sofa/sofa.gltf', download: { files: [{ url: 'https://x', path: 'models/sofa/x.bin' }] } },
        { id: 'a2', src: 'models/sofa/sofa.gltf' },
      ],
      hdris: [{ id: 'h1', src: 'hdris/room.hdr' }],
    })
    expect(paths).toEqual([
      { path: 'hdris/room.hdr', ids: ['h1'] },
      { path: 'materials/a/color.jpg', ids: ['m1'] },
      { path: 'materials/a/normal.jpg', ids: ['m1'] },
      { path: 'models/sofa/sofa.gltf', ids: ['a1', 'a2'] },
    ])
  })

  it('finds every bundled path of the real catalog under models|materials|hdris', () => {
    const paths = bundledPaths(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')))
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p.path).toMatch(/^(models|materials|hdris)\//)
  })
})

describe('gltfDependencies', () => {
  it('resolves buffers and images next to the .gltf and skips data/remote uris', () => {
    const deps = gltfDependencies('models/sofa_01/Sofa_01_1k.gltf', {
      buffers: [{ uri: 'Sofa_01.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }],
      images: [{ uri: 'textures/Sofa%2001_diff_1k.jpg' }, { uri: 'https://example.com/x.png' }, {}],
    })
    expect(deps).toEqual(['models/sofa_01/Sofa_01.bin', 'models/sofa_01/textures/Sofa 01_diff_1k.jpg'])
  })
})

describe('safeEntryName', () => {
  it('accepts files inside the pack folders', () => {
    expect(safeEntryName('models/sofa/sofa.gltf')).toBe('models/sofa/sofa.gltf')
    expect(safeEntryName('hdris/room.hdr')).toBe('hdris/room.hdr')
  })
  it('refuses traversal, absolute paths, other folders and directory entries', () => {
    for (const bad of [
      '../evil.exe',
      'models/../../evil',
      'models/./a.jpg',
      '/etc/passwd',
      'C:/Windows/x.dll',
      'models\\a.jpg',
      'catalog.json',
      'thumbs/a.webp',
      'models',
      'models/',
      'models//a.jpg',
    ])
      expect(safeEntryName(bad), bad).toBeNull()
  })
})

describe('zipLevel', () => {
  it('stores already-compressed images and deflates the rest', () => {
    expect(zipLevel('materials/a/color.JPG')).toBe(0)
    expect(zipLevel('models/a/a.bin')).toBe(6)
    expect(zipLevel('hdris/a.hdr')).toBe(6)
  })
})

describe('pack.json', () => {
  it('names a pack number and, once packed, a sha256', () => {
    const info = JSON.parse(readFileSync(PACK_JSON, 'utf8')) as PackInfo
    expect(Number.isInteger(info.pack) && info.pack >= 1).toBe(true)
    expect(info.sha256).toMatch(/^([0-9a-f]{64})?$/)
  })
})

describe('checkBundledAssets', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const put = (rel: string, data: string) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, data)
  }

  it('reports missing, empty and glTF-referenced files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'doplan-assets-check-'))
    put('models/a/a.gltf', JSON.stringify({ buffers: [{ uri: 'a.bin' }], images: [{ uri: 'tex/a.jpg' }] }))
    put('models/a/a.bin', 'x')
    put('materials/m/color.jpg', '')
    put('hdris/h.hdr', 'x')
    const res = checkBundledAssets(
      {
        assets: [{ id: 'a', src: 'models/a/a.gltf' }],
        materials: [{ id: 'm', maps: { color: 'materials/m/color.jpg', normal: 'materials/m/normal.jpg' } }],
        hdris: [{ id: 'h', src: 'hdris/h.hdr' }],
      },
      dir,
    )
    expect(res.checked).toBe(6)
    expect(res.missing.map((m) => m.path)).toEqual(['materials/m/color.jpg', 'materials/m/normal.jpg', 'models/a/tex/a.jpg'])
    expect(res.stray).toEqual([])
  })

  it('reports files that no bundled entry uses (an on-demand model left on disk)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'doplan-assets-check-'))
    put('models/a/a.glb', 'x')
    put('models/a/a.glb.fix.json', '{}')
    put('models/b/b.gltf', JSON.stringify({ buffers: [{ uri: 'b.bin' }] }))
    put('models/b/b.bin', 'x')
    put('hdris/h.hdr', 'x')
    const res = checkBundledAssets(
      { assets: [{ id: 'a', src: 'models/a/a.glb' }, { id: 'b', src: 'models/b/b.gltf', remote: true }], hdris: [] },
      dir,
    )
    expect(res.missing).toEqual([])
    expect(res.stray).toEqual(['hdris/h.hdr', 'models/b/b.bin', 'models/b/b.gltf'])
  })
})
