import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanFeedUrl, DEFAULT_FEEDS, sanitizeFeeds } from '../shared/feeds'
import { clearFeedIndexCache, expectedFiles, feedFileLocation, fromFeed, parseFeedIndex, sha256, takeExpected } from './feeds'

const spec = {
  files: [
    { url: 'https://dl.polyhaven.org/a/sofa_1k.gltf', path: 'models/sofa/sofa_1k.gltf' },
    { url: 'https://dl.polyhaven.org/a/sofa.bin', path: 'models/sofa/sofa.bin' },
  ],
}

function feedWith(files: Record<string, string>, opts: { badSha?: boolean } = {}) {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
  const index = {
    format: 'doplan-feed',
    version: 1,
    entries: { asset_ph_sofa: { file: 'asset_ph_sofa.zip', sha256: opts.badSha ? '0'.repeat(64) : sha256(zip), bytes: zip.length } },
  }
  const reads: string[] = []
  const read = async (loc: string) => {
    reads.push(loc)
    if (loc.endsWith('/index.json')) return strToU8(JSON.stringify(index))
    if (loc.endsWith('/asset_ph_sofa.zip')) return zip
    throw new Error(`404 ${loc}`)
  }
  return { read, reads }
}

describe('shared feeds settings', () => {
  it('keeps both built-in feeds, fixed, in the stored order', () => {
    const out = sanitizeFeeds([
      { id: 'upstream', name: 'x', url: 'https://evil.example/', enabled: false },
      { id: 'mine', name: 'Office', url: 'https://cdn.example.com/feed', enabled: true },
    ])
    expect(out.map((f) => f.id)).toEqual(['upstream', 'mine', 'doplan'])
    expect(out[0]).toEqual({ ...DEFAULT_FEEDS[1], enabled: false })
    expect(out[1].url).toBe('https://cdn.example.com/feed/')
    expect(sanitizeFeeds(undefined)).toEqual(DEFAULT_FEEDS.map((f) => ({ ...f })))
  })
  it('accepts https URLs and absolute folders only', () => {
    expect(cleanFeedUrl('http://example.com/feed')).toBeNull()
    expect(cleanFeedUrl('https://user:pw@example.com/')).toBeNull()
    expect(cleanFeedUrl('file:///C:/feed')).toBeNull()
    expect(cleanFeedUrl('relative/feed')).toBeNull()
    expect(cleanFeedUrl('D:\\doplan-feed')).toBe('D:\\doplan-feed')
    expect(cleanFeedUrl('\\\\server\\share\\feed')).toBe('\\\\server\\share\\feed')
    expect(sanitizeFeeds([{ id: 'bad', name: 'b', url: 'ftp://x', enabled: true }]).map((f) => f.id)).toEqual(['doplan', 'upstream'])
  })
})

describe('feed index and files', () => {
  beforeEach(() => clearFeedIndexCache())

  it('drops index entries with unsafe names or bad checksums', () => {
    const idx = parseFeedIndex({
      format: 'doplan-feed',
      version: 1,
      entries: {
        ok: { file: 'ok.zip', sha256: 'a'.repeat(64), bytes: 10 },
        '../x': { file: 'x.zip', sha256: 'a'.repeat(64), bytes: 10 },
        sub: { file: '../sub.zip', sha256: 'a'.repeat(64), bytes: 10 },
        nosha: { file: 'n.zip', sha256: 'zz', bytes: 10 },
      },
    })
    expect([...idx.entries.keys()]).toEqual(['ok'])
    expect(() => parseFeedIndex({ format: 'other', version: 1, entries: {} })).toThrow()
  })

  it('locates files next to index.json for URLs and folders', () => {
    expect(feedFileLocation('https://github.com/o/r/releases/download/feed-1/', 'a.zip')).toBe('https://github.com/o/r/releases/download/feed-1/a.zip')
    expect(feedFileLocation('D:\\feed\\', 'a.zip')).toBe('D:\\feed\\a.zip')
    expect(feedFileLocation('/srv/feed', 'a.zip')).toBe('/srv/feed/a.zip')
  })

  it('lists the paths a download must produce', () => {
    expect(expectedFiles({ zip: { url: 'https://x/a.zip', files: { 'A_Color.jpg': 'materials/a/color.jpg', 'A_N.jpg': './materials/a/normal.jpg' } } })).toEqual([
      'materials/a/color.jpg',
      'materials/a/normal.jpg',
    ])
  })

  it('takes only the expected files from a feed zip', async () => {
    const { read } = feedWith({ 'models/sofa/sofa_1k.gltf': 'g', 'models/sofa/sofa.bin': 'b', '../evil.exe': 'x' })
    const files = await fromFeed('https://feed.example/', 'asset_ph_sofa', expectedFiles(spec), read)
    expect(files && [...files.keys()].sort()).toEqual(['models/sofa/sofa.bin', 'models/sofa/sofa_1k.gltf'])
  })

  it('returns null when the feed does not have the entry, and reads index.json once', async () => {
    const { read, reads } = feedWith({ 'models/sofa/sofa_1k.gltf': 'g', 'models/sofa/sofa.bin': 'b' })
    expect(await fromFeed('https://feed.example/', 'asset_other', ['x'], read)).toBeNull()
    await fromFeed('https://feed.example/', 'asset_ph_sofa', expectedFiles(spec), read)
    expect(reads.filter((r) => r.endsWith('index.json'))).toHaveLength(1)
  })

  it('refuses a zip with a wrong checksum or missing files', async () => {
    const bad = feedWith({ 'models/sofa/sofa_1k.gltf': 'g', 'models/sofa/sofa.bin': 'b' }, { badSha: true })
    await expect(fromFeed('https://a.example/', 'asset_ph_sofa', expectedFiles(spec), bad.read)).rejects.toThrow(/checksum/)
    const partial = feedWith({ 'models/sofa/sofa_1k.gltf': 'g' })
    await expect(fromFeed('https://b.example/', 'asset_ph_sofa', expectedFiles(spec), partial.read)).rejects.toThrow(/sofa\.bin/)
    expect(() => takeExpected(strToU8('not a zip'), ['a'])).toThrow(/broken zip|lacks/)
  })

  it('reports an unreachable feed', async () => {
    const read = async () => {
      throw new Error('ENOTFOUND')
    }
    await expect(fromFeed('https://down.example/', 'asset_ph_sofa', ['a'], read)).rejects.toThrow(/index\.json: ENOTFOUND/)
  })
})
