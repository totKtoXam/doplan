/**
 * Insetting a polygon (mitered corners), shared by the 3D build (the raised centre of a multilevel
 * ceiling, view3d/build/rooms) and core/ceiling (where its lowered border ring is), so the height
 * an electric point gets is the ceiling the 3D view draws. Any unit.
 */
import { EndType, JoinType, inflatePathsD } from 'clipper2-ts'
import type { Vec2 } from './types'

function signedArea(pts: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

/** removes consecutive duplicates and collinear points */
export function cleanPolygon(pts: readonly Vec2[], eps = 0.5): Vec2[] {
  const out: Vec2[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p)
  }
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) out.pop()
  return out
}

/**
 * Insets a polygon by `d` (same unit as the points). Returns the largest resulting loop,
 * or null when the polygon collapses.
 */
export function insetPolygon(pts: readonly Vec2[], d: number): Vec2[] | null {
  const src = cleanPolygon(pts)
  if (src.length < 3 || d <= 0) return null
  // clipper treats positive-area paths as outer contours; orientation is normalised first
  const path = signedArea(src) >= 0 ? src.map((p) => ({ x: p.x, y: p.y })) : src.map((p) => ({ x: p.x, y: p.y })).reverse()
  try {
    const res = inflatePathsD([path], -d, JoinType.Miter, EndType.Polygon, 4, 2)
    let best: Vec2[] | null = null
    let bestArea = 0
    for (const loop of res) {
      const poly = loop.map((p) => ({ x: p.x, y: p.y }))
      const a = Math.abs(signedArea(poly))
      if (a > bestArea) {
        bestArea = a
        best = poly
      }
    }
    if (!best || best.length < 3 || bestArea < 1e-9) return null
    return cleanPolygon(best, Math.max(1e-6, d * 1e-4))
  } catch {
    return null
  }
}
