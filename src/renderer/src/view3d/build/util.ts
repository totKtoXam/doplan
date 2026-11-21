/**
 * Geometry helpers shared by the architecture builders.
 * Everything here works in world metres (Y-up) unless a name says `Mm`.
 */
import * as THREE from 'three'
import { toWorld } from '@core'
import type { EntityRef, Vec2 } from '@core/types'

export const MM = 0.001

export type P2 = [number, number]

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _ab = new THREE.Vector3()
const _ac = new THREE.Vector3()
const _n = new THREE.Vector3()

/** plan mm (+ elevation mm) → world metres */
export function w3(x: number, y: number, elev = 0): THREE.Vector3 {
  const p = toWorld(x, y, elev)
  return new THREE.Vector3(p[0], p[1], p[2])
}

/** plan direction (unitless) → world direction */
export function dir3(dx: number, dy: number): THREE.Vector3 {
  const o = toWorld(0, 0, 0)
  const p = toWorld(dx * 1000, dy * 1000, 0)
  return new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2]).normalize()
}

/**
 * Accumulates triangles with positions / normals / UVs (UVs in metres) and
 * produces one indexed BufferGeometry. Winding of every primitive is corrected
 * to face the normal passed by the caller, so callers never reason about it.
 */
export class GeoBuilder {
  private positions: number[] = []
  private normals: number[] = []
  private uvs: number[] = []
  private indices: number[] = []
  private count = 0

  get empty(): boolean {
    return this.indices.length === 0
  }

  private vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number): number {
    this.positions.push(p.x, p.y, p.z)
    this.normals.push(n.x, n.y, n.z)
    this.uvs.push(u, v)
    return this.count++
  }

  private tri(i0: number, i1: number, i2: number, n: THREE.Vector3): void {
    const P = this.positions
    _a.set(P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2])
    _b.set(P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2])
    _c.set(P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2])
    _ab.subVectors(_b, _a)
    _ac.subVectors(_c, _a)
    _n.crossVectors(_ab, _ac)
    if (_n.lengthSq() < 1e-16) return
    if (_n.dot(n) >= 0) this.indices.push(i0, i1, i2)
    else this.indices.push(i0, i2, i1)
  }

  /** quad a-b-c-d (in order around the perimeter) */
  addQuad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    normal: THREE.Vector3,
    ua: P2,
    ub: P2,
    uc: P2,
    ud: P2,
  ): void {
    const i0 = this.vertex(a, normal, ua[0], ua[1])
    const i1 = this.vertex(b, normal, ub[0], ub[1])
    const i2 = this.vertex(c, normal, uc[0], uc[1])
    const i3 = this.vertex(d, normal, ud[0], ud[1])
    this.tri(i0, i1, i2, normal)
    this.tri(i0, i2, i3, normal)
  }

  /**
   * Planar polygon with optional holes. `uv` are the in-plane coordinates in metres;
   * they are used both as texture coordinates and for the earcut triangulation.
   */
  addPolygon(
    pts: THREE.Vector3[],
    uv: P2[],
    normal: THREE.Vector3,
    holes: { pts: THREE.Vector3[]; uv: P2[] }[] = [],
  ): void {
    if (pts.length < 3) return
    const contour = uv.map((p) => new THREE.Vector2(p[0], p[1]))
    const holeContours = holes.map((h) => h.uv.map((p) => new THREE.Vector2(p[0], p[1])))
    let faces: number[][]
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holeContours)
    } catch {
      return
    }
    const base = this.count
    for (let i = 0; i < pts.length; i++) this.vertex(pts[i], normal, uv[i][0], uv[i][1])
    for (const h of holes) for (let i = 0; i < h.pts.length; i++) this.vertex(h.pts[i], normal, h.uv[i][0], h.uv[i][1])
    for (const f of faces) this.tri(base + f[0], base + f[1], base + f[2], normal)
  }

  /**
   * Axis-aligned box given by min / max corners in a local frame, optionally transformed
   * by a rigid matrix. UVs are in metres on every face.
   */
  addBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m?: THREE.Matrix4): void {
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    if (z1 < z0) [z0, z1] = [z1, z0]
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return
    const P = (x: number, y: number, z: number): THREE.Vector3 => {
      const v = new THREE.Vector3(x, y, z)
      return m ? v.applyMatrix4(m) : v
    }
    const N = (x: number, y: number, z: number): THREE.Vector3 => {
      const v = new THREE.Vector3(x, y, z)
      return m ? v.transformDirection(m) : v
    }
    const sx = x1 - x0
    const sy = y1 - y0
    const sz = z1 - z0
    // +X / -X  (u = z, v = y)
    this.addQuad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), N(1, 0, 0), [0, 0], [sz, 0], [sz, sy], [0, sy])
    this.addQuad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), N(-1, 0, 0), [0, 0], [sz, 0], [sz, sy], [0, sy])
    // +Y / -Y  (u = x, v = z)
    this.addQuad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), N(0, 1, 0), [0, 0], [sx, 0], [sx, sz], [0, sz])
    this.addQuad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), N(0, -1, 0), [0, 0], [sx, 0], [sx, sz], [0, sz])
    // +Z / -Z  (u = x, v = y)
    this.addQuad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), N(0, 0, 1), [0, 0], [sx, 0], [sx, sy], [0, sy])
    this.addQuad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), N(0, 0, -1), [0, 0], [sx, 0], [sx, sy], [0, sy])
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    g.setIndex(this.indices)
    g.computeBoundingBox()
    g.computeBoundingSphere()
    return g
  }

  /** builds a shadow-casting mesh, or null when nothing was added */
  mesh(material: THREE.Material, ref: EntityRef, extra?: Record<string, unknown>): THREE.Mesh | null {
    if (this.empty) return null
    const mesh = new THREE.Mesh(this.build(), material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.ref = ref
    if (extra) Object.assign(mesh.userData, extra)
    return mesh
  }
}

// ───────────────────────────── 2D polygon helpers (any unit) ─────────────────────────────

export function signedArea(pts: Vec2[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

export function pointInPoly(x: number, y: number, pts: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

// insetting is shared with core/ceiling (a multilevel ceiling's border ring)
export { cleanPolygon, insetPolygon } from '@core/inset'

/** intervals where the horizontal / vertical line crosses the polygon interior */
export function scanIntervals(pts: Vec2[], axis: 'x' | 'y', value: number): P2[] {
  const hits: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const a0 = axis === 'x' ? a.x : a.y
    const b0 = axis === 'x' ? b.x : b.y
    const a1 = axis === 'x' ? a.y : a.x
    const b1 = axis === 'x' ? b.y : b.x
    if (a0 > value !== b0 > value) hits.push(a1 + ((value - a0) / (b0 - a0)) * (b1 - a1))
  }
  hits.sort((p, q) => p - q)
  const out: P2[] = []
  for (let i = 0; i + 1 < hits.length; i += 2) if (hits[i + 1] - hits[i] > 1e-6) out.push([hits[i], hits[i + 1]])
  return out
}

/** Sutherland–Hodgman clip of a polygon (list of [u, v]) against v0 ≤ v ≤ v1 */
export function clipBand(poly: P2[], v0: number, v1: number): P2[] {
  const clipHalf = (src: P2[], limit: number, keepAbove: boolean): P2[] => {
    const out: P2[] = []
    for (let i = 0; i < src.length; i++) {
      const p = src[i]
      const q = src[(i + 1) % src.length]
      const pin = keepAbove ? p[1] >= limit : p[1] <= limit
      const qin = keepAbove ? q[1] >= limit : q[1] <= limit
      if (pin) out.push(p)
      if (pin !== qin) {
        const t = (limit - p[1]) / (q[1] - p[1])
        out.push([p[0] + (q[0] - p[0]) * t, limit])
      }
    }
    return out
  }
  let res = clipHalf(poly, v0, true)
  if (res.length >= 3) res = clipHalf(res, v1, false)
  // drop consecutive duplicates produced by the clipping
  const clean: P2[] = []
  for (const p of res) {
    const l = clean[clean.length - 1]
    if (!l || Math.abs(l[0] - p[0]) > 1e-7 || Math.abs(l[1] - p[1]) > 1e-7) clean.push(p)
  }
  return clean.length >= 3 ? clean : []
}

// ───────────────────────────── profile sweep (skirting, cornice) ─────────────────────────────

export interface SweepOptions {
  /** world-space path on the XZ plane (x, z) in metres */
  path: P2[]
  closed: boolean
  /** closed profile polygon: [offset from the path towards `side`, height] in metres */
  profile: P2[]
  /** +1 → profile offset goes to the left normal (-dz, dx) of the path direction, -1 → the other side */
  side: 1 | -1
  /** y added to every profile height */
  baseY: number
  /** omit the last (closing) profile edge — the face hidden against the wall */
  skipClosingEdge?: boolean
}

/**
 * Sweeps a profile along a polyline with mitred corners (no Frenet twisting).
 * U = distance along the path in metres, V = arc length along the profile.
 */
export function sweepProfile(gb: GeoBuilder, o: SweepOptions): void {
  const pts: P2[] = []
  for (const p of o.path) {
    const l = pts[pts.length - 1]
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-5) pts.push(p)
  }
  if (o.closed && pts.length > 2) {
    const f = pts[0]
    const l = pts[pts.length - 1]
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-5) pts.pop()
  }
  const n = pts.length
  if (n < 2 || (o.closed && n < 3)) return
  const segCount = o.closed ? n : n - 1
  const dirs: P2[] = []
  const nors: P2[] = []
  for (let i = 0; i < segCount; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
    const d: P2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len]
    dirs.push(d)
    nors.push([-d[1] * o.side, d[0] * o.side])
  }
  // mitre vector per vertex
  const mitre: P2[] = []
  for (let i = 0; i < n; i++) {
    const prev = o.closed ? (i - 1 + segCount) % segCount : i - 1
    const next = o.closed ? i % segCount : i
    const n0 = prev >= 0 && prev < segCount ? nors[prev] : null
    const n1 = next >= 0 && next < segCount ? nors[next] : null
    if (n0 && n1) {
      const k = 1 + n0[0] * n1[0] + n0[1] * n1[1]
      if (k < 0.08) mitre.push(n1)
      else mitre.push([(n0[0] + n1[0]) / k, (n0[1] + n1[1]) / k])
    } else mitre.push((n0 ?? n1) as P2)
  }
  // profile bookkeeping
  const prof = o.profile
  const pc: P2 = [0, 0]
  for (const q of prof) {
    pc[0] += q[0] / prof.length
    pc[1] += q[1] / prof.length
  }
  const arc: number[] = [0]
  for (let k = 0; k < prof.length; k++) {
    const q = prof[k]
    const r = prof[(k + 1) % prof.length]
    arc.push(arc[k] + Math.hypot(r[0] - q[0], r[1] - q[1]))
  }
  const edgeCount = o.skipClosingEdge ? prof.length - 1 : prof.length
  const at = (i: number, q: P2): THREE.Vector3 =>
    new THREE.Vector3(pts[i][0] + mitre[i][0] * q[0], o.baseY + q[1], pts[i][1] + mitre[i][1] * q[0])

  let run = 0
  for (let s = 0; s < segCount; s++) {
    const i0 = s
    const i1 = (s + 1) % n
    const segLen = Math.hypot(pts[i1][0] - pts[i0][0], pts[i1][1] - pts[i0][1])
    for (let k = 0; k < edgeCount; k++) {
      const q = prof[k]
      const r = prof[(k + 1) % prof.length]
      // outward normal of the profile edge (away from the profile centroid)
      let ex = r[1] - q[1]
      let ey = -(r[0] - q[0])
      const mx = (q[0] + r[0]) / 2 - pc[0]
      const my = (q[1] + r[1]) / 2 - pc[1]
      if (ex * mx + ey * my < 0) {
        ex = -ex
        ey = -ey
      }
      const el = Math.hypot(ex, ey) || 1
      const normal = new THREE.Vector3((nors[s][0] * ex) / el, ey / el, (nors[s][1] * ex) / el)
      gb.addQuad(
        at(i0, q),
        at(i1, q),
        at(i1, r),
        at(i0, r),
        normal,
        [run, arc[k]],
        [run + segLen, arc[k]],
        [run + segLen, arc[k + 1]],
        [run, arc[k + 1]],
      )
    }
    run += segLen
  }
  if (!o.closed) {
    const cap = (i: number, d: P2, sign: number): void => {
      const p3 = prof.map((q) => at(i, q))
      gb.addPolygon(p3, prof.map((q) => [q[0], q[1]] as P2), new THREE.Vector3(d[0] * sign, 0, d[1] * sign))
    }
    cap(0, dirs[0], -1)
    cap(n - 1, dirs[segCount - 1], 1)
  }
}

// ───────────────────────────── misc ─────────────────────────────

/**
 * tells the renderer that every object below `root` is gone for good: the WebGPU renderer keeps a
 * render object (pipeline state, uniform buffers) per drawn object until the object, its geometry or
 * its material is disposed — a mesh sharing a cached geometry and a library material would otherwise
 * keep its own for the whole session
 */
export function releaseObjects(root: THREE.Object3D): void {
  root.traverse((o) => void o.dispatchEvent({ type: 'dispose' } as never))
}

/** disposes every geometry below `root` (materials and textures belong to the MaterialLibrary) and releases its objects */
export function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (g && typeof g.dispose === 'function' && !g.userData.shared) g.dispose()
  })
  releaseObjects(root)
}

/** marks every mesh below `root` as shadow caster / receiver and stamps `ref` where missing */
export function stampRef(root: THREE.Object3D, ref: EntityRef, shadows = true): void {
  root.traverse((o) => {
    if (!o.userData.ref) o.userData.ref = ref
    const mesh = o as THREE.Mesh
    if (shadows && mesh.isMesh) {
      const mat = mesh.material as THREE.Material & { transmission?: number; opacity?: number }
      const seeThrough = !Array.isArray(mat) && mat && ((mat.transmission ?? 0) > 0.3 || (mat.transparent && (mat.opacity ?? 1) < 0.6))
      mesh.castShadow = !seeThrough
      mesh.receiveShadow = true
    }
  })
}
