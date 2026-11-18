import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'

// A save may wait in main (behind a GitHub send). When it finally returns, edits made meanwhile stay
// unsaved, and a project opened meanwhile keeps its own folder.

const fake = vi.hoisted(() => {
  const writes: string[] = []
  const gate: { wait: Promise<void> | null; started: number; recoveryCleared: number } = { wait: null, started: 0, recoveryCleared: 0 }
  const fallback = (o: Record<string, unknown>) => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  const api = {
    platform: 'win32',
    project: fallback({
      save: async (doc: { meta: { name: string } }, path: string) => {
        gate.started++
        if (gate.wait) await gate.wait
        writes.push(`${doc.meta.name} -> ${path}`)
        return { path, commit: 'c0ffee' }
      },
      recent: async () => [],
      clearRecovery: async () => void gate.recoveryCleared++,
    }),
  }
  return { writes, gate, api: new Proxy(api as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : fallback({})) }) }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { docStore } = await import('@/store/document')
const { projectStore } = await import('@/store/project')
const { saveProject } = await import('./project')

function open(path: string, name: string): void {
  docStore.getState().load(createEmptyDoc(name), path)
  projectStore.setState({ root: path, kind: 'folder', git: true, viewing: null })
}

const rename = (name: string, merge?: string) => docStore.getState().transact('edit', (d) => void (d.meta.name = name), merge ? { merge } : undefined)

/** starts a save that waits in main (behind a GitHub send) until `release` */
async function heldSave(): Promise<{ saving: Promise<boolean>; release: () => void }> {
  let release!: () => void
  fake.gate.wait = new Promise((r) => (release = r))
  const saving = saveProject()
  await vi.waitFor(() => expect(fake.gate.started).toBe(1))
  return { saving, release }
}

beforeEach(() => {
  fake.writes.length = 0
  fake.gate.wait = null
  fake.gate.started = 0
  fake.gate.recoveryCleared = 0
})

describe('a save that returns late', () => {
  it('keeps edits made while it waited unsaved', async () => {
    open('C:/p/A', 'A')
    rename('SavedEdit')
    let release!: () => void
    fake.gate.wait = new Promise((r) => (release = r))
    const saving = saveProject()
    await vi.waitFor(() => expect(fake.gate.started).toBe(1))
    rename('EditWhileWaiting')
    release()
    expect(await saving).toBe(true)
    expect(fake.writes).toEqual(['SavedEdit -> C:/p/A'])
    expect(docStore.getState().doc.meta.name).toBe('EditWhileWaiting')
    expect(docStore.getState().dirty).toBe(true)
    // undo back to what was written: that one is saved
    docStore.getState().undo()
    expect(docStore.getState().dirty).toBe(false)
  })

  it('does not point a project opened meanwhile at the old folder', async () => {
    open('C:/p/A', 'A')
    rename('A edited')
    let release!: () => void
    fake.gate.wait = new Promise((r) => (release = r))
    const saving = saveProject()
    await vi.waitFor(() => expect(fake.gate.started).toBe(1))
    open('C:/p/B', 'B')
    release()
    expect(await saving).toBe(false)
    expect(docStore.getState().filePath).toBe('C:/p/B')
    fake.gate.wait = null
    rename('B edited')
    await saveProject()
    expect(fake.writes).toEqual(['A edited -> C:/p/A', 'B edited -> C:/p/B'])
  })

  // REVIEW-NIGHT-3 #3: a nudge (same merge key, within the merge window) used to merge into the entry
  // the save was taken at, which then counted as saved
  it('keeps a merged edit (arrow-key nudge) made while it waited unsaved, with its recovery snapshot', async () => {
    open('C:/p/A', 'A')
    rename('N1', 'editor2d:nudge')
    const { saving, release } = await heldSave()
    rename('N2', 'editor2d:nudge')
    release()
    expect(await saving).toBe(true)
    expect(fake.writes).toEqual(['N1 -> C:/p/A'])
    expect(docStore.getState().doc.meta.name).toBe('N2')
    expect(docStore.getState().dirty).toBe(true)
    expect(fake.gate.recoveryCleared).toBe(0)
    // the written state is still one undo away, and counts as saved
    docStore.getState().undo()
    expect(docStore.getState().doc.meta.name).toBe('N1')
    expect(docStore.getState().dirty).toBe(false)
  })

  it('marks the document saved and clears recovery when nothing changed while it waited', async () => {
    open('C:/p/A', 'A')
    rename('N1', 'editor2d:nudge')
    const { saving, release } = await heldSave()
    release()
    expect(await saving).toBe(true)
    expect(docStore.getState().dirty).toBe(false)
    expect(fake.gate.recoveryCleared).toBe(1)
    // and the next nudge merges as usual again (the pin is gone)
    rename('N2', 'editor2d:nudge')
    rename('N3', 'editor2d:nudge')
    docStore.getState().undo()
    expect(docStore.getState().doc.meta.name).toBe('N1')
  })

  // REVIEW-NIGHT-3 #4: the same folder loaded again while the save waited (an old version viewed, or the
  // project reopened): the answer is about a document no longer on screen
  it('leaves an old version opened meanwhile as it is: still viewed, and its restore still asks', async () => {
    open('C:/p/A', 'A')
    rename('A edited')
    const { saving, release } = await heldSave()
    const viewing = { sha: 'abc', date: '2026-11-17T10:00:00Z', message: 'old' }
    docStore.getState().load(createEmptyDoc('OldVersion'), 'C:/p/A', 'version')
    projectStore.setState({ viewing: viewing as never })
    release()
    expect(await saving).toBe(false)
    expect(projectStore.getState().viewing).toEqual(viewing)
    expect(docStore.getState().doc.meta.name).toBe('OldVersion')
    expect(fake.gate.recoveryCleared).toBe(0)
  })

  it('does not mark a reopened copy of the same project saved', async () => {
    open('C:/p/A', 'A')
    rename('A edited')
    const { saving, release } = await heldSave()
    open('C:/p/B', 'B')
    open('C:/p/A', 'A') // read before the queued write: the screen shows the older file
    rename('A tweak')
    release()
    expect(await saving).toBe(false)
    expect(docStore.getState().doc.meta.name).toBe('A tweak')
    expect(docStore.getState().dirty).toBe(true)
    expect(fake.gate.recoveryCleared).toBe(0)
  })
})
