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

/** world positions for every module of a preset; unknown assets are skipped */
export function layoutKitchenPreset(preset: KitchenPreset, face: PresetFace, lookup: (id: Id) => Asset | undefined): PresetPlacement[] {
  const { p0, x, n } = face
  const L = face.length
  const at = (u: number, v: number): Vec2 => ({ x: p0.x + x.x * u + n.x * v, y: p0.y + x.y * u + n.y * v })
  const out: PresetPlacement[] = []
  for (const m of preset.modules) {
    const id = `asset_${m.asset}`
    const a = lookup(id)
    if (!a) continue
    const w = m.w ?? a.size.w
    const d = a.size.d
    let c: Vec2
    let front: Vec2
    if (m.leg === 'b') {
      c = at(L - (m.v ?? 0) - d / 2, m.s + w / 2)
      front = { x: -x.x, y: -x.y }
    } else if (m.leg === 'free') {
      c = at(m.s, m.v ?? 0)
      front = m.facing === 'room' ? n : { x: -n.x, y: -n.y }
    } else {
      c = at(m.s + w / 2, (m.v ?? 0) + d / 2)
      front = n
    }
    const p: PresetPlacement = { assetId: id, x: Math.round(c.x), y: Math.round(c.y), rotation: deg(front) }
    if (m.w !== undefined) p.size = { w, d, h: a.size.h }
    if (m.params) p.params = { ...m.params }
    out.push(p)
  }
  return out
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
      { asset: 'kitchen_backsplash_tile_2400', leg: 'b', s: 900, w: 1200 },
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
      // island: 1.1 m aisle in front of the run, cooktop in the island, bar seating on the far side
      { asset: 'kitchen_island', leg: 'free', s: 1800, v: 600 + 1100 + 450, facing: 'wall', params: { cutout: 'hob', hob: 'induction' } },
      { asset: 'hood_island', leg: 'free', s: 1800, v: 600 + 1100 + 450, facing: 'wall' },
      { asset: 'chair_bar', leg: 'free', s: 1300, v: 600 + 1100 + 900 + 120, facing: 'wall' },
      { asset: 'chair_bar', leg: 'free', s: 1800, v: 600 + 1100 + 900 + 120, facing: 'wall' },
      { asset: 'chair_bar', leg: 'free', s: 2300, v: 600 + 1100 + 900 + 120, facing: 'wall' },
    ],
  },
]
