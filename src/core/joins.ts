/**
 * Wall joins: N-way angular-sort mitre.
 *
 * For every node the incident solid wall ends are sorted by direction angle; each gap between two
 * neighbouring ends gets one corner (intersection of the facing side lines). Free ends get a square
 * cap. Reflex corners sharper than the mitre limit are bevelled. At junctions of 3+ walls (or with a
 * bevel) every wall polygon also runs through the node itself, so the polygons of all walls tile the
 * junction exactly — there is no separate "hub" polygon to draw or extrude.
 *
 * Virtual walls (room separators) have no thickness: they do not influence the corners of solid walls
 * and end where their axis leaves the solid junction (on the face of the wall they touch).
 */
import { add, cross, dist, dot, leftNormal, lineIntersect, scale, segIntersect, sub } from './geom'
import type { Doc, Id, Vec2, Wall, WallGeom } from './types'

/** |sin| of the angle below which two wall directions are treated as parallel (0.25°). */
const PARALLEL_SIN = Math.sin((0.25 * Math.PI) / 180)
/** reflex (outer) corners farther than MITER_LIMIT × half-thickness from the node are bevelled */
const MITER_LIMIT = 4
const LEN_EPS = 0.01

interface WallEnd {
  wall: Wall
  atA: boolean
  /** unit direction pointing away from the node along the wall */
  d: Vec2
  /** half thickness on the outward-left / outward-right side */
  hl: number
  hr: number
  ang: number
  solid: boolean
  /** corners in the OUTWARD-from-node frame */
  left: Vec2
  right: Vec2
  /** extra outline points between `left` and `right` (in that order) closing the wall end */
  cap: Vec2[]
  /** set on the end whose right-hand gap was bevelled: the neighbour's corner */
  bevelTo: Vec2 | null
}

/** Half thickness used for geometry: virtual walls are zero-thickness. */
export function wallHalfThickness(wall: Wall): number {
  if (wall.kind === 'virtual') return 0
  const t = Number.isFinite(wall.thickness) ? wall.thickness : 0
  return t > 0 ? t / 2 : 0
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= LEN_EPS && Math.abs(a.y - b.y) <= LEN_EPS
}

function pushUnique(out: Vec2[], p: Vec2): void {
  const last = out[out.length - 1]
  if (last && samePoint(last, p)) return
  out.push({ x: p.x, y: p.y })
}

/** true when `p` lies (within LEN_EPS) on the segment a–b */
function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  const ab = sub(b, a)
  const l = Math.hypot(ab.x, ab.y)
  if (l < LEN_EPS) return samePoint(p, a)
  const ap = sub(p, a)
  if (Math.abs(cross(ab, ap)) / l > LEN_EPS) return false
  const t = dot(ap, ab) / l
  return t >= -LEN_EPS && t <= l + LEN_EPS
}

function joinSolidEnds(v: Vec2, ends: WallEnd[]): void {
  const k = ends.length
  if (k === 0) return
  if (k === 1) {
    const e = ends[0]
    const n = leftNormal(e.d)
    e.left = add(v, scale(n, e.hl))
    e.right = add(v, scale(n, -e.hr))
    return
  }
  ends.sort((p, q) => p.ang - q.ang || (p.wall.id < q.wall.id ? -1 : 1))
  let needHub = k >= 3
  for (let i = 0; i < k; i++) {
    // P has the lower angle; the gap between P and Q is bounded by P's right side and Q's left side
    const P = ends[i]
    const Q = ends[(i + 1) % k]
    const pP = add(v, scale(leftNormal(P.d), -P.hr))
    const pQ = add(v, scale(leftNormal(Q.d), Q.hl))
    const cr = cross(P.d, Q.d)
    let gap = Q.ang - P.ang
    if (gap <= 0) gap += Math.PI * 2
    let cP = pP
    let cQ = pQ
    if (Math.abs(cr) >= PARALLEL_SIN) {
      const s = cross(sub(pQ, pP), Q.d) / cr
      const c = add(pP, scale(P.d, s))
      const reflex = gap > Math.PI
      const lim = MITER_LIMIT * Math.max(P.hr, Q.hl, 1)
      if (!(reflex && dist(c, v) > lim)) {
        cP = c
        cQ = c
      }
    }
    P.right = cP
    Q.left = cQ
    if (!samePoint(cP, cQ) && Math.abs(cross(sub(cP, v), sub(cQ, v))) / dist(cP, cQ) > LEN_EPS) {
      // bevel: the triangle (cP, v, cQ) is given to P
      P.bevelTo = cQ
      needHub = true
    }
  }
  if (needHub) {
    for (const e of ends) {
      e.cap = [{ x: v.x, y: v.y }]
      if (e.bevelTo) e.cap.push(e.bevelTo)
    }
  }
}

/** End point of a zero-thickness wall: where its axis leaves the solid material of the junction. */
function virtualEndPoint(v: Vec2, e: WallEnd, solid: WallEnd[]): Vec2 {
  if (solid.length === 0) return { x: v.x, y: v.y }
  // neighbours in angular order: P = last solid end with angle <= e.ang, Q = the next one
  let pi = -1
  for (let i = 0; i < solid.length; i++) if (solid[i].ang <= e.ang) pi = i
  if (pi < 0) pi = solid.length - 1
  const P = solid[pi]
  const Q = solid[(pi + 1) % solid.length]
  const st: { t: number; p: Vec2 | null } = { t: Infinity, p: null }
  const consider = (corner: Vec2, dir: Vec2): void => {
    const hit = lineIntersect(v, e.d, corner, dir)
    if (!hit) return
    // on the ray (s >= 0) and on the half-line of the face beyond its corner (u >= 0)
    if (hit.s < -LEN_EPS || hit.u < -LEN_EPS) return
    if (hit.s < st.t) {
      st.t = hit.s
      st.p = hit.point
    }
  }
  consider(P.right, P.d)
  consider(Q.left, Q.d)
  if (!samePoint(P.right, Q.left)) {
    const far = add(v, scale(e.d, 1e7))
    const hit = segIntersect(v, far, P.right, Q.left)
    if (hit) {
      const t = dist(v, hit.point)
      // a cut running through the node itself (square cap) only counts when no face was hit
      if (t < st.t && (t > LEN_EPS || st.p === null)) {
        st.t = t
        st.p = hit.point
      }
    }
  }
  return st.p ?? { x: v.x, y: v.y }
}

/**
 * Mitred wall outlines for one level. Every wall of the level gets a WallGeom, including
 * degenerate ones (so lookups never fail).
 */
export function computeWallGeoms(doc: Pick<Doc, 'nodes' | 'walls'>, levelId: Id): Record<Id, WallGeom> {
  const out: Record<Id, WallGeom> = {}
  const endsByNode = new Map<Id, WallEnd[]>()
  const endA = new Map<Id, WallEnd>()
  const endB = new Map<Id, WallEnd>()
  const walls: Wall[] = []

  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== levelId) continue
    const na = doc.nodes[w.a]
    const nb = doc.nodes[w.b]
    if (!na || !nb) continue
    const a = { x: na.x, y: na.y }
    const b = { x: nb.x, y: nb.y }
    const length = dist(a, b)
    if (length < 1e-6 || w.a === w.b) {
      out[w.id] = { wallId: w.id, polygon: [a, a, a, a], left: [a, a], right: [a, a], a, b, length: 0, angle: 0 }
      continue
    }
    walls.push(w)
    const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    const h = wallHalfThickness(w)
    const solid = h > 0
    const ea: WallEnd = {
      wall: w,
      atA: true,
      d,
      hl: h,
      hr: h,
      ang: Math.atan2(d.y, d.x),
      solid,
      left: add(a, scale(leftNormal(d), h)),
      right: add(a, scale(leftNormal(d), -h)),
      cap: [],
      bevelTo: null,
    }
    const db = { x: -d.x, y: -d.y }
    const eb: WallEnd = {
      wall: w,
      atA: false,
      d: db,
      hl: h,
      hr: h,
      ang: Math.atan2(db.y, db.x),
      solid,
      left: add(b, scale(leftNormal(db), h)),
      right: add(b, scale(leftNormal(db), -h)),
      cap: [],
      bevelTo: null,
    }
    endA.set(w.id, ea)
    endB.set(w.id, eb)
    let la = endsByNode.get(w.a)
    if (!la) endsByNode.set(w.a, (la = []))
    la.push(ea)
    let lb = endsByNode.get(w.b)
    if (!lb) endsByNode.set(w.b, (lb = []))
    lb.push(eb)
  }

  for (const [nodeId, ends] of endsByNode) {
    const n = doc.nodes[nodeId]
    const v = { x: n.x, y: n.y }
    const solid = ends.filter((e) => e.solid)
    joinSolidEnds(v, solid)
    for (const e of ends) {
      if (e.solid) continue
      const p = virtualEndPoint(v, e, solid)
      e.left = p
      e.right = p
    }
  }

  for (const w of walls) {
    const ea = endA.get(w.id) as WallEnd
    const eb = endB.get(w.id) as WallEnd
    const na = doc.nodes[w.a]
    const nb = doc.nodes[w.b]
    const a = { x: na.x, y: na.y }
    const b = { x: nb.x, y: nb.y }
    const length = dist(a, b)
    const d = ea.d
    const angle = Math.atan2(d.y, d.x)

    if (!ea.solid) {
      let pa = ea.left
      let pb = eb.left
      // the two trimmed ends must not cross each other
      if (dot(sub(pb, pa), d) <= LEN_EPS) {
        pa = a
        pb = b
      }
      out[w.id] = {
        wallId: w.id,
        polygon: [pa, pb, pb, pa].map((p) => ({ x: p.x, y: p.y })),
        left: [pa, pb],
        right: [pa, pb],
        a,
        b,
        length,
        angle,
      }
      continue
    }

    // translate outward-frame corners into the a→b frame
    let sL = ea.left
    let sR = ea.right
    let eL = eb.right
    let eR = eb.left
    let capA = ea.cap
    let capB = eb.cap
    const h = ea.hl
    const nL = leftNormal(d)
    // bow-tie guard: wall shorter than its joins
    const s1 = dot(sub(sL, a), d)
    const s2 = dot(sub(eL, a), d)
    if (s1 > s2 - LEN_EPS) {
      const m = add(add(a, scale(nL, h)), scale(d, (s1 + s2) / 2))
      sL = m
      eL = m
    }
    const r1 = dot(sub(sR, a), d)
    const r2 = dot(sub(eR, a), d)
    if (r1 > r2 - LEN_EPS) {
      const m = add(add(a, scale(nL, -h)), scale(d, (r1 + r2) / 2))
      sR = m
      eR = m
    }
    // node points that lie on the straight cut add nothing
    if (capA.length === 1 && onSegment(capA[0], sL, sR)) capA = []
    if (capB.length === 1 && onSegment(capB[0], eR, eL)) capB = []

    // CCW on screen: right face a→b, end at b, left face b→a, end at a
    const poly: Vec2[] = []
    pushUnique(poly, sR)
    pushUnique(poly, eR)
    for (const p of capB) pushUnique(poly, p)
    pushUnique(poly, eL)
    pushUnique(poly, sL)
    for (const p of capA) pushUnique(poly, p)
    while (poly.length > 1 && samePoint(poly[0], poly[poly.length - 1])) poly.pop()

    out[w.id] = {
      wallId: w.id,
      polygon: poly,
      left: [
        { x: sL.x, y: sL.y },
        { x: eL.x, y: eL.y },
      ],
      right: [
        { x: sR.x, y: sR.y },
        { x: eR.x, y: eR.y },
      ],
      a,
      b,
      length,
      angle,
    }
  }
  return out
}
