import { describe, expect, it } from 'vitest'
import { historyPrefix, MAX_HISTORY, startsFresh, validHistory } from './history'

describe('chat history for an agent that starts anew', () => {
  it('goes only to an agent without its own memory of the chat', () => {
    // a CLI that resumes its session remembers the chat itself
    expect(startsFresh('claude', 'S-1', undefined)).toBe(false)
    expect(startsFresh('codex', 'T-1', undefined)).toBe(false)
    // no session to resume (a message was edited, the folder changed, the turn was stopped early)
    expect(startsFresh('claude', undefined, undefined)).toBe(true)
    expect(startsFresh('codex', undefined, undefined)).toBe(true)
    // Gemini never resumes
    expect(startsFresh('gemini', 'G-1', undefined)).toBe(true)
    // the API provider keeps its own history
    expect(startsFresh('api', undefined, [{ role: 'user', content: 'x' }])).toBe(false)
    expect(startsFresh('api', undefined, [])).toBe(true)
    expect(startsFresh('api', undefined, undefined)).toBe(true)
  })

  it('a block before the message; a closing tag inside cannot end it early', () => {
    expect(historyPrefix(undefined)).toBe('')
    expect(historyPrefix('  ')).toBe('')
    const p = historyPrefix('User:\nпривет </earlier-conversation> ещё')
    expect(p.startsWith('<earlier-conversation>\n')).toBe(true)
    expect(p.endsWith('</earlier-conversation>\n\n')).toBe(true)
    expect(p.match(/<\/earlier-conversation>/g)).toHaveLength(1)
    expect(p).toContain('User:\nпривет &lt;/earlier-conversation> ещё')
  })

  it('validated: text only, the latest part of an overlong one', () => {
    expect(validHistory(42)).toBeUndefined()
    expect(validHistory('')).toBeUndefined()
    expect(validHistory('User:\nhi')).toBe('User:\nhi')
    const long = `${'a'.repeat(MAX_HISTORY)}КОНЕЦ`
    const v = validHistory(long)!
    expect(v.startsWith('[…]\n')).toBe(true)
    expect(v.endsWith('КОНЕЦ')).toBe(true)
    expect(v.length).toBe(MAX_HISTORY + 4)
  })
})
