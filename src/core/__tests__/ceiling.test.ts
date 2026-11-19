import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { addOpening, addRectRoom, addWall, normalize, syncRooms } from '../ops'
import { addElectric, alongWall } from '../electrical'
import { ceilingHeightAt, levelCeiling } from '../ceiling'
import { electricEditAllowed, rayElectricSurface } from '../electricPlace'
import { derivePlan } from '../derive'
import type { Doc, Id, Room, Wall } from '../types'

/** a 4000 × 3000 room (wall centrelines, walls 200 thick, inner faces 100 in) */
function room(): { doc: Doc; L: Id; rec: Room } {
  const doc = createEmptyDoc()
  const L = doc.levelOrder[0]
  addRectRoom(doc, L, 0, 0, 4000, 3000, { thickness: 200 })
  normalize(doc)
  syncRooms(doc)
  const rec = Object.values(doc.rooms)[0]
  return { doc, L, rec }
}

const edit = (doc: Doc): void => {
  normalize(doc)
  syncRooms(doc)
}

describe('ceiling points follow the ceiling (syncCeilingElectric)', () => {
  it('2D / inspector / AI paths agree: a ceiling point sits on its room ceiling and follows it', () => {
    const { doc, L, rec } = room()
    rec.ceiling.height = 2500
    const id = addElectric(doc, L, 'outLight', 2000, 1500)
    // addElectric alone gives the level height; the edit pipeline puts it on the room ceiling
    edit(doc)
    expect(doc.electrical![id].elevation).toBe(2500)
    // the ceiling is cleared: back to the walls' height
    delete rec.ceiling.height
    edit(doc)
    expect(doc.electrical![id].elevation).toBe(Math.min(...Object.values(doc.walls).map((w) => w.height)))
    // lower walls lower a ceiling without its own height
    for (const w of Object.values(doc.walls)) w.height = 2600
    edit(doc)
    expect(doc.electrical![id].elevation).toBe(2600)
    // a wall point is left alone
    const s = addElectric(doc, L, 'socket', 2000, 50)
    const h = doc.electrical![s].elevation
    edit(doc)
    expect(doc.electrical![s].elevation).toBe(h)
  })

  it('a point switched to the ceiling mount, and one outside the rooms, get the right height', () => {
    const { doc, L, rec } = room()
    rec.ceiling.height = 2400
    const id = addElectric(doc, L, 'socket', 2000, 50)
    doc.electrical![id].mount = 'ceiling'
    doc.electrical![id].y = 1500
    edit(doc)
    expect(doc.electrical![id].elevation).toBe(2400)
    doc.levels[L].height = 3100
    const out = addElectric(doc, L, 'outLight', 9000, 9000)
    edit(doc)
    expect(doc.electrical![out].elevation).toBe(3100)
    expect(levelCeiling(doc, L)).toBe(3100)
  })

  it('a multilevel ceiling: lower under its border ring; the ray hits the ring', () => {
    const { doc, L, rec } = room()
    rec.ceiling = { ...rec.ceiling, kind: 'multilevel', height: 2700, borderWidth: 400, borderDrop: 100 }
    const ring = addElectric(doc, L, 'outLight', 300, 1500)
    const mid = addElectric(doc, L, 'outLight', 2000, 1500)
    edit(doc)
    expect(doc.electrical![ring].elevation).toBe(2600)
    expect(doc.electrical![mid].elevation).toBe(2700)
    const rooms = derivePlan(doc, L).rooms
    const up = (x: number) => rayElectricSurface(doc, L, { ox: x, oy: 1500, oz: 1600, dx: 0, dy: 0, dz: 1 }, { rooms })!
    expect(up(300).z).toBe(2600)
    expect(up(2000).z).toBe(2700)
    // from above (orbit), the centre panel and the ring
    const down = (x: number) => rayElectricSurface(doc, L, { ox: x, oy: 1500, oz: 9000, dx: 0, dy: 0, dz: -1 }, { rooms, ceilingFromAbove: true })!
    expect(down(2000).z).toBe(2700)
    expect(down(300).z).toBe(2600)
  })

  it('a multilevel ceiling in a room too narrow for its border is flat, as the 3D view draws it', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    // inner faces 800 × 2800, border 600: no centre panel fits
    addRectRoom(doc, L, 0, 0, 1000, 3000, { thickness: 200, height: 2700 })
    edit(doc)
    const rec = Object.values(doc.rooms)[0]
    rec.ceiling = { ...rec.ceiling, kind: 'multilevel', borderWidth: 600, borderDrop: 100 }
    const id = addElectric(doc, L, 'outLight', 500, 1500)
    const edge = addElectric(doc, L, 'outLight', 150, 200)
    edit(doc)
    expect(doc.electrical![id].elevation).toBe(2700)
    expect(doc.electrical![edge].elevation).toBe(2700)
  })

  it('a multilevel ring at a reflex corner is the mitered inset the 3D view draws', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    const pts = [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 3000 },
      { x: 3000, y: 3000 },
      { x: 3000, y: 6000 },
      { x: 0, y: 6000 },
    ]
    for (let i = 0; i < pts.length; i++) addWall(doc, L, pts[i], pts[(i + 1) % pts.length], { thickness: 200, height: 2700 })
    edit(doc)
    const rec = Object.values(doc.rooms)[0]
    rec.ceiling = { ...rec.ceiling, kind: 'multilevel', borderWidth: 400, borderDrop: 100 }
    // inner corner of the L at (2900, 2900); the inset's at (2500, 2500): (2550, 2550) is ~495 mm
    // from the outline, yet on the lowered ring
    const corner = addElectric(doc, L, 'outLight', 2550, 2550)
    const centre = addElectric(doc, L, 'outLight', 1500, 1500)
    edit(doc)
    expect(doc.electrical![corner].elevation).toBe(2600)
    expect(doc.electrical![centre].elevation).toBe(2700)
  })

  it('beams: a point under a beam hangs on the beam', () => {
    const { doc, L, rec } = room()
    rec.ceiling = { ...rec.ceiling, kind: 'beams', height: 2700 }
    const rooms = derivePlan(doc, L).rooms.map((r) => ({ room: r, spec: doc.rooms[r.roomId]?.ceiling }))
    // the room is wider along x: beams across it, at x lines
    const xs: number[] = []
    for (let x = 200; x < 3800; x += 10) if (ceilingHeightAt(doc, L, rooms, x, 1500) < 2700) xs.push(x)
    expect(xs.length).toBeGreaterThan(0)
    expect(ceilingHeightAt(doc, L, rooms, xs[0], 1500)).toBe(2520)
  })
})

describe('floor kinds', () => {
  it('do not aim through the top of a wall or outside the rooms', () => {
    const { doc, L } = room()
    const rooms = derivePlan(doc, L).rooms
    const floor = { surfaces: new Set(['floor'] as const), rooms }
    const down = (x: number, y: number) => rayElectricSurface(doc, L, { ox: x, oy: y, oz: 9000, dx: 0, dy: 0, dz: -1 }, floor)
    expect(down(2000, 1500)?.surface).toBe('floor')
    // the top of the wall along y = 0
    expect(down(2000, 0)).toBeNull()
    // outside the building
    expect(down(2000, -1000)).toBeNull()
  })

  it('do not aim through the free end of a partition stub', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    addRectRoom(doc, L, 0, 0, 6000, 6000, { thickness: 200, height: 2700 })
    const [stub] = addWall(doc, L, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { thickness: 100, height: 2700 })
    edit(doc)
    const rooms = derivePlan(doc, L).rooms
    // from (2500, 4500) at eye height at the end face of the stub, (3000, 3000, 1000)
    const ray = { ox: 2500, oy: 4500, oz: 1600, dx: 500, dy: -1500, dz: -600 }
    expect(rayElectricSurface(doc, L, ray, { surfaces: new Set(['floor'] as const), rooms })).toBeNull()
    const hit = rayElectricSurface(doc, L, ray, { rooms })!
    expect(hit.surface).toBe('wall')
    expect(hit.wallId).toBe(stub)
    expect(hit.y).toBeCloseTo(3000)
    expect(hit.z).toBeCloseTo(1000)
    // past the end the floor is seen
    expect(rayElectricSurface(doc, L, { ...ray, dx: 1000 }, { surfaces: new Set(['floor'] as const), rooms })?.surface).toBe('floor')
  })

  it.each<[string, { kind?: Wall['kind']; height?: number; hidden?: boolean }]>([
    ['a virtual border', { kind: 'virtual' }],
    ['a hidden wall', { hidden: true }],
    ['a parapet lower than the hit', { kind: 'parapet', height: 900 }],
  ])('the end of a stub continued by %s still blocks the ray', (_name, cont) => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    addRectRoom(doc, L, 0, 0, 6000, 6000, { thickness: 200, height: 2700 })
    const [stub] = addWall(doc, L, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { thickness: 100, height: 2700 })
    const [next] = addWall(doc, L, { x: 3000, y: 3000 }, { x: 3000, y: 4000 }, {
      thickness: cont.kind === 'virtual' ? 0 : 100,
      height: cont.height ?? 2700,
      kind: cont.kind ?? 'wall',
    })
    if (cont.hidden) doc.walls[next].hidden = true
    edit(doc)
    expect(doc.walls[next].a === doc.walls[stub].b || doc.walls[next].b === doc.walls[stub].b).toBe(true)
    const rooms = derivePlan(doc, L).rooms
    const ray = { ox: 2500, oy: 4500, oz: 1600, dx: 500, dy: -1500, dz: -600 }
    expect(rayElectricSurface(doc, L, ray, { surfaces: new Set(['floor'] as const), rooms })).toBeNull()
    const hit = rayElectricSurface(doc, L, ray, { rooms })!
    expect(hit.wallId).toBe(stub)
    expect(hit.z).toBeCloseTo(1000)
  })

  it('a full-height wall continuing the stub covers its end', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    addRectRoom(doc, L, 0, 0, 6000, 6000, { thickness: 200, height: 2700 })
    const [stub] = addWall(doc, L, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { thickness: 100, height: 2700 })
    addWall(doc, L, { x: 3000, y: 3000 }, { x: 5000, y: 3000 }, { thickness: 100, height: 2700 })
    edit(doc)
    // straight at the joined end from below-right of the corner: the other wall's face, not the stub's end
    const ray = { ox: 3000, oy: 4500, oz: 1000, dx: 0, dy: -1, dz: 0 }
    const hit = rayElectricSurface(doc, L, ray, { rooms: derivePlan(doc, L).rooms })!
    expect(hit.surface).toBe('wall')
    expect(hit.wallId).not.toBe(stub)
  })
})

describe('electricEditAllowed (keys on the selected point)', () => {
  function withWindow() {
    const { doc, L } = room()
    const top = Object.values(doc.walls).find((w) => Math.abs(doc.nodes[w.a].y) < 1 && Math.abs(doc.nodes[w.b].y) < 1) as Wall
    const t = alongWall(doc, top.id, { x: 2000, y: 0 })!
    addOpening(doc, top.id, 'window', t, { width: 1200, height: 1400, sill: 800 })
    // a socket that was there before the window
    const id = addElectric(doc, L, 'socket', 2000, 100, { wallId: top.id, elevation: 900 })
    return { doc, L, top, p: doc.electrical![id] }
  }

  it('steps a point that is in an opening out of it, but not further in', () => {
    const { doc, p: p0 } = withWindow()
    // the socket (±30 mm) at 820 sticks 50 mm into the window over the 800 sill
    const p = { ...p0, elevation: 820 }
    expect(electricEditAllowed(doc, p, { ...p, elevation: 810 })).toBe(true)
    expect(electricEditAllowed(doc, p, { ...p, elevation: 760 })).toBe(true)
    expect(electricEditAllowed(doc, p, { ...p, elevation: 850 })).toBe(false)
  })

  it('a free point cannot be moved into an opening; a point fully inside may move', () => {
    const { doc, p } = withWindow()
    const free = { ...p, elevation: 300 }
    expect(electricEditAllowed(doc, free, { ...free, elevation: 350 })).toBe(true)
    expect(electricEditAllowed(doc, free, { ...free, elevation: 800 })).toBe(false)
    const inside = { ...p, elevation: 1500 }
    expect(electricEditAllowed(doc, inside, { ...inside, elevation: 1450 })).toBe(true)
  })
})
