/**
 * Direct Anthropic Messages API provider: manual tool-use loop over the doplan doc tools with
 * streaming, adaptive thinking and server-side model fallbacks. Tool inputs stream eagerly, so
 * each one is validated (zod) before it runs. Conversation history is kept by the chat record.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AI_TOOL_DESCRIPTIONS, AI_TOOL_NAMES, toolJsonSchema } from '../../shared/aiTools'
import type { AiRunEvent } from '../../shared/aiChat'
import { getApiKey } from '../settings'
import { callDocTool } from './bridge'
import type { RunCtx } from './cliRunners'

export const API_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]
const DEFAULT_MODEL = 'claude-opus-5-5'
const MAX_STEPS = 40
const MAX_HISTORY_BYTES = 30 * 1024 * 1024

type Block = Record<string, unknown> & { type: string }
type Msg = { role: 'user' | 'assistant'; content: Block[] | string }

let toolsCache: unknown[] | null = null
function tools(): unknown[] {
  toolsCache ??= AI_TOOL_NAMES.map((name, i) => ({
    name,
    description: AI_TOOL_DESCRIPTIONS[name],
    input_schema: toolJsonSchema(name),
    eager_input_streaming: true,
    ...(i === AI_TOOL_NAMES.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }))
  return toolsCache
}

function sanitizeHistory(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return []
  if (JSON.stringify(raw).length > MAX_HISTORY_BYTES) return []
  return raw.filter((m): m is Msg => !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
}

/** big images in old turns bloat every request: keep only the newest user images */
function stripOldImages(history: Msg[]): Msg[] {
  return history.map((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? { ...m, content: m.content.map((b) => (b.type === 'image' ? { type: 'text', text: '[изображение из прошлого сообщения]' } : b)) }
      : m,
  )
}

function apiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Неверный API-ключ Anthropic'
  if (e instanceof Anthropic.PermissionDeniedError) return `Доступ запрещён: ${e.message}`
  if (e instanceof Anthropic.RateLimitError) return 'Превышен лимит запросов Anthropic API, попробуйте позже'
  if (e instanceof Anthropic.APIConnectionError) return `Нет связи с Anthropic API: ${e.message}`
  if (e instanceof Anthropic.APIError) return `Ошибка Anthropic API (${e.status ?? '?'}): ${e.message}`
  return (e as Error)?.message ?? String(e)
}

export async function runAnthropicApi(ctx: Omit<RunCtx, 'endpoint' | 'cwd' | 'track'>): Promise<void> {
  const { req, emit, signal } = ctx
  const key = await getApiKey()
  if (!key) return emit({ type: 'done', ok: false, error: 'Не задан API-ключ Anthropic (Настройки → ИИ)' })
  const client = new Anthropic({ apiKey: key, maxRetries: 2 })
  const model = req.settings.models.api || DEFAULT_MODEL
  const effort = req.settings.effort || undefined

  const history = stripOldImages(sanitizeHistory(req.apiHistory))
  const userContent: Block[] = [
    ...req.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
    { type: 'text', text: ctx.userText },
  ]
  const messages: Msg[] = [...history, { role: 'user', content: userContent }]
  let inTok = 0
  let outTok = 0
  let cacheTok = 0
  let fallbackNoticed = false
  emit({ type: 'status', text: `Anthropic API: ${model}` })

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break
      const params = {
        model,
        max_tokens: 32000,
        system: [{ type: 'text', text: ctx.systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: tools(),
        messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(effort ? { output_config: { effort } } : {}),
        fallbacks: 'default',
        betas: ['server-side-fallback-2026-07-01'],
      }
      const stream = client.beta.messages.stream(params as never, { signal })
      stream.on('streamEvent', (ev: unknown) => {
        const e = ev as { type: string; index?: number; delta?: { type: string; text?: string; thinking?: string } }
        if (e.type !== 'content_block_delta' || !e.delta) return
        const partId = `s${step}:${e.index ?? 0}`
        if (e.delta.type === 'text_delta' && e.delta.text) emit({ type: 'text', partId, delta: e.delta.text })
        else if (e.delta.type === 'thinking_delta' && e.delta.thinking) emit({ type: 'thinking', partId, delta: e.delta.thinking })
      })
      const msg = (await stream.finalMessage()) as unknown as {
        model?: string
        content: Block[]
        stop_reason: string | null
        stop_details?: { explanation?: string } | null
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      }
      const u = msg.usage ?? {}
      inTok += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      outTok += u.output_tokens ?? 0
      cacheTok += u.cache_read_input_tokens ?? 0
      if (!fallbackNoticed && msg.model && msg.model !== model && !msg.model.startsWith(model)) {
        fallbackNoticed = true
        emit({ type: 'notice', level: 'info', text: `Ответ сформировала резервная модель ${msg.model}` })
      }
      messages.push({ role: 'assistant', content: msg.content })

      if (msg.stop_reason === 'refusal') {
        emit({ type: 'notice', level: 'warning', text: `Модель отказалась отвечать${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}` })
        break
      }
      if (msg.stop_reason === 'max_tokens') {
        emit({ type: 'notice', level: 'warning', text: 'Ответ оборвался: достигнут лимит длины' })
        // a truncated tool_use must not run; drop it from the history so the next turn is valid
        messages[messages.length - 1] = { role: 'assistant', content: msg.content.filter((b) => b.type !== 'tool_use') }
        break
      }
      if (msg.stop_reason === 'pause_turn') continue
      if (msg.stop_reason !== 'tool_use') break

      const results: Block[] = []
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue
        const r = signal.aborted ? { ok: false, text: 'Остановлено пользователем' } : await callDocTool(req.runId, String(b.name), b.input)
        const content: Block[] = [{ type: 'text', text: r.text || (r.ok ? 'OK' : 'Ошибка') }]
        if ('image' in r && r.image) content.push({ type: 'image', source: { type: 'base64', media_type: r.image.mime, data: r.image.data } })
        results.push({ type: 'tool_result', tool_use_id: b.id, content, ...(r.ok ? {} : { is_error: true }) })
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    if (signal.aborted) {
      emitHistory(emit, messages)
      return emit({ type: 'done', ok: false, stopped: true })
    }
    emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok })
    return emit({ type: 'done', ok: false, error: apiError(e) })
  }
  emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok })
  emitHistory(emit, messages)
  emit(signal.aborted ? { type: 'done', ok: false, stopped: true } : { type: 'done', ok: true })
}

/** history must end in a state the API accepts next turn (no dangling tool_use) */
function emitHistory(emit: (ev: AiRunEvent) => void, messages: Msg[]): void {
  const out = [...messages]
  const last = out[out.length - 1]
  if (last?.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) out.pop()
  if (out[out.length - 1]?.role === 'user') {
    // the turn ended right after tool results (stopped): close it with a short assistant note
    out.push({ role: 'assistant', content: [{ type: 'text', text: '(остановлено)' }] })
  }
  emit({ type: 'apiHistory', messages: out })
}
