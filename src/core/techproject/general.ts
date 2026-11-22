/** Титульный лист and «Общие данные» (ведомость листов, общие указания, экспликация). */
import type { DisplayItem } from '../display'
import { basePlan } from './common'
import { boundsOfItems, layBlockSheets, PLAN_SCALES, toPaper, type SheetBlock } from './layout'
import { DEFAULT_NOTES, type AlbumCtx, type PageDraft, type TocEntry } from './model'
import { drawFrame, frameRect, text, wrapText } from './paper'
import { explicationTable } from './plans'

export interface TitleInfo {
  object: string
  stage: string
  code: string
}

const STAGE_RU: Record<string, string> = {
  ЭП: 'Эскизный проект',
  П: 'Проект',
  РП: 'Рабочий проект',
  Р: 'Рабочая документация',
}

export function stageName(stage: string): string {
  return STAGE_RU[stage] ?? stage
}

/** the title page: frame only, no title block (it counts as sheet 1) */
export function titlePage(ctx: AlbumCtx, info: TitleInfo): PageDraft {
  const f = frameRect(ctx.paper)
  const cx = f.x + f.w / 2
  const items: DisplayItem[] = [...drawFrame(ctx.paper)]
  let y = f.y + f.h * 0.14
  if (ctx.settings.organization) {
    for (const s of wrapText(ctx.settings.organization, 3.5, f.w - 40).slice(0, 2)) {
      items.push(text({ x: cx, y }, s, 3.5, { anchor: 'middle', role: 'title' }))
      y += 5
    }
    y += 6
  }
  items.push(text({ x: cx, y }, 'ДИЗАЙН-ПРОЕКТ ИНТЕРЬЕРА', 5, { anchor: 'middle', bold: true, role: 'title' }))
  y += 12
  for (const s of wrapText(info.object, 8, f.w - 40).slice(0, 3)) {
    items.push(text({ x: cx, y }, s, 8, { anchor: 'middle', bold: true, role: 'title' }))
    y += 11
  }
  y += 2
  items.push(text({ x: cx, y }, 'Технический проект. Альбом рабочих чертежей', 4.2, { anchor: 'middle', role: 'title' }))
  y += 7
  if (info.code) {
    items.push(text({ x: cx, y }, info.code, 3.5, { anchor: 'middle', role: 'title' }))
    y += 6
  }
  // a key plan of the first level under the headings
  const lv = ctx.levels[0]
  const boxTop = y + 6
  const boxBottom = f.y + f.h - 28
  const boxW = f.w * 0.6
  const boxH = boxBottom - boxTop
  if (lv && boxH > 30) {
    for (const S of PLAN_SCALES) {
      const world = basePlan(ctx, lv, S, { labels: false })
      if (!world.length) break
      const b = boundsOfItems(world)
      const pw = (b.maxX - b.minX) / S
      const ph = (b.maxY - b.minY) / S
      if (pw > boxW || ph > boxH) continue
      items.push(...toPaper(world, S, cx - pw / 2 - b.minX / S, boxTop + (boxH - ph) / 2 - b.minY / S))
      break
    }
  }
  const year = /^(\d{4})/.exec(ctx.date)?.[1] ?? ''
  items.push(text({ x: cx, y: f.y + f.h - 16 }, `Стадия: ${stageName(info.stage)}`, 3.5, { anchor: 'middle', role: 'title' }))
  if (year) items.push(text({ x: cx, y: f.y + f.h - 9 }, year, 3.5, { anchor: 'middle', role: 'title' }))
  return { kind: 'title', title: 'Титульный лист', scale: 1, items, bare: true }
}

export function tocTable(toc: readonly TocEntry[]): SheetBlock {
  return {
    kind: 'table',
    table: {
      title: 'Ведомость листов',
      columns: [
        { title: 'Лист', width: 14, align: 'middle' },
        { title: 'Наименование', width: 112 },
        { title: 'Примечание', width: 44 },
      ],
      rows: toc.map((e) => [String(e.sheet), e.title, e.note ?? '']),
      size: 2.4,
    },
  }
}

/** «Общие данные»: the sheet list first, then the notes and the explication of every level */
export function generalPages(ctx: AlbumCtx, toc: readonly TocEntry[]): PageDraft[] {
  const notes = ctx.settings.notes?.length ? ctx.settings.notes : DEFAULT_NOTES
  const blocks: SheetBlock[] = [tocTable(toc), { kind: 'notes', title: 'Общие указания', lines: notes.map((s, i) => `${i + 1}. ${s}`), width: 170 }]
  for (const lv of ctx.levels) {
    const t = explicationTable(ctx, lv)
    if (ctx.levels.length > 1) t.title = `${t.title}. ${ctx.doc.levels[lv]?.name ?? ''}`
    if (t.rows.length) blocks.push({ kind: 'table', table: t })
  }
  const sheets = layBlockSheets(ctx.paper, blocks)
  return sheets.map((items, i) => ({ kind: 'general', title: i ? 'Общие данные (продолжение)' : 'Общие данные', scale: 1, items }))
}
