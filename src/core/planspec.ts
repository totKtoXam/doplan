/**
 * PlanSpec v1 — a compact, human/LLM-writable plan description (docs/research/photo-to-plan.md §4–5).
 *
 * Two authoring modes (can be mixed):
 *  - rooms-mode: rooms are CLEAR interior rectangles/polygons; walls are deduced from the gaps
 *    between rooms (gap width = wall thickness), unmatched room edges get exterior walls
 *    (or the room's `edgeWall`, e.g. a balcony railing) placed outside.
 *  - walls-mode: `walls[]` centre-line polylines are authoritative; rooms are given by a label
 *    point `at` (or rect/polygon used only for matching).
 *
 * Coordinates: x → right, y → DOWN. Plan measures (points, rects, widths, offsets) are in
 * `units` (mm | cm | m | px). Thicknesses, heights, sills and every `defaults` value are ALWAYS mm.
 * px needs `source.mmPerPx` or `source.calibration`.
 *
 * Pure TS: no DOM / Node imports.
 */
import type { Asset, DimSource, Doc, DoorLeafStyle, DoorSlide, Id, Item, OpeningKind, ProceduralKind, Room, RoomType, Underlay, Vec2, Wall, WallKind } from './types'
import { DOOR_LEAF_STYLES, DOOR_SLIDES } from './types'
import { BUILTIN_ASSETS, createEmptyDoc, defaultRoom, OPENING_DEFAULTS, ROOM_TYPE_NAMES } from './defaults'
import { addItem, addOpening, addWall, normalize, syncRooms } from './ops'
import { derivePlan } from './derive'
import { newId } from './ids'
import { makeProvenance } from './provenance'

// ───────────────────────────── schema ─────────────────────────────

export type PlanUnits = 'mm' | 'cm' | 'm' | 'px'
/** [x, y] in spec units */
export type PlanPoint = number[]

export const SPEC_WALL_KINDS = ['exterior', 'loadBearing', 'partition', 'parapet', 'railing', 'glass', 'separator'] as const
export type SpecWallKind = (typeof SPEC_WALL_KINDS)[number]

export const SPEC_ROOM_TYPES = [
  'living',
  'bedroom',
  'kitchen',
  'kitchenLiving',
  'bathroom',
  'toilet',
  'hallway',
  'corridor',
  'balcony',
  'loggia',
  'wardrobe',
  'office',
  'kids',
  'storage',
  'other',
  // PlanSpec aliases (report vocabulary)
  'study',
  'dining',
  'hall',
  'combinedBathroom',
  'laundry',
  'terrace',
  'utility',
] as const
export type SpecRoomType = (typeof SPEC_ROOM_TYPES)[number]

export const SPEC_OPENING_TYPES = [
  'door',
  'doubleDoor',
  'slidingDoor',
  'entranceDoor',
  'arch',
  'opening',
  'window',
  'frenchWindow',
  'balconyDoor',
  'balconyBlock',
  // aliases
  'pocketDoor',
  'foldingDoor',
  'passage',
  'panoramicWindow',
] as const
export type SpecOpeningType = (typeof SPEC_OPENING_TYPES)[number]

export type RoomSide = 'top' | 'right' | 'bottom' | 'left'

export const SPEC_DIM_SOURCES = ['plan', 'derived', 'estimated', 'measured', 'drawn'] as const

/**
 * Where a dimension comes from: 'plan' (printed, ±10 mm), 'derived' (from an area / a chain of printed
 * numbers, ±20 mm), 'estimated' (photo pixels, ±50 mm), 'measured' (tape / laser), 'drawn' (unknown).
 * Object form adds the tolerance (± mm), the measurement date (YYYY-MM-DD) and a note.
 */
export type SpecDimSource = DimSource | { source: DimSource; tol?: number; date?: string; note?: string }

/**
 * Per-room sources: one value for every side; for `rect` an object by side
 * ({top, right, bottom, left}) or an array [top, right, bottom, left]; for `polygon` an array by edge
 * (edge i = polygon[i] → polygon[i+1]).
 */
export type SpecRoomDimSources = SpecDimSource | Partial<Record<RoomSide, SpecDimSource>> | SpecDimSource[]

export interface PlanCalibration {
  p1: PlanPoint
  p2: PlanPoint
  /** real distance between p1 and p2, mm */
  mm: number
  label?: string
}

export interface PlanSource {
  /** prepped image the px coordinates refer to */
  image?: string
  /** [w, h] px of source.image */
  size?: number[]
  kind?: string
  mmPerPx?: number
  /** only if anisotropic */
  mmPerPxY?: number
  /** px position of mm (0,0); default [0,0] */
  originPx?: PlanPoint
  calibration?: PlanCalibration[]
  /** m² as printed */
  labelledTotalArea?: number
  labelledLivingArea?: number
  /** honest explanation of a remaining total / living area mismatch */
  areaNote?: string
  toScale?: boolean
}

/** all values mm */
export interface PlanDefaults {
  ceilingHeight?: number
  wallHeight?: number
  exteriorThickness?: number
  /** alias of exteriorThickness */
  outerThickness?: number
  loadBearingThickness?: number
  partitionThickness?: number
  /** alias of partitionThickness */
  innerThickness?: number
  doorHeight?: number
  windowSill?: number
  windowHeight?: number
  railingHeight?: number
  railingThickness?: number
}

export interface PlanSnap {
  /** snap near-orthogonal edges of polygons/paths (default true) */
  orthogonal?: boolean
  orthoToleranceDeg?: number
  /** round converted coordinates to this grid (default 10 for px, none otherwise) */
  gridMm?: number
  /** collinear bridge / T-join distance, default max(thickness)/2 + 50 */
  mergeMm?: number
  /** snap deduced/declared thicknesses within ±15 mm to the standard set (default true) */
  standardThickness?: boolean
}

export interface WallSpec {
  id: string
  /** ≥ 2 points; centre-line unless `align` says otherwise */
  path: PlanPoint[]
  closed?: boolean
  /** inner/outer only for closed paths: the path is the inner/outer FACE of the loop */
  align?: 'center' | 'inner' | 'outer'
  /** mm */
  thickness?: number
  kind?: SpecWallKind
  /** mm */
  height?: number
  confidence?: number
  /** provenance of the faces along this wall: one value, or one per path segment */
  source?: SpecDimSource | SpecDimSource[]
  /**
   * a wall around a technical void (a shaft / box / column cutout), as `doc spec` writes it: it is
   * never bridged with a collinear wall across a strip of floor, and it may be thicker than the
   * exterior walls (a column filled by its walls)
   */
  cutout?: boolean
}

export interface EdgeWallSpec {
  kind: SpecWallKind
  thickness?: number
  height?: number
}

export const SPEC_CUTOUT_KINDS = ['shaft', 'column', 'box'] as const
export type SpecCutoutKind = (typeof SPEC_CUTOUT_KINDS)[number]

/**
 * Something that takes floor area away from a rooms-mode room: a ventilation shaft / riser box in a
 * corner, a column, a boxed pipe. `rect` is its OUTER footprint as seen from the room (spec units),
 * i.e. what is not floor. The compiler subtracts it from the room and builds its walls: sides that
 * face the room get a wall of `wall` mm inside the footprint; sides on the room's own outline keep the
 * wall the room has there. What is left inside is a technical void (a solid column item for
 * `column` / `box`).
 */
export interface CutoutSpec {
  rect: number[]
  kind?: SpecCutoutKind
  /** mm, thickness of the shaft / box walls facing the room (default `defaults.partitionThickness`) */
  wall?: number
  name?: string
}

export interface RoomSpec {
  /** short slug referenced by openings */
  id: string
  name?: string
  type?: SpecRoomType
  number?: string
  /** [x, y, w, h] CLEAR interior rectangle */
  rect?: number[]
  /** clear interior outline (any winding) */
  polygon?: PlanPoint[]
  /** label point inside the room (walls-mode) */
  at?: PlanPoint
  /** m² as printed */
  labelledArea?: number
  /**
   * the printed area already includes a reduction coefficient (БТИ: loggia 0.5, balcony / terrace 0.3):
   * labelledArea = clear area × labelledAreaCoef. Only for the check; the geometry stays real.
   */
  labelledAreaCoef?: number
  /** honest explanation of a remaining area mismatch (lets `dp spec build` proceed) */
  areaNote?: string
  /** shafts, columns, boxes cut out of the floor (rooms-mode) */
  cutouts?: CutoutSpec[]
  /**
   * not floor: the inside of a shaft / riser box drawn as its own closed area (`dp doc spec` writes it
   * for cutout voids). Left out of the totals, the reachability check and the area check.
   */
  technical?: boolean
  /** where the clear dimensions of the sides come from (see SpecRoomDimSources) */
  source?: SpecRoomDimSources
  /** mm */
  ceilingHeight?: number
  /** wall for edges NOT facing another room (balcony railing, glazed loggia) */
  edgeWall?: EdgeWallSpec
  /** treat as an outdoor room (balcony-like) regardless of type */
  balcony?: boolean
  /** balcony/loggia is glazed: default edge wall becomes `glass` */
  glazed?: boolean
  confidence?: number
}

export interface OpeningSpec {
  id?: string
  type: SpecOpeningType
  /** centre of the opening on (or near) the wall */
  at?: PlanPoint
  /** WallSpec id (walls-mode) */
  wall?: string
  /** with `wall`: from wall path start to opening CENTRE along the path; with `room`: from the
   *  start of the side (left end for top/bottom, top end for left/right) to the centre. Spec units. */
  offset?: number
  /** RoomSpec id + side (or polygon edge index) */
  room?: string
  side?: RoomSide
  edge?: number
  /** clear width, spec units */
  width: number
  /** mm */
  height?: number
  /** mm */
  sill?: number
  /** [roomId, roomId | 'outside'] */
  between?: string[]
  /** roomId or 'outside' (swing side) */
  opensInto?: string
  /** hinge side seen from the room the door opens INTO, facing the door */
  hinge?: 'left' | 'right'
  /** exact doc values (round-trip from docToPlanSpec); override opensInto/hinge */
  hingeEnd?: 'a' | 'b'
  swingSide?: 'left' | 'right'
  sashes?: number
  /** slidingDoor: how the leaf slides (pocketDoor / foldingDoor set it too); default surface */
  slide?: DoorSlide
  /** door leaf look: flush | panel | glazed | insert | glass */
  style?: DoorLeafStyle
  confidence?: number
}

/** fixture / furniture hint */
export interface FixtureSpec {
  /** fixture type (riser, bathtub, toilet, stove…) or any ProceduralKind / AssetCategory */
  type: string
  /** [x, y, w, h] footprint, spec units (w/h are along plan x/y) */
  rect?: number[]
  at?: PlanPoint
  /** [w, d, h] mm (overrides rect / asset size) */
  size?: number[]
  /** degrees clockwise */
  rotation?: number
  assetId?: string
  name?: string
  /** mm */
  elevation?: number
}

export interface PlanSpec {
  version: 1
  units: PlanUnits
  name?: string
  source?: PlanSource
  defaults?: PlanDefaults
  snap?: PlanSnap
  walls?: WallSpec[]
  rooms: RoomSpec[]
  openings: OpeningSpec[]
  fixtures?: FixtureSpec[]
  /** alias of fixtures for free-standing furniture hints */
  furniture?: FixtureSpec[]
  /**
   * default provenance of every room side without its own `source`
   * (when absent: 'estimated' for units "px", nothing = drawn otherwise)
   */
  dimSource?: SpecDimSource
  notes?: string[]
}

export type PlanIssueSeverity = 'error' | 'warning' | 'info'

export interface PlanIssue {
  severity: PlanIssueSeverity
  code: string
  message: string
  /** JSON path into the spec, e.g. `rooms[2].rect` */
  path?: string
  ids?: string[]
}

export interface PlanRoomMetric {
  id: string
  /** clear floor area, m² (cutouts subtracted) */
  computed: number
  /** as printed */
  labelled?: number
  /** the printed number is clear area × coef (BTI loggia 0.5, balcony 0.3) */
  coef?: number
  /** computed × coef − labelled */
  delta?: number
  pct?: number
  /** the author's explanation of a known mismatch */
  note?: string
}

export interface PlanValidation {
  ok: boolean
  issues: PlanIssue[]
  metrics: { totalArea: number; livingArea: number; perRoom: PlanRoomMetric[] }
}

// ───────────────────────────── small math ─────────────────────────────

const V = (x: number, y: number): Vec2 => ({ x, y })
const vAdd = (a: Vec2, b: Vec2): Vec2 => V(a.x + b.x, a.y + b.y)
const vSub = (a: Vec2, b: Vec2): Vec2 => V(a.x - b.x, a.y - b.y)
const vMul = (a: Vec2, s: number): Vec2 => V(a.x * s, a.y * s)
const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const vCross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
const vLen = (a: Vec2): number => Math.hypot(a.x, a.y)
const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
const vNorm = (a: Vec2): Vec2 => {
  const l = vLen(a)
  return l > 1e-12 ? V(a.x / l, a.y / l) : V(0, 0)
}
const r3 = (n: number): number => Math.round(n * 1000) / 1000

function signedArea(poly: Vec2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function distToPolyBoundary(p: Vec2, poly: Vec2[]): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const pr = projectOnSeg(p, poly[i], poly[(i + 1) % poly.length])
    if (pr.dist < best) best = pr.dist
  }
  return best
}

function projectOnSeg(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number; along: number } {
  const ab = vSub(b, a)
  const l2 = vDot(ab, ab)
  let t = l2 > 0 ? vDot(vSub(p, a), ab) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  const point = vAdd(a, vMul(ab, t))
  return { point, t, dist: vDist(p, point), along: t * Math.sqrt(l2) }
}

/** p + r·λ = q + s·μ */
function lineHit(p: Vec2, r: Vec2, q: Vec2, s: Vec2): { lambda: number; mu: number; point: Vec2 } | null {
  const den = vCross(r, s)
  if (Math.abs(den) < 1e-9) return null
  const qp = vSub(q, p)
  const lambda = vCross(qp, s) / den
  const mu = vCross(qp, r) / den
  return { lambda, mu, point: vAdd(p, vMul(r, lambda)) }
}

function polygonCentroidOf(poly: Vec2[]): Vec2 {
  const a = signedArea(poly)
  if (Math.abs(a) < 1e-9) {
    let x = 0
    let y = 0
    for (const p of poly) {
      x += p.x
      y += p.y
    }
    return V(x / poly.length, y / poly.length)
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const f = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  return V(cx / (6 * a), cy / (6 * a))
}

/** A point guaranteed inside a simple polygon (centroid if inside, else widest scan-line midpoint). */
function interiorPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroidOf(poly)
  if (pointInPoly(c, poly) && distToPolyBoundary(c, poly) > 1) return c
  let minY = Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  let best: Vec2 = c
  let bestW = -1
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    const y = minY + (maxY - minY) * f
    const xs: number[] = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((m, n) => m - n)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i]
      if (w > bestW) {
        bestW = w
        best = V((xs[i] + xs[i + 1]) / 2, y)
      }
    }
  }
  return best
}

function segsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => vCross(vSub(q, p), vSub(r, p))
  const d1 = o(a, b, c)
  const d2 = o(a, b, d)
  const d3 = o(c, d, a)
  const d4 = o(c, d, b)
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6))
}

function selfIntersects(poly: Vec2[]): boolean {
  const n = poly.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue
      if (segsProperlyIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true
    }
  }
  return false
}

function isConvex(poly: Vec2[]): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const c = poly[(i + 2) % poly.length]
    const cr = vCross(vSub(b, a), vSub(c, b))
    if (Math.abs(cr) < 1e-6) continue
    const s = Math.sign(cr)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Sutherland–Hodgman: subject clipped by a CONVEX clip polygon. */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  const cw = signedArea(clip) > 0 ? 1 : -1
  let out = subject
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    const inside = (p: Vec2) => cw * vCross(vSub(b, a), vSub(p, a)) >= -1e-9
    const input = out
    out = []
    for (let j = 0; j < input.length; j++) {
      const p = input[j]
      const q = input[(j + 1) % input.length]
      const pin = inside(p)
      const qin = inside(q)
      if (pin) out.push(p)
      if (pin !== qin) {
        const h = lineHit(p, vSub(q, p), a, vSub(b, a))
        if (h) out.push(h.point)
      }
    }
  }
  return out
}

/** overlap area of two simple polygons, mm² */
function overlapArea(p: Vec2[], q: Vec2[]): number {
  if (isConvex(q)) return Math.abs(signedArea(clipConvex(p, q)))
  if (isConvex(p)) return Math.abs(signedArea(clipConvex(q, p)))
  // both concave: grid sampling of the bbox intersection
  const bb = (poly: Vec2[]) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const v of poly) {
      x0 = Math.min(x0, v.x)
      y0 = Math.min(y0, v.y)
      x1 = Math.max(x1, v.x)
      y1 = Math.max(y1, v.y)
    }
    return { x0, y0, x1, y1 }
  }
  const a = bb(p)
  const b = bb(q)
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  if (x1 <= x0 || y1 <= y0) return 0
  const n = 120
  const dx = (x1 - x0) / n
  const dy = (y1 - y0) / n
  let hits = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const s = V(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy)
      if (pointInPoly(s, p) && pointInPoly(s, q)) hits++
    }
  }
  return hits * dx * dy
}

// ───────────────────────────── parsing / coercion ─────────────────────────────

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

class Coercer {
  issues: PlanIssue[] = []
  err(path: string, message: string): void {
    this.issues.push({ severity: 'error', code: 'SCHEMA', message, path })
  }
  num(o: Obj, key: string, path: string, required = false): number | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) {
      if (required) this.err(`${path}.${key}`, `Поле «${key}» обязательно (число)`)
      return undefined
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        this.err(`${path}.${key}`, `«${key}» должно быть конечным числом`)
        return undefined
      }
      return raw
    }
    if (typeof raw === 'string') {
      const n = Number(raw.trim().replace(',', '.'))
      if (raw.trim() !== '' && Number.isFinite(n)) return n
    }
    this.err(`${path}.${key}`, `«${key}» должно быть числом`)
    return undefined
  }
  str(o: Obj, key: string, path: string, required = false): string | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) {
      if (required) this.err(`${path}.${key}`, `Поле «${key}» обязательно (строка)`)
      return undefined
    }
    if (typeof raw === 'string') return raw
    if (typeof raw === 'number') return String(raw)
    this.err(`${path}.${key}`, `«${key}» должно быть строкой`)
    return undefined
  }
  bool(o: Obj, key: string, path: string): boolean | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'boolean') return raw
    this.err(`${path}.${key}`, `«${key}» должно быть true/false`)
    return undefined
  }
  oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[], required = false): T | undefined {
    const s = this.str(o, key, path, required)
    if (s === undefined) return undefined
    if ((allowed as readonly string[]).includes(s)) return s as T
    this.err(`${path}.${key}`, `«${key}»: недопустимое значение "${s}" (допустимо: ${allowed.join(', ')})`)
    return undefined
  }
  numArr(o: Obj, key: string, path: string, len?: number, required = false): number[] | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) {
      if (required) this.err(`${path}.${key}`, `Поле «${key}» обязательно (массив чисел)`)
      return undefined
    }
    if (!Array.isArray(raw)) {
      this.err(`${path}.${key}`, `«${key}» должно быть массивом чисел`)
      return undefined
    }
    const out: number[] = []
    for (let i = 0; i < raw.length; i++) {
      const n = this.num(raw as unknown as Obj, String(i), `${path}.${key}`)
      if (n === undefined) return undefined
      out.push(n)
    }
    if (len !== undefined && out.length !== len) {
      this.err(`${path}.${key}`, `«${key}» должно содержать ${len} чисел, получено ${out.length}`)
      return undefined
    }
    return out
  }
  pts(o: Obj, key: string, path: string, minCount: number, required = false): PlanPoint[] | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) {
      if (required) this.err(`${path}.${key}`, `Поле «${key}» обязательно (массив точек [x, y])`)
      return undefined
    }
    if (!Array.isArray(raw)) {
      this.err(`${path}.${key}`, `«${key}» должно быть массивом точек [x, y]`)
      return undefined
    }
    const out: PlanPoint[] = []
    for (let i = 0; i < raw.length; i++) {
      const p = this.numArr(raw as unknown as Obj, String(i), `${path}.${key}`, 2, true)
      if (!p) return undefined
      out.push(p)
    }
    if (out.length < minCount) {
      this.err(`${path}.${key}`, `«${key}»: нужно минимум ${minCount} точки`)
      return undefined
    }
    return out
  }
  dimSource(v: unknown, path: string): SpecDimSource | undefined {
    if (typeof v === 'string') {
      if ((SPEC_DIM_SOURCES as readonly string[]).includes(v)) return v as DimSource
      this.err(path, `недопустимый источник размера "${v}" (допустимо: ${SPEC_DIM_SOURCES.join(', ')})`)
      return undefined
    }
    if (isObj(v)) {
      const source = this.oneOf(v, 'source', path, SPEC_DIM_SOURCES, true)
      if (!source) return undefined
      const out: { source: DimSource; tol?: number; date?: string; note?: string } = { source }
      const tol = this.num(v, 'tol', path)
      if (tol !== undefined) out.tol = tol
      const date = this.str(v, 'date', path)
      if (date !== undefined) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date
        else this.err(`${path}.date`, '«date» должна быть в виде ГГГГ-ММ-ДД')
      }
      const note = this.str(v, 'note', path)
      if (note !== undefined) out.note = note
      return out
    }
    this.err(path, 'источник размера: строка (plan, derived, estimated, measured, drawn) или объект {source, tol, date}')
    return undefined
  }
  /** one source, a per-side object (rooms) or an array */
  dimSources(o: Obj, key: string, path: string, sides: boolean): SpecRoomDimSources | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) return undefined
    const p = `${path}.${key}`
    if (Array.isArray(raw)) {
      const out: SpecDimSource[] = []
      for (let i = 0; i < raw.length; i++) {
        const s = this.dimSource(raw[i], `${p}[${i}]`)
        if (s === undefined) return undefined
        out.push(s)
      }
      return out
    }
    if (sides && isObj(raw) && raw.source === undefined) {
      const out: Partial<Record<RoomSide, SpecDimSource>> = {}
      for (const k of Object.keys(raw)) {
        if (k !== 'top' && k !== 'right' && k !== 'bottom' && k !== 'left') {
          this.err(`${p}.${k}`, 'сторона комнаты: top, right, bottom или left')
          continue
        }
        const s = this.dimSource(raw[k], `${p}.${k}`)
        if (s !== undefined) out[k] = s
      }
      return out
    }
    return this.dimSource(raw, p)
  }
  arr(o: Obj, key: string, path: string, required = false): unknown[] | undefined {
    const raw = o[key]
    if (raw === undefined || raw === null) {
      if (required) this.err(`${path}.${key}`, `Поле «${key}» обязательно (массив)`)
      return undefined
    }
    if (!Array.isArray(raw)) {
      this.err(`${path}.${key}`, `«${key}» должно быть массивом`)
      return undefined
    }
    return raw
  }
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

function coerceSpec(raw: unknown, c: Coercer): PlanSpec {
  const empty: PlanSpec = { version: 1, units: 'mm', rooms: [], openings: [] }
  if (!isObj(raw)) {
    c.err('$', 'PlanSpec должен быть JSON-объектом')
    return empty
  }
  const version = c.num(raw, 'version', '$', true)
  if (version !== undefined && version !== 1) c.err('$.version', `Поддерживается только version: 1 (получено ${version})`)
  const units = c.oneOf(raw, 'units', '$', ['mm', 'cm', 'm', 'px'] as const) ?? 'mm'
  const spec: PlanSpec = { version: 1, units, rooms: [], openings: [] }
  const name = c.str(raw, 'name', '$')
  if (name !== undefined) spec.name = name

  if (raw.source !== undefined) {
    if (!isObj(raw.source)) c.err('$.source', '«source» должен быть объектом')
    else {
      const s = raw.source
      const src: PlanSource = strip({
        image: c.str(s, 'image', '$.source'),
        size: c.numArr(s, 'size', '$.source', 2),
        kind: c.str(s, 'kind', '$.source'),
        mmPerPx: c.num(s, 'mmPerPx', '$.source'),
        mmPerPxY: c.num(s, 'mmPerPxY', '$.source'),
        originPx: c.numArr(s, 'originPx', '$.source', 2),
        labelledTotalArea: c.num(s, 'labelledTotalArea', '$.source'),
        labelledLivingArea: c.num(s, 'labelledLivingArea', '$.source'),
        areaNote: c.str(s, 'areaNote', '$.source'),
        toScale: c.bool(s, 'toScale', '$.source'),
      })
      const cal = c.arr(s, 'calibration', '$.source')
      if (cal) {
        src.calibration = []
        cal.forEach((it, i) => {
          const p = `$.source.calibration[${i}]`
          if (!isObj(it)) return c.err(p, 'калибровка должна быть объектом {p1, p2, mm}')
          const p1 = c.numArr(it, 'p1', p, 2, true)
          const p2 = c.numArr(it, 'p2', p, 2, true)
          const mm = c.num(it, 'mm', p, true)
          if (p1 && p2 && mm !== undefined) src.calibration!.push(strip({ p1, p2, mm, label: c.str(it, 'label', p) }))
        })
      }
      spec.source = src
    }
  }

  if (raw.defaults !== undefined) {
    if (!isObj(raw.defaults)) c.err('$.defaults', '«defaults» должен быть объектом')
    else {
      const d = raw.defaults
      const keys: (keyof PlanDefaults)[] = [
        'ceilingHeight',
        'wallHeight',
        'exteriorThickness',
        'outerThickness',
        'loadBearingThickness',
        'partitionThickness',
        'innerThickness',
        'doorHeight',
        'windowSill',
        'windowHeight',
        'railingHeight',
        'railingThickness',
      ]
      const out: PlanDefaults = {}
      for (const k of keys) {
        const v = c.num(d, k, '$.defaults')
        if (v !== undefined) out[k] = v
      }
      spec.defaults = out
    }
  }

  if (raw.dimSource !== undefined) {
    const ds = c.dimSource(raw.dimSource, '$.dimSource')
    if (ds !== undefined) spec.dimSource = ds
  }

  if (raw.snap !== undefined) {
    if (!isObj(raw.snap)) c.err('$.snap', '«snap» должен быть объектом')
    else {
      const s = raw.snap
      spec.snap = strip({
        orthogonal: c.bool(s, 'orthogonal', '$.snap'),
        orthoToleranceDeg: c.num(s, 'orthoToleranceDeg', '$.snap'),
        gridMm: c.num(s, 'gridMm', '$.snap'),
        mergeMm: c.num(s, 'mergeMm', '$.snap'),
        standardThickness: c.bool(s, 'standardThickness', '$.snap'),
      })
    }
  }

  const walls = c.arr(raw, 'walls', '$')
  if (walls) {
    spec.walls = []
    walls.forEach((w, i) => {
      const p = `$.walls[${i}]`
      if (!isObj(w)) return c.err(p, 'стена должна быть объектом')
      const path = c.pts(w, 'path', p, 2, true)
      const ws: WallSpec = strip({
        id: c.str(w, 'id', p) ?? `wall${i + 1}`,
        path: path ?? [],
        closed: c.bool(w, 'closed', p),
        align: c.oneOf(w, 'align', p, ['center', 'inner', 'outer'] as const),
        thickness: c.num(w, 'thickness', p),
        kind: c.oneOf(w, 'kind', p, SPEC_WALL_KINDS),
        height: c.num(w, 'height', p),
        confidence: c.num(w, 'confidence', p),
        source: c.dimSources(w, 'source', p, false) as SpecDimSource | SpecDimSource[] | undefined,
        cutout: c.bool(w, 'cutout', p),
      })
      if (path) spec.walls!.push(ws)
    })
  }

  const rooms = c.arr(raw, 'rooms', '$') ?? []
  rooms.forEach((r, i) => {
    const p = `$.rooms[${i}]`
    if (!isObj(r)) return c.err(p, 'комната должна быть объектом')
    let edgeWall: EdgeWallSpec | undefined
    if (r.edgeWall !== undefined) {
      if (!isObj(r.edgeWall)) c.err(`${p}.edgeWall`, '«edgeWall» должен быть объектом')
      else {
        const k = c.oneOf(r.edgeWall, 'kind', `${p}.edgeWall`, SPEC_WALL_KINDS, true)
        if (k)
          edgeWall = strip({
            kind: k,
            thickness: c.num(r.edgeWall, 'thickness', `${p}.edgeWall`),
            height: c.num(r.edgeWall, 'height', `${p}.edgeWall`),
          })
      }
    }
    let cutouts: CutoutSpec[] | undefined
    const cuts = c.arr(r, 'cutouts', p)
    if (cuts) {
      cutouts = []
      cuts.forEach((cu, k) => {
        const cp = `${p}.cutouts[${k}]`
        if (!isObj(cu)) return c.err(cp, 'вырез должен быть объектом {rect, kind?, wall?}')
        const rect = c.numArr(cu, 'rect', cp, 4, true)
        if (!rect) return
        if (rect[2] <= 0 || rect[3] <= 0) return c.err(`${cp}.rect`, 'у выреза ширина и высота должны быть > 0')
        cutouts!.push(
          strip({
            rect,
            kind: c.oneOf(cu, 'kind', cp, SPEC_CUTOUT_KINDS),
            wall: c.num(cu, 'wall', cp),
            name: c.str(cu, 'name', cp),
          }),
        )
      })
    }
    const coef = c.num(r, 'labelledAreaCoef', p)
    if (coef !== undefined && !(coef > 0 && coef <= 1)) c.err(`${p}.labelledAreaCoef`, '«labelledAreaCoef» должен быть в (0, 1]')
    spec.rooms.push(
      strip({
        id: c.str(r, 'id', p) ?? `room${i + 1}`,
        name: c.str(r, 'name', p),
        type: c.oneOf(r, 'type', p, SPEC_ROOM_TYPES),
        number: c.str(r, 'number', p),
        rect: c.numArr(r, 'rect', p, 4),
        polygon: c.pts(r, 'polygon', p, 3),
        at: c.numArr(r, 'at', p, 2),
        labelledArea: c.num(r, 'labelledArea', p),
        labelledAreaCoef: coef,
        areaNote: c.str(r, 'areaNote', p),
        cutouts,
        technical: c.bool(r, 'technical', p),
        source: c.dimSources(r, 'source', p, true),
        ceilingHeight: c.num(r, 'ceilingHeight', p),
        edgeWall,
        balcony: c.bool(r, 'balcony', p),
        glazed: c.bool(r, 'glazed', p),
        confidence: c.num(r, 'confidence', p),
      }),
    )
  })

  const openings = c.arr(raw, 'openings', '$') ?? []
  openings.forEach((o, i) => {
    const p = `$.openings[${i}]`
    if (!isObj(o)) return c.err(p, 'проём должен быть объектом')
    const type = c.oneOf(o, 'type', p, SPEC_OPENING_TYPES, true)
    const width = c.num(o, 'width', p, true)
    if (!type || width === undefined) return
    let between: string[] | undefined
    const b = c.arr(o, 'between', p)
    if (b) {
      if (b.every((x) => typeof x === 'string')) between = b as string[]
      else c.err(`${p}.between`, '«between» должен быть массивом строк')
    }
    spec.openings.push(
      strip({
        id: c.str(o, 'id', p),
        type,
        at: c.numArr(o, 'at', p, 2),
        wall: c.str(o, 'wall', p),
        offset: c.num(o, 'offset', p),
        room: c.str(o, 'room', p),
        side: c.oneOf(o, 'side', p, ['top', 'right', 'bottom', 'left'] as const),
        edge: c.num(o, 'edge', p),
        width,
        height: c.num(o, 'height', p),
        sill: c.num(o, 'sill', p),
        between,
        opensInto: c.str(o, 'opensInto', p),
        hinge: c.oneOf(o, 'hinge', p, ['left', 'right'] as const),
        hingeEnd: c.oneOf(o, 'hingeEnd', p, ['a', 'b'] as const),
        swingSide: c.oneOf(o, 'swingSide', p, ['left', 'right'] as const),
        sashes: c.num(o, 'sashes', p),
        slide: c.oneOf(o, 'slide', p, DOOR_SLIDES),
        style: c.oneOf(o, 'style', p, DOOR_LEAF_STYLES),
        confidence: c.num(o, 'confidence', p),
      }),
    )
  })

  for (const key of ['fixtures', 'furniture'] as const) {
    const arr = c.arr(raw, key, '$')
    if (!arr) continue
    const list: FixtureSpec[] = []
    arr.forEach((f, i) => {
      const p = `$.${key}[${i}]`
      if (!isObj(f)) return c.err(p, 'элемент должен быть объектом')
      const type = c.str(f, 'type', p, true)
      if (!type) return
      list.push(
        strip({
          type,
          rect: c.numArr(f, 'rect', p, 4),
          at: c.numArr(f, 'at', p, 2),
          size: c.numArr(f, 'size', p),
          rotation: c.num(f, 'rotation', p),
          assetId: c.str(f, 'assetId', p),
          name: c.str(f, 'name', p),
          elevation: c.num(f, 'elevation', p),
        }),
      )
    })
    spec[key] = list
  }

  const notes = c.arr(raw, 'notes', '$')
  if (notes) spec.notes = notes.map((n) => String(n))
  return spec
}

/** Parses JSON text or an object into a clean PlanSpec. Throws Error with readable messages on schema errors. */
export function parsePlanSpec(json: unknown): PlanSpec {
  let raw = json
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json)
    } catch (e) {
      throw new Error(`PlanSpec: некорректный JSON — ${(e as Error).message}`)
    }
  }
  const c = new Coercer()
  const spec = coerceSpec(raw, c)
  const errors = c.issues.filter((i) => i.severity === 'error')
  if (errors.length) {
    throw new Error(`PlanSpec: ошибки схемы:\n${errors.map((e) => `  ${e.path ?? ''}: ${e.message}`).join('\n')}`)
  }
  return spec
}

// ───────────────────────────── units & mapping ─────────────────────────────

interface UnitConv {
  pt(p: PlanPoint): Vec2
  len(v: number): number
  mmPerUnit: number
  grid: number
}

function mmPerPxOf(spec: PlanSpec): { x: number; y: number } | null {
  const s = spec.source
  if (s?.mmPerPx && s.mmPerPx > 0) return { x: s.mmPerPx, y: s.mmPerPxY && s.mmPerPxY > 0 ? s.mmPerPxY : s.mmPerPx }
  const cal = (s?.calibration ?? []).filter((c) => c.mm > 0 && Math.hypot(c.p2[0] - c.p1[0], c.p2[1] - c.p1[1]) > 0)
  if (!cal.length) return null
  let sum = 0
  for (const c of cal) sum += c.mm / Math.hypot(c.p2[0] - c.p1[0], c.p2[1] - c.p1[1])
  const m = sum / cal.length
  return { x: m, y: m }
}

function makeUnits(spec: PlanSpec): UnitConv {
  const grid = spec.snap?.gridMm ?? (spec.units === 'px' ? 10 : 0)
  const round = (n: number) => (grid > 0 ? Math.round(n / grid) * grid : r3(n))
  if (spec.units === 'px') {
    const k = mmPerPxOf(spec)
    if (!k) throw new Error('PlanSpec: для units "px" нужен source.mmPerPx или source.calibration')
    const o = spec.source?.originPx ?? [0, 0]
    return {
      pt: (p) => V(round((p[0] - o[0]) * k.x), round((p[1] - o[1]) * k.y)),
      len: (v) => r3(v * k.x),
      mmPerUnit: k.x,
      grid,
    }
  }
  const f = spec.units === 'cm' ? 10 : spec.units === 'm' ? 1000 : 1
  return { pt: (p) => V(round(p[0] * f), round(p[1] * f)), len: (v) => r3(v * f), mmPerUnit: f, grid }
}

const ROOM_TYPE_MAP: Record<SpecRoomType, RoomType> = {
  living: 'living',
  bedroom: 'bedroom',
  kitchen: 'kitchen',
  kitchenLiving: 'kitchenLiving',
  bathroom: 'bathroom',
  toilet: 'toilet',
  hallway: 'hallway',
  corridor: 'corridor',
  balcony: 'balcony',
  loggia: 'loggia',
  wardrobe: 'wardrobe',
  office: 'office',
  kids: 'kids',
  storage: 'storage',
  other: 'other',
  study: 'office',
  dining: 'kitchenLiving',
  hall: 'hallway',
  combinedBathroom: 'bathroom',
  laundry: 'storage',
  terrace: 'balcony',
  utility: 'storage',
}

const OPENING_MAP: Record<SpecOpeningType, OpeningKind> = {
  door: 'door',
  doubleDoor: 'doubleDoor',
  slidingDoor: 'slidingDoor',
  entranceDoor: 'entranceDoor',
  arch: 'arch',
  opening: 'opening',
  window: 'window',
  frenchWindow: 'frenchWindow',
  balconyDoor: 'balconyDoor',
  balconyBlock: 'balconyBlock',
  pocketDoor: 'slidingDoor',
  foldingDoor: 'slidingDoor',
  passage: 'opening',
  panoramicWindow: 'frenchWindow',
}

const WALL_KIND_MAP: Record<SpecWallKind, WallKind> = {
  exterior: 'wall',
  loadBearing: 'wall',
  partition: 'partition',
  parapet: 'parapet',
  railing: 'parapet',
  glass: 'glazing',
  separator: 'virtual',
}

const OUTDOOR_TYPES: SpecRoomType[] = ['balcony', 'loggia', 'terrace']
const LIVING_TYPES: SpecRoomType[] = ['living', 'bedroom', 'kids', 'study', 'office']
const WINDOW_REQUIRED: SpecRoomType[] = ['living', 'bedroom', 'kids', 'study', 'office', 'kitchen', 'kitchenLiving']
const DOOR_LIKE: OpeningKind[] = ['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'arch', 'opening', 'balconyDoor', 'balconyBlock', 'frenchWindow']
const WINDOW_LIKE: OpeningKind[] = ['window', 'frenchWindow', 'balconyDoor', 'balconyBlock']
const STANDARD_THICKNESS = [80, 100, 120, 150, 160, 180, 200, 250, 300, 380, 400, 510, 640]
const MAX_GAP = 700
/** mm: a cutout side this close to the room outline / another cutout is snapped onto it */
const CUTOUT_SNAP = 30
const AREA_COEF: Partial<Record<SpecRoomType, number>> = { balcony: 0.3, loggia: 0.5, terrace: 0.3 }

const isOutdoor = (r: RoomSpec): boolean => r.balcony === true || OUTDOOR_TYPES.includes(r.type ?? 'other')

interface ResolvedDefaults {
  wallHeight: number
  ceilingHeight: number
  exterior: number
  loadBearing: number
  partition: number
  doorHeight?: number
  windowSill?: number
  windowHeight?: number
  railingHeight: number
  railingThickness: number
}

function resolveDefaults(spec: PlanSpec): ResolvedDefaults {
  const d = spec.defaults ?? {}
  const ceiling = d.ceilingHeight ?? d.wallHeight ?? 2700
  return {
    wallHeight: d.wallHeight ?? ceiling,
    ceilingHeight: ceiling,
    exterior: d.exteriorThickness ?? d.outerThickness ?? 300,
    loadBearing: d.loadBearingThickness ?? 200,
    partition: d.partitionThickness ?? d.innerThickness ?? 100,
    doorHeight: d.doorHeight,
    windowSill: d.windowSill,
    windowHeight: d.windowHeight,
    railingHeight: d.railingHeight ?? 1100,
    railingThickness: d.railingThickness ?? 100,
  }
}

function thicknessFor(kind: SpecWallKind, D: ResolvedDefaults): number {
  switch (kind) {
    case 'exterior':
      return D.exterior
    case 'loadBearing':
      return D.loadBearing
    case 'partition':
      return D.partition
    case 'parapet':
    case 'railing':
    case 'glass':
      return D.railingThickness
    case 'separator':
      return 0
  }
}

function heightFor(kind: SpecWallKind, D: ResolvedDefaults): number {
  return kind === 'parapet' || kind === 'railing' ? D.railingHeight : D.wallHeight
}

function snapThickness(t: number, enabled: boolean): number {
  if (!enabled) return r3(t)
  let best = t
  let bd = Infinity
  for (const s of STANDARD_THICKNESS) {
    const d = Math.abs(s - t)
    if (d <= 15 && d < bd) {
      bd = d
      best = s
    }
  }
  return r3(best)
}

function orthoSnap(points: Vec2[], closed: boolean, tolDeg: number): Vec2[] {
  const out = points.map((p) => ({ ...p }))
  const tol = (tolDeg * Math.PI) / 180
  const n = out.length
  const count = closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const a = out[i]
    const bi = (i + 1) % n
    const b = out[bi]
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue
    const ang = Math.atan2(Math.abs(dy), Math.abs(dx))
    if (closed && bi === 0) {
      // closing edge: adjust the last point instead of the first
      if (ang < tol) a.y = b.y
      else if (Math.PI / 2 - ang < tol) a.x = b.x
    } else if (ang < tol) b.y = a.y
    else if (Math.PI / 2 - ang < tol) b.x = a.x
  }
  return out
}

function ccw(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly
}

/** room polygon in mm, algebraically CCW (signed area > 0), or null */
function roomPolygonMm(r: RoomSpec, U: UnitConv, snap: PlanSnap | undefined): Vec2[] | null {
  if (r.rect && r.rect.length === 4) {
    const [x, y, w, h] = r.rect
    const p0 = U.pt([x, y])
    const p1 = U.pt([x + w, y + h])
    const x0 = Math.min(p0.x, p1.x)
    const x1 = Math.max(p0.x, p1.x)
    const y0 = Math.min(p0.y, p1.y)
    const y1 = Math.max(p0.y, p1.y)
    if (x1 - x0 < 1 || y1 - y0 < 1) return null
    return ccw([V(x0, y0), V(x1, y0), V(x1, y1), V(x0, y1)])
  }
  if (r.polygon && r.polygon.length >= 3) {
    let pts = r.polygon.map((p) => U.pt(p))
    if (snap?.orthogonal !== false) pts = orthoSnap(pts, true, snap?.orthoToleranceDeg ?? 3)
    // drop consecutive duplicates
    pts = pts.filter((p, i) => vDist(p, pts[(i + 1) % pts.length]) > 0.5)
    if (pts.length < 3 || Math.abs(signedArea(pts)) < 1) return null
    return ccw(pts)
  }
  return null
}

function roomRefPoint(r: RoomSpec, U: UnitConv, snap: PlanSnap | undefined): Vec2 | null {
  if (r.at && r.at.length === 2) return U.pt(r.at)
  if (r.cutouts?.length) return roomShapeMm(r, U, snap)?.ref ?? null
  const poly = roomPolygonMm(r, U, snap)
  return poly ? interiorPoint(poly) : null
}

// ───────────────────────────── cutouts (shafts, columns) ─────────────────────────────

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** a technical void left inside the cutouts once their walls are built */
interface CutVoid {
  /** CCW polygon of the void */
  poly: Vec2[]
  kind: SpecCutoutKind
  /** index in the room's `cutouts` of the cutout holding the void */
  index: number
  /** that cutout as snapped (void + its walls) */
  cut: Box
}

interface RoomShape {
  /** the room as written (rect / polygon), CCW */
  base: Vec2[]
  /** clear floor outline after the cutouts touching the outline, CCW */
  outer: Vec2[]
  /** cutouts inside the floor (free-standing columns) */
  holes: Vec2[][]
  voids: CutVoid[]
  /** the walls of the cutouts: along every side between the floor and a cutout, inside the cutout */
  walls: Seg[]
  /** clear floor area, mm² */
  area: number
  /** a point on the floor (not in a cutout) */
  ref: Vec2
  problems: { code: string; message: string; severity: PlanIssueSeverity }[]
}

/** between two touching cutouts of different kinds, the wall stands in the one ranked higher (a column is solid) */
const CUT_RANK: Record<SpecCutoutKind, number> = { shaft: 1, box: 2, column: 3 }
/** mm: the thickest wall a column is filled with (the thickest standard wall); the rest stays a technical void */
const COLUMN_WALL_MAX = 640

const isOrthoPoly = (poly: Vec2[]): boolean =>
  poly.every((p, i) => {
    const q = poly[(i + 1) % poly.length]
    return Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5
  })

/** boundary rings of the filled cells of a rectilinear grid; outer rings CCW (signed area > 0), holes CW */
function cellRings(xs: number[], ys: number[], filled: (i: number, j: number) => boolean): Vec2[][] {
  type GEdge = { a: string; b: string; cell: number }
  const nj = ys.length - 1
  const edges = new Map<string, GEdge>()
  const add = (a: string, b: string, cell: number) => {
    if (edges.has(`${b}>${a}`)) edges.delete(`${b}>${a}`)
    else edges.set(`${a}>${b}`, { a, b, cell })
  }
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      if (!filled(i, j)) continue
      const cell = i * nj + j
      add(`${i},${j}`, `${i + 1},${j}`, cell)
      add(`${i + 1},${j}`, `${i + 1},${j + 1}`, cell)
      add(`${i + 1},${j + 1}`, `${i},${j + 1}`, cell)
      add(`${i},${j + 1}`, `${i},${j}`, cell)
    }
  // connected parts of the filled cells (edge-adjacent)
  const comp = new Map<number, number>()
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      if (!filled(i, j) || comp.has(i * nj + j)) continue
      const id = comp.size
      const stack: [number, number][] = [[i, j]]
      comp.set(i * nj + j, id)
      while (stack.length) {
        const [ci, cj] = stack.pop()!
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di
          const nj2 = cj + dj
          if (ni < 0 || nj2 < 0 || ni + 1 >= xs.length || nj2 + 1 >= ys.length) continue
          if (!filled(ni, nj2) || comp.has(ni * nj + nj2)) continue
          comp.set(ni * nj + nj2, id)
          stack.push([ni, nj2])
        }
      }
    }
  const out = new Map<string, GEdge[]>()
  for (const e of edges.values()) {
    const l = out.get(e.a) ?? []
    l.push(e)
    out.set(e.a, l)
  }
  const pt = (k: string): Vec2 => {
    const [i, j] = k.split(',').map(Number)
    return V(xs[i], ys[j])
  }
  const rings: Vec2[][] = []
  const used = new Set<GEdge>()
  for (const start of edges.values()) {
    if (used.has(start)) continue
    const ring: Vec2[] = []
    let e: GEdge | undefined = start
    while (e && !used.has(e)) {
      used.add(e)
      ring.push(pt(e.a))
      const cur: GEdge = e
      const nexts = (out.get(cur.b) ?? []).filter((x) => x === start || !used.has(x))
      // a pinch vertex: two filled cells touch diagonally. If they are connected elsewhere, the two
      // empty regions are separate (a hole touching the outline): cross over to the other cell.
      // Otherwise the filled parts are separate rings: stay with the same cell.
      if (nexts.length > 1) {
        const other = nexts.find((x) => x.cell !== cur.cell)
        const same = nexts.find((x) => x.cell === cur.cell)
        const connected = other !== undefined && comp.get(other.cell) === comp.get(cur.cell)
        e = (connected ? other : same) ?? nexts[0]
      } else e = nexts[0]
      if (e === start) break
    }
    // drop collinear vertices
    const clean = ring.filter((p, i) => {
      const a = ring[(i - 1 + ring.length) % ring.length]
      const b = ring[(i + 1) % ring.length]
      return !((Math.abs(a.x - p.x) < 1e-6 && Math.abs(b.x - p.x) < 1e-6) || (Math.abs(a.y - p.y) < 1e-6 && Math.abs(b.y - p.y) < 1e-6))
    })
    if (clean.length >= 4) rings.push(clean)
  }
  return rings
}

/**
 * The room's real floor: its rect / polygon minus `cutouts`, a boolean of rectilinear polygons on the
 * grid of their coordinates (no logic depends on which way the plan is turned). Cutouts that touch
 * the outline become notches of `outer`; cutouts inside the floor become `holes`.
 *
 * The walls of the cutouts come from that floor alone, by one rule: every side between the floor and
 * a cutout gets the cutout's wall, inside the cutout (between two touching cutouts of different kinds,
 * inside the higher ranked one: a column is solid). A cutout side on the room outline gets no wall of
 * its own — the outline wall, built as if there were no cutouts, closes it. Walls meeting at a corner
 * are joined there; a wall ending on the outline is joined to the outline wall later (joinEnds). What
 * is left inside a cutout is its technical void.
 */
function roomShapeMm(r: RoomSpec, U: UnitConv, snap: PlanSnap | undefined, partition = 100, wallHeight = 2700): RoomShape | null {
  const base = roomPolygonMm(r, U, snap)
  if (!base) return null
  const plain = (): RoomShape => ({ base, outer: base, holes: [], voids: [], walls: [], area: Math.abs(signedArea(base)), ref: interiorPoint(base), problems: [] })
  if (!r.cutouts?.length) return plain()
  const cutouts = r.cutouts
  const problems: RoomShape['problems'] = []
  if (!isOrthoPoly(base)) {
    const s = plain()
    s.problems.push({
      severity: 'warning',
      code: 'CUTOUT_UNSUPPORTED',
      message: `Комната «${r.id}»: вырезы поддерживаются только у прямоугольных (ортогональных) комнат — вырезы пропущены`,
    })
    return s
  }
  // a side within CUTOUT_SNAP of the room outline (or of an earlier cutout) is snapped onto it: a
  // cutout drawn a few mm past the wall, or a few mm short of it, is a misread, not a sliver of floor
  const vEdges: { x: number; y0: number; y1: number }[] = []
  const hEdges: { y: number; x0: number; x1: number }[] = []
  base.forEach((p, i) => {
    const q = base[(i + 1) % base.length]
    if (Math.abs(p.x - q.x) < 0.5) vEdges.push({ x: p.x, y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) })
    else hEdges.push({ y: p.y, x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x) })
  })
  const snapTo = (v: number, cands: number[]): number => {
    let best = v
    let bestD = CUTOUT_SNAP + 1e-6
    for (const c of cands)
      if (Math.abs(c - v) < bestD - 1e-9 || (Math.abs(Math.abs(c - v) - bestD) <= 1e-9 && c < best)) {
        best = c
        bestD = Math.abs(c - v)
      }
    return best
  }
  const boxes: Box[] = []
  cutouts.forEach((c, k) => {
    const p0 = U.pt([c.rect[0], c.rect[1]])
    const p1 = U.pt([c.rect[0] + c.rect[2], c.rect[1] + c.rect[3]])
    const raw: Box = { x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) }
    const overlapsY = (a0: number, a1: number) => a0 < raw.y1 - 1 && a1 > raw.y0 + 1
    const overlapsX = (a0: number, a1: number) => a0 < raw.x1 - 1 && a1 > raw.x0 + 1
    // an outline edge that only reaches the cutout's span (an inner corner's edge ending a few mm
    // off it) is a candidate too: a cutout misread past a reflex vertex snaps onto it
    const nearY = (a0: number, a1: number) => a0 <= raw.y1 + CUTOUT_SNAP && a1 >= raw.y0 - CUTOUT_SNAP
    const nearX = (a0: number, a1: number) => a0 <= raw.x1 + CUTOUT_SNAP && a1 >= raw.x0 - CUTOUT_SNAP
    const xc = [
      ...vEdges.filter((e) => nearY(e.y0, e.y1)).map((e) => e.x),
      ...boxes.filter((o) => overlapsY(o.y0, o.y1)).flatMap((o) => [o.x0, o.x1]),
    ]
    const yc = [
      ...hEdges.filter((e) => nearX(e.x0, e.x1)).map((e) => e.y),
      ...boxes.filter((o) => overlapsX(o.x0, o.x1)).flatMap((o) => [o.y0, o.y1]),
    ]
    let b: Box = { x0: snapTo(raw.x0, xc), x1: snapTo(raw.x1, xc), y0: snapTo(raw.y0, yc), y1: snapTo(raw.y1, yc) }
    if (b.x1 - b.x0 < 1 || b.y1 - b.y0 < 1) b = raw
    const moved = Math.max(Math.abs(b.x0 - raw.x0), Math.abs(b.x1 - raw.x1), Math.abs(b.y0 - raw.y0), Math.abs(b.y1 - raw.y1))
    if (moved > 0.5)
      problems.push({
        severity: 'info',
        code: 'CUTOUT_SNAPPED',
        message: `Комната «${r.id}»: вырез #${k + 1} подогнан к контуру комнаты / соседнему вырезу (сдвиг до ${Math.round(moved)} мм)`,
      })
    boxes.push(b)
  })
  const kindOf = (k: number): SpecCutoutKind => cutouts[k].kind ?? 'shaft'
  const bx = base.map((p) => p.x)
  const by = base.map((p) => p.y)
  const minX = Math.min(...bx)
  const maxX = Math.max(...bx)
  const minY = Math.min(...by)
  const maxY = Math.max(...by)
  const clampX = (v: number) => Math.min(maxX, Math.max(minX, v))
  const clampY = (v: number) => Math.min(maxY, Math.max(minY, v))
  const uniq = (v: number[]) => [...new Set(v.map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b)
  const xs = uniq([...bx, ...boxes.flatMap((b) => [clampX(b.x0), clampX(b.x1)])])
  const ys = uniq([...by, ...boxes.flatMap((b) => [clampY(b.y0), clampY(b.y1)])])
  const inBox = (p: Vec2, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1
  const nI = xs.length - 1
  const nJ = ys.length - 1
  /** each cell: -1 outside the room, 0 floor, k + 1 cutout k */
  const cls: number[][] = []
  let area = 0
  let best = { a: -1, c: V(0, 0) }
  // each cutout's own area inside the room (overlaps counted for both: that is checked separately)
  const cutInHost = boxes.map(() => 0)
  for (let i = 0; i < nI; i++) {
    cls.push([])
    for (let j = 0; j < nJ; j++) {
      const c = V((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)
      const a = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
      const h = pointInPoly(c, base)
      let first = -1
      boxes.forEach((b, k) => {
        if (!inBox(c, b)) return
        if (first < 0) first = k
        if (h) cutInHost[k] += a
      })
      cls[i].push(!h ? -1 : first >= 0 ? first + 1 : 0)
      if (h && first < 0) {
        area += a
        if (a > best.a) best = { a, c }
      }
    }
  }
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= nI || j >= nJ ? -1 : cls[i][j])
  boxes.forEach((b, k) => {
    const full = (b.x1 - b.x0) * (b.y1 - b.y0)
    // after snapping, any part outside the room is a real error (it would leave the room open)
    if (full - cutInHost[k] > 1)
      problems.push({
        severity: 'error',
        code: 'CUTOUT_OUTSIDE',
        message: `Комната «${r.id}»: вырез #${k + 1} выходит за контур комнаты на ${((full - cutInHost[k]) / 1e6).toFixed(full - cutInHost[k] < 1e4 ? 4 : 2)} м² — rect выреза задаётся внутри комнаты`,
      })
    for (let m = 0; m < k; m++) {
      const o = boxes[m]
      const ov = Math.max(0, Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0)) * Math.max(0, Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0))
      if (ov > 1)
        problems.push({
          severity: 'error',
          code: 'CUTOUT_OVERLAP',
          message: `Комната «${r.id}»: вырезы #${m + 1} и #${k + 1} перекрываются на ${(ov / 1e6).toFixed(2)} м² — Г-образную шахту задайте прямоугольниками вплотную, без перекрытия`,
        })
    }
  })
  const rings = cellRings(xs, ys, (i, j) => cls[i][j] === 0)
  const outers = rings.filter((g) => signedArea(g) > 0).sort((a, b) => signedArea(b) - signedArea(a))
  const holes = rings.filter((g) => signedArea(g) < 0)
  if (!outers.length) {
    const s = plain()
    s.problems.push({ severity: 'error', code: 'CUTOUT_OUTSIDE', message: `Комната «${r.id}»: вырезы закрывают всю комнату` })
    return s
  }
  if (outers.length > 1)
    problems.push({
      severity: 'error',
      code: 'CUTOUT_SPLITS_ROOM',
      message: `Комната «${r.id}»: вырезы делят комнату на ${outers.length} части — это разные комнаты или вырез задан неверно`,
    })

  // ── the walls of the cutouts
  /** the wall between two touching cutouts of different kinds stands in the higher-ranked one */
  const byRank = (c1: number, c2: number): number => {
    const r1 = CUT_RANK[kindOf(c1 - 1)]
    const r2 = CUT_RANK[kindOf(c2 - 1)]
    // touching cutouts of one kind are one cutout (an L-shaped shaft as two rects)
    if (r1 === r2) return -1
    return r1 > r2 ? c1 - 1 : c2 - 1
  }
  // ... except at a reflex corner of the outline where one of the two touches the outside and the
  // floor lies diagonally across from it: there the wall goes into that one, so that its end runs on
  // into the outline wall and the other cutout's floor wall meets it. With the wall in the other
  // cutout the floor and the void would touch at the corner point only, and the void leaked into
  // the floor
  const forced = new Map<string, number>()
  const pairKey = (c1: number, c2: number) => (c1 < c2 ? `${c1},${c2}` : `${c2},${c1}`)
  for (let i = 0; i <= nI; i++)
    for (let j = 0; j <= nJ; j++) {
      // the cells around grid point i,j in turn: -x-y, +x-y, +x+y, -x+y
      const q = [at(i - 1, j - 1), at(i, j - 1), at(i, j), at(i - 1, j)]
      for (let k = 0; k < 4; k++) {
        const B = q[k]
        if (B <= 0 || q[(k + 2) % 4] !== 0) continue
        for (const [A, O] of [[q[(k + 1) % 4], q[(k + 3) % 4]], [q[(k + 3) % 4], q[(k + 1) % 4]]])
          if (A > 0 && A !== B && O === -1 && byRank(A, B) >= 0) forced.set(pairKey(A, B), B - 1)
      }
    }
  /** the cutout whose wall stands on the side between cells of classes c1 and c2 (-1: no wall) */
  const owner = (c1: number, c2: number): number => {
    if (c1 === c2 || c1 < 0 || c2 < 0) return -1
    if (c1 === 0) return c2 - 1
    if (c2 === 0) return c1 - 1
    const b = byRank(c1, c2)
    return b < 0 ? b : (forced.get(pairKey(c1, c2)) ?? b)
  }
  // which sides of each cutout carry a wall (its thickness: the walls must leave room for a void)
  const walled = boxes.map(() => ({ x0: false, x1: false, y0: false, y1: false }))
  for (let i = 0; i <= nI; i++)
    for (let j = 0; j < nJ; j++) {
      const o = owner(at(i - 1, j), at(i, j))
      if (o >= 0) walled[o][at(i, j) === o + 1 ? 'x0' : 'x1'] = true
    }
  for (let j = 0; j <= nJ; j++)
    for (let i = 0; i < nI; i++) {
      const o = owner(at(i, j - 1), at(i, j))
      if (o >= 0) walled[o][at(i, j) === o + 1 ? 'y0' : 'y1'] = true
    }
  const thick = boxes.map((b, k) => {
    const c = cutouts[k]
    const column = kindOf(k) === 'column'
    // a column is solid: its walls fill it (up to the thickest standard wall)
    const t0 = c.wall ?? (column ? COLUMN_WALL_MAX : partition)
    const nX = Number(walled[k].x0) + Number(walled[k].x1)
    const nY = Number(walled[k].y0) + Number(walled[k].y1)
    const W = b.x1 - b.x0
    const H = b.y1 - b.y0
    const tX = r3(Math.min(t0, nX ? Math.max(10, (W - 40) / nX) : W))
    const tY = r3(Math.min(t0, nY ? Math.max(10, (H - 40) / nY) : H))
    if (!column && ((nX && tX < t0 - 0.5) || (nY && tY < t0 - 0.5)))
      problems.push({
        severity: 'info',
        code: 'CUTOUT_THIN',
        message: `Комната «${r.id}»: вырез #${k + 1} меньше двух стен по ${t0} мм — стенки утончены`,
      })
    return { tX, tY }
  })
  /** a straight run of cutout wall along a grid line: the wall stands on `side` (+1: towards +x / +y) */
  interface Run {
    vert: boolean
    at: number
    s0: number
    s1: number
    side: 1 | -1
    t: number
    owners: Set<number>
    /** the axis ends (moved to the corners where runs are joined) */
    e0: number
    e1: number
  }
  const runs: Run[] = []
  const lineRuns = (vert: boolean) => {
    const nLines = vert ? nI : nJ
    const nCells = vert ? nJ : nI
    const along = vert ? ys : xs
    for (let l = 0; l <= nLines; l++) {
      let cur: Run | null = null
      for (let c = 0; c < nCells; c++) {
        const before = vert ? at(l - 1, c) : at(c, l - 1)
        const after = vert ? at(l, c) : at(c, l)
        const o = owner(before, after)
        if (o < 0) {
          cur = null
          continue
        }
        const side: 1 | -1 = after === o + 1 ? 1 : -1
        const t = vert ? thick[o].tX : thick[o].tY
        if (cur && cur.side === side && Math.abs(cur.t - t) < 0.01 && cur.s1 === along[c]) {
          cur.s1 = along[c + 1]
          cur.e1 = cur.s1
          cur.owners.add(o)
          continue
        }
        cur = { vert, at: (vert ? xs : ys)[l], s0: along[c], s1: along[c + 1], side, t, owners: new Set([o]), e0: along[c], e1: along[c + 1] }
        runs.push(cur)
      }
    }
  }
  lineRuns(true)
  lineRuns(false)
  // run ends meeting at a grid point: two perpendicular runs bounding the same cutout corner (both
  // walls on the corner's side) or the same floor corner (both walls away from it) are joined at
  // the crossing of their axes, as walls meeting at a corner are
  type End = { run: Run; start: boolean; d: Vec2; w: Vec2 }
  const ends = new Map<string, End[]>()
  for (const run of runs) {
    for (const start of [true, false]) {
      const s = start ? run.s0 : run.s1
      const p = run.vert ? V(run.at, s) : V(s, run.at)
      const key = `${p.x},${p.y}`
      const d = run.vert ? V(0, start ? 1 : -1) : V(start ? 1 : -1, 0)
      const w = run.vert ? V(run.side, 0) : V(0, run.side)
      const list = ends.get(key) ?? []
      list.push({ run, start, d, w })
      ends.set(key, list)
    }
  }
  const axisOf = (run: Run): number => run.at + (run.side * run.t) / 2
  const joined = new Set<End>()
  // the run each joined end met (a run joined to a run that then collapses is fixed up below)
  const partner = new Map<End, Run>()
  for (const list of ends.values()) {
    const join = (e1: End, e2: End) => {
      const [v, h] = e1.run.vert ? [e1, e2] : [e2, e1]
      const px = axisOf(v.run)
      const py = axisOf(h.run)
      if (v.start) v.run.e0 = py
      else v.run.e1 = py
      if (h.start) h.run.e0 = px
      else h.run.e1 = px
      joined.add(e1)
      joined.add(e2)
      partner.set(e1, e2.run)
      partner.set(e2, e1.run)
    }
    const quad = (u: Vec2) => `${Math.sign(u.x)},${Math.sign(u.y)}`
    for (const mode of ['wall', 'floor'] as const)
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const e1 = list[i]
          const e2 = list[j]
          if (e1.run.vert === e2.run.vert || joined.has(e1) || joined.has(e2)) continue
          const q1 = mode === 'wall' ? vAdd(e1.d, e1.w) : vSub(e1.d, e1.w)
          const q2 = mode === 'wall' ? vAdd(e2.d, e2.w) : vSub(e2.d, e2.w)
          if (quad(q1) === quad(q2)) join(e1, e2)
        }
  }
  // a run ending against the wall side of another cutout (a shaft beside a column) meets that wall at
  // its axis. A wall met that way near its corner runs on through the corner to the cutout's edge: its
  // corner partner then meets it there too (with mitred thick column walls the axis of the side ended
  // short of the corner and the shaft wall found nothing to meet)
  for (const list of ends.values())
    for (const e of list) {
      if (joined.has(e)) continue
      const S = e.run
      const P = S.vert ? V(S.at, e.start ? S.s0 : S.s1) : V(e.start ? S.s0 : S.s1, S.at)
      for (const R of runs) {
        if (R === S || R.vert === S.vert) continue
        const across = R.vert ? P.x : P.y
        const along = R.vert ? P.y : P.x
        if (across !== R.at || along < R.s0 || along > R.s1) continue
        // S leaves R on R's floor side
        if ((R.vert ? e.d.x : e.d.y) * R.side >= 0) continue
        const tAt = axisOf(S)
        if (e.start) S.e0 = axisOf(R)
        else S.e1 = axisOf(R)
        if (tAt < R.e0) R.e0 = Math.min(R.s0, tAt)
        if (tAt > R.e1) R.e1 = Math.max(R.s1, tAt)
        joined.add(e)
        partner.set(e, R)
        break
      }
    }
  // a short run whose two ends were both joined to walls beyond it collapses to nothing (a column side
  // shorter than the wall thickness of its neighbours). The runs that met it at its axis then stop on
  // its line instead, where the cutout edge turns, or the floor leaks into the corner
  const collapsed = (run: Run) => run.e1 - run.e0 < 1
  for (const run of runs)
    if (collapsed(run))
      for (const [e, R] of partner)
        if (R === run && !collapsed(e.run)) {
          if (e.start) e.run.e0 = run.at
          else e.run.e1 = run.at
        }
  // a cutout side partly on the outline and partly along the floor (it crosses the line of a reflex
  // corner): its wall would end against the outline wall standing on the other side of the line.
  // Checked on the union of touching cutouts: beyond the corner the same cutout, or one of the same
  // kind with no wall between them (one shaft drawn as two rects), is the same refused side. A cutout
  // of another kind beyond it has its own wall there, which this run meets
  const index = (v: number[], x: number) => v.indexOf(x)
  const atCorner = new Set<number>()
  for (const run of runs)
    for (const start of [true, false]) {
      const s = start ? run.s0 : run.s1
      const lineIdx = index(run.vert ? xs : ys, run.at)
      const sIdx = index(run.vert ? ys : xs, s)
      const c = start ? sIdx - 1 : sIdx
      const cell = (l: number) => (run.vert ? at(l, c) : at(c, l))
      const wallSide = cell(run.side > 0 ? lineIdx : lineIdx - 1)
      const floorSide = cell(run.side > 0 ? lineIdx - 1 : lineIdx)
      const cIn = start ? sIdx : sIdx - 1
      const inner = run.vert ? at(run.side > 0 ? lineIdx : lineIdx - 1, cIn) : at(cIn, run.side > 0 ? lineIdx : lineIdx - 1)
      if (wallSide > 0 && floorSide === -1 && owner(inner, wallSide) < 0) for (const o of run.owners) atCorner.add(o)
    }
  for (const k of [...atCorner].sort((a, b) => a - b))
    problems.push({
      severity: 'error',
      code: 'CUTOUT_AT_CORNER',
      message: `Комната «${r.id}»: сторона выреза #${k + 1} проходит через внутренний угол комнаты — частью по контуру, частью вдоль пола; такой вырез компилятор не строит. Сдвиньте или подрежьте вырез так, чтобы каждая его сторона целиком лежала на контуре или целиком в комнате`,
    })
  const walls: Seg[] = []
  // the wall bodies, for the voids: each run from its side to the far face, over its own span and
  // the corners it was joined to
  const bodies: Box[] = []
  for (const run of runs) {
    const ax = axisOf(run)
    const a = run.vert ? V(ax, run.e0) : V(run.e0, ax)
    const b = run.vert ? V(ax, run.e1) : V(run.e1, ax)
    if (vDist(a, b) >= 1) walls.push({ a, b, t: run.t, kind: run.t >= 160 ? 'loadBearing' : 'partition', height: wallHeight, cut: true })
    const lo = Math.min(run.s0, run.e0)
    const hi = Math.max(run.s1, run.e1)
    const f0 = Math.min(run.at, run.at + run.side * run.t)
    const f1 = Math.max(run.at, run.at + run.side * run.t)
    bodies.push(run.vert ? { x0: f0, x1: f1, y0: lo, y1: hi } : { x0: lo, x1: hi, y0: f0, y1: f1 })
  }
  // two walls meeting end to end at a right angle are mitred: the joint fills the whole square around
  // the corner point, the outer quarter included (the void is what the built faces leave)
  for (const w of walls)
    for (const p of [w.a, w.b]) {
      const at = walls.filter((o) => vDist(o.a, p) < 0.5 || vDist(o.b, p) < 0.5)
      if (at.length !== 2) continue
      const o = at[0] === w ? at[1] : at[0]
      const vert = Math.abs(w.a.x - w.b.x) < 0.5
      if (vert === Math.abs(o.a.x - o.b.x) < 0.5) continue
      const [tx, ty] = vert ? [w.t, o.t] : [o.t, w.t]
      bodies.push({ x0: p.x - tx / 2, x1: p.x + tx / 2, y0: p.y - ty / 2, y1: p.y + ty / 2 })
    }
  // ── the voids: the cutouts minus the wall bodies
  const vxs = uniq([...xs, ...bodies.flatMap((b) => [b.x0, b.x1])])
  const vys = uniq([...ys, ...bodies.flatMap((b) => [b.y0, b.y1])])
  const cutAt = (p: Vec2): number => (pointInPoly(p, base) ? boxes.findIndex((b) => inBox(p, b)) : -1)
  const voidRings = cellRings(vxs, vys, (i, j) => {
    const c = V((vxs[i] + vxs[i + 1]) / 2, (vys[j] + vys[j + 1]) / 2)
    return cutAt(c) >= 0 && !bodies.some((b) => inBox(c, b))
  })
  const voids: CutVoid[] = []
  // a void belongs to the cutout it overlaps most (a point test fails for the void of a union, whose
  // inner point can fall on the line two cutouts share)
  const boxPoly = (b: Box): Vec2[] => [V(b.x0, b.y0), V(b.x1, b.y0), V(b.x1, b.y1), V(b.x0, b.y1)]
  for (const ring of voidRings) {
    if (signedArea(ring) <= 0) continue
    let k = -1
    let most = 0.5
    boxes.forEach((b, i) => {
      const ov = overlapArea(ring, boxPoly(b))
      if (ov > most + 1e-6) [k, most] = [i, ov]
    })
    if (k < 0) continue
    voids.push({ poly: ring, kind: kindOf(k), index: k, cut: boxes[k] })
  }
  return { base, outer: outers[0], holes, voids, walls, area, ref: best.c, problems }
}

// ───────────────────────────── wall synthesis ─────────────────────────────

interface Seg {
  a: Vec2
  b: Vec2
  t: number
  kind: SpecWallKind
  height: number
  /** the wall of a cutout (a void side facing the floor) */
  cut?: boolean
}

interface REdge {
  room: number
  p0: Vec2
  p1: Vec2
  e: Vec2
  n: Vec2
  L: number
  covered: [number, number][]
  kept: [number, number][]
}

function subtractIntervals(base: [number, number], cut: [number, number][]): [number, number][] {
  let parts: [number, number][] = [base]
  for (const [c0, c1] of cut) {
    const next: [number, number][] = []
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) next.push([p0, p1])
      else {
        if (c0 > p0) next.push([p0, c0])
        if (c1 < p1) next.push([c1, p1])
      }
    }
    parts = next
  }
  return parts.filter(([a, b]) => b - a > 0.5)
}

/** the wall a room gets along an outline edge nobody shares */
function roomEdgeWall(r: RoomSpec, D: ResolvedDefaults): { kind: SpecWallKind; t: number; h: number } {
  if (r.edgeWall) {
    const k = r.edgeWall.kind
    return { kind: k, t: r.edgeWall.thickness ?? thicknessFor(k, D), h: r.edgeWall.height ?? heightFor(k, D) }
  }
  if (isOutdoor(r)) {
    if (r.glazed) return { kind: 'glass', t: D.railingThickness, h: D.wallHeight }
    return { kind: 'railing', t: D.railingThickness, h: D.railingHeight }
  }
  return { kind: 'exterior', t: D.exterior, h: D.wallHeight }
}

/** the kind of the wall two rooms share across a gap d (the wall synthesis pairs their edges so) */
function sharedWallKind(a: RoomSpec, b: RoomSpec, d: number): SpecWallKind {
  if (d < 40) return 'separator'
  if (isOutdoor(a) || isOutdoor(b)) return 'exterior'
  return d >= 160 ? 'loadBearing' : 'partition'
}

function roomsModeSegments(
  rooms: RoomSpec[],
  roomPolys: (Vec2[] | null)[],
  D: ResolvedDefaults,
  stdT: boolean,
  issues: PlanIssue[],
  /** out: wall ends stopped at another room's outline (joinEnds must not push them on) */
  clipped: Vec2[] = [],
): Seg[] {
  const edges: REdge[] = []
  roomPolys.forEach((poly, ri) => {
    if (!poly) return
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i]
      const p1 = poly[(i + 1) % poly.length]
      const L = vDist(p0, p1)
      if (L < 1) continue
      const e = vNorm(vSub(p1, p0))
      // polygon is algebraically CCW → interior on the algebraic left (-ey, ex) → outward (ey, -ex)
      edges.push({ room: ri, p0, p1, e, n: V(e.y, -e.x), L, covered: [], kept: [] })
    }
  })

  /**
   * How far (≤ want) a wall end may grow along `dir` from the axis point `from` before its body
   * (half thickness `h` across `n`) enters the floor of another room (`skip`: the wall's own room).
   * At a convex corner next to a neighbour the full t/2 went through the neighbour's floor: with
   * 380…640 mm brick walls that cut 0.1…0.4 m² out of the room beside.
   */
  const roomFree = (from: Vec2, dir: Vec2, n: Vec2, h: number, want: number, skip: number): number => {
    let best = want
    for (const u of [-h + 1, -h / 2, 0, h / 2, h - 1]) {
      const o = vAdd(from, vMul(n, u))
      roomPolys.forEach((poly, ri) => {
        if (!poly || ri === skip) return
        if (pointInPoly(o, poly) && distToPolyBoundary(o, poly) > 0.5) {
          best = 0
          return
        }
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i]
          const hit = lineHit(o, dir, p, vSub(poly[(i + 1) % poly.length], p))
          if (!hit || hit.mu < -1e-6 || hit.mu > 1 + 1e-6 || hit.lambda < -0.5 || hit.lambda >= best) continue
          // an entry, not a ray leaving the outline it starts on or grazing a corner
          if (pointInPoly(vAdd(o, vMul(dir, Math.max(0, hit.lambda) + 1)), poly)) best = Math.max(0, hit.lambda)
        }
      })
    }
    return best
  }
  const segs: Seg[] = []
  // 1. anti-parallel pairs → shared walls (nearest first)
  const cands: { A: REdge; B: REdge; d: number; lo: number; hi: number }[] = []
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const A = edges[i]
      const B = edges[j]
      if (A.room === B.room) continue
      if (vDot(A.n, B.n) > -0.9995) continue
      const d = vDot(vSub(B.p0, A.p0), A.n)
      const d2 = vDot(vSub(B.p1, A.p0), A.n)
      if (Math.abs(d - d2) > 1) continue
      if (d < -1 || d > MAX_GAP) continue
      const t0 = vDot(vSub(B.p0, A.p0), A.e)
      const t1 = vDot(vSub(B.p1, A.p0), A.e)
      const lo = Math.max(0, Math.min(t0, t1))
      const hi = Math.min(A.L, Math.max(t0, t1))
      if (hi - lo < 10) continue
      cands.push({ A, B, d: Math.max(0, d), lo, hi })
    }
  }
  cands.sort((x, y) => x.d - y.d)
  for (const { A, B, d, lo, hi } of cands) {
    const toB = (t: number) => vDot(vSub(vAdd(A.p0, vMul(A.e, t)), B.p0), B.e)
    const toA = (t: number) => vDot(vSub(vAdd(B.p0, vMul(B.e, t)), A.p0), A.e)
    const restA = subtractIntervals([lo, hi], A.covered)
    for (const [a0, a1] of restA) {
      const b0 = Math.min(toB(a0), toB(a1))
      const b1 = Math.max(toB(a0), toB(a1))
      for (const [s0, s1] of subtractIntervals([b0, b1], B.covered)) {
        const x0 = Math.min(toA(s0), toA(s1))
        const x1 = Math.max(toA(s0), toA(s1))
        if (x1 - x0 < 10) continue
        A.covered.push([x0, x1])
        B.covered.push([s0, s1])
        const ra = rooms[A.room]
        const rb = rooms[B.room]
        const kind = sharedWallKind(ra, rb, d)
        if (d > 1 && d < 40)
          issues.push({
            severity: 'warning',
            code: 'TINY_GAP',
            message: `Зазор ${r3(d)} мм между «${ra.id}» и «${rb.id}» — поставлен разделитель без толщины`,
            ids: [ra.id, rb.id],
          })
        const mid = vMul(A.n, d / 2)
        segs.push({
          a: vAdd(vAdd(A.p0, vMul(A.e, x0)), mid),
          b: vAdd(vAdd(A.p0, vMul(A.e, x1)), mid),
          t: kind === 'separator' ? 0 : snapThickness(d, stdT),
          kind,
          height: D.wallHeight,
        })
      }
    }
  }

  // 2. uncovered edge parts → edge walls (skip short junction gaps between other rooms)
  for (const E of edges) {
    E.covered.sort((x, y) => x[0] - y[0])
    for (const [s0, s1] of subtractIntervals([0, E.L], E.covered)) {
      if (s1 - s0 <= MAX_GAP) {
        const probe = vAdd(vAdd(E.p0, vMul(E.e, (s0 + s1) / 2)), vMul(E.n, 30))
        let near = 0
        roomPolys.forEach((poly, ri) => {
          if (!poly || ri === E.room) return
          if (pointInPoly(probe, poly) || distToPolyBoundary(probe, poly) <= MAX_GAP) near++
        })
        const touchesVertex = s0 < 0.5 || s1 > E.L - 0.5
        if (near >= 2 || (!touchesVertex && near >= 1)) continue
        // the side of a step in a wall (the wall gets thicker along its length): beyond the edge lies
        // wall body between two rooms, not the outside → no wall (the step join below closes it)
        const inRoom = (p: Vec2): number => roomPolys.findIndex((poly) => !!poly && pointInPoly(p, poly))
        const hitAlong = (dir: Vec2): number => {
          for (let t = 10; t <= MAX_GAP; t += 10) {
            const ri = inRoom(vAdd(probe, vMul(dir, t)))
            if (ri >= 0) return ri
          }
          return -1
        }
        const h0 = hitAlong(E.e)
        const h1 = hitAlong(vMul(E.e, -1))
        if (h0 >= 0 && h1 >= 0 && h0 !== h1) continue
        // the corner square at a reflex vertex between the room and a neighbour in its notch: the
        // junction of the two walls around the neighbour, not the outside (an outer wall here went
        // a wall thickness into the neighbour's floor)
        if (near >= 1 && (h0 === E.room || h1 === E.room)) continue
      }
      E.kept.push([s0, s1])
    }
  }

  // per-room edge lists in order, to find neighbours at vertices
  const byRoom = new Map<number, REdge[]>()
  for (const E of edges) {
    const list = byRoom.get(E.room) ?? []
    list.push(E)
    byRoom.set(E.room, list)
  }
  for (const list of byRoom.values()) {
    const n = list.length
    for (let k = 0; k < n; k++) {
      const E = list[k]
      const ew = roomEdgeWall(rooms[E.room], D)
      const prev = list[(k - 1 + n) % n]
      const next = list[(k + 1) % n]
      for (const [s0, s1] of E.kept) {
        const off = vMul(E.n, ew.t / 2)
        let a = vAdd(vAdd(E.p0, vMul(E.e, s0)), off)
        let b = vAdd(vAdd(E.p0, vMul(E.e, s1)), off)
        const endAt = (atStart: boolean): Vec2 => {
          const nb = atStart ? prev : next
          const vertex = atStart ? E.p0 : E.p1
          const nbKeptAtVertex = atStart
            ? nb.kept.some(([, x1]) => x1 > nb.L - 0.5)
            : nb.kept.some(([x0]) => x0 < 0.5)
          const convex = atStart ? vCross(nb.e, E.e) > 0 : vCross(E.e, nb.e) > 0
          const base = atStart ? a : b
          if (nbKeptAtVertex) {
            const nbT = roomEdgeWall(rooms[nb.room], D).t
            const nbOff = vMul(nb.n, nbT / 2)
            const hit = lineHit(vAdd(E.p0, off), E.e, vAdd(nb.p0, nbOff), nb.e)
            if (hit && vDist(hit.point, vertex) < 2 * Math.max(ew.t, nbT) + 10) return hit.point
            return base
          }
          if (convex) {
            const dir = vMul(E.e, atStart ? -1 : 1)
            const ext = roomFree(base, dir, E.n, ew.t / 2, ew.t / 2, E.room)
            const end = vAdd(base, vMul(dir, ext))
            if (ext < ew.t / 2 - 0.5) clipped.push(end)
            return end
          }
          return base
        }
        if (s0 < 0.5) a = endAt(true)
        if (s1 > E.L - 0.5) b = endAt(false)
        segs.push({ a, b, t: ew.t, kind: ew.kind, height: ew.h })
      }
    }
  }

  return segs
}

/**
 * Steps in a wall: two parallel walls of different thickness, flush on one side, ending at the same
 * point from opposite directions (a wall that gets thicker along its length). Their axes are offset, so
 * a zero-thickness joint between the two ends closes the plan graph. Run after joinEnds.
 */
function stepJoints(segs: Seg[], height: number): Seg[] {
  const joints: Seg[] = []
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]
      const o = segs[j]
      if (s.kind === 'separator' || o.kind === 'separator' || Math.abs(s.t - o.t) < 1) continue
      const ds = vNorm(vSub(s.b, s.a))
      if (Math.abs(vCross(ds, vNorm(vSub(o.b, o.a)))) > 0.002) continue
      for (const [p, pIn] of [[s.a, s.b], [s.b, s.a]] as const) {
        for (const [q, qIn] of [[o.a, o.b], [o.b, o.a]] as const) {
          const w = vSub(q, p)
          const off = Math.abs(vCross(ds, w))
          if (Math.abs(vDot(w, ds)) > 1 || off < 1) continue
          if (Math.abs(off - Math.abs(s.t - o.t) / 2) > 1) continue
          if (vDot(vSub(pIn, p), ds) * vDot(vSub(qIn, q), ds) >= 0) continue
          // a wall across the step already ends at one of the two ends, on the joint's line (a
          // partition meeting the step): extend it to the other end instead. A zero-thickness joint
          // collinear with that wall gives the room faces a wedge (parallel face lines at a corner)
          const jd = vNorm(vSub(q, p))
          let extended = false
          for (const w of segs) {
            if (extended || w === s || w === o || w.kind === 'separator') continue
            if (Math.abs(vCross(vNorm(vSub(w.b, w.a)), jd)) > 0.002) continue
            for (const end of ['a', 'b'] as const) {
              const e = w[end]
              const far = end === 'a' ? w.b : w.a
              const to = vDist(e, p) < 0.5 ? q : vDist(e, q) < 0.5 ? p : null
              // only outward: the other step end lies beyond this end, not back along the wall
              if (!to || vDot(vSub(to, e), vSub(e, far)) <= 0) continue
              w[end] = to
              extended = true
              break
            }
          }
          if (extended) continue
          joints.push({ a: p, b: q, t: 0, kind: 'separator', height })
        }
      }
    }
  }
  return joints
}

function wallsModeSegments(walls: WallSpec[], U: UnitConv, D: ResolvedDefaults, snap: PlanSnap | undefined): Seg[] {
  const segs: Seg[] = []
  const stdT = snap?.standardThickness !== false
  for (const w of walls) {
    const kind: SpecWallKind = w.kind ?? 'loadBearing'
    const t = kind === 'separator' ? 0 : snapThickness(w.thickness ?? thicknessFor(kind, D), stdT)
    const height = w.height ?? heightFor(kind, D)
    let pts = w.path.map((p) => U.pt(p))
    const closed = w.closed === true && pts.length >= 3
    if (snap?.orthogonal !== false) pts = orthoSnap(pts, closed, snap?.orthoToleranceDeg ?? 3)
    if (closed && w.align && w.align !== 'center' && t > 0) {
      const poly = ccw(pts)
      const sign = w.align === 'inner' ? 1 : -1
      const lines = poly.map((p, i) => {
        const q = poly[(i + 1) % poly.length]
        const e = vNorm(vSub(q, p))
        return { p: vAdd(p, vMul(V(e.y, -e.x), (sign * t) / 2)), e }
      })
      pts = poly.map((p, i) => {
        const l0 = lines[(i - 1 + poly.length) % poly.length]
        const l1 = lines[i]
        const h = lineHit(l0.p, l0.e, l1.p, l1.e)
        return h ? h.point : l1.p
      })
    }
    const count = closed ? pts.length : pts.length - 1
    for (let i = 0; i < count; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (vDist(a, b) >= 1) segs.push({ a, b, t, kind, height, ...(w.cutout ? { cut: true } : {}) })
    }
  }
  return segs
}

function mergeCollinear(segs: Seg[], mergeMm: number): Seg[] {
  const groups = new Map<string, Seg[]>()
  for (const s of segs) {
    // cutout walls merge only with cutout walls, and only end to end (a strip of floor between two
    // cutouts on one line is floor, not a junction to bridge)
    const key = `${s.kind}|${Math.round(s.t)}|${Math.round(s.height)}|${s.cut ? 1 : 0}`
    const g = groups.get(key) ?? []
    g.push(s)
    groups.set(key, g)
  }
  const endpointInGap = (origin: Vec2, dir: Vec2, nrm: Vec2, g0: number, g1: number, lineT: number): boolean => {
    for (const o of segs) {
      const od = vNorm(vSub(o.b, o.a))
      if (Math.abs(vCross(od, dir)) < 0.3) continue
      for (const p of [o.a, o.b]) {
        const dn = Math.abs(vDot(vSub(p, origin), nrm))
        const u = vDot(vSub(p, origin), dir)
        if (dn <= lineT / 2 + 10 && u >= g0 - o.t / 2 - 10 && u <= g1 + o.t / 2 + 10) return true
      }
    }
    return false
  }
  const out: Seg[] = []
  for (const g of groups.values()) {
    const used = new Array<boolean>(g.length).fill(false)
    for (let i = 0; i < g.length; i++) {
      if (used[i]) continue
      const base = g[i]
      let dir = vNorm(vSub(base.b, base.a))
      if (dir.x < -1e-9 || (Math.abs(dir.x) <= 1e-9 && dir.y < 0)) dir = vMul(dir, -1)
      const origin = base.a
      const nrm = V(-dir.y, dir.x)
      const cluster: Seg[] = []
      for (let j = i; j < g.length; j++) {
        if (used[j]) continue
        const s = g[j]
        const sd = vNorm(vSub(s.b, s.a))
        if (Math.abs(vCross(sd, dir)) > 0.002) continue
        if (Math.abs(vDot(vSub(s.a, origin), nrm)) > 1 || Math.abs(vDot(vSub(s.b, origin), nrm)) > 1) continue
        used[j] = true
        cluster.push(s)
      }
      const iv = cluster
        .map((s) => {
          const u0 = vDot(vSub(s.a, origin), dir)
          const u1 = vDot(vSub(s.b, origin), dir)
          return [Math.min(u0, u1), Math.max(u0, u1), s.cut === true] as [number, number, boolean]
        })
        .sort((x, y) => x[0] - y[0])
      let cur = iv[0]
      const flush = (c: [number, number, boolean]) =>
        out.push({ ...base, a: vAdd(origin, vMul(dir, c[0])), b: vAdd(origin, vMul(dir, c[1])), ...(c[2] ? { cut: true } : {}) })
      for (let k = 1; k < iv.length; k++) {
        const nx = iv[k]
        const gap = nx[0] - cur[1]
        // two cutout walls in line (two shafts side by side) have floor between them: the corner
        // walls ending at the gap are theirs, not a junction to bridge
        const bridge = !base.cut && gap <= MAX_GAP && endpointInGap(origin, dir, nrm, cur[1], nx[0], base.t)
        if (gap <= 0.5 || (!base.cut && gap <= mergeMm) || bridge) {
          cur = [cur[0], Math.max(cur[1], nx[1]), cur[2] && nx[2]]
        } else {
          flush(cur)
          cur = nx
        }
      }
      flush(cur)
    }
  }
  return out
}

function cornerRank(o: Seg, lambda: number): number {
  return -o.t * 1e5 + Math.min(lambda, 1e5 - 1)
}

/**
 * Joins the free wall ends. Every pass decides all ends from the same positions and then moves them
 * together, so the result does not depend on the order of the walls (the order follows the
 * coordinates, and with ends moved one by one a turned or mirrored plan was joined differently)
 */
function joinEnds(segs: Seg[], mergeMm: number): void {
  const onAnother = (p: Vec2, self: Seg): boolean =>
    segs.some((o) => o !== self && projectOnSeg(p, o.a, o.b).dist <= 0.5)
  type Move = { s: Seg; end: 'a' | 'b'; p: Vec2; lambda: number }
  const same = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6
  // extension, repeated until chained corners settle
  for (let pass = 0; pass < 6; pass++) {
    const moves: Move[] = []
    const pulls: Move[] = []
    for (const s of segs) {
      for (const end of ['a', 'b'] as const) {
        const p = s[end]
        if (onAnother(p, s)) continue
        const other = end === 'a' ? s.b : s.a
        const dir = vNorm(vSub(p, other))
        // a hit through the body of another wall stops the extension (nearest wins);
        // otherwise (ends meeting near a corner) the thickest target wins, then the nearest
        let body: { lambda: number; point: Vec2 } | null = null
        let corner: { lambda: number; point: Vec2; o: Seg; oEnd: 'a' | 'b'; beyond: boolean } | null = null
        for (const o of segs) {
          if (o === s) continue
          // the outline walls are joined as if there were no cutouts: a cutout wall never draws an
          // outline wall end (that took a short outline stub through the next room's floor)
          if (o.cut && !s.cut) continue
          const od = vSub(o.b, o.a)
          const oL = vLen(od)
          if (oL < 1) continue
          const odn = vMul(od, 1 / oL)
          if (Math.abs(vCross(dir, odn)) < 0.3) continue
          const h = lineHit(p, dir, o.a, odn)
          if (!h) continue
          const reach = Math.max(o.t / 2 + 10, mergeMm)
          const tolMu = Math.max(s.t / 2 + 10, mergeMm)
          if (h.lambda > reach || h.mu < -tolMu || h.mu > oL + tolMu) continue
          const beyond = h.mu < -0.5 || h.mu > oL + 0.5
          if (h.mu > 0.5 && h.mu < oL - 0.5) {
            if (h.lambda > 0.5 && (!body || h.lambda < body.lambda)) body = { lambda: h.lambda, point: h.point }
          } else if (
            // an end already on the other wall's line beyond its end (it got there while that wall
            // moved) still meets it there
            (h.lambda > 0.5 || (beyond && h.lambda >= -0.5)) &&
            (!corner || cornerRank(o, h.lambda) < cornerRank(corner.o, corner.lambda))
          ) {
            corner = { lambda: Math.max(0, h.lambda), point: h.point, o, oEnd: h.mu < oL / 2 ? 'a' : 'b', beyond }
          }
        }
        const best = body ?? corner
        if (!best) continue
        const q = V(r3(best.point.x), r3(best.point.y))
        moves.push({ s, end, p: q, lambda: best.lambda })
        // a corner beyond the other wall's end, which sits on a third wall (a separator) and so never
        // moves itself: bring that end to the corner too, or the two walls never meet
        if (!body && corner?.beyond && onAnother(corner.o[corner.oEnd], corner.o))
          pulls.push({ s: corner.o, end: corner.oEnd, p: q, lambda: corner.lambda })
      }
    }
    // an end pulled by several walls goes to the nearest corner (then the lowest point, for a tie)
    const pulled = new Map<string, Move>()
    for (const m of pulls) {
      const key = `${segs.indexOf(m.s)}${m.end}`
      const cur = pulled.get(key)
      const d = vDist(m.p, m.s[m.end])
      if (!cur) pulled.set(key, m)
      else {
        const dc = vDist(cur.p, cur.s[cur.end])
        if (d < dc - 1e-6 || (Math.abs(d - dc) <= 1e-6 && (m.p.x < cur.p.x || (m.p.x === cur.p.x && m.p.y < cur.p.y)))) pulled.set(key, m)
      }
    }
    let changed = false
    for (const m of [...moves, ...pulled.values()]) {
      if (same(m.s[m.end], m.p)) continue
      m.s[m.end] = m.p
      changed = true
    }
    if (!changed) break
  }
  // trimming of short overshoots past a crossing wall (free ends only), decided together as well
  const trims: Move[] = []
  for (const s of segs) {
    for (const end of ['a', 'b'] as const) {
      const p = s[end]
      const other = end === 'a' ? s.b : s.a
      const sl = vDist(p, other)
      const dir = vNorm(vSub(p, other))
      let best: { lambda: number; point: Vec2 } | null = null
      for (const o of segs) {
        if (o === s) continue
        const od = vSub(o.b, o.a)
        const oL = vLen(od)
        if (oL < 1) continue
        const odn = vMul(od, 1 / oL)
        if (Math.abs(vCross(dir, odn)) < 0.3) continue
        const h = lineHit(p, dir, o.a, odn)
        if (!h) continue
        if (h.lambda < -0.5 && h.lambda >= -(o.t / 2 + 10) && h.mu >= -0.5 && h.mu <= oL + 0.5 && sl + h.lambda > 1) {
          if (!best || h.lambda > best.lambda) best = { lambda: h.lambda, point: h.point }
        }
      }
      if (best) {
        // only a free end (nothing else touches it) is trimmed
        const touching = segs.some((o) => o !== s && projectOnSeg(p, o.a, o.b).dist <= 0.5)
        // … and no other wall ends on the overshoot (a partition meeting it there would dangle)
        const cut = best.point
        const carries = segs.some(
          (o) => o !== s && [o.a, o.b].some((q) => vDist(q, cut) > 0.5 && projectOnSeg(q, cut, p).dist <= 0.5),
        )
        if (!touching && !carries) trims.push({ s, end, p: V(r3(best.point.x), r3(best.point.y)), lambda: best.lambda })
      }
    }
  }
  for (const m of trims) m.s[m.end] = m.p
}


// ───────────────────────────── compiler ─────────────────────────────

export interface CompileOptions {
  /** add the source image as an Underlay (px specs with source.image/size). Default false. */
  underlay?: boolean
}

export interface CompileResult {
  doc: Doc
  levelId: Id
  issues: PlanIssue[]
  /** spec room id → Room record id */
  roomIds: Record<string, Id>
  /** spec opening index → Opening id (null if it could not be placed) */
  openingIds: (Id | null)[]
}

const FIXTURE_KIND: Record<string, ProceduralKind> = {
  column: 'column',
  riser: 'column',
  ventShaft: 'column',
  chimney: 'column',
  radiator: 'radiator',
  bathtub: 'bathtub',
  bath: 'bathtub',
  shower: 'shower',
  toilet: 'toilet',
  washbasin: 'washbasin',
  sink: 'sink',
  kitchenSink: 'sink',
  stove: 'stove',
  hob: 'stove',
  oven: 'oven',
  hood: 'hood',
  fridge: 'fridge',
  refrigerator: 'fridge',
  washer: 'washingMachine',
  washingMachine: 'washingMachine',
  dishwasher: 'dishwasher',
  boiler: 'box',
  electricPanel: 'box',
  sofa: 'sofa',
  bed: 'bed',
  table: 'table',
  chair: 'chair',
  wardrobe: 'wardrobe',
  shelf: 'shelf',
  tv: 'tv',
  rug: 'rug',
  mirror: 'mirror',
  picture: 'picture',
  stairs: 'stairs',
  airConditioner: 'airConditioner',
  plant: 'plantPot',
  plantPot: 'plantPot',
  kitchenBase: 'kitchenBase',
  kitchenWall: 'kitchenWall',
  kitchenTall: 'kitchenTall',
  worktop: 'worktop',
  box: 'box',
}

function findFixtureAsset(f: FixtureSpec): Asset | undefined {
  if (f.assetId) {
    const a = BUILTIN_ASSETS.find((x) => x.id === f.assetId)
    if (a) return a
  }
  const kind = FIXTURE_KIND[f.type]
  if (kind) {
    const a = BUILTIN_ASSETS.find((x) => x.procedural === kind)
    if (a) return a
  }
  return BUILTIN_ASSETS.find((x) => x.category === f.type || x.procedural === f.type)
}

function wallDir(doc: Doc, w: Wall): { A: Vec2; B: Vec2; d: Vec2; L: number } | null {
  const na = doc.nodes[w.a]
  const nb = doc.nodes[w.b]
  if (!na || !nb) return null
  const A = V(na.x, na.y)
  const B = V(nb.x, nb.y)
  const L = vDist(A, B)
  if (L < 1e-6) return null
  return { A, B, d: vMul(vSub(B, A), 1 / L), L }
}

/** Full compiler with diagnostics. */
// ───────────────────────────── dimension provenance ─────────────────────────────

const PROV_PARALLEL_COS = Math.cos((5 * Math.PI) / 180)

function specDimProv(s: SpecDimSource): { source: DimSource; tol?: number; date?: string; note?: string } {
  return typeof s === 'string' ? { source: s } : s
}

/** a spec edge (mm) and the provenance it carries */
interface ProvEdge {
  p0: Vec2
  p1: Vec2
  src: SpecDimSource
}

function isSingleSource(g: SpecRoomDimSources): g is SpecDimSource {
  return typeof g === 'string' || (!Array.isArray(g) && 'source' in g)
}

/** the spec edges of a room with their sources; rect sides are recognised geometrically */
function roomProvEdges(r: RoomSpec, poly: Vec2[] | null, U: UnitConv, fallback: SpecDimSource | undefined): ProvEdge[] {
  const out: ProvEdge[] = []
  const given = r.source
  const pick = (i: number, side: RoomSide | null): SpecDimSource | undefined => {
    if (given === undefined) return fallback
    if (isSingleSource(given)) return given
    if (Array.isArray(given)) return given[i] ?? fallback
    return (side ? (given as Partial<Record<RoomSide, SpecDimSource>>)[side] : undefined) ?? fallback
  }
  if (r.rect && r.rect.length === 4 && poly) {
    const xs = poly.map((p) => p.x)
    const ys = poly.map((p) => p.y)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const sides: [RoomSide, Vec2, Vec2][] = [
      ['top', V(x0, y0), V(x1, y0)],
      ['right', V(x1, y0), V(x1, y1)],
      ['bottom', V(x1, y1), V(x0, y1)],
      ['left', V(x0, y1), V(x0, y0)],
    ]
    sides.forEach(([side, p0, p1], i) => {
      const s = pick(i, side)
      if (s !== undefined) out.push({ p0, p1, src: s })
    })
    return out
  }
  if (r.polygon && r.polygon.length >= 3) {
    // original (unsnapped) points: matching is tolerant, edge indices stay those the author wrote
    const pts = r.polygon.map((p) => U.pt(p))
    for (let i = 0; i < pts.length; i++) {
      const s = pick(i, null)
      if (s !== undefined) out.push({ p0: pts[i], p1: pts[(i + 1) % pts.length], src: s })
    }
  }
  return out
}

/** best spec edge for a boundary segment: parallel, overlapping by at least half, nearest within maxDist */
function matchProvEdge(a: Vec2, b: Vec2, cands: ProvEdge[], maxDist: number): ProvEdge | null {
  const L = vDist(a, b)
  if (L < 1) return null
  const d = V((b.x - a.x) / L, (b.y - a.y) / L)
  const mid = V((a.x + b.x) / 2, (a.y + b.y) / 2)
  let best: ProvEdge | null = null
  let bestDist = maxDist
  for (const c of cands) {
    const cl = vDist(c.p0, c.p1)
    if (cl < 1) continue
    const cd = V((c.p1.x - c.p0.x) / cl, (c.p1.y - c.p0.y) / cl)
    if (Math.abs(d.x * cd.x + d.y * cd.y) < PROV_PARALLEL_COS) continue
    // overlap of [a, b] with the candidate along cd
    const ta = (a.x - c.p0.x) * cd.x + (a.y - c.p0.y) * cd.y
    const tb = (b.x - c.p0.x) * cd.x + (b.y - c.p0.y) * cd.y
    const ov = Math.min(Math.max(ta, tb), cl) - Math.max(Math.min(ta, tb), 0)
    if (ov < L * 0.5) continue
    const dist = Math.abs((mid.x - c.p0.x) * -cd.y + (mid.y - c.p0.y) * cd.x)
    if (dist <= bestDist) {
      bestDist = dist
      best = c
    }
  }
  return best
}

/**
 * Writes Wall.dims from the spec's "source" fields: room sides (rect/polygon rooms), wall segments and
 * the top-level "dimSource" (default 'estimated' for units "px"). Room sources win over wall sources.
 */
function applySpecProvenance(doc: Doc, levelId: Id, spec: PlanSpec, U: UnitConv, polys: (Vec2[] | null)[], roomIds: Record<string, Id>): void {
  const fallback: SpecDimSource | undefined = spec.dimSource ?? (spec.units === 'px' ? 'estimated' : undefined)
  const wallEdges: ProvEdge[] = []
  for (const w of spec.walls ?? []) {
    if (w.source === undefined) continue
    const pts = w.path.map((p) => U.pt(p))
    for (let j = 0; j + 1 < pts.length; j++) {
      const s = Array.isArray(w.source) ? w.source[j] : w.source
      if (s !== undefined) wallEdges.push({ p0: pts[j], p1: pts[j + 1], src: s })
    }
  }
  const roomEdges = new Map<Id, ProvEdge[]>()
  spec.rooms.forEach((r, i) => {
    const rid = roomIds[r.id]
    if (!rid || r.source === undefined) return
    const edges = roomProvEdges(r, polys[i], U, fallback)
    if (edges.length) roomEdges.set(rid, edges)
  })
  if (!wallEdges.length && !roomEdges.size && fallback === undefined) return
  const plan = derivePlan(doc, levelId)
  const set = (wallId: Id, side: 'left' | 'right', from: Vec2, to: Vec2, s: SpecDimSource): void => {
    const w = doc.walls[wallId]
    if (!w) return
    const p = specDimProv(s)
    if (p.source === 'drawn') {
      if (w.dims) delete w.dims[side]
      return
    }
    const dims = w.dims ?? (w.dims = {})
    dims[side] = makeProvenance(p.source, vDist(from, to), { tol: p.tol, date: p.date, note: p.note })
  }
  for (const room of plan.rooms) {
    const cands = roomEdges.get(room.roomId)
    for (const e of room.edges) {
      const w = doc.walls[e.wallId]
      if (!w) continue
      // room sides: the clear face lies on the room outline (rooms mode) or near it (walls mode)
      let hit = cands ? matchProvEdge(e.from, e.to, cands, Math.max(150, w.thickness)) : null
      // wall segments: the face is half a thickness off the centreline
      if (!hit && wallEdges.length) hit = matchProvEdge(e.from, e.to, wallEdges, w.thickness / 2 + 30)
      if (hit) set(e.wallId, e.side, e.from, e.to, hit.src)
      else if (fallback !== undefined) set(e.wallId, e.side, e.from, e.to, fallback)
    }
  }
  for (const w of Object.values(doc.walls)) if (w.dims && !w.dims.left && !w.dims.right) delete w.dims
}

export function compilePlanSpecDetailed(spec: PlanSpec, opts: CompileOptions = {}): CompileResult {
  const issues: PlanIssue[] = []
  const U = makeUnits(spec)
  const D = resolveDefaults(spec)
  const snap = spec.snap
  const stdT = snap?.standardThickness !== false

  const doc = createEmptyDoc(spec.name ?? 'План')
  const levelId = doc.levelOrder[0]
  const level = doc.levels[levelId]
  level.height = D.wallHeight
  doc.settings.wallHeight = D.wallHeight

  const polys = spec.rooms.map((r) => roomPolygonMm(r, U, snap))
  const refPoints = spec.rooms.map((r) => roomRefPoint(r, U, snap))
  const shapes = spec.rooms.map((r) => (r.cutouts?.length ? roomShapeMm(r, U, snap, D.partition, D.wallHeight) : null))
  // the outline walls are built as if there were no cutouts (a cutout changes nothing for the rooms
  // beside); the cutouts add their own walls inside, along the floor
  const voids = shapes.flatMap((sh, host) => (sh ? sh.voids.map((v) => ({ host, v })) : []))

  // ── walls
  const wallsMode = (spec.walls?.length ?? 0) > 0
  // Mixed mode (documented): explicit walls are ADDED to the walls inferred from rooms that carry a
  // rect/polygon — e.g. shaft outlines drawn inside rect rooms. Pure walls-mode (rooms as `at` labels
  // only) infers nothing from rooms.
  const roomsWithGeometry = polys.some(Boolean)
  const clipped: Vec2[] = []
  let segs = [
    ...(wallsMode ? wallsModeSegments(spec.walls!, U, D, snap) : []),
    ...(roomsWithGeometry || !wallsMode ? roomsModeSegments(spec.rooms, polys, D, stdT, issues, clipped) : []),
    ...shapes.flatMap((sh) => sh?.walls ?? []),
  ]
  // the snap tolerances follow the outline walls: a thick column wall must not let them reach further
  const maxT = segs.reduce((m, s) => (s.cut ? m : Math.max(m, s.t)), 0)
  const mergeMm = snap?.mergeMm ?? maxT / 2 + 50
  segs = mergeCollinear(segs, mergeMm)
  joinEnds(segs, mergeMm)
  segs = [...segs, ...stepJoints(segs, D.wallHeight)]
  segs = segs.filter((s) => vDist(s.a, s.b) >= 1).sort((x, y) => vDist(y.a, y.b) - vDist(x.a, x.b))
  for (const s of segs) {
    addWall(doc, levelId, s.a, s.b, { thickness: s.t, height: s.height, kind: WALL_KIND_MAP[s.kind] })
  }
  normalize(doc)

  // ── openings
  const roomIndex = new Map(spec.rooms.map((r, i) => [r.id, i]))
  const levelWalls = () => Object.values(doc.walls).filter((w) => w.levelId === levelId)
  const sideOf = (w: Wall, p: Vec2): 'left' | 'right' | null => {
    const g = wallDir(doc, w)
    if (!g) return null
    const nL = V(g.d.y, -g.d.x)
    const s = vDot(vSub(p, g.A), nL)
    if (Math.abs(s) < 1e-6) return null
    return s > 0 ? 'left' : 'right'
  }
  const insideAnyRoom = (p: Vec2): boolean =>
    polys.some((poly) => poly && pointInPoly(p, poly)) ||
    (wallsMode && derivePlan(doc, levelId).rooms.some((r) => pointInPoly(p, r.polygon)))

  const openingIds: (Id | null)[] = []
  spec.openings.forEach((o, oi) => {
    const path = `openings[${oi}]`
    const label = o.id ?? `#${oi}`
    let point: Vec2 | null = null
    let pref: Vec2 | null = null
    if (o.at) point = U.pt(o.at)
    else if (o.wall !== undefined) {
      const ws = spec.walls?.find((w) => w.id === o.wall)
      if (!ws) {
        issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: стена «${o.wall}» не найдена`, path, ids: [label] })
        openingIds.push(null)
        return
      }
      const pts = ws.path.map((p) => U.pt(p))
      if (ws.closed && pts.length >= 3) pts.push(pts[0])
      let rest = U.len(o.offset ?? 0)
      for (let i = 0; i + 1 < pts.length; i++) {
        const L = vDist(pts[i], pts[i + 1])
        if (rest <= L || i + 2 === pts.length) {
          const e = vNorm(vSub(pts[i + 1], pts[i]))
          point = vAdd(pts[i], vMul(e, Math.min(rest, L)))
          pref = e
          break
        }
        rest -= L
      }
    } else if (o.room !== undefined) {
      const ri = roomIndex.get(o.room)
      const poly = ri !== undefined ? polys[ri] : null
      if (!poly) {
        issues.push({
          severity: 'error',
          code: 'OPENING_BAD_REF',
          message: `Проём ${label}: комната «${o.room}» не найдена или не имеет rect/polygon`,
          path,
          ids: [label],
        })
        openingIds.push(null)
        return
      }
      const edge = pickRoomEdge(poly, o.side, o.edge)
      if (!edge) {
        issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: сторона комнаты не найдена`, path, ids: [label] })
        openingIds.push(null)
        return
      }
      const L = vDist(edge.p0, edge.p1)
      const e = vNorm(vSub(edge.p1, edge.p0))
      let t = o.offset !== undefined ? U.len(o.offset) : L / 2
      if (o.edge === undefined && o.side) {
        const reversed = o.side === 'top' || o.side === 'bottom' ? e.x < 0 : e.y < 0
        if (reversed) t = L - t
      }
      point = vAdd(edge.p0, vMul(e, t))
      pref = e
    }
    if (!point) {
      issues.push({
        severity: 'error',
        code: 'OPENING_NO_POSITION',
        message: `Проём ${label}: нужно указать at, wall+offset или room+side`,
        path,
        ids: [label],
      })
      openingIds.push(null)
      return
    }
    const width = U.len(o.width)
    const found = projectToWall(doc, levelWalls(), point, pref)
    if (!found) {
      issues.push({
        severity: 'error',
        code: 'OPENING_OFF_WALL',
        message: `Проём ${label}: рядом с точкой (${Math.round(point.x)}, ${Math.round(point.y)}) нет стены`,
        path,
        ids: [label],
      })
      openingIds.push(null)
      return
    }
    const { wall, offset: rawOffset, L } = found
    let offset = rawOffset
    const margin = 50
    if (L >= width + 2 * margin) offset = Math.min(Math.max(offset, width / 2 + margin), L - width / 2 - margin)
    else {
      offset = L / 2
      issues.push({
        severity: 'warning',
        code: 'OPENING_TOO_WIDE',
        message: `Проём ${label}: ширина ${Math.round(width)} мм больше участка стены ${Math.round(L)} мм`,
        path,
        ids: [label],
      })
    }
    if (Math.abs(offset - rawOffset) > 1)
      issues.push({
        severity: 'warning',
        code: 'OPENING_NEAR_CORNER',
        message: `Проём ${label}: сдвинут на ${Math.round(Math.abs(offset - rawOffset))} мм, чтобы не заходить в угол`,
        path,
        ids: [label],
      })
    const kind = OPENING_MAP[o.type]
    const def = OPENING_DEFAULTS[kind]
    const isWindow = kind === 'window'
    const isDoorish = !isWindow && kind !== 'frenchWindow' && kind !== 'balconyBlock'
    const height = o.height ?? (isWindow ? (D.windowHeight ?? def.height) : isDoorish ? (D.doorHeight ?? def.height) : def.height)
    const sill = o.sill ?? (isWindow ? (D.windowSill ?? def.sill) : def.sill)

    // swing side & hinge
    let swing: 'left' | 'right' = 'left'
    let hinge: 'a' | 'b' = 'a'
    if (o.swingSide) swing = o.swingSide
    else {
      const target = o.opensInto ?? o.between?.find((b) => b !== 'outside')
      if (target && target !== 'outside') {
        const ri = roomIndex.get(target)
        const rp = ri !== undefined ? refPoints[ri] : null
        const s = rp ? sideOf(wall, rp) : null
        if (s) swing = s
      } else if (target === 'outside') {
        const otherRoom = o.between?.find((b) => b !== 'outside')
        const ri = otherRoom ? roomIndex.get(otherRoom) : undefined
        const rp = ri !== undefined ? refPoints[ri] : null
        const s = rp ? sideOf(wall, rp) : null
        if (s) swing = s === 'left' ? 'right' : 'left'
        else {
          const g = wallDir(doc, wall)!
          const nL = V(g.d.y, -g.d.x)
          const probe = vAdd(vAdd(g.A, vMul(g.d, offset)), vMul(nL, wall.thickness / 2 + 200))
          swing = insideAnyRoom(probe) ? 'right' : 'left'
        }
      }
    }
    if (o.hingeEnd) hinge = o.hingeEnd
    else if (o.hinge) hinge = (o.hinge === 'left') === (swing === 'left') ? 'b' : 'a'

    const patch: Partial<import('./types').Opening> = { width, height, sill, hinge, swing }
    if (o.sashes !== undefined) patch.sashes = o.sashes
    if (o.type === 'pocketDoor') patch.slide = 'pocket'
    else if (o.type === 'foldingDoor') patch.slide = 'folding'
    else if (kind === 'slidingDoor' && o.slide && o.slide !== 'surface') patch.slide = o.slide
    if (o.style) patch.style = o.style
    const id = addOpening(doc, wall.id, kind, offset, patch)
    openingIds.push(id)
  })
  normalize(doc)

  // ── rooms
  const roomIds: Record<string, Id> = {}
  spec.rooms.forEach((r, i) => {
    const ref = refPoints[i]
    if (!ref) {
      issues.push({
        severity: 'error',
        code: 'ROOM_NO_GEOMETRY',
        message: `Комната «${r.id}»: нет rect, polygon или at`,
        path: `rooms[${i}]`,
        ids: [r.id],
      })
      return
    }
    const type = ROOM_TYPE_MAP[r.type ?? 'other']
    const rec: Room = defaultRoom(levelId, ref)
    rec.name = r.name ?? ROOM_TYPE_NAMES[type].ru
    rec.type = type
    if (r.ceilingHeight !== undefined) rec.ceiling = { ...rec.ceiling, height: r.ceilingHeight }
    else if (D.ceilingHeight !== D.wallHeight) rec.ceiling = { ...rec.ceiling, height: D.ceilingHeight }
    // the doc keeps the clear-area equivalent: a loggia printed as 1,3 (×0.5) is 2.6 m² of floor
    if (r.labelledArea !== undefined && r.labelledArea > 0)
      rec.labelledArea = Math.round((r.labelledArea / (r.labelledAreaCoef ?? 1)) * 100) / 100
    if (r.technical) rec.technical = true
    doc.rooms[rec.id] = rec
    roomIds[r.id] = rec.id
  })
  syncRooms(doc)
  // the faces left inside cutouts are technical rooms (shaft / box / column), not «Комната N»
  if (voids.length) {
    const CUT_NAMES: Record<SpecCutoutKind, string> = { shaft: 'Шахта', box: 'Короб', column: 'Колонна' }
    const inCut = (p: Vec2, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1
    for (const face of derivePlan(doc, levelId).rooms) {
      if (doc.rooms[face.roomId] && Object.values(roomIds).includes(face.roomId)) continue
      const p = interiorPoint(face.polygon)
      // the planned void, or any leftover inside the cutout (a thick continued outline wall can
      // leave the void a sliver beside it)
      const hit = voids.find(({ v }) => pointInPoly(p, v.poly)) ?? voids.find(({ v }) => inCut(p, v.cut))
      if (!hit) continue
      // a void under 0.1 m² gets no record from syncRooms: it still is the cutout, not a nameless face
      let rec = doc.rooms[face.roomId]
      if (!rec) {
        rec = defaultRoom(levelId, p)
        doc.rooms[rec.id] = rec
      }
      const cut = spec.rooms[hit.host].cutouts?.[hit.v.index]
      rec.name = cut?.name ?? CUT_NAMES[hit.v.kind]
      rec.type = 'other'
      // not floor, whatever its size: a 1.4 × 1.4 m shaft must not add 2 m² to the flat
      rec.technical = true
    }
  }
  for (const [sid, rid] of Object.entries(roomIds)) {
    if (!doc.rooms[rid]) {
      delete roomIds[sid]
      issues.push({
        severity: 'error',
        code: 'ROOM_OPEN',
        message: `Комната «${sid}»: точка метки не попала ни в один замкнутый контур стен`,
        ids: [sid],
      })
    }
  }
  applySpecProvenance(doc, levelId, spec, U, polys, roomIds)
  if (spec.source) {
    const s = spec.source
    const ds: NonNullable<Doc['source']> = {}
    if (s.kind) ds.kind = s.kind
    if (s.labelledTotalArea && s.labelledTotalArea > 0) ds.labelledTotalArea = s.labelledTotalArea
    if (s.labelledLivingArea && s.labelledLivingArea > 0) ds.labelledLivingArea = s.labelledLivingArea
    if (Object.keys(ds).length) doc.source = ds
  }

  // ── fixtures / furniture
  const fixtures = [...(spec.fixtures ?? []), ...(spec.furniture ?? [])]
  fixtures.forEach((f, i) => {
    const asset = findFixtureAsset(f)
    const path = i < (spec.fixtures?.length ?? 0) ? `fixtures[${i}]` : `furniture[${i - (spec.fixtures?.length ?? 0)}]`
    if (!asset) {
      issues.push({ severity: 'warning', code: 'FIXTURE_UNKNOWN', message: `Неизвестный тип «${f.type}» — пропущен`, path })
      return
    }
    let center: Vec2 | null = null
    const rot = f.rotation ?? 0
    const size = { ...asset.size }
    if (f.rect && f.rect.length === 4) {
      const p0 = U.pt([f.rect[0], f.rect[1]])
      const p1 = U.pt([f.rect[0] + f.rect[2], f.rect[1] + f.rect[3]])
      center = V((p0.x + p1.x) / 2, (p0.y + p1.y) / 2)
      const rw = Math.abs(p1.x - p0.x)
      const rh = Math.abs(p1.y - p0.y)
      const quarter = Math.round((((rot % 360) + 360) % 360) / 90) % 2 === 1
      size.w = quarter ? rh : rw
      size.d = quarter ? rw : rh
    } else if (f.at) center = U.pt(f.at)
    if (f.size && f.size.length >= 2) {
      size.w = f.size[0]
      size.d = f.size[1]
      if (f.size.length >= 3) size.h = f.size[2]
    }
    if (!center) {
      issues.push({ severity: 'warning', code: 'FIXTURE_NO_POSITION', message: `«${f.type}»: нет rect или at — пропущен`, path })
      return
    }
    const patch: Partial<Item> = { rotation: rot, size }
    if (f.name) patch.name = f.name
    if (f.elevation !== undefined) patch.elevation = f.elevation
    addItem(doc, levelId, asset, center.x, center.y, patch)
  })

  // ── underlay
  if (opts.underlay && spec.units === 'px' && spec.source?.image && spec.source.size) {
    const k = mmPerPxOf(spec)
    if (k) {
      const o = spec.source.originPx ?? [0, 0]
      const u: Underlay = {
        id: newId('u'),
        levelId,
        src: spec.source.image,
        x: -o[0] * k.x,
        y: -o[1] * k.y,
        scale: k.x,
        rotation: 0,
        opacity: 0.5,
        visible: true,
        locked: true,
        widthPx: spec.source.size[0],
        heightPx: spec.source.size[1],
      }
      doc.underlays[u.id] = u
    }
  }

  return { doc, levelId, issues, roomIds, openingIds }
}

/** PlanSpec → Doc (one level). Throws on unusable input (e.g. px without scale). */
export function compilePlanSpec(spec: PlanSpec, opts?: CompileOptions): Doc {
  return compilePlanSpecDetailed(spec, opts).doc
}

function pickRoomEdge(poly: Vec2[], side: RoomSide | undefined, edge: number | undefined): { p0: Vec2; p1: Vec2 } | null {
  const n = poly.length
  if (edge !== undefined) {
    const i = ((Math.round(edge) % n) + n) % n
    return { p0: poly[i], p1: poly[(i + 1) % n] }
  }
  if (!side) return null
  const want = side === 'top' ? V(0, -1) : side === 'bottom' ? V(0, 1) : side === 'left' ? V(-1, 0) : V(1, 0)
  let best: { p0: Vec2; p1: Vec2; score: number; L: number } | null = null
  for (let i = 0; i < n; i++) {
    const p0 = poly[i]
    const p1 = poly[(i + 1) % n]
    const e = vNorm(vSub(p1, p0))
    const out = V(e.y, -e.x)
    if (vDot(out, want) < 0.7) continue
    const mid = vMul(vAdd(p0, p1), 0.5)
    const score = vDot(mid, want)
    const L = vDist(p0, p1)
    if (!best || score > best.score + 1 || (Math.abs(score - best.score) <= 1 && L > best.L)) best = { p0, p1, score, L }
  }
  return best ? { p0: best.p0, p1: best.p1 } : null
}

function projectToWall(
  doc: Doc,
  walls: Wall[],
  p: Vec2,
  pref: Vec2 | null,
): { wall: Wall; offset: number; L: number; dist: number } | null {
  const pick = (filter: (w: Wall, d: Vec2) => boolean) => {
    let best: { wall: Wall; offset: number; L: number; dist: number } | null = null
    for (const w of walls) {
      const g = wallDir(doc, w)
      if (!g || !filter(w, g.d)) continue
      const pr = projectOnSeg(p, g.A, g.B)
      const limit = Math.max(w.thickness, 300)
      if (pr.dist > limit) continue
      if (!best || pr.dist < best.dist - 0.01) best = { wall: w, offset: pr.along, L: g.L, dist: pr.dist }
    }
    return best
  }
  const solid = (w: Wall) => w.kind !== 'virtual'
  if (pref) {
    const r = pick((w, d) => solid(w) && Math.abs(vDot(d, pref)) > 0.9)
    if (r) return r
  }
  return pick((w) => solid(w)) ?? pick(() => true)
}

// ───────────────────────────── validator ─────────────────────────────

export function areaThreshold(computed: number, labelled: number): PlanIssueSeverity | null {
  const delta = Math.abs(computed - labelled)
  if (delta > Math.max(0.4, 0.05 * labelled)) return 'error'
  if (delta > Math.max(0.15, 0.02 * labelled)) return 'warning'
  return null
}

/**
 * mm: how far a built room face may stray from its spec shape. Thickness snapping moves a face by up
 * to 7.5 mm, a zero-thickness separator in a < 40 mm gap by up to 20 mm.
 */
const BUILT_SHAPE_TOL = 25
/** a built-shape difference this small (a corner notch of a wall junction) only warns: the areas
 *  stay within rounding and no wall pokes far into the floor */
function builtShapeSeverity(dev: number, dA: number, holes: boolean): 'error' | 'warning' {
  return holes || dev >= 300 || Math.abs(dA) >= 0.05 ? 'error' : 'warning'
}

/** the largest distance from the boundary of rings `a` to the boundary of rings `b` (sampled ≤ 50 mm) */
function boundaryDeviation(a: Vec2[][], b: Vec2[][], skip?: (s: Vec2, side: Vec2) => boolean): number {
  let worst = 0
  for (const ring of a)
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % ring.length]
      const n = Math.max(1, Math.ceil(vDist(p, q) / 50))
      const side = vDist(p, q) > 1e-9 ? vMul(V(-(q.y - p.y), q.x - p.x), 1 / vDist(p, q)) : V(0, 0)
      for (let k = 0; k < n; k++) {
        const s = vAdd(p, vMul(vSub(q, p), k / n))
        if (skip?.(s, side)) continue
        let d = Infinity
        for (const r of b) d = Math.min(d, distToPolyBoundary(s, r))
        if (d > worst) worst = d
      }
    }
  return worst
}

/**
 * The number of holes of a built face as the checked shape sees them: holes sharing a piece of a side
 * are one hole (partly adjacent cutouts, each with its own void), and a hole sharing a side with the
 * outer ring is a notch of the outline (a shaft against a column at the outline). Holes meeting at a
 * single point stay apart, as the checked shape keeps them.
 */
function holeGroups(outer: Vec2[], holes: Vec2[][]): number {
  const rings = [outer, ...holes]
  const up = rings.map((_, i) => i)
  const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])))
  for (let i = 0; i < rings.length; i++)
    for (let j = i + 1; j < rings.length; j++) if (sharesSide(rings[i], rings[j])) up[find(i)] = find(j)
  return rings.filter((_, i) => find(i) === i && find(i) !== find(0)).length
}

/**
 * two rings share a piece of a side (not just a point: holes meeting at a corner stay two holes). The
 * piece must be longer than the shape tolerance: a snapped wall (a 95 mm gap built 100) moves a reflex
 * corner a few mm along the hole beside it, which is no shared side
 */
function sharesSide(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = a[(i + 1) % a.length]
    const len = vLen(vSub(q, p))
    if (len < 1) continue
    const u = vMul(vSub(q, p), 1 / len)
    for (let j = 0; j < b.length; j++) {
      const r = b[j]
      const s = b[(j + 1) % b.length]
      // both ends of b's side on a's line, then the overlap of the two along it
      const off = (x: Vec2) => Math.abs(vCross(u, vSub(x, p)))
      if (off(r) > 1 || off(s) > 1) continue
      const t0 = vDot(vSub(r, p), u)
      const t1 = vDot(vSub(s, p), u)
      if (Math.min(len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > BUILT_SHAPE_TOL) return true
    }
  }
  return false
}

/** BTI coefficients a printed outdoor-room area may carry (loggia 0.5, balcony / terrace 0.3) */
export const SUMMER_AREA_COEFS = [0.5, 0.3] as const

/**
 * An outdoor room whose clear area is far from the printed one, but matches it after a BTI
 * coefficient — the printed number most likely already includes it.
 */
export function guessAreaCoef(computed: number, labelled: number): number | null {
  if (!(labelled > 0) || !areaThreshold(computed, labelled)) return null
  for (const k of SUMMER_AREA_COEFS) if (!areaThreshold(computed * k, labelled)) return k
  return null
}

/** severity of an area mismatch after the author's explanation: an explained error is only a warning */
export function explainedSeverity(sev: PlanIssueSeverity, note: string | undefined): PlanIssueSeverity {
  return note && note.trim() && sev === 'error' ? 'warning' : sev
}

/** Full validation with metrics (same code as the in-app check and `dp spec validate`). */
export function validatePlanSpecDetailed(input: PlanSpec): PlanValidation {
  const c = new Coercer()
  const spec = coerceSpec(input, c)
  const issues: PlanIssue[] = [...c.issues]
  const metrics: PlanValidation['metrics'] = { totalArea: 0, livingArea: 0, perRoom: [] }
  const done = (): PlanValidation => ({ ok: !issues.some((i) => i.severity === 'error'), issues, metrics })
  if (issues.some((i) => i.severity === 'error')) return done()

  // ── scale
  if (spec.units === 'px') {
    if (!mmPerPxOf(spec)) {
      issues.push({ severity: 'error', code: 'SCALE_MISSING', message: 'units "px": нужен source.mmPerPx или калибровка', path: 'source' })
      return done()
    }
  }
  const cal = (spec.source?.calibration ?? []).filter((k) => k.mm > 0)
  if (cal.length >= 2) {
    const ks = cal.map((k) => k.mm / Math.max(1e-9, Math.hypot(k.p2[0] - k.p1[0], k.p2[1] - k.p1[1])))
    const mn = Math.min(...ks)
    const mx = Math.max(...ks)
    if ((mx - mn) / mn > 0.02)
      issues.push({
        severity: 'warning',
        code: 'SCALE_INCONSISTENT',
        message: `Калибровки расходятся на ${(((mx - mn) / mn) * 100).toFixed(1)} % — план может быть не в масштабе`,
        path: 'source.calibration',
      })
  }
  if (spec.source?.mmPerPx && cal.length) {
    const k = cal[0].mm / Math.max(1e-9, Math.hypot(cal[0].p2[0] - cal[0].p1[0], cal[0].p2[1] - cal[0].p1[1]))
    if (Math.abs(k - spec.source.mmPerPx) / spec.source.mmPerPx > 0.02)
      issues.push({
        severity: 'warning',
        code: 'SCALE_INCONSISTENT',
        message: 'source.mmPerPx не совпадает с калибровкой (> 2 %)',
        path: 'source.mmPerPx',
      })
  }
  const U = makeUnits(spec)
  const D = resolveDefaults(spec)
  const wallsMode = (spec.walls?.length ?? 0) > 0

  // ── ids
  const dup = (list: { id?: string }[], what: string, path: string) => {
    const seen = new Set<string>()
    list.forEach((x, i) => {
      if (!x.id) return
      if (seen.has(x.id))
        issues.push({ severity: 'error', code: 'DUPLICATE_ID', message: `${what}: повторяется id «${x.id}»`, path: `${path}[${i}]`, ids: [x.id] })
      seen.add(x.id)
    })
  }
  dup(spec.rooms, 'Комнаты', 'rooms')
  dup(spec.walls ?? [], 'Стены', 'walls')
  dup(spec.openings, 'Проёмы', 'openings')
  if (!spec.rooms.length) issues.push({ severity: 'warning', code: 'NO_ROOMS', message: 'В плане нет комнат' })

  // ── rooms static
  const polys = spec.rooms.map((r) => roomPolygonMm(r, U, spec.snap))
  const shapes = spec.rooms.map((r) => (r.cutouts?.length ? roomShapeMm(r, U, spec.snap, D.partition, D.wallHeight) : null))
  spec.rooms.forEach((r, i) => {
    const path = `rooms[${i}]`
    for (const p of shapes[i]?.problems ?? []) issues.push({ ...p, path: `${path}.cutouts`, ids: [r.id] })
    if (r.cutouts?.length && !r.rect && !r.polygon)
      issues.push({ severity: 'error', code: 'CUTOUT_UNSUPPORTED', message: `Комната «${r.id}»: вырезы нужны внутри rect или polygon`, path, ids: [r.id] })
    if (r.rect && (r.rect[2] <= 0 || r.rect[3] <= 0))
      issues.push({ severity: 'error', code: 'SCHEMA', message: `Комната «${r.id}»: отрицательный или нулевой размер rect`, path: `${path}.rect`, ids: [r.id] })
    if (!r.rect && !r.polygon && !r.at)
      issues.push({ severity: 'error', code: 'ROOM_NO_GEOMETRY', message: `Комната «${r.id}»: нет rect, polygon или at`, path, ids: [r.id] })
    else if (!wallsMode && !r.rect && !r.polygon)
      issues.push({
        severity: 'error',
        code: 'ROOM_NO_GEOMETRY',
        message: `Комната «${r.id}»: без walls[] комнате нужен rect или polygon`,
        path,
        ids: [r.id],
      })
    if (r.polygon) {
      const poly = r.polygon.map((p) => U.pt(p))
      if (poly.length < 3 || Math.abs(signedArea(poly)) < 1)
        issues.push({ severity: 'error', code: 'ROOM_OPEN', message: `Комната «${r.id}»: вырожденный полигон`, path: `${path}.polygon`, ids: [r.id] })
      else if (selfIntersects(poly))
        issues.push({ severity: 'error', code: 'ROOM_OPEN', message: `Комната «${r.id}»: полигон самопересекается`, path: `${path}.polygon`, ids: [r.id] })
    }
    if (r.ceilingHeight !== undefined && (r.ceilingHeight < 2400 || r.ceilingHeight > 3500))
      issues.push({
        severity: 'info',
        code: 'DIMENSION_PRIOR',
        message: `Комната «${r.id}»: необычная высота потолка ${r.ceilingHeight} мм`,
        path: `${path}.ceilingHeight`,
        ids: [r.id],
      })
  })
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const a = polys[i]
      const b = polys[j]
      if (!a || !b) continue
      const ov = overlapArea(a, b) / 1e6
      if (ov > 0.05)
        issues.push({
          severity: 'error',
          code: 'ROOM_OVERLAP',
          message: `Комнаты «${spec.rooms[i].id}» и «${spec.rooms[j].id}» перекрываются на ${ov.toFixed(2)} м²`,
          ids: [spec.rooms[i].id, spec.rooms[j].id],
        })
    }
  }

  // ── walls static
  ;(spec.walls ?? []).forEach((w, i) => {
    const kind = w.kind ?? 'loadBearing'
    const t = w.thickness ?? thicknessFor(kind, D)
    if (kind !== 'separator' && (t < 60 || t > 700))
      issues.push({ severity: 'warning', code: 'WALL_THICKNESS_ODD', message: `Стена «${w.id}»: толщина ${t} мм вне 60–700`, path: `walls[${i}]`, ids: [w.id] })
    if ((kind === 'partition' || kind === 'loadBearing') && t > D.exterior && !w.cutout)
      issues.push({
        severity: 'warning',
        code: 'WALL_THICKNESS_ODD',
        message: `Стена «${w.id}»: внутренняя стена толще наружной (${t} > ${D.exterior})`,
        path: `walls[${i}]`,
        ids: [w.id],
      })
    if (w.align && w.align !== 'center' && !w.closed)
      issues.push({
        severity: 'warning',
        code: 'WALL_ALIGN_OPEN',
        message: `Стена «${w.id}»: align inner/outer работает только для замкнутых контуров — используется ось`,
        path: `walls[${i}].align`,
        ids: [w.id],
      })
  })
  if (D.partition > D.exterior)
    issues.push({ severity: 'warning', code: 'WALL_THICKNESS_ODD', message: 'Перегородки толще наружных стен (defaults)', path: 'defaults' })

  // ── openings static
  const roomIdSet = new Set(spec.rooms.map((r) => r.id))
  spec.openings.forEach((o, i) => {
    const path = `openings[${i}]`
    const label = o.id ?? `#${i}`
    if (o.width <= 0) issues.push({ severity: 'error', code: 'SCHEMA', message: `Проём ${label}: ширина должна быть > 0`, path, ids: [label] })
    if (!o.at && o.wall === undefined && o.room === undefined)
      issues.push({ severity: 'error', code: 'OPENING_NO_POSITION', message: `Проём ${label}: нужно at, wall+offset или room+side`, path, ids: [label] })
    if (o.wall !== undefined && !(spec.walls ?? []).some((w) => w.id === o.wall))
      issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: стена «${o.wall}» не найдена`, path, ids: [label] })
    if (o.room !== undefined && !roomIdSet.has(o.room))
      issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: комната «${o.room}» не найдена`, path, ids: [label] })
    if (o.room !== undefined && o.side === undefined && o.edge === undefined)
      issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: при room нужен side или edge`, path, ids: [label] })
    for (const b of [...(o.between ?? []), ...(o.opensInto ? [o.opensInto] : [])]) {
      if (b !== 'outside' && !roomIdSet.has(b))
        issues.push({ severity: 'error', code: 'OPENING_BAD_REF', message: `Проём ${label}: неизвестная комната «${b}»`, path, ids: [label] })
    }
    const kind = OPENING_MAP[o.type]
    const wmm = U.len(o.width)
    if (kind === 'entranceDoor' && (wmm < 800 || wmm > 1100))
      issues.push({ severity: 'info', code: 'DIMENSION_PRIOR', message: `Входная дверь ${label}: ширина ${Math.round(wmm)} мм (обычно 800–1100)`, path, ids: [label] })
    else if ((kind === 'door' || kind === 'slidingDoor') && (wmm < 600 || wmm > 1000))
      issues.push({ severity: 'info', code: 'DIMENSION_PRIOR', message: `Дверь ${label}: ширина ${Math.round(wmm)} мм (обычно 600–1000)`, path, ids: [label] })
  })
  if (issues.some((i) => i.severity === 'error')) return done()

  // ── compile-based checks
  let res: CompileResult
  try {
    res = compilePlanSpecDetailed(spec)
  } catch (e) {
    issues.push({ severity: 'error', code: 'COMPILE_FAILED', message: `Не удалось построить план: ${(e as Error).message}` })
    return done()
  }
  for (const ci of res.issues) issues.push(ci)
  const { doc, levelId } = res
  const plan = derivePlan(doc, levelId)
  const refPoints = spec.rooms.map((r) => roomRefPoint(r, U, spec.snap))
  const faceOf = (p: Vec2): number =>
    plan.rooms.findIndex((r) => pointInPoly(p, r.polygon) && !r.holes.some((h) => pointInPoly(p, h)))
  const faceToSpec = new Map<number, string[]>()
  const specFace = new Map<string, number>()
  spec.rooms.forEach((r, i) => {
    const rp = refPoints[i]
    if (!rp) return
    let fi = faceOf(rp)
    if (fi < 0 && res.roomIds[r.id]) fi = plan.rooms.findIndex((dr) => dr.roomId === res.roomIds[r.id])
    if (fi < 0) {
      if (!issues.some((x) => x.code === 'ROOM_OPEN' && x.ids?.includes(r.id)))
        issues.push({
          severity: 'error',
          code: 'ROOM_OPEN',
          message: `Комната «${r.id}»: метка не попадает ни в один замкнутый контур стен`,
          path: `rooms[${i}]`,
          ids: [r.id],
        })
      return
    }
    specFace.set(r.id, fi)
    const list = faceToSpec.get(fi) ?? []
    list.push(r.id)
    faceToSpec.set(fi, list)
  })
  for (const [, ids] of faceToSpec) {
    if (ids.length > 1)
      issues.push({
        severity: 'error',
        code: 'ROOM_MERGED',
        message: `Комнаты ${ids.map((x) => `«${x}»`).join(', ')} оказались в одном контуре — не хватает стены или разделителя`,
        ids,
      })
  }
  const voidPolys = shapes.flatMap((sh) => sh?.voids.map((v) => v.poly) ?? [])
  plan.rooms.forEach((r, fi) => {
    if (voidPolys.some((vp) => pointInPoly(interiorPoint(r.polygon), vp))) return
    if (!faceToSpec.has(fi) && r.area > 0.5)
      issues.push({
        severity: wallsMode ? 'warning' : 'info',
        code: 'FACE_UNLABELLED',
        message: `Замкнутый контур площадью ${r.area.toFixed(2)} м² не соответствует ни одной комнате`,
      })
  })

  // the built plan vs the checked shapes: the area check below works on the spec shapes, so a room
  // whose built floor differs (a wall end poking into the floor or the next room, a cutout that did
  // not become a hole) must not pass as «ok» — whatever the reason in the wall synthesis
  if (!wallsMode) {
    spec.rooms.forEach((r, i) => {
      const fi = specFace.get(r.id)
      const sh = shapes[i]
      const want = sh ? [sh.outer, ...sh.holes] : polys[i] ? [polys[i]!] : null
      if (fi === undefined || !want) return
      const f = plan.rooms[fi]
      const got = [f.polygon, ...f.holes]
      // two holes of the built face that touch (partly adjacent cutouts, each with its own void) are
      // one hole of the checked shape: their shared side borders no floor and is not compared
      // (a probe on a boundary is no floor: pointInPoly there follows the rounding, so the orientation)
      const floorAt = (p: Vec2) =>
        got.every((g) => distToPolyBoundary(p, g) > 0.5) && pointInPoly(p, f.polygon) && !f.holes.some((h) => pointInPoly(p, h))
      const inner = (s: Vec2, side: Vec2) => !floorAt(vAdd(s, vMul(side, 2))) && !floorAt(vAdd(s, vMul(side, -2)))
      const dev = Math.max(boundaryDeviation(got, want, inner), boundaryDeviation(want, got))
      const nHoles = holeGroups(f.polygon, f.holes)
      if (dev <= BUILT_SHAPE_TOL && nHoles === want.length - 1) return
      const area = (sh ? sh.area : Math.abs(signedArea(polys[i]!))) / 1e6
      const holes = nHoles !== want.length - 1 ? `, вырезов-отверстий ${nHoles} вместо ${want.length - 1}` : ''
      issues.push({
        severity: builtShapeSeverity(dev, f.area - area, holes !== ''),
        code: 'BUILT_SHAPE_MISMATCH',
        message: `Комната «${r.id}»: построенный пол отличается от проверенного (до ${Math.round(dev)} мм; ${f.area.toFixed(2)} м² вместо ${area.toFixed(2)} м²${holes}) — площади и стены в .doplan будут другими. Упростите или сдвиньте вырез / угол; если не помогает — это ограничение компилятора, сообщите`,
        path: `rooms[${i}]`,
        ids: [r.id],
      })
    })
    // every shaft / box void is one closed area of its own (a solid column has no space inside)
    shapes.forEach((sh, i) =>
      sh?.voids.forEach((v) => {
        if (v.kind === 'column') return
        const fi = faceOf(interiorPoint(v.poly))
        const f = fi >= 0 ? plan.rooms[fi] : null
        const dev = f ? Math.max(boundaryDeviation([f.polygon, ...f.holes], [v.poly]), boundaryDeviation([v.poly], [f.polygon, ...f.holes])) : Infinity
        if (dev <= BUILT_SHAPE_TOL) return
        const r = spec.rooms[i]
        issues.push({
          severity: f ? builtShapeSeverity(dev, f.area - Math.abs(signedArea(v.poly)) / 1e6, f.holes.length > 0) : 'error',
          code: 'BUILT_SHAPE_MISMATCH',
          message: `Комната «${r.id}»: вырез #${v.index + 1} построен не тем контуром, что задан (${f ? `до ${Math.round(dev)} мм` : 'нет замкнутого контура'}) — проверьте, не пересекается ли он с соседними вырезами и стенами`,
          path: `rooms[${i}].cutouts[${v.index}]`,
          ids: [r.id],
        })
      }),
    )
  }

  // areas
  const roomType = (id: string): SpecRoomType => spec.rooms.find((r) => r.id === id)?.type ?? 'other'
  spec.rooms.forEach((r, i) => {
    const fi = specFace.get(r.id)
    let computed: number | undefined
    if (!wallsMode && shapes[i]) computed = shapes[i]!.area / 1e6
    else if (!wallsMode && polys[i]) computed = Math.abs(signedArea(polys[i]!)) / 1e6
    else if (fi !== undefined) computed = plan.rooms[fi].area
    if (computed === undefined) return
    const m: PlanRoomMetric = { id: r.id, computed: Math.round(computed * 100) / 100 }
    // a blank note explains nothing (it neither downgrades the error nor shows up in the message)
    const note = r.areaNote?.trim() || undefined
    if (r.labelledArea !== undefined) {
      const k = r.labelledAreaCoef ?? 1
      const shown = computed * k
      m.labelled = r.labelledArea
      if (k !== 1) m.coef = k
      if (note) m.note = note
      m.delta = Math.round((shown - r.labelledArea) * 100) / 100
      m.pct = r.labelledArea > 0 ? Math.round(((shown - r.labelledArea) / r.labelledArea) * 1000) / 10 : undefined
      const sev = areaThreshold(shown, r.labelledArea)
      if (sev) {
        const guess = k === 1 && isOutdoor(r) ? guessAreaCoef(computed, r.labelledArea) : null
        const what = k !== 1 ? `${computed.toFixed(2)} м² × ${k} = ${shown.toFixed(2)} м²` : `${computed.toFixed(2)} м²`
        let message = `Комната «${r.id}»: площадь ${what}, на плане ${r.labelledArea} м²`
        if (guess)
          message += `. Похоже, на плане площадь с коэффициентом БТИ ${guess}: укажите labelledAreaCoef: ${guess} (реальная глубина = ${r.labelledArea} / ${guess} / длина)`
        if (note) message += ` — объяснено: ${note}`
        issues.push({
          severity: explainedSeverity(sev, note),
          code: 'AREA_MISMATCH',
          message,
          path: `rooms[${i}]`,
          ids: [r.id],
        })
      }
    }
    metrics.perRoom.push(m)
    const coef = r.balcony && !AREA_COEF[r.type ?? 'other'] ? 0.3 : (AREA_COEF[r.type ?? 'other'] ?? 1)
    // shafts / boxed niches (< 1 m² or marked technical, type other) are not floor in BTI totals
    // (a marked one follows the app's rule, isTechnicalRoom: other / storage)
    const technical =
      (computed < 1 && (r.type === undefined || r.type === 'other')) ||
      (r.technical === true && (r.type === undefined || r.type === 'other' || r.type === 'storage'))
    if (!technical) metrics.totalArea += computed * coef
    if (LIVING_TYPES.includes(r.type ?? 'other')) metrics.livingArea += computed
  })
  metrics.totalArea = Math.round(metrics.totalArea * 100) / 100
  metrics.livingArea = Math.round(metrics.livingArea * 100) / 100
  const srcNote = spec.source?.areaNote?.trim() || undefined
  const lt = spec.source?.labelledTotalArea
  if (lt !== undefined) {
    const sev = areaThreshold(metrics.totalArea, lt)
    if (sev)
      issues.push({
        severity: explainedSeverity(sev, srcNote),
        code: 'TOTAL_AREA_MISMATCH',
        message: `Общая площадь ${metrics.totalArea.toFixed(2)} м² (балкон ×0,3, лоджия ×0,5), на плане ${lt} м²${srcNote ? ` — объяснено: ${srcNote}` : ''}`,
        path: 'source.labelledTotalArea',
      })
  }
  const ll = spec.source?.labelledLivingArea
  if (ll !== undefined) {
    const sev = areaThreshold(metrics.livingArea, ll)
    if (sev)
      issues.push({
        severity: explainedSeverity(sev, srcNote),
        code: 'TOTAL_AREA_MISMATCH',
        message: `Жилая площадь ${metrics.livingArea.toFixed(2)} м², на плане ${ll} м²${srcNote ? ` — объяснено: ${srcNote}` : ''}`,
        path: 'source.labelledLivingArea',
      })
  }

  // openings: sides, between, overlap, reachability, windows
  const specOfFace = (fi: number): string => (fi < 0 ? 'outside' : (faceToSpec.get(fi)?.[0] ?? `face${fi}`))
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (a === b) return
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  const entranceRooms: string[] = []
  const windowRooms = new Set<string>()
  spec.openings.forEach((o, i) => {
    const oid = res.openingIds[i]
    if (!oid) return
    const op = doc.openings[oid]
    if (!op) return
    const wall = doc.walls[op.wallId]
    const g = wall ? wallDir(doc, wall) : null
    if (!wall || !g) return
    const nL = V(g.d.y, -g.d.x)
    const c = vAdd(g.A, vMul(g.d, op.offset))
    const reach = wall.thickness / 2 + 150
    const sL = specOfFace(faceOf(vAdd(c, vMul(nL, reach))))
    const sR = specOfFace(faceOf(vAdd(c, vMul(nL, -reach))))
    const label = o.id ?? `#${i}`
    if (o.between && o.between.length === 2) {
      const want = [...o.between].sort().join('|')
      const got = [sL, sR].sort().join('|')
      if (want !== got)
        issues.push({
          severity: 'error',
          code: 'DOOR_BETWEEN_MISMATCH',
          message: `Проём ${label}: соединяет ${sL} и ${sR}, а указано ${o.between.join(' и ')}`,
          path: `openings[${i}]`,
          ids: [label],
        })
    }
    if (DOOR_LIKE.includes(op.kind)) link(sL, sR)
    if (op.kind === 'entranceDoor') {
      for (const s of [sL, sR]) if (s !== 'outside') entranceRooms.push(s)
    }
    if (WINDOW_LIKE.includes(op.kind)) {
      windowRooms.add(sL)
      windowRooms.add(sR)
    }
  })
  // overlaps on the same wall
  const byWall = new Map<Id, { id: Id; lo: number; hi: number }[]>()
  for (const op of Object.values(doc.openings)) {
    const list = byWall.get(op.wallId) ?? []
    list.push({ id: op.id, lo: op.offset - op.width / 2, hi: op.offset + op.width / 2 })
    byWall.set(op.wallId, list)
  }
  for (const list of byWall.values()) {
    list.sort((a, b) => a.lo - b.lo)
    for (let k = 1; k < list.length; k++) {
      if (list[k].lo < list[k - 1].hi - 1) {
        const ia = res.openingIds.indexOf(list[k - 1].id)
        const ib = res.openingIds.indexOf(list[k].id)
        const la = ia >= 0 ? (spec.openings[ia].id ?? `#${ia}`) : list[k - 1].id
        const lb = ib >= 0 ? (spec.openings[ib].id ?? `#${ib}`) : list[k].id
        issues.push({ severity: 'error', code: 'OPENING_OVERLAP', message: `Проёмы ${la} и ${lb} перекрываются на одной стене`, ids: [la, lb] })
      }
    }
  }
  if (entranceRooms.length) {
    const seen = new Set<string>(entranceRooms)
    const queue = [...entranceRooms]
    while (queue.length) {
      const cur = queue.shift()!
      for (const nb of adj.get(cur) ?? []) {
        if (nb === 'outside' || seen.has(nb)) continue
        seen.add(nb)
        queue.push(nb)
      }
    }
    for (const r of spec.rooms) {
      // shafts, risers, boxed niches: tiny closed areas with no doors are technical, not rooms
      const face = specFace.get(r.id)
      const technical =
        face !== undefined &&
        (r.technical === true || (plan.rooms[face].area < 1 && !(adj.get(r.id)?.size ?? 0))) &&
        (r.type === undefined || r.type === 'other' || r.type === 'storage')
      if (face !== undefined && !seen.has(r.id) && !technical)
        issues.push({
          severity: 'error',
          code: 'ROOM_UNREACHABLE',
          message: `Комната «${r.id}» недостижима от входной двери через двери и проёмы`,
          ids: [r.id],
        })
    }
  } else if (spec.openings.length) {
    issues.push({ severity: 'info', code: 'NO_ENTRANCE', message: 'Нет входной двери (entranceDoor) — проверка достижимости пропущена' })
  }
  for (const r of spec.rooms) {
    if (WINDOW_REQUIRED.includes(roomType(r.id)) && specFace.has(r.id) && !windowRooms.has(r.id))
      issues.push({ severity: 'warning', code: 'NO_WINDOW', message: `Комната «${r.id}» без окна или балконной двери`, ids: [r.id] })
  }

  // dangling walls
  const degree = new Map<Id, number>()
  const lw = Object.values(doc.walls).filter((w) => w.levelId === levelId)
  for (const w of lw) {
    degree.set(w.a, (degree.get(w.a) ?? 0) + 1)
    degree.set(w.b, (degree.get(w.b) ?? 0) + 1)
  }
  // an end inside the body of another wall is covered, not free (the stub that closes a column's
  // corner runs on into the body of the column's other wall)
  const inBody = (id: Id, self: Id): boolean => {
    const p = doc.nodes[id]
    return lw.some((o) => {
      if (o.id === self || o.kind === 'virtual') return false
      const a = doc.nodes[o.a]
      const b = doc.nodes[o.b]
      const ab = vSub(b, a)
      const L = vLen(ab)
      if (L < 1) return false
      const along = vDot(vSub(p, a), ab) / L
      const across = Math.abs(vCross(ab, vSub(p, a))) / L
      return along >= -0.5 && along <= L + 0.5 && across <= o.thickness / 2 + 0.5
    })
  }
  let dangling = 0
  for (const w of lw) {
    if (w.kind === 'parapet' || w.kind === 'glazing' || w.kind === 'virtual') continue
    if ([w.a, w.b].some((n) => (degree.get(n) ?? 0) === 1 && !inBody(n, w.id))) dangling++
  }
  if (dangling)
    issues.push({ severity: 'warning', code: 'DANGLING_WALL', message: `${dangling} стен(ы) со свободным концом — проверьте примыкания` })
  // non-orthogonal edges
  let nonOrtho = 0
  for (const w of lw) {
    const g = wallDir(doc, w)
    if (!g) continue
    const ang = (Math.atan2(Math.abs(g.d.y), Math.abs(g.d.x)) * 180) / Math.PI
    if (ang > 0.5 && ang < 89.5) nonOrtho++
  }
  if (nonOrtho) issues.push({ severity: 'info', code: 'NON_ORTHO', message: `${nonOrtho} стен(ы) под непрямым углом` })
  return done()
}

/** Returns issues (severity/code/message/path). Never throws. */
export function validatePlanSpec(spec: PlanSpec): PlanIssue[] {
  return validatePlanSpecDetailed(spec).issues
}

// ───────────────────────────── Doc → PlanSpec ─────────────────────────────

const r1 = (n: number): number => Math.round(n * 10) / 10

/** Decompile one level to a walls-mode PlanSpec in mm (round-trips through compilePlanSpec). */
export function docToPlanSpec(doc: Doc, levelId?: Id): PlanSpec {
  const lid = levelId ?? doc.levelOrder[0]
  const level = doc.levels[lid]
  const plan = derivePlan(doc, lid)
  const sidesWithRoom = new Map<Id, Set<string>>()
  // the walls around a technical void: written with `cutout`, so the rebuild keeps them as cutout walls
  const aroundVoid = new Set<Id>()
  for (const r of plan.rooms) {
    for (const e of r.edges) {
      const s = sidesWithRoom.get(e.wallId) ?? new Set<string>()
      s.add(e.side)
      sidesWithRoom.set(e.wallId, s)
      if (doc.rooms[r.roomId]?.technical) aroundVoid.add(e.wallId)
    }
  }
  const walls: WallSpec[] = []
  for (const w of Object.values(doc.walls)) {
    if (w.levelId !== lid) continue
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    if (!a || !b) continue
    let kind: SpecWallKind
    switch (w.kind) {
      case 'wall':
        kind = (sidesWithRoom.get(w.id)?.size ?? 0) >= 2 ? 'loadBearing' : 'exterior'
        break
      case 'partition':
        kind = 'partition'
        break
      case 'parapet':
        kind = 'parapet'
        break
      case 'glazing':
        kind = 'glass'
        break
      case 'virtual':
        kind = 'separator'
        break
    }
    walls.push({
      id: w.id,
      path: [
        [r1(a.x), r1(a.y)],
        [r1(b.x), r1(b.y)],
      ],
      thickness: w.thickness,
      kind,
      height: w.height,
      ...(aroundVoid.has(w.id) ? { cutout: true } : {}),
    })
    // provenance: a wall segment carries one source for both faces; emit it when the faces agree
    const pl = w.dims?.left
    const pr = w.dims?.right
    const pv = pl && pr ? (pl.source === pr.source && pl.tol === pr.tol ? pl : undefined) : (pl ?? pr)
    if (pv) {
      const ws = walls[walls.length - 1]
      ws.source = pv.tol === undefined && !pv.date && !pv.note ? pv.source : strip({ source: pv.source, tol: pv.tol, date: pv.date, note: pv.note })
    }
  }
  const REVERSE_TYPE: Record<RoomType, SpecRoomType> = {
    living: 'living',
    bedroom: 'bedroom',
    kitchen: 'kitchen',
    kitchenLiving: 'kitchenLiving',
    bathroom: 'bathroom',
    toilet: 'toilet',
    hallway: 'hallway',
    corridor: 'corridor',
    balcony: 'balcony',
    loggia: 'loggia',
    wardrobe: 'wardrobe',
    office: 'office',
    kids: 'kids',
    storage: 'storage',
    other: 'other',
  }
  const rooms: RoomSpec[] = []
  for (const r of Object.values(doc.rooms)) {
    if (r.levelId !== lid) continue
    const dr = plan.rooms.find((x) => x.roomId === r.id)
    const at = dr ? dr.labelPoint : r.anchor
    const rs: RoomSpec = { id: r.id, name: r.name, type: REVERSE_TYPE[r.type] ?? 'other', at: [r1(at.x), r1(at.y)] }
    // a shaft / box void is no floor: it keeps its mark and gets no area to check
    if (r.technical) rs.technical = true
    if (r.labelledArea) rs.labelledArea = r.labelledArea
    else if (dr && !r.technical) rs.labelledArea = Math.round(dr.area * 100) / 100
    if (r.ceiling.height !== undefined) rs.ceilingHeight = r.ceiling.height
    rooms.push(rs)
  }
  const openings: OpeningSpec[] = []
  for (const o of Object.values(doc.openings)) {
    const w = doc.walls[o.wallId]
    if (!w || w.levelId !== lid) continue
    const os: OpeningSpec = {
      id: o.id,
      // the aliases keep the slide kind readable; a barn door is a slidingDoor with slide 'barn'
      type: o.kind === 'slidingDoor' && o.slide === 'pocket' ? 'pocketDoor' : o.kind === 'slidingDoor' && o.slide === 'folding' ? 'foldingDoor' : o.kind,
      wall: o.wallId,
      offset: r1(o.offset),
      width: o.width,
      height: o.height,
      sill: o.sill,
      hingeEnd: o.hinge,
      swingSide: o.swing,
    }
    if (o.sashes !== undefined) os.sashes = o.sashes
    if (o.kind === 'slidingDoor' && o.slide === 'barn') os.slide = 'barn'
    if (o.style) os.style = o.style
    openings.push(os)
  }
  const fixtures: FixtureSpec[] = []
  for (const it of Object.values(doc.items)) {
    if (it.levelId !== lid) continue
    const asset = doc.assets[it.assetId] ?? BUILTIN_ASSETS.find((a) => a.id === it.assetId)
    const f: FixtureSpec = {
      type: asset?.procedural ?? asset?.category ?? 'box',
      assetId: it.assetId,
      at: [r1(it.x), r1(it.y)],
      size: [it.size.w, it.size.d, it.size.h],
      rotation: it.rotation,
    }
    if (it.name) f.name = it.name
    if (it.elevation) f.elevation = it.elevation
    fixtures.push(f)
  }
  // a cutout wall split by a junction stays one cutout wall: its collinear pieces of the same
  // thickness carry the mark too (the piece past a shaft that closes a column's corner); an outline
  // wall never does
  for (let changed = true; changed; ) {
    changed = false
    for (const w of walls) {
      if (w.cutout || (w.kind !== 'loadBearing' && w.kind !== 'partition')) continue
      const [p, q] = w.path
      const dir = [q[0] - p[0], q[1] - p[1]]
      const run = walls.some((o) => {
        if (!o.cutout || o.thickness !== w.thickness) return false
        const [a, b] = o.path
        const od = [b[0] - a[0], b[1] - a[1]]
        if (Math.abs(dir[0] * od[1] - dir[1] * od[0]) > 1e-6 * Math.hypot(...dir) * Math.hypot(...od)) return false
        return [p, q].some((u) => [a, b].some((v) => u[0] === v[0] && u[1] === v[1]))
      })
      if (run) {
        w.cutout = true
        changed = true
      }
    }
  }
  // the exterior thickness the walls are checked against: the one most of the outline is built with
  // (by length; the walls around voids left out), so a 510 mm project is not read as a 300 mm one
  const byT = new Map<number, number>()
  for (const w of walls)
    if (w.kind === 'exterior' && !w.cutout && w.thickness)
      byT.set(w.thickness, (byT.get(w.thickness) ?? 0) + Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]))
  const exteriorThickness = [...byT].sort((p, q) => q[1] - p[1] || q[0] - p[0])[0]?.[0]
  const spec: PlanSpec = {
    version: 1,
    units: 'mm',
    name: doc.meta.name,
    defaults: strip({ ceilingHeight: level?.height ?? doc.settings.wallHeight, wallHeight: level?.height ?? doc.settings.wallHeight, exteriorThickness }),
    snap: { orthogonal: false, standardThickness: false, mergeMm: 1 },
    walls,
    rooms,
    openings,
  }
  if (fixtures.length) spec.fixtures = fixtures
  if (doc.source) spec.source = strip({ kind: doc.source.kind, labelledTotalArea: doc.source.labelledTotalArea, labelledLivingArea: doc.source.labelledLivingArea })
  return spec
}
