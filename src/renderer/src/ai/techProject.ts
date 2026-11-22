/**
 * Executors of the technical project tools (shared/aiTechProject.ts): the album composition as text
 * (and a sheet as an image), and the album set-up saved in `doc.techProject.album`.
 */
import {
  type AlbumSettings,
  albumRooms,
  captureBaseline,
  composeAlbum,
  drawToCanvas,
  mergeCatalog,
  builtinCatalog,
  pageDisplayList,
  readAlbumSettings,
  SHEET_CATALOG,
  sheetInfo,
  stageName,
} from '@core'
import type { Catalog, Doc } from '@core/types'
import type { AiToolResult } from '@shared/aiChat'
import type { TECH_PROJECT_SHAPES, TechProjectToolName } from '@shared/aiTechProject'
import type { z } from 'zod'

type Args<K extends TechProjectToolName> = z.infer<z.ZodObject<(typeof TECH_PROJECT_SHAPES)[K]>>

/** what the executors need from the tool host */
export interface TechProjectHost {
  doc(): Doc
  catalog(): Catalog
  mutate(label: string, fn: (d: Doc) => void): void
}

export interface TechProjectOutcome {
  result: AiToolResult
  changes?: string[]
}

let builtinCache: Catalog | null = null
const fullCatalog = (c: Catalog) => mergeCatalog((builtinCache ??= builtinCatalog()), c)

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** the album as text: settings, numbered sheets, empty ones and why, elevation rooms, the catalogue */
export function describeAlbum(doc: Doc, catalog: Catalog): string {
  const cat = fullCatalog(catalog)
  const s = readAlbumSettings(doc, doc.techProject?.album, { catalog: cat })
  const album = composeAlbum(doc, s, { catalog: cat })
  const lines: string[] = []
  lines.push(
    `Технический проект «${album.object}»: ${s.format} ${s.orientation === 'landscape' ? 'альбомная' : 'книжная'}, стадия ${s.stage} (${stageName(s.stage)}), шифр ${s.code}, дата ${album.date}.`,
  )
  const signed = [s.organization && 'организация', s.author && 'разработал', s.checker && 'проверил'].filter(Boolean)
  lines.push(signed.length ? `В штампе заполнено: ${signed.join(', ')}.` : 'Штамп без личных данных.')
  const b = doc.techProject?.baseline
  lines.push(b ? `Обмер зафиксирован ${b.takenAt.slice(0, 10)}.` : 'Обмер не зафиксирован: планы демонтажа и монтажа будут пустыми (fixSurvey: true фиксирует текущий план).')
  lines.push(`Листов: ${album.pages.length}.`)
  for (const p of album.pages)
    lines.push(`${p.no}. ${p.title} [${p.kind}]${p.scale > 1 ? `, М 1:${p.scale}` : ''}${p.empty ? ` — нет данных: ${p.empty}` : ''}`)
  const off = s.sheets.filter((x) => !x.on).map((x) => `${x.kind} (${sheetInfo(x.kind).title})`)
  if (off.length) lines.push(`Выключены: ${off.join(', ')}.`)
  const rooms = albumRooms(doc, s, cat)
  const elev = rooms.filter((r) => r.elevations)
  if (rooms.length)
    lines.push(
      `Развёртки: ${elev.length ? elev.map((r) => `${r.name} (${r.id})`).join(', ') : 'нет'}; другие помещения: ${
        rooms
          .filter((r) => !r.elevations)
          .map((r) => `${r.name} (${r.id})`)
          .join(', ') || 'нет'
      }.`,
    )
  lines.push('Виды листов:')
  for (const k of SHEET_CATALOG) lines.push(`- ${k.kind}: ${k.title} — ${k.description}${k.scales.length ? ` (масштабы ${k.scales.map((x) => `1:${x}`).join(', ')})` : ''}`)
  lines.push('Выгрузка PDF / DXF: Экспорт → «Технический проект…».')
  return lines.join('\n')
}

async function sheetImage(doc: Doc, catalog: Catalog, no: number, width: number): Promise<{ mime: 'image/png'; data: string; title: string }> {
  const cat = fullCatalog(catalog)
  const album = composeAlbum(doc, readAlbumSettings(doc, doc.techProject?.album, { catalog: cat }), { catalog: cat })
  const page = album.pages.find((p) => p.no === no)
  if (!page) throw new Error(`Нет листа ${no}: в альбоме ${album.pages.length}`)
  const dl = pageDisplayList(album, page)
  const pxPerMm = width / album.paper.width
  const w = Math.ceil(album.paper.width * pxPerMm)
  const h = Math.ceil(album.paper.height * pxPerMm)
  const canvas = new OffscreenCanvas(w, h)
  const c2d = canvas.getContext('2d')
  if (!c2d) throw new Error('2D-контекст недоступен')
  drawToCanvas(c2d, dl, { pxPerMm, width: w, height: h, scale: 1, background: '#ffffff' })
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { mime: 'image/png', data: await blobToBase64(blob), title: `${page.no}. ${page.title}` }
}

export async function runTechProjectTool(host: TechProjectHost, name: TechProjectToolName, a: Record<string, unknown>): Promise<TechProjectOutcome> {
  if (name === 'get_tech_project') {
    const args = a as Args<'get_tech_project'>
    const text = describeAlbum(host.doc(), host.catalog())
    if (args.sheet === undefined) return { result: { ok: true, text } }
    const img = await sheetImage(host.doc(), host.catalog(), args.sheet, args.width ?? 1400)
    return { result: { ok: true, text: `${text}\n\nИзображение листа ${img.title}.`, image: { mime: img.mime, data: img.data } } }
  }

  const args = a as Args<'build_tech_project'>
  const doc = host.doc()
  const cat = fullCatalog(host.catalog())
  const cur = readAlbumSettings(doc, doc.techProject?.album, { catalog: cat })
  const next: AlbumSettings = { ...cur }
  const changes: string[] = []
  if (args.sheets) {
    const order = [...new Set(args.sheets)]
    const rest = cur.sheets.filter((s) => !order.includes(s.kind)).map((s) => ({ ...s, on: false }))
    next.sheets = [...order.map((k) => ({ ...(cur.sheets.find((s) => s.kind === k) ?? { kind: k }), on: true })), ...rest]
    changes.push(`Листы: ${order.map((k) => sheetInfo(k).title).join(', ')}`)
  }
  if (args.scales)
    next.sheets = next.sheets.map((s) => (s.kind in args.scales! ? { ...s, scale: args.scales![s.kind] ?? undefined } : s))
  for (const k of ['format', 'orientation', 'stage', 'code', 'object', 'date', 'variantId'] as const) {
    const v = args[k]
    if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v
  }
  if (args.levels) {
    const bad = args.levels.filter((id) => !doc.levels[id])
    if (bad.length) return { result: { ok: false, text: `Нет этажей: ${bad.join(', ')}. Есть: ${doc.levelOrder.join(', ')}` } }
    next.levels = args.levels.length ? args.levels : undefined
  }
  if (args.elevationRooms) {
    const bad = args.elevationRooms.filter((id) => !doc.rooms[id])
    if (bad.length) return { result: { ok: false, text: `Нет помещений: ${bad.join(', ')}` } }
    next.elevationRooms = args.elevationRooms
  }
  if (args.variantId && !(doc.variants?.list[args.variantId] || args.variantId === cur.variantId))
    return { result: { ok: false, text: `Нет варианта обстановки ${args.variantId}` } }
  const fields = Object.keys(args).filter((k) => !['sheets', 'fixSurvey'].includes(k))
  if (fields.length) changes.push(`Настройки: ${fields.join(', ')}`)
  if (args.fixSurvey) changes.push('Обмер зафиксирован по текущему плану')

  host.mutate('ИИ: технический проект', (d) => {
    const tp = (d.techProject ??= {})
    if (args.sheets || fields.length) tp.album = JSON.parse(JSON.stringify(next)) as Record<string, unknown>
    if (args.fixSurvey) tp.baseline = captureBaseline(d)
  })
  return { result: { ok: true, text: `Сохранено.\n${describeAlbum(host.doc(), host.catalog())}` }, changes }
}
