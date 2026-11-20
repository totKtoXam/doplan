import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { compilePlanSpecDetailed, guessAreaCoef, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'

const base = (rooms: unknown[], extra: Record<string, unknown> = {}): PlanSpec =>
  ({
    version: 1,
    units: 'mm',
    defaults: { exteriorThickness: 300 },
    rooms,
    openings: [{ type: 'entranceDoor', at: [4150, 2000], width: 900 }],
    ...extra,
  }) as unknown as PlanSpec

const faceArea = (spec: unknown, id: string): number => {
  const res = compilePlanSpecDetailed(parsePlanSpec(spec))
  const plan = derivePlan(res.doc, res.levelId)
  const face = plan.rooms.find((f) => f.roomId === res.roomIds[id])
  if (!face) throw new Error(`no face for ${id}`)
  return face.area
}

describe('planspec: cutouts (shafts, boxes, columns)', () => {
  it('a corner shaft is subtracted from the room in the check and in the built plan', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, cutouts: [{ rect: [0, 0, 600, 1000] }] }])
    const v = validatePlanSpecDetailed(spec)
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(v.metrics.perRoom[0].computed).toBeCloseTo(11.4, 2)
    expect(faceArea(spec, 'a')).toBeCloseTo(11.4, 2)
  })

  it('the shaft void becomes a technical room with walls of the cutout thickness', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 1000], wall: 120, name: 'Вентшахта' }] }])
    const res = compilePlanSpecDetailed(parsePlanSpec(spec))
    const shaft = Object.values(res.doc.rooms).find((r) => r.name === 'Вентшахта')
    expect(shaft?.type).toBe('other')
    const plan = derivePlan(res.doc, res.levelId)
    const face = plan.rooms.find((f) => f.roomId === shaft?.id)
    // void = (600 − 120) × (1000 − 120) minus nothing on the outline sides
    expect(face?.area).toBeCloseTo(0.48 * 0.88, 2)
  })

  it('a free-standing column becomes a hole in the floor', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.84, cutouts: [{ rect: [1800, 1300, 400, 400], kind: 'column' }] }])
    const v = validatePlanSpecDetailed(spec)
    expect(v.metrics.perRoom[0].computed).toBeCloseTo(11.84, 2)
    const res = compilePlanSpecDetailed(parsePlanSpec(spec))
    const face = derivePlan(res.doc, res.levelId).rooms.find((f) => f.roomId === res.roomIds.a)
    expect(face?.holes.length).toBe(1)
    expect(face?.area).toBeCloseTo(11.84, 2)
  })

  it('a rect room without cutouts is unchanged (regression)', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 12 }])
    expect(faceArea(spec, 'a')).toBeCloseTo(12, 3)
  })

  it('reports cutouts outside the room and cutouts splitting it', () => {
    const out = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [3800, 0, 600, 600] }] }]))
    expect(out.issues.some((i) => i.code === 'CUTOUT_OUTSIDE')).toBe(true)
    const split = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [1800, 0, 400, 3000] }] }]))
    expect(split.issues.some((i) => i.code === 'CUTOUT_SPLITS_ROOM')).toBe(true)
  })

  it('rejects a malformed cutout', () => {
    const v = validatePlanSpecDetailed(base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, -5, 100] }] }]))
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.code === 'SCHEMA')).toBe(true)
  })
})

describe('planspec: printed-area coefficient and explanations', () => {
  const loggia = (extra: Record<string, unknown>) =>
    base([
      { id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 12 },
      { id: 'l', type: 'loggia', rect: [0, 3300, 4000, 1000], labelledArea: 2, edgeWall: { kind: 'parapet' }, ...extra },
    ])

  it('a loggia printed with the BTI ×0.5 is an error without labelledAreaCoef, with a hint', () => {
    const v = validatePlanSpecDetailed(loggia({}))
    const issue = v.issues.find((i) => i.code === 'AREA_MISMATCH' && i.ids?.includes('l'))
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toContain('labelledAreaCoef: 0.5')
  })

  it('labelledAreaCoef makes it match and keeps the clear area in the doc', () => {
    const v = validatePlanSpecDetailed(loggia({ labelledAreaCoef: 0.5 }))
    expect(v.issues.filter((i) => i.code === 'AREA_MISMATCH')).toEqual([])
    const m = v.metrics.perRoom.find((r) => r.id === 'l')
    expect(m).toMatchObject({ computed: 4, labelled: 2, coef: 0.5, delta: 0 })
    const res = compilePlanSpecDetailed(parsePlanSpec(loggia({ labelledAreaCoef: 0.5 })))
    expect(res.doc.rooms[res.roomIds.l].labelledArea).toBe(4)
  })

  it('areaNote turns an area error into an explained warning', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 10, areaNote: 'на плане опечатка: 10,0 вместо 12,0' }])
    const v = validatePlanSpecDetailed(spec)
    const issue = v.issues.find((i) => i.code === 'AREA_MISMATCH')
    expect(issue?.severity).toBe('warning')
    expect(issue?.message).toContain('опечатка')
    expect(v.ok).toBe(true)
  })

  it('rejects a coefficient outside (0, 1]', () => {
    expect(validatePlanSpecDetailed(loggia({ labelledAreaCoef: 2 })).ok).toBe(false)
  })

  it('guessAreaCoef recognises loggia and balcony labels', () => {
    expect(guessAreaCoef(2.6, 1.3)).toBe(0.5)
    expect(guessAreaCoef(4, 1.2)).toBe(0.3)
    expect(guessAreaCoef(4, 3.98)).toBeNull()
  })
})

describe('planspec: wall steps and cutouts next to other rooms', () => {
  const walls = (spec: PlanSpec) => {
    const res = compilePlanSpecDetailed(parsePlanSpec(spec))
    return { res, plan: derivePlan(res.doc, res.levelId), list: Object.values(res.doc.walls) }
  }

  it('a wall that gets thicker along its length closes both rooms (step joint, no stray exterior wall)', () => {
    const spec = base(
      [
        { id: 'a', type: 'living', rect: [0, 0, 6000, 3000] },
        { id: 'b', type: 'bedroom', polygon: [[0, 3120], [3000, 3120], [3000, 3320], [6000, 3320], [6000, 6000], [0, 6000]] },
      ],
      { openings: [{ type: 'entranceDoor', at: [-150, 1500], width: 900 }] },
    )
    const { res, plan, list } = walls(spec)
    const area = (id: string) => plan.rooms.find((f) => f.roomId === res.roomIds[id])?.area
    expect(area('a')).toBeCloseTo(18, 2)
    expect(area('b')).toBeCloseTo(16.68, 2)
    // nothing is built beyond the step edge into the wall body
    expect(list.filter((w) => w.kind !== 'virtual' && Math.abs(res.doc.nodes[w.a].x - res.doc.nodes[w.b].x) < 1 && res.doc.nodes[w.a].x > 2000 && res.doc.nodes[w.a].x < 5000)).toHaveLength(0)
  })

  it('the sides of a cutout notch do not pair with a neighbouring room', () => {
    const spec = base(
      [
        { id: 'a', type: 'bathroom', rect: [0, 0, 2620, 1780] },
        { id: 'b', type: 'living', rect: [2780, 0, 4000, 3000], cutouts: [{ rect: [2780, 0, 390, 840], kind: 'shaft' }] },
      ],
      { openings: [{ type: 'entranceDoor', at: [4780, 3150], width: 900 }] },
    )
    const { res, plan, list } = walls(spec)
    expect(Math.max(...list.map((w) => w.thickness))).toBeLessThanOrEqual(300)
    expect(plan.rooms.find((f) => f.roomId === res.roomIds.b)?.area).toBeCloseTo(12 - 0.39 * 0.84, 2)
  })
})
