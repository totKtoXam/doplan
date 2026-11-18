// No-cutout plans must build exactly as at a56f5f4 (before the cutout work): the same number of walls
// and closed areas, the same room areas, the same gate. The expectations below were produced by the
// a56f5f4 compiler; only plans it built cleanly (no dangling wall, merged or open room) are listed, so
// a difference here is a regression, not a base defect fixed
import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { compilePlanSpecDetailed, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'

type Want = { walls: number; faces: number; areas: Record<string, number>; ok: boolean }
const TYPES = ['living', 'bedroom', 'kitchen', 'bathroom', 'hall']

/** name, rooms a, b, c… (rect or polygon), exterior thickness, what a56f5f4 built */
const CASES: [string, (number[] | number[][] | null)[], number, Want][] = [
  ["three rooms at a building corner, 200 mm gaps (night #6)", [[0,0,4000,3000],[-3200,0,3000,2800],[0,-2800,2900,2600]], 300, {"walls":16,"faces":3,"areas":{"a":12,"b":8.4,"c":7.5394},"ok":true}],
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
