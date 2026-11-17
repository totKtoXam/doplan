/**
 * The chat as plain text, for an agent that starts without its own memory of it (see AiRunRequest.history):
 * what the user wrote (with the passages quoted, the objects added, the pictures) and what the assistant
 * answered (its text; tool calls as a count). Long chats keep their latest turns.
 */
import { quoteMarkdown, type AiMessage } from '@shared/aiChat'
import { t } from '@/i18n'

export const MAX_TRANSCRIPT = 40_000
/** one message never takes more than this */
const MAX_ENTRY = 8_000

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)} […]` : s
}

function userEntry(m: AiMessage): string {
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim()
  const lines: string[] = []
  if (m.quotes?.length) lines.push(quoteMarkdown(m.quotes).trim())
  if (m.chips?.length) lines.push(`[added to the chat: ${m.chips.map((c) => `${c.kind} ${c.id} — ${c.summary}`).join('; ')}]`)
  const pics = m.images?.filter(Boolean).length ?? 0
  if (pics) lines.push(`[${pics} image${pics > 1 ? 's' : ''} attached]`)
  if (text) lines.push(text)
  return lines.join('\n')
}

function assistantEntry(m: AiMessage): string {
  const out: string[] = []
  let tools = 0
  const flushTools = () => {
    if (tools) out.push(`[used ${tools} tool${tools > 1 ? 's' : ''}]`)
    tools = 0
  }
  for (const p of m.parts) {
    if (p.type === 'tool') {
      tools++
      continue
    }
    if (p.type === 'text' && p.text.trim()) {
      flushTools()
      out.push(p.text.trim())
    } else if (p.type === 'question') {
      flushTools()
      const qa = p.questions.map((q, i) => {
        const a = p.answers?.[i]
        const answer = a ? [...a.picked, a.other ?? ''].filter(Boolean).join(', ') : ''
        return `Q: ${q.question}${answer ? ` — A: ${answer}` : ''}`
      })
      const quoted = p.quotes?.length ? `\nQuoted:\n${quoteMarkdown(p.quotes).trimEnd()}` : ''
      out.push(`[asked the user${p.status === 'answered' ? '' : ` (${p.status})`}]\n${qa.join('\n')}${quoted}${p.note ? `\nNote: ${p.note}` : ''}`)
    } else if (p.type === 'notice' && (p.text === 'Остановлено' || p.text === t('Остановлено'))) {
      flushTools()
      out.push('[stopped by the user]')
    }
  }
  flushTools()
  if (m.error) out.push(`[error: ${clip(m.error, 300)}]`)
  return out.join('\n')
}

/** `messages` in order; the transcript of them, the oldest left out when it gets too long */
export function chatTranscript(messages: readonly AiMessage[], max = MAX_TRANSCRIPT): string {
  const entries: string[] = []
  for (const m of messages) {
    const body = m.role === 'user' ? userEntry(m) : assistantEntry(m)
    if (!body) continue
    entries.push(`${m.role === 'user' ? 'User' : 'Assistant'}:\n${clip(body, MAX_ENTRY)}`)
  }
  let size = 0
  let from = entries.length
  while (from > 0 && size + entries[from - 1].length + 2 <= max) size += entries[--from].length + 2
  // a single huge last entry still goes (cut)
  if (from === entries.length && entries.length) return clip(entries[entries.length - 1], max)
  return (from > 0 ? '[… earlier messages left out]\n\n' : '') + entries.slice(from).join('\n\n')
}
