/**
 * Light-map layout of the plan's built surfaces (walls, floors, ceilings, openings): each mesh is
 * split into flat charts (connected triangles facing the same way), every chart is laid flat in its
 * own plane at a fixed density (texels per metre) and the charts are packed into one square page
 * with a gap between them, so a texel never takes light from a neighbouring chart.
 *
 * Pure arithmetic on world-space triangles: the editor runs it to bake, the published viewer runs it
 * again on the same geometry (built from the same plan) to read the baked page, so no UVs have to be
 * published. A fingerprint of each mesh's triangles tells the viewer the geometry is the same.
 */
import { potpack } from 'three/addons/libs/potpack.module.js'

type V3 = [number, number, number]

export interface UnwrapMesh {
  key: string
  /** world-space triangles, 9 numbers each (non-indexed) */
  positions: Float32Array
}

export interface Chart {
  /** index of the mesh in the input */
  mesh: number
  /** triangle indices of the mesh */
  tris: number[]
  /** plane basis: u, v along the surface, n its normal (outward as the triangles face) */
  u: V3
  v: V3
  n: V3
  /** chart-plane coordinates of the texel area's corner, metres */
  minU: number
  minV: number
  /** placement in the page, texels, gap included */
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  /** page side, texels */
  size: number
  /** texels per metre */
  density: number
  /** gap around each chart, texels */
  pad: number
  charts: Chart[]
  /** per mesh, 6 numbers per triangle: the light-map UV of each corner (v up, image row 0 at v = 1) */
  uv: Float32Array[]
}

export interface UnwrapOptions {
  /** wanted texels per metre (lowered when the page would be too large) */
  density?: number
  /** largest page side */
  maxSize?: number
  /** smallest page side */
  minSize?: number
  /** gap around each chart, texels */
  pad?: number
}

/** triangles whose normals differ by more than this start a new chart */
const CHART_COS = Math.cos((12 * Math.PI) / 180)

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

function corner(p: Float32Array, t: number, c: number): V3 {
  const o = t * 9 + c * 3
  return [p[o], p[o + 1], p[o + 2]]
}

/** unnormalised face normal (twice the area) */
function faceCross(p: Float32Array, t: number): V3 {
  const a = corner(p, t, 0)
  return cross(sub(corner(p, t, 1), a), sub(corner(p, t, 2), a))
}

/** a basis in the plane of n: u level (horizontal) where possible, so wall charts lie straight */
export function planeBasis(n: V3): { u: V3; v: V3 } {
  const up: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]
  const u = norm(cross(up, n))
  return { u, v: cross(n, u) }
}

/** quantised corner (0.1 mm): corners of neighbouring triangles meet even without shared vertices */
const qkey = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`

/** connected triangles facing the same way, in a fixed order */
function chartsOf(p: Float32Array, mesh: number): Omit<Chart, 'minU' | 'minV' | 'x' | 'y' | 'w' | 'h'>[] {
  const count = p.length / 9
  const normals: V3[] = []
  const live: boolean[] = []
  const byEdge = new Map<string, number[]>()
  const keys: string[][] = []
  for (let t = 0; t < count; t++) {
    const c = faceCross(p, t)
    const area = Math.hypot(c[0], c[1], c[2])
    live.push(area > 1e-9)
    normals.push(norm(c))
    const k = [0, 1, 2].map((i) => qkey(p[t * 9 + i * 3], p[t * 9 + i * 3 + 1], p[t * 9 + i * 3 + 2]))
    keys.push(k)
    if (!live[t]) continue
    for (let e = 0; e < 3; e++) {
      const a = k[e]
      const b = k[(e + 1) % 3]
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`
      let list = byEdge.get(ek)
      if (!list) byEdge.set(ek, (list = []))
      list.push(t)
    }
  }
  const owner = new Int32Array(count).fill(-1)
  const charts: Omit<Chart, 'minU' | 'minV' | 'x' | 'y' | 'w' | 'h'>[] = []
  for (let seed = 0; seed < count; seed++) {
    if (owner[seed] !== -1 || !live[seed]) continue
    const n = normals[seed]
    const id = charts.length
    const tris: number[] = []
    const stack = [seed]
    owner[seed] = id
    while (stack.length) {
      const t = stack.pop() as number
      tris.push(t)
      const k = keys[t]
      for (let e = 0; e < 3; e++) {
        const a = k[e]
        const b = k[(e + 1) % 3]
        for (const o of byEdge.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? []) {
          if (owner[o] !== -1 || dot(normals[o], n) < CHART_COS) continue
          owner[o] = id
          stack.push(o)
        }
      }
    }
    tris.sort((a, b) => a - b)
    const { u, v } = planeBasis(n)
    charts.push({ mesh, tris, u, v, n })
  }
  return charts
}

/** chart extent in its plane, metres */
function extent(p: Float32Array, c: { tris: number[]; u: V3; v: V3 }) {
  let minU = Infinity
  let minV = Infinity
  let maxU = -Infinity
  let maxV = -Infinity
  for (const t of c.tris)
    for (let i = 0; i < 3; i++) {
      const q = corner(p, t, i)
      const a = dot(q, c.u)
      const b = dot(q, c.v)
      if (a < minU) minU = a
      if (a > maxU) maxU = a
      if (b < minV) minV = b
      if (b > maxV) maxV = b
    }
  return { minU, minV, sizeU: maxU - minU, sizeV: maxV - minV }
}

export function unwrap(meshes: UnwrapMesh[], opts: UnwrapOptions = {}): Layout {
  const maxSize = opts.maxSize ?? 2048
  const minSize = opts.minSize ?? 256
  const pad = opts.pad ?? 2
  const raw = meshes.flatMap((m, i) => chartsOf(m.positions, i).map((c) => ({ ...c, ...extent(m.positions, c) })))
  let density = opts.density ?? 20
  let placed: Chart[] = []
  let size = minSize
  for (let attempt = 0; attempt < 40; attempt++) {
    const boxes = raw.map((c, i) => ({
      i,
      w: Math.max(1, Math.ceil(c.sizeU * density - 1e-3)) + 2 * pad,
      h: Math.max(1, Math.ceil(c.sizeV * density - 1e-3)) + 2 * pad,
      x: 0,
      y: 0,
    }))
    const { w, h } = boxes.length ? potpack(boxes) : { w: 1, h: 1 }
    const need = Math.max(w, h)
    if (need <= maxSize) {
      while (size < need) size *= 2
      boxes.sort((a, b) => a.i - b.i)
      placed = boxes.map((b) => {
        const c = raw[b.i]
        return { mesh: c.mesh, tris: c.tris, u: c.u, v: c.v, n: c.n, minU: c.minU, minV: c.minV, x: b.x, y: b.y, w: b.w, h: b.h }
      })
      break
    }
    density *= 0.85
  }
  const uv = meshes.map((m) => new Float32Array((m.positions.length / 9) * 6))
  for (const c of placed) {
    const p = meshes[c.mesh].positions
    const out = uv[c.mesh]
    for (const t of c.tris)
      for (let i = 0; i < 3; i++) {
        const q = corner(p, t, i)
        const tx = c.x + pad + (dot(q, c.u) - c.minU) * density
        const ty = c.y + pad + (dot(q, c.v) - c.minV) * density
        out[t * 6 + i * 2] = tx / size
        out[t * 6 + i * 2 + 1] = 1 - ty / size
      }
  }
  return { size, density, pad, charts: placed, uv }
}

/** what the viewer needs to lay the page out again the same way */
export interface BakeLayoutOptions {
  density: number
  maxSize: number
  minSize: number
  pad: number
}

export const DEFAULT_LAYOUT: BakeLayoutOptions = { density: 20, maxSize: 2048, minSize: 256, pad: 2 }

export function layoutOf(meshes: UnwrapMesh[], o: BakeLayoutOptions = DEFAULT_LAYOUT): Layout {
  return unwrap(meshes, { density: o.density, maxSize: o.maxSize, minSize: o.minSize, pad: o.pad })
}

/** a short hash of where the charts went: the viewer's layout must give the same */
export function layoutHash(l: Layout): string {
  let h = 0x811c9dc5
  const mix = (v: number) => {
    h ^= v
    h = Math.imul(h, 0x01000193)
  }
  mix(l.size)
  for (const c of l.charts) {
    mix(c.mesh)
    mix(c.x)
    mix(c.y)
    mix(c.w)
    mix(c.h)
  }
  return `${l.charts.length}:${(h >>> 0).toString(36)}`
}

/** the triangles of a mesh as numbers that compare equal across machines (0.1 mm grid), hashed */
export function fingerprint(positions: Float32Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < positions.length; i++) {
    const v = Math.round(positions[i] * 1e4) | 0
    h ^= v & 0xffff
    h = Math.imul(h, 0x01000193)
    h ^= v >>> 16
    h = Math.imul(h, 0x01000193)
  }
  return `${positions.length / 9}:${(h >>> 0).toString(36)}`
}

export interface Texels {
  /** 6 numbers per texel: world position, normal */
  points: Float32Array
  /** texel index in the page (row * size + column) */
  index: Int32Array
  /** chart of each texel */
  chart: Int32Array
}

/**
 * The texels the charts cover, each with the surface point and normal it stands for. A texel whose
 * centre falls just outside the chart's triangles (an edge) takes the nearest point on them, so the
 * edges of a surface are lit, not left to be filled in.
 */
export function texelsOf(meshes: UnwrapMesh[], layout: Layout): Texels {
  const pts: number[] = []
  const idx: number[] = []
  const chartOf: number[] = []
  const { size, density, pad } = layout
  layout.charts.forEach((c, ci) => {
    const p = meshes[c.mesh].positions
    // the chart's triangles in its plane (texel units, page coordinates)
    const tri2 = c.tris.map((t) => {
      const q = [0, 1, 2].map((i) => corner(p, t, i))
      const xy = q.map((w) => [c.x + pad + (dot(w, c.u) - c.minU) * density, c.y + pad + (dot(w, c.v) - c.minV) * density])
      return { q, xy, n: norm(faceCross(p, t)) }
    })
    for (let ty = c.y; ty < c.y + c.h; ty++)
      for (let tx = c.x; tx < c.x + c.w; tx++) {
        const px = tx + 0.5
        const py = ty + 0.5
        let best: { d: number; q: V3; n: V3 } | null = null
        for (const t of tri2) {
          const r = closestBary(px, py, t.xy)
          if (r.d > 0.75 || (best && r.d >= best.d)) continue
          const q = t.q
          best = {
            d: r.d,
            n: t.n,
            q: [q[0][0] * r.a + q[1][0] * r.b + q[2][0] * r.c, q[0][1] * r.a + q[1][1] * r.b + q[2][1] * r.c, q[0][2] * r.a + q[1][2] * r.b + q[2][2] * r.c],
          }
          if (r.d === 0) break
        }
        if (!best) continue
        pts.push(best.q[0], best.q[1], best.q[2], best.n[0], best.n[1], best.n[2])
        idx.push(ty * size + tx)
        chartOf.push(ci)
      }
  })
  return { points: new Float32Array(pts), index: new Int32Array(idx), chart: new Int32Array(chartOf) }
}

/** barycentric weights of the point of a 2D triangle nearest to (x, y), and its distance */
function closestBary(x: number, y: number, t: number[][]): { a: number; b: number; c: number; d: number } {
  const [ax, ay] = t[0]
  const [bx, by] = t[1]
  const [cx, cy] = t[2]
  const v0x = bx - ax
  const v0y = by - ay
  const v1x = cx - ax
  const v1y = cy - ay
  const v2x = x - ax
  const v2y = y - ay
  const den = v0x * v1y - v1x * v0y
  if (Math.abs(den) > 1e-12) {
    const b = (v2x * v1y - v1x * v2y) / den
    const c = (v0x * v2y - v2x * v0y) / den
    const a = 1 - b - c
    if (a >= 0 && b >= 0 && c >= 0) return { a, b, c, d: 0 }
  }
  // outside: the nearest point on the three edges
  let best = { a: 1, b: 0, c: 0, d: Math.hypot(x - ax, y - ay) }
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 0],
  ]
  for (const [i, j] of edges) {
    const [px, py] = t[i]
    const [qx, qy] = t[j]
    const ex = qx - px
    const ey = qy - py
    const l2 = ex * ex + ey * ey
    const s = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - px) * ex + (y - py) * ey) / l2)) : 0
    const d = Math.hypot(px + ex * s - x, py + ey * s - y)
    if (d < best.d) {
      const w = [0, 0, 0]
      w[i] = 1 - s
      w[j] = s
      best = { a: w[0], b: w[1], c: w[2], d }
    }
  }
  return best
}
