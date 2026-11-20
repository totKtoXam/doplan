/**
 * 2D geometry kernel. Plan coordinates: float millimetres, x → right, y → DOWN.
 * Signed areas use the standard shoelace formula, therefore in these y-down coordinates
 * a POSITIVE area means "clockwise on screen" and a negative one "counter-clockwise on screen".
 */
import type { Vec2 } from './types'

/** Point-coincidence tolerance, mm. */
export const EPS = 0.5

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ───────────────────────────── world conversion ─────────────────────────────

/** The ONLY plan → 3D conversion: mm (y-down plan) → metres (Y-up world). */
export function toWorld(x: number, y: number, elev = 0): [number, number, number] {
  return [x / 1000, elev / 1000, y / 1000]
}

/** World metres (x, z) → plan mm. */
export function fromWorld(wx: number, wz: number): Vec2 {
  return { x: wx * 1000, y: wz * 1000 }
}

// ───────────────────────────── vector basics ─────────────────────────────

export function vec(x: number, y: number): Vec2 {
  return { x, y }
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k }
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

/** z component of the 3D cross product. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y)
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Unit vector; the zero vector stays zero. */
export function norm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Rotates `p` by `deg` degrees (clockwise on the y-down plan) around `origin` (default 0,0). */
export function rotate(p: Vec2, deg: number, origin?: Vec2): Vec2 {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const ox = origin ? origin.x : 0
  const oy = origin ? origin.y : 0
  const dx = p.x - ox
  const dy = p.y - oy
  return { x: ox + dx * c - dy * s, y: oy + dx * s + dy * c }
}

/**
 * Direction angle in degrees (clockwise on the plan, 0 = +x, range (-180, 180]).
 * `angleDeg(v)` — angle of the vector; `angleDeg(a, b)` — angle of the vector from `a` to `b`.
 */
export function angleDeg(a: Vec2, b?: Vec2): number {
  const dx = b ? b.x - a.x : a.x
  const dy = b ? b.y - a.y : a.y
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/** Left-hand normal of a direction as defined in types.ts: (dy, -dx). */
export function leftNormal(d: Vec2): Vec2 {
  return { x: d.y, y: -d.x }
}

export function almostEqual(a: Vec2, b: Vec2, tol = EPS): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol
}

// ───────────────────────────── polygons ─────────────────────────────

/** Signed shoelace area (mm²). Positive = clockwise on screen (y-down). */
export function polygonArea(poly: readonly Vec2[]): number {
  let s = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

export function polygonPerimeter(poly: readonly Vec2[]): number {
  let s = 0
  const n = poly.length
  for (let i = 0; i < n; i++) s += dist(poly[i], poly[(i + 1) % n])
  return s
}

/** Area centroid; falls back to the vertex average for degenerate polygons. */
export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  const n = poly.length
  if (n === 0) return { x: 0, y: 0 }
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const f = p.x * q.y - q.x * p.y
    a += f
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p.x
      sy += p.y
    }
    return { x: sx / n, y: sy / n }
  }
  return { x: cx / (3 * a), y: cy / (3 * a) }
}

function inRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Even-odd point-in-polygon test; points inside any of `holes` are outside. */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[], holes?: readonly (readonly Vec2[])[]): boolean {
  if (polygon.length < 3 || !inRing(p, polygon)) return false
  if (holes) for (const h of holes) if (h.length >= 3 && inRing(p, h)) return false
  return true
}

export function bboxOf(points: readonly Vec2[]): BBox {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

// ───────────────────────────── segments ─────────────────────────────

/** Result of `segIntersect`: the point itself (x, y — also as `point`) plus the parameters on both segments. */
export interface SegHit extends Vec2 {
  point: Vec2
  /** 0..1 along a1→a2 */
  t: number
  /** 0..1 along b1→b2 */
  u: number
}

/**
 * Intersection of segments a1–a2 and b1–b2 (inclusive of end points). Parallel / collinear
 * segments return null.
 */
export function segIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): SegHit | null {
  const rx = a2.x - a1.x
  const ry = a2.y - a1.y
  const sx = b2.x - b1.x
  const sy = b2.y - b1.y
  const den = rx * sy - ry * sx
  const la = Math.hypot(rx, ry)
  const lb = Math.hypot(sx, sy)
  if (la < 1e-9 || lb < 1e-9 || Math.abs(den) < 1e-9 * la * lb) return null
  const qx = b1.x - a1.x
  const qy = b1.y - a1.y
  const t = (qx * sy - qy * sx) / den
  const u = (qx * ry - qy * rx) / den
  const tolT = 1e-9
  if (t < -tolT || t > 1 + tolT || u < -tolT || u > 1 + tolT) return null
  const tc = Math.min(1, Math.max(0, t))
  const uc = Math.min(1, Math.max(0, u))
  const x = a1.x + rx * tc
  const y = a1.y + ry * tc
  return { x, y, point: { x, y }, t: tc, u: uc }
}

/** Intersection of two infinite lines given as point + direction; null when parallel. */
export function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): { point: Vec2; s: number; u: number } | null {
  const den = cross(d, e)
  if (Math.abs(den) < 1e-12 * Math.max(1e-12, len(d) * len(e))) return null
  const w = sub(q, p)
  const s = cross(w, e) / den
  const u = cross(w, d) / den
  return { point: { x: p.x + d.x * s, y: p.y + d.y * s }, s, u }
}

/** Closest point of segment a–b to `p`: the point, its parameter t ∈ [0, 1] and the distance. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 < 1e-18 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.min(1, Math.max(0, t))
  const point = { x: a.x + dx * t, y: a.y + dy * t }
  return { point, t, dist: Math.hypot(p.x - point.x, p.y - point.y) }
}

// ───────────────────────────── polylabel ─────────────────────────────

function segDistSq(px: number, py: number, a: Vec2, b: Vec2): number {
  let x = a.x
  let y = a.y
  let dx = b.x - x
  let dy = b.y - y
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b.x
      y = b.y
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = px - x
  dy = py - y
  return dx * dx + dy * dy
}

/** Signed distance from a point to the polygon outline (positive inside, negative outside). */
function pointToPolygonDist(x: number, y: number, rings: readonly (readonly Vec2[])[]): number {
  let inside = false
  let minDistSq = Infinity
  for (const ring of rings) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
      const d = segDistSq(x, y, a, b)
      if (d < minDistSq) minDistSq = d
    }
  }
  return minDistSq === Infinity ? 0 : (inside ? 1 : -1) * Math.sqrt(minDistSq)
}

interface Cell {
  x: number
  y: number
  h: number
  d: number
  max: number
}

function makeCell(x: number, y: number, h: number, rings: readonly (readonly Vec2[])[]): Cell {
  const d = pointToPolygonDist(x, y, rings)
  return { x, y, h, d, max: d + h * Math.SQRT2 }
}

class CellQueue {
  private data: Cell[] = []
  get length(): number {
    return this.data.length
  }
  push(c: Cell): void {
    const d = this.data
    d.push(c)
    let i = d.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (d[parent].max >= c.max) break
      d[i] = d[parent]
      i = parent
    }
    d[i] = c
  }
  pop(): Cell | undefined {
    const d = this.data
    if (d.length === 0) return undefined
    const top = d[0]
    const last = d.pop() as Cell
    if (d.length > 0) {
      let i = 0
      const half = d.length >> 1
      while (i < half) {
        let child = 2 * i + 1
        if (child + 1 < d.length && d[child + 1].max > d[child].max) child++
        if (d[child].max <= last.max) break
        d[i] = d[child]
        i = child
      }
      d[i] = last
    }
    return top
  }
}

/**
 * Pole of inaccessibility (the interior point farthest from the outline) — a good label position.
 * `precision` in mm; by default 0.5 % of the smaller bbox side clamped to 1…50 mm. The centroid is
 * preferred whenever it is as good as the best cell, so convex rooms get a centred label.
 */
export function polylabel(polygon: readonly Vec2[], holes?: readonly (readonly Vec2[])[], precision?: number): Vec2 {
  // every edit derives the rooms of the level again, while a drag or a rename changes one or two of
  // them: the answer for an unchanged outline is remembered (keyed by the exact coordinates)
  let key = precision === undefined ? '' : `${precision}:`
  for (const p of polygon) key += `${p.x},${p.y};`
  if (holes) for (const h of holes) {
    key += '|'
    for (const p of h) key += `${p.x},${p.y};`
  }
  const hit = labelCache.get(key)
  if (hit) {
    labelCache.delete(key)
    labelCache.set(key, hit)
    return { x: hit.x, y: hit.y }
  }
  const p = polylabelUncached(polygon, holes, precision)
  labelCache.set(key, p)
  if (labelCache.size > LABEL_CACHE_SIZE) labelCache.delete(labelCache.keys().next().value!)
  return { x: p.x, y: p.y }
}
const LABEL_CACHE_SIZE = 4000
/** least recently used first */
const labelCache = new Map<string, Vec2>()

function polylabelUncached(polygon: readonly Vec2[], holes?: readonly (readonly Vec2[])[], precision?: number): Vec2 {
  if (polygon.length === 0) return { x: 0, y: 0 }
  if (polygon.length < 3) return polygonCentroid(polygon)
  const rings: (readonly Vec2[])[] = [polygon]
  if (holes) for (const h of holes) if (h.length >= 3) rings.push(h)
  const bb = bboxOf(polygon)
  const width = bb.maxX - bb.minX
  const height = bb.maxY - bb.minY
  const cellSize = Math.min(width, height)
  if (cellSize <= 1e-9) return { x: bb.minX + width / 2, y: bb.minY + height / 2 }
  const prec = precision ?? Math.min(50, Math.max(1, cellSize * 0.005))

  const queue = new CellQueue()
  let h = cellSize / 2
  for (let x = bb.minX; x < bb.maxX; x += cellSize) {
    for (let y = bb.minY; y < bb.maxY; y += cellSize) queue.push(makeCell(x + h, y + h, h, rings))
  }

  const c = polygonCentroid(polygon)
  let best = makeCell(c.x, c.y, 0, rings)
  const bboxCell = makeCell(bb.minX + width / 2, bb.minY + height / 2, 0, rings)
  if (bboxCell.d > best.d + prec) best = bboxCell

  let guard = 0
  while (queue.length > 0 && guard++ < 20000) {
    const cell = queue.pop() as Cell
    // a cell replaces the current best only when it is better by more than the precision,
    // which keeps the label on the centroid of convex rooms and makes it stable under small edits
    if (cell.d > best.d + prec) best = cell
    if (cell.max - best.d <= prec) continue
    h = cell.h / 2
    queue.push(makeCell(cell.x - h, cell.y - h, h, rings))
    queue.push(makeCell(cell.x + h, cell.y - h, h, rings))
    queue.push(makeCell(cell.x - h, cell.y + h, h, rings))
    queue.push(makeCell(cell.x + h, cell.y + h, h, rings))
  }
  return { x: best.x, y: best.y }
}
