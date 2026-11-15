import { describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { runProjectHooks } from '@/store/projectHooks'
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

  /** a copy opened with its claim not answered yet; resolves the answer function */
  async function openCopy(path: string) {
    let answer: (v: string) => void = () => {}
    vi.spyOn(api.aiChat, 'claimDocument').mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const doc = createEmptyDoc('Flat')
    docStore.getState().load(structuredClone(doc), path)
    await settle()
    return { id: doc.meta.id, answer: (v: string) => answer(v) }
  }

  it("Ctrl+S before the claim answers: the save waits for it and never points the original's chats at the copy", async () => {
    const path = '/flats/quick - Copy.doplan'
    const { id, answer } = await openCopy(path)
    const move = vi.spyOn(api.aiChat, 'moveChats')
    // the save wrote the file (with the id it had) and runs its hook before the claim is answered
    docStore.getState().markSaved(path, id)
    const hook = runProjectHooks('saved', false)
    await settle()
    expect(move).not.toHaveBeenCalled()
    answer('id:quick-copy-id-1')
    await hook
    await settle()
    expect(move.mock.calls.some((c) => c[1] === `id:${id}`)).toBe(false)
    expect(move).toHaveBeenCalledWith('id:quick-copy-id-1', 'id:quick-copy-id-1', false, path)
    expect(docStore.getState().doc.meta.id).toBe('quick-copy-id-1')
    expect(docStore.getState().dirty).toBe(true)
    expect(aiStore.getState().projectPath).toBe('id:quick-copy-id-1')
    move.mockRestore()
  })

  it("a save that started before the claim answered and ended after it keeps the copy's new id", async () => {
    const path = '/flats/race - Copy.doplan'
    const { id, answer } = await openCopy(path)
    const move = vi.spyOn(api.aiChat, 'moveChats')
    // the claim answers while the save (with the old id) is on its way
    answer('id:race-copy-id-1')
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('race-copy-id-1')
    docStore.getState().markSaved(path, id)
    await runProjectHooks('saved', false)
    await settle()
    expect(move.mock.calls.some((c) => c[0] === `id:${id}` || c[1] === `id:${id}`)).toBe(false)
    expect(move).toHaveBeenCalledWith('id:race-copy-id-1', 'id:race-copy-id-1', false, path)
    expect(docStore.getState().doc.meta.id).toBe('race-copy-id-1')
    expect(docStore.getState().dirty).toBe(true)
    move.mockRestore()
  })

  it('Save As before the claim answers: the new file keeps the id Save As gave it', async () => {
    const path = '/flats/as - Copy.doplan'
    const { id, answer } = await openCopy(path)
    const move = vi.spyOn(api.aiChat, 'moveChats')
    docStore.getState().markSaved('/flats/as-new.doplan', 'save-as-id-1')
    const hook = runProjectHooks('saved', true)
    answer('id:as-copy-id-1')
    await hook
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('save-as-id-1')
    expect(move).toHaveBeenCalledWith(`id:${id}`, 'id:save-as-id-1', true, '/flats/as-new.doplan')
    expect(aiStore.getState().projectPath).toBe('id:save-as-id-1')
    move.mockRestore()
  })
})
