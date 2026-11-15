import { describe, expect, it } from 'vitest'
import { isAuthError } from './login'

describe('isAuthError', () => {
  it('recognises CLI credential failures', () => {
    expect(isAuthError('Failed to authenticate. API Error: 401 OAuth session expired and could not be refreshed')).toBe(true)
    expect(isAuthError('Invalid API key · Please run /login')).toBe(true)
    expect(isAuthError('Not logged in. Run `codex login`.')).toBe(true)
  })
  it('ignores ordinary failures', () => {
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError('Claude Code завершился с кодом 1:\nENOENT: no such file')).toBe(false)
    expect(isAuthError('model gpt-6.1-sol is not supported')).toBe(false)
  })
})
