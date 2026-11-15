import type { Asset, Id, Vec2 } from './types'

/**
 * Ready-made kitchen sets assembled from the builtin kitchen modules.
 *
 * A preset is laid out against a wall face: `p0` is the left end of the face as seen from the room,
 * `x` the unit vector along the face, `n` the unit normal pointing into the room. Leg "a" runs along
 * that face; leg "b" (L-shaped sets) runs from the far end of leg "a" into the room, backs against
 * the adjacent wall; "free" modules (island, stools) are positioned by their centre.
 */
export interface PresetModule {
  /** asset id without the `asset_` prefix */
  asset: string
  leg?: 'a' | 'b' | 'free'
  /** a / b: start of the module along the leg, mm; free: centre along x, mm */
  s: number
  /** a / b: gap between the wall and the back of the module, mm; free: centre along n, mm */
  v?: number
  /** free modules: which way the front looks */
  facing?: 'wall' | 'room'
  /** override of the catalog width (backsplash runs) */
  w?: number
  params?: Record<string, number | string | boolean>
}

export interface KitchenPreset {
  id: string
  nameRu: string
  name: string
  /** footprint along the wall (leg a) and, for L sets, along leg b; mm */
  length: number
  lengthB?: number
  modules: PresetModule[]
}

export interface PresetFace {
  p0: Vec2
  x: Vec2
  n: Vec2
  /** length of leg a (the wall face) — leg "b" modules back against the wall at its end */
  length: number
}

export interface PresetPlacement {
  assetId: Id
  x: number
  y: number
  rotation: number
  size?: { w: number; d: number; h: number }
  params?: Record<string, number | string | boolean>
}

const deg = (f: Vec2): number => {
  const r = (Math.atan2(-f.x, f.y) * 180) / Math.PI
  return Math.round((((r % 360) + 360) % 360) * 1000) / 1000
}

/**
 * Preset face from a straight run of a room's inner wall face: `a`, `b` its ends, `n` the unit
 * normal pointing into the room (see roomEdgeRuns). p0 is the left end as seen from the room.
 */
export function faceOfRun(run: { a: Vec2; b: Vec2; n: Vec2; length: number }): PresetFace {
  const { a, b, n } = run
  // item local +x for an item whose front looks along n
  const x = { x: n.y, y: -n.x }
  const p0 = a.x * x.x + a.y * x.y <= b.x * x.x + b.y * x.y ? a : b
  return { p0, x, n, length: run.length }
}

/** a module laid out in face coordinates: u along the face from p0, v from the face into the room */
interface ModuleBox {
  m: PresetModule
  a: Asset
  w: number
  d: number
  /** centre */
  cu: number
  cv: number
  front: 'n' | '-n' | '-x'
  u0: number
  u1: number
  v0: number
  v1: number
}

/**
 * Leg a of an L set is anchored to the far end of the face so the corner unit always meets the
 * adjacent wall that leg b runs along; straight sets start at p0.
 */
function moduleBoxes(preset: KitchenPreset, L: number, lookup: (id: Id) => Asset | undefined): ModuleBox[] {
  const shift = preset.lengthB ? L - preset.length : 0
  const out: ModuleBox[] = []
  for (const m of preset.modules) {
    const a = lookup(`asset_${m.asset}`)
    if (!a) continue
    const w = m.w ?? a.size.w
    const d = a.size.d
    const v = m.v ?? 0
    if (m.leg === 'b') {
      const cu = shift + preset.length - v - d / 2
      out.push({ m, a, w, d, cu, cv: m.s + w / 2, front: '-x', u0: cu - d / 2, u1: cu + d / 2, v0: m.s, v1: m.s + w })
    } else if (m.leg === 'free') {
      const cu = m.s + shift
      out.push({ m, a, w, d, cu, cv: v, front: m.facing === 'room' ? 'n' : '-n', u0: cu - w / 2, u1: cu + w / 2, v0: v - d / 2, v1: v + d / 2 })
    } else {
      const u0 = m.s + shift
      out.push({ m, a, w, d, cu: u0 + w / 2, cv: v + d / 2, front: 'n', u0, u1: u0 + w, v0: v, v1: v + d })
    }
  }
  return out
}

/** world positions for every module of a preset; unknown assets are skipped */
export function layoutKitchenPreset(preset: KitchenPreset, face: PresetFace, lookup: (id: Id) => Asset | undefined): PresetPlacement[] {
  const { p0, x, n } = face
  const at = (u: number, v: number): Vec2 => ({ x: p0.x + x.x * u + n.x * v, y: p0.y + x.y * u + n.y * v })
  const out: PresetPlacement[] = []
  for (const b of moduleBoxes(preset, face.length, lookup)) {
    const c = at(b.cu, b.cv)
    const front = b.front === 'n' ? n : b.front === '-n' ? { x: -n.x, y: -n.y } : { x: -x.x, y: -x.y }
    const p: PresetPlacement = { assetId: b.a.id, x: Math.round(c.x), y: Math.round(c.y), rotation: deg(front) }
    if (b.m.w !== undefined) p.size = { w: b.w, d: b.d, h: b.a.size.h }
    if (b.m.params) p.params = { ...b.m.params }
    out.push(p)
  }
  return out
}

export type PresetFit =
  | { ok: true }
  /** the set is longer than the wall face (`reason: 'length'`) or reaches further into the room than the room goes (`'depth'`); mm */
  | { ok: false; reason: 'length' | 'depth'; need: number; have: number }

/** distance from o along the unit dir to the nearest segment of the rings, or Infinity */
function rayToRings(o: Vec2, dir: Vec2, rings: readonly (readonly Vec2[])[]): number {
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % ring.length]
      const ex = q.x - p.x
      const ey = q.y - p.y
      const den = dir.x * ey - dir.y * ex
      if (Math.abs(den) < 1e-9) continue
      const wx = p.x - o.x
      const wy = p.y - o.y
      const t = (wx * ey - wy * ex) / den
      const s = (wx * dir.y - wy * dir.x) / den
      if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t)
    }
  }
  return best
}

/**
 * Does the preset fit the face: no module may pass the ends of the wall face and, when the room
 * outline is known, every module must stay inside the room (rays cast from the face into the room).
 */
export function checkPresetFit(
  preset: KitchenPreset,
  face: PresetFace,
  lookup: (id: Id) => Asset | undefined,
  room?: { polygon: readonly Vec2[]; holes?: readonly (readonly Vec2[])[] },
): PresetFit {
  const TOL = 2
  const have = Math.round(face.length)
  if (face.length + TOL < preset.length) return { ok: false, reason: 'length', need: preset.length, have }
  const boxes = moduleBoxes(preset, face.length, lookup)
  for (const b of boxes) {
    if (b.u0 < -TOL || b.u1 > face.length + TOL) return { ok: false, reason: 'length', need: preset.length, have }
  }
  if (!room || room.polygon.length < 3) return { ok: true }
  const rings = [room.polygon, ...(room.holes ?? [])]
  const { p0, x, n } = face
  let needDepth = 0
  let haveDepth = Infinity
  for (const b of boxes) {
    const us = b.u1 - b.u0 > 80 ? [b.u0 + 30, (b.u0 + b.u1) / 2, b.u1 - 30] : [(b.u0 + b.u1) / 2]
    for (const u of us) {
      const o = { x: p0.x + x.x * u + n.x, y: p0.y + x.y * u + n.y }
      const depth = rayToRings(o, n, rings) + 1
      if (depth + TOL < b.v1) {
        needDepth = Math.max(needDepth, b.v1)
        haveDepth = Math.min(haveDepth, depth)
      }
    }
  }
  if (needDepth > 0) return { ok: false, reason: 'depth', need: Math.round(needDepth), have: Math.round(haveDepth) }
  return { ok: true }
}

const HOOD_UNDER = { asset: 'hood_flat' }

/** wall units start 1400 above the floor (asset elevation); hoods sit lower over the hob */
export const KITCHEN_PRESETS: KitchenPreset[] = [
  {
    id: 'straight_2400',
    nameRu: 'Прямая 2,4 м',
    name: 'Straight 2.4 m',
    length: 2400,
    modules: [
      { asset: 'kitchen_base_sink_800', s: 0 },
      { asset: 'kitchen_base_dishwasher_600', s: 800 },
      { asset: 'kitchen_base_oven_600', s: 1400 },
      { asset: 'kitchen_base_drawers_400', s: 2000 },
      { asset: 'kitchen_wall_800', s: 0 },
      { asset: 'kitchen_wall_glass_600', s: 800 },
      { ...HOOD_UNDER, s: 1400 },
      { asset: 'kitchen_wall_hood_600', s: 1400 },
      { asset: 'kitchen_wall_400', s: 2000 },
      { asset: 'kitchen_backsplash_tile_2400', s: 0 },
    ],
  },
  {
    id: 'straight_3000_tall',
    nameRu: 'Прямая 3 м с пеналами',
    name: 'Straight 3 m with tall units',
    length: 3000,
    modules: [
      { asset: 'kitchen_tall_fridge_600', s: 0 },
      { asset: 'kitchen_tall_oven_600', s: 600 },
      { asset: 'kitchen_base_sink_600', s: 1200 },
      { asset: 'kitchen_base_dishwasher_600', s: 1800 },
      { asset: 'kitchen_base_hob_600', s: 2400 },
      { asset: 'kitchen_wall_600', s: 1200 },
      { asset: 'kitchen_wall_glass_600', s: 1800, params: { layout: 'glass', doors: 1 } },
      { ...HOOD_UNDER, s: 2400 },
      { asset: 'kitchen_wall_hood_600', s: 2400 },
      { asset: 'kitchen_backsplash_stone_3000', s: 1200, w: 1800 },
    ],
  },
  {
    id: 'corner_2700_2100',
    nameRu: 'Угловая 2,7 × 2,1 м',
    name: 'L-shaped 2.7 × 2.1 m',
    length: 2700,
    lengthB: 2100,
    modules: [
      { asset: 'kitchen_tall_fridge_600', s: 0 },
      { asset: 'kitchen_base_sink_800', s: 600 },
      { asset: 'kitchen_base_drawers_400', s: 1400 },
      { asset: 'kitchen_base_corner_l_900', s: 1800, params: { cornerSide: 'right' } },
      { asset: 'kitchen_wall_800', s: 600 },
      { asset: 'kitchen_wall_400', s: 1400 },
      { asset: 'kitchen_wall_300', s: 1800 },
      { asset: 'kitchen_wall_corner_l_600', s: 2100, params: { cornerSide: 'right' } },
      { asset: 'kitchen_backsplash_tile_2400', s: 600, w: 2100 },
      { asset: 'kitchen_base_oven_600', leg: 'b', s: 900 },
      { asset: 'kitchen_base_drawers_600', leg: 'b', s: 1500 },
      { asset: 'kitchen_wall_300', leg: 'b', s: 600 },
      { ...HOOD_UNDER, leg: 'b', s: 900 },
      { asset: 'kitchen_wall_hood_600', leg: 'b', s: 900 },
      { asset: 'kitchen_wall_600', leg: 'b', s: 1500 },
      // the side wall is tiled from the corner, above the corner unit's wing too
      { asset: 'kitchen_backsplash_tile_2400', leg: 'b', s: 0, w: 2100 },
    ],
  },
  {
    id: 'island_3000',
    nameRu: 'Прямая 3 м с островом',
    name: 'Straight 3 m with island',
    length: 3000,
    modules: [
      { asset: 'kitchen_tall_fridge_600', s: 0 },
      { asset: 'kitchen_tall_oven_600', s: 600 },
      { asset: 'kitchen_base_sink_800', s: 1200 },
      { asset: 'kitchen_base_dishwasher_600', s: 2000 },
      { asset: 'kitchen_base_drawers_400', s: 2600 },
      { asset: 'kitchen_wall_800', s: 1200 },
      { asset: 'kitchen_wall_600', s: 2000 },
      { asset: 'kitchen_wall_400', s: 2600 },
      { asset: 'kitchen_backsplash_stone_3000', s: 1200, w: 1800 },
      // island: 1.1 m aisle in front of the run, cooktop in the island, counter stools (seat 650) on the far side
      { asset: 'kitchen_island', leg: 'free', s: 1800, v: 600 + 1100 + 450, facing: 'wall', params: { cutout: 'hob', hob: 'induction' } },
      { asset: 'hood_island', leg: 'free', s: 1800, v: 600 + 1100 + 450, facing: 'wall' },
      { asset: 'chair_counter', leg: 'free', s: 1300, v: 600 + 1100 + 900 + 120, facing: 'wall' },
      { asset: 'chair_counter', leg: 'free', s: 1800, v: 600 + 1100 + 900 + 120, facing: 'wall' },
      { asset: 'chair_counter', leg: 'free', s: 2300, v: 600 + 1100 + 900 + 120, facing: 'wall' },
    ],
  },
]
