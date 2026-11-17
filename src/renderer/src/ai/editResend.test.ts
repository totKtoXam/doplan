import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'
import { quoteMarkdown, type AiMessage, type AiRunEvent, type AiRunRequest } from '@shared/aiChat'
import { chatTranscript } from './history'

// Quoting passages of the chat, and editing an earlier message: the chat goes on from it, the agent
// session of the old conversation is dropped and the new one gets the chat so far as text.

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const runs: AiRunRequest[] = []
  const stops: string[] = []
  const cb: { event: ((runId: string, ev: unknown) => void) | null } = { event: null }
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
      stop: async (runId: string) => void stops.push(runId),
      run: async (req: AiRunRequest) => void runs.push(JSON.parse(JSON.stringify(req))),
      onEvent: (f: (runId: string, ev: unknown) => void) => {
        cb.event = f
        return () => {}
      },
      onToolCall: () => () => {},
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
  return { api, files, runs, stops, cb }
})

vi.mock('@/store/api', () => ({ api: fake.api }))

const { openProject } = await import('@/actions/project')
const { addQuote, aiStore, editAndResend, initAi, removeQuote, send, stop } = await import('./store')

const settle = () => new Promise((r) => setTimeout(r, 10))
const ev = (runId: string, e: AiRunEvent) => fake.cb.event?.(runId, e)
const lastRun = () => fake.runs[fake.runs.length - 1]
const msgs = () => aiStore.getState().chat.messages
const textOf = (m: AiMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

function plan(id: string): unknown {
  const doc: Doc = createEmptyDoc('План')
  return JSON.parse(JSON.stringify({ ...doc, meta: { ...doc.meta, id } }))
}

function useProvider(id: 'claude' | 'api'): void {
  const s = aiStore.getState()
  aiStore.setState({
    providers: [{ id, label: id, available: true, models: [], efforts: [], reportsCost: false, images: true }],
    settings: { ...s.settings, provider: id },
  })
}

/** one finished turn: the user's text, the agent's session (or API history) and its answer */
async function turn(text: string, answer: string, session?: string): Promise<AiRunRequest> {
  await send(text)
  const req = lastRun()
  if (session) ev(req.runId, { type: 'session', id: session, cwd: 'C:/work' })
  else ev(req.runId, { type: 'apiHistory', messages: [{ role: 'user', content: text }] })
  ev(req.runId, { type: 'text', partId: 'p', delta: answer })
  ev(req.runId, { type: 'done', ok: true })
  await settle()
  return req
}

const IMG = { mime: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'план.png', url: 'data:image/png;base64,iVBORw0KGgo=' }
const CHIP = { kind: 'room', id: 'r_1', label: 'Кухня', summary: 'room r_1 «Кухня» 12 м²' }

beforeAll(async () => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
  fake.files.set('C:/p/A', plan('aaaaAAAA'))
  await openProject('C:/p/A', { skipConfirm: true })
  await settle()
})

beforeEach(() => {
  fake.runs.length = 0
  fake.stops.length = 0
  aiStore.setState({ running: null, asking: null, quotes: [], chips: [], images: [] })
  aiStore.setState({ chat: { ...aiStore.getState().chat, id: crypto.randomUUID(), title: '', messages: [], resume: undefined, resumeCwd: undefined, apiHistory: undefined } })
})

describe('quotes', () => {
  it('quoteMarkdown: each passage a markdown quote before the text, blank lines kept inside', () => {
    expect(quoteMarkdown(['Кухня 12 м²'])).toBe('> Кухня 12 м²\n\n')
    expect(quoteMarkdown(['  строка 1\r\n\r\nстрока 2 ', '', 'второй'])).toBe('> строка 1\n>\n> строка 2\n\n> второй\n\n')
    expect(quoteMarkdown([])).toBe('')
  })

  it('a quote goes to the model before the text, stays on the message, leaves the input box', async () => {
    useProvider('api')
    addQuote('  Площадь кухни 12 м²\n\n\n\nокно на север ')
    addQuote('Площадь кухни 12 м²\n\nокно на север') // the same passage once
    addQuote('второй абзац')
    expect(aiStore.getState().quotes.map((q) => q.text)).toEqual(['Площадь кухни 12 м²\n\nокно на север', 'второй абзац'])
    removeQuote(aiStore.getState().quotes[1].id)
    await send('почему так мало?')
    expect(lastRun().text).toBe('> Площадь кухни 12 м²\n>\n> окно на север\n\nпочему так мало?')
    const [u] = msgs()
    expect(textOf(u)).toBe('почему так мало?')
    expect(u.quotes).toEqual(['Площадь кухни 12 м²\n\nокно на север'])
    expect(aiStore.getState().quotes).toEqual([])
    stop()
  })

  it('a quote alone can be sent', async () => {
    useProvider('api')
    addQuote('Добавь окно')
    await send('')
    expect(lastRun().text).toBe('> Добавь окно\n\n')
    expect(msgs()[0].quotes).toEqual(['Добавь окно'])
    expect(aiStore.getState().chat.title).toBe('Добавь окно')
    stop()
  })
})

describe('chat transcript', () => {
  it('user text with quotes, chips and pictures; assistant text, tools as a count, questions with answers', () => {
    const m: AiMessage[] = [
      { id: '1', role: 'user', createdAt: '', parts: [{ type: 'text', text: 'Сделай кухню больше' }], quotes: ['12 м²'], chips: [CHIP], images: ['data:x', ''] },
      {
        id: '2',
        role: 'assistant',
        createdAt: '',
        parts: [
          { type: 'text', text: 'Смотрю план.' },
          { type: 'tool', id: 't1', name: 'get_plan', title: 'План', status: 'done' },
          { type: 'tool', id: 't2', name: 'move', title: 'Сдвиг', status: 'done' },
          { type: 'question', id: 'q', questions: [{ question: 'Куда?', options: [] }], status: 'answered', answers: [{ picked: ['На север'], other: 'на 30 см' }] },
          { type: 'text', text: 'Готово.' },
        ],
      } as AiMessage,
    ]
    expect(chatTranscript(m)).toBe(
      'User:\n> 12 м²\n[added to the chat: room r_1 — room r_1 «Кухня» 12 м²]\n[1 image attached]\nСделай кухню больше\n\n' +
        'Assistant:\nСмотрю план.\n[used 2 tools]\n[asked the user]\nQ: Куда? — A: На север, на 30 см\nГотово.',
    )
  })

  it('a long chat keeps its latest messages', () => {
    const m: AiMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', createdAt: '', parts: [{ type: 'text', text: `сообщение ${i} ${'x'.repeat(80)}` }] }) as AiMessage)
    const s = chatTranscript(m, 1000)
    expect(s.length).toBeLessThanOrEqual(1000 + 40)
    expect(s.startsWith('[… earlier messages left out]')).toBe(true)
    expect(s).toContain('сообщение 29')
    expect(s).not.toContain('сообщение 0 ')
  })
})

describe('edit and send again', () => {
  it('cuts the chat at the message, drops the agent session, the new one gets the turns before as text', async () => {
    useProvider('claude')
    const r1 = await turn('Нарисуй комнату 3×4', 'Нарисовал комнату.', 'S-1')
    expect(r1.history).toBeUndefined()
    expect(r1.resumeId).toBeUndefined()
    const r2 = await turn('Добавь окно', 'Окно добавлено.', 'S-1')
    expect(r2.resumeId).toBe('S-1')
    expect(r2.history).toContain('Нарисуй комнату 3×4')
    await turn('Добавь дверь', 'Дверь добавлена.', 'S-1')
    expect(msgs()).toHaveLength(6)
    expect(aiStore.getState().chat.resume?.claude).toBe('S-1')

    // the second message, changed
    const second = msgs()[2]
    expect(await editAndResend(second.id, 'Добавь два окна')).toBe(true)
    const req = lastRun()
    expect(req.text).toBe('Добавь два окна')
    expect(req.resumeId).toBeUndefined()
    expect(req.resumeCwd).toBeUndefined()
    expect(req.history).toBe('User:\nНарисуй комнату 3×4\n\nAssistant:\nНарисовал комнату.')
    const chat = aiStore.getState().chat
    expect(chat.resume).toBeUndefined()
    expect(chat.resumeCwd).toBeUndefined()
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(textOf(chat.messages[2])).toBe('Добавь два окна')
    expect(chat.messages.some((m) => textOf(m).includes('дверь'))).toBe(false)

    // the new session is kept and continues from here
    ev(req.runId, { type: 'session', id: 'S-2', cwd: 'C:/work' })
    ev(req.runId, { type: 'done', ok: true })
    await settle()
    await send('Ещё одно')
    expect(lastRun().resumeId).toBe('S-2')
    stop()
  })

  it('the first message: no history at all, the title follows the new text', async () => {
    useProvider('claude')
    await turn('Старый вопрос', 'Ответ.', 'S-1')
    expect(await editAndResend(msgs()[0].id, 'Новый вопрос')).toBe(true)
    expect(lastRun().history).toBeUndefined()
    expect(lastRun().resumeId).toBeUndefined()
    expect(aiStore.getState().chat.title).toBe('Новый вопрос')
    expect(msgs()).toHaveLength(2)
    stop()
  })

  it('the API provider: its kept history is dropped too', async () => {
    useProvider('api')
    await turn('Раз', 'один')
    await turn('Два', 'два')
    expect(lastRun().apiHistory).toHaveLength(1)
    expect(await editAndResend(msgs()[2].id, 'Два, но иначе')).toBe(true)
    expect(lastRun().apiHistory).toBeUndefined()
    expect(lastRun().history).toBe('User:\nРаз\n\nAssistant:\nодин')
    expect(aiStore.getState().chat.apiHistory).toBeUndefined()
    stop()
  })

  it('chips, quotes and pictures of the message go again; the input box stays as it is', async () => {
    useProvider('api')
    aiStore.setState({ chips: [CHIP], images: [IMG] })
    addQuote('12 м²')
    await send('Увеличь')
    const r = lastRun()
    ev(r.runId, { type: 'done', ok: true })
    await settle()
    // something new waits in the input box
    aiStore.setState({ chips: [{ ...CHIP, id: 'r_2', label: 'Спальня' }] })
    addQuote('другое')
    expect(await editAndResend(msgs()[0].id, 'Увеличь вдвое')).toBe(true)
    const req = lastRun()
    expect(req.text).toBe('> 12 м²\n\nУвеличь вдвое')
    expect(req.chips).toEqual([CHIP])
    expect(req.images).toEqual([{ mime: IMG.mime, data: IMG.data, name: IMG.name }])
    expect(msgs()[0]).toMatchObject({ chips: [CHIP], quotes: ['12 м²'] })
    expect(aiStore.getState().chips.map((c) => c.id)).toEqual(['r_2'])
    expect(aiStore.getState().quotes.map((q) => q.text)).toEqual(['другое'])
    stop()
  })

  it('after a restart the pictures kept in the chat go again', async () => {
    useProvider('api')
    const chat = aiStore.getState().chat
    aiStore.setState({
      chat: {
        ...chat,
        messages: [
          { id: 'u1', role: 'user', createdAt: '', parts: [{ type: 'text', text: '(изображение)' }], images: ['data:image/jpeg;base64,/9j/AAA='] },
          { id: 'a1', role: 'assistant', createdAt: '', parts: [{ type: 'text', text: 'Вижу план.' }] },
        ],
      },
    })
    expect(await editAndResend('u1', 'Построй по нему план')).toBe(true)
    expect(lastRun().images).toEqual([{ mime: 'image/jpeg', data: '/9j/AAA=', name: 'изображение' }])
    stop()
  })

  it('not while a turn runs; Stop ends an edited turn as any other', async () => {
    useProvider('claude')
    await turn('Раз', 'один', 'S-1')
    const id = msgs()[0].id
    await send('Два')
    const running = aiStore.getState().running
    expect(running).not.toBeNull()
    expect(await editAndResend(id, 'Другое')).toBe(false)
    stop()
    expect(fake.stops).toEqual([running!.runId])

    expect(await editAndResend(id, 'Раз, но иначе')).toBe(true)
    const r = aiStore.getState().running!
    stop()
    expect(fake.stops).toEqual([running!.runId, r.runId])
    expect(aiStore.getState().running).toBeNull()
    expect(msgs().map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('a turn stopped before the edit cannot bring the old session back', async () => {
    useProvider('claude')
    await turn('Раз', 'один', 'S-1')
    await send('Два')
    const old = lastRun()
    stop()
    expect(await editAndResend(msgs()[0].id, 'Раз, иначе')).toBe(true)
    const r = lastRun()
    // the stopped turn reports its session late
    ev(old.runId, { type: 'session', id: 'S-old', cwd: 'C:/work' })
    ev(old.runId, { type: 'apiHistory', messages: [{ role: 'user', content: 'old' }] })
    await settle()
    expect(aiStore.getState().chat.resume?.claude).toBeUndefined()
    expect(aiStore.getState().chat.apiHistory).toBeUndefined()
    ev(r.runId, { type: 'session', id: 'S-new', cwd: 'C:/work' })
    ev(r.runId, { type: 'done', ok: true })
    await settle()
    expect(aiStore.getState().chat.resume?.claude).toBe('S-new')
  })
})
