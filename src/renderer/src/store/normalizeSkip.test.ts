import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { addRectRoom, addWall, createEmptyDoc, normalize, syncFormatVersion, syncRooms } from '@core'
import type { Doc } from '@core/types'
import { docStore, touchesPlan } from './document'

const st = () => docStore.getState()

/** the full normalisation the store runs on a change that may break the plan */
const normalized = (doc: Doc): Doc =>
  produce(doc, (d) => {
    normalize(d)
    syncRooms(d)
    syncFormatVersion(d)
  })

function load(): void {
  const doc = produce(createEmptyDoc('A'), (d) => {
    const L = d.levelOrder[0]
    addRectRoom(d, L, 0, 0, 4000, 3000, { thickness: 200 })
    addRectRoom(d, L, 4000, 0, 3000, 3000, { thickness: 200 })
    d.items.i1 = { id: 'i1', levelId: L, assetId: 'chair', x: 1000, y: 1000, elevation: 0, rotation: 0, size: { w: 500, d: 500, h: 900 } } as Doc['items'][string]
  })
  st().load(doc, '/tmp/a.doplan')
}
const roomIds = () => Object.keys(st().doc.rooms)
const withoutStamp = (d: Doc) => ({ ...d, meta: { ...d.meta, modifiedAt: '' } })

describe('changes the normalisation cannot see skip it', () => {
  it('tells plan edits from the rest', () => {
    expect(touchesPlan([{ op: 'replace', path: ['rooms', 'r1', 'name'], value: 'x' }])).toBe(false)
    expect(touchesPlan([{ op: 'replace', path: ['items', 'i1', 'x'], value: 1 }])).toBe(false)
    expect(touchesPlan([{ op: 'replace', path: ['meta', 'modifiedAt'], value: '' }])).toBe(false)
    expect(touchesPlan([{ op: 'replace', path: ['rooms', 'r1', 'anchor'], value: { x: 0, y: 0 } }])).toBe(true)
    expect(touchesPlan([{ op: 'replace', path: ['rooms', 'r1', 'ceiling', 'height'], value: 2500 }])).toBe(true)
    expect(touchesPlan([{ op: 'remove', path: ['rooms', 'r1'] }])).toBe(true)
    expect(touchesPlan([{ op: 'replace', path: ['nodes', 'n1', 'x'], value: 1 }])).toBe(true)
    expect(touchesPlan([{ op: 'replace', path: ['layers'], value: {} }])).toBe(true)
  })

  it('a room renamed, furniture moved: the document is what the full normalisation gives', () => {
    load()
    expect(roomIds().length).toBe(2)
    const [r1] = roomIds()
    st().transact('rename', (d) => {
      d.rooms[r1].name = 'Кухня'
    })
    st().transact('move', (d) => {
      d.items.i1.x = 1500
    })
    st().transact('drag', (d) => void (d.items.i1.y = 1200), { transient: true })
    st().commitTransient('drag')
    const doc = st().doc
    expect(doc.rooms[r1].name).toBe('Кухня')
    expect(doc.items.i1).toMatchObject({ x: 1500, y: 1200 })
    expect(withoutStamp(normalized(doc))).toEqual(withoutStamp(doc))
    st().undo()
    st().undo()
    st().undo()
    expect(st().doc.rooms[r1].name).not.toBe('Кухня')
  })

  it('a wall added still splits the room, and one undo takes it back', () => {
    load()
    const before = st().doc
    st().transact('wall', (d) => {
      addWall(d, d.levelOrder[0], { x: 0, y: 1500 }, { x: 4000, y: 1500 })
    })
    expect(roomIds().length).toBe(3)
    expect(withoutStamp(normalized(st().doc))).toEqual(withoutStamp(st().doc))
    st().undo()
    expect(withoutStamp(st().doc)).toEqual(withoutStamp(before))
  })

  it('an item renamed raises the file format exactly as before', () => {
    load()
    st().transact('rename item', (d) => {
      d.items.i1.name = 'Мой стул'
    })
    expect(st().doc.version).toBe(normalized(st().doc).version)
  })
})
