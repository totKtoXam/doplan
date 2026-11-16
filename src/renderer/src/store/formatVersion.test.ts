import { describe, expect, it } from 'vitest'
import { DOC_VERSION, DOC_VERSION_VARIANTS, addLayer, createEmptyDoc, setGroupFlag } from '@core'
import { docStore } from './document'

const st = () => docStore.getState()

describe('the document store keeps the file format version', () => {
  it('layers-panel data raises it, undo lowers it again', () => {
    st().load(createEmptyDoc('A'), '/tmp/a.doplan')
    expect(st().doc.version).toBe(DOC_VERSION)
    st().transact('lock group', (d) => {
      setGroupFlag(d, 'wall', 'locked', true)
    })
    // the main process writes the doc object as is, so the field itself must be right
    expect(st().doc.version).toBe(DOC_VERSION_VARIANTS)
    st().undo()
    expect(st().doc.version).toBe(DOC_VERSION)
    st().transact('layer', (d) => {
      addLayer(d, 'Мебель')
    })
    expect(st().doc.version).toBe(DOC_VERSION_VARIANTS)
  })
})
