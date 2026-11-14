/**
 * Parsers for agent CLI JSON-lines output → normalised AiRunEvent stream. Pure (no Node / Electron),
 * unit-tested in tests/aichat.test.ts.
 *
 * Claude Code: `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * Codex: `codex exec --json`.
 */
import type { AiRunEvent } from '../../shared/aiChat'

/** doplan doc tools are shown by the app's own cards: hide the provider's copy */
export const DOC_TOOL_PREFIXES = ['mcp__doplan__', 'doplan__', 'doplan.']

export function isDocTool(name: string): boolean {
  return DOC_TOOL_PREFIXES.some((p) => name.startsWith(p))
}

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

function toolOutputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const o = obj(c)
        if (!o) return ''
        if (o.type === 'text') return str(o.text) ?? ''
        if (o.type === 'image') return '[изображение]'
        return ''
      })
      .join('\n')
  }
  return ''
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s)

export interface ClaudeResult {
  ok: boolean
  error?: string
  sessionId?: string
  costUsd?: number
}

export class ClaudeStreamParser {
  sessionId?: string
  result?: ClaudeResult
  /** message ids whose text/thinking arrived as partial deltas */
  private streamed = new Set<string>()
  private currentMsg = ''
  /** content block index → kind for the message being streamed */
  private blocks = new Map<number, 'text' | 'thinking' | 'other'>()
  private seenTools = new Set<string>()
  private extTools = new Map<string, string>()
  private wholeText = new Set<string>()
  private buf = ''

  /** Feed raw stdout; returns events for every complete line. */
  push(chunk: string): AiRunEvent[] {
    this.buf += chunk
    const out: AiRunEvent[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      out.push(...this.line(line))
    }
    return out
  }

  /** Flush a trailing line without newline. */
  end(): AiRunEvent[] {
    const rest = this.buf
    this.buf = ''
    return rest.trim() ? this.line(rest) : []
  }

  line(raw: string): AiRunEvent[] {
    const s = raw.trim()
    if (!s || s[0] !== '{') return []
    let msg: Record<string, unknown> | null
    try {
      msg = obj(JSON.parse(s))
    } catch {
      return []
    }
    if (!msg) return []
    // sub-agent traffic (Agent tool) stays inside its tool card
    if (msg.parent_tool_use_id) return []
    switch (msg.type) {
      case 'system':
        return this.system(msg)
      case 'stream_event':
        return this.streamEvent(obj(msg.event))
      case 'assistant':
        return this.assistant(obj(msg.message))
      case 'user':
        return this.user(obj(msg.message))
      case 'result':
        return this.resultMsg(msg)
      default:
        return []
    }
  }

  private system(msg: Record<string, unknown>): AiRunEvent[] {
    if (msg.subtype !== 'init') return []
    const out: AiRunEvent[] = []
    const sid = str(msg.session_id)
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid
      out.push({ type: 'session', id: sid })
    }
    const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : []
    const doplan = servers.map(obj).find((x) => x?.name === 'doplan')
    if (servers.length && (!doplan || doplan.status !== 'connected')) {
      out.push({ type: 'notice', level: 'error', text: `MCP-сервер doplan не подключился (${str(doplan?.status) ?? 'нет'})` })
    }
    return out
  }

  private streamEvent(ev: Record<string, unknown> | null): AiRunEvent[] {
    if (!ev) return []
    if (ev.type === 'message_start') {
      const m = obj(ev.message)
      this.currentMsg = str(m?.id) ?? `m${Date.now()}`
      this.blocks.clear()
      return []
    }
    const index = num(ev.index) ?? 0
    if (ev.type === 'content_block_start') {
      const b = obj(ev.content_block)
      const kind = b?.type === 'text' ? 'text' : b?.type === 'thinking' ? 'thinking' : 'other'
      this.blocks.set(index, kind)
      return []
    }
    if (ev.type === 'content_block_delta') {
      const d = obj(ev.delta)
      if (!d) return []
      const partId = `${this.currentMsg}:${index}`
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        this.streamed.add(this.currentMsg)
        return [{ type: 'text', partId, delta: d.text }]
      }
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        this.streamed.add(this.currentMsg)
        return [{ type: 'thinking', partId, delta: d.thinking }]
      }
    }
    return []
  }

  private assistant(m: Record<string, unknown> | null): AiRunEvent[] {
    if (!m) return []
    const id = str(m.id) ?? ''
    const content = Array.isArray(m.content) ? m.content : []
    const out: AiRunEvent[] = []
    content.forEach((raw, i) => {
      const b = obj(raw)
      if (!b) return
      if (b.type === 'tool_use') {
        const tid = str(b.id) ?? `${id}:${i}`
        const name = str(b.name) ?? 'tool'
        if (this.seenTools.has(tid)) return
        this.seenTools.add(tid)
        if (isDocTool(name)) return
        this.extTools.set(tid, name)
        out.push({ type: 'tool', partId: tid, name, input: b.input, status: 'running' })
        return
      }
      if (this.streamed.has(id)) return
      const text = b.type === 'text' ? str(b.text) : b.type === 'thinking' ? str(b.thinking) : undefined
      if (!text) return
      const key = `${id}:${b.type}:${text.length}:${text.slice(0, 40)}`
      if (this.wholeText.has(key)) return
      this.wholeText.add(key)
      out.push({ type: b.type === 'text' ? 'text' : 'thinking', partId: `${id}:w${this.wholeText.size}`, delta: text })
    })
    return out
  }

  private user(m: Record<string, unknown> | null): AiRunEvent[] {
    const content = m && Array.isArray(m.content) ? m.content : []
    const out: AiRunEvent[] = []
    for (const raw of content) {
      const b = obj(raw)
      if (!b || b.type !== 'tool_result') continue
      const tid = str(b.tool_use_id) ?? ''
      const name = this.extTools.get(tid)
      if (!name) continue
      this.extTools.delete(tid)
      out.push({ type: 'tool', partId: tid, name, status: b.is_error ? 'error' : 'done', output: clip(toolOutputText(b.content)) })
    }
    return out
  }

  private resultMsg(msg: Record<string, unknown>): AiRunEvent[] {
    const usage = obj(msg.usage)
    const isError = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))
    const sid = str(msg.session_id)
    if (sid) this.sessionId = sid
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : []
    this.result = {
      ok: !isError,
      error: isError ? clip(str(msg.result) || errors.join('; ') || String(msg.subtype ?? 'ошибка'), 1000) : undefined,
      sessionId: sid,
      costUsd: num(msg.total_cost_usd),
    }
    const out: AiRunEvent[] = []
    if (sid) out.push({ type: 'session', id: sid })
    out.push({
      type: 'usage',
      inputTokens: (num(usage?.input_tokens) ?? 0) + (num(usage?.cache_creation_input_tokens) ?? 0) + (num(usage?.cache_read_input_tokens) ?? 0) || undefined,
      outputTokens: num(usage?.output_tokens),
      cacheReadTokens: num(usage?.cache_read_input_tokens),
      costUsd: num(msg.total_cost_usd),
    })
    return out
  }
}

// ───────────── Codex ─────────────

export interface CodexResult {
  ok: boolean
  error?: string
}

export class CodexJsonParser {
  threadId?: string
  result?: CodexResult
  private lastError?: string
  private buf = ''
  private sentText = new Map<string, number>()

  push(chunk: string): AiRunEvent[] {
    this.buf += chunk
    const out: AiRunEvent[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      out.push(...this.line(line))
    }
    return out
  }

  end(): AiRunEvent[] {
    const rest = this.buf
    this.buf = ''
    return rest.trim() ? this.line(rest) : []
  }

  line(raw: string): AiRunEvent[] {
    const s = raw.trim()
    if (!s || s[0] !== '{') return []
    let ev: Record<string, unknown> | null
    try {
      ev = obj(JSON.parse(s))
    } catch {
      return []
    }
    if (!ev) return []
    switch (ev.type) {
      case 'thread.started': {
        const id = str(ev.thread_id)
        if (!id) return []
        this.threadId = id
        return [{ type: 'session', id }]
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(obj(ev.item), ev.type === 'item.completed')
      case 'turn.completed': {
        const u = obj(ev.usage)
        this.result = { ok: true }
        return [
          {
            type: 'usage',
            inputTokens: num(u?.input_tokens),
            outputTokens: num(u?.output_tokens),
            cacheReadTokens: num(u?.cached_input_tokens),
          },
        ]
      }
      case 'turn.failed': {
        const msg = str(obj(ev.error)?.message) ?? this.lastError ?? 'Ошибка Codex'
        this.result = { ok: false, error: clip(msg, 1000) }
        return []
      }
      case 'error': {
        const msg = str(ev.message) ?? 'Ошибка Codex'
        this.lastError = msg
        // reconnect chatter is informational
        return [{ type: 'notice', level: /reconnect/i.test(msg) ? 'info' : 'error', text: clip(msg, 1000) }]
      }
      default:
        return []
    }
  }

  private item(it: Record<string, unknown> | null, completed: boolean): AiRunEvent[] {
    if (!it) return []
    const id = str(it.id) ?? 'item'
    const kind = str(it.type) ?? str(it.item_type)
    if (kind === 'agent_message' || kind === 'reasoning') {
      const text = str(it.text) ?? ''
      const sent = this.sentText.get(id) ?? 0
      if (text.length <= sent) return []
      this.sentText.set(id, text.length)
      return [{ type: kind === 'agent_message' ? 'text' : 'thinking', partId: id, delta: text.slice(sent) }]
    }
    if (kind === 'mcp_tool_call') {
      if (str(it.server) === 'doplan') return []
      const name = `${str(it.server) ?? 'mcp'}.${str(it.tool) ?? 'tool'}`
      const status = !completed ? 'running' : it.status === 'failed' || it.error ? 'error' : 'done'
      return [{ type: 'tool', partId: id, name, input: it.arguments, status }]
    }
    if (kind === 'command_execution') {
      const status = !completed ? 'running' : it.status === 'failed' || (num(it.exit_code) ?? 0) !== 0 ? 'error' : 'done'
      return [{ type: 'tool', partId: id, name: 'shell', input: { command: it.command }, status, output: completed ? clip(str(it.aggregated_output) ?? '') : undefined }]
    }
    if (kind === 'web_search') {
      return [{ type: 'tool', partId: id, name: 'web_search', input: { query: it.query }, status: completed ? 'done' : 'running' }]
    }
    if (kind === 'error') {
      return [{ type: 'notice', level: 'warning', text: clip(str(it.message) ?? 'ошибка', 1000) }]
    }
    return []
  }
}
