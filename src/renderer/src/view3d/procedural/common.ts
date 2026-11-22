/**
 * Shared building blocks for procedural assets: geometry cache, metre-based UVs,
 * material slot resolution with builtin fallbacks, parameter access and primitive helpers.
 *
 * Local frame of every generator: metres, Y-up, origin at the footprint centre on the floor,
 * +Z = front. The factory (index.ts) fits the result exactly into item.size afterwards.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { BUILTIN_MATERIALS } from '@core'
import type { Asset, Id, Item, Material, MaterialCategory } from '@core/types'
import type { MaterialLibrary } from '@/contracts'

export type V3 = [number, number, number]

// ───────────────────────────── geometry cache ─────────────────────────────

const MAX_CACHE = 1500
const geoCache = new Map<string, THREE.BufferGeometry>()

/** round metres to 0.1 mm for cache keys */
export function q(v: number): number {
  return Math.round(v * 10000)
}

export function gkey(name: string, ...nums: (number | string | boolean)[]): string {
  return name + ':' + nums.map((n) => (typeof n === 'number' ? q(n) : String(n))).join(',')
}

/**
 * Returns a shared geometry for `key`, building it once. Shared geometries are flagged with
 * `userData.shared = true`; callers that dispose item meshes should skip those (disposing is
 * harmless anyway: renderers re-upload on next use).
 */
export function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = geoCache.get(key)
  if (hit) {
    geoCache.delete(key)
    geoCache.set(key, hit)
    return hit
  }
  const g = make()
  g.userData.shared = true
  g.userData.cacheKey = key
  if (!g.boundingBox) g.computeBoundingBox()
  if (!g.boundingSphere) g.computeBoundingSphere()
  geoCache.set(key, g)
  if (geoCache.size > MAX_CACHE) {
    const oldest = geoCache.keys().next().value
    if (oldest !== undefined) geoCache.delete(oldest)
  }
  return g
}

export function clearGeometryCache(): void {
  for (const g of geoCache.values()) g.dispose()
  geoCache.clear()
}

export function geometryCacheSize(): number {
  return geoCache.size
}

// ───────────────────────────── UVs & geometry utilities ─────────────────────────────

/**
 * Box (tri-planar) projection: 1 UV unit = 1 metre, matching MaterialLibrary's real-world UV
 * convention. Works for any geometry; uses the dominant normal axis per vertex.
 */
export function boxUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const ax = Math.abs(nrm.getX(i))
    const ay = Math.abs(nrm.getY(i))
    const az = Math.abs(nrm.getZ(i))
    let u: number
    let v: number
    if (ax >= ay && ax >= az) {
      u = nrm.getX(i) >= 0 ? -z : z
      v = y
    } else if (ay >= az) {
      u = x
      v = nrm.getY(i) >= 0 ? -z : z
    } else {
      u = nrm.getZ(i) >= 0 ? x : -x
      v = y
    }
    uv[i * 2] = u
    uv[i * 2 + 1] = v
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** strips attributes to position only, welds vertices and recomputes smooth normals */
export function smooth(g: THREE.BufferGeometry, tolerance = 1e-5): THREE.BufferGeometry {
  const clean = new THREE.BufferGeometry()
  clean.setAttribute('position', g.getAttribute('position').clone())
  if (g.index) clean.setIndex(g.index.clone())
  g.dispose()
  const welded = mergeVertices(clean, tolerance)
  clean.dispose()
  welded.computeVertexNormals()
  return welded
}

/** keep only position/normal/uv so geometries can be merged */
export function normalizeAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  if (!g.getAttribute('uv')) boxUV(g)
  return g
}

/** merges geometries (each optionally transformed); result is non-grouped */
export function merge(parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = []
  for (const p of parts) {
    let c = p.g.clone()
    normalizeAttrs(c)
    if (c.index) {
      const ni = c.toNonIndexed()
      c.dispose()
      c = ni
    }
    if (p.m) c.applyMatrix4(p.m)
    list.push(c)
  }
  const merged = list.length === 1 ? list[0] : mergeGeometries(list, false)
  if (list.length > 1) for (const c of list) c.dispose()
  if (!merged) throw new Error('procedural: geometry merge failed')
  return merged
}

export function mat4(pos: V3, rot?: V3, scl?: V3): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  const qt = new THREE.Quaternion()
  if (rot) qt.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]))
  m.compose(new THREE.Vector3(...pos), qt, new THREE.Vector3(...(scl ?? [1, 1, 1])))
  return m
}

/** appends a reversed copy so a sheet is visible from both sides with a single-sided material */
export function doubleSide(g: THREE.BufferGeometry, offset = 0.0004): THREE.BufferGeometry {
  const a = g.index ? g.toNonIndexed() : g.clone()
  normalizeAttrs(a)
  const b = a.clone()
  const pos = b.getAttribute('position')
  const nrm = b.getAttribute('normal')
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) - nrm.getX(i) * offset,
      pos.getY(i) - nrm.getY(i) * offset,
      pos.getZ(i) - nrm.getZ(i) * offset,
    )
    nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i))
  }
  // flip winding
  for (let i = 0; i < pos.count; i += 3) {
    for (const attr of [pos, nrm, b.getAttribute('uv')]) {
      const s = attr.itemSize
      for (let k = 0; k < s; k++) {
        const t = attr.getComponent(i + 1, k)
        attr.setComponent(i + 1, k, attr.getComponent(i + 2, k))
        attr.setComponent(i + 2, k, t)
      }
    }
  }
  const out = mergeGeometries([a, b], false)
  a.dispose()
  b.dispose()
  if (!out) throw new Error('procedural: doubleSide merge failed')
  return out
}

// ───────────────────────────── seeded random ─────────────────────────────

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v))
}

// ───────────────────────────── material fallbacks ─────────────────────────────

export interface MatFallback {
  /** preferred builtin ids, first existing wins */
  ids: Id[]
  /** categories searched when none of the ids exist */
  cats: MaterialCategory[]
  /** wanted base colour */
  color: string
  metal?: boolean
  glass?: boolean
}

function fb(ids: Id[], cats: MaterialCategory[], color: string, extra?: { metal?: boolean; glass?: boolean }): MatFallback {
  return { ids, cats, color, ...extra }
}

/** Fallback material intents. ids follow the `mat_*` builtin convention of core/defaults.ts. */
export const F = {
  white: fb(['mat_wood_white', 'mat_plastic_white', 'mat_paint_white'], ['wood', 'paint', 'plastic'], '#f0efeb'),
  whiteGloss: fb(['mat_plastic_white', 'mat_metal_white', 'mat_wood_white'], ['plastic', 'paint'], '#f6f6f4'),
  whitePaint: fb(['mat_paint_white', 'mat_wood_white'], ['paint'], '#f2f1ed'),
  grey: fb(['mat_plastic_grey', 'mat_paint_grey', 'mat_paint_light_grey'], ['plastic', 'paint'], '#8a8b8c'),
  anthracite: fb(['mat_paint_anthracite', 'mat_paint_graphite', 'mat_plastic_black'], ['paint', 'plastic', 'metal'], '#3a3c3e'),
  oak: fb(['mat_wood_oak_natural', 'mat_wood_oak_bleached', 'mat_parquet_oak'], ['wood', 'parquet', 'laminate'], '#b98d5e'),
  walnut: fb(['mat_wood_walnut', 'mat_wood_wenge', 'mat_parquet_walnut'], ['wood', 'parquet'], '#5e4130'),
  steel: fb(['mat_metal_steel', 'mat_metal_aluminium'], ['metal'], '#b9bcbe', { metal: true }),
  chrome: fb(['mat_metal_chrome', 'mat_metal_steel'], ['metal'], '#dcdcdc', { metal: true }),
  aluminium: fb(['mat_metal_aluminium', 'mat_metal_steel'], ['metal'], '#c5c7c9', { metal: true }),
  blackMetal: fb(['mat_metal_black', 'mat_plastic_black'], ['metal', 'plastic', 'paint'], '#1e1e20', { metal: true }),
  blackMatte: fb(['mat_plastic_black', 'mat_paint_black', 'mat_metal_black'], ['plastic', 'paint'], '#1b1b1c'),
  rubber: fb(['mat_other_rubber_black', 'mat_plastic_black'], ['plastic', 'other'], '#2b2c2d'),
  blackGlass: fb(['mat_glass_black', 'mat_glass_tinted', 'mat_plastic_black'], ['glass', 'plastic'], '#0a0a0b'),
  glass: fb(['mat_glass_clear'], ['glass'], '#e9f1f1', { glass: true }),
  frosted: fb(['mat_glass_frosted', 'mat_glass_clear'], ['glass'], '#e4eaea', { glass: true }),
  mirror: fb(['mat_glass_mirror', 'mat_metal_chrome'], ['glass', 'metal'], '#e6e6e6', { metal: true }),
  screen: fb(['mat_glass_black', 'mat_plastic_black'], ['glass', 'plastic'], '#050506'),
  ceramic: fb(['mat_other_ceramic_white', 'mat_plastic_acrylic_white', 'mat_tile_white_gloss'], ['other', 'tile', 'plastic'], '#f7f7f5'),
  acrylic: fb(['mat_plastic_acrylic_white', 'mat_other_ceramic_white'], ['plastic', 'other'], '#f7f7f5'),
  stone: fb(['mat_stone_quartz_white', 'mat_marble_white', 'mat_stone_grey'], ['stone', 'marble'], '#e8e5df'),
  fabric: fb(['mat_fabric_grey', 'mat_fabric_graphite'], ['fabric'], '#8f8d89'),
  fabricBeige: fb(['mat_fabric_linen_beige', 'mat_fabric_grey'], ['fabric'], '#c9bba4'),
  linen: fb(['mat_fabric_white', 'mat_fabric_linen_beige'], ['fabric'], '#eeebe5'),
  blanket: fb(['mat_fabric_grey', 'mat_fabric_linen_beige'], ['fabric', 'carpet'], '#b9b2a6'),
  rug: fb(['mat_carpet_beige', 'mat_carpet_grey'], ['carpet', 'fabric'], '#b8ab97'),
  leather: fb(['mat_leather_brown', 'mat_leather_cognac'], ['leather', 'fabric'], '#6b4a33'),
  plaster: fb(['mat_paint_white', 'mat_plaster_white'], ['paint', 'plaster'], '#efede8'),
  concrete: fb(['mat_concrete_light', 'mat_concrete_dark'], ['concrete', 'stone'], '#a3a19c'),
  canvas: fb(['mat_paint_sage', 'mat_fabric_linen_beige'], ['paint', 'fabric'], '#d8cdb9'),
  leaf: fb(['mat_other_foliage'], ['other', 'paint', 'plastic', 'fabric'], '#3d6a33'),
  stem: fb(['mat_wood_walnut', 'mat_wood_wenge'], ['wood', 'other'], '#5a4632'),
  soil: fb(['mat_other_soil'], ['other', 'outdoor', 'stone', 'concrete'], '#3a2b20'),
  terracotta: fb(['mat_other_ceramic_white', 'mat_paint_terracotta', 'mat_tile_terracotta'], ['other', 'tile', 'paint'], '#f2f0eb'),
  curtainRail: fb(['mat_metal_black', 'mat_metal_steel', 'mat_metal_aluminium'], ['metal'], '#2a2a2b', { metal: true }),
  curtain: fb(['mat_fabric_linen_beige', 'mat_fabric_grey'], ['fabric'], '#bfb3a0'),
  sheer: fb(['mat_fabric_sheer_white', 'mat_fabric_white'], ['fabric', 'glass'], '#f4f2ee', { glass: true }),
  blinds: fb(['mat_metal_white', 'mat_plastic_white', 'mat_metal_aluminium'], ['metal', 'plastic'], '#e9e9e7'),
  emissive: fb(['mat_other_led_warm', 'mat_plastic_white'], ['other', 'plastic'], '#ffffff'),
} as const

let builtinIndex: Map<Id, Material> | null = null
const fallbackMemo = new Map<MatFallback, Id>()

function builtins(): Map<Id, Material> {
  if (!builtinIndex) {
    builtinIndex = new Map()
    const list: unknown = BUILTIN_MATERIALS
    if (Array.isArray(list)) for (const m of list as Material[]) if (m && typeof m.id === 'string') builtinIndex.set(m.id, m)
  }
  return builtinIndex
}

function hexRgb(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!h) return [0.5, 0.5, 0.5]
  const n = parseInt(h[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** resolves a fallback intent to a material id that exists in BUILTIN_MATERIALS when possible */
export function fallbackId(f: MatFallback): Id {
  const memo = fallbackMemo.get(f)
  if (memo) return memo
  const all = builtins()
  let chosen: Id | undefined
  for (const id of f.ids) {
    if (all.has(id)) {
      chosen = id
      break
    }
  }
  if (!chosen && all.size > 0) {
    const want = hexRgb(f.color)
    let best = Infinity
    for (const m of all.values()) {
      if (m.remote) continue
      const inCat = f.cats.includes(m.category)
      const isGlass = (m.transmission ?? 0) > 0.2 || (m.opacity ?? 1) < 0.9
      if (!f.glass && isGlass) continue
      const c = hexRgb(m.color || '#808080')
      let score = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2
      if (!inCat) score += 1.5
      if (f.metal && (m.metalness ?? 0) < 0.5) score += 0.6
      if (!f.metal && (m.metalness ?? 0) > 0.5) score += 0.6
      if (f.glass && !isGlass) score += 1
      if (score < best) {
        best = score
        chosen = m.id
      }
    }
  }
  const id = chosen ?? f.ids[0]
  fallbackMemo.set(f, id)
  return id
}

/** list of every preferred fallback id (for the integrator / tests) */
export function fallbackMaterialIds(): Id[] {
  return Object.values(F).map((f) => f.ids[0])
}

// ───────────────────────────── build context ─────────────────────────────

/** a slot without its own override/default borrows the material of another slot */
export const SLOT_INHERIT: Record<string, string> = {
  plinth: 'front',
  cornice: 'body',
  shelves: 'body',
  sides: 'body',
  stringers: 'body',
  risers: 'body',
  headboard: 'fabric',
  frame: 'body',
  seat: 'body',
  base: 'body',
  apron: 'body',
  tray: 'body',
  ceramic: 'body',
  top: 'worktop',
  door: 'metal',
  drum: 'metal',
  filter: 'metal',
  sink: 'metal',
  panel: 'front',
  doorGlass: 'glass',
  mirror: 'glass',
  leaves: 'foliage',
  mattress: 'linen',
  pillows: 'linen',
  bedding: 'linen',
  back: 'body',
  cushions: 'fabric',
  armrests: 'fabric',
  louvre: 'body',
  cabinet: 'front',
  handles: 'metal',
  knobs: 'metal',
  treads: 'body',
  railing: 'metal',
  handrail: 'metal',
  pot: 'body',
}

export type ParamValue = number | string | boolean

export class Ctx {
  readonly root = new THREE.Group()
  readonly W: number
  readonly H: number
  readonly D: number
  private readonly params: Record<string, ParamValue>
  /** per-kind slot aliases consulted before SLOT_INHERIT */
  slotAlias: Record<string, string> = {}

  constructor(
    readonly asset: Asset,
    readonly item: Item,
    readonly mats: MaterialLibrary,
  ) {
    const s = item.size ?? asset.size
    this.W = Math.max(10, s.w) / 1000
    this.H = Math.max(10, s.h) / 1000
    this.D = Math.max(5, s.d) / 1000
    this.params = { ...(asset.defaultParams ?? {}), ...(item.params ?? {}) }
  }

  /**
   * material for a slot: item override → asset slot default → (inherited slot, e.g. plinth → front)
   * → builtin fallback. The item tint applies to every un-overridden slot.
   */
  /** the slot name actually carrying the material (first in the inheritance chain that is defined) */
  resolveSlot(slot: string): string {
    let s: string | undefined = slot
    for (let hop = 0; s && hop < 5; hop++) {
      if (this.item.overrides?.[s] || this.asset.slots?.[s]) return s
      s = this.slotAlias[s] ?? SLOT_INHERIT[s]
    }
    return slot
  }

  materialFor(slot: string, f: MatFallback): THREE.Material {
    let s: string | undefined = slot
    for (let hop = 0; s && hop < 5; hop++) {
      const ov = this.item.overrides?.[s]
      if (ov) return this.mats.getForItem(ov)
      const def = this.asset.slots?.[s]
      if (def) return this.mats.getForItem(def, this.item.tint)
      s = this.slotAlias[s] ?? SLOT_INHERIT[s]
    }
    return this.mats.getForItem(fallbackId(f), this.item.tint)
  }

  num(name: string, def: number, min = -Infinity, max = Infinity): number {
    const v = this.params[name]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return clamp(Number.isFinite(n) ? n : def, min, max)
  }

  int(name: string, def: number, min = -Infinity, max = Infinity): number {
    return Math.round(this.num(name, def, min, max))
  }

  str<T extends string>(name: string, def: T, allowed?: readonly T[]): T {
    const v = this.params[name]
    const s = typeof v === 'string' ? (v as T) : typeof v === 'number' ? (String(v) as T) : def
    if (allowed && !allowed.includes(s)) return def
    return s
  }

  bool(name: string, def: boolean): boolean {
    const v = this.params[name]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes'
    return def
  }

  has(name: string): boolean {
    return this.params[name] !== undefined
  }

  /** raw parameter value */
  raw(name: string): ParamValue | undefined {
    return this.params[name]
  }

  /** overrides a parameter (used by the per-kind parameter adapters) */
  set(name: string, v: ParamValue): void {
    this.params[name] = v
  }

  /** sets a parameter only when it is absent */
  def(name: string, v: ParamValue | undefined): void {
    if (v !== undefined && this.params[name] === undefined) this.params[name] = v
  }

  /** adds a mesh; position is the geometry origin in the parent frame */
  add(
    geo: THREE.BufferGeometry,
    slot: string,
    f: MatFallback,
    pos: V3,
    rot?: V3,
    parent?: THREE.Object3D,
    name?: string,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.materialFor(slot, f))
    mesh.position.set(pos[0], pos[1], pos[2])
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2])
    const transparent = f.glass === true || slot === 'glass'
    mesh.castShadow = !transparent
    mesh.receiveShadow = true
    mesh.userData.slot = this.resolveSlot(slot)
    if (name) mesh.name = name
    ;(parent ?? this.root).add(mesh)
    return mesh
  }

  group(pos: V3 = [0, 0, 0], rot?: V3, parent?: THREE.Object3D): THREE.Group {
    const g = new THREE.Group()
    g.position.set(pos[0], pos[1], pos[2])
    if (rot) g.rotation.set(rot[0], rot[1], rot[2])
    ;(parent ?? this.root).add(g)
    return g
  }
}

// ───────────────────────────── primitive geometries (all cached, centred at origin) ─────────────────────────────

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return cached(gkey('box', w, h, d), () => boxUV(new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4))))
}

/** bevelled box; radius is clamped to fit */
export function rbox(w: number, h: number, d: number, r = 0.004): THREE.BufferGeometry {
  w = Math.max(w, 1e-4)
  h = Math.max(h, 1e-4)
  d = Math.max(d, 1e-4)
  const rr = Math.min(r, Math.min(w, h, d) / 2 - 1e-5)
  if (rr < 0.0004) return box(w, h, d)
  const segs = rr > 0.02 ? 4 : rr > 0.006 ? 3 : 2
  return cached(gkey('rbox', w, h, d, rr), () => boxUV(new RoundedBoxGeometry(w, h, d, segs, rr)))
}

/** cylinder along Y */
export function cyl(rTop: number, rBottom: number, h: number, seg = 24): THREE.BufferGeometry {
  return cached(gkey('cyl', rTop, rBottom, h, seg), () => boxUV(new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1)))
}

/** cylinder along X */
export function cylX(r: number, len: number, seg = 20): THREE.BufferGeometry {
  return cached(gkey('cylX', r, len, seg), () => {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1)
    g.rotateZ(Math.PI / 2)
    return boxUV(g)
  })
}

/** cylinder along Z */
export function cylZ(r: number, len: number, seg = 20): THREE.BufferGeometry {
  return cached(gkey('cylZ', r, len, seg), () => {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1)
    g.rotateX(Math.PI / 2)
    return boxUV(g)
  })
}

export function sphere(r: number, sx = 1, sy = 1, sz = 1, seg = 20): THREE.BufferGeometry {
  return cached(gkey('sph', r, sx, sy, sz, seg), () => {
    const g = new THREE.SphereGeometry(r, seg, Math.max(8, Math.round(seg * 0.6)))
    g.scale(sx, sy, sz)
    return boxUV(g)
  })
}

/** torus lying in the XY plane (axis Z) */
export function torus(R: number, r: number, radial = 12, tubular = 40, arc = Math.PI * 2): THREE.BufferGeometry {
  return cached(gkey('torus', R, r, radial, tubular, arc), () => boxUV(new THREE.TorusGeometry(R, r, radial, tubular, arc)))
}

/** lathe around Y from [radius, y] profile points (bottom → top) */
export function lathe(profile: [number, number][], seg = 40, scaleZ = 1): THREE.BufferGeometry {
  const k = gkey('lathe', seg, scaleZ, ...profile.flat())
  return cached(k, () => {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y))
    const g = new THREE.LatheGeometry(pts, seg)
    if (scaleZ !== 1) g.scale(1, 1, scaleZ)
    g.computeVertexNormals()
    return boxUV(g)
  })
}

/** tube along a smooth path through points */
export function tube(points: V3[], radius: number, segs = 48, radial = 12, closed = false): THREE.BufferGeometry {
  const k = gkey('tube', radius, segs, radial, closed, ...points.flat())
  return cached(k, () => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'centripetal')
    return boxUV(new THREE.TubeGeometry(curve, segs, radius, radial, closed))
  })
}

export function roundedRectShape(w: number, h: number, r: number, cx = 0, cy = 0): THREE.Shape {
  const s = new THREE.Shape()
  roundedRectPath(s, w, h, r, cx, cy, false)
  return s
}

/** draws a rounded rectangle into a path (CCW, or CW when `hole`) */
export function roundedRectPath(p: THREE.Path, w: number, h: number, r: number, cx = 0, cy = 0, hole = false): void {
  r = Math.max(0, Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5))
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const x1 = cx + w / 2
  const y1 = cy + h / 2
  if (!hole) {
    p.moveTo(x0 + r, y0)
    p.lineTo(x1 - r, y0)
    if (r > 0) p.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false)
    p.lineTo(x1, y1 - r)
    if (r > 0) p.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false)
    p.lineTo(x0 + r, y1)
    if (r > 0) p.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false)
    p.lineTo(x0, y0 + r)
    if (r > 0) p.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
  } else {
    p.moveTo(x0 + r, y0)
    if (r > 0) p.absarc(x0 + r, y0 + r, r, Math.PI * 1.5, Math.PI, true)
    p.lineTo(x0, y1 - r)
    if (r > 0) p.absarc(x0 + r, y1 - r, r, Math.PI, Math.PI / 2, true)
    p.lineTo(x1 - r, y1)
    if (r > 0) p.absarc(x1 - r, y1 - r, r, Math.PI / 2, 0, true)
    p.lineTo(x1, y0 + r)
    if (r > 0) p.absarc(x1 - r, y0 + r, r, 0, -Math.PI / 2, true)
  }
  p.closePath()
}

export function ellipseShape(w: number, h: number, cx = 0, cy = 0, hole = false): THREE.Shape {
  const s = new THREE.Shape()
  s.absellipse(cx, cy, w / 2, h / 2, 0, Math.PI * 2, hole, 0)
  return s
}

export function ellipsePath(w: number, h: number, cx = 0, cy = 0): THREE.Path {
  const p = new THREE.Path()
  p.absellipse(cx, cy, w / 2, h / 2, 0, Math.PI * 2, true, 0)
  return p
}

/**
 * Extrudes a shape drawn in the XZ plane (shape x → X, shape y → +Z, i.e. "front") upwards to `h`,
 * bevelled. Outer bounds equal the shape bounds; occupies y ∈ [0, h].
 */
export function slabFromShape(key: string, shape: () => THREE.Shape, h: number, bevel: number, curveSegs = 24): THREE.BufferGeometry {
  return cached(gkey('slab', h, bevel, curveSegs) + '|' + key, () => {
    const b = Math.max(0, Math.min(bevel, h / 2 - 1e-5))
    const g = new THREE.ExtrudeGeometry(shape(), {
      depth: Math.max(h - 2 * b, 1e-5),
      bevelEnabled: b > 0,
      bevelThickness: b,
      bevelSize: b,
      bevelOffset: -b,
      bevelSegments: b > 0 ? 3 : 1,
      curveSegments: curveSegs,
    })
    // extrusion runs along +Z from -b to depth+b; map to Y up, shape y → +Z
    g.rotateX(-Math.PI / 2)
    g.scale(1, 1, -1)
    g.translate(0, b, 0)
    flipWindingIfNeeded(g)
    return boxUV(crease(g))
  })
}

/** rounded-rectangle slab (w × d footprint, height h) */
export function roundedSlab(w: number, d: number, h: number, cornerR: number, bevel: number): THREE.BufferGeometry {
  return slabFromShape(gkey('rr', w, d, cornerR), () => roundedRectShape(w, d, cornerR), h, bevel)
}

/** elliptical slab */
export function ellipseSlab(w: number, d: number, h: number, bevel: number): THREE.BufferGeometry {
  return slabFromShape(gkey('el', w, d), () => ellipseShape(w, d), h, bevel, 48)
}

/**
 * Extrudes a shape drawn in the XY plane (front view) along Z by `depth`, centred on z = 0, bevelled.
 */
export function extrudeFront(key: string, shape: () => THREE.Shape, depth: number, bevel: number, curveSegs = 24): THREE.BufferGeometry {
  return cached(gkey('xf', depth, bevel, curveSegs) + '|' + key, () => {
    const b = Math.max(0, Math.min(bevel, depth / 2 - 1e-5))
    const g = new THREE.ExtrudeGeometry(shape(), {
      depth: Math.max(depth - 2 * b, 1e-5),
      bevelEnabled: b > 0,
      bevelThickness: b,
      bevelSize: b,
      bevelOffset: -b,
      bevelSegments: b > 0 ? 3 : 1,
      curveSegments: curveSegs,
    })
    g.translate(0, 0, -depth / 2 + b)
    return boxUV(crease(g))
  })
}

/**
 * Extrudes a profile drawn in the side view (shape x → +Z front, shape y → Y) along X, centred on x = 0.
 */
export function extrudeSide(key: string, shape: () => THREE.Shape, width: number, bevel: number, curveSegs = 24): THREE.BufferGeometry {
  return cached(gkey('xs', width, bevel, curveSegs) + '|' + key, () => {
    const b = Math.max(0, Math.min(bevel, width / 2 - 1e-5))
    const g = new THREE.ExtrudeGeometry(shape(), {
      depth: Math.max(width - 2 * b, 1e-5),
      bevelEnabled: b > 0,
      bevelThickness: b,
      bevelSize: b,
      bevelOffset: -b,
      bevelSegments: b > 0 ? 3 : 1,
      curveSegments: curveSegs,
    })
    g.translate(0, 0, -width / 2 + b)
    // rotateY(-90°) maps (x, y, z) → (-z, y, x): shape x → +Z, extrusion → X (centred, symmetric)
    g.rotateY(-Math.PI / 2)
    return boxUV(crease(g))
  })
}

/** smooth normals across shallow angles (curved extrusion walls), keep hard edges */
export function crease(g: THREE.BufferGeometry, angle = 0.7): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name)
  g.clearGroups()
  const out = creasedNormals(g, angle)
  if (out !== g) g.dispose()
  return out
}

/**
 * `toCreasedNormals` of three, with vertices matched at 0.1 mm instead of 1 cm. three's 1 cm cells
 * gather thousands of corners of small bevelled profiles (picture and mirror frames) into one cell
 * and compare every face there with every other — seconds of main thread for one wall of pictures.
 * Only faces that really share a corner are compared here.
 */
function creasedNormals(geometry: THREE.BufferGeometry, creaseAngle: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  const pos = g.getAttribute('position')
  const count = pos.count
  const p = new Float64Array(count * 3)
  for (let i = 0; i < count; i++) {
    p[3 * i] = pos.getX(i)
    p[3 * i + 1] = pos.getY(i)
    p[3 * i + 2] = pos.getZ(i)
  }
  const faces = Math.floor(count / 3)
  const fn = new Float64Array(faces * 3)
  for (let f = 0; f < faces; f++) {
    const o = 9 * f
    const v1x = p[o + 6] - p[o + 3]
    const v1y = p[o + 7] - p[o + 4]
    const v1z = p[o + 8] - p[o + 5]
    const v2x = p[o] - p[o + 3]
    const v2y = p[o + 1] - p[o + 4]
    const v2z = p[o + 2] - p[o + 5]
    const nx = v1y * v2z - v1z * v2y
    const ny = v1z * v2x - v1x * v2z
    const nz = v1x * v2y - v1y * v2x
    const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)
    fn[3 * f] = nx * inv
    fn[3 * f + 1] = ny * inv
    fn[3 * f + 2] = nz * inv
  }
  // one id per position (0.1 mm grid), open addressing; slots hold id + 1
  const ids = new Int32Array(count)
  const q = new Float64Array(count * 3)
  let size = 1
  while (size < count * 2) size <<= 1
  const mask = size - 1
  const table = new Int32Array(size)
  let unique = 0
  for (let i = 0; i < count; i++) {
    const qx = Math.round(p[3 * i] * 1e4)
    const qy = Math.round(p[3 * i + 1] * 1e4)
    const qz = Math.round(p[3 * i + 2] * 1e4)
    let slot = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) & mask
    for (;;) {
      const id = table[slot]
      if (id === 0) {
        q[3 * unique] = qx
        q[3 * unique + 1] = qy
        q[3 * unique + 2] = qz
        table[slot] = unique + 1
        ids[i] = unique++
        break
      }
      const k = 3 * (id - 1)
      if (q[k] === qx && q[k + 1] === qy && q[k + 2] === qz) {
        ids[i] = id - 1
        break
      }
      slot = (slot + 1) & mask
    }
  }
  // the faces around each position
  const offsets = new Int32Array(unique + 1)
  for (let i = 0; i < faces * 3; i++) offsets[ids[i] + 1]++
  for (let i = 0; i < unique; i++) offsets[i + 1] += offsets[i]
  const around = new Int32Array(faces * 3)
  const cursor = offsets.slice(0, unique)
  for (let i = 0; i < faces * 3; i++) around[cursor[ids[i]]++] = Math.floor(i / 3)
  const creaseDot = Math.cos(creaseAngle)
  const normals = new Float32Array(count * 3)
  for (let i = 0; i < faces * 3; i++) {
    const f = Math.floor(i / 3)
    const nx = fn[3 * f]
    const ny = fn[3 * f + 1]
    const nz = fn[3 * f + 2]
    let sx = 0
    let sy = 0
    let sz = 0
    for (let k = offsets[ids[i]], end = offsets[ids[i] + 1]; k < end; k++) {
      const o = 3 * around[k]
      if (nx * fn[o] + ny * fn[o + 1] + nz * fn[o + 2] > creaseDot) {
        sx += fn[o]
        sy += fn[o + 1]
        sz += fn[o + 2]
      }
    }
    const inv = 1 / (Math.sqrt(sx * sx + sy * sy + sz * sz) || 1)
    normals[3 * i] = sx * inv
    normals[3 * i + 1] = sy * inv
    normals[3 * i + 2] = sz * inv
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return g
}

function flipWindingIfNeeded(g: THREE.BufferGeometry): void {
  // scale(1,1,-1) mirrors the mesh: reverse triangle winding to keep faces outward
  const idx = g.index
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i + 1)
      idx.setX(i + 1, idx.getX(i + 2))
      idx.setX(i + 2, t)
    }
    idx.needsUpdate = true
    return
  }
  const pos = g.getAttribute('position')
  const attrs = Object.values(g.attributes)
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of attrs) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k)
        a.setComponent(i + 1, k, a.getComponent(i + 2, k))
        a.setComponent(i + 2, k, t)
      }
    }
  }
}

/**
 * Soft cushion: rounded box whose top and bottom bulge, welded and smooth-shaded.
 * Outer bounds: w × h × d.
 */
export function cushion(w: number, h: number, d: number, r: number, bulge: number): THREE.BufferGeometry {
  return cached(gkey('cushion', w, h, d, r, bulge), () => {
    const b = Math.min(bulge, h * 0.25)
    const hh = h - 2 * b
    const rr = Math.max(0.001, Math.min(r, Math.min(w, hh, d) / 2 - 1e-4))
    const g = smooth(new RoundedBoxGeometry(w, hh, d, 5, rr), 1e-6)
    const pos = g.getAttribute('position')
    const hw = w / 2
    const hd = d / 2
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      const fx = Math.max(0, 1 - (x / hw) ** 2)
      const fz = Math.max(0, 1 - (z / hd) ** 2)
      const fy = Math.min(1, Math.abs(y) / (hh / 2))
      pos.setY(i, y + Math.sign(y) * b * fx * fz * fy)
      // slight side puff
      const side = (1 - fy * fy) * 0.25 * b
      pos.setX(i, x + Math.sign(x) * side * fz)
      pos.setZ(i, z + Math.sign(z) * side * fx)
    }
    g.computeVertexNormals()
    g.computeBoundingBox()
    // rescale to exact bounds
    const bb = g.boundingBox!
    const sz = new THREE.Vector3()
    bb.getSize(sz)
    g.scale(w / sz.x, h / sz.y, d / sz.z)
    return boxUV(g)
  })
}

/** Pillow: lens-shaped soft body, thickness h tapering to edges. */
export function pillow(w: number, h: number, d: number): THREE.BufferGeometry {
  return cached(gkey('pillow', w, h, d), () => {
    const rr = Math.min(w, h, d) / 2 - 1e-4
    const g = smooth(new RoundedBoxGeometry(w, h, d, 6, rr), 1e-6)
    const pos = g.getAttribute('position')
    const hw = w / 2
    const hd = d / 2
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const t = (1 - 0.55 * (x / hw) ** 4) * (1 - 0.55 * (z / hd) ** 4)
      pos.setY(i, pos.getY(i) * t)
      // pinched corners
      const corner = (Math.abs(x) / hw) * (Math.abs(z) / hd)
      pos.setX(i, x * (1 + 0.04 * corner))
      pos.setZ(i, z * (1 + 0.04 * corner))
    }
    g.computeVertexNormals()
    g.computeBoundingBox()
    const sz = new THREE.Vector3()
    g.boundingBox!.getSize(sz)
    g.scale(w / sz.x, h / sz.y, d / sz.z)
    return boxUV(g)
  })
}

/** CCW (viewed from +Y) loop of a rounded rectangle in XZ, `n` points per corner */
export function roundedRectLoop(w: number, d: number, r: number, n: number): [number, number][] {
  r = Math.max(0.0005, Math.min(r, w / 2 - 1e-5, d / 2 - 1e-5))
  const hw = w / 2 - r
  const hd = d / 2 - r
  const pts: [number, number][] = []
  const centres: [number, number, number][] = [
    [hw, -hd, -Math.PI / 2],
    [hw, hd, 0],
    [-hw, hd, Math.PI / 2],
    [-hw, -hd, Math.PI],
  ]
  for (const [cx, cz, a0] of centres) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r])
    }
  }
  return pts
}

/**
 * Hollow rounded-rectangle bowl (open top at y = 0, bottom at y = -depth).
 * `inward`: faces visible from inside (basin interior); otherwise outward (tub outer shell).
 * `taper`: horizontal inset of the walls at the bottom; `bottomR`: fillet radius into the floor.
 */
export function bowl(w: number, d: number, cornerR: number, depth: number, bottomR: number, taper: number, inward: boolean, closeBottom = true): THREE.BufferGeometry {
  return cached(gkey('bowl', w, d, cornerR, depth, bottomR, taper, inward, closeBottom), () => {
    const n = 8
    const br = Math.max(0.002, Math.min(bottomR, depth * 0.9, (Math.min(w, d) / 2 - taper) * 0.9))
    // profile: (inset, y) from top to bottom
    const prof: [number, number][] = []
    const wallSteps = 4
    for (let i = 0; i <= wallSteps; i++) {
      const t = i / wallSteps
      prof.push([taper * t, -(depth - br) * t])
    }
    const fil = 6
    for (let i = 1; i <= fil; i++) {
      const a = (i / fil) * (Math.PI / 2)
      prof.push([taper + br * (1 - Math.cos(a)), -(depth - br) - br * Math.sin(a)])
    }
    const loops: [number, number][][] = prof.map(([inset]) => roundedRectLoop(w - 2 * inset, d - 2 * inset, cornerR - inset, n))
    const per = loops[0].length
    const positions: number[] = []
    for (let k = 0; k < loops.length; k++) {
      const y = prof[k][1]
      for (const [x, z] of loops[k]) positions.push(x, y, z)
    }
    const idx: number[] = []
    for (let k = 0; k < loops.length - 1; k++) {
      for (let i = 0; i < per; i++) {
        const i2 = (i + 1) % per
        const a = k * per + i
        const b = k * per + i2
        const c = (k + 1) * per + i
        const e = (k + 1) * per + i2
        idx.push(a, c, e, a, e, b)
      }
    }
    let bottomTri = -1
    if (closeBottom) {
      const centre = positions.length / 3
      positions.push(0, prof[prof.length - 1][1], 0)
      const L = (loops.length - 1) * per
      bottomTri = idx.length
      for (let i = 0; i < per; i++) idx.push(centre, L + ((i + 1) % per), L + i)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(idx)
    // orientation check: a wall triangle of the first strip should face towards the centre when inward
    const p = (i: number) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    const t0 = bottomTri >= 0 ? bottomTri : 0
    const A = p(idx[t0])
    const B = p(idx[t0 + 1])
    const C = p(idx[t0 + 2])
    const nrm = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A))
    let flip: boolean
    if (bottomTri >= 0) flip = inward ? nrm.y < 0 : nrm.y > 0
    else {
      const mid = A.clone().add(B).add(C).divideScalar(3)
      const out = nrm.dot(new THREE.Vector3(mid.x, 0, mid.z)) > 0
      flip = inward ? out : !out
    }
    if (flip) {
      for (let i = 0; i < idx.length; i += 3) {
        const t = idx[i + 1]
        idx[i + 1] = idx[i + 2]
        idx[i + 2] = t
      }
      g.setIndex(idx)
    }
    g.computeVertexNormals()
    return boxUV(g)
  })
}

/** flat ring/plate with a rounded-rect hole, lying on y ∈ [0, h] */
export function plateWithHole(w: number, d: number, outerR: number, hw: number, hd: number, holeR: number, hx: number, hz: number, h: number, bevel: number): THREE.BufferGeometry {
  const k = gkey('plateHole', w, d, outerR, hw, hd, holeR, hx, hz)
  return slabFromShape(
    k,
    () => {
      const s = roundedRectShape(w, d, outerR)
      const hole = new THREE.Path()
      // slab maps shape y → +Z, so pass hz directly
      roundedRectPath(hole, hw, hd, holeR, hx, hz, true)
      s.holes.push(hole)
      return s
    },
    h,
    bevel,
  )
}

/** plate with several rounded-rect holes */
export function plateWithHoles(w: number, d: number, outerR: number, holes: { w: number; d: number; r: number; x: number; z: number }[], h: number, bevel: number): THREE.BufferGeometry {
  const k = gkey('plateHoles', w, d, outerR, ...holes.flatMap((o) => [o.w, o.d, o.r, o.x, o.z]))
  return slabFromShape(
    k,
    () => {
      const s = roundedRectShape(w, d, outerR)
      for (const o of holes) {
        const hole = new THREE.Path()
        roundedRectPath(hole, o.w, o.d, o.r, o.x, o.z, true)
        s.holes.push(hole)
      }
      return s
    },
    h,
    bevel,
  )
}

// ───────────────────────────── common furniture parts ─────────────────────────────

export type HandleStyle = 'bar' | 'knob' | 'none' | 'edge' | 'cup' | 'gola'
/** every handle style (param option lists) */
export const HANDLE_STYLES: readonly HandleStyle[] = ['bar', 'knob', 'edge', 'cup', 'gola', 'none']
/** front (door / drawer face) styles: plain slab, shaker frame-and-panel, classic raised panel */
export type FrontStyle = 'flat' | 'shaker' | 'classic'
export const FRONT_STYLES: readonly FrontStyle[] = ['flat', 'shaker', 'classic']
/** height of the horizontal handle-less (gola) channel above a front, m */
export const GOLA = 0.03

/**
 * Adds a handle centred at (x, y) on a front whose outer face is at z.
 * `vertical`: bar orientation. Length is the bar length (bar style).
 */
export function addHandle(c: Ctx, style: HandleStyle, x: number, y: number, z: number, len: number, vertical: boolean, parent?: THREE.Object3D): void {
  // gola fronts have no handle: the channel is added with the fronts (addFronts)
  if (style === 'none' || style === 'gola') return
  if (style === 'cup') {
    // shell (cup) pull: a half-round shell on a slim back plate
    const g = cached(gkey('cupHandle'), () => {
      const shell = new THREE.CylinderGeometry(0.016, 0.016, 0.085, 20, 1, false, 0, Math.PI)
      shell.rotateZ(Math.PI / 2)
      shell.rotateY(Math.PI / 2)
      shell.scale(1, 1, 0.9)
      const plate = new THREE.BoxGeometry(0.095, 0.034, 0.004)
      plate.translate(0, 0.002, 0.002)
      return merge([{ g: shell }, { g: plate }])
    })
    c.add(g, 'handles', F.steel, [x, y, z], vertical ? [0, 0, Math.PI / 2] : undefined, parent)
    return
  }
  if (style === 'knob') {
    const g = lathe(
      [
        [0.0001, 0],
        [0.007, 0],
        [0.0055, 0.012],
        [0.012, 0.02],
        [0.013, 0.026],
        [0.009, 0.03],
        [0.0001, 0.031],
      ],
      24,
    )
    c.add(g, 'handles', F.steel, [x, y, z], [Math.PI / 2, 0, 0], parent)
    return
  }
  if (style === 'edge') {
    // slim aluminium edge profile on top of the front
    const l = Math.max(0.05, len)
    const g = rbox(vertical ? 0.012 : l, vertical ? l : 0.012, 0.022, 0.002)
    c.add(g, 'handles', F.aluminium, [x, y, z + 0.006], undefined, parent)
    return
  }
  const L = clamp(len, 0.06, 1.2)
  const standoff = 0.028
  const r = 0.0065
  const g = cached(gkey('barHandle', L), () => {
    const bar = new THREE.CylinderGeometry(r, r, L, 16, 1)
    const capT = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
    const capB = capT.clone()
    capB.rotateX(Math.PI)
    const post = new THREE.CylinderGeometry(0.005, 0.0055, standoff, 12, 1)
    post.rotateX(Math.PI / 2)
    const inset = Math.min(0.025, L * 0.12)
    return merge([
      { g: bar, m: mat4([0, 0, standoff]) },
      { g: capT, m: mat4([0, L / 2, standoff]) },
      { g: capB, m: mat4([0, -L / 2, standoff]) },
      { g: post, m: mat4([0, L / 2 - inset, standoff / 2]) },
      { g: post, m: mat4([0, -L / 2 + inset, standoff / 2]) },
    ])
  })
  c.add(g, 'handles', F.steel, [x, y, z], vertical ? undefined : [0, 0, Math.PI / 2], parent)
}

export interface FrontOpts {
  layout: 'doors' | 'drawers' | 'mixed' | 'lift' | 'lift2' | 'glass'
  doors: number
  drawers: number
  handle: HandleStyle
  /** where door handles sit: top of doors (base units), bottom (wall units), middle (tall) */
  handlePos: 'top' | 'bottom' | 'middle'
  gap: number
  thick: number
  /** face style of every front (default flat) */
  style?: FrontStyle
}

/**
 * One door / drawer front of w × h × t centred on its own origin in the given style.
 * Shaker: a recessed centre panel inside a flat frame; classic: the centre field raised again.
 */
export function frontGeometry(w: number, h: number, t: number, style: FrontStyle = 'flat'): THREE.BufferGeometry {
  const rad = 0.0015
  const fw = Math.min(0.065, w * 0.17, h * 0.2)
  if (style === 'flat' || fw < 0.018 || w < 0.1 || h < 0.08) return rbox(w, h, t, rad)
  return cached(gkey('front', style, w, h, t), () => {
    const recess = Math.min(0.007, t * 0.4)
    const slab = new THREE.BoxGeometry(w - 0.002, h - 0.002, t - recess)
    slab.translate(0, 0, -recess / 2)
    const ring = roundedRectShape(w, h, rad)
    const hole = new THREE.Path()
    roundedRectPath(hole, w - 2 * fw, h - 2 * fw, 0.002, 0, 0, true)
    ring.holes.push(hole)
    const frame = new THREE.ExtrudeGeometry(ring, { depth: recess, bevelEnabled: false, curveSegments: 4 })
    frame.translate(0, 0, t / 2 - recess)
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = [{ g: slab }, { g: frame }]
    if (style === 'classic') {
      // raised field with a bevelled edge, inset from the frame
      const iw = w - 2 * fw - 0.03
      const ih = h - 2 * fw - 0.03
      if (iw > 0.04 && ih > 0.04) {
        const bev = 0.008
        const field = new THREE.ExtrudeGeometry(roundedRectShape(iw - 2 * bev, ih - 2 * bev, 0.002), {
          depth: recess * 0.3,
          bevelEnabled: true,
          bevelThickness: recess * 0.5,
          bevelSize: bev,
          bevelSegments: 1,
          curveSegments: 4,
        })
        field.translate(0, 0, t / 2 - recess + recess * 0.5)
        parts.push({ g: field })
      }
    }
    const merged = merge(parts)
    merged.computeVertexNormals()
    return boxUV(merged)
  })
}

/**
 * Lays out fronts (doors/drawers) inside rect [x0,x1]×[y0,y1]; fronts' back face at z.
 * Returns nothing; adds meshes to `parent`.
 */
export function addFronts(c: Ctx, x0: number, x1: number, y0: number, y1: number, z: number, o: FrontOpts, parent?: THREE.Object3D): void {
  const g = o.gap
  const t = o.thick
  const zc = z + t / 2
  const zf = z + t
  const W = x1 - x0
  const Hh = y1 - y0
  if (W <= 2 * g || Hh <= 2 * g) return
  const rad = 0.0015
  const gola = o.handle === 'gola'
  /** recessed aluminium C-profile between ya (top) and yb, set into the carcass behind the fronts */
  const golaChannel = (ya: number, yb: number) => {
    c.add(box(W, ya - yb, 0.004), 'handles', F.aluminium, [(x0 + x1) / 2, (ya + yb) / 2, z - 0.026], undefined, parent)
    c.add(box(W, 0.003, 0.026), 'handles', F.aluminium, [(x0 + x1) / 2, yb + 0.0015, z - 0.013], undefined, parent)
  }
  const doorRow = (ya: number, yb0: number, count: number, glass: boolean, handlePos: FrontOpts['handlePos']) => {
    // gola on a base unit: the doors stop under a channel (doors with their handle at the top only)
    let yb = yb0
    if (gola && handlePos === 'top' && yb0 - ya > GOLA * 4) {
      yb = yb0 - GOLA
      golaChannel(yb0, yb)
    }
    const n = Math.max(1, count)
    const dw = (W - g * (n + 1)) / n
    const dh = yb - ya - 2 * g
    if (dw <= 0 || dh <= 0) return
    for (let i = 0; i < n; i++) {
      const cx = x0 + g + dw / 2 + i * (dw + g)
      const cy = (ya + yb) / 2
      if (glass) {
        const fw = Math.min(0.022, dw * 0.2, dh * 0.2)
        // aluminium/wood frame + glass infill
        const frame = cached(gkey('glassFrame', dw, dh, fw, t), () => {
          const s = roundedRectShape(dw, dh, rad)
          const hole = new THREE.Path()
          roundedRectPath(hole, dw - 2 * fw, dh - 2 * fw, 0.001, 0, 0, true)
          s.holes.push(hole)
          const ge = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 4 })
          ge.translate(0, 0, -t / 2)
          ge.computeVertexNormals()
          return boxUV(ge)
        })
        c.add(frame, 'front', F.white, [cx, cy, zc], undefined, parent)
        c.add(box(dw - 2 * fw + 0.004, dh - 2 * fw + 0.004, 0.004), 'glass', F.frosted, [cx, cy, zc], undefined, parent)
      } else {
        c.add(frontGeometry(dw, dh, t, o.style), 'front', F.white, [cx, cy, zc], undefined, parent)
      }
      if (o.handle !== 'none' && o.handle !== 'gola') {
        const hingeLeft = n === 1 ? true : i < n / 2
        const hx = n === 1 && o.handlePos !== 'middle' ? cx : hingeLeft ? cx + dw / 2 - 0.035 : cx - dw / 2 + 0.035
        const hLen = o.handle === 'knob' ? 0 : Math.min(0.22, dh * 0.4)
        let hy = cy
        if (handlePos === 'top') hy = yb - g - 0.06 - (o.handle === 'bar' ? hLen / 2 - 0.02 : 0)
        else if (handlePos === 'bottom') hy = ya + g + 0.06 + (o.handle === 'bar' ? hLen / 2 - 0.02 : 0)
        if (n === 1 && o.handlePos !== 'middle') {
          // single door: horizontal bar centred near the edge
          const hy1 = handlePos === 'bottom' ? ya + g + 0.04 : yb - g - 0.04
          addHandle(c, o.handle, cx, hy1, zf, Math.min(0.32, dw * 0.5), false, parent)
        } else {
          addHandle(c, o.handle, hx, hy, zf, hLen, true, parent)
        }
      }
    }
  }
  const drawerStack = (ya: number, yb: number, count: number) => {
    const n = Math.max(1, count)
    // graduated drawers: lower ones taller
    const weights: number[] = []
    for (let i = 0; i < n; i++) weights.push(n === 1 ? 1 : 1 + (i / (n - 1)) * 0.5)
    const wsum = weights.reduce((a, b) => a + b, 0)
    const avail = yb - ya - g * (n + 1)
    let ytop = yb - g
    for (let i = 0; i < n; i++) {
      const h = (avail * weights[i]) / wsum
      const cy = ytop - h / 2
      if (gola && h > GOLA * 2.5) {
        // handle-less: the drawer front stops under an aluminium channel recessed into the carcass
        const fh = h - GOLA
        c.add(frontGeometry(W - 2 * g, fh, t, o.style), 'front', F.white, [(x0 + x1) / 2, ytop - GOLA - fh / 2, zc], undefined, parent)
        golaChannel(ytop + g, ytop - GOLA)
      } else {
        c.add(frontGeometry(W - 2 * g, h, t, o.style), 'front', F.white, [(x0 + x1) / 2, cy, zc], undefined, parent)
        addHandle(c, o.handle, (x0 + x1) / 2, o.handle === 'edge' ? ytop - 0.006 : ytop - Math.min(0.05, h / 2), zf, Math.min(0.4, (W - 2 * g) * 0.45), false, parent)
      }
      ytop -= h + g
    }
  }
  switch (o.layout) {
    case 'drawers':
      drawerStack(y0, y1, Math.max(1, o.drawers))
      break
    case 'mixed': {
      const topH = Math.min(0.18, Hh * 0.25)
      drawerStack(y1 - topH, y1, 1)
      doorRow(y0, y1 - topH + g, o.doors, false, 'top')
      break
    }
    case 'lift':
      doorRow(y0, y1, 1, false, o.handlePos)
      break
    case 'lift2': {
      // two horizontal lift-up fronts (bi-fold / two separate lifts), handles on the lower edges
      const mid = (y0 + y1) / 2
      doorRow(y0, mid + g / 2, 1, false, 'bottom')
      doorRow(mid - g / 2, y1, 1, false, 'bottom')
      break
    }
    case 'glass':
      doorRow(y0, y1, o.doors, true, o.handlePos)
      break
    default:
      doorRow(y0, y1, o.doors, false, o.handlePos)
  }
}

/** Faucet (mixer tap) standing at (x, y, z) on a deck, spout pointing +Z (rotate via `rotY`). */
export function addFaucet(c: Ctx, x: number, y: number, z: number, height: number, reach: number, rotY = 0, parent?: THREE.Object3D): void {
  const g = c.group([x, y, z], [0, rotY, 0], parent)
  const h = Math.max(0.12, height)
  const rr = clamp(reach, 0.08, 0.3)
  const base = lathe(
    [
      [0.0001, 0],
      [0.026, 0],
      [0.026, 0.004],
      [0.021, 0.012],
      [0.018, 0.05],
      [0.017, h * 0.55],
      [0.0001, h * 0.55],
    ],
    32,
  )
  c.add(base, 'metal', F.chrome, [0, 0, 0], undefined, g)
  // spout: rises from the body then arcs forward and down
  const top = h * 0.55
  const spout = tube(
    [
      [0, top - 0.02, 0],
      [0, h * 0.85, 0],
      [0, h - 0.012, rr * 0.25],
      [0, h - 0.02, rr * 0.7],
      [0, h * 0.82, rr],
      [0, h * 0.72, rr * 1.02],
    ],
    0.0095,
    64,
    14,
  )
  c.add(spout, 'metal', F.chrome, [0, 0, 0], undefined, g)
  c.add(cyl(0.011, 0.0095, 0.012, 16), 'metal', F.chrome, [0, h * 0.72 - 0.004, rr * 1.02], undefined, g)
  // lever
  const lever = cached(gkey('lever', h), () => {
    const hub = new THREE.CylinderGeometry(0.016, 0.017, 0.03, 20)
    const arm = new THREE.BoxGeometry(0.012, 0.009, 0.07)
    return merge([
      { g: hub, m: mat4([0, 0, 0]) },
      { g: arm, m: mat4([0, 0.012, -0.035], [-0.25, 0, 0]) },
    ])
  })
  c.add(lever, 'metal', F.chrome, [0, top + 0.015, 0], undefined, g)
}

/** Legs: tapered round leg of height h, top radius rt, bottom radius rb */
export function taperedLeg(h: number, rt: number, rb: number): THREE.BufferGeometry {
  return lathe(
    [
      [0.0001, 0],
      [rb * 0.92, 0],
      [rb, 0.004],
      [rt, h - 0.003],
      [rt * 0.9, h],
      [0.0001, h],
    ],
    20,
  )
}
