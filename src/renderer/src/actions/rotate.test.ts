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
})
