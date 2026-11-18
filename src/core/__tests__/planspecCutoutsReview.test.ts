// Regressions for the review of cutouts (shafts, boxes, columns) in rooms-mode PlanSpec: each case
// is a spec the validator passed as «ok» while the built .doplan had other areas or extra walls
import { describe, expect, it } from 'vitest'
import { summarizeLevelRooms } from '../area'
import { derivePlan } from '../derive'
import { parseDoc, serializeDoc } from '../io'
import { addRectRoom, addWall, moveNode, moveNodes, normalize, removeEntities, syncRooms } from '../ops'
import { newId } from '../ids'
import { remapVoidNodes } from '../rooms'
import { createEmptyDoc } from '../defaults'
import { compileCutoutSpec, docToPlanSpec, parsePlanSpec, validateCutoutSpec, type PlanSpec } from '../planspec'
import { DOC_VERSION, DOC_VERSION_V4 } from '../types'
import { docFormatVersion } from '../variants'

const base = (rooms: unknown[], extra: Record<string, unknown> = {}): PlanSpec =>
  ({
    version: 1,
    units: 'mm',
    defaults: { exteriorThickness: 300 },
    rooms,
    openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }],
    ...extra,
  }) as unknown as PlanSpec

// the cutout compiler itself (compileCutoutSpec / validateCutoutSpec); the public entry sends plans
// without cutouts to the base code and falls back to it when only the base accepts a plan
const build = (spec: unknown) => {
  const res = compileCutoutSpec(parsePlanSpec(spec))
  const plan = derivePlan(res.doc, res.levelId)
  const face = (id: string) => plan.rooms.find((f) => f.roomId === res.roomIds[id])
  const walls = Object.values(res.doc.walls).map((w) => ({ t: w.thickness, pa: res.doc.nodes[w.a], pb: res.doc.nodes[w.b] }))
  return { res, plan, face, walls }
}
/** a technical void far away: the cutout geometry of the faces works on a level with a void, and a plan
 *  without one goes to the base code anyway; plain corners of the cutout compiler are checked with it */
const FAR_VOID = { id: 'z', type: 'other', rect: [40000, 40000, 600, 600], technical: true }
const errors = (spec: unknown) => validateCutoutSpec(spec as PlanSpec).issues.filter((i) => i.severity === 'error')
/** an L-room: 4×3 m without the 2×1 m notch at the top right (9.64 m² of floor with a 0.6 m shaft) */
const L = [[0, 0], [2000, 0], [2000, 1000], [4000, 1000], [4000, 3000], [0, 3000]]

describe('planspec cutouts: review findings', () => {
  it('#1 a corner column does not push its wall into the next room', () => {
    const spec = base(
      [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.75, cutouts: [{ rect: [0, 2500, 500, 500], kind: 'column' }] },
        { id: 'b', type: 'bedroom', rect: [0, 3100, 4000, 3000], labelledArea: 12 },
      ],
      { openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }, { type: 'door', at: [2000, 3050], width: 800 }] },
    )
    expect(errors(spec)).toEqual([])
    const { face, walls } = build(spec)
    expect(face('a')?.area).toBeCloseTo(11.75, 2)
    expect(face('b')?.area).toBeCloseTo(12, 2)
    // nothing thicker than the partition reaches past the shared wall (y 3000…3100) into the bedroom
    expect(walls.some((w) => w.t > 200 && Math.max(w.pa.y, w.pb.y) > 3100 && Math.min(w.pa.y, w.pb.y) < 3100 && Math.min(w.pa.x, w.pb.x) < 600 && Math.min(w.pa.x, w.pb.x) > -100)).toBe(false)
  })

  it('#1 a column in a loggia corner does not go through the parapet', () => {
    const spec = base(
      [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 12 },
        { id: 'l', type: 'loggia', rect: [0, 3300, 4000, 1000], labelledArea: 3.75, edgeWall: { kind: 'parapet' }, cutouts: [{ rect: [0, 3800, 500, 500], kind: 'column' }] },
      ],
      { openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }, { type: 'balconyDoor', at: [2000, 3150], width: 800 }] },
    )
    expect(errors(spec)).toEqual([])
    expect(build(spec).face('l')?.area).toBeCloseTo(3.75, 2)
  })

  it('#2 a shaft touching the reflex corner of an L-room is subtracted', () => {
    const spec = base([{ id: 'a', type: 'living', polygon: L, labelledArea: 9.64, cutouts: [{ rect: [1400, 1000, 600, 600] }] }])
    expect(errors(spec)).toEqual([])
    expect(build(spec).face('a')?.area).toBeCloseTo(9.64, 2)
  })

  it('#3 a shaft of 1 m² or more is a technical void: kept out of every total', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 4000], labelledArea: 13.75, cutouts: [{ rect: [0, 0, 1500, 1500], kind: 'shaft' }] }], {
      source: { labelledTotalArea: 13.75 },
    })
    const v = validateCutoutSpec(spec)
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(v.metrics.totalArea).toBeCloseTo(13.75, 2)
    const { res, plan } = build(spec)
    const voidRoom = Object.values(res.doc.rooms).find((r) => r.type === 'other')
    expect(voidRoom?.technical).toBe(true)
    // the void face is over 1 m², yet the app's summary leaves it out
    expect(plan.rooms.find((f) => f.roomId === voidRoom?.id)!.area).toBeGreaterThan(1)
    expect(summarizeLevelRooms(res.doc, plan.rooms).total).toBeCloseTo(13.75, 2)
  })

  it('#3 the technical flag survives saving and loading the project', () => {
    const { res } = build(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 4000], cutouts: [{ rect: [0, 0, 1500, 1500] }] }]))
    const back = parseDoc(JSON.parse(serializeDoc(res.doc)))
    expect(Object.values(back.rooms).filter((r) => r.technical)).toHaveLength(1)
  })

  it('#4 a cutout a few mm outside the outline snaps onto it (no open room)', () => {
    for (const cut of [
      [0, -10, 600, 1010],
      [-10, 0, 610, 1000],
    ]) {
      const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, cutouts: [{ rect: cut }] }])
      const v = validateCutoutSpec(spec)
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([])
      expect(v.issues.some((i) => i.code === 'CUTOUT_SNAPPED')).toBe(true)
      expect(build(spec).face('a')?.area).toBeCloseTo(11.4, 2)
    }
  })

  it('#4 the snapped cutout next to a neighbour room builds both rooms', () => {
    const spec = base(
      [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, cutouts: [{ rect: [-10, 0, 610, 1000] }] },
        { id: 'b', type: 'bedroom', rect: [-3120, 0, 3000, 3000], labelledArea: 9 },
      ],
      { openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }, { type: 'door', at: [-60, 2000], width: 800 }] },
    )
    expect(errors(spec)).toEqual([])
    const { face } = build(spec)
    expect(face('a')?.area).toBeCloseTo(11.4, 2)
    expect(face('b')?.area).toBeCloseTo(9, 2)
  })

  it('#4 a cutout clearly outside the room is still reported', () => {
    const v = validateCutoutSpec(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [3800, 0, 600, 600] }] }]))
    expect(v.issues.some((i) => i.code === 'CUTOUT_OUTSIDE')).toBe(true)
  })

  it('#5 overlapping cutouts are an overlap error, not a false «outside»', () => {
    const v = validateCutoutSpec(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000] }, { rect: [400, 0, 600, 600] }] }]))
    const codes = v.issues.filter((i) => i.severity === 'error').map((i) => i.code)
    expect(codes).toContain('CUTOUT_OVERLAP')
    expect(codes).not.toContain('CUTOUT_OUTSIDE')
  })

  it('#6 partially adjacent cutouts build no wall into the floor', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000] }, { rect: [600, 0, 600, 600] }] }])
    expect(errors(spec)).toEqual([])
    expect(validateCutoutSpec(spec).metrics.perRoom[0].computed).toBeCloseTo(11.04, 2)
    expect(build(spec).face('a')?.area).toBeCloseTo(11.04, 2)
  })

  it('#7 the dp doc spec round trip of a project with cutouts validates (voids stay technical)', () => {
    const spec = base(
      [{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 10.8, cutouts: [{ rect: [0, 0, 600, 1000], kind: 'shaft' }, { rect: [600, 0, 600, 1000], kind: 'box' }] }],
      { source: { labelledTotalArea: 10.8 } },
    )
    const { res } = build(spec)
    const back = docToPlanSpec(res.doc, res.levelId)
    const tech = back.rooms.filter((r) => r.technical)
    expect(tech).toHaveLength(2)
    expect(tech.every((r) => r.labelledArea === undefined)).toBe(true)
    const v = validateCutoutSpec(back)
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(v.metrics.totalArea).toBeCloseTo(10.8, 2)
    const again = build(back)
    expect(summarizeLevelRooms(again.res.doc, again.plan.rooms).total).toBeCloseTo(10.8, 2)
  })

  it('#8 a cutout at the inner walls of a reflex corner continues the outline wall', () => {
    const cases: [number[], number][] = [
      [[2000, 1000, 600, 600], 9.64],
      [[2000, 1000, 750, 1000], 9.25],
      [[1100, 200, 900, 800], 9.28],
    ]
    for (const [cut, area] of cases) {
      const spec = base([{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: cut, kind: 'column' }] }])
      expect(errors(spec)).toEqual([])
      expect(build(spec).face('a')?.area).toBeCloseTo(area, 2)
    }
  })

  it('#9 a blank areaNote explains nothing', () => {
    const v = validateCutoutSpec(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, areaNote: '  ' }]))
    const m = v.issues.find((i) => i.code === 'AREA_MISMATCH')
    expect(m?.severity).toBe('error')
    expect(m?.message).not.toMatch(/объяснено/)
    expect(v.metrics.perRoom[0].note).toBeUndefined()
  })

  it('two cutouts with floor between them are two walls, not one wall over the floor', () => {
    const variants = [
      [{ rect: [0, 600, 1300, 1100] }, { rect: [0, 2150, 1300, 850], kind: 'box' }],
      [{ rect: [0, 0, 1100, 1150], kind: 'box' }, { rect: [1000, 1550, 600, 1450], kind: 'box' }],
    ]
    for (const cutouts of variants) {
      const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts }])
      expect(errors(spec)).toEqual([])
      const computed = validateCutoutSpec(spec).metrics.perRoom[0].computed
      // computed is rounded to 0.01 m²; the bug swallowed 0.6 … 1.9 m²
      expect(Math.abs(build(spec).face('a')!.area - computed)).toBeLessThan(0.01)
    }
  })

  it('a built floor that differs from the checked shape is reported (a corner notch only warns)', () => {
    // two rows of rooms with offset gaps: r1's outline used to fold over the junction (10.42 m²); the fold
    // is cut off now and every room is exact
    const rows = base([
      { id: 'r0', type: 'bedroom', rect: [0, 0, 2300, 3250] },
      { id: 'r1', type: 'living', rect: [2500, 0, 2900, 3600] },
      { id: 's0', type: 'bedroom', rect: [150, 3720, 2050, 2200] },
      { id: 's1', type: 'bedroom', rect: [2300, 3720, 1500, 2950] },
      FAR_VOID,
    ])
    expect(validateCutoutSpec(rows).issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
    const res = compileCutoutSpec(parsePlanSpec(rows))
    expect(derivePlan(res.doc, res.levelId).rooms.find((f) => f.roomId === res.roomIds.r1)?.area).toBeCloseTo(10.44, 4)
    // three rooms at a building corner, 380 mm walls: a 30 mm step at the junction (≈0.008 m²) warns
    const v = validateCutoutSpec({
      ...base([
        { id: 'a', type: 'living', rect: [0, 0, 4900, 2800] },
        { id: 'b', type: 'bedroom', rect: [-2400, 100, 2300, 2600] },
        { id: 'c', type: 'kitchen', rect: [0, -2370, 4800, 2250] },
        FAR_VOID,
      ]),
      defaults: { exteriorThickness: 380 },
    } as PlanSpec)
    const m = v.issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')
    expect(m.length).toBeGreaterThan(0)
    expect(m.every((i) => i.severity === 'warning')).toBe(true)
  })
})

describe('planspec cutouts: review round 2', () => {
  const T = (t: number, rooms: unknown[]) =>
    ({ version: 1, units: 'mm', defaults: { exteriorThickness: t, partitionThickness: 100, loadBearingThickness: 200 }, rooms, openings: [] }) as unknown as PlanSpec
  const rectArea = (r: { rect?: number[] }) => (r.rect![2] * r.rect![3]) / 1e6
  const nb = { id: 'b', type: 'bathroom', rect: [2100, 0, 1900, 900] }
  const shapeErrors = (spec: unknown) => errors(spec).filter((i) => i.code !== 'NO_ENTRANCE')

  it('#12 plans without cutouts build exactly with 380–640 mm exterior walls (no false BUILT_SHAPE_MISMATCH)', () => {
    const layouts: { id: string; type: string; rect: number[] }[][] = [
      [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000] },
        { id: 'b', type: 'bedroom', rect: [4100, 500, 3000, 2000] },
      ],
      [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 4000] },
        { id: 'k', type: 'kitchen', rect: [4000, 0, 2500, 3000] },
      ],
      [
        { id: 'h', type: 'hallway', rect: [0, 0, 1200, 6000] },
        { id: 'l', type: 'living', rect: [-4100, 0, 4000, 3500] },
        { id: 'r', type: 'bedroom', rect: [1300, 1000, 3500, 3000] },
      ],
    ]
    for (const t of [300, 380, 510, 640])
      for (const rooms of layouts) {
        const spec = T(t, rooms)
        expect(shapeErrors(spec).map((i) => i.code)).toEqual([])
        const { face } = build(spec)
        for (const r of rooms) expect(face(r.id)?.area).toBeCloseTo(rectArea(r), 2)
      }
  })

  it('#12 an L-room with a bathroom in its notch builds exactly with thick exterior walls', () => {
    for (const t of [300, 380, 510, 640]) {
      const spec = T(t, [{ id: 'a', type: 'living', polygon: L }, nb])
      expect(shapeErrors(spec)).toEqual([])
      const { face } = build(spec)
      expect(face('a')?.area).toBeCloseTo(10, 2)
      expect(face('b')?.area).toBeCloseTo(1.71, 2)
    }
  })

  it('#12 a tight two-row layout with 640 mm walls stays closed', () => {
    const spec = T(640, [
      { id: 'r0', type: 'hallway', rect: [0, -200, 1750, 2100] },
      { id: 'r1', type: 'hallway', rect: [1870, 0, 2200, 2650] },
      { id: 'r2', type: 'hallway', rect: [4070, 400, 1750, 3400] },
      { id: 'r3', type: 'bathroom', rect: [5820, -250, 3150, 3400] },
      { id: 's0', type: 'bedroom', rect: [-50, 4000, 2200, 1600] },
      { id: 's1', type: 'bedroom', rect: [2250, 4000, 3150, 2250] },
    ])
    const codes = validateCutoutSpec(spec).issues.map((i) => i.code)
    expect(codes).not.toContain('ROOM_OPEN')
    expect(codes).not.toContain('ROOM_MERGED')
  })

  it('#1 #2 a cutout misread 10–20 mm off a reflex vertex snaps onto it', () => {
    const cases: [number[], number, number][] = [
      // [rect, built floor, holes]
      [[1990, 1000, 600, 600], 9.646, 0],
      [[1410, 1000, 600, 600], 9.646, 1],
      [[1400, 990, 600, 600], 9.646, 1],
      [[1420, 1000, 600, 600], 9.652, 1],
    ]
    for (const [cut, area, holes] of cases) {
      const spec = base([{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: cut }] }])
      const v = validateCutoutSpec(spec)
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([])
      expect(v.issues.some((i) => i.code === 'CUTOUT_SNAPPED')).toBe(true)
      expect(v.issues.some((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toBe(false)
      const f = build(spec).face('a')!
      expect(f.area).toBeCloseTo(area, 3)
      expect(f.holes).toHaveLength(holes)
    }
  })

  it('#3 #5 a cutout at a reflex corner shared with a neighbour keeps the partition (no 300 mm stubs)', () => {
    for (const cut of [
      [2000, 1000, 600, 600],
      [1400, 400, 600, 600],
    ]) {
      const spec = T(300, [{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: cut, kind: 'shaft' }] }, nb])
      const v = validateCutoutSpec(spec)
      expect(v.issues.filter((i) => ['BUILT_SHAPE_MISMATCH', 'DANGLING_WALL'].includes(i.code))).toEqual([])
      const { res, plan, face, walls } = build(spec)
      expect(face('a')?.area).toBeCloseTo(9.64, 2)
      expect(face('b')?.area).toBeCloseTo(1.71, 2)
      const shaft = Object.values(res.doc.rooms).find((r) => r.technical)!
      expect(plan.rooms.find((f) => f.roomId === shaft.id)?.area).toBeCloseTo(0.2, 2)
      // every wall around the shaft (inside the L's bounding box, off the outline) is a partition
      const inner = walls.filter((w) => [w.pa, w.pb].every((p) => p.x > 100 && p.x < 3900 && p.y > 100 && p.y < 2900))
      expect(inner.every((w) => w.t <= 100)).toBe(true)
    }
  })

  it('#4 a column partly next to a shaft stays solid to its box', () => {
    for (const cutouts of [
      [{ rect: [0, 0, 600, 1000], kind: 'column' }, { rect: [600, 0, 600, 600], kind: 'shaft' }],
      [{ rect: [0, 0, 600, 600], kind: 'shaft' }, { rect: [600, 0, 600, 1000], kind: 'column' }],
    ]) {
      const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts }])
      const v = validateCutoutSpec(spec)
      expect(v.issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
      expect(v.metrics.perRoom[0].computed).toBeCloseTo(11.04, 2)
      expect(build(spec).face('a')?.area).toBeCloseTo(11.04, 2)
    }
  })

  it('#6 a corner column or shaft with neighbours on both sides pokes into neither', () => {
    for (const cut of [
      { rect: [3600, 2600, 400, 400], kind: 'column' },
      { rect: [3400, 2400, 600, 600] },
    ]) {
      const spec = T(300, [
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [cut] },
        { id: 'b', type: 'bedroom', rect: [4100, 0, 3000, 3000] },
        { id: 'c', type: 'bedroom', rect: [0, 3100, 4000, 2000] },
      ])
      expect(validateCutoutSpec(spec).issues.filter((i) => ['BUILT_SHAPE_MISMATCH', 'DANGLING_WALL'].includes(i.code))).toEqual([])
      const { face } = build(spec)
      expect(face('b')?.area).toBeCloseTo(9, 2)
      expect(face('c')?.area).toBeCloseTo(8, 2)
    }
  })

  it('#7 two partly touching shafts mid-room: no false hole-count error, two shafts with their own walls', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [1000, 1000, 500, 500] }, { rect: [1500, 1200, 500, 500] }] }])
    const v = validateCutoutSpec(spec)
    expect(v.issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
    expect(v.ok).toBe(true)
    const { res, face } = build(spec)
    expect(face('a')?.area).toBeCloseTo(11.5, 2)
    // staggered cutouts (neither side lies in full on the other) are two cutouts, walls back to back
    const shafts = Object.values(res.doc.rooms).filter((r) => r.technical)
    expect(shafts).toHaveLength(2)
    expect(shafts.every((r) => r.name === 'Шахта' && r.type === 'other')).toBe(true)
  })

  it('#7 a column sharing 1–25 mm of side with a shaft flush to the outline passes, in every orientation (night review 3)', () => {
    const turn = (r: number[], o: number): number[] => {
      const f = ([x, y]: number[]): number[] => {
        const [mx, my] = o >= 4 ? [-x, y] : [x, y]
        const k = o % 4
        return k === 0 ? [mx, my] : k === 1 ? [-my, mx] : k === 2 ? [-mx, -my] : [my, -mx]
      }
      const [a, b] = [f([r[0], r[1]]), f([r[0] + r[2], r[1] + r[3]])]
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]
    }
    for (const ov of [1, 5, 10, 15, 20, 25])
      for (let o = 0; o < 8; o++) {
        const s = parsePlanSpec({
          version: 1,
          units: 'mm',
          defaults: { exteriorThickness: 300, partitionThickness: 100, loadBearingThickness: 200 },
          rooms: [
            {
              id: 'a',
              type: 'living',
              rect: turn([0, 0, 3750, 5150], o),
              cutouts: [
                { rect: turn([2700, 2730, 500, 1100], o), kind: 'column' },
                { rect: turn([3200 - ov, 3830, 550 + ov, 650], o), kind: 'shaft' },
              ],
            },
          ],
          openings: [],
        })
        const v = validateCutoutSpec(s)
        expect(v.ok, `ov ${ov}, orientation ${o}: ${v.issues.map((i) => i.message).join('; ')}`).toBe(true)
        const res = compileCutoutSpec(s)
        const a = derivePlan(res.doc, res.levelId).rooms.find((x) => x.roomId === res.roomIds.a)!
        expect(a.area, `ov ${ov}, orientation ${o}`).toBeCloseTo(3.75 * 5.15 - 0.55 - ((550 + ov) / 1000) * 0.65, 2)
      }
  })

  it('#7 a hole really missing from the built floor is still an error', () => {
    // a cutout that cannot become a hole (its void is swallowed) must not pass as two touching holes
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [1000, 1000, 500, 500] }] }])
    expect(validateCutoutSpec(spec).issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
    expect(build(spec).face('a')?.holes).toHaveLength(1)
  })

  it('#8 removing the walls of a centred shaft gives the floor back to the room', () => {
    for (const cut of [
      [1900, 1900, 1200, 1200],
      [1000, 1000, 2000, 2000],
    ]) {
      const { res } = build({ version: 1, units: 'mm', rooms: [{ id: 'a', type: 'living', rect: [0, 0, 5000, 5000], cutouts: [{ rect: cut, kind: 'shaft' }] }], openings: [] })
      const doc = res.doc
      const [x, y, w, h] = cut
      const inside = (p: { x: number; y: number }) => p.x > x - 1 && p.x < x + w + 1 && p.y > y - 1 && p.y < y + h + 1
      const shaftWalls = Object.values(doc.walls).filter((wl) => inside(doc.nodes[wl.a]) && inside(doc.nodes[wl.b]))
      expect(shaftWalls.length).toBeGreaterThan(0)
      removeEntities(
        doc,
        shaftWalls.map((wl) => ({ kind: 'wall' as const, id: wl.id })),
      )
      normalize(doc)
      syncRooms(doc)
      const plan = derivePlan(doc, res.levelId)
      expect(plan.rooms).toHaveLength(1)
      const rec = doc.rooms[plan.rooms[0].roomId]
      expect(rec.technical).toBeFalsy()
      expect(rec.type).toBe('living')
      expect(summarizeLevelRooms(doc, plan.rooms).total).toBeCloseTo(25, 2)
    }
  })

  it('#10 a project with technical voids is saved as format 4, which older readers refuse', () => {
    const { res } = build(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 4000], cutouts: [{ rect: [0, 0, 1500, 1500] }] }]))
    expect(docFormatVersion(res.doc)).toBe(DOC_VERSION_V4)
    const raw = JSON.parse(serializeDoc(res.doc))
    expect(raw.version).toBe(DOC_VERSION_V4)
    // this app reads it back with the flag
    expect(Object.values(parseDoc(raw).rooms).filter((r) => r.technical)).toHaveLength(1)
    // a plan without cutouts keeps the old format
    expect(docFormatVersion(build(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 4000] }])).res.doc)).toBe(DOC_VERSION)
  })

  it('#11 a void left beside a thick continued outline wall is still a named technical void', () => {
    const cases: [PlanSpec, string][] = [
      [T(500, [{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: [2000, 1000, 600, 600], kind: 'shaft' }] }]), 'Шахта'],
      [base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000], kind: 'column' }, { rect: [600, 0, 600, 1000], kind: 'shaft' }] }]), 'Колонна'],
    ]
    for (const [spec, name] of cases) {
      const { res, plan, face } = build(spec)
      expect(face('a')).toBeDefined()
      // no face without a record: every void face is a named, technical room
      for (const f of plan.rooms) expect(res.doc.rooms[f.roomId]).toBeDefined()
      const tech = Object.values(res.doc.rooms).filter((r) => r.technical)
      expect(tech.map((r) => r.name)).toContain(name)
    }
  })

  it('#13 a cutout whose side crosses a reflex corner is reported as such, not as an open room', () => {
    const L2 = [[0, 0], [3000, 0], [3000, 2000], [6000, 2000], [6000, 5000], [0, 5000]]
    for (const cut of [
      [2400, 2000, 1200, 600],
      [2700, 1000, 300, 2000],
    ]) {
      const codes = errors(base([{ id: 'a', type: 'living', polygon: L2, cutouts: [{ rect: cut }] }])).map((i) => i.code)
      expect(codes).toContain('CUTOUT_AT_CORNER')
      expect(codes).not.toContain('ROOM_OPEN')
    }
    // the same cutout kept on one side of the corner line builds
    expect(errors(base([{ id: 'a', type: 'living', polygon: L2, cutouts: [{ rect: [3000, 2000, 600, 600] }] }]))).toEqual([])
  })
})

describe('planspec cutouts: review round 3', () => {
  it('#8 dragging the walls of an island shaft keeps it technical and the room around it real', () => {
    for (const d of [0, 700, 800, 900, 1000, 1100]) {
      const { res } = build({ version: 1, units: 'mm', defaults: { exteriorThickness: 300 }, rooms: [{ id: 'a', type: 'living', rect: [0, 0, 5000, 5000], cutouts: [{ rect: [1000, 1000, 2400, 2400], kind: 'shaft' }] }], openings: [] })
      const doc = res.doc
      syncRooms(doc)
      const inside = (p: { x: number; y: number }) => p.x > 999 && p.x < 3401 && p.y > 999 && p.y < 3401
      const nodes = new Set<string>()
      for (const wl of Object.values(doc.walls)) if (inside(doc.nodes[wl.a]) && inside(doc.nodes[wl.b])) nodes.add(wl.a).add(wl.b)
      expect(nodes.size).toBe(4)
      // the select tool's drag: nodes move, room anchors stay, the commit normalizes and syncs once
      for (const id of nodes) moveNode(doc, id, doc.nodes[id].x + d, doc.nodes[id].y + d)
      normalize(doc)
      syncRooms(doc)
      const plan = derivePlan(doc, res.levelId)
      const sum = summarizeLevelRooms(doc, plan.rooms)
      expect(sum.total).toBeCloseTo(19.24, 2)
      const recs = plan.rooms.map((f) => doc.rooms[f.roomId])
      expect(recs.filter((r) => r?.technical)).toHaveLength(1)
      // at +700 the room anchor falls inside a moved wall and the record is lost (as before this rule)
      if (d !== 700) expect(recs.find((r) => !r?.technical)?.type).toBe('living')
      expect(docFormatVersion(doc)).toBe(DOC_VERSION_V4)
    }
  })
})

describe('editor: technical voids and islands, review round 4', () => {
  /** a 5000×4000 room (200 mm walls) with a 1500×1500 island (100 mm walls) at 500,500 marked technical */
  const roomWithShaft = () => {
    const doc = createEmptyDoc()
    const lv = doc.levelOrder[0]
    addRectRoom(doc, lv, 0, 0, 5000, 4000, { thickness: 200 })
    const islandWalls = addRectRoom(doc, lv, 500, 500, 1500, 1500, { thickness: 100 })
    normalize(doc)
    syncRooms(doc)
    const plan = derivePlan(doc, lv)
    const shaft = plan.rooms.find((f) => Math.abs(f.area - 1.96) < 0.01)!
    const room = plan.rooms.find((f) => Math.abs(f.area - 15.68) < 0.01)!
    doc.rooms[shaft.roomId].technical = true
    Object.assign(doc.rooms[room.roomId], { type: 'living', name: 'Гостиная' })
    normalize(doc)
    syncRooms(doc)
    const nodes = new Set<string>()
    for (const id of islandWalls) nodes.add(doc.walls[id].a).add(doc.walls[id].b)
    return { doc, lv, nodes, roomAnchor: { ...doc.rooms[room.roomId].anchor }, shaftAnchor: { ...doc.rooms[shaft.roomId].anchor } }
  }
  const dragAndCommit = (doc: ReturnType<typeof createEmptyDoc>, nodes: Set<string>, dx: number, dy: number) => {
    moveNodes(doc, new Map([...nodes].map((id) => [id, { x: doc.nodes[id].x + dx, y: doc.nodes[id].y + dy }])))
    normalize(doc)
    syncRooms(doc)
  }

  it('#17 dragging the shaft island onto the room label keeps the room real and the shaft technical', () => {
    const { doc, lv, nodes, roomAnchor, shaftAnchor } = roomWithShaft()
    dragAndCommit(doc, nodes, roomAnchor.x - shaftAnchor.x, roomAnchor.y - shaftAnchor.y)
    const plan = derivePlan(doc, lv)
    const sum = summarizeLevelRooms(doc, plan.rooms)
    expect(sum.total).toBeCloseTo(15.68, 2)
    expect(sum.technicalCount).toBe(1)
    const big = plan.rooms.find((f) => Math.abs(f.area - 15.68) < 0.01)!
    expect(doc.rooms[big.roomId].name).toBe('Гостиная')
    expect(doc.rooms[big.roomId].technical).toBeFalsy()
  })

  it('#18 a drag of any size keeps the technical flag (and the area total)', () => {
    for (const [dx, dy] of [[0, 1700], [1700, 0], [2400, 1700], [800, 800], [-300, 1500], [2000, 0]]) {
      const { doc, lv, nodes } = roomWithShaft()
      dragAndCommit(doc, nodes, dx, dy)
      const plan = derivePlan(doc, lv)
      const sum = summarizeLevelRooms(doc, plan.rooms)
      expect(sum.total, `${dx},${dy}`).toBeCloseTo(15.68, 2)
      expect(sum.technicalCount, `${dx},${dy}`).toBe(1)
      expect(sum.count, `${dx},${dy}`).toBe(1)
    }
  })

  it('#18 removing the shaft walls returns the floor to the room (no room-sized shaft)', () => {
    const { doc, lv, nodes } = roomWithShaft()
    const ids = Object.values(doc.walls).filter((w) => nodes.has(w.a) || nodes.has(w.b)).map((w) => ({ kind: 'wall' as const, id: w.id }))
    removeEntities(doc, ids)
    normalize(doc)
    syncRooms(doc)
    const sum = summarizeLevelRooms(doc, derivePlan(doc, lv).rooms)
    expect(sum.technicalCount).toBe(0)
    expect(sum.total).toBeCloseTo(4.8 * 3.8, 2)
  })

  it('#17/#18 the void nodes survive a save and load', () => {
    const { doc, lv, nodes, roomAnchor, shaftAnchor } = roomWithShaft()
    const again = parseDoc(serializeDoc(doc))
    dragAndCommit(again, nodes, roomAnchor.x - shaftAnchor.x, roomAnchor.y - shaftAnchor.y)
    const sum = summarizeLevelRooms(again, derivePlan(again, lv).rooms)
    expect(sum.total).toBeCloseTo(15.68, 2)
    expect(sum.technicalCount).toBe(1)
  })

  it('#19 an island whose wall overlaps the room wall is still a hole of the room, on every side', () => {
    for (const off of [50, 100, 120, 140]) {
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const doc = createEmptyDoc()
        const lv = doc.levelOrder[0]
        addRectRoom(doc, lv, 0, 0, 5000, 4000, { thickness: 200 })
        const at = { left: [off, 1500], right: [5000 - off - 800, 1500], top: [2000, off], bottom: [2000, 4000 - off - 800] }[side]
        addRectRoom(doc, lv, at[0], at[1], 800, 800, { thickness: 100 })
        normalize(doc)
        const plan = derivePlan(doc, lv)
        const room = plan.rooms.reduce((a, b) => (a.area > b.area ? a : b))
        expect(room.holes, `${side} ${off}`).toHaveLength(1)
        // 4.8 × 3.8 minus the box footprint (900 × 900, as before the overlap rule)
        expect(room.area, `${side} ${off}`).toBeCloseTo(18.24 - 0.81, 2)
      }
    }
  })

  // night review 3 #2: a void keeps all its nodes on the room face that took its floor when one of
  // its walls goes (4 of that face's 8 nodes), and so took the whole room, deleting the room record
  it('removing any one wall of a void gives its floor to the room beside it (never the room to the void)', () => {
    const CASES: [string, unknown, string][] = [
      ['box at the exterior wall', { version: 1, units: 'mm', defaults: { exteriorThickness: 300, partitionThickness: 100 }, rooms: [{ id: 'a', type: 'kitchen', name: 'Кухня', rect: [0, 0, 3000, 3000], cutouts: [{ rect: [1000, 2400, 800, 600], kind: 'box' }] }], openings: [] }, 'Кухня'],
      ['shaft at the exterior wall', { version: 1, units: 'mm', defaults: { exteriorThickness: 300, partitionThickness: 100 }, rooms: [{ id: 'a', type: 'living', name: 'Гостиная', rect: [0, 0, 4000, 4000], cutouts: [{ rect: [1000, 0, 1500, 1000], kind: 'shaft' }] }], openings: [] }, 'Гостиная'],
      ['box at the partition to a hall', { version: 1, units: 'mm', defaults: { exteriorThickness: 300, partitionThickness: 100 }, rooms: [{ id: 'a', type: 'bathroom', name: 'Санузел', rect: [0, 0, 2000, 2000], cutouts: [{ rect: [600, 1500, 800, 500], kind: 'box' }] }, { id: 'b', type: 'hall', name: 'Коридор', rect: [0, 2100, 2000, 1500] }], openings: [] }, 'Коридор'],
      // night review 4 #1/#7: a neighbour smaller than the void (the merged face is under the size gate)
      ...([[1500, 600, 'bathroom', 'Туалет'], [1500, 600, 'wardrobe', 'Гардеробная'], [1500, 600, 'storage', 'Кладовая'], [1200, 800, 'storage', 'Кладовая'], [1000, 600, 'storage', 'Кладовая']] as const).map(
        ([w, h, type, nm]): [string, unknown, string] => [
          `a ${w}×${h} ${type} beside a shaft`,
          { version: 1, units: 'mm', defaults: { exteriorThickness: 300, partitionThickness: 100 }, rooms: [{ id: 'a', type: 'kitchen', name: 'Кухня', rect: [0, 0, 3000, 3000], cutouts: [{ rect: [1000, 2000, 1500, 1000], kind: 'shaft' }] }, { id: 'b', type, name: nm, rect: [750, 3100, w, h] }], openings: [] },
          nm,
        ],
      ),
    ]
    for (const [name, spec, keep] of CASES) {
      const res = compileCutoutSpec(parsePlanSpec(spec))
      const doc = parseDoc(serializeDoc(res.doc))
      normalize(doc)
      syncRooms(doc)
      const lv = res.levelId
      const plan = derivePlan(doc, lv)
      const before = summarizeLevelRooms(doc, plan.rooms)
      const voidFace = plan.rooms.find((f) => doc.rooms[f.roomId]?.technical)!
      expect(voidFace, name).toBeTruthy()
      for (const wid of [...new Set(voidFace.edges.map((e) => e.wallId))]) {
        const d = structuredClone(doc)
        removeEntities(d, [{ kind: 'wall', id: wid }])
        normalize(d)
        syncRooms(d)
        const faces = derivePlan(d, lv).rooms
        const sum = summarizeLevelRooms(d, faces)
        const tag = `${name}, wall ${wid}`
        expect(sum.count, tag).toBeGreaterThanOrEqual(before.count)
        // (the exterior wall behind it gone, the void is open to the street: outside, not floor)
        expect(sum.total, tag).toBeGreaterThanOrEqual(before.total - 1e-9)
        // (no face left to the void; a small closet may still count as technical by its size)
        expect(faces.filter((x) => d.rooms[x.roomId]?.technical).length, tag).toBe(0)
        const kept = faces.find((f) => d.rooms[f.roomId]?.name === keep)
        expect(kept, tag).toBeTruthy()
        expect(d.rooms[kept!.roomId].technical, tag).toBeFalsy()
      }
    }
  })
})

describe('planspec cutouts: dp doc spec round trip, review round 4', () => {
  const W = [{ type: 'window', at: [2000, 3150], width: 1200 }]
  const roundTrip = (spec: PlanSpec) => {
    const first = build(spec)
    const back = docToPlanSpec(first.res.doc, first.res.levelId)
    const again = build(back)
    const total = (b: ReturnType<typeof build>) => summarizeLevelRooms(b.res.doc, b.plan.rooms).total
    const tech = (b: ReturnType<typeof build>) => b.plan.rooms.filter((f) => b.res.doc.rooms[f.roomId]?.technical).length
    return { back, v: validateCutoutSpec(back), first, again, total, tech }
  }

  it('#6 a floor strip between two cutouts on one wall stays floor after the round trip', () => {
    const cases: [unknown[], number][] = [
      [[{ rect: [0, 600, 1300, 1100] }, { rect: [0, 2150, 1300, 850], kind: 'box' }], 9.47],
      [[{ rect: [0, 0, 600, 600], kind: 'shaft' }, { rect: [0, 1000, 600, 600], kind: 'shaft' }], 11.28],
    ]
    for (const [cutouts, area] of cases) {
      const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: area, cutouts }], { openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }, ...W] })
      const { back, v, first, again, total, tech } = roundTrip(spec)
      expect(back.walls!.some((w) => w.cutout)).toBe(true)
      expect(v.ok).toBe(true)
      expect(v.issues.filter((i) => i.severity !== 'info')).toEqual([])
      expect(total(again)).toBeCloseTo(total(first), 2)
      expect(total(again)).toBeCloseTo(area, 2)
      expect(again.plan.rooms).toHaveLength(first.plan.rooms.length)
      expect(tech(again)).toBe(2)
    }
  })

  it('#7 the round trip of a column raises no WALL_THICKNESS_ODD (dp spec build --strict takes it)', () => {
    const cases: unknown[][] = [
      [{ rect: [0, 0, 600, 1000], kind: 'column' }, { rect: [600, 0, 600, 600], kind: 'shaft' }],
      [{ rect: [0, 0, 600, 1000], kind: 'column' }, { rect: [600, 200, 600, 600], kind: 'shaft' }],
      [{ rect: [0, 0, 600, 1000], kind: 'column' }, { rect: [600, 0, 600, 1000], kind: 'shaft' }],
      [{ rect: [1500, 1200, 600, 600], kind: 'column' }],
    ]
    for (const cutouts of cases) {
      const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts }], { openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }, ...W] })
      const { v, first, again, total } = roundTrip(spec)
      expect(v.issues.filter((i) => i.severity !== 'info')).toEqual([])
      expect(total(again)).toBeCloseTo(total(first), 2)
    }
  })

  it('the exported spec keeps the exterior thickness of a 510 mm project', () => {
    const spec = { ...base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [3600, 1000, 400, 500], kind: 'column' }] }]), defaults: { exteriorThickness: 510 } } as PlanSpec
    const { back, v } = roundTrip(spec)
    expect(back.defaults?.exteriorThickness).toBe(510)
    expect(v.issues.filter((i) => i.code === 'WALL_THICKNESS_ODD')).toEqual([])
  })
})

describe('editor: technical voids copied, pasted and split, night review', () => {
  type D = ReturnType<typeof createEmptyDoc>
  /** a 5000×4000 room (200 mm walls) with a `s`×`s` shaft island (100 mm walls) at 500,500 */
  const roomWithShaft = (s = 1500) => {
    const doc = createEmptyDoc()
    const lv = doc.levelOrder[0]
    addRectRoom(doc, lv, 0, 0, 5000, 4000, { thickness: 200 })
    addRectRoom(doc, lv, 500, 500, s, s, { thickness: 100 })
    normalize(doc)
    syncRooms(doc)
    const plan = derivePlan(doc, lv)
    const shaft = plan.rooms.reduce((a, b) => (a.area < b.area ? a : b))
    doc.rooms[shaft.roomId].technical = true
    doc.rooms[shaft.roomId].name = 'Шахта'
    normalize(doc)
    syncRooms(doc)
    expect(doc.rooms[shaft.roomId].voidNodes?.length).toBe(4)
    return { doc, lv, shaftId: shaft.roomId }
  }
  /** what the level copy / paste paths do: nodes, walls and room records under new ids, shifted */
  const copyInto = (src: D, from: string, d: D, to: string, dx: number, dy: number, remap = true) => {
    const nodeMap = new Map<string, string>()
    for (const n of Object.values(src.nodes)) {
      if (n.levelId !== from) continue
      const id = newId('n')
      nodeMap.set(n.id, id)
      d.nodes[id] = { ...n, id, levelId: to, x: n.x + dx, y: n.y + dy }
    }
    for (const w of Object.values(src.walls)) {
      if (w.levelId !== from) continue
      const id = newId('w')
      d.walls[id] = structuredClone({ ...w, id, levelId: to, a: nodeMap.get(w.a)!, b: nodeMap.get(w.b)! })
    }
    for (const r of Object.values(src.rooms)) {
      if (r.levelId !== from) continue
      const id = newId('r')
      d.rooms[id] = structuredClone({ ...r, id, levelId: to, anchor: { x: r.anchor.x + dx, y: r.anchor.y + dy } })
      if (remap) remapVoidNodes(d.rooms[id], nodeMap)
    }
  }
  const sum = (doc: D, lv: string) => summarizeLevelRooms(doc, derivePlan(doc, lv).rooms)
  const commit = (doc: D) => {
    normalize(doc)
    syncRooms(doc)
  }

  it('#1/#9 a level copy keeps the shaft technical on both levels (with or without remapped nodes)', () => {
    for (const remap of [true, false]) {
      const { doc, lv } = roomWithShaft()
      const before = sum(doc, lv)
      const lv2 = 'lv_copy'
      doc.levels[lv2] = { ...doc.levels[lv], id: lv2, name: 'Этаж 2' }
      doc.levelOrder.push(lv2)
      copyInto(doc, lv, doc, lv2, 0, 0, remap)
      commit(doc)
      for (const l of [lv, lv2]) {
        const s = sum(doc, l)
        expect(s.technicalCount, `${remap} ${l}`).toBe(1)
        expect(s.count, `${remap} ${l}`).toBe(1)
        expect(s.total, `${remap} ${l}`).toBeCloseTo(before.total, 4)
      }
    }
  })

  it('#9/#10 a paste on the same level keeps both shafts technical and the original record', () => {
    for (const remap of [true, false]) {
      for (let k = 0; k < 6; k++) {
        const { doc, lv, shaftId } = roomWithShaft()
        const before = sum(doc, lv)
        copyInto(structuredClone(doc), lv, doc, lv, 8000, 0, remap)
        commit(doc)
        const s = sum(doc, lv)
        expect(s.technicalCount, `${remap}`).toBe(2)
        expect(s.count, `${remap}`).toBe(2)
        expect(s.total, `${remap}`).toBeCloseTo(2 * before.total, 4)
        expect(doc.rooms[shaftId]?.technical, `${remap}`).toBe(true)
        expect(doc.rooms[shaftId].anchor.x).toBeLessThan(5000)
      }
    }
  })

  it('#9 cut and paste (onto the same or another level) keeps the shaft technical', () => {
    for (const other of [false, true]) {
      const { doc, lv } = roomWithShaft()
      const before = sum(doc, lv)
      const clip = structuredClone(doc)
      removeEntities(doc, Object.keys(doc.walls).map((id) => ({ kind: 'wall' as const, id })))
      commit(doc)
      let dst = lv
      if (other) {
        dst = 'lv_other'
        doc.levels[dst] = { ...doc.levels[lv], id: dst, name: 'Этаж 2' }
        doc.levelOrder.push(dst)
      }
      copyInto(clip, lv, doc, dst, 300, 300)
      commit(doc)
      const s = sum(doc, dst)
      expect(s.technicalCount, `${other}`).toBe(1)
      expect(s.count, `${other}`).toBe(1)
      expect(s.total, `${other}`).toBeCloseTo(before.total, 4)
    }
  })

  it('#11 a wall splitting the shaft leaves both halves technical', () => {
    const { doc, lv } = roomWithShaft(1600)
    const before = sum(doc, lv)
    expect(before.total).toBeCloseTo(15.35, 2)
    addWall(doc, lv, { x: 1300, y: 500 }, { x: 1300, y: 2100 }, { thickness: 100 })
    commit(doc)
    const s = sum(doc, lv)
    expect(s.technicalCount).toBe(2)
    expect(s.count).toBe(1)
    expect(s.total).toBeCloseTo(before.total, 4)
    const voids = Object.values(doc.rooms).filter((r) => r.technical)
    expect(voids.map((r) => r.name)).toEqual(['Шахта', 'Шахта'])
    // and again, after the split: a drag of the left half keeps it technical
    commit(doc)
    expect(sum(doc, lv).technicalCount).toBe(2)
  })

  it('#11 a split that is undone by removing the wall leaves one void', () => {
    const { doc, lv } = roomWithShaft(1600)
    const ids = addWall(doc, lv, { x: 1300, y: 500 }, { x: 1300, y: 2100 }, { thickness: 100 })
    commit(doc)
    removeEntities(doc, ids.map((id) => ({ kind: 'wall' as const, id })))
    commit(doc)
    const s = sum(doc, lv)
    expect(s.technicalCount).toBe(1)
    expect(s.count).toBe(1)
    expect(s.total).toBeCloseTo(15.35, 2)
  })
})
