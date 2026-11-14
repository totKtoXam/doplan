/**
 * Pure math of direct item manipulation, shared by the 2D editor and the 3D view:
 *  - face-anchored resize in the item's rotated frame (the opposite face stays put);
 *  - snapping a dragged face to wall faces, other items' edges and a length step;
 *  - stacking: the item under a footprint whose top an item can stand on;
 *  - sane minimum sizes and redistribution of count parameters (doors, shelves…) of procedural items.
 *
 * Plan conventions (types.ts): mm, y down, rotation degrees clockwise. The item's local frame:
 * u = (cos θ, sin θ) is the width axis (local +x), f = (−sin θ, cos θ) the depth axis pointing to
 * the front (local +y), height goes up from `elevation`.
 */
import type { Asset, Item, ProceduralKind, Vec2, Wall, WallGeom } from './types'

const DEG = Math.PI / 180

export type ResizeAxis = 'w' | 'd' | 'h'
export type ItemSize = { w: number; d: number; h: number }

export interface ItemPose {
  x: number
  y: number
  rotation: number
  elevation: number
  size: ItemSize
}

/** unit width (u) and front (f) axes of a footprint rotated by `rotationDeg` */
export function itemAxes(rotationDeg: number): { u: Vec2; f: Vec2 } {
  const c = Math.cos(rotationDeg * DEG)
  const s = Math.sin(rotationDeg * DEG)
  return { u: { x: c, y: s }, f: { x: -s, y: c } }
}

/** corners of the footprint (clockwise on the y-down plan for θ = 0: back-left first) */
export function itemFootprint(p: Pick<ItemPose, 'x' | 'y' | 'rotation' | 'size'>): Vec2[] {
  const { u, f } = itemAxes(p.rotation)
  const hw = p.size.w / 2
  const hd = p.size.d / 2
  const at = (a: number, b: number): Vec2 => ({ x: p.x + u.x * a + f.x * b, y: p.y + u.y * a + f.y * b })
  return [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)]
}

export interface ResizeOptions {
  /** uniform scaling (the inspector's «Сохранять пропорции») */
  lockRatio?: boolean
  /** minimum size per axis (see `minItemSize`) */
  min?: ItemSize
  /** keep the back face (wall-mounted items): depth only grows to the front */
  fixedBack?: boolean
}

/**
 * New pose after dragging one face of the item: `axis` w/d/h, `side` +1 (right / front / top) or
 * −1 (left / back / bottom), `length` the requested size along that axis. The opposite face does not
 * move; with `lockRatio` every axis scales by the same factor, the other plan axis stays centred
 * (or keeps its back with `fixedBack`) and the bottom stays on its elevation.
 */
export function resizeFromFace(p: ItemPose, axis: ResizeAxis, side: 1 | -1, length: number, opts: ResizeOptions = {}): ItemPose {
  const min = opts.min ?? { w: 1, d: 1, h: 1 }
  const old = p.size
  let size: ItemSize
  if (opts.lockRatio && old[axis] > 0) {
    let k = Math.max(length, min[axis]) / old[axis]
    for (const a of ['w', 'd', 'h'] as const) if (old[a] > 0) k = Math.max(k, min[a] / old[a])
    size = { w: old.w * k, d: old.d * k, h: old.h * k }
  } else {
    size = { ...old, [axis]: Math.max(length, min[axis]) }
  }
  const { u, f } = itemAxes(p.rotation)
  let su = 0 // centre shift along u
  let sf = 0 // centre shift along f
  let elevation = p.elevation
  const dw = size.w - old.w
  const dd = size.d - old.d
  const dh = size.h - old.h
  if (axis === 'w') su = (side * dw) / 2
  if (axis === 'd') sf = (side * dd) / 2
  else if (opts.fixedBack) sf = dd / 2
  if (axis === 'h' && side < 0) elevation = p.elevation - dh
  return { x: p.x + u.x * su + f.x * sf, y: p.y + u.y * su + f.y * sf, rotation: p.rotation, elevation, size }
}

// ───────────────────────────── snapping ─────────────────────────────

export interface PlanSeg {
  a: Vec2
  b: Vec2
}

export type SnapKind = 'wall' | 'item' | 'grid' | 'height' | 'floor' | 'ceiling' | 'support'

export interface SnapTarget {
  value: number
  kind: SnapKind
}

/**
 * Lengths along `axis` (measured from the fixed opposite face) at which the moving face would lie on
 * one of the segments: only segments parallel to the face (within `angleTolDeg`), in front of the
 * fixed face and overlapping the face laterally (± `margin` mm) count.
 */
export function faceTargets(
  p: ItemPose,
  axis: 'w' | 'd',
  side: 1 | -1,
  segs: Iterable<PlanSeg>,
  kind: SnapKind,
  opts: { angleTolDeg?: number; margin?: number; maxLength?: number } = {},
): SnapTarget[] {
  const { u, f } = itemAxes(p.rotation)
  const dir = axis === 'w' ? { x: u.x * side, y: u.y * side } : { x: f.x * side, y: f.y * side }
  const lat = axis === 'w' ? f : u
  const len = p.size[axis]
  const half = (axis === 'w' ? p.size.d : p.size.w) / 2
  const fixed = { x: p.x - dir.x * (len / 2), y: p.y - dir.y * (len / 2) }
  const sinTol = Math.sin((opts.angleTolDeg ?? 3) * DEG)
  const margin = opts.margin ?? 0
  const maxLength = opts.maxLength ?? Infinity
  const out: SnapTarget[] = []
  for (const s of segs) {
    const ex = s.b.x - s.a.x
    const ey = s.b.y - s.a.y
    const l = Math.hypot(ex, ey)
    if (l < 1) continue
    if (Math.abs((ex * dir.x + ey * dir.y) / l) > sinTol) continue
    const dist = ((s.a.x + s.b.x) / 2 - fixed.x) * dir.x + ((s.a.y + s.b.y) / 2 - fixed.y) * dir.y
    if (!(dist > 0.5) || dist > maxLength) continue
    const t0 = (s.a.x - fixed.x) * lat.x + (s.a.y - fixed.y) * lat.y
    const t1 = (s.b.x - fixed.x) * lat.x + (s.b.y - fixed.y) * lat.y
    if (Math.max(t0, t1) < -half - margin || Math.min(t0, t1) > half + margin) continue
    out.push({ value: dist, kind })
  }
  return out
}

/** the four footprint edges of an item as plan segments */
export function footprintEdges(p: Pick<ItemPose, 'x' | 'y' | 'rotation' | 'size'>): PlanSeg[] {
  const c = itemFootprint(p)
  return c.map((a, i) => ({ a, b: c[(i + 1) % 4] }))
}

/** both faces of every real (non-virtual) wall of a level as plan segments */
export function wallFaceSegments(walls: Record<string, Pick<Wall, 'levelId' | 'kind'>>, geoms: Record<string, Pick<WallGeom, 'left' | 'right' | 'length'>>, levelId: string): PlanSeg[] {
  const out: PlanSeg[] = []
  for (const id in walls) {
    const w = walls[id]
    if (w.levelId !== levelId || w.kind === 'virtual') continue
    const g = geoms[id]
    if (!g || !(g.length > 1)) continue
    out.push({ a: g.left[0], b: g.left[1] }, { a: g.right[0], b: g.right[1] })
  }
  return out
}

/** an item that can act as a snap neighbour for plan resizing */
export type PlanNeighbour = Pick<Item, 'id' | 'x' | 'y' | 'rotation' | 'size' | 'mount'> & { hidden?: boolean }

/**
 * Snap lengths for a plan (width / depth) face drag: wall faces (± 60 mm lateral margin) and the
 * footprint edges of nearby items (hidden and ceiling items and the item itself are skipped).
 * Shared by the 2D handles and the 3D handles.
 */
export function planResizeTargets(
  p: ItemPose,
  axis: 'w' | 'd',
  side: 1 | -1,
  ctx: { walls: Iterable<PlanSeg>; items: Iterable<PlanNeighbour>; selfId?: string; reach?: number },
): SnapTarget[] {
  const out = faceTargets(p, axis, side, ctx.walls, 'wall', { margin: 60, maxLength: MAX_ITEM_MM })
  const r = Math.hypot(p.size.w, p.size.d) / 2 + (ctx.reach ?? 3000)
  const edges: PlanSeg[] = []
  for (const o of ctx.items) {
    if (o.id === ctx.selfId || o.hidden || o.mount === 'ceiling') continue
    if (Math.hypot(o.x - p.x, o.y - p.y) > r + Math.hypot(o.size.w, o.size.d) / 2) continue
    edges.push(...footprintEdges(o))
  }
  out.push(...faceTargets(p, axis, side, edges, 'item', { margin: 0, maxLength: MAX_ITEM_MM }))
  return out
}

/**
 * Snaps a raw value: the nearest target within `tol` wins; otherwise the value is rounded to `step`
 * (0 = only to whole millimetres).
 */
export function snapValue(raw: number, targets: Iterable<SnapTarget>, tol: number, step = 0): { value: number; kind: SnapKind | null } {
  let best: SnapTarget | null = null
  let bestD = tol
  for (const t of targets) {
    const d = Math.abs(t.value - raw)
    if (d <= bestD) {
      best = t
      bestD = d
    }
  }
  if (best) return { value: best.value, kind: best.kind }
  if (step > 0) return { value: Math.round(raw / step) * step, kind: 'grid' }
  return { value: Math.round(raw), kind: null }
}

// ───────────────────────────── stacking ─────────────────────────────

/** area of the intersection of two convex polygons (Sutherland–Hodgman), mm² */
export function convexOverlapArea(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (a.length < 3 || b.length < 3) return 0
  // orient the clip polygon counter-clockwise in the usual (y-up) sense of the cross product
  const clip = signedArea(b) < 0 ? [...b].reverse() : [...b]
  let poly: Vec2[] = signedArea(a) < 0 ? [...a].reverse() : [...a]
  for (let i = 0; i < clip.length && poly.length; i++) {
    const c0 = clip[i]
    const c1 = clip[(i + 1) % clip.length]
    const inside = (p: Vec2) => (c1.x - c0.x) * (p.y - c0.y) - (c1.y - c0.y) * (p.x - c0.x) >= -1e-9
    const cut = (p: Vec2, q: Vec2): Vec2 => {
      const dx = q.x - p.x
      const dy = q.y - p.y
      const den = (c1.x - c0.x) * dy - (c1.y - c0.y) * dx
      const t = den === 0 ? 0 : ((c1.y - c0.y) * (p.x - c0.x) - (c1.x - c0.x) * (p.y - c0.y)) / den
      return { x: p.x + dx * t, y: p.y + dy * t }
    }
    const next: Vec2[] = []
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j]
      const q = poly[(j + 1) % poly.length]
      const pin = inside(p)
      const qin = inside(q)
      if (pin) next.push(p)
      if (pin !== qin) next.push(cut(p, q))
    }
    poly = next
  }
  return poly.length >= 3 ? Math.abs(signedArea(poly)) : 0
}

function signedArea(p: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export type SupportCandidate = Pick<Item, 'id' | 'x' | 'y' | 'rotation' | 'size' | 'elevation' | 'mount'> & { hidden?: boolean }

/** items that never carry anything: ceiling fixtures, thin rugs / mats */
export function canSupport(o: SupportCandidate): boolean {
  return !o.hidden && o.mount !== 'ceiling' && o.size.h >= 30 && o.size.w >= 60 && o.size.d >= 60
}

/**
 * Share (0..1) of the item's footprint that rests on supports whose top is at `top` (± 5 mm): a bar
 * counter over three base units sums the three overlaps.
 */
export function supportCoverage(item: Pick<ItemPose, 'x' | 'y' | 'rotation' | 'size'>, others: Iterable<SupportCandidate>, top: number, exclude?: ReadonlySet<string>): number {
  const fp = itemFootprint(item)
  const area = item.size.w * item.size.d
  if (!(area > 0)) return 0
  let covered = 0
  for (const o of others) {
    if (exclude?.has(o.id) || !canSupport(o)) continue
    if (Math.abs(o.elevation + o.size.h - top) > 5) continue
    covered += convexOverlapArea(fp, itemFootprint(o))
  }
  return Math.min(1, covered / area)
}

/** distinct tops (mm above the floor) of the supports touching the item's footprint, highest first */
export function supportTops(item: Pick<ItemPose, 'x' | 'y' | 'rotation' | 'size'>, others: Iterable<SupportCandidate>, exclude?: ReadonlySet<string>, reach = 0): number[] {
  const r = Math.hypot(item.size.w, item.size.d) / 2 + reach
  const tops: number[] = []
  for (const o of others) {
    if (exclude?.has(o.id) || !canSupport(o)) continue
    const ro = Math.hypot(o.size.w, o.size.d) / 2
    if (Math.hypot(o.x - item.x, o.y - item.y) > r + ro) continue
    const top = o.elevation + o.size.h
    if (!tops.some((t) => Math.abs(t - top) <= 5)) tops.push(top)
  }
  return tops.sort((a, b) => b - a)
}

/**
 * The surface the item stands on: the highest support top ≤ `maxTop` covering at least `minCover`
 * of its footprint (TV on a stand, vase on a table, bar counter on base units), or null.
 */
export function findSupport(
  item: Pick<ItemPose, 'x' | 'y' | 'rotation' | 'size'>,
  others: Iterable<SupportCandidate>,
  opts: { exclude?: ReadonlySet<string>; maxTop?: number; minCover?: number } = {},
): { top: number; cover: number } | null {
  const list = [...others]
  const minCover = opts.minCover ?? 0.5
  for (const top of supportTops(item, list, opts.exclude)) {
    if (opts.maxTop !== undefined && top > opts.maxTop + 0.5) continue
    const cover = supportCoverage(item, list, top, opts.exclude)
    if (cover >= minCover) return { top, cover }
  }
  return null
}

// ───────────────────────────── per-type limits ─────────────────────────────

const MIN_DEFAULT: ItemSize = { w: 20, d: 10, h: 5 }
const MIN_BY_KIND: Partial<Record<ProceduralKind, ItemSize>> = {
  kitchenBase: { w: 150, d: 250, h: 300 },
  kitchenWall: { w: 150, d: 150, h: 200 },
  kitchenTall: { w: 150, d: 250, h: 900 },
  worktop: { w: 150, d: 150, h: 10 },
  wardrobe: { w: 250, d: 250, h: 300 },
  shelf: { w: 150, d: 80, h: 12 },
  table: { w: 250, d: 250, h: 200 },
  chair: { w: 280, d: 280, h: 400 },
  bed: { w: 600, d: 1200, h: 200 },
  sofa: { w: 500, d: 500, h: 350 },
  fridge: { w: 300, d: 300, h: 500 },
  bathtub: { w: 1000, d: 500, h: 350 },
  stairs: { w: 500, d: 500, h: 300 },
}
export const MAX_ITEM_MM = 30000

/** smallest sensible size of an item made from `asset` */
export function minItemSize(asset: Pick<Asset, 'kind' | 'procedural'> | undefined): ItemSize {
  return (asset?.kind === 'procedural' && asset.procedural && MIN_BY_KIND[asset.procedural]) || MIN_DEFAULT
}

/** clamps a size to the per-type minimum and MAX_ITEM_MM */
export function clampItemSize(size: ItemSize, asset: Pick<Asset, 'kind' | 'procedural'> | undefined): ItemSize {
  const min = minItemSize(asset)
  const c = (v: number, m: number) => Math.min(MAX_ITEM_MM, Math.max(m, v))
  return { w: c(size.w, min.w), d: c(size.d, min.d), h: c(size.h, min.h) }
}

type Params = Record<string, number | string | boolean>

/** count parameters of procedural kinds and the axis they are spread over */
const COUNT_PARAMS: Partial<Record<ProceduralKind, Array<{ key: string; axis: ResizeAxis; min: number; max: number }>>> = {
  kitchenBase: [
    { key: 'doors', axis: 'w', min: 1, max: 8 },
    { key: 'drawers', axis: 'h', min: 1, max: 6 },
  ],
  kitchenWall: [{ key: 'doors', axis: 'w', min: 1, max: 8 }],
  kitchenTall: [{ key: 'doors', axis: 'w', min: 1, max: 8 }],
  wardrobe: [
    { key: 'doors', axis: 'w', min: 1, max: 12 },
    { key: 'count', axis: 'w', min: 1, max: 12 },
    { key: 'sections', axis: 'w', min: 1, max: 8 },
    { key: 'drawers', axis: 'h', min: 1, max: 8 },
  ],
  shelf: [
    { key: 'shelves', axis: 'h', min: 1, max: 20 },
    { key: 'columns', axis: 'w', min: 1, max: 8 },
  ],
}

const toNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)

/**
 * Item params after a resize from `from` to `to`: doors, drawers, shelves… keep their module size
 * (a 600 mm unit with one door stretched to 1200 mm gets two doors). Counts of 0 (no doors: a drawer
 * unit) and corner units stay as they are. Returns undefined when nothing changes.
 */
export function resizedParams(
  asset: Pick<Asset, 'kind' | 'procedural' | 'defaultParams'> | undefined,
  params: Params | undefined,
  from: ItemSize,
  to: ItemSize,
): Params | undefined {
  if (asset?.kind !== 'procedural' || !asset.procedural) return undefined
  const rules = COUNT_PARAMS[asset.procedural]
  if (!rules) return undefined
  const eff = { ...(asset.defaultParams ?? {}), ...(params ?? {}) }
  if (eff.corner === true || eff.corner === 'true') return undefined
  let out: Params | undefined
  for (const r of rules) {
    const v = toNum(eff[r.key])
    if (v === undefined || v <= 0) continue
    if (!(from[r.axis] > 0) || Math.abs(to[r.axis] - from[r.axis]) < 0.5) continue
    const next = Math.min(r.max, Math.max(r.min, Math.round((v * to[r.axis]) / from[r.axis])))
    if (next === v) continue
    out ??= { ...(params ?? {}) }
    out[r.key] = next
  }
  return out
}

/**
 * Mount after a change of elevation: a floor item lifted into the air becomes free («свободно»),
 * one put onto another item stands on its surface («на поверхности»); other mounts are kept.
 */
export function mountForElevation(current: Item['mount'], elevation: number, onSupport: boolean): Item['mount'] {
  if (current === 'wall' || current === 'ceiling') return current
  if (onSupport) return 'surface'
  if (elevation > 0.5 && current === 'floor') return 'free'
  return current
}
