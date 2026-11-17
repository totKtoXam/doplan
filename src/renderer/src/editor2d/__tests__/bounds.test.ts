import { describe, expect, it } from 'vitest'
import { createEmptyDoc, defaultLevel } from '@core/defaults'
import { derivePlan } from '@core/derive'
import { addRectRoom, normalize, syncRooms } from '@core/ops'
import type { DerivedPlan, Doc, Id, Underlay } from '@core/types'
import { fitBounds, levelBelow, selectionBounds } from '../bounds'
import { Camera } from '../view'

function twoLevels(): { doc: Doc; lower: Id; upper: Id } {
  const doc = createEmptyDoc('test')
  const lower = doc.levelOrder[0]
  const up = defaultLevel('Этаж 2', 3000)
  doc.levels[up.id] = up
  doc.levelOrder.push(up.id)
  addRectRoom(doc, lower, 0, 0, 6000, 4000)
  normalize(doc)
  syncRooms(doc)
  return { doc, lower, upper: up.id }
}

const deriveAll = (doc: Doc): Record<Id, DerivedPlan> =>
  Object.fromEntries(doc.levelOrder.map((id) => [id, derivePlan(doc, id)]))

function underlay(levelId: Id, visible: boolean): Underlay {
  return {
    id: 'u1',
    levelId,
    src: 'data:,',
    x: 20000,
    y: 20000,
    scale: 10,
    rotation: 0,
    opacity: 0.5,
    visible,
    locked: false,
    widthPx: 100,
    heightPx: 50,
  }
}

describe('editor2d fitBounds', () => {
  it('frames the ghost of the level below when the active level is empty', () => {
    const { doc, lower, upper } = twoLevels()
    const all = deriveAll(doc)
    expect(levelBelow(doc, upper)).toBe(lower)
    const box = fitBounds(doc, all, upper, all[upper])
    expect(box).not.toBeNull()
    // the 6 × 4 m room drawn by the ghost (plus wall thickness)
    expect(box!.minX).toBeLessThanOrEqual(0)
    expect(box!.maxX).toBeGreaterThanOrEqual(6000)
    expect(box!.maxY).toBeGreaterThanOrEqual(4000)
    expect(box!.maxX).toBeLessThan(7000)
  })

  it('frames only the active level once it has content', () => {
    const { doc, upper } = twoLevels()
    addRectRoom(doc, upper, 10000, 10000, 2000, 2000)
    normalize(doc)
    syncRooms(doc)
    const all = deriveAll(doc)
    const box = fitBounds(doc, all, upper, all[upper])!
    expect(box.minX).toBeGreaterThan(9000)
    expect(box.maxX).toBeLessThan(13000)
  })

  it('a visible underlay counts as content, a hidden one falls back to the ghost', () => {
    const { doc, upper } = twoLevels()
    doc.underlays.u1 = underlay(upper, true)
    let all = deriveAll(doc)
    expect(fitBounds(doc, all, upper, all[upper])).toEqual({ minX: 20000, minY: 20000, maxX: 21000, maxY: 20500 })
    doc.underlays.u1 = underlay(upper, false)
    all = deriveAll(doc)
    expect(fitBounds(doc, all, upper, all[upper])!.maxX).toBeLessThan(7000)
  })

  it('returns null for an empty bottom level', () => {
    const doc = createEmptyDoc('test')
    const lv = doc.levelOrder[0]
    const all = deriveAll(doc)
    expect(fitBounds(doc, all, lv, all[lv])).toBeNull()
  })
})

describe('editor2d selectionBounds', () => {
  it('boxes the selected room and wall, ignores refs that are gone, null for nothing drawable', () => {
    const { doc, lower } = twoLevels()
    const plan = derivePlan(doc, lower)
    const roomId = Object.keys(doc.rooms)[0]
    const room = selectionBounds(doc, plan, [{ kind: 'room', id: roomId }])!
    // the inner faces of the 6 × 4 m room
    expect(room.minX).toBeGreaterThanOrEqual(0)
    expect(room.maxX).toBeLessThanOrEqual(6000)
    expect(room.maxX - room.minX).toBeGreaterThan(5000)
    const wallId = Object.keys(doc.walls)[0]
    const both = selectionBounds(doc, plan, [{ kind: 'room', id: roomId }, { kind: 'wall', id: wallId }, { kind: 'item', id: 'gone' }])!
    expect(both.minX).toBeLessThanOrEqual(room.minX)
    expect(both.maxY).toBeGreaterThanOrEqual(room.maxY)
    expect(selectionBounds(doc, plan, [{ kind: 'item', id: 'gone' }])).toBeNull()
    expect(selectionBounds(doc, plan, [])).toBeNull()
  })
})

describe('editor2d Camera.setSize', () => {
  it('keeps the plan point under the viewport centre fixed', () => {
    const cam = new Camera()
    cam.setSize(800, 600)
    cam.fit({ minX: 0, minY: 0, maxX: 5000, maxY: 3000 })
    cam.panBy(-120, 45)
    const before = cam.toPlan(400, 300)
    cam.setSize(1200, 500)
    const after = cam.toPlan(600, 250)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})
