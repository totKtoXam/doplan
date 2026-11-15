import { describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { aiStore, initAi } from './store'

const settle = () => new Promise((r) => setTimeout(r, 30))

describe('claiming a copy', () => {
  it('a late answer for a copy never gives its id to the original opened meanwhile', async () => {
    initAi()
    await settle()
    let answer: (v: string) => void = () => {}
    const claim = vi.spyOn(api.aiChat, 'claimDocument').mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const doc = createEmptyDoc('Flat')
    const id = doc.meta.id
    expect(id).toBeTruthy()
    // the copy is opened, then (before its claim is answered) the original with the same id
    docStore.getState().load(structuredClone(doc), '/flats/flat - Copy.doplan')
    docStore.getState().load(structuredClone(doc), '/flats/flat.doplan')
    // the claim of the copy has started (it waits for its answer)
    await settle()
    expect(claim).toHaveBeenCalledWith(`id:${id}`, '/flats/flat - Copy.doplan')
    answer('id:copy-own-id-1')
    await settle()
    expect(docStore.getState().doc.meta.id).toBe(id)
    expect(docStore.getState().dirty).toBe(false)
    expect(aiStore.getState().projectPath).toBe(`id:${id}`)
  })

  it('an opened copy takes its own id, and is changed until the user saves it (nothing is written on open)', async () => {
    const doc = createEmptyDoc('Flat')
    vi.spyOn(api.aiChat, 'claimDocument').mockResolvedValueOnce('id:copy-own-id-2')
    const save = vi.spyOn(api.project, 'save')
    docStore.getState().load(structuredClone(doc), '/flats/flat - Copy 2.doplan')
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copy-own-id-2')
    expect(docStore.getState().dirty).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
})
