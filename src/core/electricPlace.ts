/**
 * Placing electric points from a 3D ray (the 3D view in orbit and in walk mode): which surface the
 * ray hits (a wall face, the floor, the ceiling), whether a point fits there (not in a door or
 * window opening), snaps (standard heights, neighbouring points, clearances from corners and
 * openings) and the live dimensions shown while a point is moved. Pure geometry on the document,
 * plan millimetres: x, y as on the plan, z = height above the level floor.
 */
import type { Doc, ElectricKind, ElectricPoint, Id, Opening, Wall } from './types'
import {
  ELECTRIC_HEIGHT_PRESETS,
  electricGangs,
  electricHalfWidth,
  electricType,
  isMountableWall,
  wallFacePoint,
  wallFaceRange,
  wallHidden,
} from './electrical'

/** a ray in plan millimetres (z up); the direction need not be unit length */
export interface PlanRay {
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
}

export type ElectricSurface = 'wall' | 'floor' | 'ceiling'

export interface ElectricSurfaceHit {
  surface: ElectricSurface
  /** hit point, plan mm; z = height above the floor */
  x: number
  y: number
  z: number
  /** ray parameter of the hit (in units of the ray direction) */
  s: number
  /** wall hits: the face and the distance along the wall from node a */
  wallId?: Id
  side?: 'left' | 'right'
  t?: number
}

type PointShape = Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical'>

/** half the size of a point across its wall (vertically for wall points), mm */
export function electricHalfHeight(p: PointShape): number {
  const ty = electricType(p.kind)
  if (ty.framed) return 43 + (p.vertical ? (electricGangs(p) - 1) * 35.5 : 0)
  if (ty.device === 'panel') return 200
  if (ty.device === 'box') return 42
  if (ty.device === 'cable') return 40
  return 30
}

/** ceiling height of a level, mm (as addElectric puts ceiling points) */
export function levelCeiling(doc: Pick<Doc, 'levels' | 'settings'>, levelId: Id): number {
  return doc.levels[levelId]?.height || doc.settings.wallHeight || 2700
}

/**
 * The nearest surface a ray hits on a level: a face of a mountable, visible wall (from its front,
 * within the wall height), else the floor or the ceiling plane. `surfaces` limits what counts.
 */
export function rayElectricSurface(
  doc: Pick<Doc, 'nodes' | 'walls' | 'levels' | 'settings'> & Partial<Pick<Doc, 'layers' | 'groupFlags'>>,
  levelId: Id,
  ray: PlanRay,
  surfaces: ReadonlySet<ElectricSurface> = new Set(['wall', 'floor', 'ceiling']),
): ElectricSurfaceHit | null {
  let best: ElectricSurfaceHit | null = null
  const ceiling = levelCeiling(doc, levelId)
  if (surfaces.has('wall')) {
    for (const id in doc.walls) {
      const w = doc.walls[id]
      if (w.levelId !== levelId || !isMountableWall(w) || wallHidden(doc, w)) continue
      for (const side of ['left', 'right'] as const) {
        const hit = rayFace(doc, w, side, ray)
        if (hit && (!best || hit.s < best.s)) best = hit
      }
    }
  }
  const planes: Array<[ElectricSurface, number]> = [
    ['floor', 0],
    ['ceiling', ceiling],
  ]
  for (const [surface, z] of planes) {
    if (!surfaces.has(surface) || Math.abs(ray.dz) < 1e-9) continue
    // the floor is seen from above, the ceiling from below
    if (surface === 'floor' ? ray.dz >= 0 || ray.oz < z : ray.dz <= 0 || ray.oz > z) continue
    const s = (z - ray.oz) / ray.dz
    if (s <= 0 || (best && s >= best.s)) continue
    best = { surface, x: ray.ox + ray.dx * s, y: ray.oy + ray.dy * s, z, s }
  }
  return best
}

function rayFace(doc: Pick<Doc, 'nodes' | 'walls'>, w: Wall, side: 'left' | 'right', ray: PlanRay): ElectricSurfaceHit | null {
  const f0 = wallFacePoint(doc, w.id, side, 0)
  const a = doc.nodes[w.a]
  const b = doc.nodes[w.b]
  if (!f0 || !a || !b) return null
  const len = f0.len
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  const nx = Math.cos((f0.rotation * Math.PI) / 180)
  const ny = Math.sin((f0.rotation * Math.PI) / 180)
  const denom = ray.dx * nx + ray.dy * ny
  if (denom > -1e-9) return null // seen from behind or along it
  const s = ((f0.point.x - ray.ox) * nx + (f0.point.y - ray.oy) * ny) / denom
  if (s <= 0) return null
  const x = ray.ox + ray.dx * s
  const y = ray.oy + ray.dy * s
  const z = ray.oz + ray.dz * s
  if (z < 0 || z > w.height) return null
  const t = (x - f0.point.x) * ux + (y - f0.point.y) * uy
  const range = wallFaceRange(doc, w.id, side, 0)
  if (!range || t < range.lo - 1 || t > range.hi + 1) return null
  return { surface: 'wall', x, y, z, s, wallId: w.id, side, t }
}

/**
 * The door or window opening of a wall that a wall point at `t` (along the wall from node a),
 * `h` (centre height) would overlap, `gap` mm clearance included. Openings cut the wall through,
 * so both faces count.
 */
export function openingAtWallPoint(
  doc: Pick<Doc, 'openings'>,
  wallId: Id,
  t: number,
  h: number,
  p: PointShape,
  gap = 0,
): Opening | null {
  const hw = electricHalfWidth(p) + gap
  const hh = electricHalfHeight(p) + gap
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (o.wallId !== wallId) continue
    if (Math.abs(t - o.offset) >= o.width / 2 + hw) continue
    if (h + hh <= o.sill || h - hh >= o.sill + o.height) continue
    return o
  }
  return null
}

/** what a snapped value is aligned to (for the hint and the guide lines) */
export type ElectricSnapKind = 'preset' | 'default' | 'neighbour' | 'corner' | 'opening'

export interface ElectricSnap {
  t: number
  h: number
  /** the height was snapped to … */
  hSnap?: { kind: ElectricSnapKind; value: number; id?: Id }
  /** the position along the wall was snapped to … */
  tSnap?: { kind: ElectricSnapKind; value: number; id?: Id }
  /** the opening the point would sit in (the placement is not allowed) */
  blocked: Opening | null
}

/** clearances of a point's edge from a room corner and from an opening edge, mm */
export const ELECTRIC_CLEARANCES: readonly number[] = [100, 150, 200, 300]

export interface ElectricSnapOptions {
  /** the point being moved (it is not its own neighbour) */
  selfId?: Id
  /** snap distance, mm (from the pixel size at the cursor); 0 = no snaps */
  tol: number
  /** neighbours further than this along the wall are not aligned with, mm */
  reach?: number
}

/**
 * Snaps a wall point at (t, h) on a face: the height to the standard heights (ELECTRIC_HEIGHT_PRESETS),
 * the type's height and the heights of points on the same face; the position along the wall to the
 * points on the same face (one above another), to clearances from the room corners and from the
 * opening edges (ELECTRIC_CLEARANCES, measured to the point's edge). `t` is kept on the face
 * (wallFaceRange). `blocked` tells when the point would be in an opening.
 */
export function snapElectricOnWall(
  doc: Pick<Doc, 'nodes' | 'walls' | 'openings'> & Partial<Pick<Doc, 'electrical'>>,
  wallId: Id,
  side: 'left' | 'right',
  t: number,
  h: number,
  p: PointShape,
  opts: ElectricSnapOptions,
): ElectricSnap {
  const half = electricHalfWidth(p)
  const halfH = electricHalfHeight(p)
  const w = doc.walls[wallId]
  const range = wallFaceRange(doc, wallId, side, half)
  const maxH = Math.max(halfH, (w?.height ?? 2700) - halfH)
  let tt = range ? Math.min(range.hi, Math.max(range.lo, t)) : t
  let hh = Math.min(maxH, Math.max(halfH, h))
  const out: ElectricSnap = { t: tt, h: hh, blocked: null }
  const tol = opts.tol
  if (tol > 0) {
    const reach = opts.reach ?? 3000
    const neighbours = Object.values(doc.electrical ?? {}).filter(
      (q) => q.id !== opts.selfId && q.mount === 'wall' && q.wallId === wallId && q.side === side,
    )
    // height
    let bestH = tol
    const tryH = (value: number, kind: ElectricSnapKind, id?: Id): void => {
      const d = Math.abs(value - hh)
      if (d < bestH || (d === bestH && kind === 'neighbour')) {
        bestH = d
        out.hSnap = { kind, value, id }
      }
    }
    for (const pr of ELECTRIC_HEIGHT_PRESETS) tryH(pr.h, 'preset')
    const ty = electricType(p.kind)
    if (ty.mount === 'wall') tryH(ty.elevation, 'default')
    for (const q of neighbours) {
      const qt = faceT(doc, q, wallId)
      if (qt !== null && Math.abs(qt - tt) <= reach) tryH(q.elevation, 'neighbour', q.id)
    }
    if (out.hSnap) hh = out.hSnap.value
    // along the wall
    let bestT = tol
    const tryT = (value: number, kind: ElectricSnapKind, id?: Id): void => {
      if (range && (value < range.lo - 0.5 || value > range.hi + 0.5)) return
      const d = Math.abs(value - tt)
      if (d < bestT) {
        bestT = d
        out.tSnap = { kind, value, id }
      }
    }
    for (const q of neighbours) {
      const qt = faceT(doc, q, wallId)
      if (qt !== null && Math.abs(q.elevation - hh) > 1) tryT(qt, 'neighbour', q.id)
    }
    if (range) {
      const ends = faceEnds(doc, wallId, side)
      for (const c of ELECTRIC_CLEARANCES) {
        if (ends.lo > 0.5) tryT(ends.lo + c + half, 'corner')
        if (ends.hi < range.len - 0.5) tryT(ends.hi - c - half, 'corner')
      }
    }
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (o.wallId !== wallId) continue
      for (const c of ELECTRIC_CLEARANCES) {
        tryT(o.offset - o.width / 2 - c - half, 'opening', o.id)
        tryT(o.offset + o.width / 2 + c + half, 'opening', o.id)
      }
    }
    if (out.tSnap) tt = out.tSnap.value
  }
  out.t = tt
  out.h = hh
  out.blocked = openingAtWallPoint(doc, wallId, tt, hh, p)
  return out
}

/** the ends of a face where adjoining walls cover it (wallFaceRange without the point's half size) */
function faceEnds(doc: Pick<Doc, 'nodes' | 'walls'>, wallId: Id, side: 'left' | 'right'): { lo: number; hi: number } {
  const r = wallFaceRange(doc, wallId, side, 0)
  return r ? { lo: r.lo, hi: r.hi } : { lo: 0, hi: 0 }
}

/** distance along the wall from node a of a point */
function faceT(doc: Pick<Doc, 'nodes' | 'walls'>, q: Pick<ElectricPoint, 'x' | 'y'>, wallId: Id): number | null {
  const w = doc.walls[wallId]
  const a = w && doc.nodes[w.a]
  const b = w && doc.nodes[w.b]
  if (!a || !b) return null
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < 1e-6) return null
  return ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / len
}

/** a live dimension of a wall point on its face: from (t0, h0) to (t1, h1), both along the face */
export interface ElectricDim {
  kind: 'floor' | 'corner' | 'opening' | 'neighbour' | 'ceiling'
  t0: number
  h0: number
  t1: number
  h1: number
  /** the measured distance, mm */
  value: number
}

/**
 * Dimensions of a wall point at (t, h) on a face, as shown while it is moved: the height of its
 * centre above the floor, the clear distance from its edges to the nearest obstacle along the wall
 * on both sides (a room corner or an opening edge), and the centre distance to the nearest point
 * on the same face.
 */
export function electricWallDims(
  doc: Pick<Doc, 'nodes' | 'walls' | 'openings'> & Partial<Pick<Doc, 'electrical'>>,
  wallId: Id,
  side: 'left' | 'right',
  t: number,
  h: number,
  p: PointShape,
  selfId?: Id,
): ElectricDim[] {
  const out: ElectricDim[] = [{ kind: 'floor', t0: t, h0: 0, t1: t, h1: h, value: h }]
  const half = electricHalfWidth(p)
  const r = wallFaceRange(doc, wallId, side, 0)
  if (!r) return out
  let lo: { t: number; kind: ElectricDim['kind'] } = { t: r.lo, kind: 'corner' }
  let hi: { t: number; kind: ElectricDim['kind'] } = { t: r.hi, kind: 'corner' }
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (o.wallId !== wallId) continue
    const e0 = o.offset - o.width / 2
    const e1 = o.offset + o.width / 2
    if (e1 <= t - half + 0.5 && e1 > lo.t) lo = { t: e1, kind: 'opening' }
    if (e0 >= t + half - 0.5 && e0 < hi.t) hi = { t: e0, kind: 'opening' }
  }
  const left = t - half - lo.t
  const right = hi.t - (t + half)
  if (left > 0.5) out.push({ kind: lo.kind, t0: lo.t, h0: h, t1: t - half, h1: h, value: left })
  if (right > 0.5) out.push({ kind: hi.kind, t0: t + half, h0: h, t1: hi.t, h1: h, value: right })
  let near: { t: number; h: number; d: number } | null = null
  for (const q of Object.values(doc.electrical ?? {})) {
    if (q.id === selfId || q.mount !== 'wall' || q.wallId !== wallId || q.side !== side) continue
    const qt = faceT(doc, q, wallId)
    if (qt === null) continue
    const d = Math.hypot(qt - t, q.elevation - h)
    if (d > 1 && d < 2000 && (!near || d < near.d)) near = { t: qt, h: q.elevation, d }
  }
  if (near) out.push({ kind: 'neighbour', t0: t, h0: h, t1: near.t, h1: near.h, value: near.d })
  return out
}

/** the next / previous kind in the catalog order (walk-mode keys) */
export function cycleElectricKind(kinds: readonly ElectricKind[], kind: ElectricKind, step: 1 | -1): ElectricKind {
  const i = kinds.indexOf(kind)
  if (i < 0) return kinds[0]
  return kinds[(i + step + kinds.length) % kinds.length]
}
