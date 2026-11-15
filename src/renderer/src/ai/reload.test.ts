import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'

// The AI chat follows the open document: another document gets its own chats, the same project loaded
// again (an old version, back to the current one, plan.json reloaded from disk) keeps the open chat.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const claims = new Map<string, string>()
  const calls: { claim: [string, string][]; stop: string[] } = { claim: [], stop: [] }
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
        return claims.get(`${ref}|${path}`) ?? ref
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
    }),
  }
  return { api, files, claims, calls }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { docStore } = await import('@/store/document')
const { projectStore } = await import('@/store/project')
const { leaveVersion, openProject, viewVersion } = await import('@/actions/project')
const { aiStore, initAi } = await import('./store')

function planWithId(id: string): unknown {
  const doc: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...doc, meta: { ...doc.meta, id } }))
}

const settle = () => new Promise((r) => setTimeout(r, 10))

/** a chat with one message and a turn running in it, plus (unless `draft` is false) a plan-mode draft */
function busyChat(runId: string, draft = true): string {
  const chat = { ...aiStore.getState().chat, id: `chat-${runId}`, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'привет' }], at: 0 }] }
  aiStore.setState({ chat: chat as never, running: { runId, msgId: 'm1' }, draftCount: draft ? 1 : 0 })
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
  aiStore.setState({ running: null, draftCount: 0 })
  await settle()
})

describe('AI chat across reloads of the same project', () => {
  it('an opened copy keeps its own id when its folder is read again; a live turn goes on after a disk reload', async () => {
    // F is a copy: plan.json still holds the original's id, the claim gives it its own (in memory only)
    fake.files.set('C:/p/F', planWithId('origXXXX'))
    fake.claims.set('id:origXXXX|C:/p/F', 'id:copyYYYY')
    await openProject('C:/p/F', { skipConfirm: true })
    await settle()
    expect(aiStore.getState().projectPath).toBe('id:copyYYYY')
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')

    const chatId = busyChat('r1', false)
    await openProject('C:/p/F', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copyYYYY')
    expect(aiStore.getState().projectPath).toBe('id:copyYYYY')
    expect(aiStore.getState().chat.id).toBe(chatId)
    expect(aiStore.getState().running?.runId).toBe('r1')
    expect(fake.calls.stop).toEqual([])
  })

  it('a disk reload drops a plan-mode draft and stops the turn that was making it; the chat stays', async () => {
    fake.files.set('C:/p/F', planWithId('origXXXX'))
    fake.claims.set('id:origXXXX|C:/p/F', 'id:copyYYYY')
    await openProject('C:/p/F', { skipConfirm: true })
    await settle()

    const chatId = busyChat('r6')
    await openProject('C:/p/F', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(aiStore.getState().chat.id).toBe(chatId)
    expect(aiStore.getState().chat.messages.length).toBeGreaterThan(0)
    expect(aiStore.getState().draftCount).toBe(0)
    expect(aiStore.getState().running).toBeNull()
    expect(fake.calls.stop).toEqual(['r6'])
  })

  it('viewing a version and going back keep the chat open but stop the turn and drop the draft', async () => {
    fake.files.set('C:/p/F', planWithId('origXXXX'))
    fake.files.set('version:abc', planWithId('origXXXX'))
    fake.claims.set('id:origXXXX|C:/p/F', 'id:copyYYYY')
    await openProject('C:/p/F', { skipConfirm: true })
    await settle()

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
