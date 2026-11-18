/**
 * Distances for the viewer: between two picked points and between two plan objects (shortest, and
 * its parts along the plan's X / Y and in height). Objects are footprint polygons on the plan with a
 * height range above the floor. Pure, millimetres.
 */
import { itemFootprint, pointInPolygon, projectOnSegment } from '@core'
import type { DerivedPlan, Doc, EntityRef, Vec2 } from '@core/types'

export interface Shape {
  /** footprint on the plan (a single point for lights and sockets) */
  poly: Vec2[]
  /** bottom and top above the floor */
  z0: number
  z1: number
}

export interface Gap {
  /** shortest distance in space */
  shortest: number
  /** clear gaps along the plan's X and Y axes and in height (0 where the objects overlap) */
  dx: number
  dy: number
  dz: number
  /** the closest points on the plan (for the drawn dimension line) */
  a: Vec2
  b: Vec2
  /** heights of the closest points */
  za: number
  zb: number
}

/** the shape of an object as the viewer measures it, null for kinds without one */
export function shapeOf(ref: EntityRef, doc: Doc, plan: DerivedPlan | undefined): Shape | null {
  switch (ref.kind) {
    case 'item': {
      const it = doc.items[ref.id]
      return it ? { poly: itemFootprint(it), z0: it.elevation, z1: it.elevation + it.size.h } : null
    }
    case 'wall': {
      const w = doc.walls[ref.id]
      const g = plan?.wallGeoms[ref.id]
      if (!w || !g) return null
      return { poly: g.polygon.length >= 3 ? g.polygon : [g.a, g.b], z0: 0, z1: w.height }
    }
    case 'opening': {
      const o = doc.openings[ref.id]
      const w = o && doc.walls[o.wallId]
      const g = o && plan?.wallGeoms[o.wallId]
      if (!o || !w || !g || !(g.length > 0)) return null
      const ux = (g.b.x - g.a.x) / g.length
      const uy = (g.b.y - g.a.y) / g.length
      const nx = -uy * (w.thickness / 2)
      const ny = ux * (w.thickness / 2)
      const at = (s: number, k: number): Vec2 => ({ x: g.a.x + ux * s + nx * k, y: g.a.y + uy * s + ny * k })
      const s0 = o.offset - o.width / 2
      const s1 = o.offset + o.width / 2
      return { poly: [at(s0, -1), at(s1, -1), at(s1, 1), at(s0, 1)], z0: o.sill, z1: o.sill + o.height }
    }
    case 'room': {
      const r = plan?.rooms.find((e) => e.roomId === ref.id)
      if (!r) return null
      const h = doc.rooms[ref.id]?.ceiling?.height ?? doc.levels[r.levelId]?.height ?? 2700
      return { poly: r.polygon, z0: 0, z1: h }
    }
    case 'light': {
      const l = doc.lights[ref.id]
      return l ? { poly: [{ x: l.x, y: l.y }], z0: l.elevation, z1: l.elevation } : null
    }
    case 'electric': {
      const p = doc.electrical?.[ref.id]
      return p ? { poly: [{ x: p.x, y: p.y }], z0: p.elevation, z1: p.elevation } : null
    }
    default:
      return null
  }
}

function edges(poly: readonly Vec2[]): [Vec2, Vec2][] {
  if (poly.length === 1) return [[poly[0], poly[0]]]
  if (poly.length === 2) return [[poly[0], poly[1]]]
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]])
}

function inside(p: Vec2, poly: readonly Vec2[]): boolean {
  return poly.length >= 3 && pointInPolygon(p, poly)
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; dist: number } {
  if (a.x === b.x && a.y === b.y) return { point: a, dist: Math.hypot(p.x - a.x, p.y - a.y) }
  return projectOnSegment(p, a, b)
}

function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dx = a2.x - a1.x
  const dy = a2.y - a1.y
  const ex = b2.x - b1.x
  const ey = b2.y - b1.y
  const den = dx * ey - dy * ex
  if (Math.abs(den) < 1e-9) return null
  const s = ((b1.x - a1.x) * ey - (b1.y - a1.y) * ex) / den
  const u = ((b1.x - a1.x) * dy - (b1.y - a1.y) * dx) / den
  return s >= 0 && s <= 1 && u >= 0 && u <= 1 ? { x: a1.x + dx * s, y: a1.y + dy * s } : null
}

/** shortest distance between two footprints on the plan (0 when they touch or overlap) and its points */
export function planGap(A: readonly Vec2[], B: readonly Vec2[]): { dist: number; a: Vec2; b: Vec2 } {
  for (const p of A) if (inside(p, B)) return { dist: 0, a: p, b: p }
  for (const p of B) if (inside(p, A)) return { dist: 0, a: p, b: p }
  let best = { dist: Infinity, a: A[0], b: B[0] }
  for (const [a1, a2] of edges(A)) {
    for (const [b1, b2] of edges(B)) {
      const x = segmentsCross(a1, a2, b1, b2)
      if (x) return { dist: 0, a: x, b: x }
      for (const [p, s, t, flip] of [
        [a1, b1, b2, false],
        [a2, b1, b2, false],
        [b1, a1, a2, true],
        [b2, a1, a2, true],
      ] as const) {
        const c = closestOnSegment(p, s, t)
        if (c.dist < best.dist) best = flip ? { dist: c.dist, a: c.point, b: p } : { dist: c.dist, a: p, b: c.point }
      }
    }
  }
  return best
}

function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, b0 - a1, a0 - b1)
}

export function gapBetween(A: Shape, B: Shape): Gap {
  const g = planGap(A.poly, B.poly)
  const xs = (s: Shape) => s.poly.map((p) => p.x)
  const ys = (s: Shape) => s.poly.map((p) => p.y)
  const dx = axisGap(Math.min(...xs(A)), Math.max(...xs(A)), Math.min(...xs(B)), Math.max(...xs(B)))
  const dy = axisGap(Math.min(...ys(A)), Math.max(...ys(A)), Math.min(...ys(B)), Math.max(...ys(B)))
  const dz = axisGap(A.z0, A.z1, B.z0, B.z1)
  // closest heights: the facing ends of the two ranges, or a shared height when they overlap
  const shared = Math.max(A.z0, B.z0) <= Math.min(A.z1, B.z1) ? (Math.max(A.z0, B.z0) + Math.min(A.z1, B.z1)) / 2 : null
  const za = shared ?? (A.z1 < B.z0 ? A.z1 : A.z0)
  const zb = shared ?? (A.z1 < B.z0 ? B.z0 : B.z1)
  return { shortest: Math.hypot(g.dist, dz), dx, dy, dz, a: g.a, b: g.b, za, zb }
}

/** two measured points (plan mm + height mm): the distance and its X / Y / height parts */
export function pointGap(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  const dz = Math.abs(b.z - a.z)
  return { shortest: Math.hypot(dx, dy, dz), dx, dy, dz }
}
