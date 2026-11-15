import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'

// The AI chat follows the open document: another document gets its own chats, the same project loaded
// again (an old version, back to the current one, plan.json reloaded from disk) keeps the open chat.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const claims = new Map<string, string>()
  const calls: { claim: [string, string][]; stop: string[]; move: [string, string, boolean, string | null][]; save: [string, string][] } = {
    claim: [],
    stop: [],
    move: [],
    save: [],
  }
  /** a claim answers only once `gate.wait` resolves; `gate.fail` makes it throw */
  const gate: { wait: Promise<void> | null; fail: boolean } = { wait: null, fail: false }
  const fallback = (o: Record<string, unknown>) =>
    new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  const api = {
    platform: 'win32',
    aiChat: fallback({
      providers: async () => [],
      listChats: async () => [],
      getSettings: async () => ({}),
      claimDocument: async (ref: string, path: string) => {
        calls.claim.push([ref, path])
        if (gate.wait) await gate.wait
        if (gate.fail) throw new Error('EPERM')
        return claims.get(`${ref}|${path}`) ?? ref
      },
      moveChats: async (from: string, to: string, copy: boolean, path: string | null) => {
        calls.move.push([from, to, copy, path])
        return { sessionsKept: true }
      },
      stop: async (runId: string) => void calls.stop.push(runId),
      onEvent: () => () => {},
      onToolCall: () => () => {},
      onLogin: () => () => {},
    }),
    settings: fallback({ get: async () => ({}) }),
    project: fallback({
      open: async (path: string) => (files.has(path) ? { path, doc: files.get(path), kind: /\.json$/.test(path) ? 'json' : 'folder', git: true } : null),
      versionDoc: async (sha: string) => files.get(`version:${sha}`),
      save: async (doc: { meta: { id: string } }, path: string) => {
        calls.save.push([doc.meta.id, path])
        return { path }
      },
      create: async (doc: { meta: { id: string } }, name: string, parent: string) => {
        calls.save.push([doc.meta.id, `${parent}/${name}`])
        return { path: `${parent}/${name}`, git: true }
      },
    }),
  }
  return { api, files, claims, calls, gate }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { docStore } = await import('@/store/document')
const { projectStore } = await import('@/store/project')
const { createProjectFolder, leaveVersion, openProject, saveProject, viewVersion } = await import('@/actions/project')
const { aiStore, initAi } = await import('./store')

function planWithId(id: string): unknown {
  const doc: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...doc, meta: { ...doc.meta, id } }))
}

const settle = () => new Promise((r) => setTimeout(r, 10))

/** a chat with one message and a turn running in it, plus a plan-mode draft */
function busyChat(runId: string): string {
  const chat = { ...aiStore.getState().chat, id: `chat-${runId}`, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'привет' }], at: 0 }] }
  aiStore.setState({ chat: chat as never, running: { runId, msgId: 'm1' }, draftCount: 1 })
  return chat.id
}

const version = { sha: 'abc', short: 'abc', date: new Date(0).toISOString(), author: 'a', message: 'старая', tags: [] }

beforeAll(() => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
})

beforeEach(async () => {
  fake.calls.claim.length = 0
  fake.calls.stop.length = 0
  fake.calls.move.length = 0
  fake.calls.save.length = 0
  fake.gate.wait = null
  fake.gate.fail = false
  aiStore.setState({ running: null, draftCount: 0 })
  await settle()
})

describe('AI chat across reloads of the same project', () => {
  it('an opened copy keeps its own id when its folder is read again; the turn goes on after a disk reload', async () => {
    // F is a copy: plan.json still holds the original's id, the claim gives it its own (in memory only)
    fake.files.set('C:/p/F', planWithId('origXXXX'))
    fake.claims.set('id:origXXXX|C:/p/F', 'id:copyYYYY')
    await openProject('C:/p/F', { skipConfirm: true })
    await settle()
    expect(aiStore.getState().projectPath).toBe('id:copyYYYY')
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')

    const chatId = busyChat('r1')
    await openProject('C:/p/F', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')
    expect(aiStore.getState().projectPath).toBe('id:copyYYYY')
    expect(aiStore.getState().chat.id).toBe(chatId)
    expect(aiStore.getState().running?.runId).toBe('r1')
    // the plan-mode draft was made against the plan that is gone
    expect(aiStore.getState().draftCount).toBe(0)
    expect(fake.calls.stop).toEqual([])
  })

  it('viewing a version and going back keep the chat open but stop the turn and drop the draft', async () => {
    fake.files.set('C:/p/F', planWithId('origXXXX'))
    fake.files.set('version:abc', planWithId('origXXXX'))
    fake.claims.set('id:origXXXX|C:/p/F', 'id:copyYYYY')
    await openProject('C:/p/F', { skipConfirm: true })
    await settle()
    // the copy's own id is a change until saved (viewing a version would ask about it first): saved
    expect(docStore.getState().dirty).toBe(true)
    expect(await saveProject(false)).toBe(true)
    expect(docStore.getState().dirty).toBe(false)

    const chatId = busyChat('r2')
    expect(await viewVersion(version)).toBe(true)
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')
    expect(aiStore.getState().chat.id).toBe(chatId)
    expect(aiStore.getState().chat.messages.length).toBeGreaterThan(0)
    expect(aiStore.getState().running).toBeNull()
    expect(aiStore.getState().draftCount).toBe(0)
    expect(fake.calls.stop).toEqual(['r2'])

    busyChat('r3')
    await leaveVersion()
    await settle()
    expect(projectStore.getState().viewing).toBeNull()
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')
    expect(aiStore.getState().projectPath).toBe('id:copyYYYY')
    expect(aiStore.getState().chat.id).toBe('chat-r3')
    expect(fake.calls.stop).toEqual(['r2', 'r3'])
  })

  it('a version viewed right after a save that changed the path still keeps the chat', async () => {
    // a .json turned into a folder by Ctrl+S: same id, new path
    fake.files.set('C:/p/old.json', planWithId('jsonJJJJ'))
    await openProject('C:/p/old.json', { skipConfirm: true })
    await settle()
    docStore.getState().markSaved('C:/p/G', 'jsonJJJJ')
    projectStore.setState({ root: 'C:/p/G', kind: 'folder', git: true })
    fake.files.set('version:abc', planWithId('jsonJJJJ'))

    const chatId = busyChat('r4')
    expect(await viewVersion(version)).toBe(true)
    await settle()
    expect(aiStore.getState().projectPath).toBe('id:jsonJJJJ')
    expect(aiStore.getState().chat.id).toBe(chatId)
  })

  it('reopening the original file after it was saved as a folder is another document', async () => {
    fake.files.set('C:/p/orig.json', planWithId('origKKKK'))
    await openProject('C:/p/orig.json', { skipConfirm: true })
    await settle()
    docStore.getState().markSaved('C:/p/H', 'origKKKK')
    busyChat('r5')

    fake.calls.claim.length = 0
    await openProject('C:/p/orig.json', { skipConfirm: true })
    await settle()
    // the turn of the folder does not go on in the file, and the file is checked for being a copy
    expect(fake.calls.stop).toEqual(['r5'])
    expect(fake.calls.claim).toEqual([['id:origKKKK', 'C:/p/orig.json']])
    expect(aiStore.getState().chat.messages).toEqual([])
  })
})

/** holds the next claims until the returned function is called */
function holdClaims(): () => Promise<void> {
  let release!: () => void
  fake.gate.wait = new Promise<void>((r) => (release = r))
  return async () => {
    release()
    fake.gate.wait = null
    await settle()
  }
}

describe('saves and reloads while a copy is being claimed', () => {
  it("Ctrl+S right after opening a copy waits for the claim and writes the copy's own id", async () => {
    fake.files.set('C:/p/K', planWithId('origAAAA'))
    fake.claims.set('id:origAAAA|C:/p/K', 'id:copyAAAA')
    const release = holdClaims()
    await openProject('C:/p/K', { skipConfirm: true })
    await settle()
    const saving = saveProject(false)
    await settle()
    expect(fake.calls.save).toEqual([])
    await release()
    expect(await saving).toBe(true)
    expect(fake.calls.save).toEqual([['copyAAAA', 'C:/p/K']])
    expect(fake.calls.move.some((m) => m[1] === 'id:origAAAA')).toBe(false)
    expect(fake.calls.move).toEqual([['id:copyAAAA', 'id:copyAAAA', false, 'C:/p/K']])
    expect(docStore.getState().doc.meta.id).toBe('copyAAAA')
    expect(docStore.getState().dirty).toBe(false)
  })

  it("a .json copy turned into a project folder before the claim answers takes the copy's id there", async () => {
    fake.files.set('C:/p/copy.json', planWithId('origBBBB'))
    fake.claims.set('id:origBBBB|C:/p/copy.json', 'id:copyBBBB')
    const release = holdClaims()
    await openProject('C:/p/copy.json', { skipConfirm: true })
    await settle()
    const creating = createProjectFolder('saveAs', 'Copy', 'C:/p')
    await settle()
    expect(fake.calls.save).toEqual([])
    await release()
    expect(await creating).toBeNull()
    await settle()
    expect(fake.calls.save).toEqual([['copyBBBB', 'C:/p/Copy']])
    expect(fake.calls.move.some((m) => m[0] === 'id:origBBBB' || m[1] === 'id:origBBBB')).toBe(false)
    expect(aiStore.getState().projectPath).toBe('id:copyBBBB')
  })

  it('a failed claim shows no chats of the id and leaves them alone on save; the next open tries again', async () => {
    fake.files.set('C:/p/L', planWithId('origCCCC'))
    fake.gate.fail = true
    await openProject('C:/p/L', { skipConfirm: true })
    await settle()
    expect(aiStore.getState().projectPath).toMatch(/^unsaved:/)
    expect(aiStore.getState().status).not.toBe('')
    expect(docStore.getState().doc.meta.id).toBe('origCCCC')
    expect(await saveProject(false)).toBe(true)
    await settle()
    expect(fake.calls.save).toEqual([['origCCCC', 'C:/p/L']])
    expect(fake.calls.move).toEqual([])
    fake.gate.fail = false
    fake.calls.claim.length = 0
    await openProject('C:/p/L', { skipConfirm: true })
    await settle()
    expect(fake.calls.claim).toEqual([['id:origCCCC', 'C:/p/L']])
    expect(aiStore.getState().projectPath).toBe('id:origCCCC')
  })

  it('a reload of the copy while it is being claimed keeps the answer, and the copy stays changed after reloads', async () => {
    fake.files.set('C:/p/M', planWithId('origDDDD'))
    fake.claims.set('id:origDDDD|C:/p/M', 'id:copyDDDD')
    const release = holdClaims()
    await openProject('C:/p/M', { skipConfirm: true })
    await settle()
    await openProject('C:/p/M', { skipConfirm: true, reload: 'disk' })
    await settle()
    await release()
    expect(docStore.getState().doc.meta.id).toBe('copyDDDD')
    expect(aiStore.getState().projectPath).toBe('id:copyDDDD')
    expect(docStore.getState().dirty).toBe(true)
    // plan.json still holds the original's id: read again, the copy is still a change until saved
    await openProject('C:/p/M', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copyDDDD')
    expect(docStore.getState().dirty).toBe(true)
  })
})
