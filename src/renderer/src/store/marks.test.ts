import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyDoc, setGroupFlag, setHidden, setLocked } from '@core'
import { docStore } from './document'
import { addMark, clearMarks, deleteMark } from './marks'

const st = () => docStore.getState()
const marks = () => Object.keys(st().doc.annotations ?? {})
const level = () => st().doc.levelOrder[0]
const pts = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 1000 },
]

describe('pencil marks and the layers panel', () => {
  beforeEach(() => {
    st().load(createEmptyDoc('A'), '/tmp/a.doplan')
  })

  it('a locked mark is not deleted', () => {
    const id = addMark(level(), 'zone', pts)
    st().transact('lock', (d) => {
      setLocked(d, [{ kind: 'annotation', id }], true)
    })
    deleteMark(id)
    expect(marks()).toEqual([id])
  })

  it('a mark locked through its group is not deleted', () => {
    const id = addMark(level(), 'zone', pts)
    st().transact('lock group', (d) => {
      setGroupFlag(d, 'annotation', 'locked', true)
    })
    deleteMark(id)
    expect(marks()).toEqual([id])
  })

  it('«clear marks» keeps locked and hidden marks', () => {
    const free = addMark(level(), 'zone', pts)
    const locked = addMark(level(), 'stroke', pts)
    const hidden = addMark(level(), 'stroke', pts)
    st().transact('flags', (d) => {
      setLocked(d, [{ kind: 'annotation', id: locked }], true)
      setHidden(d, [{ kind: 'annotation', id: hidden }], true)
    })
    clearMarks(level())
    expect(marks()).not.toContain(free)
    expect(marks().sort()).toEqual([locked, hidden].sort())
  })
})
