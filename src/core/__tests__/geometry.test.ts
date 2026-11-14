import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { builtinCatalog, findAsset, findMaterial, mergeCatalog } from '../catalog'
import { BUILTIN_ASSETS, BUILTIN_MATERIALS, DEFAULT_MATERIALS, OPENING_DEFAULTS, createEmptyDoc } from '../defaults'
import { derivePlan } from '../derive'
import {
  EPS,
  angleDeg,
  bboxOf,
  dist,
  fromWorld,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polylabel,
  projectOnSegment,
  rotate,
  segIntersect,
  toWorld,
} from '../geom'
import { newId } from '../ids'
import { parseDoc, serializeDoc } from '../io'
import { computeWallGeoms } from '../joins'
import {
  addItem,
  addLight,
  addOpening,
  addRectRoom,
  addWall,
  applyFinishToWallSide,
  duplicateEntities,
  findWallBetween,
  moveNode,
  moveOpening,
  moveWall,
  normalize,
  openingsOfWall,
  planarize,
  removeEntities,
  setWallLength,
  splitWall,
  syncRooms,
  wallLength,
  wallsAtNode,
} from '../ops'
import { detectRooms } from '../rooms'
import type { Doc, Id, MaterialCategory, ProceduralKind, Vec2, Wall } from '../types'

// ───────────────────────────── helpers ─────────────────────────────

function setup(): { doc: Doc; lv: Id } {
  const doc = createEmptyDoc('test')
  return { doc, lv: doc.levelOrder[0] }
}

function commit(doc: Doc): void {
  normalize(doc)
  syncRooms(doc)
}

function nodeAt(doc: Doc, x: number, y: number): Id {
  for (const id in doc.nodes) {
    const n = doc.nodes[id]
    if (Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6) return id
  }
  throw new Error(`no node at ${x},${y}`)
}

function wallBetween(doc: Doc, p: [number, number], q: [number, number]): Wall {
  const w = findWallBetween(doc, nodeAt(doc, p[0], p[1]), nodeAt(doc, q[0], q[1]))
  if (!w) throw new Error(`no wall between ${p} and ${q}`)
  return w
}

function wallAreaSum(doc: Doc, lv: Id): number {
  const geoms = computeWallGeoms(doc, lv)
  let s = 0
  for (const id in geoms) s += Math.abs(polygonArea(geoms[id].polygon))
  return s
}

function hasPoint(poly: Vec2[], x: number, y: number): boolean {
  return poly.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6)
}

const count = (o: object): number => Object.keys(o).length

// ───────────────────────────── geom ─────────────────────────────

describe('geom', () => {
  it('converts plan mm to world metres and back', () => {
    expect(toWorld(1500, 2500, 300)).toEqual([1.5, 0.3, 2.5])
    expect(toWorld(1000, 2000)).toEqual([1, 0, 2])
    expect(fromWorld(1.5, 2.5)).toEqual({ x: 1500, y: 2500 })
    expect(EPS).toBe(0.5)
  })

  it('signed area is positive for clockwise-on-screen polygons (y down)', () => {
    const cw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]
    expect(polygonArea(cw)).toBe(50)
    expect(polygonArea(cw.slice().reverse())).toBe(-50)
    expect(polygonCentroid(cw)).toEqual({ x: 5, y: 2.5 })
    expect(bboxOf(cw)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 })
  })

  it('point in polygon respects holes', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const hole = [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
    ]
    expect(pointInPolygon({ x: 1, y: 1 }, outer)).toBe(true)
    expect(pointInPolygon({ x: 11, y: 1 }, outer)).toBe(false)
    expect(pointInPolygon({ x: 5, y: 5 }, outer, [hole])).toBe(false)
    expect(pointInPolygon({ x: 5, y: 5 }, outer)).toBe(true)
  })

  it('segment intersection, projection, rotation and angles', () => {
    const hit = segIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: -5 }, { x: 4, y: 5 })
    expect(hit).not.toBeNull()
    expect(hit?.x).toBeCloseTo(4)
    expect(hit?.point.y).toBeCloseTo(0)
    expect(hit?.t).toBeCloseTo(0.4)
    expect(hit?.u).toBeCloseTo(0.5)
    expect(segIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBeNull()
    expect(segIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: -5 }, { x: 20, y: 5 })).toBeNull()

    const pr = projectOnSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(pr.point).toEqual({ x: 3, y: 0 })
    expect(pr.t).toBeCloseTo(0.3)
    expect(pr.dist).toBeCloseTo(4)
    expect(projectOnSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }).t).toBe(0)

    const r = rotate({ x: 1, y: 0 }, 90)
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(1) // clockwise on a y-down plan
    expect(angleDeg({ x: 0, y: 1 })).toBeCloseTo(90)
    expect(angleDeg({ x: 1, y: 1 }, { x: 2, y: 1 })).toBeCloseTo(0)
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('polylabel finds an interior point of concave polygons', () => {
    const L = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 1000 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 4000 },
      { x: 0, y: 4000 },
    ]
    const p = polylabel(L)
    expect(pointInPolygon(p, L)).toBe(true)
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]
    expect(polylabel(square)).toEqual({ x: 50, y: 50 })
  })
})

// ───────────────────────────── joins ─────────────────────────────

describe('wall joins', () => {
  it('free ends get square caps and outlines are counter-clockwise on screen', () => {
    const { doc, lv } = setup()
    const [id] = addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 }, { thickness: 200 })
    const g = computeWallGeoms(doc, lv)[id]
    expect(g.length).toBe(1000)
    expect(g.angle).toBe(0)
    // left side of a wall heading +x is up the screen (−y)
    expect(g.left).toEqual([
      { x: 0, y: -100 },
      { x: 1000, y: -100 },
    ])
    expect(g.right).toEqual([
      { x: 0, y: 100 },
      { x: 1000, y: 100 },
    ])
    expect(g.polygon).toHaveLength(4)
    expect(polygonArea(g.polygon)).toBeCloseTo(-200000)
  })

  it('mitres an L corner of different thicknesses along one shared cut', () => {
    const { doc, lv } = setup()
    const [w1] = addWall(doc, lv, { x: 0, y: 0 }, { x: 2000, y: 0 }, { thickness: 200 })
    const [w2] = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { thickness: 100 })
    const geoms = computeWallGeoms(doc, lv)
    const g1 = geoms[w1]
    const g2 = geoms[w2]
    // inner corner (below wall 1, left of wall 2) and outer corner
    expect(hasPoint(g1.polygon, 1950, 100)).toBe(true)
    expect(hasPoint(g1.polygon, 2050, -100)).toBe(true)
    expect(hasPoint(g2.polygon, 1950, 100)).toBe(true)
    expect(hasPoint(g2.polygon, 2050, -100)).toBe(true)
    expect(g1.polygon).toHaveLength(4)
    expect(g2.polygon).toHaveLength(4)
    // union of the two outlines = the L footprint, no overlap
    const total = Math.abs(polygonArea(g1.polygon)) + Math.abs(polygonArea(g2.polygon))
    expect(total).toBeCloseTo(2050 * 200 + 100 * 1900, 3)
  })

  it('T junction with different thicknesses tiles exactly', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: -2000, y: 0 }, { x: 2000, y: 0 }, { thickness: 200 })
    const [branch] = addWall(doc, lv, { x: 0, y: 0 }, { x: 0, y: 2000 }, { thickness: 100 })
    expect(count(doc.walls)).toBe(3)
    const geoms = computeWallGeoms(doc, lv)
    const gb = geoms[branch]
    // the branch starts on the face of the through wall
    expect(hasPoint(gb.polygon, 50, 100)).toBe(true)
    expect(hasPoint(gb.polygon, -50, 100)).toBe(true)
    const east = geoms[wallBetween(doc, [0, 0], [2000, 0]).id]
    expect(hasPoint(east.polygon, 50, 100)).toBe(true)
    expect(hasPoint(east.polygon, 0, -100)).toBe(true)
    // through wall 4000×200 + branch 100×1900 below its face
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4000 * 200 + 100 * 1900, 3)
  })

  it('X junction tiles exactly', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: -1000, y: 0 }, { x: 1000, y: 0 }, { thickness: 200 })
    addWall(doc, lv, { x: 0, y: -1000 }, { x: 0, y: 1000 }, { thickness: 200 })
    expect(count(doc.walls)).toBe(4)
    expect(count(doc.nodes)).toBe(5)
    expect(wallAreaSum(doc, lv)).toBeCloseTo(2 * 2000 * 200 - 200 * 200, 3)
  })

  it('collinear walls of different thickness form a step, sharp reflex corners are bevelled', () => {
    const { doc, lv } = setup()
    const [w1] = addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 }, { thickness: 200 })
    const [w2] = addWall(doc, lv, { x: 1000, y: 0 }, { x: 2000, y: 0 }, { thickness: 100 })
    let geoms = computeWallGeoms(doc, lv)
    expect(Math.abs(polygonArea(geoms[w1].polygon))).toBeCloseTo(200000)
    expect(Math.abs(polygonArea(geoms[w2].polygon))).toBeCloseTo(100000)

    const s = setup()
    const [a] = addWall(s.doc, s.lv, { x: 0, y: 0 }, { x: 3000, y: 0 }, { thickness: 200 })
    const [b] = addWall(s.doc, s.lv, { x: 0, y: 0 }, { x: 3000, y: 300 }, { thickness: 200 })
    geoms = computeWallGeoms(s.doc, s.lv)
    for (const id of [a, b]) {
      for (const p of geoms[id].polygon) {
        // without the mitre limit the outer corner would be ~2000 mm behind the node
        expect(p.x).toBeGreaterThan(-450)
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      }
    }
  })

  it('virtual walls have no thickness and end on the face of the wall they touch', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [v] = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { kind: 'virtual' })
    const g = computeWallGeoms(doc, lv)[v]
    expect(g.left).toEqual(g.right)
    expect(g.left[0].x).toBeCloseTo(2000)
    expect(g.left[0].y).toBeCloseTo(100)
    expect(g.left[1]).toEqual({ x: 2000, y: 2000 })
    expect(polygonArea(g.polygon)).toBeCloseTo(0)
    // the through wall is not notched by the virtual wall
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4000 * 200, 3)
  })
})

// ───────────────────────────── rooms ─────────────────────────────

describe('room detection', () => {
  it('rectangular room: area by inner faces', () => {
    const { doc, lv } = setup()
    const ids = addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    expect(ids).toHaveLength(4)
    expect(count(doc.nodes)).toBe(4)
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    const room = plan.rooms[0]
    expect(room.area).toBeCloseTo(3.8 * 2.8, 6)
    expect(room.perimeter).toBeCloseTo(2 * (3.8 + 2.8), 6)
    expect(room.polygon).toHaveLength(4)
    expect(polygonArea(room.polygon)).toBeGreaterThan(0) // clockwise on screen
    expect(room.holes).toEqual([])
    expect(room.centerline).toHaveLength(4)
    expect(Math.abs(polygonArea(room.centerline))).toBeCloseTo(4000 * 3000)
    expect(room.edges).toHaveLength(4)
    expect(room.labelPoint.x).toBeCloseTo(2000, 0)
    expect(room.labelPoint.y).toBeCloseTo(1500, 0)
    expect(room.levelId).toBe(lv)
    // one Room record, matched by anchor
    expect(count(doc.rooms)).toBe(1)
    expect(doc.rooms[room.roomId]).toBeDefined()
    expect(doc.rooms[room.roomId].floor.materialId).toBe(DEFAULT_MATERIALS.floor)
    // walls tile the ring between the outer and the inner rectangle
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4200 * 3200 - 3800 * 2800, 3)
    expect(plan.bounds).toEqual({ minX: -100, minY: -100, maxX: 4100, maxY: 3100 })
  })

  it('faces without a record get a deterministic auto id', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    const a = derivePlan(doc, lv).rooms[0].roomId
    const b = derivePlan(doc, lv).rooms[0].roomId
    expect(a).toMatch(/^auto_/)
    expect(a).toBe(b)
  })

  it('two rooms sharing a wall', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    const made = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { thickness: 200 })
    expect(made).toHaveLength(1)
    commit(doc)
    expect(count(doc.nodes)).toBe(6)
    expect(count(doc.walls)).toBe(7)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(2)
    for (const r of plan.rooms) {
      expect(r.area).toBeCloseTo(1.8 * 2.8, 6)
      expect(r.polygon).toHaveLength(4)
      expect(doc.rooms[r.roomId]).toBeDefined()
    }
    expect(count(doc.rooms)).toBe(2)
    const shared = made[0]
    const sides = plan.rooms.map((r) => r.edges.find((e) => e.wallId === shared)?.side).sort()
    expect(sides).toEqual(['left', 'right'])
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4200 * 3200 - 2 * 1800 * 2800, 3)
    const names = Object.values(doc.rooms).map((r) => r.name)
    expect(new Set(names).size).toBe(2)
  })

  it('L-shaped room', () => {
    const { doc, lv } = setup()
    const pts = [
      [0, 0],
      [4000, 0],
      [4000, 2000],
      [2000, 2000],
      [2000, 4000],
      [0, 4000],
    ]
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      addWall(doc, lv, { x: p[0], y: p[1] }, { x: q[0], y: q[1] }, { thickness: 200 })
    }
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    const room = plan.rooms[0]
    expect(room.polygon).toHaveLength(6)
    expect(room.area).toBeCloseTo((3800 * 1800 + 1800 * 2000) / 1e6, 6)
    expect(pointInPolygon(room.labelPoint, room.polygon)).toBe(true)
    expect(hasPoint(room.polygon, 1900, 1900)).toBe(true) // the reflex corner of the L
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4200 * 2200 + 2200 * 2000 - (3800 * 1800 + 1800 * 2000), 3)
  })

  it('island becomes a hole of the surrounding room', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 6000, 6000, { thickness: 200 })
    addRectRoom(doc, lv, 2500, 2500, 1000, 1000, { thickness: 200 })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(2)
    const outer = plan.rooms.find((r) => r.holes.length === 1)
    const inner = plan.rooms.find((r) => r.holes.length === 0)
    expect(outer).toBeDefined()
    expect(inner).toBeDefined()
    if (!outer || !inner) return
    expect(outer.area).toBeCloseTo((5800 * 5800 - 1200 * 1200) / 1e6, 6)
    expect(inner.area).toBeCloseTo(0.64, 6)
    expect(Math.abs(polygonArea(outer.holes[0]))).toBeCloseTo(1200 * 1200)
    // holes run opposite to the outer boundary
    expect(polygonArea(outer.holes[0])).toBeLessThan(0)
    expect(pointInPolygon(outer.labelPoint, outer.polygon, outer.holes)).toBe(true)
    expect(outer.perimeter).toBeCloseTo((4 * 5800 + 4 * 1200) / 1000, 6)
    expect(outer.edges).toHaveLength(8) // 4 own walls + 4 faces of the island
    expect(count(doc.rooms)).toBe(2)
  })

  it('free-standing wall is a hole, not a room', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    addWall(doc, lv, { x: 1000, y: 1500 }, { x: 3000, y: 1500 }, { thickness: 100 })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    expect(plan.rooms[0].holes).toHaveLength(1)
    expect(plan.rooms[0].area).toBeCloseTo((3800 * 2800 - 2000 * 100) / 1e6, 6)
    expect(count(doc.walls)).toBe(5)
  })

  it('dangling wall is kept, makes no face and is notched out of the room', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    const [stub] = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 1000 }, { thickness: 200 })
    // a second dangling wall outside the room and one not connected to anything
    addWall(doc, lv, { x: 4000, y: 3000 }, { x: 5500, y: 3000 }, { thickness: 200 })
    addWall(doc, lv, { x: 8000, y: 0 }, { x: 9000, y: 500 }, { thickness: 200 })
    commit(doc)
    expect(doc.walls[stub]).toBeDefined()
    expect(count(doc.walls)).toBe(8)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    const room = plan.rooms[0]
    expect(room.area).toBeCloseTo((3800 * 2800 - 200 * 900) / 1e6, 6)
    expect(room.holes).toEqual([])
    expect(room.centerline).toHaveLength(5) // rectangle + the T node, the spur is pruned
    expect(room.edges.filter((e) => e.wallId === stub).map((e) => e.side).sort()).toEqual(['left', 'right'])
    expect(pointInPolygon({ x: 2000, y: 500 }, room.polygon)).toBe(false)
    expect(count(doc.rooms)).toBe(1)
  })

  it('virtual wall splits a room without taking area', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    commit(doc)
    const before = Object.keys(doc.rooms)[0]
    const [v] = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { kind: 'virtual' })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(2)
    expect(plan.rooms[0].area + plan.rooms[1].area).toBeCloseTo(3.8 * 2.8, 6)
    for (const r of plan.rooms) {
      expect(r.area).toBeCloseTo(1.9 * 2.8, 6)
      expect(r.polygon).toHaveLength(4)
      expect(r.edges.some((e) => e.wallId === v)).toBe(false)
    }
    expect(count(doc.rooms)).toBe(2)
    expect(doc.rooms[before]).toBeDefined() // the original record survives in one of the halves
    // solid walls are unaffected by the separator
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4200 * 3200 - 3800 * 2800, 3)
  })

  it('island connected by a bridge wall: one ring room with a slit, one inner room', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 6000, 6000, { thickness: 200 })
    addRectRoom(doc, lv, 2500, 2500, 1000, 1000, { thickness: 200 })
    addWall(doc, lv, { x: 0, y: 3000 }, { x: 2500, y: 3000 }, { thickness: 200 })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(2)
    const ring = plan.rooms.find((r) => r.area > 1)
    expect(ring).toBeDefined()
    if (!ring) return
    expect(ring.holes).toEqual([])
    // bridge footprint between the inner face (x = 100) and the island face (x = 2400)
    expect(ring.area).toBeCloseTo((5800 * 5800 - 1200 * 1200 - 2300 * 200) / 1e6, 6)
    expect(pointInPolygon(ring.labelPoint, ring.polygon)).toBe(true)
    expect(pointInPolygon({ x: 3000, y: 3000 }, ring.polygon)).toBe(false)
    expect(pointInPolygon({ x: 1000, y: 3000 }, ring.polygon)).toBe(false)
    expect(count(doc.rooms)).toBe(2)
  })

  it('diagonal virtual wall into corners splits the area exactly', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 3000 }, { kind: 'virtual' })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(2)
    expect(plan.rooms[0].area + plan.rooms[1].area).toBeCloseTo(3.8 * 2.8, 6)
    for (const r of plan.rooms) {
      expect(polygonArea(r.polygon)).toBeGreaterThan(0)
      expect(r.area).toBeGreaterThan(5)
      expect(pointInPolygon(r.labelPoint, r.polygon)).toBe(true)
    }
    expect(wallAreaSum(doc, lv)).toBeCloseTo(4200 * 3200 - 3800 * 2800, 3)
  })

  it('acute corners keep valid outlines and a positive room', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: 0, y: 0 }, { x: 6000, y: 0 }, { thickness: 200 })
    addWall(doc, lv, { x: 6000, y: 0 }, { x: 6000, y: 1500 }, { thickness: 200 })
    addWall(doc, lv, { x: 6000, y: 1500 }, { x: 0, y: 0 }, { thickness: 200 })
    commit(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    const room = plan.rooms[0]
    expect(room.area).toBeGreaterThan(2.5)
    expect(room.area).toBeLessThan(4.5)
    for (const id in plan.wallGeoms) {
      const g = plan.wallGeoms[id]
      expect(polygonArea(g.polygon)).toBeLessThan(0)
      for (const p of g.polygon) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
    // rooms + walls = outer footprint (the bevelled 14° corner included): nothing overlaps, nothing is missing
    const total = room.area * 1e6 + wallAreaSum(doc, lv)
    const bb = plan.bounds
    expect(total).toBeLessThan((bb.maxX - bb.minX) * (bb.maxY - bb.minY))
    expect(total).toBeGreaterThan(6000 * 1500 * 0.5)
  })

  it('outer face is excluded and an open chain forms no room', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    addWall(doc, lv, { x: 4000, y: 0 }, { x: 4000, y: 3000 })
    addWall(doc, lv, { x: 4000, y: 3000 }, { x: 0, y: 3000 })
    commit(doc)
    expect(derivePlan(doc, lv).rooms).toHaveLength(0)
    expect(count(doc.rooms)).toBe(0)
    addWall(doc, lv, { x: 0, y: 3000 }, { x: 0, y: 0 })
    commit(doc)
    expect(derivePlan(doc, lv).rooms).toHaveLength(1)
    expect(count(doc.rooms)).toBe(1)
  })

  it('rooms on different levels are independent', () => {
    const { doc, lv } = setup()
    const lv2 = newId('lv')
    doc.levels[lv2] = { id: lv2, name: 'Этаж 2', elevation: 3000, height: 2700, visible: true }
    doc.levelOrder.push(lv2)
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    addRectRoom(doc, lv2, 0, 0, 5000, 5000)
    commit(doc)
    expect(count(doc.nodes)).toBe(8)
    expect(derivePlan(doc, lv).rooms).toHaveLength(1)
    expect(derivePlan(doc, lv2).rooms).toHaveLength(1)
    expect(derivePlan(doc, lv2).rooms[0].area).toBeCloseTo(4.8 * 4.8, 6)
    expect(count(doc.rooms)).toBe(2)
  })
})

// ───────────────────────────── editing ops ─────────────────────────────

describe('addWall', () => {
  it('snaps to existing nodes and never duplicates a wall', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 })
    const again = addWall(doc, lv, { x: 0.2, y: 0.1 }, { x: 1000.3, y: -0.2 })
    expect(again).toEqual([])
    expect(count(doc.walls)).toBe(1)
    expect(count(doc.nodes)).toBe(2)
    expect(addWall(doc, lv, { x: 5, y: 5 }, { x: 5.1, y: 5.1 })).toEqual([])
    // extending over an existing wall only adds the missing stretch
    const ext = addWall(doc, lv, { x: -500, y: 0 }, { x: 2000, y: 0 })
    expect(ext).toHaveLength(2)
    expect(count(doc.walls)).toBe(3)
    expect(count(doc.nodes)).toBe(4)
  })

  it('T-junction split keeps openings and finishes', () => {
    const { doc, lv } = setup()
    const [base] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const door = addOpening(doc, base, 'door', 800)
    const win = addOpening(doc, base, 'window', 3000, { width: 1200 })
    applyFinishToWallSide(doc, base, 'left', 'mat_paint_sage')
    applyFinishToWallSide(doc, base, 'right', 'mat_tile_white_gloss', { from: 0, to: 1200 })

    const made = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 2500 }, { thickness: 100, kind: 'partition' })
    commit(doc)
    expect(made).toHaveLength(1)
    expect(count(doc.walls)).toBe(3)
    expect(count(doc.nodes)).toBe(4)
    const first = wallBetween(doc, [0, 0], [2000, 0])
    const second = wallBetween(doc, [2000, 0], [4000, 0])
    expect(first.id).toBe(base)
    expect(doc.openings[door].wallId).toBe(first.id)
    expect(doc.openings[door].offset).toBe(800)
    expect(doc.openings[win].wallId).toBe(second.id)
    expect(doc.openings[win].offset).toBe(1000)
    expect(doc.openings[win].width).toBe(1200)
    for (const w of [first, second]) {
      expect(w.thickness).toBe(200)
      expect(w.left.materialId).toBe('mat_paint_sage')
      expect(w.right.zones).toEqual([{ from: 0, to: 1200, materialId: 'mat_tile_white_gloss' }])
    }
    expect(first.right.zones).not.toBe(second.right.zones)
    expect(doc.walls[made[0]].kind).toBe('partition')
    expect(wallsAtNode(doc, nodeAt(doc, 2000, 0))).toHaveLength(3)
  })

  it('crossing walls are split at the crossing with openings redistributed', () => {
    const { doc, lv } = setup()
    const [base] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    const o1 = addOpening(doc, base, 'door', 600)
    const o2 = addOpening(doc, base, 'window', 3200)
    const made = addWall(doc, lv, { x: 1500, y: -1000 }, { x: 1500, y: 1000 })
    commit(doc)
    expect(made).toHaveLength(2)
    expect(count(doc.walls)).toBe(4)
    expect(count(doc.nodes)).toBe(5)
    const x = nodeAt(doc, 1500, 0)
    expect(wallsAtNode(doc, x)).toHaveLength(4)
    expect(doc.openings[o1].wallId).toBe(base)
    expect(doc.openings[o1].offset).toBe(600)
    expect(doc.openings[o2].wallId).toBe(wallBetween(doc, [1500, 0], [4000, 0]).id)
    expect(doc.openings[o2].offset).toBe(1700)
  })

  it('a wall drawn across a room through several walls stays planar', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    const made = addWall(doc, lv, { x: -1000, y: 1500 }, { x: 5000, y: 1500 })
    commit(doc)
    expect(made).toHaveLength(3)
    expect(count(doc.walls)).toBe(9)
    expect(count(doc.nodes)).toBe(8)
    expect(derivePlan(doc, lv).rooms).toHaveLength(2)
  })

  it('uses document defaults and rejects bad input', () => {
    const { doc, lv } = setup()
    const [id] = addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 })
    expect(doc.walls[id].thickness).toBe(doc.settings.wallThickness)
    expect(doc.walls[id].height).toBe(doc.levels[lv].height)
    expect(doc.walls[id].kind).toBe('wall')
    expect(doc.walls[id].left.materialId).toBe(DEFAULT_MATERIALS.wall)
    expect(() => addWall(doc, 'nope', { x: 0, y: 0 }, { x: 1, y: 1 })).toThrow()
    expect(() => addWall(doc, lv, { x: Number.NaN, y: 0 }, { x: 100, y: 1 })).toThrow()
  })
})

describe('moving and resizing', () => {
  it('moving a node keeps the room record and its finish', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000, { thickness: 200 })
    commit(doc)
    const roomId = Object.keys(doc.rooms)[0]
    doc.rooms[roomId].name = 'Гостиная'
    doc.rooms[roomId].type = 'living'
    doc.rooms[roomId].floor = { materialId: 'mat_parquet_oak' }
    const anchorBefore = { ...doc.rooms[roomId].anchor }

    moveNode(doc, nodeAt(doc, 4000, 3000), 5000, 3600)
    commit(doc)
    expect(Object.keys(doc.rooms)).toEqual([roomId])
    const rec = doc.rooms[roomId]
    expect(rec.name).toBe('Гостиная')
    expect(rec.type).toBe('living')
    expect(rec.floor.materialId).toBe('mat_parquet_oak')
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    expect(plan.rooms[0].roomId).toBe(roomId)
    expect(plan.rooms[0].area).toBeGreaterThan(3.8 * 2.8)
    expect(rec.anchor).toEqual(plan.rooms[0].labelPoint)
    expect(rec.anchor).not.toEqual(anchorBefore)
    expect(pointInPolygon(rec.anchor, plan.rooms[0].polygon)).toBe(true)

    // moving a whole wall keeps it too
    moveWall(doc, wallBetween(doc, [0, 0], [4000, 0]).id, 0, -700)
    commit(doc)
    expect(Object.keys(doc.rooms)).toEqual([roomId])
    expect(doc.rooms[roomId].floor.materialId).toBe('mat_parquet_oak')
  })

  it('survives inside an Immer draft and produces no patches when nothing changes', () => {
    const base = createEmptyDoc('immer')
    const lv = base.levelOrder[0]
    const next = produce(base, (d) => {
      addRectRoom(d, lv, 0, 0, 4000, 3000)
      commit(d)
    })
    expect(count(next.rooms)).toBe(1)
    const again = produce(next, (d) => {
      commit(d)
    })
    expect(again).toBe(next)
    const roomId = Object.keys(next.rooms)[0]
    const moved = produce(next, (d) => {
      moveNode(d, nodeAt(d, 0, 0), -500, -500)
      commit(d)
    })
    expect(Object.keys(moved.rooms)).toEqual([roomId])
    expect(derivePlan(moved, lv).rooms[0].roomId).toBe(roomId)
  })

  it('room records follow splits and merges', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 6000, 3000)
    commit(doc)
    const original = Object.keys(doc.rooms)[0]
    doc.rooms[original].floor = { materialId: 'mat_tile_grey' }
    const [divider] = addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 3000 })
    commit(doc)
    expect(count(doc.rooms)).toBe(2)
    expect(doc.rooms[original].floor.materialId).toBe('mat_tile_grey')
    // the record stays with the part that contains its anchor (the larger, right part)
    expect(doc.rooms[original].anchor.x).toBeGreaterThan(2000)

    removeEntities(doc, [{ kind: 'wall', id: divider }])
    commit(doc)
    expect(count(doc.rooms)).toBe(1)
    expect(count(doc.walls)).toBe(4) // the split top and bottom walls were merged back
    expect(count(doc.nodes)).toBe(4)
    expect(derivePlan(doc, lv).rooms).toHaveLength(1)

    // opening the room deletes its record
    removeEntities(doc, [{ kind: 'wall', id: Object.keys(doc.walls)[0] }])
    commit(doc)
    expect(count(doc.rooms)).toBe(0)
  })

  it('moveNode keeps openings in place relative to the fixed end', () => {
    const { doc, lv } = setup()
    const [w] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    const o = addOpening(doc, w, 'door', 3000)
    moveNode(doc, doc.walls[w].a, -1000, 0) // wall grows at its start
    expect(doc.openings[o].offset).toBe(4000)
    moveNode(doc, doc.walls[w].b, 5000, 0) // wall grows at its end
    expect(doc.openings[o].offset).toBe(4000)
    moveNode(doc, doc.walls[w].b, 2000, 0) // shrinks below the opening → clamped
    expect(doc.openings[o].offset).toBe(3000 - doc.openings[o].width / 2)
  })

  it('setWallLength with the three anchors', () => {
    const { doc, lv } = setup()
    const [w] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    setWallLength(doc, w, 5000, 'a')
    expect(doc.nodes[doc.walls[w].b].x).toBe(5000)
    setWallLength(doc, w, 3000, 'b')
    expect(doc.nodes[doc.walls[w].a].x).toBe(2000)
    setWallLength(doc, w, 1000, 'center')
    expect(doc.nodes[doc.walls[w].a].x).toBe(3000)
    expect(doc.nodes[doc.walls[w].b].x).toBe(4000)
    expect(wallLength(doc, doc.walls[w])).toBe(1000)
  })

  it('splitWall redistributes openings and the pinned node survives normalize', () => {
    const { doc, lv } = setup()
    const [w] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    const o1 = addOpening(doc, w, 'door', 700)
    const o2 = addOpening(doc, w, 'window', 3000)
    const n = splitWall(doc, w, { x: 2000, y: 37 })
    expect(doc.nodes[n]).toMatchObject({ x: 2000, y: 0 })
    expect(count(doc.walls)).toBe(2)
    expect(doc.openings[o1].wallId).toBe(w)
    expect(doc.openings[o2].wallId).not.toBe(w)
    expect(doc.openings[o2].offset).toBe(1000)
    commit(doc)
    expect(count(doc.walls)).toBe(2)
    expect(doc.nodes[n]).toBeDefined()
    // splitting at an end returns the end node
    expect(splitWall(doc, w, { x: 0.1, y: 0 })).toBe(doc.walls[w].a)
    expect(count(doc.walls)).toBe(2)
  })
})

describe('normalize', () => {
  it('merges coincident nodes and drops degenerate / duplicate walls', () => {
    const { doc, lv } = setup()
    addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 })
    const [w2] = addWall(doc, lv, { x: 1000, y: 800 }, { x: 2000, y: 800 })
    // drag the start of w2 onto the end of the first wall
    moveNode(doc, doc.walls[w2].a, 1000.2, 0.1)
    expect(count(doc.nodes)).toBe(4)
    normalize(doc)
    expect(count(doc.nodes)).toBe(3)
    expect(count(doc.walls)).toBe(2)
    expect(wallsAtNode(doc, doc.walls[w2].a)).toHaveLength(2)

    // collapse w2 onto a point → degenerate → removed together with its opening
    const o = addOpening(doc, w2, 'door', 300)
    moveNode(doc, doc.walls[w2].b, 1000, 0)
    normalize(doc)
    expect(doc.walls[w2]).toBeUndefined()
    expect(doc.openings[o]).toBeUndefined()
    expect(count(doc.walls)).toBe(1)
    expect(count(doc.nodes)).toBe(2)
  })

  it('merges collinear walls only when their properties are identical', () => {
    const { doc, lv } = setup()
    const [w1] = addWall(doc, lv, { x: 0, y: 0 }, { x: 2000, y: 0 })
    const [w2] = addWall(doc, lv, { x: 4000, y: 0 }, { x: 2000, y: 0 }) // reversed direction
    const o1 = addOpening(doc, w1, 'door', 500)
    const o2 = addOpening(doc, w2, 'door', 500, { hinge: 'a', swing: 'left' })
    applyFinishToWallSide(doc, w1, 'left', 'mat_paint_navy')
    normalize(doc)
    expect(count(doc.walls)).toBe(2) // finishes differ (w2.right is the same physical side as w1.left)
    applyFinishToWallSide(doc, w2, 'right', 'mat_paint_navy')
    normalize(doc)
    expect(count(doc.walls)).toBe(1)
    expect(count(doc.nodes)).toBe(2)
    const w = Object.values(doc.walls)[0]
    expect(wallLength(doc, w)).toBe(4000)
    expect(doc.openings[o1].wallId).toBe(w.id)
    expect(doc.openings[o2].wallId).toBe(w.id)
    // both openings keep their world position: 500 and 3500 from the x = 0 end
    const fromZero = (id: Id): number => (doc.nodes[w.a].x === 0 ? doc.openings[id].offset : 4000 - doc.openings[id].offset)
    expect(fromZero(o1)).toBe(500)
    expect(fromZero(o2)).toBe(3500)
    // exactly one of the two had to be mirrored
    expect(doc.openings[o1].hinge).not.toBe(doc.openings[o2].hinge)
    expect(doc.openings[o1].swing).not.toBe(doc.openings[o2].swing)

    // different thickness → never merged
    const s = setup()
    addWall(s.doc, s.lv, { x: 0, y: 0 }, { x: 2000, y: 0 }, { thickness: 200 })
    addWall(s.doc, s.lv, { x: 2000, y: 0 }, { x: 4000, y: 0 }, { thickness: 100 })
    normalize(s.doc)
    expect(count(s.doc.walls)).toBe(2)
    // a corner is not collinear
    const c = setup()
    addWall(c.doc, c.lv, { x: 0, y: 0 }, { x: 2000, y: 0 })
    addWall(c.doc, c.lv, { x: 2000, y: 0 }, { x: 2000, y: 2000 })
    normalize(c.doc)
    expect(count(c.doc.walls)).toBe(2)
  })

  it('clamps openings to their wall and is idempotent', () => {
    const { doc, lv } = setup()
    const [w] = addWall(doc, lv, { x: 0, y: 0 }, { x: 1000, y: 0 })
    const o = addOpening(doc, w, 'window', 5000, { width: 3000 })
    expect(doc.openings[o].width).toBe(1000)
    expect(doc.openings[o].offset).toBe(500)
    const o2 = addOpening(doc, w, 'door', -200)
    expect(doc.openings[o2].offset).toBe(OPENING_DEFAULTS.door.width / 2)
    doc.openings[o2].offset = 99999
    normalize(doc)
    expect(doc.openings[o2].offset).toBe(1000 - OPENING_DEFAULTS.door.width / 2)
    const snapshot = JSON.stringify(doc)
    normalize(doc)
    syncRooms(doc)
    expect(JSON.stringify(doc)).toBe(snapshot)
  })

  it('planarize inserts touching nodes and splits crossings', () => {
    const { doc, lv } = setup()
    const [w1] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    const [w2] = addWall(doc, lv, { x: 1000, y: 500 }, { x: 1000, y: 2000 })
    const [w3] = addWall(doc, lv, { x: 3000, y: 500 }, { x: 3000, y: 2000 })
    moveNode(doc, doc.walls[w2].a, 1000, 0) // touches w1
    moveNode(doc, doc.walls[w3].a, 3000, -1000) // crosses w1
    expect(count(doc.walls)).toBe(3)
    planarize(doc, lv)
    normalize(doc)
    expect(count(doc.walls)).toBe(6)
    expect(wallsAtNode(doc, nodeAt(doc, 1000, 0))).toHaveLength(3)
    expect(wallsAtNode(doc, nodeAt(doc, 3000, 0))).toHaveLength(4)
    expect(doc.walls[w1]).toBeDefined()
  })
})

describe('openings, items, lights, finishes', () => {
  it('addOpening applies kind defaults and moveOpening changes host', () => {
    const { doc, lv } = setup()
    const [w1] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    const [w2] = addWall(doc, lv, { x: 4000, y: 0 }, { x: 4000, y: 3000 })
    const win = addOpening(doc, w1, 'window', 2000)
    expect(doc.openings[win]).toMatchObject({ kind: 'window', width: 1400, height: 1400, sill: 850, wallId: w1, sashes: 2 })
    expect(doc.openings[win].frameMaterialId).toBe(DEFAULT_MATERIALS.frame)
    const door = addOpening(doc, w1, 'door', 600, { hinge: 'b', swing: 'right' })
    expect(doc.openings[door]).toMatchObject({ kind: 'door', sill: 0, hinge: 'b', swing: 'right' })
    moveOpening(doc, door, w2, 1500)
    expect(doc.openings[door].wallId).toBe(w2)
    expect(doc.openings[door].offset).toBe(1500)
    expect(openingsOfWall(doc, w1).map((o) => o.id)).toEqual([win])
    expect(() => addOpening(doc, 'missing', 'door', 0)).toThrow()
  })

  it('wall finish zones cut and merge', () => {
    const { doc, lv } = setup()
    const [w] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 })
    applyFinishToWallSide(doc, w, 'left', 'mat_tile_white_gloss', { from: 0, to: 1200 })
    applyFinishToWallSide(doc, w, 'left', 'mat_tile_blue', { from: 600, to: 900 })
    expect(doc.walls[w].left.zones).toEqual([
      { from: 0, to: 600, materialId: 'mat_tile_white_gloss' },
      { from: 600, to: 900, materialId: 'mat_tile_blue' },
      { from: 900, to: 1200, materialId: 'mat_tile_white_gloss' },
    ])
    applyFinishToWallSide(doc, w, 'left', 'mat_tile_white_gloss', { from: 500, to: 1000 })
    expect(doc.walls[w].left.zones).toEqual([{ from: 0, to: 1200, materialId: 'mat_tile_white_gloss' }])
    applyFinishToWallSide(doc, w, 'left', 'mat_paint_navy')
    expect(doc.walls[w].left).toEqual({ materialId: 'mat_paint_navy' })
    expect(doc.walls[w].right.materialId).toBe(DEFAULT_MATERIALS.wall)
  })

  it('addItem and addLight use asset / kind defaults', () => {
    const { doc, lv } = setup()
    const wallUnit = BUILTIN_ASSETS.find((a) => a.id === 'asset_kitchen_wall_600')
    const sofa = BUILTIN_ASSETS.find((a) => a.id === 'asset_sofa_3seat')
    expect(wallUnit && sofa).toBeTruthy()
    if (!wallUnit || !sofa) return
    const i1 = addItem(doc, lv, wallUnit, 100, 200)
    expect(doc.items[i1]).toMatchObject({ assetId: wallUnit.id, x: 100, y: 200, elevation: 1400, mount: 'wall', rotation: 0 })
    expect(doc.items[i1].size).toEqual(wallUnit.size)
    expect(doc.items[i1].size).not.toBe(wallUnit.size)
    const i2 = addItem(doc, lv, sofa, 0, 0, { rotation: 90, size: { w: 2000, d: 900, h: 800 } })
    expect(doc.items[i2]).toMatchObject({ rotation: 90, elevation: 0, mount: 'floor' })
    expect(doc.items[i2].size.w).toBe(2000)
    expect(doc.items[i2].params).toMatchObject({ seats: 3 })
    const l = addLight(doc, lv, 'pendant', 10, 20, { lumens: 900 })
    expect(doc.lights[l]).toMatchObject({ kind: 'pendant', x: 10, y: 20, lumens: 900, on: true })
    expect(doc.lights[l].elevation).toBeLessThan(doc.levels[lv].height)
    const plan = derivePlan(doc, lv)
    // the sofa is rotated by 90°: its 2000 mm width runs along y
    expect(plan.bounds.maxY).toBeCloseTo(1000)
    expect(plan.bounds.maxX).toBeCloseTo(450)
  })

  it('removeEntities cascades and duplicateEntities copies walls with openings', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    const top = wallBetween(doc, [0, 0], [4000, 0])
    const o = addOpening(doc, top.id, 'window', 2000)
    const sofa = BUILTIN_ASSETS.find((a) => a.procedural === 'sofa')
    if (!sofa) throw new Error('no sofa')
    const item = addItem(doc, lv, sofa, 1000, 1000)
    commit(doc)

    const refs = duplicateEntities(
      doc,
      [
        { kind: 'wall', id: top.id },
        { kind: 'item', id: item },
        { kind: 'opening', id: o },
      ],
      0,
      -5000,
    )
    commit(doc)
    const newWalls = refs.filter((r) => r.kind === 'wall')
    const newOpenings = refs.filter((r) => r.kind === 'opening')
    const newItems = refs.filter((r) => r.kind === 'item')
    expect(newWalls).toHaveLength(1)
    expect(newOpenings).toHaveLength(1)
    expect(newItems).toHaveLength(1)
    expect(doc.openings[newOpenings[0].id].wallId).toBe(newWalls[0].id)
    expect(doc.openings[newOpenings[0].id].offset).toBe(2000)
    expect(doc.items[newItems[0].id]).toMatchObject({ x: 1000, y: -4000 })
    expect(doc.nodes[doc.walls[newWalls[0].id].a].y).toBe(-5000)

    // duplicating an opening alone keeps it on its wall
    const [dup] = duplicateEntities(doc, [{ kind: 'opening', id: o }], 0, 0)
    expect(doc.openings[dup.id].wallId).toBe(top.id)
    expect(doc.openings[dup.id].offset).not.toBe(2000)

    removeEntities(doc, [
      { kind: 'wall', id: top.id },
      { kind: 'item', id: item },
    ])
    expect(doc.walls[top.id]).toBeUndefined()
    expect(doc.openings[o]).toBeUndefined()
    expect(doc.openings[dup.id]).toBeUndefined()
    expect(doc.items[item]).toBeUndefined()
    expect(count(doc.nodes)).toBe(6) // room corners stay (other walls use them) + the copy's two nodes
    removeEntities(doc, [{ kind: 'node', id: nodeAt(doc, 0, 3000) }])
    commit(doc)
    expect(wallBetween(doc, [4000, 0], [4000, 3000])).toBeDefined()
    expect(count(doc.walls)).toBe(2) // right wall of the room + the copied wall
  })
})

// ───────────────────────────── io ─────────────────────────────

describe('io', () => {
  it('round-trips a document', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    addWall(doc, lv, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { kind: 'partition', thickness: 100 })
    const w = wallBetween(doc, [0, 0], [2000, 0])
    addOpening(doc, w.id, 'window', 1000)
    applyFinishToWallSide(doc, w.id, 'right', 'mat_tile_white_gloss', { from: 0, to: 1200 })
    const sofa = BUILTIN_ASSETS.find((a) => a.procedural === 'sofa')
    if (sofa) addItem(doc, lv, sofa, 1000, 1500)
    addLight(doc, lv, 'ceiling', 1000, 1500)
    commit(doc)
    Object.values(doc.rooms)[0].name = 'Кухня'
    const text = serializeDoc(doc)
    const back = parseDoc(text)
    expect(back).toEqual(doc)
    expect(parseDoc(JSON.parse(text))).toEqual(doc)
  })

  it('fills defaults for a minimal hand-written document', () => {
    const doc = parseDoc({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 3000, y: 0 },
        { id: 'c', x: 3000, y: '3000' },
        { id: 'd', x: 0, y: 3000 },
        { id: 'broken', x: 'oops' },
      ],
      walls: {
        w1: { a: 'a', b: 'b' },
        w2: { a: 'b', b: 'c', thickness: 100, kind: 'nonsense' },
        w3: { a: 'c', b: 'd' },
        w4: { a: 'd', b: 'a' },
        w5: { a: 'a', b: 'missing' },
      },
      openings: [{ wallId: 'w1', kind: 'window' }, { wallId: 'nope' }],
      items: [{ assetId: 'asset_sofa_2seat', x: 1500, y: 1500 }, { x: 1 }],
    })
    expect(doc.version).toBe(1)
    expect(doc.meta.app).toBe('doplan')
    expect(doc.levelOrder).toHaveLength(1)
    const lv = doc.levelOrder[0]
    expect(count(doc.nodes)).toBe(4)
    expect(count(doc.walls)).toBe(4)
    expect(doc.walls.w1).toMatchObject({ levelId: lv, thickness: doc.settings.wallThickness, height: 2700, kind: 'wall' })
    expect(doc.walls.w1.left.materialId).toBe(DEFAULT_MATERIALS.wall)
    expect(doc.walls.w2).toMatchObject({ thickness: 100, kind: 'wall' })
    expect(count(doc.openings)).toBe(1)
    const o = Object.values(doc.openings)[0]
    expect(o).toMatchObject({ kind: 'window', offset: 1500, width: 1400, sill: 850, hinge: 'a', swing: 'left' })
    expect(count(doc.items)).toBe(1)
    expect(Object.values(doc.items)[0]).toMatchObject({ rotation: 0, elevation: 0, mount: 'floor', levelId: lv })
    expect(count(doc.rooms)).toBe(1)
    expect(doc.render.toneMapping).toBe('agx')
    expect(doc.settings.units).toBe('mm')
    expect(derivePlan(doc, lv).rooms).toHaveLength(1)
  })

  it('rejects garbage with readable errors', () => {
    expect(() => parseDoc(null)).toThrow(/doplan/)
    expect(() => parseDoc(42)).toThrow(/doplan/)
    expect(() => parseDoc('not json at all')).toThrow(/JSON/)
    expect(() => parseDoc('[1,2,3]')).toThrow(/doplan/)
    expect(() => parseDoc({ foo: 1 })).toThrow(/doplan/)
    expect(() => parseDoc({ meta: { app: 'other' }, walls: {} })).toThrow()
    expect(() => parseDoc({ version: 999, meta: { app: 'doplan' } })).toThrow(/верси/)
    expect(() => parseDoc({ version: 'x', walls: {} })).toThrow()
    expect(parseDoc({ meta: { app: 'doplan', name: 'Пусто' } }).meta.name).toBe('Пусто')
  })
})

// ───────────────────────────── catalogue ─────────────────────────────

describe('built-in catalogue', () => {
  it('has a rich, valid material set covering every category', () => {
    expect(BUILTIN_MATERIALS.length).toBeGreaterThanOrEqual(70)
    const ids = new Set(BUILTIN_MATERIALS.map((m) => m.id))
    expect(ids.size).toBe(BUILTIN_MATERIALS.length)
    const categories: MaterialCategory[] = [
      'paint',
      'wallpaper',
      'plaster',
      'wood',
      'parquet',
      'laminate',
      'tile',
      'stone',
      'marble',
      'concrete',
      'brick',
      'fabric',
      'carpet',
      'leather',
      'metal',
      'glass',
      'plastic',
      'ceiling',
      'outdoor',
      'other',
    ]
    for (const c of categories) expect(BUILTIN_MATERIALS.some((m) => m.category === c), c).toBe(true)
    expect(BUILTIN_MATERIALS.filter((m) => m.category === 'paint').length).toBeGreaterThanOrEqual(30)
    for (const m of BUILTIN_MATERIALS) {
      expect(m.id).toMatch(/^mat_[a-z0-9_]+$/)
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(m.roughness).toBeGreaterThanOrEqual(0)
      expect(m.roughness).toBeLessThanOrEqual(1)
      expect(m.metalness).toBeGreaterThanOrEqual(0)
      expect(m.metalness).toBeLessThanOrEqual(1)
      expect(m.nameRu).toMatch(/[А-Яа-яЁё]/)
      expect(m.maps).toBeUndefined()
    }
    expect(BUILTIN_MATERIALS.some((m) => m.category === 'glass' && (m.transmission ?? 0) > 0.5)).toBe(true)
    for (const id of Object.values(DEFAULT_MATERIALS)) expect(ids.has(id), id).toBe(true)
  })

  it('has procedural assets for every kind with valid slots', () => {
    expect(BUILTIN_ASSETS.length).toBeGreaterThanOrEqual(60)
    const ids = new Set(BUILTIN_ASSETS.map((a) => a.id))
    expect(ids.size).toBe(BUILTIN_ASSETS.length)
    const kinds: ProceduralKind[] = [
      'box',
      'kitchenBase',
      'kitchenWall',
      'kitchenTall',
      'worktop',
      'wardrobe',
      'shelf',
      'bed',
      'sofa',
      'table',
      'chair',
      'fridge',
      'stove',
      'oven',
      'hood',
      'dishwasher',
      'washingMachine',
      'tv',
      'sink',
      'toilet',
      'bathtub',
      'shower',
      'washbasin',
      'radiator',
      'rug',
      'mirror',
      'picture',
      'column',
      'stairs',
      'airConditioner',
      'plantPot',
    ]
    for (const k of kinds) expect(BUILTIN_ASSETS.some((a) => a.procedural === k), k).toBe(true)
    const mats = new Set(BUILTIN_MATERIALS.map((m) => m.id))
    for (const a of BUILTIN_ASSETS) {
      expect(a.id).toMatch(/^asset_[a-z0-9_]+$/)
      expect(a.kind).toBe('procedural')
      expect(a.nameRu).toMatch(/[А-Яа-яЁё]/)
      expect(a.size.w).toBeGreaterThan(0)
      expect(a.size.d).toBeGreaterThan(0)
      expect(a.size.h).toBeGreaterThan(0)
      expect(['floor', 'wall', 'ceiling', 'surface']).toContain(a.mount)
      if (a.mount === 'wall') expect(a.elevation, a.id).toBeGreaterThan(0)
      for (const slot in a.slots) expect(mats.has(a.slots[slot]), `${a.id}.${slot}`).toBe(true)
    }
    for (const w of [400, 600, 800]) expect(ids.has(`asset_kitchen_base_${w}`)).toBe(true)
    expect(BUILTIN_ASSETS.some((a) => a.procedural === 'sofa' && a.defaultParams?.corner === 'left')).toBe(true)
  })

  it('catalogue lookups and merging', () => {
    const base = builtinCatalog()
    expect(base.materials.length).toBe(BUILTIN_MATERIALS.length)
    const doc = createEmptyDoc()
    expect(findMaterial(doc, base, 'mat_paint_white')?.nameRu).toBe('Белый')
    expect(findAsset(doc, base, 'asset_toilet')?.procedural).toBe('toilet')
    expect(findMaterial(doc, base, 'nope')).toBeUndefined()
    const custom = { ...BUILTIN_MATERIALS[0], id: 'mat_custom', name: 'Custom' }
    const override = { ...BUILTIN_MATERIALS[0], name: 'Override' }
    const merged = mergeCatalog(base, { materials: [custom, override], hdris: [{ id: 'h', name: 'H', src: 'x.hdr', kind: 'exterior' }] })
    expect(merged.materials.length).toBe(base.materials.length + 1)
    expect(merged.materials[0].name).toBe('Override')
    expect(base.materials[0].name).not.toBe('Override')
    expect(merged.hdris).toHaveLength(1)
    expect(findMaterial(doc, merged, 'mat_custom')?.name).toBe('Custom')
    doc.materials.mat_custom = { ...custom, name: 'Local' }
    expect(findMaterial(doc, merged, 'mat_custom')?.name).toBe('Local')
  })

  it('ids are prefixed and unique', () => {
    const a = newId('w')
    const b = newId('w')
    expect(a).toMatch(/^w_.{10}$/)
    expect(newId('lv')).toMatch(/^lv_.{10}$/)
    expect(a).not.toBe(b)
  })
})

// ───────────────────────────── robustness ─────────────────────────────

describe('robustness', () => {
  it('detectRooms tolerates a non-planar graph and missing geoms', () => {
    const { doc, lv } = setup()
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    // force a crossing diagonal without planarising
    const a = nodeAt(doc, 0, 0)
    const c = nodeAt(doc, 4000, 3000)
    const b = nodeAt(doc, 4000, 0)
    const d = nodeAt(doc, 0, 3000)
    for (const [p, q] of [
      [a, c],
      [b, d],
    ]) {
      const id = newId('w')
      doc.walls[id] = { id, levelId: lv, a: p, b: q, thickness: 100, height: 2700, kind: 'wall', left: { materialId: 'x' }, right: { materialId: 'x' } }
    }
    expect(() => derivePlan(doc, lv)).not.toThrow()
    expect(() => detectRooms(doc, lv, {})).not.toThrow()
    expect(detectRooms(doc, lv, {})).toEqual([])
    expect(() => commit(doc)).not.toThrow()
  })

  it('random rectangles keep the tiling invariant: rooms + walls = outline', () => {
    const { doc, lv } = setup()
    // a 3×2 grid of rooms drawn as overlapping rectangles
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) addRectRoom(doc, lv, i * 3000, j * 2500, 3000, 2500, { thickness: 150 })
    commit(doc)
    expect(count(doc.nodes)).toBe(12)
    expect(count(doc.walls)).toBe(17)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(6)
    const roomArea = plan.rooms.reduce((s, r) => s + r.area * 1e6, 0)
    expect(roomArea + wallAreaSum(doc, lv)).toBeCloseTo(9150 * 5150, 2)
    for (const r of plan.rooms) expect(r.area).toBeCloseTo(2.85 * 2.35, 6)
    expect(count(doc.rooms)).toBe(6)
  })
})
