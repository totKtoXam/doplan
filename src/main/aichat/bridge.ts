/**
 * Doc tool calls main → renderer: the renderer owns the document and applies the change with
 * docStore.transact (undoable, visible immediately); main waits for the result.
 */
import { randomUUID } from 'node:crypto'
import { type AiToolResult } from '../../shared/aiChat'
import { isAiToolName, parseToolArgs } from '../../shared/aiTools'
import { PLAN_EXTRACTION_SYSTEM } from '../ai'
import { CH } from '../channels'
import { getMainWindow, sendToRenderer } from '../window'

interface Pending {
  runId: string
  resolve: (r: AiToolResult) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
/** runs stopped by the user: their late MCP calls never reach the document */
const closed = new Set<string>()
/** generous: ask mode waits for the user to approve */
const CALL_TIMEOUT_MS = 15 * 60 * 1000
const MAX_TEXT = 200_000

function sanitizeResult(raw: unknown): AiToolResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiToolResult>
  const text = typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : ''
  const out: AiToolResult = { ok: r.ok === true, text }
  const img = r.image
  if (img && typeof img === 'object' && (img.mime === 'image/png' || img.mime === 'image/jpeg') && typeof img.data === 'string' && img.data.length < 12_000_000) {
    out.image = { mime: img.mime, data: img.data }
  }
  return out
}

export function onToolResult(callId: unknown, result: unknown): void {
  if (typeof callId !== 'string') return
  const p = pending.get(callId)
  if (!p) return
  pending.delete(callId)
  clearTimeout(p.timer)
  p.resolve(sanitizeResult(result))
}

/** Validates and forwards one call; never throws (errors come back as ok:false for the agent). */
export async function callDocTool(runId: string, tool: string, args: unknown): Promise<AiToolResult> {
  if (!isAiToolName(tool)) return { ok: false, text: `Неизвестный инструмент: ${tool}` }
  const parsed = parseToolArgs(tool, args)
  if (!parsed.ok) return { ok: false, text: parsed.error }
  // static reference text: answered here, the document is not involved
  if (tool === 'get_planspec_schema') return { ok: true, text: PLAN_EXTRACTION_SYSTEM }
  if (closed.has(runId)) return { ok: false, text: 'Запуск остановлен пользователем' }
  if (!getMainWindow()) return { ok: false, text: 'Окно редактора закрыто' }
  const callId = randomUUID()
  return new Promise<AiToolResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(callId)
      resolve({ ok: false, text: 'Нет ответа от редактора (время ожидания истекло)' })
    }, CALL_TIMEOUT_MS)
    pending.set(callId, { runId, resolve, timer })
    sendToRenderer(CH.evAiChatToolCall, { callId, runId, tool, args: parsed.args })
  })
}

/** Stop: the run takes no more doc calls, the waiting ones resolve as stopped. */
export function closeRun(runId: string): void {
  closed.add(runId)
  abortRunCalls(runId)
}

/** the run is over and its token revoked: nothing left to remember */
export function forgetRun(runId: string): void {
  closed.delete(runId)
}

/** Resolves every call still waiting for this run (stop / process exit). */
export function abortRunCalls(runId: string, why = 'Остановлено пользователем'): void {
  for (const [id, p] of pending) {
    if (p.runId !== runId) continue
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve({ ok: false, text: why })
  }
}
