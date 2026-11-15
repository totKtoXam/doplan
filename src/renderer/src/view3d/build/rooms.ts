/**
 * Floors, ceilings, cornices and skirting boards of one detected room.
 * Floors / ceilings are triangulated from the DerivedRoom polygon (+ holes) directly in world
 * metres; UV is in metres from a room corner along the room's walls (see roomUvFrame), so a laying
 * pattern and its «Начало раскладки» shift start at the corner.
 */
import * as THREE from 'three'
import { DEFAULT_MATERIALS } from '@core'
import type { DerivedRoom, EntityRef, Opening, Room, Vec2, Wall, WallGeom } from '@core/types'
import type { MaterialLibraryEx } from '../materials'
import { openingHoles, reachesFloor } from './holes'
import { roomUv, roomUvFrame, type RoomUvFrame } from './roomUv'
import { GeoBuilder, MM, type P2, insetPolygon, pointInPoly, scanIntervals, sweepProfile } from './util'

export interface RoomInput {
  room: DerivedRoom
  rec: Room
  /** ceiling height above the floor, mm */
  ceilingMm: number
  walls: Record<string, Wall>
  wallGeoms: Record<string, WallGeom>
  openingsByWall: Map<string, Opening[]>
}

export interface RoomBuild {
  group: THREE.Group
  /** everything that hides when the camera is above the ceiling */
  ceiling: THREE.Group
  floor: THREE.Mesh | null
  /** world Y of the lowest ceiling surface */
  ceilingY: number
}

const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

function flat(gb: GeoBuilder, poly: Vec2[], holes: Vec2[][], y: number, normal: THREE.Vector3, frame: RoomUvFrame): void {
  const p3 = (p: Vec2): THREE.Vector3 => new THREE.Vector3(p.x * MM, y, p.y * MM)
  const uv = (p: Vec2): P2 => roomUv(frame, p)
  gb.addPolygon(
    poly.map(p3),
    poly.map(uv),
    normal,
    holes.filter((h) => h.length >= 3).map((h) => ({ pts: h.map(p3), uv: h.map(uv) })),
  )
}

/** vertical faces along a closed loop between two heights, facing the loop interior */
function riser(gb: GeoBuilder, loop: Vec2[], y0: number, y1: number): void {
  let run = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]
    const q = loop[(i + 1) % loop.length]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len < 0.5) continue
    const ex = (q.x - p.x) / len
    const ey = (q.y - p.y) / len
    let nx = ey
    let ny = -ex
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    if (!pointInPoly(mx + nx * 5, my + ny * 5, loop)) {
      nx = -nx
      ny = -ny
    }
    const u0 = run * MM
    const u1 = (run + len) * MM
    gb.addQuad(
      new THREE.Vector3(p.x * MM, y0, p.y * MM),
      new THREE.Vector3(q.x * MM, y0, q.y * MM),
      new THREE.Vector3(q.x * MM, y1, q.y * MM),
      new THREE.Vector3(p.x * MM, y1, p.y * MM),
      new THREE.Vector3(nx, 0, ny),
      [u0, y0],
      [u1, y0],
      [u1, y1],
      [u0, y1],
    )
    run += len
  }
}

/** boxes along parallel lines clipped to the room polygon (beams, coffers) */
function beams(
  gb: GeoBuilder,
  poly: Vec2[],
  axis: 'x' | 'y',
  spacing: number,
  width: number,
  yTop: number,
  depth: number,
): void {
  let min = Infinity
  let max = -Infinity
  for (const p of poly) {
    const v = axis === 'x' ? p.x : p.y
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  const span = max - min
  const n = Math.max(1, Math.round(span / spacing) - 1)
  const step = span / (n + 1)
  for (let i = 1; i <= n; i++) {
    const c = min + step * i
    for (const [a, b] of scanIntervals(poly, axis, c)) {
      if (axis === 'x') gb.addBox((c - width / 2) * MM, yTop - depth, a * MM, (c + width / 2) * MM, yTop, b * MM)
      else gb.addBox(a * MM, yTop - depth, (c - width / 2) * MM, b * MM, yTop, (c + width / 2) * MM)
    }
  }
}

export function buildRoom(input: RoomInput, lib: MaterialLibraryEx): RoomBuild {
  const { room, rec } = input
  const ref: EntityRef = { kind: 'room', id: room.roomId }
  const group = new THREE.Group()
  group.name = `room:${room.roomId}`
  group.userData.ref = ref
  const ceiling = new THREE.Group()
  ceiling.name = 'ceiling'
  ceiling.userData.ref = ref
  ceiling.userData.surface = 'ceiling'
  group.add(ceiling)
  const poly = room.polygon
  const H = input.ceilingMm * MM
  let ceilingY = H
  if (poly.length < 3) return { group, ceiling, floor: null, ceilingY }

  const frame = roomUvFrame(poly)

  // ── floor ──
  const fb = new GeoBuilder()
  flat(fb, poly, room.holes, 0, UP, frame)
  const floor = fb.mesh(lib.get(rec.floor), ref, { surface: 'floor' })
  if (floor) group.add(floor)

  // ── ceiling ──
  const spec = rec.ceiling
  const addCeil = (gb: GeoBuilder, material: THREE.Material, extra?: Record<string, unknown>): void => {
    const mesh = gb.mesh(material, ref, { surface: 'ceiling', ...extra })
    if (mesh) ceiling.add(mesh)
  }
  const baseMat = spec.kind === 'stretch' ? lib.variant(spec, { roughness: 0.08, clearcoat: 1, metalness: 0 }) : lib.get(spec)
  let corniceY = H
  let done = false
  if (spec.kind === 'multilevel') {
    const bw = Math.max(100, spec.borderWidth ?? 400)
    const drop = Math.max(20, spec.borderDrop ?? 100) * MM
    const inner = insetPolygon(poly, bw)
    if (inner && inner.length >= 3) {
      const gb = new GeoBuilder()
      // lowered border ring, raised centre panel and the riser between them
      flat(gb, poly, [inner], H - drop, DOWN, frame)
      flat(
        gb,
        inner,
        room.holes.filter((h) => h.length >= 3 && pointInPoly(h[0].x, h[0].y, inner)),
        H,
        DOWN,
        frame,
      )
      riser(gb, inner, H - drop, H)
      addCeil(gb, baseMat)
      if (spec.coveLight) {
        const lip = insetPolygon(poly, bw + 3)
        if (lip && lip.length >= 3) {
          const strip = new GeoBuilder()
          const h = Math.min(0.03, drop * 0.45)
          riser(strip, lip, H - drop * 0.5 - h / 2, H - drop * 0.5 + h / 2)
          const led = strip.mesh(lib.plain({ color: '#fff4e0', emissive: '#ffdcae', emissiveIntensity: 6, roughness: 0.6 }), ref, {
            surface: 'ceiling',
            part: 'cove',
          })
          if (led) {
            led.castShadow = false
            ceiling.add(led)
          }
        }
      }
      ceilingY = H - drop
      corniceY = H - drop
      done = true
    }
  }
  if (!done) {
    const gb = new GeoBuilder()
    flat(gb, poly, room.holes, H, DOWN, frame)
    addCeil(gb, baseMat)
    if (spec.kind === 'coffered' || spec.kind === 'beams') {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const p of poly) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
      }
      const bb = new GeoBuilder()
      if (spec.kind === 'coffered') {
        beams(bb, poly, 'x', 900, 120, H, 0.1)
        beams(bb, poly, 'y', 900, 120, H, 0.1)
        addCeil(bb, lib.get(spec.materialId), { part: 'coffer' })
        ceilingY = H - 0.1
      } else {
        // beams span the shorter direction of the room
        const alongX = maxX - minX >= maxY - minY
        beams(bb, poly, alongX ? 'x' : 'y', 1000, 150, H, 0.18)
        addCeil(bb, lib.plain({ color: '#7a5536', roughness: 0.7 }), { part: 'beam' })
        ceilingY = H - 0.18
      }
    }
  }

  // ── cornice ──
  const c = (spec.cornice ?? 0) * MM
  if (c > 0.005) {
    const gb = new GeoBuilder()
    const side = interiorSide(poly)
    sweepProfile(gb, {
      path: poly.map((p) => [p.x * MM, p.y * MM] as P2),
      closed: true,
      side,
      baseY: corniceY,
      profile: [
        [0, 0],
        [c * 0.9, 0],
        [c * 0.9, -c * 0.14],
        [c * 0.58, -c * 0.3],
        [c * 0.32, -c * 0.6],
        [c * 0.13, -c * 0.86],
        [c * 0.13, -c],
        [0, -c],
      ],
    })
    addCeil(gb, lib.get(spec.materialId), { part: 'cornice' })
  }

  // ── skirting ──
  if (rec.skirting > 5) {
    const gb = new GeoBuilder()
    const h = rec.skirting * MM
    const t = 0.014
    const profile: P2[] = [
      [0, 0],
      [t, 0],
      [t, Math.max(h - 0.006, h * 0.6)],
      [t - 0.005, h],
      [0, h],
    ]
    for (const chain of skirtingPaths(input)) {
      const mid: P2 = [(chain.pts[0][0] + chain.pts[1][0]) / 2, (chain.pts[0][1] + chain.pts[1][1]) / 2]
      const ex = chain.pts[1][0] - chain.pts[0][0]
      const ey = chain.pts[1][1] - chain.pts[0][1]
      const el = Math.hypot(ex, ey) || 1
      // which side of the first segment is inside the room?
      const lx = -ey / el
      const ly = ex / el
      const inside = pointInPoly((mid[0] + lx * 0.03) / MM, (mid[1] + ly * 0.03) / MM, poly)
      sweepProfile(gb, { path: chain.pts, closed: chain.closed, side: inside ? 1 : -1, baseY: 0, profile, skipClosingEdge: true })
    }
    const mesh = gb.mesh(lib.get(rec.skirtingMaterialId ?? DEFAULT_MATERIALS.skirting), ref, { part: 'skirting', surface: 'skirting' })
    if (mesh) group.add(mesh)
  }

  return { group, ceiling, floor, ceilingY }
}

/** +1 when the room interior lies on the (-dz, dx) side of the polygon's edges */
function interiorSide(poly: Vec2[]): 1 | -1 {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len < 50) continue
    const lx = -(q.y - p.y) / len
    const ly = (q.x - p.x) / len
    return pointInPoly((p.x + q.x) / 2 + lx * 10, (p.y + q.y) / 2 + ly * 10, poly) ? 1 : -1
  }
  return 1
}

/**
 * Skirting paths (world XZ metres): the room boundary edges chained into polylines, broken at
 * openings that reach the floor and at walls without a solid base (virtual, glazing).
 */
function skirtingPaths(input: RoomInput): { pts: P2[]; closed: boolean }[] {
  const paths: P2[][] = []
  let current: P2[] | null = null
  const flush = (): void => {
    if (current && current.length >= 2) paths.push(current)
    current = null
  }
  const near = (a: P2, b: P2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.002

  for (const edge of input.room.edges) {
    const wall = input.walls[edge.wallId]
    const geom = input.wallGeoms[edge.wallId]
    const len = Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y)
    if (!wall || !geom || len < 1 || wall.kind === 'virtual' || wall.kind === 'glazing') {
      flush()
      continue
    }
    const ex = (edge.to.x - edge.from.x) / len
    const ey = (edge.to.y - edge.from.y) / len
    const dx = (geom.b.x - geom.a.x) / (geom.length || 1)
    const dy = (geom.b.y - geom.a.y) / (geom.length || 1)
    // gaps along the edge, in edge parameter mm
    const gaps: P2[] = []
    for (const o of input.openingsByWall.get(edge.wallId) ?? []) {
      if (!reachesFloor(o)) continue
      const margin = o.kind === 'opening' || o.kind === 'arch' ? 0 : 62
      for (const h of openingHoles(o, geom.length, wall.height)) {
        if (h.v0 > 10) continue
        const t0 = (geom.a.x + dx * h.s0 - edge.from.x) * ex + (geom.a.y + dy * h.s0 - edge.from.y) * ey
        const t1 = (geom.a.x + dx * h.s1 - edge.from.x) * ex + (geom.a.y + dy * h.s1 - edge.from.y) * ey
        gaps.push([Math.min(t0, t1) - margin, Math.max(t0, t1) + margin])
      }
    }
    gaps.sort((p, q) => p[0] - q[0])
    const solid: P2[] = []
    let cursor = 0
    for (const [g0, g1] of gaps) {
      if (g0 > cursor + 20) solid.push([cursor, Math.min(g0, len)])
      cursor = Math.max(cursor, g1)
    }
    if (len > cursor + 20) solid.push([cursor, len])
    const at = (t: number): P2 => [(edge.from.x + ex * t) * MM, (edge.from.y + ey * t) * MM]
    for (const [t0, t1] of solid) {
      if (t1 - t0 < 20) continue
      const start = at(t0)
      const end = at(t1)
      if (current && t0 < 0.5 && near(current[current.length - 1], start)) current.push(end)
      else {
        flush()
        current = [start, end]
      }
      if (t1 < len - 0.5) flush()
    }
    if (solid.length === 0) flush()
  }
  flush()
  // join the last path to the first one when the loop wraps around
  if (paths.length > 1) {
    const first = paths[0]
    const last = paths[paths.length - 1]
    if (near(last[last.length - 1], first[0])) {
      paths[0] = [...last, ...first.slice(1)]
      paths.pop()
    }
  }
  return paths
    .map((pts) => {
      const closed = pts.length > 3 && near(pts[0], pts[pts.length - 1])
      return { pts: closed ? pts.slice(0, -1) : pts, closed }
    })
    .filter((p) => p.pts.length >= 2)
}
