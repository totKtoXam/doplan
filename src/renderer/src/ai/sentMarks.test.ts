import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc, Id } from '@core/types'
import type { AiRunRequest } from '@shared/aiChat'

// Plan marks that went to the agent stay on the plan while it works (it marks them «внесено» and asks
// about them), and leave it when the turn ends well: one undoable step, «внесено» ones too. A stopped or
// failed turn keeps them, to send again. In plan mode the «внесено» of a mark let go is skipped on apply.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const runs: AiRunRequest[] = []
  const results: Record<string, { ok: boolean; text: string }> = {}
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
      toolResult: (callId: string, r: { ok: boolean; text: string }) => void (results[callId] = r),
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
  return { api, files, runs, results, cb }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { openProject } = await import('@/actions/project')
const { docStore } = await import('@/store/document')
const { uiStore } = await import('@/store/ui')
const { addMark } = await import('@/store/marks')
const { addMarkToChat, aiStore, applyDraft, initAi, newChat, send, stop, updateSettings } = await import('./store')

const settle = () => new Promise((r) => setTimeout(r, 20))
const doc = () => docStore.getState().doc
const lv = () => uiStore.getState().activeLevelId
const marks = () => Object.keys(doc().annotations ?? {}).sort()
let calls = 0

function plan(id: string): unknown {
  const d: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...d, meta: { ...d.meta, id } }))
}

const lastRun = () => fake.runs[fake.runs.length - 1].runId

async function tool(name: string, args: unknown): Promise<{ ok: boolean; text: string }> {
  const callId = `c${++calls}`
  fake.cb.tool?.({ runId: lastRun(), callId, tool: name, args })
  await settle()
  return fake.results[callId]
}

async function end(ok = true): Promise<void> {
  fake.cb.event?.(lastRun(), { type: 'text', partId: 'p', delta: 'ok' })
  fake.cb.event?.(lastRun(), ok ? { type: 'done', ok: true } : { type: 'done', ok: false, error: 'сбой' })
  await settle()
}

/** a mark on the plan, put into the message as the pencil tool does */
async function sentMark(x = 0): Promise<Id> {
  const id = addMark(lv(), 'zone', [
    { x, y: 0 },
    { x: x + 1000, y: 0 },
    { x: x + 1000, y: 1000 },
  ])
  await addMarkToChat(id)
  return id
}

/** a wall of the room the first turn drew: its two nodes */
function wallNodes(): { a: Id; b: Id } {
  const w = Object.values(doc().walls).find((x) => x.levelId === lv())!
  return { a: w.a, b: w.b }
}

beforeAll(async () => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
  fake.files.set('C:/p/M', plan('mmmmMMMM'))
  await openProject('C:/p/M', { skipConfirm: true })
  await settle()
  aiStore.setState({ providers: [{ id: 'api', label: 'api', available: true, models: [], efforts: [], reportsCost: false, images: false }] })
  updateSettings({ provider: 'api', planMode: false })
  // a room to measure
  await send('нарисуй комнату')
  expect((await tool('add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, name: 'Кухня' })).ok).toBe(true)
  await end()
})

beforeEach(() => {
  newChat()
  updateSettings({ planMode: false })
})

it('sent marks stay while the agent works and leave the plan when its turn ends, in one undo step («внесено» too)', async () => {
  const m1 = await sentMark(0)
  const m2 = await sentMark(2000)
  // drawn, but taken out of the message: not sent, stays
  const m3 = addMark(lv(), 'stroke', [
    { x: 0, y: 5000 },
    { x: 900, y: 5000 },
  ])
  expect(aiStore.getState().chips.map((c) => c.id)).toEqual([m1, m2])

  await send('в ① длина 4200')
  expect(aiStore.getState().running?.marks).toEqual([m1, m2])
  expect(aiStore.getState().chips).toEqual([])
  // the agent still sees the mark: it measures by it and marks it applied
  const { a, b } = wallNodes()
  const r = await tool('apply_measurement', { measurements: [{ nodes: { fixed: a, move: b }, length: 4200 }], annotationId: m1 })
  expect(r.ok).toBe(true)
  expect(doc().annotations?.[m1]?.done).toBe(true)
  expect(marks()).toEqual([m1, m2, m3].sort())

  await end()
  expect(marks()).toEqual([m3])
  expect(docStore.getState().undoLabel).toBe('Убрать отправленные пометки')
  // one step brings both back, the «внесено» one as it was
  docStore.getState().undo()
  expect(marks()).toEqual([m1, m2, m3].sort())
  expect(doc().annotations?.[m1]?.done).toBe(true)
  docStore.getState().redo()
  expect(marks()).toEqual([m3])
  docStore.getState().transact('clean', (d) => void delete d.annotations)
})

it('a stopped or failed turn keeps its marks, to send again', async () => {
  const m = await sentMark()
  await send('что тут?')
  stop()
  await settle()
  expect(marks()).toEqual([m])

  await addMarkToChat(m)
  await send('ещё раз')
  expect(aiStore.getState().running?.marks).toEqual([m])
  await end(false)
  expect(marks()).toEqual([m])

  // a mark deleted from the plan leaves the message too
  await addMarkToChat(m)
  expect(aiStore.getState().chips.map((c) => c.id)).toEqual([m])
  docStore.getState().transact('clean', (d) => void delete d.annotations)
  expect(aiStore.getState().chips).toEqual([])
})

it('a mark sent with an answer to the agent’s question goes too', async () => {
  await send('поставь розетку')
  fake.cb.tool?.({ runId: lastRun(), callId: 'q1', tool: 'ask_user', args: { questions: [{ question: 'Где?', options: [{ label: 'Здесь' }, { label: 'Там' }] }] } })
  await settle()
  const m = await sentMark()
  await send('вот тут')
  await settle()
  expect(fake.results.q1?.text).toContain(`annotation ${m}`)
  expect(aiStore.getState().running?.marks).toEqual([m])
  await end()
  expect(marks()).toEqual([])
})

it('a mark anchoring an estimate defect stays on the plan when its turn ends', async () => {
  const anchor = await sentMark(0)
  const plain = await sentMark(2000)
  docStore.getState().transact('defect', (d) => void ((d.annotations![anchor] as { defectId?: string }).defectId = 'df_1'))
  await send('что здесь не так?')
  expect(aiStore.getState().running?.marks).toEqual([anchor, plain])
  await end()
  expect(marks()).toEqual([anchor])
  docStore.getState().transact('clean', (d) => void delete d.annotations)
})

it('plan mode: the «внесено» of a mark let go is skipped on «Применить», and the draft is not taken for stale', async () => {
  updateSettings({ planMode: true })
  const m = await sentMark()
  const { a, b } = wallNodes()
  await send('в ① длина 4500')
  expect((await tool('apply_measurement', { measurements: [{ nodes: { fixed: a, move: b }, length: 4500 }], annotationId: m })).ok).toBe(true)
  // a proposal: the live plan is untouched
  expect(doc().annotations?.[m]?.done).toBeUndefined()
  await end()
  expect(marks()).toEqual([])
  expect(aiStore.getState().draftCount).toBe(1)

  const res = applyDraft()
  expect(res).toEqual({ ok: true, stale: false })
  const na = doc().nodes[a]
  const nb = doc().nodes[b]
  expect(Math.round(Math.hypot(nb.x - na.x, nb.y - na.y))).toBe(4500)
  expect(doc().annotations).toBeUndefined()
})
