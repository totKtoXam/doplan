import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { addOpening, addRectRoom, normalize } from '../ops'
import { addElectric, alongWall, electricHalfWidth, wallFaceRange } from '../electrical'
import {
  ELECTRIC_CLEARANCES,
  cycleElectricKind,
  electricHalfHeight,
  electricWallDims,
  levelCeiling,
  openingAtWallPoint,
  rayElectricSurface,
  roomCeilingHeight,
  snapElectricOnWall,
} from '../electricPlace'
import { derivePlan } from '../derive'
import type { Doc, Id, Wall } from '../types'

/** a 4000 × 3000 room (wall centrelines), walls 200 thick; `top` is the wall along y = 0 */
function room(): { doc: Doc; L: Id; top: Wall } {
  const doc = createEmptyDoc()
  const L = doc.levelOrder[0]
  addRectRoom(doc, L, 0, 0, 4000, 3000, { thickness: 200 })
  normalize(doc)
  const top = Object.values(doc.walls).find((w) => Math.abs(doc.nodes[w.a].y) < 1 && Math.abs(doc.nodes[w.b].y) < 1)!
  return { doc, L, top }
}

const tAt = (doc: Doc, w: Wall, x: number): number => alongWall(doc, w.id, { x, y: 0 })!

describe('rayElectricSurface', () => {
  it('hits the inner face of the wall in front, on the room side', () => {
    const { doc, L, top } = room()
    const hit = rayElectricSurface(doc, L, { ox: 1000, oy: 1500, oz: 1200, dx: 0, dy: -1, dz: 0 })!
    expect(hit.surface).toBe('wall')
    expect(hit.wallId).toBe(top.id)
    expect(hit.y).toBeCloseTo(100)
    expect(hit.z).toBeCloseTo(1200)
    expect(hit.t).toBeCloseTo(tAt(doc, top, 1000))
    // the room is on the side the face looks to
    const face = addElectric(doc, L, 'socket', hit.x, hit.y, { wallId: hit.wallId, side: hit.side })
    expect(doc.electrical![face].rotation).toBeCloseTo(90)
  })

  it('hits the outer face from outside the room', () => {
    const { doc, L, top } = room()
    const hit = rayElectricSurface(doc, L, { ox: 1000, oy: -2000, oz: 1000, dx: 0, dy: 1, dz: 0 })!
    expect(hit.wallId).toBe(top.id)
    expect(hit.y).toBeCloseTo(-100)
    const inner = rayElectricSurface(doc, L, { ox: 1000, oy: 1500, oz: 1000, dx: 0, dy: -1, dz: 0 })!
    expect(hit.side).not.toBe(inner.side)
  })

  it('hits the floor looking down and the ceiling looking up', () => {
    const { doc, L } = room()
    const down = rayElectricSurface(doc, L, { ox: 2000, oy: 1500, oz: 1600, dx: 0.2, dy: 0, dz: -1 })!
    expect(down.surface).toBe('floor')
    expect(down.z).toBe(0)
    expect(down.x).toBeCloseTo(2320)
    const up = rayElectricSurface(doc, L, { ox: 2000, oy: 1500, oz: 1600, dx: 0, dy: 0.1, dz: 1 })!
    expect(up.surface).toBe('ceiling')
    expect(up.z).toBe(levelCeiling(doc, L))
  })

  it('passes over a wall lower than the ray', () => {
    const { doc, L, top } = room()
    doc.walls[top.id].height = 1000
    const hit = rayElectricSurface(doc, L, { ox: 1000, oy: 1500, oz: 1500, dx: 0, dy: -1, dz: 0 })
    expect(hit?.wallId).not.toBe(top.id)
  })

  it('skips hidden walls; a wall in front blocks the floor and the ceiling', () => {
    const { doc, L, top } = room()
    const ray = { ox: 1000, oy: 1500, oz: 1500, dx: 0, dy: -1, dz: -0.1 }
    expect(rayElectricSurface(doc, L, ray, { surfaces: new Set(['floor']) })).toBeNull()
    expect(rayElectricSurface(doc, L, { ...ray, dz: 0.3 }, { surfaces: new Set(['ceiling']) })).toBeNull()
    expect(rayElectricSurface(doc, L, { ...ray, dz: 0.3 })!.wallId).toBe(top.id)
    doc.walls[top.id].hidden = true
    const hit = rayElectricSurface(doc, L, ray)!
    expect(hit.wallId).not.toBe(top.id)
    expect(rayElectricSurface(doc, L, ray, { surfaces: new Set(['floor']) })!.surface).toBe('floor')
  })

  it('passes over a wall the cut-away shows lowered', () => {
    const { doc, L, top } = room()
    const ray = { ox: 1000, oy: -3000, oz: 1200, dx: 0, dy: 1, dz: 0 }
    expect(rayElectricSurface(doc, L, ray)!.wallId).toBe(top.id)
    const hit = rayElectricSurface(doc, L, ray, { wallHeight: (w) => (w.id === top.id ? 1000 : w.height) })!
    expect(hit.wallId).not.toBe(top.id)
    expect(hit.y).toBeCloseTo(2900)
  })

  it('aims through a door and hits the wall above it', () => {
    const { doc, L, top } = room()
    addOpening(doc, top.id, 'door', tAt(doc, top, 2000), { width: 800, height: 2100, sill: 0 })
    const through = rayElectricSurface(doc, L, { ox: 2000, oy: -3000, oz: 1000, dx: 0, dy: 1, dz: 0 })!
    expect(through.wallId).not.toBe(top.id)
    expect(through.y).toBeCloseTo(2900)
    expect(rayElectricSurface(doc, L, { ox: 2000, oy: -3000, oz: 2300, dx: 0, dy: 1, dz: 0 })!.wallId).toBe(top.id)
    // beside the door the wall is solid
    expect(rayElectricSurface(doc, L, { ox: 2600, oy: -3000, oz: 1000, dx: 0, dy: 1, dz: 0 })!.wallId).toBe(top.id)
  })

  it('aims at the ceiling of the room under the ray, from above in orbit', () => {
    const { doc, L, top } = room()
    doc.walls[top.id].height = 2500
    const rooms = derivePlan(doc, L).rooms
    expect(rooms.length).toBe(1)
    expect(roomCeilingHeight(doc, rooms[0], L)).toBe(2500)
    const up = rayElectricSurface(doc, L, { ox: 2000, oy: 1500, oz: 1600, dx: 0, dy: 0, dz: 1 }, { rooms })!
    expect(up.surface).toBe('ceiling')
    expect(up.z).toBe(2500)
    // the room's own ceiling height wins
    ;(doc.rooms as Record<string, unknown>)[rooms[0].roomId] = { ceiling: { height: 2400 } }
    expect(rayElectricSurface(doc, L, { ox: 2000, oy: 1500, oz: 1600, dx: 0, dy: 0, dz: 1 }, { rooms })!.z).toBe(2400)
    // no ceiling outside the rooms
    expect(rayElectricSurface(doc, L, { ox: 6000, oy: 1500, oz: 1600, dx: 0, dy: 0, dz: 1 }, { rooms })).toBeNull()
    // from above: only when asked
    const down = { ox: 2000, oy: 1500, oz: 8000, dx: 0, dy: 0, dz: -1 }
    expect(rayElectricSurface(doc, L, down, { rooms, surfaces: new Set(['ceiling']) })).toBeNull()
    expect(rayElectricSurface(doc, L, down, { rooms, ceilingFromAbove: true })!.z).toBe(2400)
  })
})

describe('openings', () => {
  it('forbids a point inside a door, allows it beside and above', () => {
    const { doc, top } = room()
    const t = tAt(doc, top, 2000)
    const door = addOpening(doc, top.id, 'door', t, { width: 800, height: 2100, sill: 0 })
    const p = { kind: 'socket' as const }
    expect(openingAtWallPoint(doc, top.id, t, 300, p)?.id).toBe(door)
    expect(openingAtWallPoint(doc, top.id, t + 400 + electricHalfWidth(p) + 1, 300, p)).toBeNull()
    expect(openingAtWallPoint(doc, top.id, t, 2100 + electricHalfHeight(p) + 1, p)).toBeNull()
    // a clearance makes the beside position too close
    expect(openingAtWallPoint(doc, top.id, t + 400 + electricHalfWidth(p) + 1, 300, p, 50)?.id).toBe(door)
  })

  it('allows a socket under a window sill', () => {
    const { doc, top } = room()
    const t = tAt(doc, top, 2000)
    addOpening(doc, top.id, 'window', t, { width: 1200, height: 1400, sill: 900 })
    expect(openingAtWallPoint(doc, top.id, t, 300, { kind: 'socket' })).toBeNull()
    expect(openingAtWallPoint(doc, top.id, t, 1000, { kind: 'switch1' })).not.toBeNull()
  })

  it('a balcony block: wall under its window part, a door from the threshold', () => {
    const { doc, L, top } = room()
    const t = tAt(doc, top, 2000)
    const id = addOpening(doc, top.id, 'balconyBlock', t, { width: 2000, height: 2100, sill: 0, hinge: 'a' })
    const o = doc.openings[id]
    // hinge a: the door at the node-a end, the window part over an apron
    const dir = tAt(doc, top, 0) < 1 ? 1 : -1
    const p = { kind: 'socket' as const }
    expect(openingAtWallPoint(doc, top.id, o.offset + 500 * dir, 300, p)).toBeNull()
    expect(openingAtWallPoint(doc, top.id, o.offset - 600 * dir, 300, p)?.id).toBe(id)
    expect(openingAtWallPoint(doc, top.id, o.offset + 500 * dir, 1200, p)?.id).toBe(id)
    // a ray under the window hits the wall, through the door it passes
    const x = (t2: number): number => (dir > 0 ? t2 : 4000 - t2)
    expect(rayElectricSurface(doc, L, { ox: x(o.offset + 500 * dir), oy: -3000, oz: 400, dx: 0, dy: 1, dz: 0 })!.wallId).toBe(top.id)
    expect(rayElectricSurface(doc, L, { ox: x(o.offset - 600 * dir), oy: -3000, oz: 400, dx: 0, dy: 1, dz: 0 })!.wallId).not.toBe(top.id)
    // the dimension under the window measures past it to the door part
    const side = rayElectricSurface(doc, L, { ox: 2000, oy: 1500, oz: 300, dx: 0, dy: -1, dz: 0 })!.side!
    const dims = electricWallDims(doc, top.id, side, o.offset + 500 * dir, 300, p)
    expect(dims.filter((d) => d.kind === 'opening').length).toBe(1)
  })

  it('reports a snapped position in an opening as blocked', () => {
    const { doc, top } = room()
    const t = tAt(doc, top, 2000)
    addOpening(doc, top.id, 'door', t, { width: 800, height: 2100, sill: 0 })
    const side = rayElectricSurface(doc, doc.levelOrder[0], { ox: 1000, oy: 1500, oz: 500, dx: 0, dy: -1, dz: 0 })!.side!
    expect(snapElectricOnWall(doc, top.id, side, t, 900, { kind: 'switch1' }, { tol: 0 }).blocked).not.toBeNull()
  })
})

describe('snapElectricOnWall', () => {
  function face() {
    const r = room()
    const hit = rayElectricSurface(r.doc, r.L, { ox: 1000, oy: 1500, oz: 500, dx: 0, dy: -1, dz: 0 })!
    return { ...r, side: hit.side! }
  }

  it('snaps the height to the standard heights within the tolerance only', () => {
    const { doc, top, side } = face()
    const t = tAt(doc, top, 1500)
    const s = snapElectricOnWall(doc, top.id, side, t, 912, { kind: 'switch1' }, { tol: 20 })
    expect(s.h).toBe(900)
    expect(['preset', 'default']).toContain(s.hSnap?.kind)
    expect(snapElectricOnWall(doc, top.id, side, t, 1300 + 15, { kind: 'socket' }, { tol: 20 }).h).toBe(1300)
    expect(snapElectricOnWall(doc, top.id, side, t, 640, { kind: 'socket' }, { tol: 20 }).h).toBe(640)
    expect(snapElectricOnWall(doc, top.id, side, t, 912, { kind: 'socket' }, { tol: 0 }).h).toBe(912)
  })

  it('aligns with a neighbour on the same face: its height and one above another', () => {
    const { doc, L, top, side } = face()
    const n = addElectric(doc, L, 'socket', 1500, 100, { wallId: top.id, side, elevation: 1234 })
    const nt = tAt(doc, top, 1500)
    const s = snapElectricOnWall(doc, top.id, side, nt + 300, 1240, { kind: 'socket' }, { tol: 20 })
    expect(s.h).toBe(1234)
    expect(s.hSnap).toEqual({ kind: 'neighbour', value: 1234, id: n })
    const above = snapElectricOnWall(doc, top.id, side, nt + 12, 900, { kind: 'switch1' }, { tol: 20 })
    expect(above.t).toBeCloseTo(nt)
    expect(above.tSnap?.kind).toBe('neighbour')
    // the point itself is not its own neighbour
    const self = snapElectricOnWall(doc, top.id, side, nt + 300, 1240, { kind: 'socket' }, { tol: 20, selfId: n })
    expect(self.hSnap?.kind).not.toBe('neighbour')
  })

  it('snaps to clearances from the corner and from an opening edge (to the frame edge)', () => {
    const { doc, top, side } = face()
    const p = { kind: 'switch1' as const }
    const half = electricHalfWidth(p)
    const r = wallFaceRange(doc, top.id, side, 0)!
    const c = ELECTRIC_CLEARANCES[0]
    const s = snapElectricOnWall(doc, top.id, side, r.lo + c + half + 8, 1000, p, { tol: 20 })
    expect(s.t).toBeCloseTo(r.lo + c + half)
    expect(s.tSnap?.kind).toBe('corner')
    const t = tAt(doc, top, 2500)
    const o = addOpening(doc, top.id, 'door', t, { width: 800, height: 2100, sill: 0 })
    const near = snapElectricOnWall(doc, top.id, side, t - 400 - 150 - half - 7, 1000, p, { tol: 20 })
    expect(near.t).toBeCloseTo(t - 400 - 150 - half)
    expect(near.tSnap).toMatchObject({ kind: 'opening', id: o })
  })

  it('keeps an explicit height (snapHeight: false)', () => {
    const { doc, top, side } = face()
    const t = tAt(doc, top, 1500)
    expect(snapElectricOnWall(doc, top.id, side, t, 310, { kind: 'socket' }, { tol: 20 }).h).toBe(300)
    const s = snapElectricOnWall(doc, top.id, side, t, 310, { kind: 'socket' }, { tol: 20, snapHeight: false })
    expect(s.h).toBe(310)
    expect(s.hSnap).toBeUndefined()
  })

  it('does not let a snap move a free spot into an opening', () => {
    const { doc, top, side } = face()
    const t = tAt(doc, top, 2000)
    addOpening(doc, top.id, 'window', t, { width: 1200, height: 1400, sill: 900 })
    const p = { kind: 'switch1' as const }
    // 830 is under the sill; the 900 switch height would put the frame into the window
    const s = snapElectricOnWall(doc, top.id, side, t, 830, p, { tol: 80 })
    expect(s.blocked).toBeNull()
    expect(s.h).toBe(830)
    expect(s.hSnap).toBeUndefined()
  })

  it('keeps the point on the face and inside the wall height', () => {
    const { doc, top, side } = face()
    const p = { kind: 'socket' as const }
    const r = wallFaceRange(doc, top.id, side, electricHalfWidth(p))!
    const s = snapElectricOnWall(doc, top.id, side, -500, 99999, p, { tol: 0 })
    expect(s.t).toBeCloseTo(r.lo)
    expect(s.h).toBeCloseTo(doc.walls[top.id].height - electricHalfHeight(p))
  })
})

describe('electricWallDims', () => {
  it('measures the height, the clear gaps to the corner and the opening, and the neighbour', () => {
    const { doc, L, top } = room()
    const side = rayElectricSurface(doc, L, { ox: 1000, oy: 1500, oz: 500, dx: 0, dy: -1, dz: 0 })!.side!
    const r = wallFaceRange(doc, top.id, side, 0)!
    const xAt = (t: number): number => (tAt(doc, top, 0) < 1 ? t : 4000 - t)
    // a door in the middle of the face, the point between the lo corner and the door
    const mid = (r.lo + r.hi) / 2
    addOpening(doc, top.id, 'door', mid, { width: 800, height: 2100, sill: 0 })
    const p = { kind: 'socket' as const }
    const half = electricHalfWidth(p)
    const pt = r.lo + 500
    const dims = electricWallDims(doc, top.id, side, pt, 300, p)
    expect(dims.find((d) => d.kind === 'floor')?.value).toBe(300)
    expect(dims.find((d) => d.kind === 'corner')?.value).toBeCloseTo(500 - half)
    expect(dims.find((d) => d.kind === 'opening')?.value).toBeCloseTo(mid - 400 - pt - half)
    expect(dims.some((d) => d.kind === 'neighbour')).toBe(false)
    addElectric(doc, L, 'socket', xAt(pt + 300), 0, { wallId: top.id, side, elevation: 700 })
    const withN = electricWallDims(doc, top.id, side, pt, 300, p)
    expect(withN.find((d) => d.kind === 'neighbour')?.value).toBeCloseTo(500)
  })
})

describe('cycleElectricKind', () => {
  it('wraps both ways', () => {
    const ks = ['socket', 'switch1', 'tv'] as const
    expect(cycleElectricKind(ks, 'tv', 1)).toBe('socket')
    expect(cycleElectricKind(ks, 'socket', -1)).toBe('tv')
  })
})
