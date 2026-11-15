import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'

// The AI chat follows the open document: another document gets its own chats, the same project loaded
// again (an old version, back to the current one, plan.json reloaded from disk) keeps the open chat.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const claims = new Map<string, string>()
  /** `ref|path` claims that keep the id but drop its agent sessions (moved outside the app) */
  const dropped = new Set<string>()
  /** chat records main holds, and what the app wrote back */
  const records = new Map<string, unknown>()
  const saved: [string | null, { id: string; resume?: unknown }][] = []
  const listener: { cb: ((runId: string, ev: unknown) => void) | null } = { cb: null }
  const calls: { claim: [string, string][]; stop: string[]; move: [string, string, boolean, string | null][]; save: [string, string][] } = {
    claim: [],
    stop: [],
    move: [],
    save: [],
  }
  /** a claim answers only once `gate.wait` resolves; `gate.fail` makes it throw */
  const gate: { wait: Promise<void> | null; fail: boolean; attach: Promise<void> | null; openFor: Map<string, Promise<void>>; attachFor: Map<string, Promise<void>> } = {
    wait: null,
    fail: false,
    attach: null,
    openFor: new Map(),
    attachFor: new Map(),
  }
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
        return { ref: claims.get(`${ref}|${path}`) ?? ref, sessionsDropped: dropped.has(`${ref}|${path}`) }
      },
      loadChat: async (ref: string | null, chatId: string) => structuredClone(records.get(`${ref}|${chatId}`) ?? null),
      saveChat: async (ref: string | null, chat: { id: string; resume?: unknown }) => void saved.push([ref, structuredClone(chat)]),
      moveChats: async (from: string, to: string, copy: boolean, path: string | null) => {
        calls.move.push([from, to, copy, path])
        return { sessionsKept: true }
      },
      stop: async (runId: string) => void calls.stop.push(runId),
      onEvent: (cb: (runId: string, ev: unknown) => void) => {
        listener.cb = cb
        return () => {}
      },
      onToolCall: () => () => {},
      onLogin: () => () => {},
    }),
    settings: fallback({ get: async () => ({}) }),
    project: fallback({
      attach: async (path: string | null) => {
        if (path && gate.attachFor.has(path)) await gate.attachFor.get(path)
        if (gate.attach) await gate.attach
      },
      open: async (path: string) => {
        if (gate.openFor.has(path)) await gate.openFor.get(path)
        return files.has(path) ? { path, doc: files.get(path), kind: /\.json$/.test(path) ? 'json' : 'folder', git: true } : null
      },
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
  return { api, files, claims, dropped, records, saved, listener, calls, gate }
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
  fake.gate.attach = null
  fake.saved.length = 0
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

/** holds main's switch to the next opened project until the returned function is called */
function holdAttach(): () => Promise<void> {
  let release!: () => void
  fake.gate.attach = new Promise<void>((r) => (release = r))
  return async () => {
    release()
    fake.gate.attach = null
    await settle()
  }
}

describe('a reload while the copy is being claimed (the claim answers before main switched the project)', () => {
  for (const how of ['disk', 'version'] as const) {
    it(`reload '${how}': one claim, the copy's id and the open chat stay`, async () => {
      const path = `C:/p/R-${how}`
      fake.files.set(path, planWithId(`orig${how}`))
      fake.files.set('version:abc', planWithId(`orig${how}`))
      fake.claims.set(`id:orig${how}|${path}`, `id:copy${how}`)
      const releaseClaim = holdClaims()
      await openProject(path, { skipConfirm: true })
      await settle()
      if (how === 'version') {
        expect(await viewVersion(version)).toBe(true)
        await settle()
      }
      const chatId = busyChat(`rr-${how}`)
      aiStore.setState({ running: null })
      const releaseAttach = holdAttach()
      const reloading = how === 'disk' ? openProject(path, { skipConfirm: true, reload: 'disk' }) : leaveVersion()
      await settle()
      // the claim answers while main is still switching to the project read again
      await releaseClaim()
      expect(docStore.getState().doc.meta.id).toBe(`copy${how}`)
      await releaseAttach()
      await reloading
      await settle()
      expect(fake.calls.claim).toEqual([[`id:orig${how}`, path]])
      expect(docStore.getState().doc.meta.id).toBe(`copy${how}`)
      expect(aiStore.getState().projectPath).toBe(`id:copy${how}`)
      expect(aiStore.getState().chat.id).toBe(chatId)
      expect(docStore.getState().dirty).toBe(true)
    })
  }
})

describe('the original moved outside the app loses its agent sessions, also those a stopped turn reports late', () => {
  const session = (id: string) => ({ type: 'session', id })

  it('a turn stopped by opening the moved original does not write its session into the saved chat', async () => {
    fake.files.set('C:/p/S', planWithId('origSSSS'))
    await openProject('C:/p/S', { skipConfirm: true })
    await settle()
    const chatId = busyChat('rs1')
    fake.records.set(`id:origSSSS|${chatId}`, { ...aiStore.getState().chat })
    // the project was moved in Explorer: the same id at a new path, its sessions are dropped there
    fake.files.set('C:/p/S-moved', planWithId('origSSSS'))
    fake.dropped.add('id:origSSSS|C:/p/S-moved')
    const release = holdClaims()
    await openProject('C:/p/S-moved', { skipConfirm: true })
    await settle()
    expect(fake.calls.stop).toEqual(['rs1'])
    // the stopped turn reports its session while the claim is still on its way
    fake.listener.cb?.('rs1', session('LATE-1'))
    await release()
    await settle()
    expect(aiStore.getState().projectPath).toBe('id:origSSSS')
    expect(fake.saved.filter(([, c]) => c.id === chatId && c.resume)).toEqual([])
    // and later, with that chat open again
    aiStore.setState({ chat: { ...aiStore.getState().chat, id: chatId } })
    fake.listener.cb?.('rs1', session('LATE-2'))
    await settle()
    expect(aiStore.getState().chat.resume).toBeUndefined()
  })

  it("a turn whose session and 'done' both come before the claim answers does not write the session", async () => {
    fake.files.set('C:/p/PA', planWithId('origPAPA'))
    await openProject('C:/p/PA', { skipConfirm: true })
    await settle()
    const chatId = busyChat('pa1')
    fake.records.set(`id:origPAPA|${chatId}`, { ...aiStore.getState().chat })
    fake.files.set('C:/p/PA-moved', planWithId('origPAPA'))
    fake.dropped.add('id:origPAPA|C:/p/PA-moved')
    const release = holdClaims()
    await openProject('C:/p/PA-moved', { skipConfirm: true })
    await settle()
    // main always ends the killed agent with 'done', right after what it still flushed
    fake.listener.cb?.('pa1', session('LATE-A'))
    fake.listener.cb?.('pa1', { type: 'done', ok: false, stopped: true })
    await release()
    await settle()
    expect(fake.saved.filter(([, c]) => c.id === chatId && c.resume)).toEqual([])
  })

  it('a turn started before the claim answers does not keep its session', async () => {
    fake.files.set('C:/p/T', planWithId('origTTTT'))
    await openProject('C:/p/T', { skipConfirm: true })
    await settle()
    fake.files.set('C:/p/T-moved', planWithId('origTTTT'))
    fake.dropped.add('id:origTTTT|C:/p/T-moved')
    const release = holdClaims()
    await openProject('C:/p/T-moved', { skipConfirm: true })
    await settle()
    busyChat('rt1')
    await release()
    fake.listener.cb?.('rt1', session('RUN-1'))
    await settle()
    expect(aiStore.getState().chat.resume).toBeUndefined()
  })

  it('a claim that keeps the sessions leaves a stopped turn its session', async () => {
    fake.files.set('C:/p/U', planWithId('origUUUU'))
    await openProject('C:/p/U', { skipConfirm: true })
    await settle()
    const chatId = busyChat('ru1')
    fake.records.set(`id:origUUUU|${chatId}`, { ...aiStore.getState().chat })
    fake.files.set('C:/p/U-same', planWithId('origUUUU'))
    const release = holdClaims()
    await openProject('C:/p/U-same', { skipConfirm: true })
    await settle()
    fake.listener.cb?.('ru1', session('KEEP-1'))
    await release()
    await settle()
    expect(fake.saved.some(([ref, c]) => ref === 'id:origUUUU' && c.id === chatId && JSON.stringify(c.resume ?? {}).includes('KEEP-1'))).toBe(true)
  })
})

/** holds main's open or attach of one path until the returned function is called */
function holdFor(map: Map<string, Promise<void>>, path: string): () => Promise<void> {
  let release!: () => void
  map.set(path, new Promise<void>((r) => (release = r)))
  return async () => {
    release()
    map.delete(path)
    await settle()
  }
}

describe('a reload that finishes after another project was opened', () => {
  for (const how of ['disk', 'version'] as const) {
    for (const step of ['openFor', 'attachFor'] as const) {
      it(`reload '${how}' held in ${step === 'openFor' ? 'open' : 'attach'}: the project read again never takes the other project's id or chat`, async () => {
        const A = `C:/p/XA-${how}-${step}`
        const B = `C:/p/XB-${how}-${step}.json`
        fake.files.set(A, planWithId(`aaaa${how}${step}`))
        fake.files.set(B, planWithId(`bbbb${how}${step}`))
        fake.files.set('version:abc', planWithId(`aaaa${how}${step}`))
        await openProject(A, { skipConfirm: true })
        await settle()
        if (how === 'version') {
          expect(await viewVersion(version)).toBe(true)
          await settle()
        }
        const release = holdFor(fake.gate[step], A)
        const reloading = how === 'disk' ? openProject(A, { skipConfirm: true, reload: 'disk' }) : leaveVersion()
        await settle()
        await openProject(B, { skipConfirm: true })
        await settle()
        expect(aiStore.getState().projectPath).toBe(`id:bbbb${how}${step}`)
        const chatB = busyChat(`xb-${how}-${step}`)
        aiStore.setState({ running: null })
        await release()
        await reloading
        await settle()
        // main attached A last: A is open, as a project of its own
        const s = docStore.getState()
        expect(s.filePath).toBe(A)
        expect(s.doc.meta.id).toBe(`aaaa${how}${step}`)
        expect(aiStore.getState().projectPath).toBe(`id:aaaa${how}${step}`)
        expect(aiStore.getState().chat.id).not.toBe(chatB)
      })
    }
  }

  it('a version read while another project opened is not shown over it', async () => {
    fake.files.set('C:/p/VA', planWithId('vvvvAAAA'))
    fake.files.set('C:/p/VB.json', planWithId('vvvvBBBB'))
    fake.files.set('version:slow', planWithId('vvvvAAAA'))
    await openProject('C:/p/VA', { skipConfirm: true })
    await settle()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const versionDoc = fake.api.project.versionDoc
    ;(fake.api.project as Record<string, unknown>).versionDoc = async (sha: string) => {
      await held
      return fake.files.get(`version:${sha}`)
    }
    try {
      const viewing = viewVersion({ ...version, sha: 'slow' })
      await settle()
      await openProject('C:/p/VB.json', { skipConfirm: true })
      await settle()
      release()
      expect(await viewing).toBe(false)
      await settle()
      expect(docStore.getState().filePath).toBe('C:/p/VB.json')
      expect(docStore.getState().doc.meta.id).toBe('vvvvBBBB')
      expect(projectStore.getState().viewing).toBeNull()
    } finally {
      ;(fake.api.project as Record<string, unknown>).versionDoc = versionDoc
    }
  })
})

describe('reloads of the same project that overlap', () => {
  const openChatWith = (id: string) => {
    const chat = { ...aiStore.getState().chat, id, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'привет' }], at: 0 }] }
    aiStore.setState({ chat: chat as never })
  }

  it('"back to current" clicked twice: the second is a reload too (the chat stays, no new claim)', async () => {
    fake.files.set('C:/p/DV', planWithId('dvdvdvdv'))
    fake.files.set('version:abc', planWithId('dvdvdvdv'))
    await openProject('C:/p/DV', { skipConfirm: true })
    await settle()
    expect(await viewVersion(version)).toBe(true)
    await settle()
    openChatWith('chat-dv')
    fake.calls.claim.length = 0
    const release = holdFor(fake.gate.attachFor, 'C:/p/DV')
    const a = leaveVersion()
    const b = leaveVersion()
    await settle()
    await release()
    await Promise.all([a, b])
    await settle()
    expect(aiStore.getState().chat.id).toBe('chat-dv')
    expect(fake.calls.claim).toEqual([])
    expect(projectStore.getState().viewing).toBeNull()
  })

  it("two disk reloads of a copy that overlap keep the copy's id and the open chat", async () => {
    fake.files.set('C:/p/DC', planWithId('origDCDC'))
    fake.claims.set('id:origDCDC|C:/p/DC', 'id:copyDCDC')
    await openProject('C:/p/DC', { skipConfirm: true })
    await settle()
    expect(aiStore.getState().projectPath).toBe('id:copyDCDC')
    openChatWith('chat-dc')
    // a second claim of the file would give yet another id
    fake.claims.set('id:origDCDC|C:/p/DC', 'id:copy2DC2')
    const release = holdFor(fake.gate.openFor, 'C:/p/DC')
    const a = openProject('C:/p/DC', { skipConfirm: true, reload: 'disk' })
    const b = openProject('C:/p/DC', { skipConfirm: true, reload: 'disk' })
    await settle()
    await release()
    await Promise.all([a, b])
    await settle()
    expect(docStore.getState().doc.meta.id).toBe('copyDCDC')
    expect(aiStore.getState().projectPath).toBe('id:copyDCDC')
    expect(aiStore.getState().chat.id).toBe('chat-dc')
  })

  it('a version view that lands while the project is reloaded leaves the reload a reload', async () => {
    fake.files.set('C:/p/DW', planWithId('dwdwdwdw'))
    fake.files.set('version:abc', planWithId('dwdwdwdw'))
    await openProject('C:/p/DW', { skipConfirm: true })
    await settle()
    openChatWith('chat-dw')
    fake.calls.claim.length = 0
    const release = holdFor(fake.gate.attachFor, 'C:/p/DW')
    const reloading = openProject('C:/p/DW', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(await viewVersion(version)).toBe(true)
    await settle()
    await release()
    await reloading
    await settle()
    expect(aiStore.getState().chat.id).toBe('chat-dw')
    expect(fake.calls.claim).toEqual([])
    expect(docStore.getState().doc.meta.id).toBe('dwdwdwdw')
  })
})
