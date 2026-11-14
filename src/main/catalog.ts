import { randomBytes } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { join, posix } from 'node:path'
import { unzipSync } from 'fflate'
import type { Asset, Catalog, Hdri, Material, MaterialMaps } from '../core/types'
import { CH } from './channels'
import { atomicWrite, cleanExt, readJson, rmrf, safeJoin, toBytes } from './fsutil'
import { paths } from './paths'
import { broadcast } from './window'

const USER_AGENT = 'doplan/0.1'
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

type Kind = 'asset' | 'material' | 'hdri'
type Coll = 'assets' | 'materials' | 'hdris'
type AnyEntry = Asset | Material | Hdri

interface DownloadSpec {
  files?: { url: string; path: string }[]
  zip?: { url: string; files: Record<string, string> }
}

type RawEntry = AnyEntry & {
  remote?: boolean
  download?: DownloadSpec
  /** library-only: files owned by this entry (relative to library root) */
  _files?: string[]
}

interface RawCatalog {
  version: number
  materials: RawEntry[]
  assets: RawEntry[]
  hdris: RawEntry[]
}

interface LibraryCatalog extends RawCatalog {
  /** id → thumbnail path relative to library root (may carry ?v=) for entries not owned by the library */
  thumbs: Record<string, string>
}

const COLL: Record<Kind, Coll> = { asset: 'assets', material: 'materials', hdri: 'hdris' }
const MAP_KEYS = ['color', 'normal', 'roughness', 'metalness', 'ao', 'arm', 'displacement'] as const

const libCatalogFile = () => join(paths.library, 'catalog.json')

function arr(x: unknown): RawEntry[] {
  return Array.isArray(x) ? (x.filter((e) => e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') as RawEntry[]) : []
}

async function readBase(): Promise<RawCatalog> {
  const raw = await readJson<Partial<RawCatalog> | null>(join(paths.catalogRoot, 'catalog.json'), null)
  return {
    version: typeof raw?.version === 'number' ? raw.version : 1,
    materials: arr(raw?.materials),
    assets: arr(raw?.assets),
    hdris: arr(raw?.hdris),
  }
}

async function readLib(): Promise<LibraryCatalog> {
  const raw = await readJson<Partial<LibraryCatalog> | null>(libCatalogFile(), null)
  const thumbs: Record<string, string> = {}
  if (raw?.thumbs && typeof raw.thumbs === 'object') {
    for (const [k, v] of Object.entries(raw.thumbs)) if (typeof v === 'string') thumbs[k] = v
  }
  return {
    version: 1,
    materials: arr(raw?.materials),
    assets: arr(raw?.assets),
    hdris: arr(raw?.hdris),
    thumbs,
  }
}

/** serialise read-modify-write cycles of the library catalog */
let libLock: Promise<unknown> = Promise.resolve()
function withLib<T>(fn: (lib: LibraryCatalog) => Promise<T> | T): Promise<T> {
  const run = libLock.catch(() => undefined).then(async () => {
    const lib = await readLib()
    const result = await fn(lib)
    await atomicWrite(libCatalogFile(), JSON.stringify(lib, null, 2))
    return result
  })
  libLock = run
  return run
}

// ───────────── URL resolution ─────────────

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function cleanRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

export function toAssetUrl(host: 'catalog' | 'library', rel: string): string {
  if (HAS_SCHEME.test(rel)) return rel
  const q = rel.indexOf('?')
  const pathPart = cleanRel(q >= 0 ? rel.slice(0, q) : rel)
  const query = q >= 0 ? rel.slice(q) : ''
  return `doplan-asset://${host}/${pathPart.split('/').map(encodeURIComponent).join('/')}${query}`
}

function stripPrivate<T extends RawEntry>(e: T): AnyEntry {
  const { download: _d, _files: _f, ...rest } = e
  return rest as unknown as AnyEntry
}

function resolveThumb(thumb: string | undefined, preferCatalog: boolean): string | undefined {
  if (!thumb) return undefined
  if (HAS_SCHEME.test(thumb)) return thumb
  if (preferCatalog) {
    const p = safeJoin(paths.catalogRoot, thumb.split('?')[0])
    if (p && existsSync(p)) return toAssetUrl('catalog', thumb)
    return toAssetUrl('library', thumb)
  }
  return toAssetUrl('library', thumb)
}

function resolveEntry(e: RawEntry, host: 'catalog' | 'library', fromBase: boolean): AnyEntry {
  const out = stripPrivate({ ...e }) as AnyEntry & { src?: string; maps?: MaterialMaps; thumb?: string; remote?: boolean }
  const remote = fromBase && !!e.remote
  // remote entries' files land in the library; local base entries live in the bundled pack
  const fileHost: 'catalog' | 'library' = remote ? 'library' : host
  if (typeof out.src === 'string' && out.src) out.src = toAssetUrl(fileHost, out.src)
  if (out.maps && typeof out.maps === 'object') {
    const maps: MaterialMaps = {}
    for (const k of MAP_KEYS) {
      const v = out.maps[k]
      if (typeof v === 'string' && v) maps[k] = toAssetUrl(fileHost, v)
    }
    out.maps = maps
  }
  out.thumb = fromBase ? resolveThumb(e.thumb, true) : resolveThumb(e.thumb, false)
  if (out.thumb === undefined) delete out.thumb
  if (remote) out.remote = true
  else delete out.remote
  return out
}

export async function loadCatalog(): Promise<Catalog> {
  const [base, lib] = await Promise.all([readBase(), readLib()])
  const result: Catalog = { version: base.version, materials: [], assets: [], hdris: [] }
  for (const coll of ['materials', 'assets', 'hdris'] as const) {
    const byId = new Map<string, AnyEntry>()
    for (const e of base[coll]) byId.set(e.id, resolveEntry(e, 'catalog', true))
    for (const e of lib[coll]) byId.set(e.id, resolveEntry(e, 'library', false))
    for (const [id, rel] of Object.entries(lib.thumbs)) {
      const e = byId.get(id) as (AnyEntry & { thumb?: string }) | undefined
      if (e) e.thumb = toAssetUrl('library', rel)
    }
    ;(result[coll] as AnyEntry[]) = [...byId.values()]
  }
  return result
}

// ───────────── imports ─────────────

function newId(prefix: string): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = randomBytes(10)
  let s = ''
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return `${prefix}_${s}`
}

function libPath(rel: string): string {
  const p = safeJoin(paths.library, rel)
  if (!p) throw new Error(`Недопустимый путь в библиотеке: ${rel}`)
  return p
}

export async function importModel(glbData: unknown, meta: unknown, thumbPng?: unknown): Promise<Asset> {
  const glb = toBytes(glbData)
  if (glb.length < 12) throw new Error('Пустой файл модели')
  const m = (meta && typeof meta === 'object' ? meta : {}) as Partial<Asset>
  const id = newId('a')
  const src = `models/${id}/model.glb`
  await atomicWrite(libPath(src), glb)
  const files = [`models/${id}`]
  let thumb: string | undefined
  if (thumbPng != null) {
    thumb = `thumbs/${id}.png`
    await atomicWrite(libPath(thumb), toBytes(thumbPng))
    files.push(thumb)
  }
  const entry: RawEntry = {
    ...(m as object),
    id,
    kind: 'model',
    src,
    name: typeof m.name === 'string' && m.name ? m.name : 'Модель',
    category: m.category ?? 'other',
    size: m.size ?? { w: 1000, d: 1000, h: 1000 },
    mount: m.mount ?? 'floor',
    custom: true,
    _files: files,
  } as RawEntry
  delete (entry as { remote?: boolean }).remote
  if (thumb) (entry as Asset).thumb = thumb
  await withLib((lib) => {
    lib.assets = lib.assets.filter((e) => e.id !== id)
    lib.assets.push(entry)
  })
  return resolveEntry(entry, 'library', false) as Asset
}

export async function importMaterial(meta: unknown, maps: unknown): Promise<Material> {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Partial<Material>
  const id = newId('m')
  const relMaps: MaterialMaps = {}
  const input = (maps && typeof maps === 'object' ? maps : {}) as Record<string, { data: unknown; ext: string } | undefined>
  for (const k of MAP_KEYS) {
    const v = input[k]
    if (!v || v.data == null) continue
    const rel = `materials/${id}/${k}.${cleanExt(v.ext, 'png')}`
    await atomicWrite(libPath(rel), toBytes(v.data))
    relMaps[k] = rel
  }
  const entry: RawEntry = {
    ...(m as object),
    id,
    name: typeof m.name === 'string' && m.name ? m.name : 'Материал',
    category: m.category ?? 'other',
    color: typeof m.color === 'string' ? m.color : '#ffffff',
    roughness: typeof m.roughness === 'number' ? m.roughness : 0.8,
    metalness: typeof m.metalness === 'number' ? m.metalness : 0,
    maps: relMaps,
    custom: true,
    _files: [`materials/${id}`],
  } as RawEntry
  delete (entry as { remote?: boolean }).remote
  await withLib((lib) => {
    lib.materials.push(entry)
  })
  return resolveEntry(entry, 'library', false) as Material
}

export async function saveThumb(kind: unknown, id: unknown, png: unknown): Promise<string> {
  if (kind !== 'asset' && kind !== 'material') throw new Error('Неизвестный тип элемента каталога')
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_.-]{1,128}$/.test(id)) throw new Error('Некорректный id')
  const fileId = id.replace(/[^A-Za-z0-9_.-]/g, '_')
  const rel = `thumbs/${fileId}.png`
  await atomicWrite(libPath(rel), toBytes(png))
  const versioned = `${rel}?v=${Date.now().toString(36)}`
  await withLib((lib) => {
    const coll = lib[COLL[kind]]
    const own = coll.find((e) => e.id === id) as (RawEntry & { thumb?: string }) | undefined
    if (own) {
      own.thumb = versioned
      own._files = [...new Set([...(own._files ?? []), rel])]
      delete lib.thumbs[id]
    } else {
      lib.thumbs[id] = versioned
    }
  })
  return toAssetUrl('library', versioned)
}

export async function removeEntry(kind: unknown, id: unknown): Promise<void> {
  if (kind !== 'asset' && kind !== 'material') throw new Error('Неизвестный тип элемента каталога')
  if (typeof id !== 'string') throw new Error('Некорректный id')
  const toDelete: string[] = []
  await withLib((lib) => {
    const coll = COLL[kind]
    const entry = lib[coll].find((e) => e.id === id)
    if (entry) {
      toDelete.push(...(entry._files ?? []))
      lib[coll] = lib[coll].filter((e) => e.id !== id)
    }
    const t = lib.thumbs[id]
    if (t) {
      toDelete.push(t.split('?')[0])
      delete lib.thumbs[id]
    }
  })
  for (const rel of toDelete) {
    const p = safeJoin(paths.library, rel)
    if (p) await rmrf(p)
  }
}

// ───────────── downloads of remote entries ─────────────

const inflight = new Map<string, Promise<AnyEntry>>()

class Progress {
  done = 0
  total = 0
  private last = 0
  constructor(private id: string) {}
  emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.last < 100) return
    this.last = now
    broadcast(CH.evCatalogProgress, { id: this.id, done: this.done, total: Math.max(this.total, this.done) })
  }
}

async function fetchBytes(url: string, progress: Progress): Promise<Uint8Array> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`Некорректный адрес загрузки: ${url}`)
  }
  if (u.protocol !== 'https:') throw new Error(`Разрешены только HTTPS-загрузки: ${url}`)
  const res = await fetch(u, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) throw new Error(`Ошибка загрузки ${res.status} ${res.statusText}: ${url}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_DOWNLOAD_BYTES) throw new Error('Файл слишком большой для загрузки')
  if (len > 0) progress.total += len
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.length
    progress.done += value.length
    if (len <= 0) progress.total = Math.max(progress.total, progress.done)
    if (received > MAX_DOWNLOAD_BYTES) {
      await reader.cancel()
      throw new Error('Файл слишком большой для загрузки')
    }
    progress.emit()
  }
  const out = new Uint8Array(received)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

const baseName = (p: string) => posix.basename(p.replace(/\\/g, '/')).toLowerCase()

async function runDownload(kind: Kind, id: string): Promise<AnyEntry> {
  const coll = COLL[kind]
  const [base, lib] = await Promise.all([readBase(), readLib()])
  const existing = lib[coll].find((e) => e.id === id)
  if (existing) return resolveEntry(existing, 'library', false)
  const raw = base[coll].find((e) => e.id === id)
  if (!raw) throw new Error(`Элемент каталога не найден: ${id}`)
  if (!raw.remote) return resolveEntry(raw, 'catalog', true)
  const spec = raw.download
  if (!spec || (!spec.files?.length && !spec.zip)) throw new Error(`Для «${id}» не указан источник загрузки`)

  const progress = new Progress(id)
  progress.emit(true)
  const written: string[] = []

  for (const f of spec.files ?? []) {
    const target = libPath(f.path)
    const data = await fetchBytes(f.url, progress)
    await atomicWrite(target, data)
    written.push(cleanRel(f.path))
  }

  if (spec.zip) {
    const zipBytes = await fetchBytes(spec.zip.url, progress)
    const wanted = spec.zip.files
    const exact = new Set(Object.keys(wanted))
    const byBase = new Map<string, string>()
    for (const k of Object.keys(wanted)) byBase.set(baseName(k), k)
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(zipBytes, { filter: (f) => exact.has(f.name) || byBase.has(baseName(f.name)) })
    } catch (err) {
      throw new Error(`Не удалось распаковать архив: ${(err as Error).message}`)
    }
    const found = new Map<string, Uint8Array>()
    for (const [name, data] of Object.entries(entries)) {
      if (exact.has(name)) found.set(name, data)
    }
    for (const [name, data] of Object.entries(entries)) {
      const key = byBase.get(baseName(name))
      if (key && !found.has(key)) found.set(key, data)
    }
    const missing = Object.keys(wanted).filter((k) => !found.has(k))
    if (missing.length) throw new Error(`В архиве нет файлов: ${missing.join(', ')}`)
    for (const [entryName, rel] of Object.entries(wanted)) {
      await atomicWrite(libPath(rel), found.get(entryName)!)
      written.push(cleanRel(rel))
    }
  }

  // thumbnails of remote entries are usually bundled: keep an absolute URL if so
  const thumb = resolveThumb(raw.thumb, true)
  const local: RawEntry = { ...raw, _files: written } as RawEntry
  delete local.download
  delete local.remote
  if (thumb) (local as { thumb?: string }).thumb = thumb
  else delete (local as { thumb?: string }).thumb

  await withLib((l) => {
    l[coll] = l[coll].filter((e) => e.id !== id)
    l[coll].push(local)
  })
  progress.total = Math.max(progress.total, progress.done)
  progress.emit(true)
  return resolveEntry(local, 'library', false)
}

export function downloadEntry(kind: unknown, id: unknown): Promise<AnyEntry> {
  if (kind !== 'asset' && kind !== 'material' && kind !== 'hdri') return Promise.reject(new Error('Неизвестный тип элемента каталога'))
  if (typeof id !== 'string' || !id) return Promise.reject(new Error('Некорректный id'))
  const key = `${kind}:${id}`
  const running = inflight.get(key)
  if (running) return running
  const p = runDownload(kind, id).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export async function ensureLibrary(): Promise<void> {
  await fsp.mkdir(paths.library, { recursive: true })
}
