import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addWall, createEmptyDoc } from '@core'
import type { EntityRef } from '@core/types'

vi.mock('@/store/api', () => {
  const fallback = (o: Record<string, unknown> = {}): unknown => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  return { api: fallback({ platform: 'win32', aiChat: fallback({ onEvent: () => () => {} }), settings: fallback(), project: fallback() }) }
})

const { docStore } = await import('@/store/document')
const { uiStore } = await import('@/store/ui')
const { canGroupRotate, groupRotate, ROTATABLE_KINDS } = await import('./edit')

describe('rotating dimensions and labels', () => {
  let n1 = ''
  let n2 = ''
  beforeEach(() => {
    const doc = createEmptyDoc('T')
    const levelId = doc.levelOrder[0]
    doc.dimensions.d = { id: 'd', levelId, a: { x: 1000, y: 1000 }, b: { x: 3000, y: 1000 }, offset: 0 }
    doc.labels.l1 = { id: 'l1', levelId, x: 0, y: 0, text: 'a', size: 200 }
    doc.labels.l2 = { id: 'l2', levelId, x: 2000, y: 0, text: 'b', size: 200 }
    const [w] = addWall(doc, levelId, { x: 1000, y: 500 }, { x: 3000, y: 500 }, { thickness: 200 })
    n1 = doc.walls[w].a
    n2 = doc.walls[w].b
    docStore.getState().load(doc, null)
    uiStore.setState({ activeLevelId: levelId })
  })

  const select = (refs: EntityRef[]) => uiStore.setState({ selection: refs })

  it('the floating bar offers rotation for every kind that Shift+R turns', () => {
    expect(ROTATABLE_KINDS.has('dimension')).toBe(true)
    expect(ROTATABLE_KINDS.has('label')).toBe(true)
  })

  it('a single dimension turns about its middle', () => {
    select([{ kind: 'dimension', id: 'd' }])
    groupRotate(90)
    const d = docStore.getState().doc.dimensions.d
    expect(d.a.x).toBeCloseTo(2000)
    expect(d.a.y).toBeCloseTo(0)
    expect(d.b.x).toBeCloseTo(2000)
    expect(d.b.y).toBeCloseTo(2000)
  })

  it('two labels turn about their common centre', () => {
    select([
      { kind: 'label', id: 'l1' },
      { kind: 'label', id: 'l2' },
    ])
    groupRotate(90)
    const { l1, l2 } = docStore.getState().doc.labels
    expect([l1.x, l1.y].map(Math.round)).toEqual([1000, -1000])
    expect([l2.x, l2.y].map(Math.round)).toEqual([1000, 1000])
  })

  it('the button is off when rotating would change nothing: a single label', () => {
    const doc = () => docStore.getState().doc
    expect(canGroupRotate(doc(), [{ kind: 'label', id: 'l1' }])).toBe(false)
    expect(canGroupRotate(doc(), [{ kind: 'label', id: 'l1' }, { kind: 'label', id: 'l2' }])).toBe(true)
    expect(canGroupRotate(doc(), [{ kind: 'dimension', id: 'd' }])).toBe(true)
    expect(canGroupRotate(doc(), [{ kind: 'room', id: 'nope' }])).toBe(false)
    expect(canGroupRotate(doc(), [])).toBe(false)
    // a lone wall node is one point too; two of them turn about their middle
    expect(canGroupRotate(doc(), [{ kind: 'node', id: n1 }])).toBe(false)
    expect(canGroupRotate(doc(), [{ kind: 'node', id: n1 }, { kind: 'node', id: n2 }])).toBe(true)
    // and indeed a single label stays where it was
    select([{ kind: 'label', id: 'l1' }])
    const before = doc()
    groupRotate(90)
    expect(doc()).toBe(before)
  })

  it('the button is off for a wall whose ends sit on locked walls', () => {
    const d = createEmptyDoc('T')
    const levelId = d.levelOrder[0]
    const [w1] = addWall(d, levelId, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    const [w2] = addWall(d, levelId, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { thickness: 200 })
    const [w3] = addWall(d, levelId, { x: 4000, y: 3000 }, { x: 0, y: 3000 }, { thickness: 200 })
    expect(d.walls[w2].a === d.walls[w1].b || d.walls[w2].b === d.walls[w1].b).toBe(true)
    d.walls[w1].locked = true
    docStore.getState().load(d, null)
    uiStore.setState({ activeLevelId: levelId })
    const doc = () => docStore.getState().doc
    const wall = (id: string): EntityRef[] => [{ kind: 'wall', id }]
    // one end free: it turns about that end, which stays where it is
    expect(canGroupRotate(doc(), wall(w2))).toBe(false)
    select(wall(w2))
    let before = doc()
    groupRotate(90)
    expect(doc()).toBe(before)
    // with another, free wall it turns about their common centre
    expect(canGroupRotate(doc(), [...wall(w2), ...wall(w3)])).toBe(true)
    // both ends on locked walls
    docStore.getState().load({ ...doc(), walls: { ...doc().walls, [w3]: { ...doc().walls[w3], locked: true } } }, null)
    expect(canGroupRotate(doc(), wall(w2))).toBe(false)
    select(wall(w2))
    before = doc()
    groupRotate(90)
    expect(doc()).toBe(before)
  })

  it('a free wall can turn', () => {
    const d = createEmptyDoc('T')
    const levelId = d.levelOrder[0]
    const [w] = addWall(d, levelId, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 })
    docStore.getState().load(d, null)
    uiStore.setState({ activeLevelId: levelId })
    expect(canGroupRotate(docStore.getState().doc, [{ kind: 'wall', id: w }])).toBe(true)
    uiStore.setState({ selection: [{ kind: 'wall', id: w }] })
    const before = docStore.getState().doc
    groupRotate(90)
    expect(docStore.getState().doc).not.toBe(before)
  })
})
