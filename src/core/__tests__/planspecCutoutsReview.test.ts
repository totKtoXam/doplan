// Regressions for the review of cutouts (shafts, boxes, columns) in rooms-mode PlanSpec: each case
// is a spec the validator passed as «ok» while the built .doplan had other areas or extra walls
import { describe, expect, it } from 'vitest'
import { summarizeLevelRooms } from '../area'
import { derivePlan } from '../derive'
import { parseDoc, serializeDoc } from '../io'
import { compilePlanSpecDetailed, docToPlanSpec, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'

const base = (rooms: unknown[], extra: Record<string, unknown> = {}): PlanSpec =>
  ({
    version: 1,
    units: 'mm',
    defaults: { exteriorThickness: 300 },
    rooms,
    openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }],
    ...extra,
  }) as unknown as PlanSpec

const build = (spec: unknown) => {
  const res = compilePlanSpecDetailed(parsePlanSpec(spec))
  const plan = derivePlan(res.doc, res.levelId)
  const face = (id: string) => plan.rooms.find((f) => f.roomId === res.roomIds[id])
  const walls = Object.values(res.doc.walls).map((w) => ({ t: w.thickness, pa: res.doc.nodes[w.a], pb: res.doc.nodes[w.b] }))
  return { res, plan, face, walls }
}
const errors = (spec: unknown) => validatePlanSpecDetailed(spec as PlanSpec).issues.filter((i) => i.severity === 'error')
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
    const v = validatePlanSpecDetailed(spec)
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
      const v = validatePlanSpecDetailed(spec)
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
    const v = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [3800, 0, 600, 600] }] }]))
    expect(v.issues.some((i) => i.code === 'CUTOUT_OUTSIDE')).toBe(true)
  })

  it('#5 overlapping cutouts are an overlap error, not a false «outside»', () => {
    const v = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000] }, { rect: [400, 0, 600, 600] }] }]))
    const codes = v.issues.filter((i) => i.severity === 'error').map((i) => i.code)
    expect(codes).toContain('CUTOUT_OVERLAP')
    expect(codes).not.toContain('CUTOUT_OUTSIDE')
  })

  it('#6 partially adjacent cutouts build no wall into the floor', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000] }, { rect: [600, 0, 600, 600] }] }])
    expect(errors(spec)).toEqual([])
    expect(validatePlanSpecDetailed(spec).metrics.perRoom[0].computed).toBeCloseTo(11.04, 2)
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
    const v = validatePlanSpecDetailed(back)
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
    const v = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, areaNote: '  ' }]))
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
      const computed = validatePlanSpecDetailed(spec).metrics.perRoom[0].computed
      // computed is rounded to 0.01 m²; the bug swallowed 0.6 … 1.9 m²
      expect(Math.abs(build(spec).face('a')!.area - computed)).toBeLessThan(0.01)
    }
  })

  it('a built floor that differs from the checked shape is reported (a corner notch only warns)', () => {
    // three rooms meeting diagonally leave a ≈0.02 m² notch at the corner: a warning, the areas hold
    const v = validatePlanSpecDetailed(
      base([
        { id: 'a', type: 'living', rect: [0, 0, 4000, 3000] },
        { id: 'b', type: 'bedroom', rect: [0, 3120, 4000, 3000] },
        { id: 'c', type: 'kitchen', rect: [-3120, 0, 3000, 3000] },
      ]),
    )
    const m = v.issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')
    expect(m.length).toBeGreaterThan(0)
    expect(m.every((i) => i.severity === 'warning')).toBe(true)
  })
})
