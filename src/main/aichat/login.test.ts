import { describe, expect, it } from 'vitest'
import { isAuthError, terminalCommandLine } from './login'

describe('terminalCommandLine', () => {
  it('quotes the way cmd.exe expects (checked by hand: paths with spaces reach the CLI intact)', () => {
    expect(terminalCommandLine('C:\\Program Files\\nodejs\\node.exe', ['C:\\a b\\cli.js'], ['auth', 'login'])).toBe(
      '/d /s /c "start "doplan" cmd /k ""C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\cli.js" auth login""',
    )
    // a quote inside a path can not break out
    expect(terminalCommandLine('C:\\x"&calc.exe', [], ['login'])).toContain('"C:\\x&calc.exe" login')
  })
})

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
