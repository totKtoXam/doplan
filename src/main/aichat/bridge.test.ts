import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The doc-tool bridge main → renderer: an ask_user call waits up to an hour (other calls a quarter),
// and a call main gives up on is withdrawn in the renderer too.

const sent = vi.hoisted(() => [] as [string, unknown][])
vi.mock('../window', () => ({
  getMainWindow: () => ({}),
  sendToRenderer: (ch: string, payload: unknown) => void sent.push([ch, payload]),
}))
vi.mock('../ai', () => ({ PLAN_EXTRACTION_SYSTEM: '' }))

const { ASK_TIMEOUT_MS, callDocTool, closeRun, onToolResult } = await import('./bridge')
const { CH } = await import('../channels')

const QUESTIONS = { questions: [{ question: 'Как назвать комнату 1?', options: [{ label: 'Кухня' }, { label: 'Спальня' }] }] }

const callIdOf = (i = 0) => (sent.filter(([ch]) => ch === CH.evAiChatToolCall)[i][1] as { callId: string }).callId

beforeEach(() => {
  sent.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('callDocTool: ask_user', () => {
  it('waits for the answer longer than other calls and returns it', async () => {
    const p = callDocTool('r1', 'ask_user', QUESTIONS)
    expect(sent[0]).toEqual([CH.evAiChatToolCall, { callId: callIdOf(), runId: 'r1', tool: 'ask_user', args: QUESTIONS }])
    // past the 15 minutes of an ordinary call: still waiting
    vi.advanceTimersByTime(30 * 60 * 1000)
    onToolResult(callIdOf(), { ok: true, text: 'Ответы пользователя: Кухня' })
    await expect(p).resolves.toEqual({ ok: true, text: 'Ответы пользователя: Кухня' })
  })

  it('an hour without an answer: the agent is told not to invent it and the card is withdrawn', async () => {
    const p = callDocTool('r2', 'ask_user', QUESTIONS)
    const callId = callIdOf()
    vi.advanceTimersByTime(ASK_TIMEOUT_MS)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.text).toContain('Не выдумывай')
    expect(sent.at(-1)).toEqual([CH.evAiChatToolCancel, { callId, runId: 'r2' }])
    // a late answer from the renderer changes nothing
    onToolResult(callId, { ok: true, text: 'поздно' })
  })

  it('an ordinary call still times out after 15 minutes', async () => {
    const p = callDocTool('r3', 'get_plan', {})
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect((await p).ok).toBe(false)
  })

  it('Stop resolves a waiting question as stopped', async () => {
    const p = callDocTool('r4', 'ask_user', QUESTIONS)
    closeRun('r4')
    await expect(p).resolves.toEqual({ ok: false, text: 'Остановлено пользователем' })
  })

  it('invalid questions never reach the renderer', async () => {
    const r = await callDocTool('r5', 'ask_user', { questions: [] })
    expect(r.ok).toBe(false)
    expect(sent).toEqual([])
  })
})
