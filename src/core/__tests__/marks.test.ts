import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { derivePlan } from '../derive'
import { parseDoc, serializeDoc } from '../io'
import { describeMark, markAt, markBadge, markDistance, markTargets, nextMarkNumber } from '../marks'
import { applyNodeDistance } from '../measure'
import { addRectRoom, addWall, normalize, syncRooms } from '../ops'
import type { Annotation, Doc, Id } from '../types'

/** one room 0…4000 × 0…3000 (centrelines), walls 100 mm → clear faces at x 50/3950, y 50/2950 */
function room(): { doc: Doc; levelId: Id } {
  const doc = createEmptyDoc('test')
  const levelId = doc.levelOrder[0]
  addRectRoom(doc, levelId, 0, 0, 4000, 3000, { thickness: 100 })
  normalize(doc)
  syncRooms(doc)
  return { doc, levelId }
}

const mark = (levelId: Id, points: Annotation['points'], shape: Annotation['shape'] = 'stroke', n = 1): Annotation => ({ id: `pm_${n}`, levelId, n, shape, points })

describe('pencil marks: hit-testing', () => {
  it('a stroke along the inner face of the top wall picks that wall side with high cover', () => {
    const { doc, levelId } = room()
    const plan = derivePlan(doc, levelId)
    const m = mark(levelId, [
      { x: 300, y: 120 },
      { x: 2000, y: 110 },
      { x: 3700, y: 120 },
    ])
    const t = markTargets(doc, plan, m)
    expect(t.runs.length).toBeGreaterThan(0)
    const top = t.runs[0]
    expect(top.cover).toBeGreaterThan(0.7)
    expect(Math.round(top.length)).toBe(3900)
    const topWall = Object.values(doc.walls).find((w) => doc.nodes[w.a].y === 0 && doc.nodes[w.b].y === 0)!
    expect(top.key.startsWith(`${topWall.id}:`)).toBe(true)
    expect(t.walls.map((w) => w.id)).toEqual([topWall.id])
    // the bottom and side walls are far away
    expect(t.runs.every((r) => r.key.startsWith(topWall.id))).toBe(true)
    expect(t.rooms).toHaveLength(1)
    const text = describeMark(doc, m, t)
    expect(text).toContain(top.key)
    expect(text).toContain('3900')
  })

  it('a stroke drawn along a face 30 cm inside the room still means that face, not the neighbour behind the wall', () => {
    const doc = createEmptyDoc('test')
    const levelId = doc.levelOrder[0]
    // two rooms stacked: top y 0…3000, bottom y 3000…6000, partition at y = 3000 (100 mm)
    addRectRoom(doc, levelId, 0, 0, 4000, 6000, { thickness: 100 })
    addWall(doc, levelId, { x: 0, y: 3000 }, { x: 4000, y: 3000 }, { thickness: 100 })
    normalize(doc)
    syncRooms(doc)
    const plan = derivePlan(doc, levelId)
    const m = mark(levelId, [
      { x: 200, y: 3350 },
      { x: 2000, y: 3340 },
      { x: 3800, y: 3360 },
    ])
    const t = markTargets(doc, plan, m)
    const part = Object.values(doc.walls).find((w) => doc.nodes[w.a].y === 3000 && doc.nodes[w.b].y === 3000)!
    expect(t.runs[0].key.startsWith(`${part.id}:`)).toBe(true)
    expect(t.runs[0].cover).toBeGreaterThan(0.8)
    // only the bottom room's face of the partition, not the top room's
    expect(t.runs.filter((r) => r.key.startsWith(part.id))).toHaveLength(1)
    expect(t.walls.map((w) => w.id)).toContain(part.id)
  })

  it('a zone around a corner takes the corner node and both walls; a zone inside the room only the room', () => {
    const { doc, levelId } = room()
    const plan = derivePlan(doc, levelId)
    const corner = mark(
      levelId,
      [
        { x: -300, y: -300 },
        { x: 400, y: -300 },
        { x: 400, y: 400 },
        { x: -300, y: 400 },
      ],
      'zone',
    )
    const t = markTargets(doc, plan, corner)
    const origin = Object.values(doc.nodes).find((n) => n.x === 0 && n.y === 0)!
    expect(t.nodes).toContain(origin.id)
    expect(t.walls).toHaveLength(2)
    expect(t.rooms).toHaveLength(1)
    expect(markDistance(corner, { x: 0, y: 0 })).toBe(0)

    const inner = mark(
      levelId,
      [
        { x: 1500, y: 1200 },
        { x: 2500, y: 1200 },
        { x: 2500, y: 1800 },
        { x: 1500, y: 1800 },
      ],
      'zone',
      2,
    )
    const ti = markTargets(doc, plan, inner)
    expect(ti.walls).toHaveLength(0)
    expect(ti.runs).toHaveLength(0)
    expect(ti.rooms).toHaveLength(1)
  })

  it('numbers, badges, markAt and the io round trip', () => {
    const { doc, levelId } = room()
    expect(markBadge(1)).toBe('①')
    expect(markBadge(21)).toBe('(21)')
    expect(nextMarkNumber(doc)).toBe(1)
    doc.annotations = {
      pm_1: mark(levelId, [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ]),
      pm_2: {
        ...mark(
          levelId,
          [
            { x: 0, y: 10 },
            { x: 1000, y: 10 },
          ],
          'stroke',
          2,
        ),
        done: true,
      },
    }
    expect(nextMarkNumber(doc)).toBe(3)
    expect(markAt(doc, levelId, { x: 500, y: 40 }, 60)?.id).toBe('pm_2')
    expect(markAt(doc, levelId, { x: 500, y: 900 }, 60)).toBeNull()
    const back = parseDoc(serializeDoc(doc))
    expect(back.annotations?.pm_2).toMatchObject({ n: 2, done: true, shape: 'stroke' })
    expect(back.annotations?.pm_1.points).toHaveLength(2)
  })
})

describe('applyNodeDistance', () => {
  it('slides the moving node along the line so the distance matches; the walls follow', () => {
    const { doc, levelId } = room()
    const nodes = Object.values(doc.nodes)
    const a = nodes.find((n) => n.x === 0 && n.y === 0)!
    const b = nodes.find((n) => n.x === 4000 && n.y === 0)!
    const res = applyNodeDistance(doc, levelId, a.id, b.id, 4150)
    expect(res.ok, res.error).toBe(true)
    expect(Math.round(res.before)).toBe(4000)
    expect(Math.round(res.after)).toBe(4150)
    expect(Math.round(doc.nodes[b.id].x)).toBe(4150)
    expect(doc.nodes[a.id].x).toBe(0)
    expect(applyNodeDistance(doc, levelId, a.id, a.id, 1000).ok).toBe(false)
  })
})
