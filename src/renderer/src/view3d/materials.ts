/**
 * MaterialLibrary: document / catalog Material entries → cached MeshPhysicalMaterial instances.
 *
 *  - real-world UVs: every surface carries UVs in metres, texture repeat = 1000 / sizeMm
 *  - colour / normal / roughness / metalness / ao / ARM maps with the right colour spaces
 *  - transmission, ior, sheen, clearcoat, emissive
 *  - TilePattern → baked periodic canvas texture set (see patterns.ts)
 *  - cache keyed by material content + finish; unused entries are swept and their textures released
 *
 * Only standard physical-material properties and plain textures are used, so the same materials
 * feed the rasteriser, the path tracer and the GLB exporter.
 */
import * as THREE from 'three'
import type { Id, Material, SurfaceFinish, TilePattern } from '@core/types'
import type { EngineContext, MaterialLibrary } from '@/contracts'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { currentQuality } from './quality'
import {
  type PatternCanvases,
  type PatternLayout,
  type PatternSource,
  createPatternCanvases,
  layoutPattern,
  paintPattern,
  roughnessFromArm,
} from './patterns'
import { type SharedImage, type TexImage, TextureStore, applyTextureParams, makeTexture } from './textures'

export interface PlainSpec {
  color: string
  roughness?: number
  metalness?: number
  emissive?: string
  emissiveIntensity?: number
  opacity?: number
  transmission?: number
  clearcoat?: number
  doubleSided?: boolean
}

/** extension of the contract used inside view3d (architecture builders, items, thumbnails) */
export interface MaterialLibraryEx extends MaterialLibrary {
  /** simple cached colour material (hardware, cut faces, LED strips …) */
  plain(spec: PlainSpec): THREE.Material
  /** like get(), with Material fields overridden (e.g. glossy stretch ceiling) */
  variant(finish: SurfaceFinish | Id, overrides: Partial<Material>, opts?: { doubleSided?: boolean }): THREE.Material
  /** material for a definition that is not (yet) in the document or catalog */
  fromDefinition(def: Material, opts?: { doubleSided?: boolean; pattern?: TilePattern; tint?: string }): THREE.Material
  /** definition lookup: project-local first, then catalog, then a neutral fallback */
  resolve(id: Id): Material
  /** cached tinted copy of a foreign (glTF) material */
  tinted(source: THREE.Material, tint: string): THREE.Material
  /** marks materials reachable from `roots` as alive and disposes entries unused for a while */
  collect(roots: THREE.Object3D[]): void
  /** resolves when all requested textures are decoded and applied */
  whenIdle(timeoutMs?: number): Promise<void>
  /** bumped whenever cached materials became stale (quality tier change) */
  readonly epoch: number
  /** drops every cached material (device loss, quality tier change) */
  reset(): void
  /** re-reads the quality preset; returns true when cached materials were invalidated */
  syncQuality(): boolean
}

interface Entry {
  key: string
  material: THREE.MeshPhysicalMaterial
  images: SharedImage[]
  textures: THREE.Texture[]
  lastSeen: number
  disposed: boolean
}

const FALLBACK: Material = {
  id: 'mat_fallback',
  name: 'Fallback',
  category: 'other',
  color: '#bdbdbd',
  roughness: 0.8,
  metalness: 0,
}

const defJson = new WeakMap<object, string>()
function jsonOf(def: Material): string {
  let s = defJson.get(def)
  if (s === undefined) {
    s = JSON.stringify(def)
    defJson.set(def, s)
  }
  return s
}

function safeColor(hex: string | undefined, fallback = '#ffffff'): THREE.Color {
  const c = new THREE.Color()
  try {
    c.set(hex && /^#[0-9a-fA-F]{3,8}$/.test(hex) ? hex.slice(0, 7) : fallback)
  } catch {
    c.set(fallback)
  }
  return c
}

export function createMaterialLibrary(ctx: EngineContext): MaterialLibrary {
  const store = new TextureStore()
  const entries = new Map<string, Entry>()
  const quick = new Map<string, { def: Material; entry: Entry }>()
  const tintCache = new Map<string, THREE.Material>()
  let generation = 0
  let epoch = 0
  let tier = ''
  let pendingApply = 0
  let idleWaiters: (() => void)[] = []

  const settle = (): void => {
    pendingApply = Math.max(0, pendingApply - 1)
    if (pendingApply === 0 && idleWaiters.length) {
      const w = idleWaiters
      idleWaiters = []
      for (const fn of w) fn()
    }
  }

  const syncTier = (): boolean => {
    const q = currentQuality(ctx)
    const t = `${q.preset === 'low' ? 'lowglass' : 'pbr'}|${q.maxTextureSize}`
    if (t === tier) return false
    const first = tier === ''
    tier = t
    store.maxSize = q.maxTextureSize
    if (!first) {
      lib.reset()
      epoch++
    }
    return !first
  }

  const resolve = (id: Id): Material => {
    const ui = uiStore.getState()
    return ui.getMaterial(id) ?? docStore.getState().doc.materials[id] ?? { ...FALLBACK, id }
  }

  const disposeEntry = (e: Entry): void => {
    if (e.disposed) return
    e.disposed = true
    for (const t of e.textures) t.dispose()
    for (const img of e.images) store.release(img)
    e.material.dispose()
    entries.delete(e.key)
  }

  const create = (
    key: string,
    def: Material,
    pattern: TilePattern | undefined,
    tint: string | undefined,
    doubleSided: boolean,
  ): Entry => {
    const q = currentQuality(ctx)
    const anisotropy = Math.max(1, Math.min(q.anisotropy, ctx.renderer?.getMaxAnisotropy?.() ?? 8))
    const m = new THREE.MeshPhysicalMaterial()
    const entry: Entry = { key, material: m, images: [], textures: [], lastSeen: generation, disposed: false }
    m.name = def.id
    m.userData.libKey = key
    m.userData.materialId = def.id
    const tintColor = tint ? safeColor(tint) : null
    const baseColor = safeColor(def.color, '#bdbdbd')
    const setColor = (c: THREE.Color): void => {
      m.color.copy(c)
      if (tintColor) m.color.multiply(tintColor)
    }
    setColor(baseColor)
    m.roughness = THREE.MathUtils.clamp(def.roughness ?? 0.8, 0.02, 1)
    m.metalness = THREE.MathUtils.clamp(def.metalness ?? 0, 0, 1)
    m.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide
    m.normalScale.setScalar(def.normalScale ?? 1)

    const transmission = THREE.MathUtils.clamp(def.transmission ?? 0, 0, 1)
    if (transmission > 0) {
      if (q.preset === 'low') {
        // cheap glass for integrated GPUs: no transmission pass
        m.transparent = true
        m.opacity = THREE.MathUtils.clamp(1 - 0.82 * transmission, 0.12, 1)
        m.depthWrite = false
      } else {
        m.transmission = transmission
        m.thickness = 0
      }
      m.ior = def.ior ?? 1.5
    }
    if (def.ior !== undefined) m.ior = THREE.MathUtils.clamp(def.ior, 1, 2.333)
    if (def.opacity !== undefined && def.opacity < 1) {
      m.transparent = true
      m.opacity = Math.min(m.opacity, Math.max(0.02, def.opacity))
      m.depthWrite = false
    }
    if (def.sheen) {
      m.sheen = THREE.MathUtils.clamp(def.sheen, 0, 1)
      m.sheenRoughness = 0.5
      m.sheenColor.copy(baseColor).lerp(new THREE.Color('#ffffff'), 0.5)
    }
    if (def.clearcoat) {
      m.clearcoat = THREE.MathUtils.clamp(def.clearcoat, 0, 1)
      m.clearcoatRoughness = 0.08
    }
    if (def.emissive) {
      m.emissive.copy(safeColor(def.emissive, '#000000'))
      m.emissiveIntensity = def.emissiveIntensity ?? 1
    }

    const maps = def.remote ? undefined : def.maps
    const sizeMm: [number, number] = [
      Math.max(1, def.sizeMm?.[0] ?? 1000),
      Math.max(1, def.sizeMm?.[1] ?? def.sizeMm?.[0] ?? 1000),
    ]
    // Catalog entries carry the average texture colour in `color` (used as a swatch); multiplying
    // it with the colour map would darken the texture, so only user-made materials tint their map.
    const mapTint = def.custom ? baseColor : new THREE.Color('#ffffff')

    const acquire = (src: string | undefined): SharedImage | null => {
      if (!src) return null
      const img = store.acquire(src)
      entry.images.push(img)
      return img
    }
    const changed = (): void => {
      m.needsUpdate = true
      ctx.invalidate()
    }

    if (pattern && pattern.type !== 'none') {
      // ── baked laying pattern ──
      const layout: PatternLayout = layoutPattern(pattern, Math.min(2048, q.maxTextureSize))
      const canvases: PatternCanvases = createPatternCanvases(layout)
      const rotation = THREE.MathUtils.degToRad((pattern.rotation || 0) + layout.extraRotation)
      const repeat: [number, number] = [1000 / layout.periodMm[0], 1000 / layout.periodMm[1]]
      const mk = (canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
        const t = new THREE.CanvasTexture(canvas)
        applyTextureParams(t, { srgb, repeat, rotation, anisotropy })
        // layout origin shift (mm along the surface) → texture offset in periods
        if (pattern.offsetX || pattern.offsetY) t.offset.set(-(pattern.offsetX ?? 0) / layout.periodMm[0], -(pattern.offsetY ?? 0) / layout.periodMm[1])
        entry.textures.push(t)
        return t
      }
      const albedo = mk(canvases.albedo, true)
      const normal = mk(canvases.normal, false)
      const rough = mk(canvases.roughness, false)
      const cImg = acquire(maps?.color)
      const nImg = acquire(maps?.normal)
      const rImg = acquire(maps?.roughness)
      const armImg = !rImg ? acquire(maps?.arm) : null
      const asSrc = (s: SharedImage | null): PatternSource | null =>
        s && s.image ? { image: s.image as PatternSource['image'], flipped: s.flipped } : null
      const paint = (): void => {
        if (entry.disposed) return
        let roughSrc = asSrc(rImg)
        if (!roughSrc && armImg?.image) roughSrc = roughnessFromArm(asSrc(armImg) as PatternSource)
        try {
          paintPattern(layout, canvases, {
            pattern,
            color: cImg?.image && !def.custom ? '#ffffff' : def.color,
            roughness: m.userData.baseRoughness as number,
            sizeMm,
            colorSrc: asSrc(cImg),
            normalSrc: asSrc(nImg),
            roughSrc,
          })
        } catch (err) {
          console.warn('[doplan] pattern paint failed', err)
        }
        albedo.needsUpdate = true
        normal.needsUpdate = true
        rough.needsUpdate = true
      }
      m.userData.baseRoughness = m.roughness
      paint()
      // the pattern carries the colour; the material colour is only the finish tint
      m.color.set('#ffffff')
      if (tintColor) m.color.multiply(tintColor)
      m.map = albedo
      m.normalMap = normal
      m.roughnessMap = rough
      m.roughness = 1
      const waits = [cImg, nImg, rImg, armImg].filter((s): s is SharedImage => !!s && !s.image)
      if (waits.length) {
        pendingApply++
        Promise.all(waits.map((s) => s.ready)).then(() => {
          paint()
          changed()
          settle()
        })
      }
    } else if (maps) {
      // ── plain textured material ──
      const repeat: [number, number] = [1000 / sizeMm[0], 1000 / sizeMm[1]]
      const bind = (src: string | undefined, srgb: boolean, apply: (t: THREE.Texture) => void): void => {
        const shared = acquire(src)
        if (!shared) return
        const use = (img: TexImage | null): void => {
          if (!img || entry.disposed) return
          const t = makeTexture(img, shared.flipped, { srgb, repeat, anisotropy })
          entry.textures.push(t)
          apply(t)
          changed()
        }
        if (shared.image) use(shared.image)
        else {
          pendingApply++
          shared.ready.then((img) => {
            use(img)
            settle()
          })
        }
      }
      bind(maps.color, true, (t) => {
        m.map = t
        setColor(mapTint)
      })
      bind(maps.normal, false, (t) => {
        m.normalMap = t
      })
      if (maps.arm && !(maps.roughness && maps.ao)) {
        bind(maps.arm, false, (t) => {
          m.aoMap = t
          m.roughnessMap = t
          m.roughness = 1
          if (def.metalness > 0 || def.category === 'metal') {
            m.metalnessMap = t
            m.metalness = 1
          }
        })
      } else {
        bind(maps.roughness, false, (t) => {
          m.roughnessMap = t
          m.roughness = 1
        })
        bind(maps.ao, false, (t) => {
          m.aoMap = t
        })
      }
      bind(maps.metalness, false, (t) => {
        m.metalnessMap = t
        m.metalness = 1
      })
    }
    entries.set(key, entry)
    return entry
  }

  const obtain = (
    def: Material,
    pattern: TilePattern | undefined,
    tint: string | undefined,
    doubleSided: boolean,
    quickKey: string | null,
  ): THREE.Material => {
    syncTier()
    if (quickKey) {
      const hit = quick.get(quickKey)
      if (hit && hit.def === def && !hit.entry.disposed) {
        hit.entry.lastSeen = generation
        return hit.entry.material
      }
    }
    const key = `${jsonOf(def)}|${pattern && pattern.type !== 'none' ? JSON.stringify(pattern) : ''}|${tint ?? ''}|${doubleSided ? 2 : 1}`
    let entry = entries.get(key)
    if (!entry || entry.disposed) entry = create(key, def, pattern, tint, doubleSided)
    entry.lastSeen = generation
    if (quickKey) quick.set(quickKey, { def, entry })
    return entry.material
  }

  const lib: MaterialLibraryEx = {
    get(finish, opts) {
      const f: SurfaceFinish = typeof finish === 'string' ? { materialId: finish } : finish
      const def = resolve(f.materialId)
      // a material may suggest its own laying pattern (e.g. subway tile); an explicit finish pattern wins
      const pattern = f.pattern ?? def.pattern
      const ds = !!opts?.doubleSided
      const qk = `${f.materialId}|${f.tint ?? ''}|${ds ? 2 : 1}|${f.pattern ? JSON.stringify(f.pattern) : ''}`
      return obtain(def, pattern, f.tint, ds, qk)
    },
    getForItem(materialId, tint) {
      const def = resolve(materialId)
      return obtain(def, undefined, tint, false, `item|${materialId}|${tint ?? ''}`)
    },
    variant(finish, overrides, opts) {
      const f: SurfaceFinish = typeof finish === 'string' ? { materialId: finish } : finish
      const base = resolve(f.materialId)
      const def: Material = { ...base, ...overrides }
      return obtain(def, f.pattern ?? base.pattern, f.tint, !!opts?.doubleSided, null)
    },
    fromDefinition(def, opts) {
      return obtain(def, opts?.pattern ?? def.pattern, opts?.tint, !!opts?.doubleSided, null)
    },
    plain(spec) {
      const def: Material = {
        id: `plain_${spec.color}`,
        name: 'plain',
        category: 'other',
        color: spec.color,
        roughness: spec.roughness ?? 0.6,
        metalness: spec.metalness ?? 0,
        emissive: spec.emissive,
        emissiveIntensity: spec.emissiveIntensity,
        opacity: spec.opacity,
        transmission: spec.transmission,
        clearcoat: spec.clearcoat,
      }
      return obtain(def, undefined, undefined, !!spec.doubleSided, null)
    },
    resolve,
    tinted(source, tint) {
      const key = `${source.uuid}|${tint}`
      let m = tintCache.get(key)
      if (!m) {
        m = source.clone()
        const c = (m as THREE.MeshStandardMaterial).color
        if (c && c.isColor) c.multiply(safeColor(tint))
        m.userData.tintOf = source.uuid
        tintCache.set(key, m)
      }
      return m
    },
    collect(roots) {
      generation++
      const alive = new Set<THREE.Material>()
      for (const root of roots) {
        root.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
          if (!mat) return
          if (Array.isArray(mat)) for (const m of mat) alive.add(m)
          else alive.add(mat)
        })
      }
      for (const e of Array.from(entries.values())) {
        if (alive.has(e.material)) e.lastSeen = generation
        else if (generation - e.lastSeen > 3) disposeEntry(e)
      }
      for (const [k, v] of Array.from(quick.entries())) if (v.entry.disposed) quick.delete(k)
      for (const [k, m] of Array.from(tintCache.entries())) {
        if (!alive.has(m)) {
          const seen = (m.userData.unusedFor as number | undefined) ?? 0
          if (seen > 3) {
            m.dispose()
            tintCache.delete(k)
          } else m.userData.unusedFor = seen + 1
        } else m.userData.unusedFor = 0
      }
    },
    whenIdle(timeoutMs = 6000) {
      if (pendingApply === 0 && store.loading === 0) return Promise.resolve()
      return new Promise<void>((done) => {
        const timer = setTimeout(done, timeoutMs)
        const check = (): void => {
          if (pendingApply === 0 && store.loading === 0) {
            clearTimeout(timer)
            done()
          } else idleWaiters.push(check)
        }
        store.whenIdle(timeoutMs).then(check)
      })
    },
    get epoch() {
      return epoch
    },
    syncQuality() {
      return syncTier()
    },
    reset() {
      for (const e of Array.from(entries.values())) disposeEntry(e)
      entries.clear()
      quick.clear()
      for (const m of tintCache.values()) m.dispose()
      tintCache.clear()
    },
    dispose() {
      lib.reset()
      store.dispose()
    },
  }
  return lib
}
