/** Result / error conventions shared by all `dp` commands. */

export class DpError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'DpError'
  }
}

export interface CommandResult {
  /** machine-readable payload (printed as one JSON object with --json) */
  data: Record<string, unknown>
  /** concise human/agent-friendly lines (default output) */
  text?: string[]
  exitCode?: number
}

export function printResult(res: CommandResult, json: boolean): void {
  if (json || !res.text || res.text.length === 0) {
    process.stdout.write(`${JSON.stringify(res.data, null, json ? 2 : 0)}\n`)
  } else {
    process.stdout.write(`${res.text.join('\n')}\n`)
  }
}

export function printError(err: unknown, json: boolean): number {
  const isDp = err instanceof DpError
  const message = err instanceof Error ? err.message : String(err)
  const hint = isDp ? err.hint : undefined
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...(hint ? { hint } : {}) }, null, 2)}\n`)
  } else {
    process.stderr.write(`error: ${message}\n${hint ? `hint: ${hint}\n` : ''}`)
    if (!isDp && err instanceof Error && err.stack && process.env.DP_DEBUG) process.stderr.write(`${err.stack}\n`)
  }
  return isDp ? err.exitCode : 2
}

export const r1 = (n: number): number => Math.round(n * 10) / 10
export const r2 = (n: number): number => Math.round(n * 100) / 100
export const r3 = (n: number): number => Math.round(n * 1000) / 1000
export const r4 = (n: number): number => Math.round(n * 10000) / 10000

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
