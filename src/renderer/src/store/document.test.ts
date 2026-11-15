import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyDoc } from '@core'
import { docStore, HISTORY_LIMIT } from './document'

const st = () => docStore.getState()
const rename = (name: string, merge?: string) =>
  st().transact('rename', (d) => {
    d.meta.name = name
  }, merge ? { merge } : undefined)

describe('docStore dirty flag', () => {
  beforeEach(() => {
    st().load(createEmptyDoc('A'), '/tmp/a.doplan')
  })

  it('is clean after load and dirty after a change', () => {
    expect(st().dirty).toBe(false)
    rename('B')
    expect(st().dirty).toBe(true)
  })

  it('returns to clean when undoing back to the saved state', () => {
    rename('B')
    st().markSaved('/tmp/a.doplan')
    expect(st().dirty).toBe(false)
    rename('C')
    expect(st().dirty).toBe(true)
    st().undo()
    expect(st().dirty).toBe(false)
    st().undo()
    expect(st().dirty).toBe(true)
    st().redo()
    expect(st().dirty).toBe(false)
    st().redo()
    expect(st().dirty).toBe(true)
  })

  it('undo to the freshly loaded state is clean', () => {
    rename('B')
    st().undo()
    expect(st().dirty).toBe(false)
  })

  it('a new change after undoing past the save point stays dirty', () => {
    rename('B')
    st().markSaved('/tmp/a.doplan')
    st().undo()
    rename('X') // drops the redo branch holding the saved state
    expect(st().dirty).toBe(true)
    st().undo()
    expect(st().dirty).toBe(true)
  })

  it('does not merge into the saved history entry', () => {
    rename('B', 'k')
    st().markSaved('/tmp/a.doplan')
    rename('C', 'k')
    expect(st().dirty).toBe(true)
    st().undo()
    expect(st().doc.meta.name).toBe('B')
    expect(st().dirty).toBe(false)
  })

  it('still merges unsaved changes', () => {
    rename('B', 'k')
    rename('C', 'k')
    st().undo()
    expect(st().doc.meta.name).toBe('A')
    expect(st().canUndo).toBe(false)
  })

  it('setDirty(true) stays dirty until saved', () => {
    st().setDirty(true)
    expect(st().dirty).toBe(true)
    rename('B')
    st().undo()
    expect(st().dirty).toBe(true)
    st().markSaved('/tmp/a.doplan')
    expect(st().dirty).toBe(false)
  })

  it('a new id for an opened copy is a change until saved, so it reaches the file', () => {
    st().markSaved('/tmp/copy.doplan')
    st().setDocId('own-copy-id')
    expect(st().doc.meta.id).toBe('own-copy-id')
    expect(st().dirty).toBe(true)
    st().markSaved('/tmp/copy.doplan', 'own-copy-id')
    expect(st().dirty).toBe(false)
    expect(st().doc.meta.id).toBe('own-copy-id')
  })

  it('transient previews are dirty only while pending', () => {
    st().transact('move', (d) => {
      d.meta.name = 'T'
    }, { transient: true })
    expect(st().dirty).toBe(true)
    st().cancelTransient()
    expect(st().dirty).toBe(false)
    st().transact('move', (d) => {
      d.meta.name = 'T'
    }, { transient: true })
    st().commitTransient('move')
    expect(st().dirty).toBe(true)
    st().undo()
    expect(st().dirty).toBe(false)
  })

  it('handles history trimming', () => {
    rename('saved')
    st().markSaved('/tmp/a.doplan')
    for (let i = 0; i < HISTORY_LIMIT; i++) rename(`n${i}`)
    // the saved entry is now the trimmed base: undoing everything returns to it
    while (st().canUndo) st().undo()
    expect(st().doc.meta.name).toBe('saved')
    expect(st().dirty).toBe(false)

    st().load(createEmptyDoc('A'), null)
    for (let i = 0; i < HISTORY_LIMIT + 1; i++) rename(`m${i}`)
    // the loaded state was trimmed away: it can no longer be reached
    while (st().canUndo) st().undo()
    expect(st().dirty).toBe(true)
  })
})
