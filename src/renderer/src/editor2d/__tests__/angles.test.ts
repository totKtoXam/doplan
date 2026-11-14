import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '@core/defaults'
import { derivePlan } from '@core/derive'
import { addRectRoom, addWall, moveNode, normalize, syncRooms } from '@core/ops'
import type { Doc, Id, Vec2 } from '@core/types'
import {
  angleToHorizontal,
  nodeRays,
  nodeRoomProbe,
  planNodeAngle,
  primarySector,
  type Ray,
  roomProbe,
  rotateAround,
  sectorsOf,
  visibleSectors,
} from '../angles'

const R = (id: string, deg: number): Ray => ({ id, angle: (((deg % 360) + 360) % 360) * (Math.PI / 180) })
const degs = (xs: { deg: number }[]): number[] => xs.map((s) => Math.round(s.deg * 1000) / 1000)
const never = (): boolean => false

function nodeAt(doc: Doc, p: Vec2): Id {
  const n = Object.values(doc.nodes).find((x) => Math.hypot(x.x - p.x, x.y - p.y) < 1)
  if (!n) throw new Error(`no node at ${p.x},${p.y}`)
  return n.id
}

function polyline(doc: Doc, pts: Vec2[], closed = false): void {
  const lv = doc.levelOrder[0]
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) addWall(doc, lv, pts[i], pts[(i + 1) % pts.length], { thickness: 200 })
  normalize(doc)
  syncRooms(doc)
}

/** angle between the two walls at a node measured inside the sector from `fromWall` to `toWall` */
function sectorDeg(doc: Doc, nodeId: Id, fromWall: Id, toWall: Id): number {
  const s = sectorsOf(nodeRays(doc, nodeId)).find((x) => x.from.id === fromWall && x.to.id === toWall)
  if (!s) throw new Error('sector not found')
  return s.deg
}

describe('sectorsOf', () => {
  it('splits the full turn between consecutive rays', () => {
    expect(degs(sectorsOf([R('a', 0), R('b', 90)]))).toEqual([90, 270])
    expect(degs(sectorsOf([R('a', 90), R('b', 0), R('c', 225)]))).toEqual([90, 135, 135])
    const s = sectorsOf([R('a', 350), R('b', 20)])
    expect(degs(s)).toEqual([330, 30])
    // the 30° sector runs from 350° across 0° to 20°, its bisector is at 5°
    expect(s[1].from.id).toBe('a')
    expect(s[1].to.id).toBe('b')
    expect((s[1].mid * 180) / Math.PI).toBeCloseTo(5, 6)
  })

  it('handles a lone ray and coincident rays', () => {
    expect(degs(sectorsOf([R('a', 45)]))).toEqual([360])
    expect(degs(sectorsOf([R('a', 45), R('b', 45)]))).toEqual([360])
    expect(sectorsOf([])).toEqual([])
  })
})

describe('visibleSectors', () => {
  it('shows only the convex angle of a corner outside rooms', () => {
    expect(degs(visibleSectors(sectorsOf([R('a', 0), R('b', 90)]), never))).toEqual([90])
    expect(degs(visibleSectors(sectorsOf([R('a', 0), R('b', 180)]), never))).toEqual([180])
  })

  it('prefers the sectors that lie inside rooms', () => {
    const s = sectorsOf([R('a', 0), R('b', 90)])
    expect(degs(visibleSectors(s, (x) => x.deg > 180))).toEqual([270])
    expect(degs(visibleSectors(s, () => true))).toEqual([90, 270])
  })

  it('shows the non-reflex sectors of a junction without rooms, only room sectors otherwise', () => {
    const tee = sectorsOf([R('a', 0), R('b', 90), R('c', 180)])
    expect(degs(visibleSectors(tee, never))).toEqual([90, 90, 180])
    // a partition meeting the outer wall: the 180° outside the building is not labelled
    expect(degs(visibleSectors(tee, (x) => x.deg < 180))).toEqual([90, 90])
    const y = sectorsOf([R('a', 0), R('b', 30), R('c', 60)])
    expect(degs(visibleSectors(y, never))).toEqual([30, 30])
    expect(degs(visibleSectors(y, (x) => x.deg > 180))).toEqual([300])
  })

  it('has nothing to show at a free wall end', () => {
    expect(visibleSectors(sectorsOf([R('a', 10)]), () => true)).toEqual([])
  })
})

describe('angles on a real plan', () => {
  it('measures a rectangular room corner as 90° on the inside', () => {
    const doc = createEmptyDoc('t')
    const lv = doc.levelOrder[0]
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    normalize(doc)
    syncRooms(doc)
    const rooms = derivePlan(doc, lv).rooms
    const id = nodeAt(doc, { x: 0, y: 0 })
    const probe = nodeRoomProbe(doc, rooms, id)
    const s = primarySector(nodeRays(doc, id), probe)
    expect(s?.deg).toBeCloseTo(90, 6)
    expect(probe(s!)).toBe(true)
    expect(degs(visibleSectors(sectorsOf(nodeRays(doc, id)), probe))).toEqual([90])
  })

  it('measures the reflex corner of an L-shaped room as 270°', () => {
    const doc = createEmptyDoc('t')
    const lv = doc.levelOrder[0]
    polyline(
      doc,
      [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 2000, y: 4000 },
        { x: 0, y: 4000 },
      ],
      true,
    )
    const rooms = derivePlan(doc, lv).rooms
    expect(rooms.length).toBe(1)
    const id = nodeAt(doc, { x: 2000, y: 2000 })
    const probe = nodeRoomProbe(doc, rooms, id)
    expect(degs(visibleSectors(sectorsOf(nodeRays(doc, id)), probe))).toEqual([270])
    expect(primarySector(nodeRays(doc, id), probe)?.deg).toBeCloseTo(270, 6)
  })

  it('needs exactly two walls for a primary angle', () => {
    const doc = createEmptyDoc('t')
    polyline(doc, [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
    ])
    expect(primarySector(nodeRays(doc, nodeAt(doc, { x: 0, y: 0 })), never)).toBeNull()
    polyline(doc, [
      { x: 1500, y: 0 },
      { x: 1500, y: 2000 },
    ])
    // the T at x = 1500 has three walls
    expect(primarySector(nodeRays(doc, nodeAt(doc, { x: 1500, y: 0 })), never)).toBeNull()
  })
})

describe('rotateAround / angleToHorizontal', () => {
  it('turns a point around the centre keeping its distance', () => {
    const c = { x: 100, y: 100 }
    const p = rotateAround(c, { x: 1100, y: 100 }, 0, 90, true)
    expect(p.x).toBeCloseTo(100, 6)
    expect(p.y).toBeCloseTo(1100, 6)
    const q = rotateAround(c, { x: 100, y: 600 }, 0, 30, false)
    expect(Math.hypot(q.x - c.x, q.y - c.y)).toBeCloseTo(500, 6)
    expect((Math.atan2(q.y - c.y, q.x - c.x) * 180) / Math.PI).toBeCloseTo(-30, 6)
  })

  it('measures the angle to the nearest horizontal half-axis', () => {
    const a = angleToHorizontal({ x: 1, y: -1 })
    expect(a.deg).toBeCloseTo(45, 6)
    expect(a.axis).toBe(0)
    const b = angleToHorizontal({ x: -2, y: 1 })
    expect(b.deg).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 6)
    expect(b.axis).toBeCloseTo(Math.PI, 9)
    expect(angleToHorizontal({ x: 0, y: 5 }).deg).toBeCloseTo(90, 6)
  })
})

describe('planNodeAngle', () => {
  it('turns the wall whose far end has fewer connections and keeps its length', () => {
    const doc = createEmptyDoc('t')
    // corner at the origin: a long free wall to the right, a short wall down that continues on
    polyline(doc, [
      { x: 3000, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 1000 },
      { x: 1000, y: 1000 },
    ])
    const id = nodeAt(doc, { x: 0, y: 0 })
    const free = nodeAt(doc, { x: 3000, y: 0 })
    const s = primarySector(nodeRays(doc, id), never)!
    expect(s.deg).toBeCloseTo(90, 6)
    const plan = planNodeAngle(doc, id, s, 60)!
    expect(plan).not.toBeNull()
    expect(plan.movingNodeId).toBe(free)
    expect(Math.hypot(plan.to.x, plan.to.y)).toBeCloseTo(3000, 6)
    moveNode(doc, plan.movingNodeId, plan.to.x, plan.to.y)
    // same sector (same walls, same side), now 60°
    expect(sectorDeg(doc, id, s.from.id, s.to.id)).toBeCloseTo(60, 6)
    // the other wall did not move
    expect(nodeAt(doc, { x: 0, y: 1000 })).toBeTruthy()
  })

  it('on a tie turns the shorter wall, on either side of the sector', () => {
    const doc = createEmptyDoc('t')
    const lv = doc.levelOrder[0]
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    normalize(doc)
    syncRooms(doc)
    const rooms = derivePlan(doc, lv).rooms
    const id = nodeAt(doc, { x: 0, y: 0 })
    const s = primarySector(nodeRays(doc, id), nodeRoomProbe(doc, rooms, id))!
    const plan = planNodeAngle(doc, id, s, 100)!
    // both far ends are corners (two walls each): the 3000 mm wall is shorter than the 4000 mm one
    expect(plan.movingNodeId).toBe(nodeAt(doc, { x: 0, y: 3000 }))
    moveNode(doc, plan.movingNodeId, plan.to.x, plan.to.y)
    expect(sectorDeg(doc, id, s.from.id, s.to.id)).toBeCloseTo(100, 6)
    const moved = doc.nodes[plan.movingNodeId]
    expect(Math.hypot(moved.x, moved.y)).toBeCloseTo(3000, 6)
    // the room interior stays on the measured side: the moved corner leans away from x = 0
    expect(moved.x).toBeLessThan(0)
  })

  it('accepts a reflex target and rejects bad input', () => {
    const doc = createEmptyDoc('t')
    polyline(doc, [
      { x: 2000, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 2000 },
    ])
    const id = nodeAt(doc, { x: 0, y: 0 })
    const s = primarySector(nodeRays(doc, id), never)!
    const plan = planNodeAngle(doc, id, s, 250)!
    moveNode(doc, plan.movingNodeId, plan.to.x, plan.to.y)
    expect(sectorDeg(doc, id, s.from.id, s.to.id)).toBeCloseTo(250, 6)
    expect(planNodeAngle(doc, id, s, 0)).toBeNull()
    expect(planNodeAngle(doc, id, s, 360)).toBeNull()
    expect(planNodeAngle(doc, id, s, Number.NaN)).toBeNull()
    expect(planNodeAngle(doc, id, { from: s.from, to: s.from }, 45)).toBeNull()
    expect(planNodeAngle(doc, 'nope', s, 45)).toBeNull()
  })
})

describe('roomProbe / stable choice', () => {
  it('still finds the room when the length cap leaves the probe inside the wall body', () => {
    const room = { polygon: [{ x: 100, y: 100 }, { x: 4000, y: 100 }, { x: 4000, y: 4000 }, { x: 100, y: 4000 }], holes: [] }
    const corner = sectorsOf([R('a', 0), R('b', 90)])[0]
    // capped at 120 mm the bisector point (85, 85) is in the wall; the full distance reaches the room
    expect(roomProbe([room], { x: 0, y: 0 }, 100, 120)(corner)).toBe(true)
  })

  it('moves the same wall whichever way the sector is ordered', () => {
    const doc = createEmptyDoc('t')
    polyline(doc, [
      { x: 2000, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 2000 },
    ])
    const id = nodeAt(doc, { x: 0, y: 0 })
    const [s1, s2] = sectorsOf(nodeRays(doc, id))
    expect(planNodeAngle(doc, id, s1, 120)!.movingWallId).toBe(planNodeAngle(doc, id, s2, 120)!.movingWallId)
  })
})
