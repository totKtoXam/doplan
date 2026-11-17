import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'
import type { AiRunRequest } from '@shared/aiChat'

// Editing an earlier message in plan mode: what the dropped turns proposed goes with them, the proposals of
// the turns before the edited message stay in the draft (and on their cards), ready to apply.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const runs: AiRunRequest[] = []
  const cb: { event: ((runId: string, ev: unknown) => void) | null; tool: ((c: unknown) => void) | null } = { event: null, tool: null }
  const fallback = (o: Record<string, unknown>) => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  const api = {
    platform: 'win32',
    aiChat: fallback({
      providers: async () => [],
      listChats: async () => [],
      getSettings: async () => ({}),
      claimDocument: async (ref: string) => ({ ref, sessionsDropped: false }),
      loadChat: async () => null,
      saveChat: async () => {},
      moveChats: async () => ({ sessionsKept: true }),
      stop: async () => {},
      run: async (req: AiRunRequest) => void runs.push(JSON.parse(JSON.stringify(req))),
      toolResult: () => {},
      onEvent: (f: (runId: string, ev: unknown) => void) => {
        cb.event = f
        return () => {}
      },
      onToolCall: (f: (c: unknown) => void) => {
        cb.tool = f
        return () => {}
      },
      onToolCancel: () => () => {},
      onLogin: () => () => {},
    }),
    settings: fallback({ get: async () => ({}) }),
    project: fallback({
      attach: async () => {},
      info: async () => ({ root: null }),
      open: async (path: string) => (files.has(path) ? { path, doc: files.get(path), kind: 'folder', git: true } : null),
    }),
  }
  return { api, files, runs, cb }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { openProject } = await import('@/actions/project')
const { docStore } = await import('@/store/document')
const { aiStore, applyDraft, editAndResend, initAi, newChat, send, updateSettings } = await import('./store')

const settle = () => new Promise((r) => setTimeout(r, 20))
const msgs = () => aiStore.getState().chat.messages
const statuses = (i: number) => msgs()[i].parts.flatMap((p) => (p.type === 'tool' ? [p.status] : []))
const rooms = () => Object.values(docStore.getState().doc.rooms ?? {}).map((r) => (r as { name?: string }).name)

let calls = 0
/** a finished turn; `room` — the agent proposes adding a room of that name */
async function turn(text: string, room?: string): Promise<void> {
  await send(text)
  const req = fake.runs[fake.runs.length - 1]
  if (room) {
    fake.cb.tool?.({ runId: req.runId, callId: `c${++calls}`, tool: 'add_rect_room', args: { x: calls * 4000, y: 0, w: 3000, h: 3000, name: room } })
    await settle()
  }
  fake.cb.event?.(req.runId, { type: 'text', partId: 'p', delta: 'ok' })
  fake.cb.event?.(req.runId, { type: 'done', ok: true })
  await settle()
}

function plan(id: string): unknown {
  const doc: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...doc, meta: { ...doc.meta, id } }))
}

beforeAll(async () => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
  fake.files.set('C:/p/A', plan('aaaaAAAA'))
  await openProject('C:/p/A', { skipConfirm: true })
  await settle()
  aiStore.setState({ providers: [{ id: 'api', label: 'api', available: true, models: [], efforts: [], reportsCost: false, images: true }] })
  updateSettings({ provider: 'api', planMode: true })
})

beforeEach(() => {
  newChat()
})

it('the dropped turns proposed nothing: the proposal of the turn kept stays as it is', async () => {
  await turn('добавь кухню', 'Кухня')
  await turn('что дальше?')
  expect(aiStore.getState().draftCount).toBe(1)
  expect(await editAndResend(msgs()[2].id, 'а теперь спальню')).toBe(true)
  const s = aiStore.getState()
  expect(s.draftCount).toBe(1)
  expect(s.draftChanges).toHaveLength(1)
  expect(statuses(1)).toEqual(['proposed'])
})

it('only what the dropped turns proposed is taken back; the rest applies', async () => {
  await turn('добавь кухню', 'Кухня')
  await turn('и спальню', 'Спальня')
  expect(aiStore.getState().draftCount).toBe(2)
  expect(await editAndResend(msgs()[2].id, 'лучше кабинет')).toBe(true)
  expect(aiStore.getState().draftCount).toBe(1)
  expect(aiStore.getState().draftChanges).toHaveLength(1)
  expect(statuses(1)).toEqual(['proposed'])
  // the new answer proposes its own room on top of what is kept
  const req = fake.runs[fake.runs.length - 1]
  fake.cb.tool?.({ runId: req.runId, callId: `c${++calls}`, tool: 'add_rect_room', args: { x: 20000, y: 0, w: 3000, h: 3000, name: 'Кабинет' } })
  await settle()
  fake.cb.event?.(req.runId, { type: 'done', ok: true })
  await settle()
  expect(aiStore.getState().draftCount).toBe(2)
  const before = rooms()
  expect(applyDraft()?.ok).toBe(true)
  const added = rooms().filter((n) => !before.includes(n))
  expect(added.sort()).toEqual(['Кабинет', 'Кухня'])
})

it('editing the message that started the draft drops all of it', async () => {
  await turn('добавь кухню', 'Кухня')
  await turn('и спальню', 'Спальня')
  expect(await editAndResend(msgs()[0].id, 'ничего не добавляй')).toBe(true)
  const s = aiStore.getState()
  expect(s.draftCount).toBe(0)
  expect(s.draftChanges).toEqual([])
  expect(applyDraft()).toBeNull()
})

it('a draft applied earlier is not touched; only the newer one is cut', async () => {
  await turn('добавь кухню', 'Кухня')
  expect(applyDraft()?.ok).toBe(true)
  await turn('и спальню', 'Спальня')
  await turn('и ванную', 'Ванная')
  expect(statuses(1)).toEqual(['done'])
  expect(await editAndResend(msgs()[4].id, 'без ванной')).toBe(true)
  expect(aiStore.getState().draftCount).toBe(1)
  expect(statuses(1)).toEqual(['done'])
  expect(statuses(3)).toEqual(['proposed'])
})
