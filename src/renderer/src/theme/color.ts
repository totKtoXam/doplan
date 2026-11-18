/** Small colour helpers for themes: CSS hex strings in, CSS hex strings out. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → channels 0..255 and alpha 0..1; undefined if not a hex colour */
export function parseColor(s: unknown): Rgba | undefined {
  if (typeof s !== 'string') return undefined
  let h = s.trim()
  if (!h.startsWith('#')) return undefined
  h = h.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return undefined
  if (!/^[0-9a-f]+$/i.test(h)) return undefined
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')

export function toHex(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
}

/** a colour over a solid background (drops the alpha) */
export function flatten(color: string, over: string): string {
  const c = parseColor(color)
  const o = parseColor(over)
  if (!c) return over
  if (!o || c.a >= 1) return toHex(c)
  return toHex({ r: o.r + (c.r - o.r) * c.a, g: o.g + (c.g - o.g) * c.a, b: o.b + (c.b - o.b) * c.a, a: 1 })
}

/** a + (b − a)·t */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return a
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 })
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color)
  if (!c) return color
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${+alpha.toFixed(3)})`
}

/** WCAG relative luminance 0..1 */
export function luminance(color: string): number {
  const c = parseColor(color)
  if (!c) return 0
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** WCAG contrast ratio 1..21 */
export function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** of two candidates, the one that reads better on `bg` */
export function readableOn(bg: string, light = '#ffffff', dark = '#111111'): string {
  return contrast(bg, light) >= contrast(bg, dark) ? light : dark
}

/** `#rrggbb` → 0xRRGGBB for Pixi */
export function toNumber(color: string): number {
  const c = parseColor(color)
  return c ? (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b) : 0
}

export function fromNumber(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}
