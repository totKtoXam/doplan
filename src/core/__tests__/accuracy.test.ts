import { describe, expect, it } from 'vitest'
import { createEmptyDoc, sizedCatalogName } from '../defaults'
import { derivePlan } from '../derive'
import { parseDoc, serializeDoc } from '../io'
import { compilePlanSpecDetailed, docToPlanSpec, parsePlanSpec } from '../planspec'
import { applyMeasuredLength, setRunSource } from '../measure'
import { addRectRoom, addWall, moveWall, normalize, syncRooms } from '../ops'
import {
  type EdgeRun,
  itemClearances,
  itemGaps,
  roomAreaReport,
  roomEdgeRuns,
  roomMeasureStatus,
  runProvenance,
  sideKey,
  sourceAreaChecks,
  unmeasuredChecklist,
} from '../provenance'
import type { DerivedPlan, DerivedRoom, Doc, Id, Vec2 } from '../types'

/**
 * Two rooms side by side (centrelines): kitchen x 0…3100, neighbour x 3100…5100, both y 0…4000,
 * walls 100 mm thick → kitchen clear 3000 × 3900, neighbour clear 1900 × 3900.
 */
function twoRooms(): { doc: Doc; levelId: Id } {
  const doc = createEmptyDoc('test')
  const levelId = doc.levelOrder[0]
  addRectRoom(doc, levelId, 0, 0, 5100, 4000, { thickness: 100 })
  addWall(doc, levelId, { x: 3100, y: 0 }, { x: 3100, y: 4000 }, { thickness: 100 })
  normalize(doc)
  syncRooms(doc)
  return { doc, levelId }
}

function roomAt(doc: Doc, plan: DerivedPlan, p: Vec2): DerivedRoom {
  const r = plan.rooms.find((room) => {
    const xs = room.polygon.map((q) => q.x)
    const ys = room.polygon.map((q) => q.y)
    return p.x > Math.min(...xs) && p.x < Math.max(...xs) && p.y > Math.min(...ys) && p.y < Math.max(...ys)
  })
  if (!r) throw new Error('room not found')
  void doc
  return r
}

/** the horizontal run along y = yFace */
function runAtY(room: DerivedRoom, yFace: number): EdgeRun {
  const run = roomEdgeRuns(room).find((r) => Math.abs(r.a.y - yFace) < 1 && Math.abs(r.b.y - yFace) < 1)
  if (!run) throw new Error(`no run at y=${yFace}`)
  return run
}

function runAtX(room: DerivedRoom, xFace: number): EdgeRun {
  const run = roomEdgeRuns(room).find((r) => Math.abs(r.a.x - xFace) < 1 && Math.abs(r.b.x - xFace) < 1)
  if (!run) throw new Error(`no run at x=${xFace}`)
  return run
}

describe('runs of a room', () => {
  it('merges a face split by a T-junction on its far side into one run', () => {
    const { doc, levelId } = twoRooms()
    const plan = derivePlan(doc, levelId)
    const outer = derivePlan(doc, levelId)
    void outer
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const runs = roomEdgeRuns(kitchen)
    expect(runs).toHaveLength(4)
    const top = runAtY(kitchen, 50)
    expect(top.length).toBeCloseTo(3000, 3)
    expect(runAtX(kitchen, 3050).length).toBeCloseTo(3900, 3)
  })
})

describe('provenance round-trip', () => {
  it('keeps wall dims, labelled areas, the source block and the item-size toggle through save/load', () => {
    const { doc, levelId } = twoRooms()
    const plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    setRunSource(doc, levelId, top.key, 'measured', { tol: 1, date: '2026-11-14', note: 'лазер' })
    const right = runAtX(kitchen, 3050)
    setRunSource(doc, levelId, right.key, 'estimated')
    doc.rooms[kitchen.roomId].labelledArea = 12
    doc.source = { kind: 'bti', labelledTotalArea: 52.4, labelledLivingArea: 30.1 }
    doc.settings.showItemSizes = false

    const back = parseDoc(serializeDoc(doc))
    const w = back.walls[top.edges[0].wallId]
    expect(w.dims?.[top.edges[0].side]).toEqual({ source: 'measured', tol: 1, date: '2026-11-14', note: 'лазер', value: 3000 })
    expect(back.walls[right.edges[0].wallId].dims?.[right.edges[0].side]?.source).toBe('estimated')
    expect(back.rooms[kitchen.roomId].labelledArea).toBe(12)
    expect(back.source).toEqual({ kind: 'bti', labelledTotalArea: 52.4, labelledLivingArea: 30.1 })
    expect(back.settings.showItemSizes).toBe(false)

    const plan2 = derivePlan(back, levelId)
    const k2 = roomAt(back, plan2, { x: 1500, y: 2000 })
    expect(runProvenance(back, runAtY(k2, 50))).toMatchObject({ source: 'measured', tol: 1, stale: false, date: '2026-11-14' })
  })

  it('reads old documents without provenance (back-compat) and drops junk values', () => {
    const { doc } = twoRooms()
    const raw = JSON.parse(serializeDoc(doc))
    delete raw.settings.showItemSizes
    const wid = Object.keys(raw.walls)[0]
    raw.walls[wid].dims = { left: { source: 'bogus' }, right: 'plan' }
    const back = parseDoc(raw)
    expect(back.settings.showItemSizes).toBe(true)
    expect(back.walls[wid].dims).toEqual({ right: { source: 'plan' } })
    for (const id in back.walls) if (id !== wid) expect(back.walls[id].dims).toBeUndefined()
    expect(back.source).toBeUndefined()
  })
})

describe('stale provenance', () => {
  it('falls back to drawn when the wall is moved after the measurement', () => {
    const { doc, levelId } = twoRooms()
    let plan = derivePlan(doc, levelId)
    let kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    setRunSource(doc, levelId, top.key, 'measured')
    expect(runProvenance(doc, top).source).toBe('measured')
    // drag the partition 50 mm to the right: the kitchen top face is now 3050
    const partition = Object.values(doc.walls).find((w) => Math.abs(doc.nodes[w.a].x - 3100) < 0.01 && Math.abs(doc.nodes[w.b].x - 3100) < 0.01)!
    moveWall(doc, partition.id, 50, 0)
    plan = derivePlan(doc, levelId)
    kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const p = runProvenance(doc, runAtY(kitchen, 50))
    expect(p.source).toBe('drawn')
    expect(p.stale).toBe(true)
  })
})

describe('applyMeasuredLength (propagation through the node graph)', () => {
  it('moves the far partition along the wall, keeps the near side and marks the run measured', () => {
    const { doc, levelId } = twoRooms()
    let plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    // the run goes a → b; find which end is on the partition (x = 3050)
    const partitionEnd = Math.abs(top.b.x - 3050) < 1 ? 'b' : 'a'
    const res = applyMeasuredLength(doc, levelId, top.key, 3120, partitionEnd, { date: '2026-11-14' })
    expect(res.ok).toBe(true)
    expect(res.delta).toBeCloseTo(120, 6)
    expect(res.before).toBeCloseTo(3000, 6)
    expect(res.after).toBeCloseTo(3120, 6)
    // the partition (both nodes) moved, the exterior walls did not
    const xs = Object.values(doc.nodes).map((n) => Math.round(n.x * 1000) / 1000).sort((p, q) => p - q)
    expect([...new Set(xs)]).toEqual([0, 3220, 5100])
    expect(res.moved).toHaveLength(2)

    plan = derivePlan(doc, levelId)
    const k2 = roomAt(doc, plan, { x: 1500, y: 2000 })
    const n2 = roomAt(doc, plan, { x: 4500, y: 2000 })
    // the opposite (bottom) face followed: the kitchen stays rectangular
    expect(runAtY(k2, 3950).length).toBeCloseTo(3120, 6)
    expect(runAtX(k2, 3170).length).toBeCloseTo(3900, 6)
    // the neighbour shrank by the same amount
    expect(runAtY(n2, 50).length).toBeCloseTo(1780, 6)
    expect(k2.area).toBeCloseTo(3.12 * 3.9, 6)
    const prov = runProvenance(doc, runAtY(k2, 50))
    expect(prov).toMatchObject({ source: 'measured', stale: false, date: '2026-11-14', tol: 2 })
    // only the measured face is marked; the bottom face is not
    expect(runProvenance(doc, runAtY(k2, 3950)).source).toBe('drawn')
    expect(roomMeasureStatus(doc, k2)).toMatchObject({ runs: 4, measured: 1, full: false })
  })

  it('moving the other end keeps the partition and moves the exterior wall with everything on it', () => {
    const { doc, levelId } = twoRooms()
    const plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    const outerEnd = Math.abs(top.a.x - 50) < 1 ? 'a' : 'b'
    const res = applyMeasuredLength(doc, levelId, top.key, 2950, outerEnd)
    expect(res.ok).toBe(true)
    expect(res.delta).toBeCloseTo(-50, 6)
    const xs = [...new Set(Object.values(doc.nodes).map((n) => Math.round(n.x * 1000) / 1000))].sort((p, q) => p - q)
    expect(xs).toEqual([50, 3100, 5100])
  })

  it('reports an earlier measurement that the new one changes', () => {
    const { doc, levelId } = twoRooms()
    let plan = derivePlan(doc, levelId)
    const neighbour = roomAt(doc, plan, { x: 4500, y: 2000 })
    const nTop = runAtY(neighbour, 50)
    setRunSource(doc, levelId, nTop.key, 'measured')
    plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    const partitionEnd = Math.abs(top.b.x - 3050) < 1 ? 'b' : 'a'
    const res = applyMeasuredLength(doc, levelId, top.key, 3100, partitionEnd)
    expect(res.ok).toBe(true)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0].before).toBeCloseTo(1900, 3)
    expect(res.conflicts[0].after).toBeCloseTo(1800, 3)
  })

  it('refuses a measurement that would collapse the neighbouring room and leaves the doc untouched', () => {
    const { doc, levelId } = twoRooms()
    const before = JSON.stringify(doc.nodes)
    const plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const top = runAtY(kitchen, 50)
    const partitionEnd = Math.abs(top.b.x - 3050) < 1 ? 'b' : 'a'
    const res = applyMeasuredLength(doc, levelId, top.key, 5200, partitionEnd)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/схлопнул/)
    expect(JSON.stringify(doc.nodes)).toBe(before)
  })

  it('a fully measured room gets the badge status', () => {
    const doc = createEmptyDoc('t')
    const levelId = doc.levelOrder[0]
    addRectRoom(doc, levelId, 0, 0, 3000, 2000, { thickness: 100 })
    syncRooms(doc)
    let plan = derivePlan(doc, levelId)
    for (const run of roomEdgeRuns(plan.rooms[0])) setRunSource(doc, levelId, run.key, 'measured')
    plan = derivePlan(doc, levelId)
    expect(roomMeasureStatus(doc, plan.rooms[0]).full).toBe(true)
  })
})

describe('checklist, clearances, area report', () => {
  it('lists unmeasured dimensions with the kitchen and bathroom first', () => {
    const { doc, levelId } = twoRooms()
    const plan = derivePlan(doc, levelId)
    const kitchen = roomAt(doc, plan, { x: 1500, y: 2000 })
    const bath = roomAt(doc, plan, { x: 4500, y: 2000 })
    doc.rooms[kitchen.roomId].type = 'living'
    doc.rooms[kitchen.roomId].name = 'Гостиная'
    doc.rooms[bath.roomId].type = 'bathroom'
    doc.rooms[bath.roomId].name = 'Ванная'
    setRunSource(doc, levelId, runAtY(bath, 50).key, 'measured')
    const list = unmeasuredChecklist(doc, derivePlan(doc, levelId))
    expect(list).toHaveLength(7)
    expect(list.slice(0, 3).every((e) => e.roomType === 'bathroom')).toBe(true)
    expect(list[3].roomType).toBe('living')
  })

  it('measures clearances from an item to the walls and flags unmeasured walls', () => {
    const doc = createEmptyDoc('t')
    const levelId = doc.levelOrder[0]
    // clear room 0…3000 × 0…2000 (centreline −50 … 3050)
    addRectRoom(doc, levelId, -50, -50, 3100, 2100, { thickness: 100 })
    syncRooms(doc)
    let plan = derivePlan(doc, levelId)
    // fridge 600 × 650, back to the top wall with a 20 mm gap, 400 mm from the left wall
    // rotation 0: the front looks down (+y), the back to the top wall
    const fridge = { x: 400 + 300, y: 20 + 325, rotation: 0, size: { w: 600, d: 650, h: 1850 } }
    let cl = itemClearances(doc, plan, fridge)
    const by = Object.fromEntries(cl.map((c) => [c.dir, c]))
    expect(by.back.dist).toBeCloseTo(20, 6)
    expect(by.front.dist).toBeCloseTo(2000 - 20 - 650, 6)
    expect(by.left.dist).toBeCloseTo(400, 6)
    expect(by.right.dist).toBeCloseTo(3000 - 400 - 600, 6)
    expect(cl.every((c) => !c.reliable)).toBe(true)
    for (const run of roomEdgeRuns(plan.rooms[0])) setRunSource(doc, levelId, run.key, 'measured')
    plan = derivePlan(doc, levelId)
    cl = itemClearances(doc, plan, fridge)
    expect(cl.every((c) => c.reliable)).toBe(true)
  })

  it('reports computed vs labelled area and detects a plan that contradicts itself', () => {
    const doc = createEmptyDoc('t')
    const levelId = doc.levelOrder[0]
    // clear 3100 × 4050 = 12.555 m², labelled 12.0 (the user's kitchen)
    addRectRoom(doc, levelId, -50, -50, 3200, 4150, { thickness: 100 })
    syncRooms(doc)
    let plan = derivePlan(doc, levelId)
    const room = plan.rooms[0]
    doc.rooms[room.roomId].labelledArea = 12
    for (const run of roomEdgeRuns(room)) setRunSource(doc, levelId, run.key, 'plan')
    plan = derivePlan(doc, levelId)
    const rep = roomAreaReport(doc, plan.rooms[0])
    expect(rep.computed).toBeCloseTo(12.56, 2)
    expect(Math.abs(rep.delta! - 0.555)).toBeLessThan(0.006)
    expect(rep.pct).toBeCloseTo(4.6, 1)
    expect(rep.level).toBe('bad')
    // ±10 mm on 3.1 + 4.05 m sides → ±0.0715 m²
    expect(rep.uncertainty).toBeCloseTo(0.0715, 2)
    expect(rep.allPlan).toBe(true)
    expect(rep.contradiction).toBe(true)

    // estimated dimensions explain small deltas but never claim a contradiction
    for (const run of roomEdgeRuns(plan.rooms[0])) setRunSource(doc, levelId, run.key, 'estimated')
    const rep2 = roomAreaReport(doc, derivePlan(doc, levelId).rooms[0])
    expect(rep2.contradiction).toBe(false)
    expect(rep2.uncertainty).toBeCloseTo(0.3575, 2)
  })

  it('checks that printed room areas add up to the printed total', () => {
    const { doc, levelId } = twoRooms()
    const plan = derivePlan(doc, levelId)
    const a = roomAt(doc, plan, { x: 1500, y: 2000 })
    const b = roomAt(doc, plan, { x: 4500, y: 2000 })
    doc.rooms[a.roomId].type = 'kitchen'
    doc.rooms[a.roomId].labelledArea = 12
    doc.rooms[b.roomId].type = 'bedroom'
    doc.rooms[b.roomId].labelledArea = 7.4
    doc.source = { labelledTotalArea: 19.4, labelledLivingArea: 7.9 }
    const checks = sourceAreaChecks(doc, plan)
    expect(checks.find((c) => c.kind === 'total')).toMatchObject({ sum: 19.4, contradiction: false })
    expect(checks.find((c) => c.kind === 'living')).toMatchObject({ sum: 7.4, contradiction: true })
  })
})

void sideKey

describe('PlanSpec provenance', () => {
  const spec = {
    version: 1,
    units: 'mm',
    source: { kind: 'bti', labelledTotalArea: 20.2, labelledLivingArea: 12 },
    defaults: { exteriorThickness: 300, partitionThickness: 100 },
    rooms: [
      {
        id: 'kit',
        type: 'kitchen',
        rect: [0, 0, 3000, 4000],
        labelledArea: 12,
        source: { top: 'plan', left: { source: 'measured', tol: 3, date: '2026-11-01' }, right: 'derived' },
      },
      { id: 'bed', type: 'bedroom', rect: [3100, 0, 2000, 4000], labelledArea: 8.2, source: 'estimated' },
    ],
    openings: [],
  }

  it('maps room-side sources onto wall faces and carries labelled areas', () => {
    const res = compilePlanSpecDetailed(parsePlanSpec(spec))
    const { doc, levelId } = res
    const plan = derivePlan(doc, levelId)
    const kit = plan.rooms.find((r) => r.roomId === res.roomIds.kit)!
    const bed = plan.rooms.find((r) => r.roomId === res.roomIds.bed)!
    const bySide = (room: DerivedRoom): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const run of roomEdgeRuns(room)) {
        const side = Math.abs(run.u.x) > 0.9 ? (run.n.y > 0 ? 'top' : 'bottom') : run.n.x > 0 ? 'left' : 'right'
        out[side] = runProvenance(doc, run).source
      }
      return out
    }
    expect(bySide(kit)).toEqual({ top: 'plan', left: 'measured', right: 'derived', bottom: 'drawn' })
    expect(bySide(bed)).toEqual({ top: 'estimated', left: 'estimated', right: 'estimated', bottom: 'estimated' })
    const leftRun = roomEdgeRuns(kit).find((r) => Math.abs(r.u.y) > 0.9 && r.n.x > 0)!
    expect(runProvenance(doc, leftRun)).toMatchObject({ source: 'measured', tol: 3, date: '2026-11-01' })
    expect(doc.rooms[res.roomIds.kit].labelledArea).toBe(12)
    expect(doc.source).toEqual({ kind: 'bti', labelledTotalArea: 20.2, labelledLivingArea: 12 })
    // the shared partition: kitchen face is 'derived', bedroom face 'estimated'
    const back = docToPlanSpec(doc, levelId)
    expect(back.rooms.find((r) => r.id === res.roomIds.kit)?.labelledArea).toBe(12)
    expect(back.source).toMatchObject({ labelledTotalArea: 20.2 })
  })

  it('defaults to estimated for px plans and to drawn otherwise; rejects bad sources', () => {
    const px = { ...spec, units: 'px', source: { ...spec.source, mmPerPx: 10 }, rooms: [{ id: 'a', type: 'living', rect: [0, 0, 300, 400] }] }
    const res = compilePlanSpecDetailed(parsePlanSpec(px))
    const plan = derivePlan(res.doc, res.levelId)
    for (const run of roomEdgeRuns(plan.rooms[0])) expect(runProvenance(res.doc, run).source).toBe('estimated')
    const mm = compilePlanSpecDetailed(parsePlanSpec({ ...spec, rooms: [{ id: 'a', type: 'living', rect: [0, 0, 3000, 4000] }] }))
    const plan2 = derivePlan(mm.doc, mm.levelId)
    for (const run of roomEdgeRuns(plan2.rooms[0])) expect(runProvenance(mm.doc, run).source).toBe('drawn')
    expect(() => parsePlanSpec({ ...spec, rooms: [{ id: 'a', rect: [0, 0, 10, 10], source: 'guess' }] })).toThrow(/источник размера/)
  })

  it('applies wall-segment sources in walls mode', () => {
    const ws = {
      version: 1,
      units: 'mm',
      walls: [{ path: [[0, 0], [3000, 0], [3000, 3000], [0, 3000], [0, 0]], thickness: 200, kind: 'exterior', source: ['plan', 'measured', 'plan', 'derived'] }],
      rooms: [{ id: 'r', type: 'living', at: [1500, 1500] }],
      openings: [],
    }
    const res = compilePlanSpecDetailed(parsePlanSpec(ws))
    const plan = derivePlan(res.doc, res.levelId)
    const sources = roomEdgeRuns(plan.rooms[0]).map((r) => runProvenance(res.doc, r).source).sort()
    expect(sources).toEqual(['derived', 'measured', 'plan', 'plan'])
  })
})

describe('itemGaps', () => {
  const mk = (id: string, x: number, y: number, w: number, d: number, rotation = 0, extra: Partial<{ elevation: number; h: number; levelId: string }> = {}) => ({
    id,
    levelId: extra.levelId ?? 'L',
    x,
    y,
    rotation,
    elevation: extra.elevation ?? 0,
    size: { w, d, h: extra.h ?? 800 },
  })
  it('finds the nearest neighbour on each side, footprint to footprint', () => {
    const table = mk('t', 0, 0, 1200, 800)
    const items = [
      table,
      mk('r', 600 + 300 + 250, 0, 500, 500), // right, gap 300
      mk('r2', 600 + 900 + 250, 0, 500, 500), // further right
      mk('f', 0, 400 + 700 + 200, 400, 400), // front (+y), gap 700
      mk('b', 0, -400 - 2000, 400, 400), // back, beyond 1.5 m
      mk('diag', 1500, 1500, 300, 300), // not in any side band
    ]
    const g = itemGaps(table, items)
    const by = Object.fromEntries(g.map((x) => [x.dir, x]))
    expect(Object.keys(by).sort()).toEqual(['front', 'right'])
    expect(by.right.dist).toBeCloseTo(300)
    expect(by.right.itemId).toBe('r')
    expect(by.right.from).toEqual({ x: 600, y: 0 })
    expect(by.front.dist).toBeCloseTo(700)
  })
  it('works in the rotated item frame and with rotated neighbours', () => {
    const bed = mk('bed', 0, 0, 1600, 2000, 90)
    // local +x of a 90° item points down the plan (+y); a nightstand 200 mm past its local right edge
    const ns = mk('ns', 0, 800 + 200 + 250, 500, 500, 45)
    const g = itemGaps(bed, [bed, ns])
    expect(g).toHaveLength(1)
    expect(g[0].dir).toBe('right')
    expect(g[0].dist).toBeCloseTo(200 + 250 - 250 * Math.SQRT2, 3)
  })
  it('ignores other levels, hidden items and items at another height', () => {
    const a = mk('a', 0, 0, 1000, 1000)
    const others = [
      mk('lvl', 900, 0, 200, 200, 0, { levelId: 'L2' }),
      { ...mk('hid', 900, 0, 200, 200), hidden: true },
      mk('wallcab', 900, 0, 200, 200, 0, { elevation: 1500, h: 700 }),
      mk('rug', 900, 0, 200, 200, 0, { h: 10 }),
    ]
    expect(itemGaps(a, others)).toEqual([])
  })
  it('ignores neighbours behind the nearest wall', () => {
    const a = mk('a', 0, 0, 1000, 1000)
    const b = mk('b', 1000, 0, 200, 200)
    expect(itemGaps(a, [b])).toHaveLength(1)
    expect(itemGaps(a, [b], 1500, [{ dir: 'right', dist: 200 }])).toEqual([])
    expect(itemGaps(a, [b], 1500, [{ dir: 'right', dist: 600 }])).toHaveLength(1)
  })
})

describe('sizedCatalogName', () => {
  it('replaces the default width in the catalog name', () => {
    expect(sizedCatalogName('Тумба под мойку 800', 800, 600)).toBe('Тумба под мойку 600')
    expect(sizedCatalogName('Тумба под мойку 800', 800, 800)).toBe('Тумба под мойку 800')
    expect(sizedCatalogName('Диван двухместный', 1600, 1800)).toBe('Диван двухместный')
    expect(sizedCatalogName('Шкаф 1800 ×800', 800, 900)).toBe('Шкаф 1800 ×800')
  })
})
