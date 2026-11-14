/**
 * Unit formatting and the small arithmetic expression evaluator used by NumberInput.
 * Lengths are stored in millimetres; they are displayed in mm / cm / m.
 */
export type LengthUnit = 'mm' | 'cm' | 'm'
export type NumberKind = 'length' | 'angle' | 'number' | 'percent'

export const MM_PER: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000 }

export const UNIT_LABEL: Record<LengthUnit, string> = { mm: 'мм', cm: 'см', m: 'м' }

/** trims trailing zeros of a fixed-point number, uses '.' as decimal separator */
export function fmtNum(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return ''
  const s = v.toFixed(Math.max(0, decimals))
  if (!s.includes('.')) return s === '-0' ? '0' : s
  const t = s.replace(/0+$/, '').replace(/\.$/, '')
  return t === '-0' ? '0' : t
}

export function defaultDecimals(kind: NumberKind, unit: LengthUnit): number {
  if (kind === 'length') return unit === 'mm' ? 1 : unit === 'cm' ? 2 : 4
  if (kind === 'angle') return 2
  if (kind === 'percent') return 1
  return 3
}

/** value in base units (mm, deg, plain, fraction) → value in display units */
export function toDisplay(v: number, kind: NumberKind, unit: LengthUnit): number {
  if (kind === 'length') return v / MM_PER[unit]
  if (kind === 'percent') return v * 100
  return v
}

export function fromDisplay(v: number, kind: NumberKind, unit: LengthUnit): number {
  if (kind === 'length') return v * MM_PER[unit]
  if (kind === 'percent') return v / 100
  return v
}

export function formatValue(v: number, kind: NumberKind, unit: LengthUnit, decimals?: number): string {
  return fmtNum(toDisplay(v, kind, unit), decimals ?? defaultDecimals(kind, unit))
}

/** formats a length in mm for read-only labels, e.g. "3 200 мм", "3.2 м" */
export function formatLength(mm: number, unit: LengthUnit): string {
  const d = toDisplay(mm, 'length', unit)
  const s = fmtNum(d, unit === 'mm' ? 0 : unit === 'cm' ? 1 : 3)
  return `${s} ${UNIT_LABEL[unit]}`
}

// ───────────────────────────── expression evaluator ─────────────────────────────

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string }

const UNIT_RE = /^(mm|мм|cm|см|m|м|°|deg|град|%)/i

function unitFactorToDisplay(u: string, kind: NumberKind, unit: LengthUnit): number {
  const l = u.toLowerCase()
  if (kind === 'length') {
    const mm = l === 'mm' || l === 'мм' ? 1 : l === 'cm' || l === 'см' ? 10 : l === 'm' || l === 'м' ? 1000 : NaN
    if (Number.isNaN(mm)) throw new Error(`unit ${u}`)
    return mm / MM_PER[unit]
  }
  if (kind === 'angle' && (l === '°' || l === 'deg' || l === 'град')) return 1
  if (kind === 'percent' && l === '%') return 1
  throw new Error(`unit ${u}`)
}

function tokenize(src: string, kind: NumberKind, unit: LengthUnit): Tok[] {
  const s = src.replace(/\s+/g, '').replace(/[×xх]/gi, '*').replace(/÷/g, '/').replace(/−/g, '-')
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if ('+-*/()'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)/.exec(s.slice(i))
    if (!m) throw new Error(`unexpected "${c}"`)
    let v = Number.parseFloat(m[1].replace(',', '.'))
    i += m[1].length
    const u = UNIT_RE.exec(s.slice(i))
    if (u) {
      v *= unitFactorToDisplay(u[1], kind, unit)
      i += u[1].length
    }
    out.push({ t: 'num', v })
  }
  return out
}

/**
 * Evaluates expressions like "3200+150", "1.2м + 15см", "(2400-100)/2", "2*1,5".
 * Literals without unit are in the display unit; literals with a unit are converted to it.
 * Returns the result in DISPLAY units, or null if invalid.
 */
export function evalExpression(src: string, kind: NumberKind, unit: LengthUnit): number | null {
  if (!src.trim()) return null
  let toks: Tok[]
  try {
    toks = tokenize(src, kind, unit)
  } catch {
    return null
  }
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => {
    const k = toks[p]
    return k !== undefined && k.t === 'op' && k.v === v
  }
  function primary(): number {
    const k = peek()
    if (!k) throw new Error('eof')
    if (k.t === 'num') {
      p++
      return k.v
    }
    if (k.v === '(') {
      p++
      const v = expr()
      if (!isOp(')')) throw new Error(')')
      p++
      return v
    }
    if (k.v === '-') {
      p++
      return -primary()
    }
    if (k.v === '+') {
      p++
      return primary()
    }
    throw new Error('bad')
  }
  function term(): number {
    let v = primary()
    while (isOp('*') || isOp('/')) {
      const op = (toks[p] as { v: string }).v
      p++
      const r = primary()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  function expr(): number {
    let v = term()
    while (isOp('+') || isOp('-')) {
      const op = (toks[p] as { v: string }).v
      p++
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  try {
    const v = expr()
    if (p !== toks.length || !Number.isFinite(v)) return null
    return v
  } catch {
    return null
  }
}

// ───────────────────────────── colour temperature ─────────────────────────────

/** approximate sRGB colour of a black body at `kelvin` (Tanner Helland fit), '#rrggbb' */
export function kelvinToHex(kelvin: number): string {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100
  let r: number
  let g: number
  let b: number
  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592
    g = 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255
  }
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}
