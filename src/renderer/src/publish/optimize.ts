/**
 * Lighter files for a published plan. Before the site goes out every texture is fitted to the size it
 * is seen at and re-encoded as WebP, and every model is cleaned up, simplified within a small visual
 * error, quantized and meshopt-compressed (EXT_meshopt_compression: the viewer's loader decodes it).
 * A .gltf with separate files becomes one .glb. Files that come out byte-identical are published once.
 *
 * Pure apart from the image codec (the browser one is ./browserCodec): sources are read through
 * `env.read`, results ride along in `SiteFile.data`, and main writes those instead of copying.
 * Anything that fails to load or would not get smaller is published as it is.
 */
import { type Document as GltfDocument, PropertyType, type Texture, WebIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions'
import { dedup, listTextureSlots, meshopt, prune, simplify, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { gltfDependencies, joinRel, mapStrings, type SiteContent, type SiteFile, siteUrlOf } from '@shared/pagesSite'

/** bumps when the same input would give a different output (results are cached by it) */
export const OPTIMIZE_VERSION = 2

/** how a texture is sampled: colour (sRGB), a normal map, or other data (roughness / AO / …) */
export type TextureUse = 'color' | 'normal' | 'data'

export interface FittedImage {
  data: Uint8Array
  mime: string
}

export interface ImageCodec {
  /** the picture fitted within maxPx × maxPx (never enlarged) and re-encoded; null = cannot decode */
  fit(data: Uint8Array, mime: string, maxPx: number, use: TextureUse): Promise<FittedImage | null>
}

export interface OptimizeEnv {
  /** bytes of a site file's source */
  read(f: SiteFile): Promise<Uint8Array>
  codec: ImageCodec
  /** results by input, kept across publications of a session */
  cache?: Map<string, Promise<Uint8Array | null>>
  onProgress?(done: number, total: number): void
}

export interface OptimizeReport {
  /** bytes of the textures and models before and after (other files are not counted) */
  before: number
  after: number
  /** files re-encoded / dropped as duplicates / published as they were */
  changed: number
  duplicates: number
  kept: number
}

export interface Budget {
  /** longest side of a texture, px */
  px: number
  /** triangles a model is simplified towards (never past the visual error) */
  tris: number
  /** how its textures are sampled, when known from the catalogue (material maps) */
  use?: TextureUse
}

const DEFAULT_BUDGET: Budget = { px: 1024, tris: Infinity }

/**
 * What an object of this size needs on screen: ~1 texel per millimetre up to 1024 px, at least 256 px
 * for a cup; triangles likewise (a chair does not need 180 000).
 */
export function budgetForSize(maxMm: number): Budget {
  const m = Number.isFinite(maxMm) && maxMm > 0 ? maxMm / 1000 : 1
  const px = Math.min(1024, Math.max(256, 2 ** Math.ceil(Math.log2(m * 1024))))
  const tris = m < 0.35 ? 12_000 : m < 0.8 ? 25_000 : m < 1.6 ? 45_000 : 80_000
  return { px, tris }
}

const IMAGE = /\.(jpe?g|png|webp)$/i
const MODEL = /\.(glb|gltf)$/i
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const MAP_USE: Record<string, TextureUse> = { color: 'color', normal: 'normal' }

/** a texture's use from its file name, when nothing else says */
export function mapUseOfName(path: string): TextureUse {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const words = name.replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/)
  if (words.some((w) => /^(nor|normal|nrm|norm|normalgl|normaldx)$/.test(w))) return 'normal'
  if (words.some((w) => /^(rough|roughness|ao|arm|orm|metal|metalness|metallic|occlusion|spec|specular|height|disp|displacement|bump)$/.test(w))) return 'data'
  return 'color'
}

/** `./assets/c/a%20b.jpg` → `assets/c/a b.jpg` */
function pathOfUrl(s: string): string | null {
  if (!s.startsWith('./assets/')) return null
  try {
    return s
      .slice(2)
      .split('/')
      .map((p) => decodeURIComponent(p))
      .join('/')
  } catch {
    return null
  }
}

/**
 * Budgets of the files the catalogue part of the site names: models by their size, material maps
 * 1024 px with their use. HDRIs are left out (lighting, not a texture to shrink).
 */
export function budgets(content: SiteContent): { byPath: Map<string, Budget>; skip: Set<string> } {
  const byPath = new Map<string, Budget>()
  const put = (path: string | null, b: Budget) => {
    if (!path) return
    const cur = byPath.get(path)
    byPath.set(path, cur ? { ...cur, px: Math.max(cur.px, b.px), tris: Math.max(cur.tris, b.tris) } : b)
  }
  type AssetLike = { src?: unknown; size?: { w?: number; d?: number; h?: number } }
  for (const a of content.catalog.assets as AssetLike[]) {
    if (typeof a?.src !== 'string') continue
    const s = a.size ?? {}
    put(pathOfUrl(a.src), budgetForSize(Math.max(s.w ?? 0, s.d ?? 0, s.h ?? 0)))
  }
  for (const m of content.catalog.materials as { maps?: Record<string, unknown> }[]) {
    for (const [k, v] of Object.entries(m?.maps ?? {}))
      if (typeof v === 'string') put(pathOfUrl(v), { ...DEFAULT_BUDGET, use: MAP_USE[k] ?? 'data' })
  }
  const skip = new Set<string>()
  for (const h of content.catalog.hdris as { src?: unknown }[]) {
    const p = typeof h?.src === 'string' ? pathOfUrl(h.src) : null
    if (p) skip.add(p)
  }
  return { byPath, skip }
}

const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? ''
const withExt = (path: string, ext: string) => `${path.replace(/\.[a-z0-9]+$/i, '')}.${ext}`

async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

let ioPromise: Promise<WebIO> | null = null
function gltfIO(): Promise<WebIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])
    return new WebIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })
  })()
  return ioPromise
}

function textureUse(t: Texture): TextureUse {
  const slots = listTextureSlots(t)
  if (slots.some((s) => /normal/i.test(s))) return 'normal'
  if (slots.length && slots.every((s) => !/baseColor|emissive|diffuse|sheenColor|specularColor/i.test(s))) return 'data'
  return 'color'
}

function triangles(doc: GltfDocument): number {
  let n = 0
  for (const mesh of doc.getRoot().listMeshes())
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4) continue
      const idx = p.getIndices()
      n += (idx ? idx.getCount() : (p.getAttribute('POSITION')?.getCount() ?? 0)) / 3
    }
  return n
}

/** a model made lighter (see the module comment) */
export async function optimizeModel(doc: GltfDocument, budget: Budget, codec: ImageCodec): Promise<Uint8Array> {
  const io = await gltfIO()
  // identical accessors / meshes / textures merge; materials stay apart: their names are override slots
  await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }), prune({ keepAttributes: true, keepLeaves: true }))
  const tris = triangles(doc)
  if (Number.isFinite(budget.tris) && tris > budget.tris * 1.2) {
    // within 0.2 % of the model's size: silhouettes and joints stay where they are
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: budget.tris / tris, error: 0.002, lockBorder: true }))
  }
  let webp = false
  for (const t of doc.getRoot().listTextures()) {
    const img = t.getImage()
    if (!img) continue
    const fitted = await codec.fit(img, t.getMimeType() || 'image/png', budget.px, textureUse(t)).catch(() => null)
    if (fitted && fitted.data.byteLength < img.byteLength) t.setImage(fitted.data).setMimeType(fitted.mime).setURI('')
    if (t.getMimeType() === 'image/webp') webp = true
  }
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true)
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
  return io.writeBinary(doc)
}

/** a .glb, or a .gltf with the files it points to (read through env, never fetched) */
async function readModel(f: SiteFile, bytes: Uint8Array, env: OptimizeEnv): Promise<GltfDocument> {
  const io = await gltfIO()
  if (extOf(f.rel) === 'glb') return io.readBinary(bytes)
  const json = JSON.parse(new TextDecoder().decode(bytes))
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {}
  for (const list of [json.buffers ?? [], json.images ?? []] as { uri?: unknown }[][])
    for (const x of list) {
      if (typeof x?.uri !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(x.uri)) continue
      const dep = gltfDependencies({ buffers: [{ uri: x.uri }] })[0]
      const rel = dep && joinRel(f.rel, dep)
      if (!rel) throw new Error(`bad glTF reference ${x.uri}`)
      resources[x.uri] = (await env.read({ host: f.host, rel, path: f.path })) as Uint8Array<ArrayBuffer>
    }
  return io.readJSON({ json, resources })
}

interface Done {
  file: SiteFile
  /** the source bytes, and the new ones when the file was made lighter */
  source: Uint8Array | null
  data?: Uint8Array
}

async function optimizeOne(f: SiteFile, budget: Budget, env: OptimizeEnv): Promise<Done> {
  const source = await env.read(f)
  const ext = extOf(f.rel)
  const key = `${OPTIMIZE_VERSION}|${f.host}|${f.rel}|${source.byteLength}|${budget.px}|${budget.tris}|${budget.use ?? ''}`
  const run = async (): Promise<Uint8Array | null> => {
    if (IMAGE.test(f.rel)) {
      const fitted = await env.codec.fit(source, MIME[ext] ?? 'image/png', budget.px, budget.use ?? mapUseOfName(f.rel))
      return fitted && fitted.mime === 'image/webp' && fitted.data.byteLength < source.byteLength * 0.9 ? fitted.data : null
    }
    const out = await optimizeModel(await readModel(f, source, env), budget, env.codec)
    // a .gltf becomes its .glb even when not smaller: one request instead of many
    return ext === 'gltf' || out.byteLength < source.byteLength * 0.95 ? out : null
  }
  let p = env.cache?.get(key)
  if (!p) {
    p = run().catch((err) => {
      console.warn('[doplan] publish: keeping as is', f.path, err)
      return null
    })
    env.cache?.set(key, p)
  }
  const data = await p
  if (!data) return { file: f, source }
  return { file: { ...f, path: withExt(f.path, IMAGE.test(f.rel) ? 'webp' : 'glb') }, source, data }
}

/** the site content with lighter files (see the module comment) and what it saved */
export async function optimizeSite(content: SiteContent, env: OptimizeEnv): Promise<{ content: SiteContent; report: OptimizeReport }> {
  const { byPath, skip } = budgets(content)
  const total = content.files.length
  const results: Done[] = new Array(total)
  let next = 0
  let done = 0
  // a few at a time: models are big, and images decode one by one anyway
  const worker = async () => {
    while (next < total) {
      const i = next++
      const f = content.files[i]
      const light = !skip.has(f.path) && (IMAGE.test(f.rel) || MODEL.test(f.rel))
      results[i] = light ? await optimizeOne(f, byPath.get(f.path) ?? DEFAULT_BUDGET, env) : { file: f, source: null }
      env.onProgress?.(++done, total)
    }
  }
  await Promise.all([worker(), worker(), worker()])

  const report: OptimizeReport = { before: 0, after: 0, changed: 0, duplicates: 0, kept: 0 }
  const urls = new Map<string, string>()
  const byHash = new Map<string, string>()
  const files: SiteFile[] = []
  const taken = new Set(content.files.map((f) => f.path))
  for (let i = 0; i < total; i++) {
    const from = content.files[i].path
    const { source, data } = results[i]
    let { file } = results[i]
    // `a.jpg` and `a.png` side by side both become WebP: the second keeps its old name in the new one
    if (file.path !== from && taken.has(file.path)) file = { ...file, path: `${from}.${extOf(file.path)}` }
    taken.add(file.path)
    const bytes = data ?? source
    if (source) report.before += source.byteLength
    // the same bytes under another name: one file, every reference pointed at it
    const hash = bytes && !/\.gltf$/i.test(file.path) ? await sha256(bytes) : null
    const same = hash ? byHash.get(hash) : undefined
    if (same) {
      urls.set(siteUrlOf(from), siteUrlOf(same))
      report.duplicates++
      continue
    }
    if (hash) byHash.set(hash, file.path)
    if (file.path !== from) urls.set(siteUrlOf(from), siteUrlOf(file.path))
    if (bytes) report.after += bytes.byteLength
    if (data) report.changed++
    else report.kept++
    files.push(data ? { ...file, data } : file)
  }
  const fix = (s: string) => urls.get(s) ?? s
  return { content: { ...content, doc: mapStrings(content.doc, fix), catalog: mapStrings(content.catalog, fix), files }, report }
}
