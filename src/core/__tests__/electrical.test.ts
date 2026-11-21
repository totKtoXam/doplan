import { enablePatches, produceWithPatches } from 'immer'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { parseDoc, serializeDoc } from '../io'
import { addRectRoom, addWall, duplicateEntities, moveNodes, moveWall, normalize, removeEntities, splitWall } from '../ops'
import {
  ELECTRIC_KINDS,
  ELECTRIC_TYPES,
  addElectric,
  alongWall,
  clampOnFace,
  electricBinding,
  electricBomRows,
  electricLabelLines,
  electricPointSymbol,
  electricSymbol,
  electricType,
  nearestWallFace,
  wallFaceRange,
} from '../electrical'
import { computeBom } from '../bom'
import { buildDisplayList } from '../display'
import { derivePlan } from '../derive'
import { toDxf } from '../export/dxf'
import { DOC_VERSION, DOC_VERSION_V3, type Doc, type Id, type Wall } from '../types'
import { addLayer, assignLayer, entityKind, layerIndex, setHidden, setLocked, visibleDoc } from '../layers'
import { syncFormatVersion } from '../variants'

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
    expect(doc.electrical).toEqual({})
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

describe('review fixes', () => {
  it('patches single points, never the whole record (a stale AI draft keeps the user points)', () => {
    enablePatches()
    const { doc, L } = room()
    expect(doc.electrical).toEqual({})
    const [one, added] = produceWithPatches(doc, (d) => {
      addElectric(d, L, 'socket', 1000, 60)
      normalize(d)
    })
    const ofRecord = (ps: typeof added) => ps.filter((p) => p.path[0] === 'electrical')
    expect(ofRecord(added).length).toBeGreaterThan(0)
    for (const p of ofRecord(added)) expect(p.path.length).toBeGreaterThanOrEqual(2)
    const id = Object.keys(one.electrical!)[0]
    const [none, removed] = produceWithPatches(one, (d) => {
      removeEntities(d, [{ kind: 'electric', id }])
      normalize(d)
    })
    expect(none.electrical).toEqual({})
    expect(ofRecord(removed).length).toBeGreaterThan(0)
    for (const p of ofRecord(removed)) expect(p.path.length).toBeGreaterThanOrEqual(2)
  })

  it('does not put a point on a virtual wall', () => {
    const { doc, L } = room()
    const [vid] = addWall(doc, L, { x: 1000, y: 1000 }, { x: 3000, y: 1000 }, { kind: 'virtual' })
    normalize(doc)
    expect(doc.walls[vid].kind).toBe('virtual')
    const id = addElectric(doc, L, 'socket', 2000, 1100, { wallId: vid, side: 'right' })
    normalize(doc)
    expect(doc.electrical![id].wallId).toBeUndefined()
    expect(nearestWallFace(doc, L, { x: 2000, y: 1100 }, 400)).toBeNull()
  })

  it('detaches a corner point in place when its wall is deleted, without turning it onto the side wall', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 150, 60)
    expect(doc.electrical![id].wallId).toBe(top.id)
    expect(doc.electrical![id].rotation).toBeCloseTo(90)
    removeEntities(doc, [{ kind: 'wall', id: top.id }])
    normalize(doc)
    const p = doc.electrical![id]
    expect(p.wallId).toBeUndefined()
    expect(p.x).toBeCloseTo(150)
    expect(p.y).toBeCloseTo(100)
    expect(p.rotation).toBeCloseTo(90)
  })

  it('keeps a frame on the visible face, clear of the adjoining wall at the room corner', () => {
    const { doc, L, top } = room()
    for (const x of [0, 20, 60]) {
      // no plan needed: the face range comes from the walls at the corner
      const id = addElectric(doc, L, 'socket', x, 100)
      normalize(doc)
      const p = doc.electrical![id]
      expect(p.wallId).toBe(top.id)
      // the inner face starts at x = 100; half the frame is 43
      expect(p.x).toBeCloseTo(143)
      const b = electricBinding(doc, derivePlan(doc, L), p)!
      expect(b.room).toBe(true)
      expect(Math.min(b.fromA, b.fromB)).toBeCloseTo(43)
    }
    // a 3-post frame keeps 43 + 2 × 35.5 from the far corner
    const wide = addElectric(doc, L, 'socketDouble', 3990, 100, { gangs: 3 })
    expect(doc.electrical![wide].x).toBeCloseTo(3900 - 114)
    // the face range agrees with the derived plan's face segment
    const p = doc.electrical![wide]
    const seg = derivePlan(doc, L).wallGeoms[top.id][p.side!]
    expect(Math.max(seg[0].x, seg[1].x)).toBeCloseTo(3900)
    // the outer face is not limited at the outer corner
    const out = addElectric(doc, L, 'socket', 20, -150)
    normalize(doc)
    expect(doc.electrical![out].y).toBeCloseTo(-100)
    expect(doc.electrical![out].x).toBeCloseTo(20)
    expect(clampOnFace(doc, top.id, doc.electrical![out].side!, -50, 43)).toBe(0)
  })

  it('agrees with the plan at corners with a thinner wall, stops at a short outer face', () => {
    for (const deg of [160, 135, 90]) {
      const doc = createEmptyDoc()
      const L = doc.levelOrder[0]
      const a = ((180 - deg) * Math.PI) / 180
      addWall(doc, L, { x: 0, y: 0 }, { x: 3000, y: 0 }, { thickness: 200 })
      addWall(doc, L, { x: 3000, y: 0 }, { x: 3000 + 2000 * Math.cos(a), y: 2000 * Math.sin(a) }, { thickness: 120 })
      normalize(doc)
      const wA = Object.values(doc.walls).find((w) => w.thickness === 200)!
      const plan = derivePlan(doc, L)
      for (const side of ['left', 'right'] as const) {
        const seg = plan.wallGeoms[wA.id][side]
        const ts = seg.map((q) => alongWall(doc, wA.id, q)!)
        const r = wallFaceRange(doc, wA.id, side)!
        expect(r.lo, `${deg}° ${side} start`).toBeCloseTo(Math.max(0, Math.min(...ts)), 0)
        expect(r.hi, `${deg}° ${side} end`).toBeCloseTo(Math.min(r.len, Math.max(...ts)), 0)
      }
      // a socket pushed to the outer end of A stays on its visible face, half a frame from the end
      const id = addElectric(doc, L, 'socket', 2995, -150)
      normalize(doc)
      const p = doc.electrical![id]
      expect(p.wallId).toBe(wA.id)
      const seg = plan.wallGeoms[wA.id][p.side!]
      const end = Math.max(seg[0].x, seg[1].x)
      expect(p.x + 43, `${deg}°`).toBeLessThanOrEqual(end + 0.5)
      // short of the node only where the face is short of it
      if (end < 3000) expect(p.x).toBeCloseTo(end - 43, 0)
    }
  })

  it('moves a frame widened in place off the adjoining wall', () => {
    const { doc, L } = room()
    const id = addElectric(doc, L, 'socketDouble', 0, 100)
    normalize(doc)
    expect(doc.electrical![id].x).toBeCloseTo(143)
    doc.electrical![id].gangs = 4
    normalize(doc)
    expect(doc.electrical![id].x).toBeCloseTo(100 + 43 + 3 * 35.5)
    doc.electrical![id].vertical = true
    normalize(doc)
    // a vertical frame is narrow again; the point stays where it is (still clear)
    expect(doc.electrical![id].x).toBeCloseTo(100 + 43 + 3 * 35.5)
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
    expect(parseDoc(old).electrical).toEqual({})
  })

  it('writes a file with a socket as format 3, without points as before', () => {
    const { doc, L } = room()
    expect(JSON.parse(serializeDoc(doc)).version).toBe(DOC_VERSION)
    const id = addElectric(doc, L, 'socket', 1000, 60)
    normalize(doc)
    syncFormatVersion(doc)
    // the live document follows too (the store syncs it after every edit; the app saves it as is)
    expect(doc.version).toBe(DOC_VERSION_V3)
    const text = serializeDoc(doc)
    expect(JSON.parse(text).version).toBeGreaterThan(2)
    expect(JSON.parse(text).version).toBe(DOC_VERSION_V3)
    // this app opens it back with the point; an app that knows only format 2 would refuse it
    const back = parseDoc(text)
    expect(back.version).toBe(DOC_VERSION_V3)
    expect(back.electrical![id]).toBeDefined()
    removeEntities(doc, [{ kind: 'electric', id }])
    normalize(doc)
    syncFormatVersion(doc)
    expect(doc.version).toBe(DOC_VERSION)
    expect(JSON.parse(serializeDoc(doc)).version).toBe(DOC_VERSION)
    expect(() => parseDoc({ ...JSON.parse(text), version: 6 })).toThrow(/новой версии/)
  })

  it('sanitises broken records', () => {
    const { doc, L } = room()
    const raw = JSON.parse(serializeDoc(doc))
    raw.electrical = {
      e_a: { levelId: L, kind: 'laser', x: 500, y: 1500, gangs: 9 },
      e_b: { levelId: L, kind: 'socket', x: 'oops', y: 1 },
      e_c: { levelId: L, kind: 'socket', x: 1200, y: 100, rotation: 90, gangs: 9, wallId: 'w_missing', side: 'right', mount: 'wall' },
    }
    const d = parseDoc(raw)
    expect(d.electrical!.e_a.kind).toBe('other')
    expect(d.electrical!.e_b).toBeUndefined()
    expect(d.electrical!.e_c.gangs).toBe(5)
    // the missing wall is replaced by the face the point sits on (and looks the same way)
    expect(d.electrical!.e_c.wallId).toBeDefined()
    expect(d.walls[d.electrical!.e_c.wallId!]).toBeDefined()
  })
})

describe('layers panel', () => {
  it('is a kind of its own: named after the type, child of its wall', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 1000, 60, { gangs: 2 })
    const def = entityKind('electric')!
    expect(def.docKey).toBe('electrical')
    const p = doc.electrical![id]
    expect(def.name(p, { doc, lang: 'ru' })).toBe('Розетка одинарная ×2')
    expect(def.parent!(p, doc)).toEqual({ kind: 'wall', id: top.id })
    def.rename!(p, '  Холодильник ')
    expect(def.name(p, { doc, lang: 'ru' })).toBe('Холодильник')
    def.rename!(p, '')
    expect(p.name).toBeUndefined()
  })

  it('keeps name, hidden, locked and the layer through a file', () => {
    const { doc, L } = room()
    const a = addElectric(doc, L, 'socket', 1000, 60)
    const b = addElectric(doc, L, 'switch1', 300, 60)
    const ly = addLayer(doc, 'Розетки')
    assignLayer(doc, [{ kind: 'electric', id: a }], ly)
    doc.electrical![a].name = 'Чайник'
    setHidden(doc, [{ kind: 'electric', id: a }], true)
    setLocked(doc, [{ kind: 'electric', id: b }], true)
    const back = parseDoc(serializeDoc(doc))
    expect(back.version).toBe(DOC_VERSION_V3)
    expect(back.electrical![a]).toMatchObject({ name: 'Чайник', hidden: true, layerId: ly })
    expect(back.electrical![b].locked).toBe(true)
    const idx = layerIndex(back)
    expect(idx.hidden('electric', a)).toBe(true)
    expect(idx.pickable('electric', b)).toBe(false)
    // a broken layer id is dropped
    const raw = JSON.parse(serializeDoc(doc))
    raw.electrical[a].layerId = 'ly_missing'
    expect(parseDoc(raw).electrical![a].layerId).toBeUndefined()
  })

  it('a point hides and locks with its wall and is left out of drawings', () => {
    const { doc, L, top } = room()
    const id = addElectric(doc, L, 'socket', 1000, 60)
    setHidden(doc, [{ kind: 'wall', id: top.id }], true)
    const v = { ...doc }
    expect(layerIndex(v).hidden('electric', id)).toBe(true)
    expect(visibleDoc(v).electrical![id]).toBeUndefined()
    expect(buildDisplayList(v, L).items.some((i) => i.layer === 'electrical')).toBe(false)
    expect(toDxf(v, L)).not.toContain('h=300')
    setHidden(doc, [{ kind: 'wall', id: top.id }], false)
    setLocked(doc, [{ kind: 'wall', id: top.id }], true)
    const w = { ...doc }
    expect(layerIndex(w).hidden('electric', id)).toBe(false)
    expect(layerIndex(w).pickable('electric', id)).toBe(false)
  })

  it('is never put on a hidden wall', () => {
    const { doc, L, top } = room()
    setHidden(doc, [{ kind: 'wall', id: top.id }], true)
    expect(nearestWallFace(doc, L, { x: 1000, y: 100 }, 400, { skipHidden: true })).toBeNull()
    // re-seating after a wall edit still sees it (only putting a point somewhere skips hidden walls)
    expect(nearestWallFace(doc, L, { x: 1000, y: 100 }, 400)?.wallId).toBe(top.id)
    // the given wall is hidden: as without it (no visible face near)
    const id = addElectric(doc, L, 'socket', 1000, 100, { wallId: top.id })
    expect(doc.electrical![id].wallId).toBeUndefined()
    // a hidden walls group or user layer counts too
    setHidden(doc, [{ kind: 'wall', id: top.id }], false)
    const ly = addLayer(doc, 'Стены')
    assignLayer(doc, [{ kind: 'wall', id: top.id }], ly)
    doc.layers![ly].hidden = true
    expect(nearestWallFace(doc, L, { x: 1000, y: 100 }, 400, { skipHidden: true })).toBeNull()
    doc.layers![ly].hidden = false
    expect(nearestWallFace(doc, L, { x: 1000, y: 100 }, 400, { skipHidden: true })?.wallId).toBe(top.id)
  })

  it('a lone duplicate is not put on a hidden wall; one copied with its walls is', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [side] = addWall(doc, L, { x: 1550, y: 300 }, { x: 1550, y: 2000 }, { thickness: 100 })
    normalize(doc)
    const id = addElectric(doc, L, 'socket', 1000, 100)
    const base = doc.electrical![id].wallId!
    expect(base).not.toBe(side)
    setHidden(doc, [{ kind: 'wall', id: side }], true)
    const [copy] = duplicateEntities(doc, [{ kind: 'electric', id }], 500, 500)
    normalize(doc)
    // stays on the wall of the original, shifted along it
    expect(doc.electrical![copy.id].wallId).toBe(base)
    // the walls group hidden: copies of walls are hidden too, the copied point still sits on its copy
    const d2 = createEmptyDoc()
    const L2 = d2.levelOrder[0]
    const [w] = addWall(d2, L2, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    normalize(d2)
    const e = addElectric(d2, L2, 'socket', 1000, 100)
    d2.groupFlags = { wall: { hidden: true } }
    const out = duplicateEntities(d2, [{ kind: 'wall', id: w }, { kind: 'electric', id: e }], 0, 1000)
    normalize(d2)
    const wallCopy = out.find((r) => r.kind === 'wall')!.id
    const pointCopy = out.find((r) => r.kind === 'electric')!.id
    expect(d2.electrical![pointCopy].wallId).toBe(wallCopy)
    expect(d2.electrical![pointCopy].y).toBeCloseTo(1100)
  })

  it('deleting a visible wall never moves its points onto a hidden one', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    const [a] = addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [b] = addWall(doc, L, { x: 0, y: 125 }, { x: 4000, y: 125 }, { thickness: 50 })
    normalize(doc)
    setHidden(doc, [{ kind: 'wall', id: a }], true)
    const id = addElectric(doc, L, 'socket', 1000, 300)
    const p = doc.electrical![id]
    expect(p.wallId).toBe(b)
    expect(p.y).toBeCloseTo(150)
    removeEntities(doc, [{ kind: 'wall', id: b }])
    normalize(doc)
    expect(p.wallId).toBeUndefined()
    expect(p.y).toBeCloseTo(150)
  })

  it('a point dragged off its hidden wall never lands on another hidden wall', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    const [h] = addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [h2] = addWall(doc, L, { x: 6000, y: 0 }, { x: 10000, y: 0 }, { thickness: 200 })
    normalize(doc)
    const id = addElectric(doc, L, 'socket', 1000, 100)
    const p = doc.electrical![id]
    expect(p.wallId).toBe(h)
    setHidden(doc, [{ kind: 'wall', id: h }, { kind: 'wall', id: h2 }], true)
    // moved with a group (marquee / arrows move only x, y)
    p.x += 7000
    normalize(doc)
    expect(p.wallId).toBeUndefined()
    expect(p.x).toBeCloseTo(8000)
  })

  it('a point dragged to a hidden wall meeting its own end to end (a T-junction) is not put on it', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    const [h] = addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [h2] = addWall(doc, L, { x: 4000, y: 0 }, { x: 8000, y: 0 }, { thickness: 200 })
    addWall(doc, L, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { thickness: 100 })
    normalize(doc)
    // the partition keeps the two walls apart
    expect(doc.walls[h]).toBeDefined()
    expect(doc.walls[h2]).toBeDefined()
    const id = addElectric(doc, L, 'socket', 3000, -100)
    const p = doc.electrical![id]
    expect(p.wallId).toBe(h)
    setHidden(doc, [{ kind: 'wall', id: h }, { kind: 'wall', id: h2 }], true)
    p.x += 2000
    normalize(doc)
    expect(p.wallId).toBeUndefined()
    expect(p.x).toBeCloseTo(5000)
  })

  it('copying walls with a point: an existing hidden wall the copy runs into is not taken', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    const [w] = addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [h] = addWall(doc, L, { x: 500, y: 500 }, { x: 4500, y: 500 }, { thickness: 200 })
    normalize(doc)
    const id = addElectric(doc, L, 'socket', 1000, 100)
    expect(doc.electrical![id].wallId).toBe(w)
    setHidden(doc, [{ kind: 'wall', id: h }], true)
    const out = duplicateEntities(doc, [{ kind: 'wall', id: w }, { kind: 'electric', id }], 500, 500)
    normalize(doc)
    const copy = doc.electrical![out.find((r) => r.kind === 'electric')!.id]
    expect(copy.wallId).not.toBe(h)
    expect(layerIndex({ ...doc }).hidden('electric', copy.id)).toBe(false)
  })

  it('stays on a hidden wall that is merged or split', () => {
    const doc = createEmptyDoc()
    const L = doc.levelOrder[0]
    addWall(doc, L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [part] = addWall(doc, L, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { thickness: 100 })
    normalize(doc)
    const halves = () => Object.values(doc.walls).filter((w) => w.id !== part)
    expect(halves()).toHaveLength(2)
    const id = addElectric(doc, L, 'socket', 3000, 100)
    const p = doc.electrical![id]
    const w2 = p.wallId!
    expect(halves().map((w) => w.id)).toContain(w2)
    // both halves on a hidden user layer
    const ly = addLayer(doc, 'Существующие')
    assignLayer(doc, halves().map((w) => ({ kind: 'wall', id: w.id })), ly)
    doc.layers![ly].hidden = true
    // the visible partition goes: the halves merge, one of them is deleted
    removeEntities(doc, [{ kind: 'wall', id: part }])
    normalize(doc)
    const merged = Object.values(doc.walls)
    expect(merged).toHaveLength(1)
    expect(p.wallId).toBe(merged[0].id)
    expect(p.side).toBeDefined()
    expect(p.y).toBeCloseTo(100)
    // split again (a wall joined at its middle): the point keeps a half under it
    addWall(doc, L, { x: 2500, y: 0 }, { x: 2500, y: -2000 }, { thickness: 100 })
    normalize(doc)
    expect(p.wallId).toBeDefined()
    expect(doc.walls[p.wallId!].layerId).toBe(ly)
    expect(p.y).toBeCloseTo(100)
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
