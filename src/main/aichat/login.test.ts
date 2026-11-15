import { describe, expect, it } from 'vitest'
import { isAuthError, terminalCommandLine } from './login'

/**
 * How cmd.exe reads `cmd /s /c "<line>"`: the outer quote pair goes, then each `"` flips the quote
 * state and, outside quotes, `^` escapes the next character while & | < > end the command.
 * Returns the text cmd hands on, or throws where an unescaped metacharacter would split the command.
 */
function cmdParse(line: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && c === '^') {
      out += line[++i]
      continue
    } else if (!quoted && /[&|<>]/.test(c)) throw new Error(`command split at ${i}: ${line}`)
    out += c
  }
  return out
}

/** the argv the inner `cmd /k "<cmd>"` runs (it strips the first and last quote of <cmd>) */
function innerArgv(line: string): string[] {
  const prefix = '/d /s /c "'
  expect(line.startsWith(prefix) && line.endsWith('"')).toBe(true)
  const outer = cmdParse(line.slice(prefix.length, -1))
  const m = /^start "doplan" cmd \/k "(.*)"$/.exec(outer)
  expect(m).not.toBeNull()
  const inner = cmdParse(m![1])
  return [...inner.matchAll(/"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2])
}

describe('terminalCommandLine', () => {
  it('quotes the way cmd.exe expects (checked by hand: paths with spaces reach the CLI intact)', () => {
    expect(terminalCommandLine('C:\\Program Files\\nodejs\\node.exe', ['C:\\a b\\cli.js'], ['auth', 'login'])).toBe(
      '/d /s /c "start "doplan" cmd /k ""C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\cli.js" auth login""',
    )
  })
  it('keeps cmd metacharacters in paths from splitting the command', () => {
    const bin = 'C:\\Users\\R&D (x86)\\AppData\\Roaming\\npm\\node_modules\\a|b^c\\cli.exe'
    const pre = 'C:\\Users\\R&D\\x<y>.js'
    const line = terminalCommandLine(bin, [pre], ['auth', 'login'])!
    expect(innerArgv(line)).toEqual([bin, pre, 'auth', 'login'])
  })
  it('refuses what it cannot pass safely', () => {
    expect(terminalCommandLine('C:\\x"&calc.exe', [], ['login'])).toBeNull()
    expect(terminalCommandLine('C:\\%PATH%\\a.exe', [], ['login'])).toBeNull()
    expect(terminalCommandLine('C:\\a.exe', [], ['login & calc'])).toBeNull()
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
