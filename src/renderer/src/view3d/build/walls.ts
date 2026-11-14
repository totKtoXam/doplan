/**
 * Wall meshes from the core's mitred WallGeom outlines (the 3D never re-mitres).
 *
 * Per wall:
 *  - one mesh per side and finish material: the elevation of the face in wall-local metres
 *    (u along the face, v above the floor) with the openings cut out, split into horizontal
 *    finish bands (FinishZone). UV = (u, v) in metres.
 *  - reveals inside every opening (jambs, head, sill, arch intrados), split at the wall axis so
 *    each half takes the finish of its side; a floor strip under openings that reach the floor
 *  - top cap and end caps
 *  - `glazing` walls: aluminium frame with mullions and glass, `parapet`: a low solid wall
 */
import * as THREE from 'three'
import { DEFAULT_MATERIALS } from '@core'
import type { EntityRef, FinishZone, Id, Opening, SurfaceFinish, TilePattern, Vec2, Wall, WallGeom, WallSide } from '@core/types'
import type { MaterialLibraryEx } from '../materials'
import { type Hole, archPoints, openingHoles } from './holes'
import { GeoBuilder, MM, type P2, clipBand, dir3, distToSegment, signedArea, w3 } from './util'

export interface WallInput {
  wall: Wall
  geom: WallGeom
  openings: Opening[]
  /** effective height in mm — the cut-away height when `lowered` */
  heightMm: number
  lowered: boolean
  /** floor finish continued under openings that reach the floor */
  threshold: SurfaceFinish | Id | null
}

interface Band {
  y0: number
  y1: number
  materialId: Id
  /**
   * height range (mm) the paint tool should target when this band is clicked:
   * the FinishZone it comes from, or the band itself when the side has zones elsewhere;
   * undefined when the side is one uniform finish
   */
  zone?: { from: number; to: number }
  /** laying pattern of the band (zone's, else the side's); undefined = the material's own */
  pattern?: TilePattern
  key: string
}

const CUT_COLOR = '#3f4247'
const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

function computeBands(side: WallSide, H: number): Band[] {
  const zones = (side.zones ?? []).filter((z) => z.to > z.from)
  const cuts = new Set<number>([0, H])
  for (const z of zones) {
    cuts.add(Math.max(0, Math.min(H, z.from)))
    cuts.add(Math.max(0, Math.min(H, z.to)))
  }
  const ys = Array.from(cuts).sort((a, b) => a - b)
  const bands: Band[] = []
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i]
    const y1 = ys[i + 1]
    if (y1 - y0 < 0.05) continue
    const mid = (y0 + y1) / 2
    let materialId = side.materialId
    let pattern = side.pattern
    let zone: FinishZone | null = null
    for (const z of zones) {
      if (z.from <= mid && z.to >= mid) {
        materialId = z.materialId
        pattern = z.pattern
        zone = z
      }
    }
    const last = bands[bands.length - 1]
    const lastZone = last?.zone && last.key.startsWith('z') ? last.zone : null
    const sameSource = zone ? lastZone && lastZone.from === zone.from && lastZone.to === zone.to : last && !last.key.startsWith('z')
    if (last && sameSource && last.materialId === materialId && last.pattern === pattern && Math.abs(last.y1 - y0) < 0.05) {
      last.y1 = y1
      if (!zone && last.zone) last.zone = { from: last.zone.from, to: y1 }
    } else {
      bands.push({
        y0,
        y1,
        materialId,
        pattern,
        zone: zone ? { from: zone.from, to: zone.to } : zones.length ? { from: y0, to: y1 } : undefined,
        key: zone ? `z${zone.from}:${zone.to}` : `b${y0}`,
      })
    }
  }
  return bands
}

/** complement of the union of [a, b] intervals inside [0, H] */
function solids(intervals: P2[], H: number): P2[] {
  const sorted = intervals
    .map((i) => [Math.max(0, i[0]), Math.min(H, i[1])] as P2)
    .filter((i) => i[1] > i[0])
    .sort((a, b) => a[0] - b[0])
  const out: P2[] = []
  let cursor = 0
  for (const [a, b] of sorted) {
    if (a > cursor + 0.05) out.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (H > cursor + 0.05) out.push([cursor, H])
  return out
}

export function buildWall(input: WallInput, lib: MaterialLibraryEx): THREE.Group {
  const { wall, geom } = input
  const ref: EntityRef = { kind: 'wall', id: wall.id }
  const group = new THREE.Group()
  group.name = `wall:${wall.id}`
  group.userData.ref = ref
  const H = Math.max(0, input.heightMm)
  const L = geom.length
  if (wall.kind === 'virtual' || L < 1 || H < 1) return group

  const a = geom.a
  const dx = (geom.b.x - a.x) / L
  const dy = (geom.b.y - a.y) / L
  // left normal in plan space (y down): (dy, -dx)
  const nlx = dy
  const nly = -dx
  const holes: Hole[] = input.openings.flatMap((o) => openingHoles(o, L, H))
  const add = (mesh: THREE.Mesh | null): void => {
    if (mesh) group.add(mesh)
  }

  if (wall.kind === 'glazing') {
    buildGlazing(group, input, holes, lib, ref)
    return group
  }

  const offsetOf = (p: Vec2): number => (p.x - a.x) * nlx + (p.y - a.y) * nly
  const oL = offsetOf(geom.left[0])
  const oR = offsetOf(geom.right[0])

  // ── faces ──
  for (const side of ['left', 'right'] as const) {
    const [p0, p1] = geom[side]
    const fl = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    if (fl < 1) continue
    const fdx = (p1.x - p0.x) / fl
    const fdy = (p1.y - p0.y) / fl
    const sign = fdx * dx + fdy * dy >= 0 ? 1 : -1
    const sOff = (p0.x - a.x) * dx + (p0.y - a.y) * dy
    const toF = (s: number): number => (s - sOff) * sign
    const off = side === 'left' ? oL : oR
    const ns = Math.abs(off) > 1e-6 ? Math.sign(off) : side === 'left' ? 1 : -1
    const normal = dir3(nlx * ns, nly * ns)
    // bands span the full wall height so that a lowered (cut-away) face reports the real zone ranges
    const bands = computeBands(wall[side], Math.max(H, wall.height))
    // one mesh per finish band, so that every band takes its own material and reports its zone
    const builders = new Map<string, { band: Band; gb: GeoBuilder }>()
    const builderFor = (band: Band): GeoBuilder => {
      let b = builders.get(band.key)
      if (!b) {
        b = { band, gb: new GeoBuilder() }
        builders.set(band.key, b)
      }
      return b.gb
    }
    const P = (f: number, v: number): THREE.Vector3 => w3(p0.x + fdx * f, p0.y + fdy * f, v)
    const fh = holes
      .map((h) => {
        const f0 = Math.max(0, Math.min(fl, Math.min(toF(h.s0), toF(h.s1))))
        const f1 = Math.max(0, Math.min(fl, Math.max(toF(h.s0), toF(h.s1))))
        return { f0, f1, h }
      })
      .filter((x) => x.f1 - x.f0 > 0.5)
    const cuts = new Set<number>([0, fl])
    for (const x of fh) {
      cuts.add(x.f0)
      cuts.add(x.f1)
    }
    const cs = Array.from(cuts).sort((p, q) => p - q)
    for (let i = 0; i + 1 < cs.length; i++) {
      const c0 = cs[i]
      const c1 = cs[i + 1]
      if (c1 - c0 < 0.05) continue
      const mid = (c0 + c1) / 2
      const active = fh.filter((x) => x.f0 <= mid && x.f1 >= mid)
      for (const [y0, y1] of solids(active.map((x) => [x.h.v0, x.h.v1] as P2), H)) {
        for (const band of bands) {
          const lo = Math.max(y0, band.y0)
          const hi = Math.min(y1, band.y1)
          if (hi - lo < 0.05) continue
          builderFor(band).addQuad(
            P(c0, lo),
            P(c1, lo),
            P(c1, hi),
            P(c0, hi),
            normal,
            [c0 * MM, lo * MM],
            [c1 * MM, lo * MM],
            [c1 * MM, hi * MM],
            [c0 * MM, hi * MM],
          )
        }
      }
      // spandrels of an arched head
      const only = active.length === 1 ? active[0] : null
      if (only && only.h.arch && Math.abs(only.f0 - c0) < 0.1 && Math.abs(only.f1 - c1) < 0.1) {
        const top = only.h.v1
        const spring = top - only.h.arch.rise
        const arc = archPoints(c0, c1, top, only.h.arch.rise, 16)
        const half = arc.length >> 1 // index of the crown
        const leftPoly: P2[] = [[c0, spring], ...arc.slice(0, half + 1), [c0, top]]
        const rightPoly: P2[] = [...arc.slice(half), [c1, spring], [c1, top]]
        for (const poly of [leftPoly, rightPoly]) {
          for (const band of bands) {
            const clipped = clipBand(poly, band.y0, band.y1)
            if (clipped.length < 3) continue
            builderFor(band).addPolygon(
              clipped.map((p) => P(p[0], p[1])),
              clipped.map((p) => [p[0] * MM, p[1] * MM] as P2),
              normal,
            )
          }
        }
      }
    }
    for (const { band, gb } of builders.values()) {
      const extra: Record<string, unknown> = { side, materialId: band.materialId, part: 'face' }
      if (band.zone) extra.zone = { from: band.zone.from, to: band.zone.to }
      add(gb.mesh(lib.get(band.pattern ? { materialId: band.materialId, pattern: band.pattern } : band.materialId), ref, extra))
    }
  }

  // ── caps ──
  const poly = geom.polygon
  if (poly.length >= 3) {
    const cap = new GeoBuilder()
    cap.addPolygon(
      poly.map((p) => w3(p.x, p.y, H)),
      poly.map((p) => [p.x * MM, p.y * MM] as P2),
      UP,
    )
    const capMat = input.lowered ? lib.plain({ color: CUT_COLOR, roughness: 0.9 }) : lib.get(wall.left.materialId)
    add(cap.mesh(capMat, ref, { part: 'cap' }))

    const ends = new GeoBuilder()
    const orient = signedArea(poly) >= 0 ? 1 : -1
    const onFace = (p: Vec2, q: Vec2, f: [Vec2, Vec2]): boolean => distToSegment(p, f[0], f[1]) < 0.6 && distToSegment(q, f[0], f[1]) < 0.6
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const el = Math.hypot(q.x - p.x, q.y - p.y)
      if (el < 0.6) continue
      if (onFace(p, q, geom.left) || onFace(p, q, geom.right)) continue
      const ex = (q.x - p.x) / el
      const ey = (q.y - p.y) / el
      ends.addQuad(
        w3(p.x, p.y, 0),
        w3(q.x, q.y, 0),
        w3(q.x, q.y, H),
        w3(p.x, p.y, H),
        dir3(ey * orient, -ex * orient),
        [0, 0],
        [el * MM, 0],
        [el * MM, H * MM],
        [0, H * MM],
      )
    }
    add(ends.mesh(lib.get(wall.left.materialId), ref, { part: 'end', side: 'left', materialId: wall.left.materialId }))
  }

  // ── reveals ──
  const P3 = (s: number, off: number, v: number): THREE.Vector3 => w3(a.x + dx * s + nlx * off, a.y + dy * s + nly * off, v)
  const along = dir3(dx, dy)
  const back = along.clone().negate()
  const reveal = { left: new GeoBuilder(), right: new GeoBuilder() }
  const floor = new GeoBuilder()
  const halves: { side: 'left' | 'right'; o0: number; o1: number }[] =
    oL * oR < 0
      ? [
          { side: 'left', o0: oL, o1: 0 },
          { side: 'right', o0: 0, o1: oR },
        ]
      : [{ side: 'left', o0: oL, o1: oR }]
  for (const h of holes) {
    for (const half of halves) {
      const gb = reveal[half.side]
      const { o0, o1 } = half
      const d = Math.abs(o1 - o0) * MM
      const jamb = (s: number, range: [number, number] | null, n: THREE.Vector3): void => {
        if (!range || range[1] - range[0] < 0.5) return
        gb.addQuad(
          P3(s, o0, range[0]),
          P3(s, o1, range[0]),
          P3(s, o1, range[1]),
          P3(s, o0, range[1]),
          n,
          [0, range[0] * MM],
          [d, range[0] * MM],
          [d, range[1] * MM],
          [0, range[1] * MM],
        )
      }
      jamb(h.s0, h.jamb0, along)
      jamb(h.s1, h.jamb1, back)
      const flat = (v: number, n: THREE.Vector3): void => {
        gb.addQuad(
          P3(h.s0, o0, v),
          P3(h.s1, o0, v),
          P3(h.s1, o1, v),
          P3(h.s0, o1, v),
          n,
          [h.s0 * MM, 0],
          [h.s1 * MM, 0],
          [h.s1 * MM, d],
          [h.s0 * MM, d],
        )
      }
      if (h.head) flat(h.v1, DOWN)
      if (h.sill) flat(h.v0, UP)
      if (h.arch) {
        const spring = h.v1 - h.arch.rise
        const w = h.s1 - h.s0
        const r = (w * w) / 4 / (2 * h.arch.rise) + h.arch.rise / 2
        const cx = (h.s0 + h.s1) / 2
        const cy = h.v1 - r
        const arc: P2[] = [[h.s0, spring], ...archPoints(h.s0, h.s1, h.v1, h.arch.rise, 16), [h.s1, spring]]
        let run = 0
        for (let k = 0; k + 1 < arc.length; k++) {
          const p = arc[k]
          const q = arc[k + 1]
          const seg = Math.hypot(q[0] - p[0], q[1] - p[1])
          const mx = cx - (p[0] + q[0]) / 2
          const my = cy - (p[1] + q[1]) / 2
          const ml = Math.hypot(mx, my) || 1
          const n = along.clone().multiplyScalar(mx / ml).addScaledVector(UP, my / ml).normalize()
          gb.addQuad(
            P3(p[0], o0, p[1]),
            P3(q[0], o0, q[1]),
            P3(q[0], o1, q[1]),
            P3(p[0], o1, p[1]),
            n,
            [run * MM, 0],
            [(run + seg) * MM, 0],
            [(run + seg) * MM, d],
            [run * MM, d],
          )
          run += seg
        }
      }
    }
    if (!h.sill && input.threshold) {
      const c = [P3(h.s0, oL, 0), P3(h.s1, oL, 0), P3(h.s1, oR, 0), P3(h.s0, oR, 0)]
      floor.addQuad(c[0], c[1], c[2], c[3], UP, [c[0].x, c[0].z], [c[1].x, c[1].z], [c[2].x, c[2].z], [c[3].x, c[3].z])
    }
  }
  add(reveal.left.mesh(lib.get(wall.left.materialId), ref, { side: 'left', materialId: wall.left.materialId, part: 'reveal' }))
  add(reveal.right.mesh(lib.get(wall.right.materialId), ref, { side: 'right', materialId: wall.right.materialId, part: 'reveal' }))
  if (input.threshold) add(floor.mesh(lib.get(input.threshold), ref, { part: 'threshold' }))
  return group
}

// ───────────────────────────── glazing walls ─────────────────────────────

function buildGlazing(group: THREE.Group, input: WallInput, holes: Hole[], lib: MaterialLibraryEx, ref: EntityRef): void {
  const { wall, geom } = input
  const H = input.heightMm * MM
  const L = geom.length * MM
  const dx = (geom.b.x - geom.a.x) / geom.length
  const dy = (geom.b.y - geom.a.y) / geom.length
  const X = dir3(dx, dy)
  const Z = new THREE.Vector3().crossVectors(X, UP)
  const m = new THREE.Matrix4().makeBasis(X, UP, Z).setPosition(w3(geom.a.x, geom.a.y, 0))
  const frame = new GeoBuilder()
  const glass = new GeoBuilder()
  const fw = 0.05
  const fd = Math.max(0.04, Math.min(0.07, wall.thickness * MM || 0.06))
  const z0 = -fd / 2
  const z1 = fd / 2

  /** one glazed bay: perimeter frame, mullions, optional handrail transom, glass */
  const bay = (x0: number, x1: number, y0: number, y1: number): void => {
    const w = x1 - x0
    const h = y1 - y0
    if (w < 0.04 || h < 0.04) return
    if (w < fw * 2.5 || h < fw * 2.5) {
      frame.addBox(x0, y0, z0, x1, y1, z1, m)
      return
    }
    frame.addBox(x0, y0, z0, x1, y0 + fw, z1, m)
    frame.addBox(x0, y1 - fw, z0, x1, y1, z1, m)
    frame.addBox(x0, y0 + fw, z0, x0 + fw, y1 - fw, z1, m)
    frame.addBox(x1 - fw, y0 + fw, z0, x1, y1 - fw, z1, m)
    const n = Math.max(1, Math.round(w / 0.8))
    const mw = 0.04
    for (let i = 1; i < n; i++) {
      const x = x0 + (w * i) / n
      frame.addBox(x - mw / 2, y0 + fw, z0, x + mw / 2, y1 - fw, z1, m)
    }
    if (y0 < 0.9 && y1 > 1.9) frame.addBox(x0 + fw, 1.0 - mw / 2, z0, x1 - fw, 1.0 + mw / 2, z1, m)
    glass.addBox(x0 + fw * 0.5, y0 + fw * 0.5, -0.004, x1 - fw * 0.5, y1 - fw * 0.5, 0.004, m)
  }

  const cuts = new Set<number>([0, L])
  const hs = holes.map((h) => ({ x0: h.s0 * MM, x1: h.s1 * MM, y0: h.v0 * MM, y1: h.v1 * MM }))
  for (const h of hs) {
    cuts.add(h.x0)
    cuts.add(h.x1)
  }
  const cs = Array.from(cuts).sort((p, q) => p - q)
  for (let i = 0; i + 1 < cs.length; i++) {
    const c0 = cs[i]
    const c1 = cs[i + 1]
    if (c1 - c0 < 0.001) continue
    const mid = (c0 + c1) / 2
    const active = hs.filter((h) => h.x0 <= mid && h.x1 >= mid)
    for (const [y0, y1] of solids(active.map((h) => [h.y0, h.y1] as P2), H)) bay(c0, c1, y0, y1)
  }
  const frameMat = lib.get(DEFAULT_MATERIALS.frame)
  const glassMat = lib.get(DEFAULT_MATERIALS.glass)
  const fm = frame.mesh(frameMat, ref, { part: 'glazingFrame' })
  if (fm) group.add(fm)
  const gm = glass.mesh(glassMat, ref, { part: 'glazing' })
  if (gm) {
    gm.castShadow = false
    group.add(gm)
  }
}
