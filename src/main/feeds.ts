/**
 * Downloads of on-demand catalog entries from doplan feeds (see shared/feeds.ts and docs/ASSET-FEEDS.md).
 *
 * A feed is a folder (https:// base URL or local path) with
 *   index.json   { "format": "doplan-feed", "version": 1, "entries": { "<id>": { "file", "sha256", "bytes" } } }
 *   <file>       a zip whose entries are the entry's library paths exactly as catalog.json names them
 *                (`models/sofa_02/sofa_02_1k.gltf`, `materials/tiles052/color.jpg`, …)
 * Feed content is untrusted: the index is validated, the zip must match its sha256 and size, and only the
 * paths the catalog expects for the entry are taken from it.
 *
 * No Electron imports here (unit-tested in Node); catalog.ts supplies the byte reader.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { unzipSync } from 'fflate'
import { isLocalFeedPath } from '../shared/feeds'

export interface FeedIndexEntry {
  file: string
  sha256: string
  bytes: number
}
export interface FeedIndex {
  entries: Map<string, FeedIndexEntry>
}

/** files of a feed are flat names next to index.json */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

export function parseFeedIndex(json: unknown): FeedIndex {
  const j = json as { format?: unknown; version?: unknown; entries?: unknown } | null
  if (!j || typeof j !== 'object' || j.format !== 'doplan-feed') throw new Error('not a doplan feed index')
  if (j.version !== 1) throw new Error(`unsupported feed index version ${String(j.version)}`)
  if (!j.entries || typeof j.entries !== 'object') throw new Error('feed index has no entries')
  const entries = new Map<string, FeedIndexEntry>()
  for (const [id, v] of Object.entries(j.entries as Record<string, unknown>)) {
    const e = v as Partial<FeedIndexEntry> | null
    if (!SAFE_ID.test(id) || !e || typeof e !== 'object') continue
    if (typeof e.file !== 'string' || !SAFE_FILE.test(e.file)) continue
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) continue
    if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes <= 0) continue
    entries.set(id, { file: e.file, sha256: e.sha256, bytes: e.bytes })
  }
  return { entries }
}

/** location of a file in a feed: URL for an https feed, path for a local folder */
export function feedFileLocation(base: string, file: string): string {
  if (isLocalFeedPath(base)) return `${base.replace(/[\\/]+$/, '')}${base.includes('\\') ? '\\' : '/'}${file}`
  return new URL(file, base.endsWith('/') ? base : `${base}/`).href
}

interface SpecLike {
  files?: { url: string; path: string }[]
  zip?: { url: string; files: Record<string, string> }
}

const normRel = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/^\/+/, '')

/** library-relative paths an entry's download must produce, as the catalog names them */
export function expectedFiles(spec: SpecLike): string[] {
  const out = new Set<string>()
  for (const f of spec.files ?? []) out.add(normRel(f.path))
  for (const rel of Object.values(spec.zip?.files ?? {})) out.add(normRel(rel))
  return [...out].sort()
}

/** the expected files out of a feed zip; throws when one is missing */
export function takeExpected(zip: Uint8Array, expected: string[]): Map<string, Uint8Array> {
  const want = new Set(expected)
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip, { filter: (f) => want.has(normRel(f.name)) })
  } catch (err) {
    throw new Error(`broken zip: ${(err as Error).message}`)
  }
  const out = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(entries)) out.set(normRel(name), data)
  const missing = expected.filter((p) => !out.has(p))
  if (missing.length) throw new Error(`zip lacks ${missing.join(', ')}`)
  return out
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** reads a feed file (https URL or local path) */
export type FeedReader = (location: string) => Promise<Uint8Array>

const INDEX_TTL_MS = 10 * 60 * 1000
const INDEX_FAIL_TTL_MS = 60 * 1000
const indexCache = new Map<string, { at: number; ok: boolean; index?: FeedIndex; error?: string }>()

export function clearFeedIndexCache(): void {
  indexCache.clear()
}

async function feedIndex(base: string, read: FeedReader): Promise<FeedIndex> {
  const hit = indexCache.get(base)
  const now = Date.now()
  if (hit && now - hit.at < (hit.ok ? INDEX_TTL_MS : INDEX_FAIL_TTL_MS)) {
    if (hit.ok && hit.index) return hit.index
    throw new Error(hit.error ?? 'feed unavailable')
  }
  try {
    const bytes = await read(feedFileLocation(base, 'index.json'))
    const index = parseFeedIndex(JSON.parse(new TextDecoder().decode(bytes)))
    indexCache.set(base, { at: now, ok: true, index })
    return index
  } catch (err) {
    const error = `index.json: ${(err as Error).message}`
    indexCache.set(base, { at: now, ok: false, error })
    throw new Error(error)
  }
}

/**
 * The files of entry `id` from the feed at `base`, keyed by library path; null when the feed does not
 * have the entry (the next feed is tried). Throws when the feed is unreachable or its data is wrong.
 */
export async function fromFeed(base: string, id: string, expected: string[], read: FeedReader): Promise<Map<string, Uint8Array> | null> {
  const index = await feedIndex(base, read)
  const item = index.entries.get(id)
  if (!item) return null
  const zip = await read(feedFileLocation(base, item.file))
  if (zip.length !== item.bytes || sha256(zip) !== item.sha256) throw new Error(`${item.file}: checksum mismatch`)
  return takeExpected(zip, expected)
}
