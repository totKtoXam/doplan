/**
 * Sheet paper of the technical project album: formats, the drawing frame and the title block
 * (основная надпись, форма 3 ГОСТ Р 21.101 — упрощённая, без граф подписей с личными данными по умолчанию).
 *
 * Everything here is in PAPER millimetres (page origin at the top-left corner, y down); the page
 * display list has `scale: 1`, so pen widths and text sizes are paper millimetres too.
 * Pure TS.
 */
import type { DisplayItem, DlPen } from '../display'
import type { Vec2 } from '../types'

export type PaperFormat = 'A4' | 'A3' | 'A2'
export type PaperOrientation = 'landscape' | 'portrait'

const FORMAT_MM: Record<PaperFormat, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
}

export interface PaperSize {
  width: number
  height: number
}

export function paperSize(format: PaperFormat, orientation: PaperOrientation): PaperSize {
  const [a, b] = FORMAT_MM[format]
  return orientation === 'landscape' ? { width: b, height: a } : { width: a, height: b }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** frame margins (ГОСТ 21.101: 20 мм слева под подшивку, 5 мм с остальных сторон) */
export const FRAME_MARGIN = { left: 20, top: 5, right: 5, bottom: 5 } as const
/** основная надпись, форма 3 */
export const STAMP_W = 185
export const STAMP_H = 55

export function frameRect(paper: PaperSize): Rect {
  const m = FRAME_MARGIN
  return { x: m.left, y: m.top, w: paper.width - m.left - m.right, h: paper.height - m.top - m.bottom }
}

export function stampRect(paper: PaperSize): Rect {
  const f = frameRect(paper)
  return { x: f.x + f.w - STAMP_W, y: f.y + f.h - STAMP_H, w: STAMP_W, h: STAMP_H }
}

/** What goes into the title block. Personal data (names) are empty by default. */
export interface StampInfo {
  /** обозначение документа, e.g. «2026-11-ДП» */
  code: string
  /** наименование объекта (project) */
  object: string
  /** наименование листа */
  sheetTitle: string
  /** стадия: П, РП, Р, ЭП… */
  stage: string
  sheet: number
  sheets: number
  /** ISO date or free text */
  date: string
  /** organisation / studio (empty by default) */
  organization?: string
  /** «Разработал» (empty by default) */
  author?: string
  /** «Проверил» (empty by default) */
  checker?: string
  /** «Формат А3» under the frame */
  format?: string
}

export const INK = '#111111'
export const THIN: DlPen = { color: INK, width: 0.25 }
export const THICK: DlPen = { color: INK, width: 0.6 }

const V = (x: number, y: number): Vec2 => ({ x, y })

export function rectPoly(r: Rect, pen: DlPen, role = 'frame'): DisplayItem {
  return {
    t: 'poly',
    layer: 'sheet',
    role,
    pts: [V(r.x, r.y), V(r.x + r.w, r.y), V(r.x + r.w, r.y + r.h), V(r.x, r.y + r.h)],
    closed: true,
    stroke: pen,
  }
}

export function line(a: Vec2, b: Vec2, pen: DlPen = THIN, role = 'stamp'): DisplayItem {
  return { t: 'line', layer: 'sheet', role, a, b, stroke: pen }
}

export function text(
  p: Vec2,
  s: string,
  size: number,
  opts: { anchor?: 'start' | 'middle' | 'end'; bold?: boolean; role?: string; color?: string; rot?: number } = {},
): DisplayItem {
  return {
    t: 'text',
    layer: 'sheet',
    role: opts.role ?? 'stamp',
    p,
    text: s,
    size,
    rot: opts.rot ?? 0,
    anchor: opts.anchor ?? 'start',
    baseline: 'middle',
    color: opts.color ?? INK,
    bold: opts.bold,
  }
}

/** average glyph width of the sheet font, as a fraction of the size (matches display.estimateTextWidth) */
export const GLYPH = 0.56

export function textWidth(s: string, size: number): number {
  return s.length * size * GLYPH
}

/** shrinks `size` until `s` fits `maxW` (not below `min`) */
export function fitSize(s: string, size: number, maxW: number, min = 1.6): number {
  const w = textWidth(s, size)
  if (w <= maxW) return size
  return Math.max(min, (size * maxW) / Math.max(1e-6, w))
}

/** cuts `s` with an ellipsis so that it fits `maxW` at `size` */
export function ellipsize(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  const n = Math.max(1, Math.floor(maxW / (size * GLYPH)) - 1)
  return `${s.slice(0, n).trimEnd()}…`
}

/** Word-wraps `s` into lines no wider than `maxW` at `size`. */
export function wrapText(s: string, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of s.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (textWidth(next, size) <= maxW || !cur) {
        cur = next
        // a single word longer than the line: hard-cut it
        while (textWidth(cur, size) > maxW && cur.length > 1) {
          const n = Math.max(1, Math.floor(maxW / (size * GLYPH)))
          out.push(cur.slice(0, n))
          cur = cur.slice(n)
        }
      } else {
        out.push(cur)
        cur = w
      }
    }
    out.push(cur)
  }
  return out
}

/** The frame of a sheet (outer trim is not drawn: the page edge is the trim line). */
export function drawFrame(paper: PaperSize): DisplayItem[] {
  return [rectPoly(frameRect(paper), THICK, 'frame')]
}

/**
 * Основная надпись (форма 3), 185 × 55 мм:
 *
 *   ┌──┬──┬──┬──┬───┬──┬──────────────────────────────────────┐
 *   │изменения (3 строки по 5)       │ обозначение (15)                     │
 *   ├────────────────────────────────┼──────────────────────────────────────┤
 *   │Разраб. / Пров. / … (5 строк)   │ наименование объекта (15)            │
 *   │                                ├─────────────────┬──────┬─────┬───────┤
 *   │                                │ наименование    │Стадия│Лист │Листов │
 *   │                                │ листа (25)      ├──────┼─────┼───────┤
 *   │                                │                 │ организация (15)   │
 *   └────────────────────────────────┴─────────────────┴────────────────────┘
 */
export function drawStamp(paper: PaperSize, info: StampInfo): DisplayItem[] {
  const r = stampRect(paper)
  const items: DisplayItem[] = []
  const X = (dx: number) => r.x + dx
  const Y = (dy: number) => r.y + dy
  items.push(rectPoly(r, THICK, 'stamp'))
  // left block: 10 | 10 | 10 | 10 | 15 | 10 = 65; right block 120
  const cols = [0, 10, 20, 30, 40, 55, 65]
  const L = 65
  // horizontal rows in the left block every 5 mm
  for (let i = 1; i < 11; i++) items.push(line(V(X(0), Y(i * 5)), V(X(L), Y(i * 5)), i === 3 ? THICK : THIN))
  // verticals of the left block: change table columns over the top 3 rows, then name columns
  for (const c of cols.slice(1, -1)) items.push(line(V(X(c), Y(0)), V(X(c), Y(15)), THIN))
  items.push(line(V(X(20), Y(15)), V(X(20), Y(55)), THIN))
  items.push(line(V(X(40), Y(15)), V(X(40), Y(55)), THIN))
  items.push(line(V(X(55), Y(15)), V(X(55), Y(55)), THIN))
  items.push(line(V(X(L), Y(0)), V(X(L), Y(55)), THICK))
  const hdr = 1.8
  const hdrRow = 12.5
  const heads = ['Изм.', 'Кол.уч', 'Лист', '№ док.', 'Подп.', 'Дата']
  heads.forEach((h, i) => items.push(text(V(X((cols[i] + cols[i + 1]) / 2), Y(hdrRow)), h, hdr, { anchor: 'middle' })))
  const roles: [string, string | undefined][] = [
    ['Разраб.', info.author],
    ['Пров.', info.checker],
    ['', undefined],
    ['Н. контр.', undefined],
    ['Утв.', undefined],
  ]
  const date = info.date
  roles.forEach(([role, name], i) => {
    const y = Y(15 + i * 5 + 2.5)
    if (role) items.push(text(V(X(1), y), role, hdr))
    if (name) items.push(text(V(X(21), y), ellipsize(name, 2, 18.5), 2))
    if (i === 0 && date) items.push(text(V(X(60), y), formatStampDate(date), 1.6, { anchor: 'middle' }))
  })
  // right block
  const R0 = L
  const RW = 120
  items.push(line(V(X(R0), Y(15)), V(X(R0 + RW), Y(15)), THICK))
  items.push(line(V(X(R0), Y(30)), V(X(R0 + RW), Y(30)), THICK))
  // code
  items.push(text(V(X(R0 + RW / 2), Y(7.5)), info.code, fitSize(info.code, 5, RW - 6), { anchor: 'middle', bold: true }))
  // object name (up to 2 lines)
  {
    const size = 3
    const lines = wrapText(info.object, size, RW - 6).slice(0, 2)
    const y0 = Y(22.5) - ((lines.length - 1) * size * 1.3) / 2
    lines.forEach((s, i) => items.push(text(V(X(R0 + RW / 2), y0 + i * size * 1.3), ellipsize(s, size, RW - 6), size, { anchor: 'middle' })))
  }
  // sheet title (left 70 × 25) + stage / sheet / sheets + organisation
  const TW = 70
  items.push(line(V(X(R0 + TW), Y(30)), V(X(R0 + TW), Y(55)), THICK))
  {
    const size = 3.2
    const lines = wrapText(info.sheetTitle, size, TW - 5).slice(0, 4)
    const y0 = Y(42.5) - ((lines.length - 1) * size * 1.3) / 2
    lines.forEach((s, i) => items.push(text(V(X(R0 + TW / 2), y0 + i * size * 1.3), ellipsize(s, size, TW - 5), size, { anchor: 'middle' })))
  }
  const S0 = R0 + TW
  const sc = [S0, S0 + 15, S0 + 30, S0 + 50]
  items.push(line(V(X(S0), Y(35)), V(X(S0 + 50), Y(35)), THIN))
  items.push(line(V(X(S0), Y(40)), V(X(S0 + 50), Y(40)), THICK))
  items.push(line(V(X(sc[1]), Y(30)), V(X(sc[1]), Y(40)), THIN))
  items.push(line(V(X(sc[2]), Y(30)), V(X(sc[2]), Y(40)), THIN))
  const sh = ['Стадия', 'Лист', 'Листов']
  sh.forEach((h, i) => items.push(text(V(X((sc[i] + sc[i + 1]) / 2), Y(32.5)), h, hdr, { anchor: 'middle' })))
  const vals = [info.stage, String(info.sheet), String(info.sheets)]
  vals.forEach((v, i) => items.push(text(V(X((sc[i] + sc[i + 1]) / 2), Y(37.5)), v, 2.6, { anchor: 'middle' })))
  if (info.organization) {
    const size = 2.8
    const lines = wrapText(info.organization, size, 46).slice(0, 3)
    const y0 = Y(47.5) - ((lines.length - 1) * size * 1.3) / 2
    lines.forEach((s, i) => items.push(text(V(X(S0 + 25), y0 + i * size * 1.3), ellipsize(s, size, 46), size, { anchor: 'middle' })))
  }
  if (info.format) {
    const f = frameRect(paper)
    items.push(text(V(f.x + f.w, f.y + f.h + 2.6), info.format, 2, { anchor: 'end', role: 'frame' }))
  }
  return items
}

/** «2026-11-21» → «11.26» (графа «Дата» основной надписи: месяц и год) */
export function formatStampDate(date: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date)
  if (!m) return date.slice(0, 8)
  return `${m[2]}.${m[1].slice(2)}`
}

/** «2026-11-21» → «21.11.2026» */
export function formatRuDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : date
}
