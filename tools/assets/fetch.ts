/**
 * doplan asset fetcher.
 *
 *   pnpm exec tsx tools/assets/fetch.ts [--all] [--only=models|materials|hdris] [--limit=N]
 *
 * Reads tools/assets/manifest.json, downloads the BUNDLED core pack (or everything with --all)
 * into resources/assets and (re)writes resources/assets/catalog.json + LICENSES.md.
 * Every manifest entry that is not downloaded locally becomes a `remote: true` catalog entry with a
 * `download` field ({ files } or { zip }) so the app can fetch it on demand into the user library.
 *
 * Resumable (existing non-empty files are skipped), never aborts on a single failure.
 * Downloads are untrusted: only whitelisted extensions are written, paths are sanitised, nothing is executed.
 */
import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import type { Asset, AssetCategory, Catalog, Hdri, Material, MaterialCategory, MountKind } from '../../src/core/types'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds, metalRough, prune, textureCompress } from '@gltf-transform/functions'
import { gltfExtents, implausibleSize, sizeFromGltf, type GltfJson } from './sizes'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUT = path.join(ROOT, 'resources', 'assets')
const CACHE = path.join(HERE, '.cache')
const UA = 'doplan-asset-fetcher/0.1'
const CONCURRENCY = 4
const ALLOWED_EXT = new Set(['.gltf', '.glb', '.bin', '.jpg', '.jpeg', '.png', '.webp', '.hdr', '.exr', '.ktx2'])

// ───────────────────────────── CLI ─────────────────────────────
const argv = process.argv.slice(2)
const FLAG_ALL = argv.includes('--all')
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7) as 'models' | 'materials' | 'hdris' | undefined
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? '0') || 0
const want = (k: 'models' | 'materials' | 'hdris') => !ONLY || ONLY === k

// ───────────────────────────── bundled core pack ─────────────────────────────
const BUNDLE_MODELS = new Set([
  'ph:sofa_02', 'ph:sofa_03', 'ph:Sofa_01', 'ph:modern_arm_chair_01', 'ph:mid_century_lounge_chair',
  'ph:dining_chair_02', 'ph:bar_chair_round_01', 'ph:dining_table', 'ph:modern_coffee_table_01',
  'ph:coffee_table_round_01', 'ph:side_table_01', 'ph:ClassicNightstand_01', 'ph:GothicBed_01',
  'ph:modern_wooden_cabinet', 'ph:drawer_cabinet', 'ph:steel_frame_shelves_01', 'ph:wooden_display_shelves_01',
  'ph:ClassicConsole_01', 'ph:modern_ceiling_lamp_01', 'ph:desk_lamp_arm_01', 'ph:hanging_industrial_lamp',
  'ph:industrial_wall_lamp', 'ph:potted_plant_02', 'ph:potted_plant_04', 'ph:ceramic_vase_01',
  'ph:hanging_picture_frame_01', 'ph:throw_pillows_01', 'ph:Television_01', 'ph:electric_stove',
  'ph:metal_office_desk', 'khr:SheenChair', 'khr:GlassVaseFlowers',
])
const BUNDLE_MATERIALS = new Set([
  'ph:herringbone_parquet', 'ph:laminate_floor_02', 'ph:wood_floor', 'ph:oak_veneer_01', 'ph:american_walnut_veneer',
  'ph:white_oak_veneer', 'ph:plank_flooring', 'ph:dark_wooden_planks', 'ph:long_white_tiles', 'ph:terrazzo_tiles',
  'ph:marble_tiles', 'ph:grey_tiles', 'ph:floor_tiles_08', 'ph:marble_01', 'ph:white_plaster_02', 'ph:beige_wall_001',
  'ph:grey_plaster', 'ph:smooth_concrete_floor', 'ph:red_brick', 'ph:whitewashed_brick', 'ph:rough_linen',
  'ph:velour_velvet', 'ph:wool_boucle', 'ph:brown_leather', 'ph:dirty_carpet',
  'acg:Tiles107', 'acg:Tiles052', 'acg:Tiles133A', 'acg:Tiles129B', 'acg:Tiles074', 'acg:Tiles139', 'acg:Tiles040',
  'acg:Marble012', 'acg:Marble016', 'acg:Granite002A', 'acg:PaintedPlaster017', 'acg:Concrete046', 'acg:Carpet016',
  'acg:Carpet001', 'acg:Wallpaper001A', 'acg:Metal049A', 'acg:Metal050A', 'acg:Metal048A', 'acg:Metal046A',
  'acg:Fabric030',
])
const BUNDLE_HDRIS = new Set([
  'ph:kloofendal_48d_partly_cloudy_puresky', 'ph:qwantani_noon_puresky', 'ph:kloofendal_overcast_puresky', 'ph:hotel_room',
])

// ───────────────────────────── manifest types ─────────────────────────────
interface MModel {
  id: string; name: string; nameRu?: string; category: string; source: string; licence: string; format: string
  gltf?: string; url?: string; files?: Record<string, string>; zip?: string; dimensionsM?: [number, number, number]
  attributionRequired?: boolean
  /** preview image URL when the source's default location does not have one */
  thumb?: string
  /** uniform correction of a model built at the wrong scale (sizeNote says why) */
  sizeScale?: number
  sizeNote?: string
  /** catalog size [w, d, h] in mm when the source scale is arbitrary (Sketchfab uploads): skips the glTF bounds */
  sizeMm?: [number, number, number]
  /** placement overrides of the category defaults (mountFor) */
  mount?: MountKind
  elevation?: number
  /** repair applied right after download; entries with a fix are always bundled (the app downloads remote files as is) */
  fix?: MFix
}
interface MFix {
  /** degrees about +Y that turn the model's front to +Z */
  rotateY?: number
  /** drop tiny flat helper meshes (ground planes, shadow discs): <= 64 vertices and ~zero height */
  dropFlat?: boolean
  /** convert KHR_materials_pbrSpecularGlossiness (unsupported by three.js) to metal/roughness */
  metalRough?: boolean
  /** downscale textures to this many pixels on the long side */
  maxTexture?: number
}
interface MMaterial {
  id: string; name: string; nameRu?: string; category: string; source: string; licence: string
  realWorldSizeM?: [number, number] | null; maps1k?: Record<string, string>; zip1k?: string; tags?: string[]
}
interface MHdri { id: string; name: string; source: string; licence: string; kind: 'interior' | 'exterior'; hdr1k: string; tags?: string[] }
interface Manifest { models: MModel[]; materials: MMaterial[]; hdris: MHdri[] }

// ───────────────────────────── utils ─────────────────────────────
const failures: string[] = []
const log = (...a: unknown[]) => console.log(...a)
const fail = (what: string, err: unknown) => {
  const msg = `${what}: ${err instanceof Error ? err.message : String(err)}`
  failures.push(msg)
  console.error('  FAIL ' + msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const rawId = (id: string) => id.slice(id.indexOf(':') + 1)

async function pool<T>(items: T[], worker: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      try { await worker(items[i], i) } catch (e) { fail(`worker#${i}`, e) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run))
}

/** sanitise a relative path coming from untrusted manifest/zip data; returns null if unacceptable */
function safeRel(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/')
  if (!norm || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.includes('\0')) return null
  const parts = norm.split('/')
  if (parts.some((p) => p === '..' || p === '' || p === '.')) return null
  if (!ALLOWED_EXT.has(path.extname(norm).toLowerCase())) return null
  return parts.join('/')
}
const abs = (rel: string) => path.join(OUT, ...rel.split('/'))
async function sizeOf(p: string): Promise<number> {
  try { return (await stat(p)).size } catch { return 0 }
}
const has = async (rel: string) => (await sizeOf(abs(rel))) > 0

async function httpGet(url: string): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120_000) })
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
        throw new Error(`HTTP ${res.status}`)
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      if ((e as { fatal?: boolean }).fatal) break
      await sleep(1500 * 2 ** attempt)
    }
  }
  throw new Error(`${url} -> ${lastErr instanceof Error ? lastErr.message : lastErr}`)
}

/** download url -> OUT/rel atomically. Skips existing non-empty files. Returns true if the file exists afterwards. */
async function download(url: string, rel: string): Promise<boolean> {
  const safe = safeRel(rel)
  if (!safe) { fail(`bad path ${rel}`, 'rejected'); return false }
  if (await has(safe)) return true
  try {
    const buf = await httpGet(url)
    if (!buf.length) throw new Error('empty body')
    const dest = abs(safe)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest + '.part', buf)
    await rename(dest + '.part', dest)
    return true
  } catch (e) {
    fail(`download ${rel}`, e)
    return false
  }
}

// ───────────────────────────── mapping helpers ─────────────────────────────
const ASSET_CAT: Record<string, AssetCategory> = {
  armchair: 'armchair', ottoman: 'armchair', chair: 'chair', stool: 'chair', bench: 'chair', sofa: 'sofa',
  outdoor: 'outdoor', 'coffee-table': 'table', table: 'table', 'side-table': 'table', desk: 'office',
  nightstand: 'storage', sideboard: 'storage', shelf: 'storage', wardrobe: 'storage', bed: 'bed',
  'lamp-ceiling': 'lighting', 'lamp-table': 'lighting', 'lamp-wall': 'lighting', 'lamp-floor': 'lighting',
  tv: 'electronics', electronics: 'electronics', 'appliance-kitchen': 'appliance', appliance: 'appliance',
  'appliance-balcony': 'outdoor', kitchenware: 'kitchen', kitchen: 'kitchen', decor: 'decor', 'decor-wall': 'decor',
  misc: 'other', plant: 'plant', textile: 'textile', curtain: 'textile', rug: 'textile', bathroom: 'bathroom',
}
function mountFor(cat: string, id: string, hM?: number): { mount: MountKind; elevation?: number } {
  if (cat === 'lamp-ceiling') return { mount: 'ceiling' }
  if (cat === 'lamp-wall') return { mount: 'wall', elevation: 1700 }
  if (cat === 'decor-wall') return { mount: 'wall', elevation: 1500 }
  if (['lamp-table', 'kitchenware', 'electronics', 'tv', 'textile'].includes(cat)) return { mount: 'surface' }
  if (['decor', 'plant'].includes(cat) && (hM ?? 1) < 0.45) return { mount: 'surface' }
  if (id.includes('ceiling_fan')) return { mount: 'ceiling' }
  return { mount: 'floor' }
}
/** default sizes (mm) for remote entries without dimensions (khronos / kaykit) */
const DEFAULT_SIZE: Record<string, [number, number, number]> = {
  sofa: [2000, 900, 800], armchair: [800, 800, 900], chair: [450, 450, 900], appliance: [800, 700, 1900],
  'appliance-kitchen': [800, 700, 1900], 'lamp-ceiling': [500, 500, 500], 'lamp-table': [250, 250, 450],
  'lamp-floor': [400, 400, 1600], decor: [200, 200, 250], plant: [500, 500, 900], table: [1200, 800, 750],
  bed: [1600, 2000, 900], shelf: [1000, 400, 1800], tv: [900, 100, 550], storage: [1000, 500, 800],
  wardrobe: [1000, 600, 2000], rug: [2000, 1400, 10],
}
/** glTF unit → metre per source (by id prefix): KayKit is built in stylised game units ~1.5× real size */
const UNIT_SCALE: Record<string, number> = { kk: 2 / 3 }
const MAT_CAT: Record<string, MaterialCategory> = {
  'wood-floor': 'wood', wood: 'wood', tile: 'tile', marble: 'marble', concrete: 'concrete', plaster: 'plaster',
  brick: 'brick', wallpaper: 'wallpaper', fabric: 'fabric', leather: 'leather', carpet: 'carpet',
  'resilient-floor': 'other', metal: 'metal', stone: 'stone', granite: 'stone', terrazzo: 'stone',
}
function matCategory(m: MMaterial): MaterialCategory {
  const id = rawId(m.id).toLowerCase()
  if (m.category === 'wood-floor') return id.includes('parquet') ? 'parquet' : id.includes('laminate') ? 'laminate' : 'wood'
  if (m.id === 'acg:Granite002A' || m.id === 'acg:Granite005A') return 'stone'
  if (id.includes('painted') && m.category === 'plaster') return 'paint'
  if (id.includes('rubber')) return 'plastic'
  return MAT_CAT[m.category] ?? 'other'
}
function matSurface(cat: MaterialCategory, id: string): { roughness: number; metalness: number } {
  const i = id.toLowerCase()
  if (cat === 'metal') return { roughness: 0.35, metalness: 1 }
  if (cat === 'marble') return { roughness: 0.2, metalness: 0 }
  if (cat === 'stone' && (i.includes('granite') || i.includes('onyx'))) return { roughness: 0.25, metalness: 0 }
  if (cat === 'tile') return { roughness: i.includes('tiles') && !i.includes('terrazzo') ? 0.35 : 0.5, metalness: 0 }
  if (cat === 'leather') return { roughness: 0.5, metalness: 0 }
  if (cat === 'fabric' || cat === 'carpet') return { roughness: 0.9, metalness: 0 }
  if (cat === 'plaster' || cat === 'paint' || cat === 'concrete' || cat === 'brick') return { roughness: 0.85, metalness: 0 }
  return { roughness: 0.6, metalness: 0 }
}
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
async function avgColor(buf: Buffer | string): Promise<string> {
  try {
    const st = await sharp(buf).resize(32, 32, { fit: 'fill' }).removeAlpha().stats()
    const [r, g, b] = st.channels.map((c) => c.mean)
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    return '#b0b0b0'
  }
}

// ───────────────────────────── thumbnails ─────────────────────────────
/** returns relative thumb path (webp under thumbs/) or undefined; also returns the decoded image buffer for colour sampling */
async function ensureThumb(id: string, url: string | undefined): Promise<{ rel?: string; file?: string }> {
  if (!url) return {}
  const rel = `thumbs/${id}.webp`
  if (await has(rel)) return { rel, file: abs(rel) }
  try {
    const buf = await httpGet(url)
    const out = await sharp(buf).resize({ height: 256, width: 256, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
    const dest = abs(rel)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest + '.part', out)
    await rename(dest + '.part', dest)
    return { rel, file: dest }
  } catch (e) {
    fail(`thumb ${id}`, e)
    return {}
  }
}

// ───────────────────────────── glTF metadata ─────────────────────────────
async function readGltfJson(rel: string): Promise<GltfJson | null> {
  try {
    const buf = await readFile(abs(rel))
    if (rel.toLowerCase().endsWith('.glb')) {
      if (buf.readUInt32LE(0) !== 0x46546c67) return null
      let off = 12
      while (off + 8 <= buf.length) {
        const len = buf.readUInt32LE(off)
        const type = buf.readUInt32LE(off + 4)
        if (type === 0x4e4f534a) return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
        off += 8 + len + ((4 - (len % 4)) % 4)
      }
      return null
    }
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

async function httpRange(url: string, from: number, to: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${from}-${to}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // a server that ignores Range returns the whole file
  return res.status === 206 ? buf : buf.subarray(from, to + 1)
}

/**
 * glTF JSON of a model that is not downloaded (for its size): a .gltf is small, of a .glb only the
 * JSON chunk is fetched with Range requests. Cached in .cache/gltf so re-runs stay offline.
 */
async function remoteGltfJson(url: string, key: string): Promise<GltfJson | null> {
  const file = path.join(CACHE, 'gltf', `${key}.json`)
  try { return JSON.parse(await readFile(file, 'utf8')) as GltfJson } catch { /* not cached yet */ }
  try {
    let text: string
    if (new URL(url).pathname.toLowerCase().endsWith('.glb')) {
      const head = await httpRange(url, 0, 19)
      if (head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) throw new Error('not a glb')
      const len = head.readUInt32LE(12)
      if (len > 32 * 1024 * 1024) throw new Error('JSON chunk too large')
      text = (await httpRange(url, 20, 19 + len)).toString('utf8')
    } else {
      text = (await httpGet(url)).toString('utf8')
    }
    const json = JSON.parse(text) as GltfJson
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    return json
  } catch (e) {
    fail(`gltf json ${key}`, e)
    return null
  }
}

// ───────────────────────────── ACG metadata ─────────────────────────────
interface AcgMeta { maps: string[]; dimCm: [number, number] | null }
let acgMeta: Record<string, AcgMeta> = {}
async function loadAcgMeta(ids: string[]): Promise<void> {
  const file = path.join(CACHE, 'acg-meta.json')
  try { acgMeta = JSON.parse(await readFile(file, 'utf8')) } catch { acgMeta = {} }
  const missing = ids.filter((i) => !acgMeta[i])
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40)
    try {
      const buf = await httpGet(`https://ambientcg.com/api/v2/full_json?id=${chunk.join(',')}&limit=100&include=mapData,dimensionsData`)
      const json = JSON.parse(buf.toString('utf8')) as { foundAssets?: { assetId: string; maps?: string[]; dimensionX?: number; dimensionY?: number }[] }
      for (const a of json.foundAssets ?? []) {
        acgMeta[a.assetId] = { maps: a.maps ?? [], dimCm: a.dimensionX && a.dimensionY ? [a.dimensionX, a.dimensionY] : null }
      }
    } catch (e) { fail('ambientCG metadata', e) }
  }
  await mkdir(CACHE, { recursive: true })
  await writeFile(file, JSON.stringify(acgMeta))
}

// ───────────────────────────── models ─────────────────────────────
function parseLicence(l: string): { licence: string; author?: string } {
  const m = /^(CC0-1\.0|CC-BY-4\.0)\s*\((.*)\)\s*$/.exec(l)
  if (m) return { licence: m[1] === 'CC0-1.0' ? 'CC0' : m[1], author: m[2] }
  return { licence: l.startsWith('CC0') ? 'CC0' : l }
}
function modelPrefix(id: string): string {
  const p = id.slice(0, id.indexOf(':'))
  return p === 'ph' ? 'ph' : p === 'khr' ? 'khr' : p === 'kaykit' ? 'kk' : p
}

/** applies a manifest `fix` to a downloaded .glb once (a marker next to it records the applied fix) */
async function fixModel(rel: string, fix: MFix): Promise<boolean> {
  const marker = abs(rel) + '.fix.json'
  const want = JSON.stringify(fix)
  try { if ((await readFile(marker, 'utf8')) === want) return true } catch { /* not fixed yet */ }
  try {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    const doc = await io.read(abs(rel))
    if (fix.metalRough) await doc.transform(metalRough())
    if (fix.dropFlat) {
      for (const scene of doc.getRoot().listScenes()) {
        const all = getBounds(scene)
        const size = Math.max(...all.max.map((v, k) => v - all.min[k]))
        for (const node of doc.getRoot().listNodes()) {
          const mesh = node.getMesh()
          if (!mesh) continue
          const verts = mesh.listPrimitives().reduce((n, p) => n + (p.getAttribute('POSITION')?.getCount() ?? 0), 0)
          const b = getBounds(node)
          if (verts <= 64 && b.max[1] - b.min[1] < size * 1e-3) node.setMesh(null)
        }
      }
    }
    if (fix.rotateY) {
      const a = (fix.rotateY * Math.PI) / 360
      for (const scene of doc.getRoot().listScenes()) {
        const pivot = doc.createNode('doplan_front').setRotation([0, Math.sin(a), 0, Math.cos(a)])
        for (const child of scene.listChildren()) {
          scene.removeChild(child)
          pivot.addChild(child)
        }
        scene.addChild(pivot)
      }
    }
    if (fix.maxTexture) await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82, resize: [fix.maxTexture, fix.maxTexture] }))
    await doc.transform(prune())
    await io.write(abs(rel), doc)
    await writeFile(marker, want)
    return true
  } catch (e) {
    fail(`fix ${rel}`, e)
    return false
  }
}

async function processModels(mf: Manifest, assets: Asset[]): Promise<void> {
  let list = mf.models.filter((m) => {
    if (m.zip) { log(`  skip ${m.id}: archive needs offline OBJ/FBX->glTF conversion (not fetched)`); return false }
    return !!(m.gltf || m.url)
  })
  const bundledOf = (m: MModel) => FLAG_ALL || BUNDLE_MODELS.has(m.id) || !!m.fix
  if (LIMIT) list = list.filter(bundledOf).slice(0, LIMIT)
  log(`models: ${list.length} entries, ${list.filter(bundledOf).length} to download`)
  const results: (Asset | undefined)[] = new Array(list.length)
  await pool(list, async (m, idx) => {
    const slug = slugify(rawId(m.id))
    const id = `asset_${modelPrefix(m.id)}_${slug}`
    const mainUrl = (m.gltf ?? m.url) as string
    const mainName = path.posix.basename(new URL(mainUrl).pathname)
    const srcRel = `models/${slug}/${mainName}`
    const fileList: { url: string; path: string }[] = [{ url: mainUrl, path: srcRel }]
    for (const [k, u] of Object.entries(m.files ?? {})) fileList.push({ url: u, path: `models/${slug}/${k}` })
    if (fileList.some((f) => !safeRel(f.path))) { fail(`model ${m.id}`, 'unsafe path in manifest'); return }

    let local = false
    if (bundledOf(m)) {
      const oks = await Promise.all(fileList.map((f) => download(f.url, f.path)))
      local = oks.every(Boolean)
      if (local && m.fix) local = await fixModel(srcRel, m.fix)
      log(`  ${local ? 'ok  ' : 'FAIL'} ${m.id}`)
    }
    const th = await ensureThumb(
      id,
      m.thumb ??
        (m.id.startsWith('ph:')
          ? `https://cdn.polyhaven.com/asset_img/thumbs/${rawId(m.id)}.png?height=256`
          : m.id.startsWith('khr:')
            ? `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${rawId(m.id)}/screenshot/screenshot.jpg`
            : undefined),
    )
    // size of what the app renders: the glTF bounds (first variant of a collection), not the API
    // dimensions, which cover the whole source scene (see sizes.ts)
    const g = m.sizeMm ? null : local ? await readGltfJson(srcRel) : await remoteGltfJson(mainUrl, slugify(m.id))
    const ext = g ? gltfExtents(g) : null
    let size = m.sizeMm ? { w: m.sizeMm[0], d: m.sizeMm[1], h: m.sizeMm[2] } : ext ? sizeFromGltf(ext, m.dimensionsM, UNIT_SCALE[modelPrefix(m.id)] ?? 1) : null
    if (!size && m.dimensionsM) size = { w: Math.round(m.dimensionsM[0] * 1000), d: Math.round(m.dimensionsM[1] * 1000), h: Math.round(m.dimensionsM[2] * 1000) }
    if (!size) {
      const d = DEFAULT_SIZE[m.category] ?? [500, 500, 500]
      size = { w: d[0], d: d[1], h: d[2] }
    }
    if (m.sizeScale) {
      const k = m.sizeScale
      size = { w: Math.round(size.w * k), d: Math.round(size.d * k), h: Math.round(size.h * k) }
    }
    const odd = implausibleSize(m.category, size)
    if (odd) log(`  WARN ${m.id}: implausible size, ${odd} (set sizeScale in the manifest if the model is mis-scaled)`)
    const lic = m.id.startsWith('ph:') ? { licence: 'CC0', author: 'Poly Haven' } : parseLicence(m.licence)
    const cat = ASSET_CAT[m.category] ?? 'other'
    const byCat = mountFor(m.category, m.id, size.h / 1000)
    const mount = m.mount ?? byCat.mount
    const elevation = m.elevation ?? (m.mount ? undefined : byCat.elevation)
    const a: Asset = {
      id,
      name: m.name,
      nameRu: m.nameRu,
      category: cat,
      kind: 'model',
      src: srcRel,
      size,
      mount,
      ...(elevation !== undefined ? { elevation } : {}),
      thumb: th.rel ?? (m.id.startsWith('ph:') ? `https://cdn.polyhaven.com/asset_img/thumbs/${rawId(m.id)}.png?height=256` : undefined),
      tags: [m.category],
      source: m.source.split(' ')[0],
      licence: lic.licence,
      ...(lic.author ? { author: lic.author } : {}),
    }
    if (!local) {
      a.remote = true
      ;(a as Asset & { download: unknown }).download = { files: fileList }
    }
    results[idx] = a
  })
  for (const a of results) if (a) assets.push(a)
}

// ───────────────────────────── materials ─────────────────────────────
const ACG_FILE_SUFFIX = { color: 'Color', normal: 'NormalGL', roughness: 'Roughness', ao: 'AmbientOcclusion', metalness: 'Metalness' } as const
const MAP_FILE = { color: 'color.jpg', normal: 'normal.jpg', roughness: 'roughness.jpg', ao: 'ao.jpg', metalness: 'metalness.jpg' } as const
type MapKey = keyof typeof MAP_FILE

async function processMaterials(mf: Manifest, out: Material[]): Promise<void> {
  const bundledOf = (m: MMaterial) => FLAG_ALL || BUNDLE_MATERIALS.has(m.id)
  let list = mf.materials
  if (LIMIT) list = list.filter(bundledOf).slice(0, LIMIT)
  await loadAcgMeta(list.filter((m) => m.id.startsWith('acg:')).map((m) => rawId(m.id)))
  log(`materials: ${list.length} entries, ${list.filter(bundledOf).length} to download`)
  const results: (Material | undefined)[] = new Array(list.length)
  await pool(list, async (m, idx) => {
    const raw = rawId(m.id)
    const isAcg = m.id.startsWith('acg:')
    const slug = slugify(raw)
    const id = `mat_${isAcg ? 'acg' : 'ph'}_${slug}`
    const dir = `materials/${slug}`
    const cat = matCategory(m)
    const meta = isAcg ? acgMeta[raw] : undefined
    // which maps exist
    const avail: MapKey[] = ['color', 'normal', 'roughness']
    const phUrls: Partial<Record<MapKey, string>> = {}
    if (isAcg) {
      if (!meta || meta.maps.includes('ambient-occlusion')) {
        if (meta) avail.push('ao')
      }
      if (meta?.maps.includes('metalness')) avail.push('metalness')
    } else {
      const mp = m.maps1k ?? {}
      phUrls.color = mp.color; phUrls.normal = mp.normalGL; phUrls.roughness = mp.rough; phUrls.ao = mp.ao
      if (mp.ao) avail.push('ao')
    }
    const relOf = (k: MapKey) => `${dir}/${MAP_FILE[k]}`

    let local = false
    if (bundledOf(m)) {
      if (isAcg) {
        const wantedRel = avail.map(relOf)
        const present = await Promise.all(wantedRel.map(has))
        if (!present.every(Boolean)) {
          try {
            const zbuf = await httpGet(m.zip1k ?? `https://ambientcg.com/get?file=${raw}_1K-JPG.zip`)
            const names: Record<string, MapKey> = {}
            for (const k of avail) names[`${raw}_1K-JPG_${ACG_FILE_SUFFIX[k]}.jpg`] = k
            const files = unzipSync(new Uint8Array(zbuf), { filter: (f) => f.name in names })
            for (const [name, data] of Object.entries(files)) {
              const rel = relOf(names[name])
              const safe = safeRel(rel)
              if (!safe || !data.length) continue
              await mkdir(path.dirname(abs(safe)), { recursive: true })
              await writeFile(abs(safe), data)
            }
          } catch (e) { fail(`zip ${m.id}`, e) }
        }
        // drop maps that turned out missing (e.g. AO listed but absent)
        for (let i = avail.length - 1; i >= 0; i--) if (!(await has(relOf(avail[i]))) && avail[i] !== 'color' && avail[i] !== 'normal') avail.splice(i, 1)
        local = (await has(relOf('color'))) && (await has(relOf('normal')))
      } else {
        const oks = await Promise.all(avail.map((k) => (phUrls[k] ? download(phUrls[k] as string, relOf(k)) : Promise.resolve(false))))
        // optional maps may fail without invalidating the material
        for (let i = avail.length - 1; i >= 0; i--) if (!oks[i] && avail[i] === 'ao') avail.splice(i, 1)
        local = oks[avail.indexOf('color')] && oks[avail.indexOf('normal')]
      }
      log(`  ${local ? 'ok  ' : 'FAIL'} ${m.id}`)
    }

    const th = await ensureThumb(
      id,
      isAcg
        ? `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/${raw}.png`
        : `https://cdn.polyhaven.com/asset_img/thumbs/${raw}.png?height=256`,
    )
    let color = '#b0b0b0'
    if (local) color = await avgColor(abs(relOf('color')))
    else if (th.file) color = await avgColor(th.file)

    const dimM: [number, number] | null = m.realWorldSizeM ?? (meta?.dimCm ? [meta.dimCm[0] / 100, meta.dimCm[1] / 100] : null)
    const sizeMm: [number, number] = dimM ? [Math.round(dimM[0] * 1000), Math.round(dimM[1] * 1000)] : [1000, 1000]
    const maps: Material['maps'] = {}
    if (avail.includes('color')) maps.color = relOf('color')
    if (avail.includes('normal')) maps.normal = relOf('normal')
    if (avail.includes('roughness')) maps.roughness = relOf('roughness')
    if (avail.includes('ao')) maps.ao = relOf('ao')
    if (avail.includes('metalness')) maps.metalness = relOf('metalness')

    const surf = matSurface(cat, raw)
    const mat: Material = {
      id,
      name: m.name,
      nameRu: m.nameRu,
      category: cat,
      color,
      roughness: surf.roughness,
      metalness: surf.metalness,
      maps,
      sizeMm,
      tags: [...new Set([m.category, ...(m.tags ?? [])])],
      source: isAcg ? 'ambientcg' : 'polyhaven',
      licence: 'CC0',
      thumb: th.rel ?? (isAcg ? undefined : `https://cdn.polyhaven.com/asset_img/thumbs/${raw}.png?height=256`),
    }
    if (!local) {
      mat.remote = true
      const dl = isAcg
        ? {
            zip: {
              url: m.zip1k ?? `https://ambientcg.com/get?file=${raw}_1K-JPG.zip`,
              files: Object.fromEntries(avail.map((k) => [`${raw}_1K-JPG_${ACG_FILE_SUFFIX[k]}.jpg`, relOf(k)])),
            },
          }
        : { files: avail.filter((k) => phUrls[k]).map((k) => ({ url: phUrls[k] as string, path: relOf(k) })) }
      ;(mat as Material & { download: unknown }).download = dl
    }
    results[idx] = mat
  })
  for (const r of results) if (r) out.push(r)
}

// ───────────────────────────── hdris ─────────────────────────────
async function processHdris(mf: Manifest, out: Hdri[]): Promise<void> {
  const bundledOf = (h: MHdri) => FLAG_ALL || BUNDLE_HDRIS.has(h.id)
  let list = mf.hdris
  if (LIMIT) list = list.filter(bundledOf).slice(0, LIMIT)
  log(`hdris: ${list.length} entries, ${list.filter(bundledOf).length} to download`)
  const results: (Hdri | undefined)[] = new Array(list.length)
  await pool(list, async (h, idx) => {
    const raw = rawId(h.id)
    const id = `hdri_ph_${slugify(raw)}`
    const rel = `hdris/${raw}_1k.hdr`
    let local = false
    if (bundledOf(h)) {
      local = await download(h.hdr1k, rel)
      log(`  ${local ? 'ok  ' : 'FAIL'} ${h.id}`)
    }
    const th = await ensureThumb(id, `https://cdn.polyhaven.com/asset_img/thumbs/${raw}.png?height=256`)
    const e: Hdri & { download?: unknown; remote?: boolean; tags?: string[] } = {
      id, name: h.name, src: rel, kind: h.kind,
      thumb: th.rel ?? `https://cdn.polyhaven.com/asset_img/thumbs/${raw}.png?height=256`,
      source: 'polyhaven', licence: 'CC0', tags: h.tags,
    }
    if (!local) {
      e.remote = true
      e.download = { files: [{ url: h.hdr1k, path: rel }] }
    }
    results[idx] = e
  })
  for (const r of results) if (r) out.push(r)
}

// ───────────────────────────── licences ─────────────────────────────
const LICENSES_MD = `# Asset licences and credits

Everything under \`resources/assets\` (and everything downloadable on demand through \`catalog.json\`) is CC0 or CC-BY.
Machine-readable per-entry licence/author fields are in \`catalog.json\`.

## Poly Haven (https://polyhaven.com)
- Models, PBR textures and HDRIs. Licence: **CC0 1.0** (public domain). No attribution required.
- Credit anyway (good practice, and required by the Poly Haven API terms when browsing the live API): "Powered by Poly Haven".
- Files are fetched with a unique User-Agent (\`doplan-asset-fetcher/0.1\`) as the API terms ask.

## ambientCG (https://ambientcg.com)
- PBR materials (1K-JPG sets: Color, NormalGL, Roughness, AmbientOcclusion, Metalness). Licence: **CC0 1.0**.
- No attribution required; credit: "Textures from ambientCG.com (CC0)".

## Khronos glTF-Sample-Assets (https://github.com/KhronosGroup/glTF-Sample-Assets)
- Per-model licences. The script only accepts CC0 and CC-BY-4.0.
- **CC0** (bundled): SheenChair, GlassVaseFlowers.
- **CC-BY-4.0** (on-demand only, attribution REQUIRED when downloaded and used; author is stored in the catalog \`author\` field):
  GlamVelvetSofa, SheenWoodLeatherSofa, ChairDamaskPurplegold, CommercialRefrigerator, AnisotropyBarnLamp,
  IridescenceLamp, GlassHurricaneCandleHolder, DiffuseTransmissionPlant, LightsPunctualLamp.
  The app must list them in its credits screen with owner and artist (see \`author\`).

## KayKit Furniture Bits (https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0)
- Licence: **CC0 1.0**. Stylised low-poly, on-demand only.

## Sketchfab (https://sketchfab.com), via the Objaverse mirror (https://huggingface.co/datasets/allenai/objaverse)
- Furniture, lamps, plants, bathroom fittings and appliances. Licence: **CC-BY-4.0** for every entry (checked against the
  Sketchfab API). Attribution REQUIRED: the list below is generated from the catalog, and the app shows the author, source
  and licence of each model in the catalog card and the item inspector («Источник»).
- Most of them are on-demand downloads. Models that needed a repair (front turned to +Z, ground planes removed,
  spec/gloss materials converted, textures cut to 1K) are bundled in their repaired form; the change is listed as
  "modified" below, as CC-BY asks.

@@SKETCHFAB@@

## Not fetched by the script
- Quaternius "Ultimate House Interior Pack" and Kenney "Furniture Pack" (CC0, OpenGameArt) are listed in the manifest
  but need an offline OBJ/FBX to glTF conversion, so they are not part of the catalog.
`

function licensesMd(assets: Asset[], mf: Manifest): string {
  const fixed = new Set(mf.models.filter((m) => m.fix).map((m) => `asset_${modelPrefix(m.id)}_${slugify(rawId(m.id))}`))
  const rows = assets
    .filter((a) => a.source?.includes('sketchfab.com'))
    .sort((a, b) => (a.nameRu ?? a.name).localeCompare(b.nameRu ?? b.name, 'ru'))
    .map((a) => `- ${a.nameRu ?? a.name}: "${a.name}" by ${a.author ?? 'unknown'}, ${a.source}, ${a.licence}${fixed.has(a.id) ? ' (modified: repaired for doplan)' : ''}`)
  return LICENSES_MD.replace('@@SKETCHFAB@@', rows.join('\n') || '- (none)')
}

// ───────────────────────────── main ─────────────────────────────
async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const mf = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')) as Manifest
  const catalogPath = path.join(OUT, 'catalog.json')
  const partial = !!(ONLY || LIMIT)
  let prev: Catalog | null = null
  if (partial && existsSync(catalogPath)) {
    try { prev = JSON.parse(await readFile(catalogPath, 'utf8')) as Catalog } catch { prev = null }
  }
  const assets: Asset[] = []
  const materials: Material[] = []
  const hdris: Hdri[] = []
  if (want('models')) await processModels(mf, assets)
  if (want('materials')) await processMaterials(mf, materials)
  if (want('hdris')) await processHdris(mf, hdris)

  const catalog: Catalog = {
    version: 1,
    materials: want('materials') ? materials : prev?.materials ?? [],
    assets: want('models') ? assets : prev?.assets ?? [],
    hdris: want('hdris') ? hdris : prev?.hdris ?? [],
  }
  // partial run with --limit: keep previous entries that were not touched
  if (LIMIT && prev) {
    const merge = <T extends { id: string }>(old: T[], now: T[]) => {
      const ids = new Set(now.map((x) => x.id))
      return [...old.filter((x) => !ids.has(x.id)), ...now]
    }
    catalog.materials = merge(prev.materials, materials)
    catalog.assets = merge(prev.assets, assets)
    catalog.hdris = merge(prev.hdris, hdris)
  }
  await writeFile(catalogPath, JSON.stringify(catalog, null, 1))
  await writeFile(path.join(OUT, 'LICENSES.md'), licensesMd(catalog.assets, mf))

  // verification
  const missing: string[] = []
  const check = async (rel?: string) => {
    if (!rel || /^https?:/.test(rel)) return
    if (!(await has(rel))) missing.push(rel)
  }
  for (const m of catalog.materials) {
    if (!m.remote) for (const v of Object.values(m.maps ?? {})) await check(v)
    await check(m.thumb)
  }
  for (const a of catalog.assets) {
    if (!a.remote) await check(a.src)
    await check(a.thumb)
  }
  for (const h of catalog.hdris) {
    if (!(h as { remote?: boolean }).remote) await check(h.src)
    await check(h.thumb)
  }
  // total size
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    const { readdir } = await import('node:fs/promises')
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else total += await sizeOf(p)
    }
  }
  await walk(OUT)
  // stray .part files from interrupted runs
  void rm

  const loc = (xs: { remote?: boolean }[]) => xs.filter((x) => !x.remote).length
  log('\n=== summary ===')
  log(`materials: ${catalog.materials.length} (local ${loc(catalog.materials)}, remote ${catalog.materials.length - loc(catalog.materials)})`)
  log(`assets:    ${catalog.assets.length} (local ${loc(catalog.assets)}, remote ${catalog.assets.length - loc(catalog.assets)})`)
  log(`hdris:     ${catalog.hdris.length} (local ${loc(catalog.hdris as { remote?: boolean }[])}, remote ${catalog.hdris.length - loc(catalog.hdris as { remote?: boolean }[])})`)
  log(`total size: ${(total / 1024 / 1024).toFixed(1)} MB`)
  log(`missing local paths: ${missing.length}`)
  for (const m of missing) log('  MISSING ' + m)
  log(`failures: ${failures.length}`)
  for (const f of failures) log('  - ' + f)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
