/**
 * Minimal hand-rolled argument parser for the `dp` CLI.
 *
 *  - `--name value`, `--name=value`
 *  - boolean flags (listed in BOOLEAN_FLAGS, or a flag followed by another `--flag` / end of argv)
 *  - `--no-name` sets `name` to false
 *  - everything else is positional
 */
import { DpError } from './output'

export const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'h',
  'contrast',
  'gray',
  'open',
  'strict',
  'force',
  'underlay',
  'diff',
  'upscale',
  'inner',
  'write',
  'overwrite',
  'dims',
  'furniture',
])

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (body.startsWith('no-') && BOOLEAN_FLAGS.has(body.slice(3))) {
        flags[body.slice(3)] = false
        continue
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true
      } else {
        flags[body] = next
        i++
      }
      continue
    }
    if (tok === '-h') {
      flags.help = true
      continue
    }
    positional.push(tok)
  }
  return { positional, flags }
}

export class Args {
  constructor(readonly parsed: ParsedArgs) {}

  get json(): boolean {
    return this.parsed.flags.json === true
  }

  pos(i: number, what: string): string {
    const v = this.parsed.positional[i]
    if (v === undefined) throw new DpError(`missing argument: ${what}`)
    return v
  }

  optPos(i: number): string | undefined {
    return this.parsed.positional[i]
  }

  has(name: string): boolean {
    return this.parsed.flags[name] !== undefined
  }

  bool(name: string, def = false): boolean {
    const v = this.parsed.flags[name]
    if (v === undefined) return def
    if (typeof v === 'boolean') return v
    return !['0', 'false', 'no', 'off'].includes(v.toLowerCase())
  }

  str(name: string): string | undefined {
    const v = this.parsed.flags[name]
    if (v === undefined || typeof v === 'boolean') return undefined
    return v
  }

  req(name: string): string {
    const v = this.str(name)
    if (v === undefined) throw new DpError(`missing required option --${name}`)
    return v
  }

  num(name: string, def: number): number
  num(name: string): number | undefined
  num(name: string, def?: number): number | undefined {
    const v = this.str(name)
    if (v === undefined) return def
    const n = Number(v.replace(',', '.'))
    if (!Number.isFinite(n)) throw new DpError(`--${name} expects a number, got "${v}"`)
    return n
  }

  /** comma-separated list of numbers, e.g. --crop 10,20,300,400 */
  nums(name: string, count?: number): number[] | undefined {
    const v = this.str(name)
    if (v === undefined) return undefined
    return parseNumList(v, `--${name}`, count)
  }
}

export function parseNumList(v: string, what: string, count?: number): number[] {
  const parts = v
    .split(/[,;\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
  if (parts.some((n) => !Number.isFinite(n))) throw new DpError(`${what} expects numbers, got "${v}"`)
  if (count !== undefined && parts.length !== count) {
    throw new DpError(`${what} expects ${count} numbers, got ${parts.length} ("${v}")`)
  }
  return parts
}
