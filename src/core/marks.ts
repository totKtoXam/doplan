/**
 * Plan marks («Пометить» in the chat): what a freehand stroke or a closed zone drawn over the plan points at.
 *
 * The AI chat attaches a mark with the entities it touches (walls and their clear sides, nodes,
 * openings, rooms, items) so that «в ① ширина 180 см» can be mapped onto a concrete dimension.
 * Pure TS, no DOM.
 */
import { ROOM_TYPE_NAMES } from './defaults'
import { pointInPolygon } from './geom'
import { runEndNode } from './measure'
import { roomEdgeRuns } from './provenance'
import type { Annotation, DerivedPlan, Doc, Id, Vec2 } from './types'

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

/** ①…⑳, then (21), (22)… */
export function markBadge(n: number): string {
  return n >= 1 && n <= 20 ? [...CIRCLED][n - 1] : `(${n})`
}

/** number for a new mark: one more than the largest one in the document */
export function nextMarkNumber(doc: Pick<Doc, 'annotations'>): number {
  let max = 0
  for (const id in doc.annotations ?? {}) max = Math.max(max, doc.annotations![id].n)
  return max + 1
}

export interface MarkBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function markBounds(m: Pick<Annotation, 'points'>): MarkBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of m.points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

// ───────────── distances ─────────────

function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function segsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segsIntersect(a, b, c, d)) return 0
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b))
}

/** segments of the mark (a zone is closed) */
function markSegments(m: Pick<Annotation, 'points' | 'shape'>): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = []
  const pts = m.points
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]])
  if (m.shape === 'zone' && pts.length > 2) out.push([pts[pts.length - 1], pts[0]])
  return out
}

/** distance from a point to the mark's line (0 inside a zone) */
export function markDistance(m: Pick<Annotation, 'points' | 'shape'>, p: Vec2): number {
  if (m.shape === 'zone' && m.points.length > 2 && pointInPolygon(p, m.points)) return 0
  let best = Infinity
  for (const [a, b] of markSegments(m)) best = Math.min(best, pointSegDist(p, a, b))
  if (m.points.length === 1) best = Math.hypot(p.x - m.points[0].x, p.y - m.points[0].y)
  return best
}

/** distance from a segment to the mark (0 when it crosses the mark or enters a zone) */
function segMarkDist(m: Pick<Annotation, 'points' | 'shape'>, a: Vec2, b: Vec2): number {
  if (m.shape === 'zone' && m.points.length > 2 && (pointInPolygon(a, m.points) || pointInPolygon(b, m.points))) return 0
  let best = Infinity
  for (const [c, d] of markSegments(m)) best = Math.min(best, segSegDist(a, b, c, d))
  return best
}

/** share (0…1) of the segment a→b that lies within `tol` of the mark */
function coverage(m: Pick<Annotation, 'points' | 'shape'>, a: Vec2, b: Vec2, tol: number): number {
  const N = 20
  let hit = 0
  for (let i = 0; i <= N; i++) {
    const t = i / N
    if (markDistance(m, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) <= tol) hit++
  }
  return hit / (N + 1)
}

/** how far (mm) from a face a parallel stroke may run and still mean that face */
const ALONG_DIST = 600

/**
 * Share (0…1) of the face a→b that a STROKE runs along: the stroke is roughly parallel to the face
 * (within ~18°), all its points lie within `maxDist` of the face line, and the share is its
 * projection onto the face. 0 for zones and strokes across the face.
 */
function alongCover(m: Pick<Annotation, 'points' | 'shape'>, a: Vec2, b: Vec2, maxDist: number): number {
  if (m.shape !== 'stroke' || m.points.length < 2) return 0
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < 1) return 0
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  const p0 = m.points[0]
  const p1 = m.points[m.points.length - 1]
  const sl = Math.hypot(p1.x - p0.x, p1.y - p0.y)
  if (sl < 1 || Math.abs(((p1.x - p0.x) * u.x + (p1.y - p0.y) * u.y) / sl) < 0.95) return 0
  let lo = Infinity
  let hi = -Infinity
  for (const p of m.points) {
    const dx = p.x - a.x
    const dy = p.y - a.y
    if (Math.abs(dx * u.y - dy * u.x) > maxDist) return 0
    const t = dx * u.x + dy * u.y
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
  }
  return Math.max(0, Math.min(hi, len) - Math.max(lo, 0)) / len
}

// ───────────── targets ─────────────

export interface MarkRunTarget {
  /** clear face key `wallId:side` (core/provenance) — the target of a tape measurement */
  key: string
  roomId: Id
  roomName: string
  /** current clear length, mm */
  length: number
  /** wall nodes at the run's ends (a → b along the face) */
  endA: Id | null
  endB: Id | null
  /** share of the face covered by the mark, 0…1 */
  cover: number
}

export interface MarkWallTarget {
  id: Id
  a: Id
  b: Id
  /** centreline length, mm */
  length: number
  thickness: number
  /** wall faces the mark runs along / crosses */
  sides: ('left' | 'right')[]
}

export interface MarkTargets {
  runs: MarkRunTarget[]
  walls: MarkWallTarget[]
  nodes: Id[]
  openings: Id[]
  rooms: { id: Id; name: string }[]
  items: Id[]
}

export function roomDisplayName(doc: Pick<Doc, 'rooms'>, roomId: Id): string {
  const r = doc.rooms[roomId]
  return r?.name || ROOM_TYPE_NAMES[r?.type ?? 'other']?.ru || 'Помещение'
}

/**
 * Entities the mark touches (a stroke within `tol` mm) or encloses (a zone).
 * Runs are sorted by how much of them the mark covers.
 */
export function markTargets(doc: Doc, plan: DerivedPlan, m: Annotation, tol = 150): MarkTargets {
  const lv = m.levelId
  const out: MarkTargets = { runs: [], walls: [], nodes: [], openings: [], rooms: [], items: [] }

  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== lv) continue
    const g = plan.wallGeoms[id]
    if (!g) continue
    if (segMarkDist(m, g.a, g.b) > tol + w.thickness / 2) continue
    const sides: ('left' | 'right')[] = []
    if (segMarkDist(m, g.left[0], g.left[1]) <= tol) sides.push('left')
    if (segMarkDist(m, g.right[0], g.right[1]) <= tol) sides.push('right')
    out.walls.push({ id, a: w.a, b: w.b, length: g.length, thickness: w.thickness, sides })
  }

  const seen = new Set<string>()
  for (const room of plan.rooms) {
    // a parallel stroke only means the faces of the room it is drawn in
    const mid = m.points[Math.floor(m.points.length / 2)]
    const strokeInRoom = !!mid && pointInPolygon(mid, room.polygon)
    for (const run of roomEdgeRuns(room)) {
      if (seen.has(run.key)) continue
      const touched = run.edges.some((e) => segMarkDist(m, e.from, e.to) <= tol)
      // a stroke drawn along a face a bit inside the room still means that face
      const along = touched || !strokeInRoom ? 0 : alongCover(m, run.a, run.b, ALONG_DIST)
      if (!touched && along < 0.3) continue
      seen.add(run.key)
      out.runs.push({
        key: run.key,
        roomId: room.roomId,
        roomName: roomDisplayName(doc, room.roomId),
        length: run.length,
        endA: runEndNode(doc, run, 'a'),
        endB: runEndNode(doc, run, 'b'),
        cover: touched ? Math.max(coverage(m, run.a, run.b, tol), strokeInRoom ? alongCover(m, run.a, run.b, ALONG_DIST) : 0) : along,
      })
      const wallId = run.key.split(':')[0] as Id
      const side = run.key.split(':')[1] as 'left' | 'right'
      const w = doc.walls[wallId]
      const known = out.walls.find((x) => x.id === wallId)
      if (known) {
        if (!known.sides.includes(side)) known.sides.push(side)
      } else if (w && plan.wallGeoms[wallId]) {
        out.walls.push({ id: wallId, a: w.a, b: w.b, length: plan.wallGeoms[wallId].length, thickness: w.thickness, sides: [side] })
      }
    }
  }
  out.runs.sort((a, b) => b.cover - a.cover)

  for (const id in doc.nodes) {
    const n = doc.nodes[id]
    if (n.levelId === lv && markDistance(m, n) <= tol) out.nodes.push(id)
  }

  for (const id in doc.openings) {
    const o = doc.openings[id]
    const w = doc.walls[o.wallId]
    if (!w || w.levelId !== lv) continue
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    if (!a || !b) continue
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const ux = (b.x - a.x) / L
    const uy = (b.y - a.y) / L
    const p0 = { x: a.x + ux * (o.offset - o.width / 2), y: a.y + uy * (o.offset - o.width / 2) }
    const p1 = { x: a.x + ux * (o.offset + o.width / 2), y: a.y + uy * (o.offset + o.width / 2) }
    if (segMarkDist(m, p0, p1) <= tol + w.thickness / 2) out.openings.push(id)
  }

  for (const room of plan.rooms) {
    const inRoom = (p: Vec2) => pointInPolygon(p, room.polygon) && !room.holes.some((h) => pointInPolygon(p, h))
    const hit = m.points.some(inRoom) || (m.shape === 'zone' && m.points.length > 2 && room.polygon.some((p) => pointInPolygon(p, m.points)))
    if (hit) out.rooms.push({ id: room.roomId, name: roomDisplayName(doc, room.roomId) })
  }

  for (const id in doc.items) {
    const it = doc.items[id]
    if (it.levelId !== lv) continue
    const r = Math.max(it.size.w, it.size.d) / 2
    if (markDistance(m, it) <= tol + r * 0.7) out.items.push(id)
  }
  return out
}

const r0 = (v: number) => Math.round(v)

/** Text sent to the agent with an attached mark. */
export function describeMark(doc: Doc, m: Annotation, t: MarkTargets): string {
  const b = markBounds(m)
  const lines: string[] = []
  lines.push(
    `Пометка ${markBadge(m.n)} карандашом (${m.id}, уровень ${m.levelId}): ${m.shape === 'zone' ? 'замкнутая зона' : 'линия'}, рамка (${r0(b.minX)}, ${r0(b.minY)}) – (${r0(b.maxX)}, ${r0(b.maxY)}) мм.`,
  )
  if (m.done) lines.push('Замеры по этой пометке уже внесены.')
  if (t.runs.length) {
    lines.push('Чистые размеры (стороны стен), которых касается пометка — цели apply_measurement:')
    for (const r of t.runs.slice(0, 12))
      lines.push(`- ${r.key} «${r.roomName}»: сейчас ${r0(r.length)} мм, концы a=${r.endA ?? '?'} b=${r.endB ?? '?'}, покрыто пометкой ${Math.round(r.cover * 100)}%`)
  }
  if (t.walls.length)
    lines.push(
      `Стены: ${t.walls
        .slice(0, 12)
        .map((w) => `${w.id} (${w.a}→${w.b}, по оси ${r0(w.length)} мм, толщина ${r0(w.thickness)}${w.sides.length ? `, стороны ${w.sides.join('/')}` : ''})`)
        .join('; ')}`,
    )
  if (t.nodes.length) lines.push(`Узлы: ${t.nodes.slice(0, 16).map((id) => `${id} (${r0(doc.nodes[id].x)}, ${r0(doc.nodes[id].y)})`).join(', ')}`)
  if (t.openings.length) lines.push(`Проёмы: ${t.openings.slice(0, 10).join(', ')}`)
  if (t.rooms.length) lines.push(`Помещения: ${t.rooms.map((r) => `${r.id} «${r.name}»`).join(', ')}`)
  if (t.items.length) lines.push(`Предметы: ${t.items.slice(0, 10).map((id) => `${id} (${doc.items[id].name ?? doc.items[id].assetId})`).join(', ')}`)
  if (!t.runs.length && !t.walls.length && !t.rooms.length) lines.push('Пометка не касается стен и помещений.')
  return lines.join('\n')
}

/** mark under the pointer (screen tolerance in mm), topmost = highest number */
export function markAt(doc: Pick<Doc, 'annotations'>, levelId: Id, p: Vec2, tol: number): Annotation | null {
  let best: Annotation | null = null
  for (const id in doc.annotations ?? {}) {
    const m = doc.annotations![id]
    if (m.levelId !== levelId) continue
    if (markDistance(m, p) > tol) continue
    if (!best || m.n > best.n) best = m
  }
  return best
}
