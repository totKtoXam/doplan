import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { parseDoc, serializeDoc } from '../io'
import { addRectRoom, duplicateEntities, moveNodes, moveWall, normalize, removeEntities, splitWall } from '../ops'
import {
  ELECTRIC_KINDS,
  ELECTRIC_TYPES,
  addElectric,
  electricBinding,
  electricBomRows,
  electricLabelLines,
  electricPointSymbol,
  electricSymbol,
  electricType,
  nearestWallFace,
} from '../electrical'
import { computeBom } from '../bom'
import { buildDisplayList } from '../display'
import { derivePlan } from '../derive'
import { toDxf } from '../export/dxf'
import type { Doc, Id, Wall } from '../types'

/** a 4000 × 3000 room (wall centrelines), walls 200 thick */
function room(): { doc: Doc; L: Id; top: Wall } {
  const doc = createEmptyDoc()
  const L = doc.levelOrder[0]
  addRectRoom(doc, L, 0, 0, 4000, 3000, { thickness: 200 })
  normalize(doc)
  const top = Object.values(doc.walls).find((w) => {
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    return Math.abs(a.y) < 1 && Math.abs(b.y) < 1
  })!
  return { doc, L, top }
}

describe('electrical catalog', () => {
  it('has unique kinds, a symbol and a code for every type', () => {
    expect(new Set(ELECTRIC_KINDS).size).toBe(ELECTRIC_KINDS.length)
    for (const ty of ELECTRIC_TYPES) {
      const s = electricSymbol(ty.kind)
      expect(s.prims.length, ty.kind).toBeGreaterThan(0)
      for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(Number.isFinite(s.box[k]), ty.kind).toBe(true)
      expect(ty.ru.length).toBeGreaterThan(0)
      expect(ty.elevation).toBeGreaterThanOrEqual(0)
    }
    expect(electricType('nonsense').kind).toBe('other')
  })

  it('repeats the post symbol for a multi-post frame', () => {
    const one = electricPointSymbol({ kind: 'socket', mount: 'wall' })
    const three = electricPointSymbol({ kind: 'socket', mount: 'wall', gangs: 3 })
    expect(three.prims.length).toBe(one.prims.length * 3)
    expect(three.box.maxX - three.box.minX).toBeGreaterThan((one.box.maxX - one.box.minX) * 2.5)
  })

  it('labels the code, the vertical post count and the height', () => {
    const { doc, L } = room()
    const id = addElectric(doc, L, 'socketIP44', 1000, 50, { gangs: 2, vertical: true })
    expect(electricLabelLines(doc.electrical![id])).toEqual(['2× IP44', 'h=1000'])
    expect(electricLabelLines(doc.electrical![id], { heights: false })).toEqual(['2× IP44'])
  })
})

describe('placing on walls', () => {
  it('snaps a socket to the nearest face, facing into the room', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 1000, 60)
    const p = doc.electrical![id]
    expect(p.wallId).toBe(top.id)
    expect(p.x).toBeCloseTo(1000)
    expect(p.y).toBeCloseTo(100)
    expect(p.rotation).toBeCloseTo(90)
    expect(p.elevation).toBe(300)
    expect(p.mount).toBe('wall')
  })

  it('leaves a point free when no wall is near, ceiling points take the level height', () => {
    const { doc, L } = room()
    const free = addElectric(doc, L, 'socket', 2000, 1500)
    expect(doc.electrical![free].wallId).toBeUndefined()
    const smoke = addElectric(doc, L, 'sensorSmoke', 2000, 1500)
    expect(doc.electrical![smoke].mount).toBe('ceiling')
    expect(doc.electrical![smoke].elevation).toBe(doc.levels[L].height)
    expect(doc.electrical![smoke].wallId).toBeUndefined()
  })

  it('finds the outer face from outside', () => {
    const { doc, L, top } = room()
    const hit = nearestWallFace(doc, L, { x: 1500, y: -150 }, 400)!
    expect(hit.wallId).toBe(top.id)
    expect(hit.point.y).toBeCloseTo(-100)
    expect(hit.rotation).toBeCloseTo(270)
  })

  it('follows its wall when the wall moves or gets thicker', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'switch1', 1000, 60)
    moveWall(doc, top.id, 0, 300)
    normalize(doc)
    expect(doc.electrical![id].y).toBeCloseTo(400)
    expect(doc.electrical![id].x).toBeCloseTo(1000)
    doc.walls[top.id].thickness = 400
    normalize(doc)
    expect(doc.electrical![id].y).toBeCloseTo(500)
    expect(doc.electrical![id].wallId).toBe(top.id)
  })

  it('keeps its distance from the fixed end when the other end moves', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 1000, 60)
    // the node at x = 0 goes 500 left: the point keeps its distance from the fixed end at x = 4000
    const left = doc.nodes[top.a].x < 1 ? top.a : top.b
    moveNodes(doc, new Map([[left, { x: -500, y: 0 }]]))
    normalize(doc)
    expect(doc.electrical![id].x).toBeCloseTo(1000)
    expect(doc.electrical![id].y).toBeCloseTo(100)
    // the far end at x = 4000 tilts the wall: the point stays 1000 from the corner along the wall
    const right = left === top.a ? top.b : top.a
    moveNodes(doc, new Map([[right, { x: 4000, y: 1000 }]]))
    normalize(doc)
    const p = doc.electrical![id]
    const n = doc.nodes[left]
    const r = doc.nodes[right]
    const len = Math.hypot(r.x - n.x, r.y - n.y)
    const t = ((p.x - n.x) * (r.x - n.x) + (p.y - n.y) * (r.y - n.y)) / len
    expect(t).toBeCloseTo(1500)
    expect(p.wallId).toBe(top.id)
  })

  it('moves to the right piece when its wall is split, detaches when the wall is deleted', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 3000, 60)
    splitWall(doc, top.id, { x: 2000, y: 0 })
    normalize(doc)
    const p = doc.electrical![id]
    expect(doc.walls[p.wallId!]).toBeDefined()
    expect(p.x).toBeCloseTo(3000)
    expect(p.y).toBeCloseTo(100)
    removeEntities(doc, [{ kind: 'wall', id: p.wallId! }])
    normalize(doc)
    expect(doc.electrical![id]).toBeDefined()
    expect(doc.electrical![id].wallId).toBeUndefined()
    expect(doc.electrical![id].x).toBeCloseTo(3000)
  })

  it('duplicates along the wall and deletes', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socketDouble', 1000, 60)
    const [copy] = duplicateEntities(doc, [{ kind: 'electric', id }], 0, 0)
    normalize(doc)
    const c = doc.electrical![copy.id]
    expect(copy.kind).toBe('electric')
    expect(c.wallId).toBe(top.id)
    expect(c.x).toBeCloseTo(1250)
    expect(c.y).toBeCloseTo(100)
    removeEntities(doc, [{ kind: 'electric', id }, { kind: 'electric', id: copy.id }])
    normalize(doc)
    expect(doc.electrical).toBeUndefined()
  })

  it('ties a wall point to the room corners', () => {
    const { doc, L } = room()
    const id = addElectric(doc, L, 'socket', 1000, 60)
    const b = electricBinding(doc, derivePlan(doc, L), doc.electrical![id])!
    expect(b.room).toBe(true)
    // inner corners at x = 100 and x = 3900
    expect(Math.min(b.fromA, b.fromB)).toBeCloseTo(900)
    expect(Math.max(b.fromA, b.fromB)).toBeCloseTo(2900)
    expect(b.n.y).toBeCloseTo(1)
  })
})

describe('files', () => {
  it('round-trips points and reads old files without them', () => {
    const { doc, L } = room()
    const id = addElectric(doc, L, 'switch2', 1000, 60, { comment: 'у входа', gangs: 2 })
    const back = parseDoc(serializeDoc(doc))
    expect(back.electrical![id]).toEqual(doc.electrical![id])

    const old = JSON.parse(serializeDoc(doc))
    delete old.electrical
    expect(parseDoc(old).electrical).toBeUndefined()
  })

  it('sanitises broken records', () => {
    const { doc, L } = room()
    const raw = JSON.parse(serializeDoc(doc))
    raw.electrical = {
      e_a: { levelId: L, kind: 'laser', x: 500, y: 1500, gangs: 9 },
      e_b: { levelId: L, kind: 'socket', x: 'oops', y: 1 },
      e_c: { levelId: L, kind: 'socket', x: 1200, y: 100, gangs: 9, wallId: 'w_missing', side: 'right', mount: 'wall' },
    }
    const d = parseDoc(raw)
    expect(d.electrical!.e_a.kind).toBe('other')
    expect(d.electrical!.e_b).toBeUndefined()
    expect(d.electrical!.e_c.gangs).toBe(5)
    // the missing wall is replaced by the face the point sits on
    expect(d.electrical!.e_c.wallId).toBeDefined()
    expect(d.walls[d.electrical!.e_c.wallId!]).toBeDefined()
  })
})

describe('estimate and drawings', () => {
  it('counts points, frames and boxes', () => {
    const { doc, L } = room()
    addElectric(doc, L, 'socket', 1000, 60, { gangs: 2 })
    addElectric(doc, L, 'socket', 2000, 60)
    addElectric(doc, L, 'switch1', 300, 60)
    addElectric(doc, L, 'sensorSmoke', 2000, 1500)
    const rows = electricBomRows(doc)
    const by = (ref: string) => rows.find((r) => r.refId === ref)?.quantity
    expect(by('electric:socket')).toBe(3)
    expect(by('electric:switch1')).toBe(1)
    expect(by('electric:sensorSmoke')).toBe(1)
    expect(by('electric:frame:1')).toBe(2)
    expect(by('electric:frame:2')).toBe(1)
    expect(by('electric:box')).toBe(4)
    expect(rows.every((r) => r.group === 'Электрика')).toBe(true)
    expect(computeBom(doc).filter((r) => r.group === 'Электрика').length).toBe(rows.length)
  })

  it('draws a separate «Электрика» layer in the display list and DXF', () => {
    const { doc, L } = room()
    addElectric(doc, L, 'socket', 1000, 60)
    const dl = buildDisplayList(doc, L)
    const el = dl.items.filter((i) => i.layer === 'electrical')
    expect(el.length).toBeGreaterThan(2)
    expect(el.some((i) => i.t === 'text' && i.text === 'h=300')).toBe(true)
    expect(buildDisplayList(doc, L, { electrical: false }).items.some((i) => i.layer === 'electrical')).toBe(false)
    const dims = buildDisplayList(doc, L, { electricalDims: true }).items.filter((i) => i.role === 'electric-dim' || i.role === 'dim-text')
    expect(dims.some((i) => i.layer === 'electrical' && i.t === 'text' && /900/.test(i.text))).toBe(true)
    const dxf = toDxf(doc, L)
    expect(dxf).toContain('ELECTRICAL')
  })
})
