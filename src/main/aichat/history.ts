/**
 * The chat's earlier turns for an agent that starts without a session of its own: the user edited an
 * earlier message (the chat goes on from there, the old session would remember the cut turns), the
 * session was never kept (a turn stopped before the agent reported it, another provider ran before),
 * or the folder changed. The text comes from the renderer (chatTranscript) and is put before the message.
 */

export const MAX_HISTORY = 60_000

export function validHistory(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  // the start is what goes: the turns right before the message matter most
  return raw.length > MAX_HISTORY ? `[…]\n${raw.slice(raw.length - MAX_HISTORY)}` : raw
}

export function historyPrefix(history: string | undefined): string {
  const h = history?.trim()
  if (!h) return ''
  // a closing tag inside the transcript must not end the block early
  const quoted = h.replace(/<(\/?)earlier-conversation/gi, '&lt;$1earlier-conversation')
  return (
    '<earlier-conversation>\n' +
    'The conversation so far in this chat (your earlier session is not continued: the user may have edited a message, ' +
    'so this is the history as it stands now). Take it as context only; the plan may have changed since — read it with the tools.\n\n' +
    `${quoted}\n</earlier-conversation>\n\n`
  )
}

/**
 * Whether the agent starts without its own memory of the chat and needs the history: the API provider
 * without kept messages, a CLI without a session to resume (Gemini never resumes).
 */
export function startsFresh(provider: string, resumeId: string | undefined, apiHistory: unknown[] | undefined): boolean {
  if (provider === 'api') return !apiHistory?.length
  if (provider === 'gemini') return true
  return !resumeId
}
