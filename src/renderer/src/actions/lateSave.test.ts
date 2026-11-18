import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'

// A save may wait in main (behind a GitHub send). When it finally returns, edits made meanwhile stay
// unsaved, and a project opened meanwhile keeps its own folder.

const fake = vi.hoisted(() => {
  const writes: string[] = []
  const gate: { wait: Promise<void> | null; started: number } = { wait: null, started: 0 }
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

const rename = (name: string) => docStore.getState().transact('edit', (d) => void (d.meta.name = name))

beforeEach(() => {
  fake.writes.length = 0
  fake.gate.wait = null
  fake.gate.started = 0
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
})
