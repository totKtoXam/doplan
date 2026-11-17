// Regressions for the review of cutouts (shafts, boxes, columns) in rooms-mode PlanSpec: each case
// is a spec the validator passed as «ok» while the built .doplan had other areas or extra walls
import { describe, expect, it } from 'vitest'
import { summarizeLevelRooms } from '../area'
import { derivePlan } from '../derive'
import { parseDoc, serializeDoc } from '../io'
import { normalize, removeEntities, syncRooms } from '../ops'
import { compilePlanSpecDetailed, docToPlanSpec, parsePlanSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'
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
    // two rows of rooms with offset gaps leave a ≈0.02 m² notch at a junction: a warning, the areas hold
    const v = validatePlanSpecDetailed(
      base([
        { id: 'r0', type: 'bedroom', rect: [0, 0, 2300, 3250] },
        { id: 'r1', type: 'living', rect: [2500, 0, 2900, 3600] },
        { id: 's0', type: 'bedroom', rect: [150, 3720, 2050, 2200] },
        { id: 's1', type: 'bedroom', rect: [2300, 3720, 1500, 2950] },
      ]),
    )
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
    const codes = validatePlanSpecDetailed(spec).issues.map((i) => i.code)
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
      const v = validatePlanSpecDetailed(spec)
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
      const v = validatePlanSpecDetailed(spec)
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
      const v = validatePlanSpecDetailed(spec)
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
      expect(validatePlanSpecDetailed(spec).issues.filter((i) => ['BUILT_SHAPE_MISMATCH', 'DANGLING_WALL'].includes(i.code))).toEqual([])
      const { face } = build(spec)
      expect(face('b')?.area).toBeCloseTo(9, 2)
      expect(face('c')?.area).toBeCloseTo(8, 2)
    }
  })

  it('#7 two partly touching shafts mid-room: no false hole-count error, both voids are shafts', () => {
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [1000, 1000, 500, 500] }, { rect: [1500, 1200, 500, 500] }] }])
    const v = validatePlanSpecDetailed(spec)
    expect(v.issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
    expect(v.ok).toBe(true)
    const { res, face } = build(spec)
    expect(face('a')?.area).toBeCloseTo(11.5, 2)
    const shafts = Object.values(res.doc.rooms).filter((r) => r.technical)
    expect(shafts).toHaveLength(2)
    expect(shafts.every((r) => r.name === 'Шахта' && r.type === 'other')).toBe(true)
  })

  it('#7 a hole really missing from the built floor is still an error', () => {
    // a cutout that cannot become a hole (its void is swallowed) must not pass as two touching holes
    const spec = base([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [1000, 1000, 500, 500] }] }])
    expect(validatePlanSpecDetailed(spec).issues.filter((i) => i.code === 'BUILT_SHAPE_MISMATCH')).toEqual([])
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
