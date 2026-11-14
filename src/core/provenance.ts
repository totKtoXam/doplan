/**
 * Dimension provenance: how far each clear dimension of the plan can be trusted.
 *
 * A "dimension" here is a RUN: consecutive collinear inner-face edges of one room (a wall face that
 * a T-junction on its other side splits into several walls is still one run, exactly what a tape
 * measures and what the 2D editor labels). Provenance is stored per wall side (`Wall.dims`), together
 * with the face length it was recorded for: when the wall is moved later, the recorded value no longer
 * matches the geometry and the dimension honestly falls back to `drawn` (stale).
 *
 * Also here: the "what is still unmeasured" checklist, the clearances of an item to the walls around
 * it and the computed-vs-labelled area report. Pure TS.
 */
import { isTechnicalRoom, ROOM_AREA_COEF, LIVING_ROOM_TYPES } from './area'
import { ROOM_TYPE_NAMES } from './defaults'
import { pointInPolygon } from './geom'
import type { DerivedPlan, DerivedRoom, DimProvenance, DimSource, Doc, Id, Item, RoomBoundaryEdge, RoomType, Vec2 } from './types'

// ───────────────────────────── sources ─────────────────────────────

export const DIM_SOURCES: readonly DimSource[] = ['measured', 'plan', 'derived', 'estimated', 'drawn']

/** default tolerance ± mm per source (`drawn`: unknown) */
export const DIM_SOURCE_TOL: Record<DimSource, number | undefined> = {
  plan: 10,
  derived: 20,
  estimated: 50,
  measured: 2,
  drawn: undefined,
}

/** trust order: a run made of several faces is as good as its weakest face */
export const DIM_SOURCE_RANK: Record<DimSource, number> = { drawn: 0, estimated: 1, derived: 2, plan: 3, measured: 4 }

export const DIM_SOURCE_NAMES: Record<DimSource, { ru: string; en: string; hint: string }> = {
  plan: { ru: 'с плана', en: 'from plan', hint: 'Напечатан на плане БТИ / застройщика, точность ±1 см' },
  derived: { ru: 'вычислен', en: 'derived', hint: 'Вычислен из площади или цепочки размеров, точность ±2 см' },
  estimated: { ru: '≈ по фото', en: '≈ from photo', hint: 'Не напечатан, оценён по пикселям фото, точность ±5 см' },
  measured: { ru: 'замерен', en: 'measured', hint: 'Замерен рулеткой или дальномером' },
  drawn: { ru: 'нарисован', en: 'drawn', hint: 'Нарисован вручную, точность неизвестна' },
}

/** a recorded length that differs from the geometry by more than this (mm) is stale */
export const STALE_TOL_MM = 1
/** runs shorter than this (mm) are slivers of mitres / niches, not dimensions */
export const MIN_RUN_MM = 30

export const sideKey = (wallId: Id, side: 'left' | 'right'): string => `${wallId}:${side}`

export function provenanceTol(p: DimProvenance | undefined): number | undefined {
  if (!p) return undefined
  return p.tol ?? DIM_SOURCE_TOL[p.source]
}

const todayIso = (): string => new Date().toISOString().slice(0, 10)

/** a fresh provenance record for a face of the given current length */
export function makeProvenance(source: DimSource, length: number, extra?: { tol?: number; date?: string; note?: string }): DimProvenance {
  const p: DimProvenance = { source, value: Math.round(length * 100) / 100 }
  if (extra?.tol !== undefined && extra.tol !== DIM_SOURCE_TOL[source]) p.tol = extra.tol
  if (source === 'measured') p.date = extra?.date ?? todayIso()
  else if (extra?.date) p.date = extra.date
  if (extra?.note) p.note = extra.note
  return p
}

// ───────────────────────────── runs ─────────────────────────────

export interface EdgeRun {
  /** stable id: `${wallId}:${side}` of the first edge */
  key: string
  roomId: Id
  /** clear face end points, mm */
  a: Vec2
  b: Vec2
  /** unit normal pointing into the room */
  n: Vec2
  /** unit direction a → b */
  u: Vec2
  length: number
  edges: RoomBoundaryEdge[]
}

const elen = (e: RoomBoundaryEdge): number => Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)

function continues(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  if (Math.hypot(b0.x - a1.x, b0.y - a1.y) >= 1) return false
  const d1x = a1.x - a0.x
  const d1y = a1.y - a0.y
  const d2x = b1.x - b0.x
  const d2y = b1.y - b0.y
  const l1 = Math.hypot(d1x, d1y)
  const l2 = Math.hypot(d2x, d2y)
  return l1 > 1e-6 && l2 > 1e-6 && Math.abs(d1x * d2y - d1y * d2x) / (l1 * l2) < 0.01 && d1x * d2x + d1y * d2y > 0
}

const runCache = new WeakMap<DerivedRoom, EdgeRun[]>()

/**
 * Consecutive collinear inner-face edges of a room merged into runs (cyclic: a run may wrap around
 * the start of the edge list). Runs shorter than MIN_RUN_MM are dropped.
 */
export function roomEdgeRuns(room: DerivedRoom): EdgeRun[] {
  const cached = runCache.get(room)
  if (cached) return cached
  const groups: RoomBoundaryEdge[][] = []
  for (const e of room.edges) {
    const last = groups[groups.length - 1]
    if (last) {
      const l = last[last.length - 1]
      if (continues(l.from, l.to, e.from, e.to)) {
        last.push(e)
        continue
      }
    }
    groups.push([e])
  }
  if (groups.length > 1) {
    const first = groups[0]
    const last = groups[groups.length - 1]
    const le = last[last.length - 1]
    if (continues(le.from, le.to, first[0].from, first[0].to)) {
      groups.pop()
      groups[0] = [...last, ...first]
    }
  }
  const out: EdgeRun[] = []
  for (const g of groups) {
    const a = g[0].from
    const b = g[g.length - 1].to
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < MIN_RUN_MM) continue
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    let n = { x: -u.y, y: u.x }
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const probe = { x: m.x + n.x * 8, y: m.y + n.y * 8 }
    const inside = pointInPolygon(probe, room.polygon) && !room.holes.some((h) => pointInPolygon(probe, h))
    if (!inside) n = { x: -n.x, y: -n.y }
    out.push({ key: sideKey(g[0].wallId, g[0].side), roomId: room.roomId, a, b, n, u, length, edges: g })
  }
  runCache.set(room, out)
  return out
}

/** the run that contains the face `key` (`wallId:side`), searching every room of the plan */
export function findRun(plan: DerivedPlan, key: string): EdgeRun | null {
  for (const room of plan.rooms) {
    for (const run of roomEdgeRuns(room)) {
      if (run.key === key) return run
    }
  }
  for (const room of plan.rooms) {
    for (const run of roomEdgeRuns(room)) {
      if (run.edges.some((e) => sideKey(e.wallId, e.side) === key)) return run
    }
  }
  return null
}

// ───────────────────────────── effective provenance ─────────────────────────────

export interface EffectiveProvenance {
  /** weakest source over the faces of the run (stale faces count as `drawn`) */
  source: DimSource
  /** ± mm (largest over the faces), undefined when unknown */
  tol: number | undefined
  /** some face carries a recorded value that no longer matches the geometry */
  stale: boolean
  /** faces have different (non-stale) sources */
  mixed: boolean
  /** latest measurement date */
  date?: string
}

/** provenance of one room face, with the stale check against its current length */
export function edgeProvenance(doc: Pick<Doc, 'walls'>, e: RoomBoundaryEdge): { prov: DimProvenance | undefined; stale: boolean } {
  const prov = doc.walls[e.wallId]?.dims?.[e.side]
  if (!prov) return { prov: undefined, stale: false }
  if (prov.value !== undefined && Math.abs(elen(e) - prov.value) > STALE_TOL_MM) return { prov, stale: true }
  return { prov, stale: false }
}

export function runProvenance(doc: Pick<Doc, 'walls'>, run: Pick<EdgeRun, 'edges'>): EffectiveProvenance {
  let source: DimSource | null = null
  let tol: number | undefined = 0
  let stale = false
  let mixed = false
  let date: string | undefined
  let first: DimSource | null = null
  for (const e of run.edges) {
    const ep = edgeProvenance(doc, e)
    const s: DimSource = ep.stale || !ep.prov ? 'drawn' : ep.prov.source
    if (ep.stale) stale = true
    if (first === null) first = s
    else if (s !== first) mixed = true
    if (source === null || DIM_SOURCE_RANK[s] < DIM_SOURCE_RANK[source]) source = s
    const t = ep.stale ? undefined : provenanceTol(ep.prov)
    tol = t === undefined || tol === undefined ? undefined : Math.max(tol, t)
    if (!ep.stale && ep.prov?.source === 'measured' && ep.prov.date && (!date || ep.prov.date > date)) date = ep.prov.date
  }
  const src = source ?? 'drawn'
  const out: EffectiveProvenance = { source: src, tol: src === 'drawn' ? undefined : tol, stale, mixed }
  if (date && src === 'measured') out.date = date
  return out
}

/** label decoration for a dimension of this provenance */
export function dimLabel(text: string, p: Pick<EffectiveProvenance, 'source' | 'stale'>): string {
  if (p.stale) return `${text} ≠`
  switch (p.source) {
    case 'measured':
      return `✓ ${text}`
    case 'estimated':
      return `≈ ${text}`
    default:
      return text
  }
}

// ───────────────────────────── rooms: measured status & checklist ─────────────────────────────

export interface RoomMeasureStatus {
  runs: number
  measured: number
  /** every run of the room is measured (and not stale) */
  full: boolean
  /** counts per effective source */
  bySource: Record<DimSource, number>
}

export function roomMeasureStatus(doc: Pick<Doc, 'walls'>, room: DerivedRoom): RoomMeasureStatus {
  const bySource: Record<DimSource, number> = { measured: 0, plan: 0, derived: 0, estimated: 0, drawn: 0 }
  const runs = roomEdgeRuns(room)
  for (const run of runs) bySource[runProvenance(doc, run).source]++
  return { runs: runs.length, measured: bySource.measured, full: runs.length > 0 && bySource.measured === runs.length, bySource }
}

/** checklist order: where millimetres decide whether furniture fits */
const ROOM_PRIORITY: Record<RoomType, number> = {
  kitchen: 0,
  kitchenLiving: 0,
  bathroom: 1,
  toilet: 1,
  hallway: 2,
  corridor: 2,
  wardrobe: 3,
  storage: 3,
  living: 4,
  bedroom: 4,
  kids: 4,
  office: 4,
  other: 5,
  balcony: 6,
  loggia: 6,
}

export interface ChecklistEntry {
  run: EdgeRun
  roomId: Id
  roomName: string
  roomType: RoomType
  prov: EffectiveProvenance
  /** lower = more important */
  priority: number
}

/** Every dimension of the level that is not measured yet, most important first. */
export function unmeasuredChecklist(doc: Pick<Doc, 'walls' | 'rooms'>, plan: DerivedPlan): ChecklistEntry[] {
  const out: ChecklistEntry[] = []
  for (const room of plan.rooms) {
    const rec = doc.rooms[room.roomId]
    const type: RoomType = rec?.type ?? 'other'
    if (isTechnicalRoom(rec?.type, room.area)) continue
    const name = rec?.name || ROOM_TYPE_NAMES[type].ru
    for (const run of roomEdgeRuns(room)) {
      const prov = runProvenance(doc, run)
      if (prov.source === 'measured') continue
      out.push({ run, roomId: room.roomId, roomName: name, roomType: type, prov, priority: ROOM_PRIORITY[type] ?? 5 })
    }
  }
  // within a room: the least trusted first, then the longest
  out.sort(
    (p, q) =>
      p.priority - q.priority ||
      p.roomName.localeCompare(q.roomName, 'ru') ||
      p.roomId.localeCompare(q.roomId) ||
      DIM_SOURCE_RANK[p.prov.source] - DIM_SOURCE_RANK[q.prov.source] ||
      q.run.length - p.run.length,
  )
  return out
}

// ───────────────────────────── item clearances ─────────────────────────────

export type ClearanceDir = 'front' | 'back' | 'left' | 'right'

export interface Clearance {
  dir: ClearanceDir
  /** point on the item edge and the wall face hit, mm */
  from: Vec2
  to: Vec2
  /** clear distance, mm */
  dist: number
  wallId: Id
  side: 'left' | 'right'
  /** effective provenance of the hit face's run */
  prov: EffectiveProvenance
  /**
   * true when the distance can be trusted to the tape: the hit wall face is measured AND the room
   * dimensions along this direction (that position the wall) are measured
   */
  reliable: boolean
}

function rayHit(o: Vec2, d: Vec2, a: Vec2, b: Vec2): number | null {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const den = d.x * ey - d.y * ex
  if (Math.abs(den) < 1e-9) return null
  const wx = a.x - o.x
  const wy = a.y - o.y
  const t = (wx * ey - wy * ex) / den
  const s = (wx * d.y - wy * d.x) / den
  if (t < -0.5 || s < -1e-6 || s > 1 + 1e-6) return null
  return Math.max(0, t)
}

/**
 * Distances from the item footprint to the nearest wall face in its four local directions (rays from
 * both ends and the middle of each edge; the shortest wins). Directions without a wall within
 * `maxMm` are omitted.
 */
export function itemClearances(doc: Pick<Doc, 'walls' | 'rooms'>, plan: DerivedPlan, item: Pick<Item, 'x' | 'y' | 'rotation' | 'size'>, maxMm = 15000): Clearance[] {
  const r = (item.rotation * Math.PI) / 180
  const ux = { x: Math.cos(r), y: Math.sin(r) }
  // local +y on plan (y down) = the item's front (towards the room), local -y = back (to the wall)
  const uy = { x: -Math.sin(r), y: Math.cos(r) }
  const hw = item.size.w / 2
  const hd = item.size.d / 2
  const c = { x: item.x, y: item.y }
  const at = (lx: number, ly: number): Vec2 => ({ x: c.x + ux.x * lx + uy.x * ly, y: c.y + ux.y * lx + uy.y * ly })
  const dirs: { dir: ClearanceDir; d: Vec2; pts: Vec2[] }[] = [
    { dir: 'front', d: uy, pts: [at(-hw, hd), at(0, hd), at(hw, hd)] },
    { dir: 'back', d: { x: -uy.x, y: -uy.y }, pts: [at(-hw, -hd), at(0, -hd), at(hw, -hd)] },
    { dir: 'right', d: ux, pts: [at(hw, -hd), at(hw, 0), at(hw, hd)] },
    { dir: 'left', d: { x: -ux.x, y: -ux.y }, pts: [at(-hw, -hd), at(-hw, 0), at(-hw, hd)] },
  ]
  // faces that bound a room (the measurable ones) with their run
  const faceRun = new Map<string, { run: EdgeRun; room: DerivedRoom }>()
  for (const room of plan.rooms) for (const run of roomEdgeRuns(room)) for (const e of run.edges) faceRun.set(sideKey(e.wallId, e.side), { run, room })
  const home = plan.rooms.find((room) => pointInPolygon(c, room.polygon) && !room.holes.some((h) => pointInPolygon(c, h)))

  const out: Clearance[] = []
  for (const { dir, d, pts } of dirs) {
    let best: { t: number; from: Vec2; wallId: Id; side: 'left' | 'right' } | null = null
    for (const id in plan.wallGeoms) {
      const g = plan.wallGeoms[id]
      const w = doc.walls[id]
      if (!w || w.kind === 'virtual' || g.polygon.length < 3) continue
      for (const side of ['left', 'right'] as const) {
        const [a, b] = g[side]
        // only faces turned towards the ray
        const fx = b.x - a.x
        const fy = b.y - a.y
        const fl = Math.hypot(fx, fy)
        if (fl < 1) continue
        for (const p of pts) {
          const t = rayHit(p, d, a, b)
          if (t === null || t > maxMm) continue
          if (!best || t < best.t) best = { t, from: p, wallId: id, side }
        }
      }
    }
    if (!best) continue
    const to = { x: best.from.x + d.x * best.t, y: best.from.y + d.y * best.t }
    const fr = faceRun.get(sideKey(best.wallId, best.side))
    const prov: EffectiveProvenance = fr ? runProvenance(doc, fr.run) : { source: 'drawn', tol: undefined, stale: false, mixed: false }
    // the wall's position along d is fixed by the room's runs parallel to d
    let alongMeasured = true
    const room = home ?? fr?.room
    if (room) {
      for (const run of roomEdgeRuns(room)) {
        if (Math.abs(run.u.x * d.x + run.u.y * d.y) < 0.985) continue
        if (runProvenance(doc, run).source !== 'measured') alongMeasured = false
      }
    } else alongMeasured = false
    out.push({
      dir,
      from: best.from,
      to,
      dist: best.t,
      wallId: best.wallId,
      side: best.side,
      prov,
      reliable: prov.source === 'measured' && alongMeasured,
    })
  }
  return out
}

// ───────────────────────────── gaps between items ─────────────────────────────

export interface ItemGap {
  dir: ClearanceDir
  /** point on this item's edge and on the neighbour's footprint, mm */
  from: Vec2
  to: Vec2
  /** clear distance between the footprints, mm */
  dist: number
  itemId: Id
}

type GapItem = Pick<Item, 'id' | 'levelId' | 'x' | 'y' | 'rotation' | 'size' | 'elevation'> & { hidden?: boolean }

/**
 * Gaps from the item footprint to the nearest neighbouring item in each of its four local directions,
 * measured axis-aligned in the item's frame (the neighbour's footprint is taken as its bounding box in
 * that frame). Only neighbours on the same level whose height range overlaps the item's, whose
 * footprint overlaps the item's side band, and that are closer than `maxMm` count. Thin floor items
 * (rugs, mats: under 50 mm high) are ignored; a neighbour farther than the wall in that direction
 * (`walls`, e.g. from itemClearances) is behind the wall and ignored too.
 */
export function itemGaps(item: GapItem, items: Iterable<GapItem>, maxMm = 1500, walls: readonly { dir: ClearanceDir; dist: number }[] = []): ItemGap[] {
  const r = (item.rotation * Math.PI) / 180
  const ux = { x: Math.cos(r), y: Math.sin(r) }
  const uy = { x: -Math.sin(r), y: Math.cos(r) }
  const hw = item.size.w / 2
  const hd = item.size.d / 2
  const at = (lx: number, ly: number): Vec2 => ({ x: item.x + ux.x * lx + uy.x * ly, y: item.y + ux.y * lx + uy.y * ly })
  const z0 = item.elevation
  const z1 = item.elevation + item.size.h
  const best = new Map<ClearanceDir, ItemGap>()
  const consider = (g: ItemGap) => {
    if (walls.some((w) => w.dir === g.dir && w.dist < g.dist)) return
    const b = best.get(g.dir)
    if (!b || g.dist < b.dist) best.set(g.dir, g)
  }
  for (const o of items) {
    if (o.id === item.id || o.levelId !== item.levelId || o.hidden) continue
    if (o.size.h < 50 && o.elevation < 50) continue
    if (Math.min(z1, o.elevation + o.size.h) - Math.max(z0, o.elevation) <= 1) continue
    // neighbour's corners in this item's frame → bounding box
    const ro = (o.rotation * Math.PI) / 180
    const ox = { x: Math.cos(ro), y: Math.sin(ro) }
    const oy = { x: -Math.sin(ro), y: Math.cos(ro) }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = o.x + ox.x * sx * (o.size.w / 2) + oy.x * sy * (o.size.d / 2) - item.x
      const py = o.y + ox.y * sx * (o.size.w / 2) + oy.y * sy * (o.size.d / 2) - item.y
      const lx = px * ux.x + py * ux.y
      const ly = px * uy.x + py * uy.y
      minX = Math.min(minX, lx)
      maxX = Math.max(maxX, lx)
      minY = Math.min(minY, ly)
      maxY = Math.max(maxY, ly)
    }
    // band overlap across the direction (> 1 mm), then the gap along it
    const oyLo = Math.max(minY, -hd)
    const oyHi = Math.min(maxY, hd)
    if (oyHi - oyLo > 1) {
      const ym = (oyLo + oyHi) / 2
      if (minX >= hw - 0.5 && minX - hw <= maxMm) consider({ dir: 'right', from: at(hw, ym), to: at(minX, ym), dist: Math.max(0, minX - hw), itemId: o.id })
      if (maxX <= -hw + 0.5 && -hw - maxX <= maxMm) consider({ dir: 'left', from: at(-hw, ym), to: at(maxX, ym), dist: Math.max(0, -hw - maxX), itemId: o.id })
    }
    const oxLo = Math.max(minX, -hw)
    const oxHi = Math.min(maxX, hw)
    if (oxHi - oxLo > 1) {
      const xm = (oxLo + oxHi) / 2
      if (minY >= hd - 0.5 && minY - hd <= maxMm) consider({ dir: 'front', from: at(xm, hd), to: at(xm, minY), dist: Math.max(0, minY - hd), itemId: o.id })
      if (maxY <= -hd + 0.5 && -hd - maxY <= maxMm) consider({ dir: 'back', from: at(xm, -hd), to: at(xm, maxY), dist: Math.max(0, -hd - maxY), itemId: o.id })
    }
  }
  return [...best.values()]
}

// ───────────────────────────── area report ─────────────────────────────

export type AreaLevel = 'ok' | 'warn' | 'bad'

export interface RoomAreaReport {
  /** m² between finished wall faces */
  computed: number
  /** m² printed on the source plan */
  labelled?: number
  /** computed − labelled, m² */
  delta?: number
  /** delta in % of labelled */
  pct?: number
  /** |pct| ≤ 1 → ok, ≤ 3 → warn, else bad */
  level?: AreaLevel
  /** ± m² the computed area can be off by, from the tolerances of its dimensions; undefined = unknown */
  uncertainty?: number
  /** every dimension of the room comes from the plan */
  allPlan: boolean
  /** the delta is explained by the dimension tolerances (+ rounding of the label to 0.05 m²) */
  withinTolerance?: boolean
  /**
   * the printed dimensions and the printed area contradict each other (all dimensions are 'plan' and
   * the delta exceeds what their ±1 cm and the label rounding allow)
   */
  contradiction: boolean
}

/** half the label rounding step (areas are printed to 0.1 m²) */
const LABEL_ROUNDING_M2 = 0.05

export function areaLevel(pct: number): AreaLevel {
  const a = Math.abs(pct)
  return a <= 1 ? 'ok' : a <= 3 ? 'warn' : 'bad'
}

export function roomAreaReport(doc: Pick<Doc, 'walls' | 'rooms'>, room: DerivedRoom): RoomAreaReport {
  const runs = roomEdgeRuns(room)
  let unc: number | undefined = 0
  let allPlan = runs.length > 0
  for (const run of runs) {
    const p = runProvenance(doc, run)
    if (p.source !== 'plan') allPlan = false
    if (p.tol === undefined || unc === undefined) unc = undefined
    else unc += (run.length / 1000) * (p.tol / 1000)
  }
  const uncertainty = unc === undefined ? undefined : Math.round((unc / 2) * 1000) / 1000
  const rep: RoomAreaReport = { computed: Math.round(room.area * 100) / 100, allPlan, contradiction: false }
  if (uncertainty !== undefined) rep.uncertainty = uncertainty
  const labelled = doc.rooms[room.roomId]?.labelledArea
  if (labelled !== undefined && labelled > 0) {
    rep.labelled = labelled
    const delta = room.area - labelled
    rep.delta = Math.round(delta * 100) / 100
    rep.pct = Math.round((delta / labelled) * 1000) / 10
    rep.level = areaLevel(rep.pct)
    if (uncertainty !== undefined) {
      rep.withinTolerance = Math.abs(delta) <= uncertainty + LABEL_ROUNDING_M2 + 1e-9
      rep.contradiction = allPlan && !rep.withinTolerance
    }
  }
  return rep
}

export interface SourceAreaCheck {
  kind: 'total' | 'living'
  /** sum of the labelled room areas (total: with balcony ×0.3 / loggia ×0.5) */
  sum: number
  /** printed on the plan */
  labelled: number
  /** rooms that had a labelled area */
  rooms: number
  /** the printed room areas do not add up to the printed total */
  contradiction: boolean
}

/**
 * Do the printed numbers of the source plan agree with each other? Compares the sum of the printed
 * room areas with the printed total / living area (each room label is rounded to 0.1 m², so the sum
 * may legitimately drift by 0.05 m² per room).
 */
export function sourceAreaChecks(doc: Pick<Doc, 'rooms' | 'source'>, plan: DerivedPlan): SourceAreaCheck[] {
  const src = doc.source
  if (!src || (src.labelledTotalArea === undefined && src.labelledLivingArea === undefined)) return []
  let total = 0
  let living = 0
  let n = 0
  let nLiving = 0
  let missing = 0
  for (const room of plan.rooms) {
    const rec = doc.rooms[room.roomId]
    if (!rec || isTechnicalRoom(rec.type, room.area)) continue
    if (rec.labelledArea === undefined) {
      missing++
      continue
    }
    n++
    total += rec.labelledArea * (ROOM_AREA_COEF[rec.type] ?? 1)
    if (LIVING_ROOM_TYPES.includes(rec.type)) {
      living += rec.labelledArea
      nLiving++
    }
  }
  const out: SourceAreaCheck[] = []
  const r2 = (v: number): number => Math.round(v * 100) / 100
  if (src.labelledTotalArea !== undefined && n > 0 && missing === 0) {
    out.push({ kind: 'total', sum: r2(total), labelled: src.labelledTotalArea, rooms: n, contradiction: Math.abs(total - src.labelledTotalArea) > LABEL_ROUNDING_M2 * n + 0.01 })
  }
  if (src.labelledLivingArea !== undefined && nLiving > 0 && missing === 0) {
    out.push({
      kind: 'living',
      sum: r2(living),
      labelled: src.labelledLivingArea,
      rooms: nLiving,
      contradiction: Math.abs(living - src.labelledLivingArea) > LABEL_ROUNDING_M2 * nLiving + 0.01,
    })
  }
  return out
}
