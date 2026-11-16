/** Colour palettes of the 2D editor (numbers are 0xRRGGBB). */
export interface Palette {
  bg: number
  gridMinor: number
  gridMajor: number
  gridMinorAlpha: number
  gridMajorAlpha: number
  axisX: number
  axisY: number
  /** colour painted into opening gaps */
  gap: number
  wall: number
  partition: number
  parapet: number
  wallStroke: number
  glazing: number
  virtual: number
  roomDefault: number
  /** how much of the floor material colour shows through (0..1) */
  roomMix: number
  roomPattern: number
  roomPatternAlpha: number
  opening: number
  glass: number
  curtain: number
  itemFill: number
  itemFillAlpha: number
  itemStroke: number
  itemSketch: number
  text: number
  textMuted: number
  dim: number
  dimAuto: number
  accent: number
  hover: number
  danger: number
  ok: number
  /** amber: needs checking (stale / unmeasured dimensions) */
  warn: number
  guide: number
  badgeBg: number
  badgeText: number
  lightOn: number
  lightOff: number
  /** electrical points (sockets, switches, low-voltage) */
  electric: number
  handleFill: number
  handleStroke: number
  camera: number
  underlayFrame: number
}

export const DARK: Palette = {
  bg: 0x1b1d22,
  gridMinor: 0xffffff,
  gridMajor: 0xffffff,
  gridMinorAlpha: 0.035,
  gridMajorAlpha: 0.085,
  axisX: 0xd9534f,
  axisY: 0x4caf7a,
  gap: 0x1b1d22,
  wall: 0xc8cdd6,
  partition: 0x8b93a1,
  parapet: 0x596170,
  wallStroke: 0xeef1f5,
  glazing: 0x56b6ff,
  virtual: 0x8b93a1,
  roomDefault: 0x2a2e36,
  roomMix: 0.42,
  roomPattern: 0xffffff,
  roomPatternAlpha: 0.07,
  opening: 0xe6e9ee,
  glass: 0x6cc4ff,
  curtain: 0xc79bff,
  itemFill: 0x7f8aa0,
  itemFillAlpha: 0.22,
  itemStroke: 0xaab3c5,
  itemSketch: 0x8e98ab,
  text: 0xe8ebf0,
  textMuted: 0x9aa3b2,
  dim: 0xd0d5de,
  dimAuto: 0x7c8696,
  accent: 0x4c9dff,
  hover: 0x8fc2ff,
  danger: 0xff5d5d,
  ok: 0x4cd08a,
  warn: 0xffb547,
  guide: 0xff4fd8,
  badgeBg: 0x10131a,
  badgeText: 0xffffff,
  lightOn: 0xffd45e,
  lightOff: 0x7a8291,
  electric: 0xff8a7a,
  handleFill: 0xffffff,
  handleStroke: 0x4c9dff,
  camera: 0xffa53c,
  underlayFrame: 0x6d7686,
}

export const LIGHT: Palette = {
  bg: 0xf3f4f6,
  gridMinor: 0x000000,
  gridMajor: 0x000000,
  gridMinorAlpha: 0.045,
  gridMajorAlpha: 0.11,
  axisX: 0xd9534f,
  axisY: 0x2e9c63,
  gap: 0xffffff,
  wall: 0x3b4049,
  partition: 0x8a919d,
  parapet: 0xc3c8d0,
  wallStroke: 0x15181d,
  glazing: 0x1f8fe5,
  virtual: 0x7a828f,
  roomDefault: 0xffffff,
  roomMix: 0.5,
  roomPattern: 0x000000,
  roomPatternAlpha: 0.08,
  opening: 0x20242b,
  glass: 0x1f8fe5,
  curtain: 0x8e55d9,
  itemFill: 0x5d6b85,
  itemFillAlpha: 0.14,
  itemStroke: 0x4a5568,
  itemSketch: 0x6b7689,
  text: 0x1b1f26,
  textMuted: 0x5f6875,
  dim: 0x2b3038,
  dimAuto: 0x7a828f,
  accent: 0x1a73e8,
  hover: 0x5a9df0,
  danger: 0xe03131,
  ok: 0x1f9d57,
  warn: 0xc76a00,
  guide: 0xd61fb0,
  badgeBg: 0x1d2129,
  badgeText: 0xffffff,
  lightOn: 0xe8a600,
  lightOff: 0x8a919d,
  electric: 0xc62828,
  handleFill: 0xffffff,
  handleStroke: 0x1a73e8,
  camera: 0xe07b00,
  underlayFrame: 0x8a919d,
}

export function paletteFor(theme: 'dark' | 'light'): Palette {
  return theme === 'light' ? LIGHT : DARK
}

export function parseHex(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  let h = s.trim()
  if (h.startsWith('#')) h = h.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length >= 6) {
    const n = Number.parseInt(h.slice(0, 6), 16)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

export function multiplyColor(a: number, b: number): number {
  const r = Math.round((((a >> 16) & 255) * ((b >> 16) & 255)) / 255)
  const g = Math.round((((a >> 8) & 255) * ((b >> 8) & 255)) / 255)
  const bl = Math.round(((a & 255) * (b & 255)) / 255)
  return (r << 16) | (g << 8) | bl
}

export function luminance(c: number): number {
  return (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255
}

export function cssColor(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}
