// Orientation battery for cutouts in rooms-mode PlanSpec: every case from the three cutout reviews
// is built in 8 orientations (4 turns × mirror) and with the cutout misread by ±10 / ±20 mm. The
// outcome (gate, error codes, built areas, holes, technical voids) must not depend on how the plan is
// turned, and at the exact position each room must be built with the area of the same plan without
// cutouts, less the cutouts
import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { compilePlanSpecDetailed, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'

type P = [number, number]
interface SpecLike {
  rooms: { id: string; rect?: number[]; polygon?: P[]; cutouts?: { rect: number[] }[] }[]
  openings?: { at?: P }[]
}

const L: P[] = [[0, 0], [2000, 0], [2000, 1000], [4000, 1000], [4000, 3000], [0, 3000]]
const L2: P[] = [[0, 0], [3000, 0], [3000, 2000], [6000, 2000], [6000, 5000], [0, 5000]]
const sp = (rooms: unknown[], T = 300) => ({
  version: 1,
  units: 'mm',
  defaults: { exteriorThickness: T, partitionThickness: 100, loadBearingThickness: 200 },
  rooms,
  openings: [],
})
const R = (cutouts: unknown[], rect = [0, 0, 4000, 3000]) => ({ id: 'a', type: 'living', rect, cutouts })
const Lr = (cutouts: unknown[], polygon: P[] = L) => ({ id: 'a', type: 'living', polygon, cutouts })
const nb = (rect: number[]) => ({ id: 'b', type: 'bathroom', rect })
const bedroom = (id: string, rect: number[]) => ({ id, type: 'bedroom', rect })
const col = (rect: number[]) => ({ rect, kind: 'column' })
const shaft = (rect: number[]) => ({ rect, kind: 'shaft' })

/** name → [spec, index of the cutout of room a that gets misread (-1: none), the gate opens] */
const SCENARIOS: Record<string, [unknown, number, boolean]> = {
  // review 1
  'r1 corner column': [sp([R([col([0, 2500, 500, 500])]), bedroom('b', [0, 3100, 4000, 3000])]), 0, true],
  'r1 loggia column': [sp([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000] }, { id: 'l', type: 'loggia', rect: [0, 3300, 4000, 1000], edgeWall: { kind: 'parapet' }, cutouts: [col([0, 3800, 500, 500])] }]), -1, true],
  'r1 shaft at a reflex corner': [sp([Lr([{ rect: [1400, 1000, 600, 600] }])]), 0, true],
  'r1 big shaft': [sp([R([{ rect: [0, 0, 1500, 1500] }], [0, 0, 4000, 4000])]), 0, true],
  'r1 shaft at the outline (and past it)': [sp([R([{ rect: [0, 0, 600, 1000] }])]), 0, true],
  'r1 partly adjacent cutouts': [sp([R([{ rect: [0, 0, 600, 1000] }, { rect: [600, 0, 600, 600] }])]), -1, true],
  'r1 column under a reflex corner': [sp([Lr([col([2000, 1000, 600, 600])])]), 0, true],
  'r1 long column under a reflex corner': [sp([Lr([col([2000, 1000, 750, 1000])])]), 0, true],
  'r1 column in a reflex corner': [sp([Lr([col([1100, 200, 900, 800])])]), 0, true],
  'r1 two cutouts on one wall': [sp([R([{ rect: [0, 600, 1300, 1100] }, { rect: [0, 2150, 1300, 850], kind: 'box' }])]), -1, true],
  // review 2
  'r2 #3 shaft under a reflex corner, neighbour in the notch': [sp([Lr([shaft([2000, 1000, 600, 600])]), nb([2100, 0, 1900, 900])]), 0, true],
  'r2 #4 column then shaft': [sp([R([col([0, 0, 600, 1000]), shaft([600, 0, 600, 600])])]), -1, true],
  'r2 #4 shaft then column': [sp([R([shaft([0, 0, 600, 600]), col([600, 0, 600, 1000])])]), -1, true],
  'r2 #5 shaft beside a reflex corner, neighbour in the notch': [sp([Lr([{ rect: [1400, 400, 600, 600] }]), nb([2100, 0, 1900, 900])]), 0, true],
  'r2 #6 corner column between two neighbours': [sp([R([col([3600, 2600, 400, 400])]), bedroom('b', [4100, 0, 3000, 3000]), bedroom('c', [0, 3100, 4000, 2000])]), 0, true],
  'r2 #6 corner shaft between two neighbours': [sp([R([{ rect: [3400, 2400, 600, 600] }]), bedroom('b', [4100, 0, 3000, 3000]), bedroom('c', [0, 3100, 4000, 2000])]), 0, true],
  'r2 #7 partly adjacent cutouts mid-room': [sp([R([{ rect: [1000, 1000, 500, 500] }, { rect: [1500, 1200, 500, 500] }])]), -1, true],
  'r2 #11 shaft under a reflex corner, 500 mm walls': [sp([Lr([shaft([2000, 1000, 600, 600])])], 500), 0, true],
  'r2 #11 column beside a shaft as tall': [sp([R([col([0, 0, 600, 1000]), shaft([600, 0, 600, 1000])])]), -1, true],
  'r2 #13 cutout across a reflex corner line (refused)': [sp([Lr([{ rect: [2400, 2000, 1200, 600] }], L2)]), -1, false],
  // review 3
  'r3 #1 column at a reflex corner': [sp([Lr([col([1400, 1000, 600, 600])])]), 0, true],
  'r3 #2 shaft at the middle of a column side': [sp([R([col([0, 0, 600, 1000]), shaft([600, 200, 600, 600])])]), 1, true],
  'r3 #3 shaft at a reflex corner, neighbour in the notch': [sp([Lr([shaft([1400, 1000, 600, 600])]), nb([2100, 0, 1900, 900])]), 0, true],
  'r3 #3 … neighbour misread to a 90 mm gap': [sp([Lr([shaft([1400, 1000, 600, 600])]), nb([2090, 0, 1910, 900])]), 0, true],
  'r3 #3 … neighbour misread 10 mm taller': [sp([Lr([shaft([1400, 1000, 600, 600])]), nb([2100, 0, 1900, 910])]), 0, true],
  'r3 #4 neighbour facing part of the reflex edge': [sp([Lr([shaft([1400, 400, 600, 600])]), nb([2100, 0, 1900, 400])]), 0, true],
  'r3 #4 … taller shaft': [sp([Lr([shaft([1400, 300, 600, 700])]), nb([2100, 0, 1900, 400])]), -1, true],
  'r3 #5 cutouts touching at a corner': [sp([R([{ rect: [1000, 1000, 500, 500] }, { rect: [1500, 1500, 500, 500] }])]), -1, true],
  'r3 #5 column and shaft touching at a corner': [sp([R([col([1000, 1000, 400, 400]), { rect: [1400, 1400, 600, 600] }])]), -1, true],
  'r3 #5 columns touching at a corner': [sp([R([col([1000, 1000, 400, 400]), col([1400, 1400, 400, 400])])]), -1, true],
  'r3 #6 load-bearing wall in the notch': [sp([Lr([{ rect: [1400, 400, 600, 600] }]), nb([2200, 0, 1800, 800])]), 0, true],
  'r3 #6 … cutout under the corner': [sp([Lr([{ rect: [2000, 1000, 600, 600] }]), nb([2200, 0, 1800, 800])]), 0, true],
  'r3 #6 column, 400 mm walls, 300 mm gap': [sp([Lr([col([1400, 400, 600, 600])]), nb([2300, 0, 1700, 700])], 400), 0, true],
  'r3 #6 shaft, 510 mm walls, 300 mm gap': [sp([Lr([{ rect: [1400, 400, 600, 600] }]), nb([2300, 0, 1700, 700])], 510), 0, true],
  'r3 #6 balcony in the notch': [sp([Lr([{ rect: [1400, 400, 600, 600] }]), { id: 'b', type: 'balcony', rect: [2510, 0, 1490, 490], edgeWall: { kind: 'railing', thickness: 100, height: 1100 } }], 510), 0, true],
  'r3 #7 column and shaft on a shared edge': [sp([R([col([0, 0, 600, 1000]), shaft([600, 0, 600, 600])]), bedroom('b', [0, -3100, 4000, 3000])]), -1, true],
  'r3 #7 … 200 mm gap, 510 mm walls': [sp([R([col([0, 0, 600, 1000]), shaft([600, 0, 600, 600])]), bedroom('b', [0, -3200, 4000, 3000])], 510), -1, true],
}

const turn = (o: number) => (p: P): P => {
  let [x, y] = p
  if (o >= 4) x = -x
  for (let k = 0; k < o % 4; k++) [x, y] = [-y, x]
  return [x, y]
}
const turnRect = (f: (p: P) => P, r: number[]): number[] => {
  const a = f([r[0], r[1]])
  const b = f([r[0] + r[2], r[1] + r[3]])
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]
}
function turned(spec: unknown, o: number, k = -1, dx = 0, dy = 0): SpecLike {
  const f = turn(o)
  const s = JSON.parse(JSON.stringify(spec)) as SpecLike
  if (k >= 0) {
    const c = s.rooms[0].cutouts![k]
    c.rect = [c.rect[0] + dx, c.rect[1] + dy, c.rect[2], c.rect[3]]
  }
  for (const r of s.rooms) {
    if (r.rect) r.rect = turnRect(f, r.rect)
    if (r.polygon) r.polygon = r.polygon.map(f)
    for (const c of r.cutouts ?? []) c.rect = turnRect(f, c.rect)
  }
  for (const op of s.openings ?? []) if (op.at) op.at = f(op.at)
  return s
}

interface Outcome {
  ok: boolean
  codes: string
  area: Record<string, number>
  holes: Record<string, number>
  tech: number[]
}
function outcome(spec: SpecLike): Outcome {
  const v = validatePlanSpecDetailed(spec as unknown as PlanSpec)
  const codes = [...new Set(v.issues.filter((i) => i.severity === 'error' || /BUILT_SHAPE|DANGLING/.test(i.code)).map((i) => `${i.severity}:${i.code}`))].sort().join(' ')
  const res = compilePlanSpecDetailed(parsePlanSpec(spec))
  const plan = derivePlan(res.doc, res.levelId)
  const area: Record<string, number> = {}
  const holes: Record<string, number> = {}
  for (const r of spec.rooms) {
    const f = plan.rooms.find((x) => x.roomId === res.roomIds[r.id])
    area[r.id] = f ? f.area : -1
    holes[r.id] = f ? f.holes.length : -1
  }
  const tech = plan.rooms.filter((f) => res.doc.rooms[f.roomId]?.technical).map((f) => f.area).sort((a, b) => a - b)
  return { ok: v.ok, codes, area, holes, tech }
}
const same = (a: Outcome, b: Outcome): boolean =>
  a.ok === b.ok &&
  a.codes === b.codes &&
  Object.keys(a.area).every((id) => Math.abs(a.area[id] - b.area[id]) < 0.002 && a.holes[id] === b.holes[id]) &&
  a.tech.length === b.tech.length &&
  a.tech.every((t, i) => Math.abs(t - b.tech[i]) < 0.002)

/** the area of a ring, and of the part of a polygon inside a box (Sutherland–Hodgman, the box is convex) */
const ringArea = (p: P[]) => Math.abs(p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0)) / 2
function clipToBox(poly: P[], r: number[]): P[] {
  const [x0, y0, x1, y1] = [r[0], r[1], r[0] + r[2], r[1] + r[3]]
  const planes: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ]
  let out = poly
  for (const [inside, cut] of planes) {
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const a = src[i]
      const b = src[(i + 1) % src.length]
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b))
        out.push(b)
      } else if (inside(a)) out.push(cut(a, b))
    }
    if (!out.length) break
  }
  return out
}
/** each room's area as the same plan without cutouts is built, less its cutouts */
function expectedAreas(spec: SpecLike): Record<string, number> {
  const plain = JSON.parse(JSON.stringify(spec)) as SpecLike
  for (const r of plain.rooms) delete r.cutouts
  const built = outcome(plain).area
  const o: Record<string, number> = {}
  for (const r of spec.rooms) {
    const [x, y, w, h] = r.rect ?? [0, 0, 0, 0]
    const poly: P[] = r.polygon ?? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    o[r.id] = built[r.id] - (r.cutouts ?? []).reduce((s, c) => s + (clipToBox(poly, c.rect).length >= 3 ? ringArea(clipToBox(poly, c.rect)) : 0), 0) / 1e6
  }
  return o
}

const MISREADS = [-20, -10, 0, 10, 20]

describe('planspec cutouts: the same in every orientation', () => {
  for (const [name, [spec, k, opens]] of Object.entries(SCENARIOS)) {
    it(name, { timeout: 60_000 }, () => {
      const shifts = k >= 0 ? MISREADS.flatMap((dx) => MISREADS.map((dy) => [dx, dy])) : [[0, 0]]
      for (const [dx, dy] of shifts) {
        const outs = [0, 1, 2, 3, 4, 5, 6, 7].map((o) => outcome(turned(spec, o, k, dx, dy)))
        const at = `misread (${dx}, ${dy})`
        for (let o = 1; o < 8; o++) if (!same(outs[0], outs[o])) expect(outs[o], `${at}, orientation ${o}`).toEqual(outs[0])
        expect(outs[0].ok, `${at}: gate`).toBe(opens)
        if (dx === 0 && dy === 0 && opens) {
          const want = expectedAreas(turned(spec, 0))
          for (const id of Object.keys(want)) expect(outs[0].area[id], `room ${id}`).toBeCloseTo(want[id], 2)
        }
      }
    })
  }
})
