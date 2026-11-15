import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'

// ask_user: the agent's questions wait on a card above the input box; the answer (picked options, the
// «Другое» text, or text typed in the chat box) goes back as the tool result of that call only.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const results: [string, { ok: boolean; text: string }][] = []
  const calls: { stop: string[]; run: string[] } = { stop: [], run: [] }
  const cb: { call: ((c: unknown) => void) | null; cancel: ((c: { callId: string; runId: string }) => void) | null } = { call: null, cancel: null }
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
      stop: async (runId: string) => void calls.stop.push(runId),
      run: async (req: { runId: string }) => void calls.run.push(req.runId),
      onEvent: () => () => {},
      onToolCall: (f: (c: unknown) => void) => {
        cb.call = f
        return () => {}
      },
      onToolCancel: (f: (c: { callId: string; runId: string }) => void) => {
        cb.cancel = f
        return () => {}
      },
      toolResult: (callId: string, r: { ok: boolean; text: string }) => void results.push([callId, r]),
      onLogin: () => () => {},
    }),
    settings: fallback({ get: async () => ({}) }),
    project: fallback({
      attach: async () => {},
      open: async (path: string) => (files.has(path) ? { path, doc: files.get(path), kind: 'folder', git: true } : null),
    }),
  }
  return { api, files, results, calls, cb }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { openProject } = await import('@/actions/project')
const { aiStore, answerQuestion, hasAnswer, initAi, pickAnswer, send, setAnswerOther, stop } = await import('./store')

const settle = () => new Promise((r) => setTimeout(r, 10))

function plan(id: string): unknown {
  const doc: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...doc, meta: { ...doc.meta, id } }))
}

const QUESTIONS = [
  {
    header: 'Комната 1',
    question: 'Как назвать комнату 1?',
    options: [{ label: 'Кухня' }, { label: 'Гостиная', description: 'с выходом на балкон' }],
  },
  { question: 'Где нужны розетки?', options: [{ label: 'Кухня' }, { label: 'Спальня' }, { label: 'Коридор' }], multiSelect: true },
]

/** a turn running in the open chat */
function busy(runId: string): void {
  const chat = { ...aiStore.getState().chat, id: `chat-${runId}`, messages: [{ id: 'm1', role: 'assistant', parts: [], createdAt: '' }] }
  aiStore.setState({ chat: chat as never, running: { runId, msgId: 'm1' } })
}

function ask(runId: string, callId: string, args: unknown = { questions: QUESTIONS }): void {
  fake.cb.call?.({ callId, runId, tool: 'ask_user', args })
}

const part = () => aiStore.getState().chat.messages[0]?.parts.find((p) => p.type === 'question')
const resultOf = (callId: string) => fake.results.filter(([id]) => id === callId).map(([, r]) => r)

beforeAll(async () => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
  fake.files.set('C:/p/A', plan('aaaaAAAA'))
  fake.files.set('C:/p/B', plan('bbbbBBBB'))
  await openProject('C:/p/A', { skipConfirm: true })
  await settle()
})

beforeEach(async () => {
  fake.results.length = 0
  fake.calls.stop.length = 0
  fake.calls.run.length = 0
  aiStore.setState({ running: null, asking: null })
  await settle()
})

describe('ask_user', () => {
  it('shows the questions and returns the options picked and the «Другое» text', async () => {
    busy('r1')
    ask('r1', 'c1')
    await settle()
    const a = aiStore.getState().asking
    expect(a?.callId).toBe('c1')
    expect(a?.questions).toHaveLength(2)
    expect(part()).toMatchObject({ type: 'question', id: 'c1', status: 'pending' })
    expect(hasAnswer(a)).toBe(false)

    pickAnswer(0, 'Кухня')
    pickAnswer(0, 'Гостиная') // single choice: replaces
    pickAnswer(1, 'Кухня')
    pickAnswer(1, 'Спальня') // multi: adds
    pickAnswer(1, 'Кухня') // multi: toggles off
    setAnswerOther(1, '  у окна ')
    expect(aiStore.getState().asking?.draft).toEqual([{ picked: ['Гостиная'] }, { picked: ['Спальня'], other: '  у окна ' }])
    answerQuestion()
    await settle()

    const [r] = resultOf('c1')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('1. Как назвать комнату 1?\n   Ответ: Гостиная')
    expect(r.text).toContain('2. Где нужны розетки?\n   Ответ: Спальня; своими словами: у окна')
    expect(aiStore.getState().asking).toBeNull()
    expect(part()).toMatchObject({ status: 'answered', answers: [{ picked: ['Гостиная'] }, { picked: ['Спальня'], other: 'у окна' }] })
    // the turn goes on
    expect(aiStore.getState().running?.runId).toBe('r1')
  })

  it('text sent from the chat box answers the open question instead of starting a turn', async () => {
    busy('r2')
    ask('r2', 'c2')
    await settle()
    pickAnswer(0, 'Кухня')
    await send('  вторую комнату назови кабинетом ')
    await settle()
    const [r] = resultOf('c2')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Ответ: Кухня')
    expect(r.text).toContain('2. Где нужны розетки?\n   Ответ: (без ответа)')
    expect(r.text).toContain('Пользователь ответил в чате своими словами: вторую комнату назови кабинетом')
    expect(part()).toMatchObject({ status: 'answered', note: 'вторую комнату назови кабинетом' })
    expect(fake.calls.run).toEqual([])
    expect(aiStore.getState().running?.runId).toBe('r2')
  })

  it('«Пропустить» tells the agent not to invent the answers; the turn goes on', async () => {
    busy('r3')
    ask('r3', 'c3')
    await settle()
    answerQuestion(null)
    await settle()
    const [r] = resultOf('c3')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('Не выдумывай')
    expect(part()?.status).toBe('cancelled')
    expect(aiStore.getState().asking).toBeNull()
    expect(aiStore.getState().running?.runId).toBe('r3')
  })

  it('Stop while a question is open ends it; a late answer reaches nothing', async () => {
    busy('r4')
    ask('r4', 'c4')
    await settle()
    pickAnswer(0, 'Кухня')
    stop()
    await settle()
    expect(fake.calls.stop).toEqual(['r4'])
    expect(resultOf('c4')).toEqual([{ ok: false, text: 'Запуск остановлен' }])
    expect(aiStore.getState().asking).toBeNull()
    expect(part()?.status).toBe('cancelled')
    answerQuestion()
    await send('Кухня')
    await settle()
    expect(resultOf('c4')).toHaveLength(1)
  })

  it('another project opened while a question waits: the answer never reaches the old turn', async () => {
    busy('r5')
    ask('r5', 'c5')
    await settle()
    pickAnswer(0, 'Кухня')
    await openProject('C:/p/B', { skipConfirm: true })
    await settle()
    expect(fake.calls.stop).toEqual(['r5'])
    expect(resultOf('c5')).toEqual([{ ok: false, text: 'Запуск остановлен' }])
    expect(aiStore.getState().asking).toBeNull()

    // a new turn there asks its own question: the answer goes to that call only
    busy('r6')
    ask('r6', 'c6')
    await settle()
    pickAnswer(0, 'Гостиная')
    answerQuestion()
    await settle()
    expect(resultOf('c5')).toHaveLength(1)
    expect(resultOf('c6')[0].text).toContain('Ответ: Гостиная')
    await openProject('C:/p/A', { skipConfirm: true })
    await settle()
  })

  it('the project read again from disk keeps the question open and answerable', async () => {
    busy('r7')
    ask('r7', 'c7')
    await settle()
    await openProject('C:/p/A', { skipConfirm: true, reload: 'disk' })
    await settle()
    expect(fake.calls.stop).toEqual([])
    expect(aiStore.getState().asking?.callId).toBe('c7')
    pickAnswer(0, 'Кухня')
    answerQuestion()
    await settle()
    expect(resultOf('c7')[0]).toMatchObject({ ok: true })
  })

  it('main giving up on the call (an hour without an answer) closes the card', async () => {
    busy('r8')
    ask('r8', 'c8')
    await settle()
    fake.cb.cancel?.({ callId: 'c8', runId: 'r8' })
    await settle()
    expect(aiStore.getState().asking).toBeNull()
    expect(part()?.status).toBe('cancelled')
    expect(aiStore.getState().running?.runId).toBe('r8')
  })

  it('a call of a turn that is not running, or with bad arguments, shows no card', async () => {
    ask('gone', 'c9')
    await settle()
    expect(resultOf('c9')).toEqual([{ ok: false, text: 'Запуск не активен' }])
    busy('r10')
    ask('r10', 'c10', { questions: [{ question: 'Как?', options: [{ label: 'один' }] }] })
    await settle()
    expect(resultOf('c10')[0].ok).toBe(false)
    expect(resultOf('c10')[0].text).toContain('Неверные аргументы ask_user')
    expect(aiStore.getState().asking).toBeNull()
    expect(part()).toBeUndefined()
  })
})
