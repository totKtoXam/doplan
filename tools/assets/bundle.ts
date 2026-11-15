/**
 * Shared helpers for the bundled (`remote !== true`) part of resources/assets:
 * which files the installer must ship, the assets-pack zip and its manifest (tools/assets/pack.json).
 *
 * Used by check.ts (pre-build check), pack.ts (make the pack zip) and unpack.ts (CI restore).
 * Pure functions only; the CLIs do the I/O.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
export const ASSETS_DIR = path.join(ROOT, 'resources', 'assets')
export const CATALOG_PATH = path.join(ASSETS_DIR, 'catalog.json')
export const PACK_JSON = path.join(HERE, 'pack.json')

/** the gitignored heavy folders that the assets pack carries */
export const PACK_DIRS = ['models', 'materials', 'hdris'] as const

/** tools/assets/pack.json: the single place that names the current assets pack */
export interface PackInfo {
  /** pack number N: release tag `assets-N`, file `doplan-assets-N.zip` */
  pack: number
  /** sha256 (hex) of the zip, written by pack.ts and verified by unpack.ts */
  sha256: string
  /** zip size in bytes (informational) */
  bytes: number
  /** number of files in the zip (informational) */
  files: number
}

export const packTag = (n: number): string => `assets-${n}`
export const packFile = (n: number): string => `doplan-assets-${n}.zip`

const BUNDLED_RE = /^(models|materials|hdris)\//

interface Entry {
  id?: string
  remote?: boolean
  [k: string]: unknown
}

export interface CatalogLike {
  materials?: Entry[]
  assets?: Entry[]
  hdris?: Entry[]
}

/** every string under `v` (objects/arrays walked, `download` skipped) that looks like a bundled path */
function collectPaths(v: unknown, out: Set<string>, key?: string): void {
  if (key === 'download') return
  if (typeof v === 'string') {
    if (BUNDLED_RE.test(v)) out.add(v)
  } else if (Array.isArray(v)) {
    for (const x of v) collectPaths(x, out)
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collectPaths(x, out, k)
  }
}

/**
 * Paths (relative to resources/assets, forward slashes) that bundled catalog entries point to:
 * every `models/… | materials/… | hdris/…` string in an entry whose `remote` is not `true`.
 * Returned with the ids of the entries that use them, sorted by path.
 */
export function bundledPaths(catalog: CatalogLike): { path: string; ids: string[] }[] {
  const byPath = new Map<string, string[]>()
  for (const list of [catalog.materials, catalog.assets, catalog.hdris]) {
    for (const e of list ?? []) {
      if (e.remote === true) continue
      const found = new Set<string>()
      collectPaths(e, found)
      for (const p of found) {
        const ids = byPath.get(p) ?? []
        ids.push(e.id ?? '?')
        byPath.set(p, ids)
      }
    }
  }
  return [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, ids]) => ({ path: p, ids }))
}

/** relative files a .gltf references (buffers and images, `data:` URIs skipped), resolved against the .gltf's folder */
export function gltfDependencies(gltfRelPath: string, json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }): string[] {
  const dir = path.posix.dirname(gltfRelPath)
  const out: string[] = []
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    const uri = item.uri
    if (!uri || uri.startsWith('data:') || /^[a-z]+:\/\//i.test(uri)) continue
    out.push(path.posix.normalize(path.posix.join(dir, decodeURIComponent(uri))))
  }
  return out
}

/**
 * A zip entry name that may be written under resources/assets: forward slashes, inside one of PACK_DIRS,
 * no `..`, no absolute/drive paths. Returns the normalised name, or null if it must be refused.
 * Directory entries (trailing `/`) return null too: folders are created from file paths.
 */
export function safeEntryName(name: string): string | null {
  if (!name || name.endsWith('/') || name.includes('\\') || name.includes('\0')) return null
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const norm = path.posix.normalize(name)
  if (norm !== name || norm.split('/').some((s) => s === '..' || s === '.' || s === '')) return null
  const top = norm.split('/')[0]
  if (!(PACK_DIRS as readonly string[]).includes(top) || norm.split('/').length < 2) return null
  return norm
}

/** already-compressed formats are stored, everything else (gltf/bin/hdr…) deflated */
export function zipLevel(name: string): 0 | 6 {
  return /\.(jpe?g|png|webp|ktx2|exr|zip)$/i.test(name) ? 0 : 6
}
