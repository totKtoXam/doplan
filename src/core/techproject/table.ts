/**
 * Tables on sheets (ведомости, спецификации, экспликация, условные обозначения) in paper mm.
 * A table is laid out with word wrap; `splitTable` cuts a long table into pieces that fit a height
 * (the header repeats on every piece).
 */
import type { DisplayItem, DlFill, DlPen } from '../display'
import type { Vec2 } from '../types'
import { INK, THICK, THIN, text, textWidth, wrapText } from './paper'

export interface TableColumn {
  title: string
  /** paper mm */
  width: number
  align?: 'start' | 'middle' | 'end'
}

/** A legend swatch drawn in a cell instead of (or before) its text. */
export type TableSwatch =
  | { kind: 'fill'; fill: DlFill; stroke?: DlPen }
  | { kind: 'line'; stroke: DlPen }
  | { kind: 'items'; items: DisplayItem[] } // paper mm, centred on (0, 0), fitting 8 × 4 mm

export interface TableCell {
  text: string
  swatch?: TableSwatch
  bold?: boolean
}

export type TableRow = (string | TableCell)[]

export interface Table {
  title?: string
  columns: TableColumn[]
  rows: TableRow[]
  /** text size, mm (default 2.5) */
  size?: number
  /** bold summary rows at the end (Итого) */
  footer?: TableRow[]
}

const PAD_X = 1.2
const HEAD_MIN = 8
const ROW_MIN = 6

export function tableWidth(t: Table): number {
  return t.columns.reduce((s, c) => s + c.width, 0)
}

const cellOf = (c: string | TableCell | undefined): TableCell => (typeof c === 'string' ? { text: c } : (c ?? { text: '' }))

interface Laid {
  lines: string[][]
  height: number
}

function layRow(t: Table, row: TableRow, size: number, minH: number): Laid {
  const lh = size * 1.3
  const lines = t.columns.map((col, i) => {
    const c = cellOf(row[i])
    const avail = col.width - 2 * PAD_X - (c.swatch ? 10 : 0)
    return c.text ? wrapText(c.text, size, Math.max(2, avail)) : ['']
  })
  const n = Math.max(1, ...lines.map((l) => l.length))
  return { lines, height: Math.max(minH, n * lh + 2.2) }
}

export function titleHeight(t: Table): number {
  return t.title ? 6 : 0
}

/** total height of a table, mm */
export function tableHeight(t: Table): number {
  const size = t.size ?? 2.5
  const head = layRow(t, t.columns.map((c) => c.title), size * 0.9, HEAD_MIN).height
  let h = titleHeight(t) + head
  for (const r of t.rows) h += layRow(t, r, size, ROW_MIN).height
  for (const r of t.footer ?? []) h += layRow(t, r, size, ROW_MIN).height
  return h
}

/**
 * Splits a table into pieces of at most `firstH` (first piece) / `nextH` (others) mm, header
 * repeated. The title stays on the first piece; the footer goes to the last one.
 */
export function splitTable(t: Table, firstH: number, nextH = firstH): Table[] {
  const size = t.size ?? 2.5
  const head = layRow(t, t.columns.map((c) => c.title), size * 0.9, HEAD_MIN).height
  const footH = (t.footer ?? []).reduce((s, r) => s + layRow(t, r, size, ROW_MIN).height, 0)
  const pieces: Table[] = []
  let cur: TableRow[] = []
  let used = titleHeight(t) + head
  let limit = firstH
  const flush = () => {
    pieces.push({ ...t, title: pieces.length ? (t.title ? `${t.title} (продолжение)` : undefined) : t.title, rows: cur, footer: undefined })
    cur = []
    used = head + (t.title ? titleHeight(t) : 0)
    limit = nextH
  }
  t.rows.forEach((r) => {
    const h = layRow(t, r, size, ROW_MIN).height
    if (cur.length && used + h > limit) flush()
    cur.push(r)
    used += h
  })
  if (footH && cur.length && used + footH > limit) flush()
  pieces.push({ ...t, title: pieces.length ? (t.title ? `${t.title} (продолжение)` : undefined) : t.title, rows: cur, footer: t.footer })
  return pieces
}

function swatchItems(s: TableSwatch, c: Vec2): DisplayItem[] {
  const w = 8
  const h = 4
  if (s.kind === 'fill') {
    return [
      {
        t: 'poly',
        layer: 'sheet',
        role: 'legend',
        pts: [
          { x: c.x - w / 2, y: c.y - h / 2 },
          { x: c.x + w / 2, y: c.y - h / 2 },
          { x: c.x + w / 2, y: c.y + h / 2 },
          { x: c.x - w / 2, y: c.y + h / 2 },
        ],
        closed: true,
        fill: s.fill,
        stroke: s.stroke ?? THIN,
      },
    ]
  }
  if (s.kind === 'line') return [{ t: 'line', layer: 'sheet', role: 'legend', a: { x: c.x - w / 2, y: c.y }, b: { x: c.x + w / 2, y: c.y }, stroke: s.stroke }]
  return s.items.map((it) => translateItem(it, c.x, c.y))
}

export function translateItem(it: DisplayItem, dx: number, dy: number): DisplayItem {
  const P = (p: Vec2) => ({ x: p.x + dx, y: p.y + dy })
  switch (it.t) {
    case 'poly':
      return { ...it, pts: it.pts.map(P), holes: it.holes?.map((h) => h.map(P)) }
    case 'line':
      return { ...it, a: P(it.a), b: P(it.b) }
    case 'arc':
    case 'circle':
      return { ...it, c: P(it.c) }
    case 'text':
      return { ...it, p: P(it.p) }
  }
}

/** Draws a table with its top-left corner at (x, y). */
export function drawTable(t: Table, x: number, y: number): DisplayItem[] {
  const items: DisplayItem[] = []
  const size = t.size ?? 2.5
  const W = tableWidth(t)
  let cy = y
  if (t.title) {
    items.push(text({ x, y: cy + 3 }, t.title, 3, { bold: true, role: 'table' }))
    cy += titleHeight(t)
  }
  const top = cy
  const colX: number[] = [x]
  for (const c of t.columns) colX.push(colX[colX.length - 1] + c.width)
  const rowLines: number[] = []
  const drawRow = (row: TableRow, sz: number, minH: number, bold: boolean) => {
    const laid = layRow(t, row, sz, minH)
    const lh = sz * 1.3
    t.columns.forEach((col, i) => {
      const c = cellOf(row[i])
      const lines = laid.lines[i]
      const block = lines.length * lh
      let tx0 = colX[i] + PAD_X
      if (c.swatch) {
        items.push(...swatchItems(c.swatch, { x: colX[i] + PAD_X + 4, y: cy + laid.height / 2 }))
        tx0 += 10
      }
      const align = bold && !row[i] ? 'start' : (col.align ?? 'start')
      lines.forEach((s, k) => {
        const ty = cy + (laid.height - block) / 2 + lh * (k + 0.5)
        const tx = align === 'start' ? tx0 : align === 'end' ? colX[i + 1] - PAD_X : (tx0 + colX[i + 1]) / 2
        if (s) items.push(text({ x: tx, y: ty }, s, sz, { anchor: align, bold: bold || c.bold, role: 'table' }))
      })
    })
    cy += laid.height
    rowLines.push(cy)
  }
  drawRow(
    t.columns.map((c) => c.title),
    size * 0.9,
    HEAD_MIN,
    false,
  )
  const headBottom = cy
  for (const r of t.rows) drawRow(r, size, ROW_MIN, false)
  for (const r of t.footer ?? []) drawRow(r, size, ROW_MIN, true)
  // grid
  const pen = THIN
  items.push({ t: 'poly', layer: 'sheet', role: 'table', pts: [{ x, y: top }, { x: x + W, y: top }, { x: x + W, y: cy }, { x, y: cy }], closed: true, stroke: THICK })
  items.push({ t: 'line', layer: 'sheet', role: 'table', a: { x, y: headBottom }, b: { x: x + W, y: headBottom }, stroke: THICK })
  for (const ly of rowLines.slice(1, -1)) items.push({ t: 'line', layer: 'sheet', role: 'table', a: { x, y: ly }, b: { x: x + W, y: ly }, stroke: pen })
  for (const cx of colX.slice(1, -1)) items.push({ t: 'line', layer: 'sheet', role: 'table', a: { x: cx, y: top }, b: { x: cx, y: cy }, stroke: pen })
  return items
}

/** A paragraph block of notes («Общие указания»), wrapped to `width`. Returns items and height. */
export function drawNotes(title: string | undefined, lines: string[], x: number, y: number, width: number, size = 2.6): { items: DisplayItem[]; height: number } {
  const items: DisplayItem[] = []
  let cy = y
  if (title) {
    items.push(text({ x, y: cy + 3 }, title, 3, { bold: true, role: 'notes' }))
    cy += 6
  }
  const lh = size * 1.35
  lines.forEach((s, i) => {
    const num = `${i + 1}. `
    const indent = textWidth(num, size)
    const wrapped = wrapText(s, size, width - indent)
    wrapped.forEach((w, k) => {
      if (k === 0) items.push(text({ x, y: cy + lh / 2 }, num, size, { role: 'notes', color: INK }))
      items.push(text({ x: x + indent, y: cy + lh / 2 }, w, size, { role: 'notes' }))
      cy += lh
    })
    cy += 0.8
  })
  return { items, height: cy - y }
}

export function notesHeight(title: string | undefined, lines: string[], width: number, size = 2.6): number {
  return drawNotes(title, lines, 0, 0, width, size).height
}
