import { createEmptyDoc, defaultLevel } from '@core'
import { describe, expect, it } from 'vitest'
import { removeLevelFromDraft } from './levels'

describe('removeLevelFromDraft', () => {
  it('takes the pencil marks of the level with it, keeps the others', () => {
    const doc = createEmptyDoc('t')
    const keep = doc.levelOrder[0]
    const gone = { ...defaultLevel(), name: '2' }
    doc.levels[gone.id] = gone
    doc.levelOrder.push(gone.id)
    doc.annotations = {
      a: { id: 'a', levelId: keep, n: 1, shape: 'stroke', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      b: { id: 'b', levelId: gone.id, n: 2, shape: 'stroke', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    }
    removeLevelFromDraft(doc, gone.id)
    expect(Object.keys(doc.annotations)).toEqual(['a'])
    expect(doc.levelOrder).toEqual([keep])
  })
})
