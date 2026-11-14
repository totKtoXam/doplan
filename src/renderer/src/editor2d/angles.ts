/**
 * Pure geometry of wall junction angles (plan mm, y down, so a growing atan2 angle turns
 * clockwise on screen). No Pixi / store imports: shared by the overlay, the wall tool, the
 * inspector and the unit tests.
 */
import type { DerivedRoom, Doc, Id, Vec2 } from '@core/types'
import { pointInPolygon } from './geom'

const TAU = Math.PI * 2

/** normalises radians to [0, 2π) */
export function wrapRad(a: number): number {
  const r = a % TAU
  return r < 0 ? r + TAU : r
}

/** one ray leaving the junction (a wall seen from the node) */
export interface Ray {
  /** wall id, or any caller-defined key ('new' for the segment being drawn) */
  id: string
  /** atan2(dy, dx) of the direction away from the node, radians */
  angle: number
}

/** angular sector between two consecutive rays, swept from `from` to `to` in growing atan2 */
export interface Sector {
  from: Ray
  to: Ray
  /** start direction, radians (= from.angle) */
  start: number
  /** sweep, radians, in (0, 2π]; a single ray gives one full 2π sector */
  sweep: number
  /** sweep in degrees */
  deg: number
  /** bisector direction, radians */
  mid: number
}

export function rayTo(id: string, center: Vec2, p: Vec2): Ray | null {
  const dx = p.x - center.x
  const dy = p.y - center.y
  if (Math.hypot(dx, dy) < 1e-6) return null
  return { id, angle: wrapRad(Math.atan2(dy, dx)) }
}

/**
 * Sectors between consecutive rays sorted around the centre. n rays give n sectors whose sweeps
 * add up to 360°. Coincident rays (two walls on top of each other) give a zero sector which is
 * dropped. Fewer than one ray → no sectors.
 */
export function sectorsOf(rays: readonly Ray[]): Sector[] {
  if (!rays.length) return []
  const sorted = [...rays].sort((a, b) => a.angle - b.angle)
  const out: Sector[] = []
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i]
    const to = sorted[(i + 1) % sorted.length]
    let sweep = to.angle - from.angle
    if (sorted.length === 1) sweep = TAU
    else if (i === sorted.length - 1) sweep += TAU
    if (sweep < 1e-9) continue
    out.push({ from, to, start: from.angle, sweep, deg: (sweep * 180) / Math.PI, mid: wrapRad(from.angle + sweep / 2) })
  }
  return out
}

/** walls of `nodeId` (on its level) as rays leaving the node; walls with a degenerate length are skipped */
export function nodeRays(doc: Doc, nodeId: Id): Ray[] {
  const n = doc.nodes[nodeId]
  if (!n) return []
  const out: Ray[] = []
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a !== nodeId && w.b !== nodeId) continue
    if (w.a === w.b) continue
    const far = doc.nodes[w.a === nodeId ? w.b : w.a]
    if (!far) continue
    const r = rayTo(id, n, far)
    if (r) out.push(r)
  }
  return out
}

/** number of walls meeting at the node */
export function nodeDegree(doc: Doc, nodeId: Id): number {
  let k = 0
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a === nodeId || w.b === nodeId) k++
  }
  return k
}

const smallest = (sectors: readonly Sector[]): Sector => sectors.reduce((a, b) => (b.deg < a.deg ? b : a))

/**
 * Which sectors are worth labelling at a junction (`insideRoom` tells whether a sector's bisector
 * points into a room). A node with a single wall has nothing to measure.
 *  - the sectors that lie inside rooms, when there are any (so an outer building corner shows 90°
 *    and not also 270°, and a partition meeting the outer wall shows 90° + 90° without the 180°
 *    outside);
 *  - otherwise (no rooms around): a corner shows its convex angle, a junction of three or more
 *    walls every sector up to 180° (at least the smallest one).
 */
export function visibleSectors(sectors: readonly Sector[], insideRoom: (s: Sector) => boolean): Sector[] {
  if (sectors.length < 2) return []
  const inRoom = sectors.filter(insideRoom)
  if (inRoom.length) return inRoom
  if (sectors.length === 2) return [smallest(sectors)]
  const out = sectors.filter((s) => s.deg <= 180.05)
  return out.length ? out : [smallest(sectors)]
}

/**
 * The single angle a two-wall node exposes in the inspector: the sector inside a room when exactly
 * one of the two is, otherwise the smaller one. Null unless exactly two non-coincident walls meet.
 */
export function primarySector(rays: readonly Ray[], insideRoom: (s: Sector) => boolean): Sector | null {
  if (rays.length !== 2) return null
  const s = sectorsOf(rays)
  if (s.length !== 2) return null
  const inRoom = s.filter(insideRoom)
  return inRoom.length === 1 ? inRoom[0] : smallest(s)
}

/**
 * New position of `far` after rotating it around `center` so that the sector measured from the
 * fixed ray to the moving one (in growing atan2, i.e. clockwise on screen) becomes `deg`.
 * `movingIsTo` says whether the moving wall is the `to` side of the sector (then it is turned to
 * fixed + deg) or the `from` side (fixed − deg). The distance to `center` is kept.
 */
export function rotateAround(center: Vec2, far: Vec2, fixedAngle: number, deg: number, movingIsTo: boolean): Vec2 {
  const r = Math.hypot(far.x - center.x, far.y - center.y)
  const a = fixedAngle + ((movingIsTo ? 1 : -1) * deg * Math.PI) / 180
  return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r }
}

/**
 * `insideRoom` predicate for sectors at `center`: probes a point on the bisector just beyond the
 * wall faces (far enough to clear `halfThickness` even in a narrow sector) and tests it against
 * the derived room polygons of the level.
 */
export function roomProbe(
  rooms: readonly Pick<DerivedRoom, 'polygon' | 'holes'>[],
  center: Vec2,
  halfThickness: number,
  maxDist = Infinity,
): (s: Sector) => boolean {
  return (s) => {
    if (!rooms.length) return false
    // distance of a bisector point to either wall line is d·|sin(sweep/2)| (narrow and reflex alike)
    const k = Math.max(0.05, Math.abs(Math.sin(s.sweep / 2)))
    const need = (halfThickness + 40) / k
    const inside = (d: number): boolean => {
      const p = { x: center.x + Math.cos(s.mid) * d, y: center.y + Math.sin(s.mid) * d }
      return rooms.some((r) => pointInPolygon(p, r.polygon) && !r.holes.some((h) => pointInPolygon(p, h)))
    }
    // capped by the wall lengths; when the cap leaves the point inside the wall body, try the full distance too
    const d = Math.min(maxDist, need)
    return inside(d) || (d < need && inside(need))
  }
}

/** room probe for a node of the document: wall half-thickness and wall lengths taken from its walls */
export function nodeRoomProbe(doc: Doc, rooms: readonly Pick<DerivedRoom, 'polygon' | 'holes'>[], nodeId: Id): (s: Sector) => boolean {
  const n = doc.nodes[nodeId]
  if (!n) return () => false
  let half = 0
  let shortest = Infinity
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a !== nodeId && w.b !== nodeId) continue
    if (w.kind !== 'virtual') half = Math.max(half, w.thickness / 2)
    const f = doc.nodes[w.a === nodeId ? w.b : w.a]
    if (f) shortest = Math.min(shortest, Math.hypot(f.x - n.x, f.y - n.y))
  }
  return roomProbe(rooms, n, half, Number.isFinite(shortest) ? Math.max(shortest * 0.9, half + 20) : Infinity)
}

export interface AnglePlan {
  /** wall that keeps its direction */
  fixedWallId: Id
  /** wall that turns around the node */
  movingWallId: Id
  /** far node of the moving wall: the only node that moves */
  movingNodeId: Id
  /** its new position */
  to: Vec2
}

/**
 * Plans the edit "make the angle at a two-wall node equal to `deg`" while keeping the sector on the
 * same side: the wall whose far end has fewer connections turns around the node (on a tie the
 * shorter one), keeping its length. Returns null when the node does not have exactly two walls, the
 * angle is out of (0°, 360°) or `sector` does not belong to this node.
 */
export function planNodeAngle(doc: Doc, nodeId: Id, sector: Pick<Sector, 'from' | 'to'>, deg: number): AnglePlan | null {
  if (!(deg > 0 && deg < 360)) return null
  const n = doc.nodes[nodeId]
  if (!n) return null
  const ids: Id[] = []
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a === nodeId || w.b === nodeId) ids.push(id)
  }
  if (ids.length !== 2 || !ids.includes(sector.from.id) || !ids.includes(sector.to.id) || sector.from.id === sector.to.id) return null
  const farOf = (wid: Id): Id => {
    const w = doc.walls[wid]
    return w.a === nodeId ? w.b : w.a
  }
  const score = (wid: Id): [number, number] => {
    const f = doc.nodes[farOf(wid)]
    return [nodeDegree(doc, farOf(wid)), f ? Math.hypot(f.x - n.x, f.y - n.y) : Infinity]
  }
  const [fa, la] = score(sector.from.id)
  const [ta, lb] = score(sector.to.id)
  // the freer wall moves (fewer links, then shorter, then by id), independent of the sector order
  const fromFreer = fa !== ta ? fa < ta : Math.abs(la - lb) > 1e-6 ? la < lb : sector.from.id < sector.to.id
  const movingIsTo = !fromFreer
  const moving = movingIsTo ? sector.to.id : sector.from.id
  const fixed = movingIsTo ? sector.from.id : sector.to.id
  const farId = farOf(moving)
  const far = doc.nodes[farId]
  const fixedFar = doc.nodes[farOf(fixed)]
  if (!far || !fixedFar || farId === nodeId) return null
  const fixedAngle = Math.atan2(fixedFar.y - n.y, fixedFar.x - n.x)
  return { fixedWallId: fixed, movingWallId: moving, movingNodeId: farId, to: rotateAround(n, far, fixedAngle, deg, movingIsTo) }
}

/**
 * Angle of a direction to the nearest horizontal half-axis (+x or −x), degrees in [0, 90], with the
 * axis direction it is measured from (radians, 0 or π).
 */
export function angleToHorizontal(dir: Vec2): { deg: number; axis: number } {
  const a = Math.atan2(dir.y, dir.x)
  const right = Math.abs(a)
  const left = Math.PI - Math.abs(a)
  return right <= left ? { deg: (right * 180) / Math.PI, axis: 0 } : { deg: (left * 180) / Math.PI, axis: Math.PI }
}
