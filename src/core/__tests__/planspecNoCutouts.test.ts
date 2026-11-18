// No-cutout plans must build exactly as at a56f5f4 (before the cutout work): the same number of walls
// and closed areas, the same room areas, the same gate. The expectations below were produced by the
// a56f5f4 compiler; only plans it built cleanly (no dangling wall, merged or open room) are listed, so
// a difference here is a regression, not a base defect fixed
import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { compilePlanSpecDetailed, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'
import { polygonArea } from '../geom'
import { untwistRing } from '../rooms'

type Want = { walls: number; faces: number; areas: Record<string, number>; ok: boolean }
const TYPES = ['living', 'bedroom', 'kitchen', 'bathroom', 'hall']

/** name, rooms a, b, c… (rect or polygon), exterior thickness, what a56f5f4 built */
const CASES: [string, (number[] | number[][] | null)[], number, Want][] = [
  // room c is its exact 2900 × 2600: a56f5f4 built 7.5394, its outline folded over the corner (see the pinwheels below)
  ["three rooms at a building corner, 200 mm gaps (night #6)", [[0,0,4000,3000],[-3200,0,3000,2800],[0,-2800,2900,2600]], 300, {"walls":16,"faces":3,"areas":{"a":12,"b":8.4,"c":7.54},"ok":true}],
  ["… 150 mm gaps", [[0,0,4000,3000],[-3150,0,3000,2800],[0,-2750,2900,2600]], 300, {"walls":16,"faces":3,"areas":{"a":12,"b":8.4,"c":7.54},"ok":true}],
  ["corner seed 100008", [[0,0,3850,2900],[-3150,0,2850,2900],[0,-3100,4050,2900],[-3150,-3100,2850,2900]], 300, {"walls":14,"faces":4,"areas":{"a":11.165,"b":8.265,"c":11.745,"d":8.265},"ok":true}],
  ["corner seed 100009", [[0,0,4350,3300],[-2150,0,1900,3300],[0,-2650,4350,2400],[-2150,-2650,1900,2400]], 380, {"walls":12,"faces":4,"areas":{"a":14.355,"b":6.27,"c":10.44,"d":4.56},"ok":true}],
  ["corner seed 100011", [[0,0,4650,2750],[-1900,0,1700,2750],[0,-1800,4650,1650]], 300, {"walls":12,"faces":3,"areas":{"a":12.7875,"b":4.675,"c":7.6725},"ok":true}],
  ["corner seed 100018", [[0,0,3800,2700],[-2350,100,2200,2700],[0,-2550,3700,2350],[-2350,-2550,2200,2350]], 300, {"walls":17,"faces":4,"areas":{"a":10.26,"b":5.94,"c":8.695,"d":5.17},"ok":true}],
  ["corner seed 200012", [[0,0,4750,2800],[-2870,100,2750,2400],[0,-2700,4650,2500],[-2870,-2700,2750,2500]], 250, {"walls":17,"faces":4,"areas":{"a":13.3,"b":6.6,"c":11.625,"d":6.875},"ok":true}],
  ["corner seed 200015", [[0,0,3800,3900],[-3470,0,3350,4100],[0,-3150,4000,2900]], 250, {"walls":14,"faces":3,"areas":{"a":14.82,"b":13.735,"c":11.6},"ok":true}],
  ["corner seed 200022", [[0,0,3600,3100],[-2350,0,2050,3100],[0,-2500,3500,2350]], 250, {"walls":14,"faces":3,"areas":{"a":11.16,"b":6.355,"c":8.225},"ok":true}],
  ["corner seed 200024", [[0,0,4400,4300],[-2050,0,1950,4300],[0,-2450,4400,2250],[-2050,-2450,1950,2250]], 380, {"walls":12,"faces":4,"areas":{"a":18.92,"b":8.385,"c":9.9,"d":4.3875},"ok":true}],
  ["ofuzz seed 100008", [[0,0,3200,4450],[550,4960,3600,2400]], 400, {"walls":11,"faces":2,"areas":{"a":14.24,"b":8.64},"ok":true}],
  ["ofuzz seed 100009", [[0,0,2900,2700],[3100,0,2950,2700]], 510, {"walls":7,"faces":2,"areas":{"a":7.83,"b":7.965},"ok":true}],
  ["ofuzz seed 100011", [[0,0,2850,4450],[0,4830,3250,2650]], 380, {"walls":8,"faces":2,"areas":{"a":12.6825,"b":8.6125},"ok":true}],
  ["ofuzz seed 100018", [[0,0,4850,4200],[0,-1780,4850,1400],[-2300,0,2200,4200]], 380, {"walls":11,"faces":3,"areas":{"a":20.37,"b":6.79,"c":9.24},"ok":true}],
]

function spec(rooms: (number[] | number[][] | null)[], T: number): PlanSpec {
  const ids = 'abcde'
  return parsePlanSpec({
    version: 1,
    units: 'mm',
    defaults: { exteriorThickness: T, partitionThickness: 100, loadBearingThickness: 200 },
    rooms: rooms.flatMap((r, i) => (r ? [{ id: ids[i], type: TYPES[i], ...(typeof r[0] === 'number' ? { rect: r } : { polygon: r }) }] : [])),
    openings: [],
  })
}

describe('planspec without cutouts: built as at a56f5f4', () => {
  for (const [name, rooms, T, want] of CASES) {
    it(name, () => {
      const s = spec(rooms, T)
      const res = compilePlanSpecDetailed(s)
      const faces = derivePlan(res.doc, res.levelId).rooms
      expect(Object.keys(res.doc.walls).length, 'walls').toBe(want.walls)
      expect(faces.length, 'closed areas').toBe(want.faces)
      for (const [id, a] of Object.entries(want.areas)) {
        const f = faces.find((x) => x.roomId === res.roomIds[id])
        expect(f?.area ?? -1, `room ${id}`).toBeCloseTo(a, 4)
      }
      expect(validatePlanSpecDetailed(s).ok, 'gate').toBe(want.ok)
    })
  }
})

// Rooms meeting at a building corner whose walls miss each other by less than their thickness (a
// pinwheel). Walls stand on their axes, so the axes leave a tiny square at the junction: one room's
// cycle runs round it and its mitred faces fold back over the room's corner. a56f5f4 closed the square
// instead (a phantom closed area of 0.025 m²); now the fold is cut off the room's outline. Every room
// is its exact rect, in every orientation, with no closed area besides the rooms
const PINWHEELS: [string, number[][], number][] = [
  ['four rooms, axes 50 mm apart both ways', [[0, 0, 4200, 4050], [-1850, 100, 1550, 4050], [-100, -2050, 4400, 1800], [-1850, -2050, 1550, 1800]], 300],
  ['four rooms, 510 mm walls', [[0, 0, 2600, 3600], [-2500, 100, 2250, 3800], [-100, -2150, 2700, 1950], [-2500, -2150, 2250, 1950]], 510],
  ['three rooms, 510 mm walls', [[0, 0, 4950, 4300], [-3100, 0, 2850, 4100], [0, -2650, 4950, 2350]], 510],
  ['three rooms, a neighbour edge in a wall gap (review 4 #12)', [[0, 0, 4850, 3750], [-2800, 300, 2600, 3250], [-100, 3950, 3250, 2650]], 510],
]
/** the rect turned by o quarter turns, mirrored for o ≥ 4 */
function turnRect(r: number[], o: number): number[] {
  const f = ([x, y]: number[]): number[] => {
    const [mx, my] = o >= 4 ? [-x, y] : [x, y]
    const k = o % 4
    return k === 0 ? [mx, my] : k === 1 ? [-my, mx] : k === 2 ? [-mx, -my] : [my, -mx]
  }
  const [a, b] = [f([r[0], r[1]]), f([r[0] + r[2], r[1] + r[3]])]
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]
}

describe('planspec pinwheel corners: exact rooms in every orientation', () => {
  for (const [name, rooms, T] of PINWHEELS) {
    it(name, () => {
      for (let o = 0; o < 8; o++) {
        const s = spec(
          rooms.map((r) => turnRect(r, o)),
          T,
        )
        const res = compilePlanSpecDetailed(s)
        const faces = derivePlan(res.doc, res.levelId).rooms
        expect(faces.length, `closed areas, orientation ${o}`).toBe(rooms.length)
        rooms.forEach((r, i) => {
          const f = faces.find((x) => x.roomId === res.roomIds['abcde'[i]])
          expect(f?.area ?? -1, `room ${'abcde'[i]}, orientation ${o}`).toBeCloseTo((r[2] * r[3]) / 1e6, 4)
        })
        expect(validatePlanSpecDetailed(s).ok, `gate, orientation ${o}`).toBe(true)
      }
    })
  }
  it('a self-crossing face ring loses its reversed lobe; a simple ring is kept as it is', () => {
    const twisted = [{ x: -100, y: 0 }, { x: 4200, y: 0 }, { x: 4200, y: 4050 }, { x: 0, y: 4050 }, { x: 0, y: -250 }, { x: -100, y: -250 }]
    const out = untwistRing(twisted)
    expect(polygonArea(out)).toBeCloseTo(4200 * 4050, 6)
    expect(out).toHaveLength(4)
    const simple = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(untwistRing(simple)).toBe(simple)
  })
})

// Plain corners from review night 3, each built in every orientation (4 turns × mirror). Every listed
// area is the spec's exact floor except where noted, which is what a56f5f4 built there
const NIGHT3: [string, (number[] | number[][] | null)[], number, Record<string, number>, boolean, string[]?][] = [
  // the 700 mm arm of an L beside a neighbour 150 mm shorter keeps its outer wall (it was dropped: ROOM_OPEN)
  ['an L arm beside a slightly shorter neighbour', [[[0, 0], [3000, 0], [3000, 3000], [700, 3000], [700, 2000], [0, 2000]], null, [-3150, 0, 3000, 1850]], 300, { a: 8.3, c: 5.55 }, true],
  // a thick wall end inside the crossing wall's body is not dragged on to a corner past it (a lost 405 × 380)
  ['three rooms at a 580 mm corner (case A)', [[0, 0, 4350, 4250], [0, -3350, 3950, 2650], [4190, -3100, 3700, 2900]], 580, { a: 18.4875, b: 10.4543, c: 10.7155 }, true],
  // a wall end run over by another wall's end stays on it (it ran out into the next loggia)
  ['a room and two loggias at a 620 mm corner (case B)', [null, [0, 5320, 5350, 3250], [0, 8990, 1550, 1400], [-1050, 8810, 1050, 1400]], 620, { b: 17.3825, c: 2.17, d: 1.47 }, true, ['living', 'bedroom', 'loggia', 'loggia']],
  // a thick separator end crossing a partition's way stops on it (it ran into the corner of the room
  // below); room c keeps a56f5f4's 6.4416, and the gate says so
  ['a 690 mm separator above a partition (corpus 400099)', [[0, 0, 3550, 2600], [-210, 2640, 3550, 2700], [4030, 2640, 2400, 2700]], 320, { a: 9.23, b: 9.585, c: 6.4416 }, false],
  // a wall end another wall's end stops on (a corner) still moves on (the notch room stayed open)
  ['a room in an L notch (ofuzz 400052)', [[[0, 0], [1700, 0], [1700, 2050], [3300, 2050], [3300, 3100], [0, 3100]], [0, -1700, 3100, 1600], [3600, 0, 2400, 3350], [2210, 0, 1090, 1540]], 300, { a: 6.95, b: 4.96, c: 8.04, d: 1.6786 }, true],
]
function turnRoom(r: number[] | number[][] | null, o: number): number[] | number[][] | null {
  if (!r || typeof r[0] === 'number') return r && turnRect(r as number[], o)
  return (r as number[][]).map(([x, y]) => {
    const [mx, my] = o >= 4 ? [-x, y] : [x, y]
    const k = o % 4
    return k === 0 ? [mx, my] : k === 1 ? [-my, mx] : k === 2 ? [-mx, -my] : [my, -mx]
  })
}

describe('planspec review night 3: plain corners in every orientation', () => {
  for (const [name, rooms, T, areas, ok, types] of NIGHT3) {
    it(name, () => {
      for (let o = 0; o < 8; o++) {
        const s = spec(
          rooms.map((r) => turnRoom(r, o)),
          T,
        )
        if (types) s.rooms.forEach((r) => (r.type = types['abcde'.indexOf(r.id)] as typeof r.type))
        const res = compilePlanSpecDetailed(s)
        const faces = derivePlan(res.doc, res.levelId).rooms
        expect(faces.length, `closed areas, orientation ${o}`).toBe(Object.keys(areas).length)
        for (const [id, a] of Object.entries(areas)) {
          const f = faces.find((x) => x.roomId === res.roomIds[id])
          expect(f?.area ?? -1, `room ${id}, orientation ${o}`).toBeCloseTo(a, 4)
        }
        expect(validatePlanSpecDetailed(s).ok, `gate, orientation ${o}`).toBe(ok)
      }
    })
  }
})
