/**
 * Small local 2D helpers for the editor (plan mm, y down). Kept local so the editor does not
 * depend on the exact helper signatures of the core geometry module.
 */
import type { Vec2 } from '@core/types'

export const V = (x: number, y: number): Vec2 => ({ x, y })
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
export const len = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function norm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l }
}

/** "left" normal of a direction as defined by the document schema: (dy, -dx). */
export const leftOf = (d: Vec2): Vec2 => ({ x: d.y, y: -d.x })

export const DEG = Math.PI / 180

/** rotate by radians (positive = clockwise on screen because y is down) */
export function rot(p: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const point = { x: a.x + dx * t, y: a.y + dy * t }
  return { point, t, dist: Math.hypot(p.x - point.x, p.y - point.y) }
}

/** unclamped projection parameter and foot on the infinite line a–b */
export function projectOnLine(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  const point = { x: a.x + dx * t, y: a.y + dy * t }
  return { point, t, dist: Math.hypot(p.x - point.x, p.y - point.y) }
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function bboxOf(pts: readonly Vec2[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export const bboxValid = (b: BBox): boolean =>
  isFinite(b.minX) && isFinite(b.maxX) && isFinite(b.minY) && isFinite(b.maxY)

export function bboxUnion(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

export const bboxContainsPoint = (b: BBox, p: Vec2, pad = 0): boolean =>
  p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad

export const bboxOverlap = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export const bboxInside = (inner: BBox, outer: BBox): boolean =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY

/** intersection of infinite lines p + t·d1 and q + u·d2 */
export function lineLine(p: Vec2, d1: Vec2, q: Vec2, d2: Vec2): { t: number; u: number; point: Vec2 } | null {
  const cr = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(cr) < 1e-9) return null
  const wx = q.x - p.x
  const wy = q.y - p.y
  const t = (wx * d2.y - wy * d2.x) / cr
  const u = (wx * d1.y - wy * d1.x) / cr
  return { t, u, point: { x: p.x + d1.x * t, y: p.y + d1.y * t } }
}

export function segSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = lineLine(a, sub(b, a), c, sub(d, c))
  if (!r) return null
  if (r.t < 0 || r.t > 1 || r.u < 0 || r.u > 1) return null
  return r.point
}

/** does segment a–b touch the axis-aligned box */
export function segIntersectsBBox(a: Vec2, b: Vec2, box: BBox): boolean {
  if (bboxContainsPoint(box, a) || bboxContainsPoint(box, b)) return true
  const c1 = { x: box.minX, y: box.minY }
  const c2 = { x: box.maxX, y: box.minY }
  const c3 = { x: box.maxX, y: box.maxY }
  const c4 = { x: box.minX, y: box.maxY }
  return !!(segSeg(a, b, c1, c2) || segSeg(a, b, c2, c3) || segSeg(a, b, c3, c4) || segSeg(a, b, c4, c1))
}

export function polygonIntersectsBBox(poly: readonly Vec2[], box: BBox): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (segIntersectsBBox(poly[i], poly[(i + 1) % poly.length], box)) return true
  }
  return poly.length >= 3 && pointInPolygon({ x: box.minX, y: box.minY }, poly)
}

/** corners of a rectangle of size w×d centred at c, rotated by deg (clockwise on plan) */
export function rectCorners(c: Vec2, w: number, d: number, deg: number): Vec2[] {
  const r = deg * DEG
  const hw = w / 2
  const hd = d / 2
  return [
    add(c, rot({ x: -hw, y: -hd }, r)),
    add(c, rot({ x: hw, y: -hd }, r)),
    add(c, rot({ x: hw, y: hd }, r)),
    add(c, rot({ x: -hw, y: hd }, r)),
  ]
}

export function normDeg(d: number): number {
  let r = d % 360
  if (r < 0) r += 360
  return r
}

/** clip parallel hatch lines against rings (even-odd). Returns a flat segment list [x1,y1,x2,y2,…]. */
export function hatchPolygon(
  rings: readonly (readonly Vec2[])[],
  angleRad: number,
  spacing: number,
  phase = 0,
  maxLines = 300,
): number[] {
  const out: number[] = []
  if (spacing <= 0) return out
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  // rotate so that hatch lines become horizontal: p' = R(-angle) p
  let minY = Infinity
  let maxY = -Infinity
  const rr: Vec2[][] = rings.map((ring) =>
    ring.map((p) => {
      const x = p.x * c + p.y * s
      const y = -p.x * s + p.y * c
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      return { x, y }
    }),
  )
  if (!isFinite(minY)) return out
  let step = spacing
  while ((maxY - minY) / step > maxLines) step *= 2
  const start = Math.ceil((minY - phase) / step) * step + phase
  const xs: number[] = []
  for (let y = start + 1e-3; y < maxY; y += step) {
    xs.length = 0
    for (const ring of rr) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]
        const b = ring[i]
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
      }
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x1 = xs[k]
      const x2 = xs[k + 1]
      if (x2 - x1 < 1) continue
      out.push(x1 * c - y * s, x1 * s + y * c, x2 * c - y * s, x2 * s + y * c)
    }
  }
  return out
}
