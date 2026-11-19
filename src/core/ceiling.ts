/**
 * The height of the ceiling a room shows, mm above the level floor, as the 3D view builds it
 * (view3d/build/rooms): the room's own ceiling height, else the lowest wall around it, else the
 * level height; a multilevel ceiling is lower along its border ring, coffers and beams hang below
 * the slab. Ceiling electric points sit on this surface: `syncCeilingElectric` (run with syncRooms
 * after every edit) keeps their height on it when the ceiling, the walls or the level change.
 */
import type { CeilingSpec, DerivedRoom, Doc, Id, Vec2 } from './types'
import { pointInPolygon, projectOnSegment } from './geom'

type RoomShape = Pick<DerivedRoom, 'polygon' | 'holes' | 'edges'>

/** ceiling height of a level, mm (rooms without their own ceiling and points outside rooms) */
export function levelCeiling(doc: Pick<Doc, 'levels' | 'settings'>, levelId: Id): number {
  return doc.levels[levelId]?.height || doc.settings.wallHeight || 2700
}

/** the main (highest) ceiling height of a room, mm */
export function ceilingBaseHeight(
  doc: Pick<Doc, 'walls' | 'levels' | 'settings'>,
  room: Pick<DerivedRoom, 'edges'>,
  spec: CeilingSpec | undefined,
  levelId: Id,
): number {
  if (spec?.height && spec.height > 0) return spec.height
  let h = Infinity
  for (const e of room.edges) {
    const w = doc.walls[e.wallId]
    if (w && (w.kind === 'wall' || w.kind === 'partition')) h = Math.min(h, w.height)
  }
  return Number.isFinite(h) ? h : levelCeiling(doc, levelId)
}

const MULTI_BORDER = 400
const MULTI_DROP = 100

/** the lines of beams / coffers across the room: as view3d/build/rooms `beams()` lays them out */
function beamLines(poly: readonly Vec2[], axis: 'x' | 'y', spacing: number): number[] {
  let min = Infinity
  let max = -Infinity
  for (const p of poly) {
    const v = axis === 'x' ? p.x : p.y
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  const span = max - min
  if (!Number.isFinite(span) || span <= 0) return []
  const n = Math.max(1, Math.round(span / spacing) - 1)
  const step = span / (n + 1)
  const out: number[] = []
  for (let i = 1; i <= n; i++) out.push(min + step * i)
  return out
}

interface Lowered {
  /** how far below the main height, mm */
  drop: number
  /** the point is under this part */
  under(x: number, y: number): boolean
}

function loweredParts(room: RoomShape, spec: CeilingSpec | undefined): Lowered[] {
  if (!spec) return []
  const poly = room.polygon
  if (spec.kind === 'multilevel') {
    const bw = Math.max(100, spec.borderWidth ?? MULTI_BORDER)
    const drop = Math.max(20, spec.borderDrop ?? MULTI_DROP)
    // the ring: closer to the room outline than the border width
    return [{ drop, under: (x, y) => distToOutline(poly, x, y) < bw }]
  }
  if (spec.kind === 'coffered' || spec.kind === 'beams') {
    const coffered = spec.kind === 'coffered'
    let alongX = true
    if (!coffered) {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const p of poly) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
      }
      // beams span the shorter direction of the room
      alongX = maxX - minX >= maxY - minY
    }
    const spacing = coffered ? 900 : 1000
    const half = (coffered ? 120 : 150) / 2
    const drop = coffered ? 100 : 180
    const xs = coffered || alongX ? beamLines(poly, 'x', spacing) : []
    const ys = coffered || !alongX ? beamLines(poly, 'y', spacing) : []
    return [{ drop, under: (x, y) => xs.some((c) => Math.abs(x - c) <= half) || ys.some((c) => Math.abs(y - c) <= half) }]
  }
  return []
}

function distToOutline(poly: readonly Vec2[], x: number, y: number): number {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const pr = projectOnSegment({ x, y }, a, b)
    d = Math.min(d, Math.hypot(pr.point.x - x, pr.point.y - y))
  }
  return d
}

/** the ceiling surface of a room right above (x, y), mm */
export function ceilingSurfaceAt(room: RoomShape, spec: CeilingSpec | undefined, base: number, x: number, y: number): number {
  let h = base
  for (const part of loweredParts(room, spec)) if (part.under(x, y)) h = Math.min(h, base - part.drop)
  return h
}

/** the distinct heights a room's ceiling surfaces are at, mm (the main one first) */
export function ceilingHeights(room: RoomShape, spec: CeilingSpec | undefined, base: number): number[] {
  const out = [base]
  for (const part of loweredParts(room, spec)) if (!out.includes(base - part.drop)) out.push(base - part.drop)
  return out
}

/** a detected room with the ceiling it shows */
export interface CeilingRoom {
  room: RoomShape
  spec: CeilingSpec | undefined
}

/** the ceiling height at a plan point of a level: of the room it is in, else the level height */
export function ceilingHeightAt(
  doc: Pick<Doc, 'walls' | 'levels' | 'settings'>,
  levelId: Id,
  rooms: readonly CeilingRoom[],
  x: number,
  y: number,
): number {
  for (const r of rooms) {
    if (!pointInPolygon({ x, y }, r.room.polygon, r.room.holes)) continue
    return ceilingSurfaceAt(r.room, r.spec, ceilingBaseHeight(doc, r.room, r.spec, levelId), x, y)
  }
  return levelCeiling(doc, levelId)
}

/**
 * Puts the ceiling points of a level on the ceiling above them (the room ceiling height, the
 * multilevel border, a beam). Run after every edit (store/document via syncRooms), so the 2D tool,
 * the inspector, the AI tools, drags and changes of the ceiling, the walls or the level all agree.
 */
export function syncCeilingElectric(doc: Doc, levelId: Id, rooms: readonly CeilingRoom[]): void {
  const pts = doc.electrical
  if (!pts) return
  for (const id in pts) {
    const p = pts[id]
    if (p.levelId !== levelId || p.mount !== 'ceiling') continue
    const h = ceilingHeightAt(doc, levelId, rooms, p.x, p.y)
    if (Math.abs(p.elevation - h) > 0.5) p.elevation = h
  }
}
