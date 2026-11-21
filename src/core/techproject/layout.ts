/**
 * Placing a drawing and its tables on a sheet.
 *
 * A drawing is built in WORLD millimetres for a given scale (annotation sizes depend on it, as in
 * core/display); the layout picks the largest scale (smallest 1:S) at which the drawing and its
 * blocks (legend, schedules, notes) fit the sheet next to the title block, and maps the drawing to
 * paper millimetres.
 */
import type { DisplayBounds, DisplayItem } from '../display'
import { displayListBounds } from '../display'
import type { Vec2 } from '../types'
import { frameRect, type PaperSize, type Rect, stampRect, text } from './paper'
import { drawNotes, drawTable, notesHeight, splitTable, type Table, tableHeight, tableWidth, translateItem } from './table'

export type SheetBlock = { kind: 'table'; table: Table } | { kind: 'notes'; title?: string; lines: string[]; width?: number } | { kind: 'items'; items: DisplayItem[]; w: number; h: number }

export function blockSize(b: SheetBlock): { w: number; h: number } {
  if (b.kind === 'table') return { w: tableWidth(b.table), h: tableHeight(b.table) }
  if (b.kind === 'notes') {
    const w = b.width ?? 180
    return { w, h: notesHeight(b.title, b.lines, w) }
  }
  return { w: b.w, h: b.h }
}

export function drawBlock(b: SheetBlock, x: number, y: number): DisplayItem[] {
  if (b.kind === 'table') return drawTable(b.table, x, y)
  if (b.kind === 'notes') return drawNotes(b.title, b.lines, x, y, b.width ?? 180).items
  return b.items.map((it) => translateItem(it, x, y))
}

/** World → paper: p / S + offset; text sizes and radii scale with 1/S, pens are paper mm already. */
export function toPaper(items: DisplayItem[], S: number, dx: number, dy: number): DisplayItem[] {
  const P = (p: Vec2): Vec2 => ({ x: p.x / S + dx, y: p.y / S + dy })
  return items.map((it): DisplayItem => {
    switch (it.t) {
      case 'poly':
        return { ...it, pts: it.pts.map(P), holes: it.holes?.map((h) => h.map(P)) }
      case 'line':
        return { ...it, a: P(it.a), b: P(it.b) }
      case 'arc':
        return { ...it, c: P(it.c), r: it.r / S }
      case 'circle':
        return { ...it, c: P(it.c), r: it.r / S }
      case 'text':
        return { ...it, p: P(it.p), size: it.size / S }
    }
  })
}

export function boundsOfItems(items: DisplayItem[]): DisplayBounds {
  return displayListBounds({ items, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, scale: 1, theme: 'light', background: '#fff' })
}

/** inner working area of the frame (padding from the frame line) */
export function workArea(paper: PaperSize, pad = 4): Rect {
  const f = frameRect(paper)
  return { x: f.x + pad, y: f.y + pad, w: f.w - 2 * pad, h: f.h - 2 * pad }
}

interface Placement {
  plan: Rect
  blocks: Rect
  /** how the blocks flow in their region */
  flow: 'columns' | 'rows'
}

function layouts(paper: PaperSize, blocksW: number, blocksH: number): Placement[] {
  const wa = workArea(paper)
  const st = stampRect(paper)
  const gap = 5
  const out: Placement[] = []
  const aboveStamp = st.y - gap - wa.y
  const leftOfStamp = st.x - gap - wa.x
  const bottom = wa.y + wa.h
  // A: drawing over the full width above the title block; blocks in the strip left of it
  out.push({ plan: { x: wa.x, y: wa.y, w: wa.w, h: aboveStamp }, blocks: { x: wa.x, y: st.y, w: leftOfStamp, h: bottom - st.y }, flow: 'rows' })
  // B: drawing left; blocks in a column right, above the title block
  if (blocksW > 0 && blocksW <= st.w + 0.01) {
    const colX = wa.x + wa.w - Math.max(blocksW, 0)
    out.push({ plan: { x: wa.x, y: wa.y, w: colX - gap - wa.x, h: wa.h }, blocks: { x: colX, y: wa.y, w: wa.x + wa.w - colX, h: aboveStamp }, flow: 'columns' })
  }
  // C: blocks in a band above the title block (full width), drawing above them
  if (blocksH > 0) {
    const bandH = Math.min(blocksH, aboveStamp * 0.6)
    out.push({ plan: { x: wa.x, y: wa.y, w: wa.w, h: aboveStamp - bandH - gap }, blocks: { x: wa.x, y: st.y - gap - bandH, w: wa.w, h: bandH }, flow: 'rows' })
  }
  // D: no blocks: the drawing may also use the full height left of the title block
  if (blocksW === 0) out.push({ plan: { x: wa.x, y: wa.y, w: leftOfStamp, h: wa.h }, blocks: { x: 0, y: 0, w: 0, h: 0 }, flow: 'rows' })
  return out
}

/** Packs blocks into a region: column by column (top-down) or row by row (left-right). Returns top-left corners or null. */
export function packBlocks(sizes: { w: number; h: number }[], region: Rect, flow: 'columns' | 'rows', gap = 4): Vec2[] | null {
  const out: Vec2[] = []
  if (flow === 'columns') {
    let x = region.x
    let y = region.y
    let colW = 0
    for (const s of sizes) {
      if (s.w > region.w + 0.01 || s.h > region.h + 0.01) return null
      if (y + s.h > region.y + region.h + 0.01) {
        x += colW + gap
        y = region.y
        colW = 0
      }
      if (x + s.w > region.x + region.w + 0.01) return null
      out.push({ x, y })
      y += s.h + gap
      colW = Math.max(colW, s.w)
    }
    return out
  }
  let x = region.x
  let y = region.y
  let rowH = 0
  for (const s of sizes) {
    if (s.w > region.w + 0.01 || s.h > region.h + 0.01) return null
    if (x + s.w > region.x + region.w + 0.01) {
      y += rowH + gap
      x = region.x
      rowH = 0
    }
    if (y + s.h > region.y + region.h + 0.01) return null
    out.push({ x, y })
    x += s.w + gap
    rowH = Math.max(rowH, s.h)
  }
  return out
}

export const PLAN_SCALES = [20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500]

export interface DrawingSpec {
  /** world items laid out for 1:S */
  build: (S: number) => DisplayItem[]
  /** candidate scales, ascending (1:S); the first one that fits wins */
  scales: number[]
  /** caption above the drawing, e.g. «План полов»; « М 1:S» is appended */
  caption?: string
}

export interface LaidSheet {
  items: DisplayItem[]
  scale: number
  /** blocks that did not fit next to the drawing (they go to a continuation sheet) */
  overflow: SheetBlock[]
}

const CAPTION_H = 8

/** Lays out one drawing with blocks on a sheet. */
export function layDrawingSheet(paper: PaperSize, drawing: DrawingSpec, blocks: SheetBlock[]): LaidSheet {
  const sizes = blocks.map(blockSize)
  const bw = sizes.length ? Math.max(...sizes.map((s) => s.w)) : 0
  const bh = sizes.reduce((s, x) => s + x.h + 4, 0)
  const cand = drawing.scales.length ? drawing.scales : [100]
  const cache = new Map<number, { items: DisplayItem[]; b: DisplayBounds }>()
  const built = (S: number) => {
    let c = cache.get(S)
    if (!c) {
      const items = drawing.build(S)
      c = { items, b: boundsOfItems(items) }
      cache.set(S, c)
    }
    return c
  }
  const capH = drawing.caption ? CAPTION_H : 0
  const tryFit = (withBlocks: boolean) => {
    for (const S of cand) {
      const { b } = built(S)
      const pw = (b.maxX - b.minX) / S
      const ph = (b.maxY - b.minY) / S + capH
      for (const L of layouts(paper, withBlocks ? bw : 0, withBlocks ? bh : 0)) {
        if (pw > L.plan.w + 0.01 || ph > L.plan.h + 0.01) continue
        const at = withBlocks && sizes.length ? packBlocks(sizes, L.blocks, L.flow) : []
        if (!at) continue
        return { S, L, at, b, pw, ph }
      }
    }
    return null
  }
  let fit = tryFit(true)
  let overflow: SheetBlock[] = []
  if (!fit) {
    fit = tryFit(false)
    overflow = blocks
  }
  const S = fit?.S ?? cand[cand.length - 1]
  const { items: world, b } = built(S)
  const region = fit?.L.plan ?? workArea(paper)
  const pw = (b.maxX - b.minX) / S
  const ph = (b.maxY - b.minY) / S + capH
  const ox = region.x + Math.max(0, (region.w - pw) / 2)
  const oy = region.y + Math.max(0, (region.h - ph) / 2)
  const items: DisplayItem[] = []
  if (drawing.caption) {
    items.push(text({ x: ox + pw / 2, y: oy + 3.5 }, `${drawing.caption}  М 1:${S}`, 3.5, { anchor: 'middle', bold: true, role: 'caption' }))
  }
  items.push(...toPaper(world, S, ox - b.minX / S, oy + capH - b.minY / S))
  if (fit && !overflow.length) fit.at.forEach((p, i) => items.push(...drawBlock(blocks[i], p.x, p.y)))
  return { items, scale: S, overflow }
}

/**
 * Lays out blocks (tables, notes) on as many sheets as needed: each sheet's working area above the
 * title block, tables split across sheets with the header repeated.
 */
export function layBlockSheets(paper: PaperSize, blocks: SheetBlock[], topReserve = 0): DisplayItem[][] {
  const wa = workArea(paper)
  const st = stampRect(paper)
  const pages: DisplayItem[][] = []
  // columns: the full working area; the last column stops above the title block
  const colGap = 6
  let page: DisplayItem[] = []
  let x = wa.x
  let y = wa.y + topReserve
  let colW = 0
  const colBottom = (cx: number, w: number) => (cx + w > st.x - 1 ? st.y - 5 : wa.y + wa.h)
  const newPage = () => {
    pages.push(page)
    page = []
    x = wa.x
    y = wa.y
    colW = 0
  }
  const newColumn = (w: number) => {
    x += colW + colGap
    y = wa.y + (pages.length === 0 ? topReserve : 0)
    colW = 0
    if (x + w > wa.x + wa.w + 0.01) newPage()
  }
  const queue = [...blocks]
  while (queue.length) {
    const b = queue.shift()!
    const s = blockSize(b)
    if (x + s.w > wa.x + wa.w + 0.01 && x > wa.x) newPage()
    let room = colBottom(x, s.w) - y
    if (s.h <= room) {
      page.push(...drawBlock(b, x, y))
      y += s.h + 5
      colW = Math.max(colW, s.w)
      continue
    }
    if (b.kind === 'table') {
      if (room < 30) {
        newColumn(s.w)
        room = colBottom(x, s.w) - y
      }
      const full = colBottom(x, s.w) - wa.y
      const pieces = splitTable(b.table, room, full)
      const first = pieces.shift()!
      page.push(...drawBlock({ kind: 'table', table: first }, x, y))
      y += blockSize({ kind: 'table', table: first }).h + 5
      colW = Math.max(colW, s.w)
      queue.unshift(...pieces.map((t): SheetBlock => ({ kind: 'table', table: t })))
      if (pieces.length) newColumn(s.w)
      continue
    }
    // notes / items: move to the next column or sheet
    newColumn(s.w)
    page.push(...drawBlock(b, x, y))
    y += s.h + 5
    colW = Math.max(colW, s.w)
  }
  if (page.length || !pages.length) pages.push(page)
  return pages
}
