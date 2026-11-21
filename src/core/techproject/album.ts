/**
 * The technical project album: settings → numbered sheets → page display lists (SVG / PDF / DXF).
 * Pure TS.
 */
import { derivePlan } from '../derive'
import type { DisplayList } from '../display'
import { electricType } from '../electrical'
import { sheetToDxf } from '../export/dxf'
import { toSvg } from '../export/svg'
import type { Catalog, DerivedPlan, Doc, Id } from '../types'
import { activeVariantId, materializeVariant } from '../variants'
import { constructionSheet, demolitionSheet, measurePages } from './baseline'
import { contributorsFor, hasContribution } from './contrib'
import { elevationSheets, defaultElevationRooms } from './elevations'
import './fixtures'
import { generalPages, titlePage } from './general'
import { ALBUM_STAGES, type AlbumCtx, type AlbumSettings, type AlbumSheetSetting, isSheetKind, type PageDraft, SHEET_CATALOG, type SheetKind, sheetInfo, type TocEntry } from './model'
import { drawFrame, drawStamp, type PaperFormat, type PaperOrientation, type PaperSize, paperSize, type StampInfo } from './paper'
import { ceilingsSheet, floorsSheet, furnitureSheet, isPlumbingItem, lightingSheet, plumbingSheet, socketsSheet, underfloorSheet } from './plans'
import { finishesPages, specLightsPages, specOpeningsPages, specPlumbingPages } from './specs'

export interface AlbumPage extends PageDraft {
  /** sheet number, 1-based (the title page is sheet 1) */
  no: number
}

export interface Album {
  settings: AlbumSettings
  paper: PaperSize
  pages: AlbumPage[]
  toc: TocEntry[]
  /** object name and date the stamps carry */
  object: string
  date: string
}

const FORMATS: readonly PaperFormat[] = ['A4', 'A3', 'A2']

const todayIso = () => new Date().toISOString().slice(0, 10)

function ctxOf(doc: Doc, settings: AlbumSettings, catalog: Catalog | undefined, date: string): AlbumCtx {
  const vdoc = settings.variantId && settings.variantId !== activeVariantId(doc) ? materializeVariant(doc, settings.variantId, catalog) : doc
  const levels = (settings.levels?.length ? settings.levels.filter((id) => vdoc.levels[id]) : vdoc.levelOrder).filter((id) => vdoc.levels[id])
  const plans: Record<Id, DerivedPlan> = {}
  for (const lv of levels) plans[lv] = derivePlan(vdoc, lv)
  return { doc: vdoc, catalog, settings, plans, levels, paper: paperSize(settings.format, settings.orientation), date }
}

/** does a sheet have anything to show for the document (the default selection) */
export function sheetHasData(ctx: AlbumCtx, kind: SheetKind): boolean {
  const { doc } = ctx
  const onLevels = <T extends { levelId: Id }>(xs: T[]) => xs.some((x) => ctx.levels.includes(x.levelId))
  const elec = Object.values(doc.electrical ?? {})
  switch (kind) {
    case 'demolition':
    case 'construction':
      return !!doc.techProject?.baseline
    case 'furniture':
      return onLevels(Object.values(doc.items).filter((it) => !it.hidden))
    case 'lighting':
      return onLevels(Object.values(doc.lights)) || onLevels(elec.filter((p) => electricType(p.kind).group === 'switches'))
    case 'sockets':
      return onLevels(elec.filter((p) => electricType(p.kind).group !== 'switches' && p.kind !== 'thermostat'))
    case 'plumbing':
    case 'specPlumbing':
      // the builtin `fixtures` draws from the items; another contributor (utilities) has its own data
      return (
        onLevels(Object.values(doc.items).filter((it) => isPlumbingItem(ctx, it))) ||
        (kind === 'plumbing' && contributorsFor('plumbing').some((c) => c.id !== 'fixtures' && (!c.has || c.has(doc))))
      )
    case 'underfloor':
      return hasContribution('underfloor', doc)
    case 'elevations':
      return defaultElevationRooms(doc, ctx).length > 0 || !!ctx.settings.elevationRooms?.length
    case 'specLights':
      return onLevels(Object.values(doc.lights))
    case 'specOpenings':
      return Object.keys(doc.openings).length > 0
    default:
      return true
  }
}

/** defaults: A3 landscape, stage «Р», every sheet that has data, no personal data */
export function defaultAlbumSettings(doc: Doc, opts: { catalog?: Catalog; today?: string } = {}): AlbumSettings {
  const date = opts.today ?? todayIso()
  const base: AlbumSettings = {
    format: 'A3',
    orientation: 'landscape',
    stage: 'Р',
    code: `ДП-${date.slice(0, 7)}`,
    object: doc.meta.name,
    date,
    sheets: SHEET_CATALOG.map((s) => ({ kind: s.kind, on: true })),
  }
  const ctx = ctxOf(doc, base, opts.catalog, date)
  base.sheets = base.sheets.map((s) => ({ ...s, on: sheetHasData(ctx, s.kind) }))
  return base
}

const optStr = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** saved album settings (`doc.techProject.album`) over the defaults; unknown values dropped */
export function readAlbumSettings(doc: Doc, raw: unknown = doc.techProject?.album, opts: { catalog?: Catalog; today?: string } = {}): AlbumSettings {
  const def = defaultAlbumSettings(doc, opts)
  if (!raw || typeof raw !== 'object') return def
  const r = raw as Record<string, unknown>
  const out: AlbumSettings = { ...def }
  if (FORMATS.includes(r.format as PaperFormat)) out.format = r.format as PaperFormat
  if (r.orientation === 'landscape' || r.orientation === 'portrait') out.orientation = r.orientation as PaperOrientation
  const stage = optStr(r.stage, 8)
  if (stage) out.stage = stage
  for (const k of ['code', 'object', 'organization', 'author', 'checker'] as const) {
    const v = optStr(r[k])
    if (v !== undefined) out[k] = v
  }
  const date = optStr(r.date, 10)
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date
  if (Array.isArray(r.sheets)) {
    const seen = new Set<SheetKind>()
    const list: AlbumSheetSetting[] = []
    for (const s of r.sheets) {
      if (!s || typeof s !== 'object') continue
      const kind = (s as Record<string, unknown>).kind
      if (!isSheetKind(kind) || seen.has(kind)) continue
      seen.add(kind)
      const scale = (s as Record<string, unknown>).scale
      list.push({ kind, on: (s as Record<string, unknown>).on !== false, scale: typeof scale === 'number' && scale >= 1 && scale <= 1000 ? scale : undefined })
    }
    for (const s of def.sheets) if (!seen.has(s.kind)) list.push(s)
    out.sheets = list
  }
  const ids = (v: unknown, ok: (id: string) => boolean) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ok(x)) : undefined)
  out.levels = ids(r.levels, (id) => !!doc.levels[id])
  out.elevationRooms = ids(r.elevationRooms, (id) => !!doc.rooms[id])
  if (typeof r.variantId === 'string' && (doc.variants?.list[r.variantId] || r.variantId === activeVariantId(doc))) out.variantId = r.variantId
  if (Array.isArray(r.notes)) out.notes = r.notes.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 1000))
  return out
}

function sheetPages(ctx: AlbumCtx, kind: SheetKind, object: string): PageDraft[] {
  const perLevel = (f: (ctx: AlbumCtx, lv: Id) => PageDraft[]) => ctx.levels.flatMap((lv) => f(ctx, lv))
  switch (kind) {
    case 'title':
      return [titlePage(ctx, { object, stage: ctx.settings.stage, code: ctx.settings.code })]
    case 'general':
      return [] // laid out after numbering
    case 'measure':
      return perLevel(measurePages)
    case 'demolition':
      return perLevel(demolitionSheet)
    case 'construction':
      return perLevel(constructionSheet)
    case 'furniture':
      return perLevel(furnitureSheet)
    case 'floors':
      return perLevel(floorsSheet)
    case 'ceilings':
      return perLevel(ceilingsSheet)
    case 'lighting':
      return perLevel(lightingSheet)
    case 'sockets':
      return perLevel(socketsSheet)
    case 'plumbing':
      return perLevel(plumbingSheet)
    case 'underfloor':
      return perLevel(underfloorSheet)
    case 'elevations':
      return elevationSheets(ctx)
    case 'specOpenings':
      return specOpeningsPages(ctx)
    case 'specPlumbing':
      return specPlumbingPages(ctx)
    case 'specLights':
      return specLightsPages(ctx)
    case 'finishes':
      return finishesPages(ctx)
  }
}

export interface ComposeOptions {
  catalog?: Catalog
  /** ISO date used when the settings have none */
  today?: string
  /** compose only these sheets (preview of one sheet); numbering still counts the whole album */
  only?: SheetKind[]
}

/** Builds the album: every enabled sheet in order, numbered, with the sheet list on «Общие данные». */
export function composeAlbum(doc: Doc, settings: AlbumSettings = readAlbumSettings(doc), opts: ComposeOptions = {}): Album {
  const date = settings.date || opts.today || todayIso()
  const ctx = ctxOf(doc, settings, opts.catalog, date)
  const object = settings.object?.trim() || doc.meta.name
  const on = settings.sheets.filter((s) => s.on)
  // sheets by kind, the general data pages left for later
  const drafts = new Map<SheetKind, PageDraft[]>()
  for (const s of on) if (s.kind !== 'general') drafts.set(s.kind, sheetPages(ctx, s.kind, object))
  const hasGeneral = on.some((s) => s.kind === 'general')
  const assemble = (general: PageDraft[]): PageDraft[] => on.flatMap((s) => (s.kind === 'general' ? general : (drafts.get(s.kind) ?? [])))
  const tocOf = (pages: PageDraft[]): TocEntry[] => pages.map((p, i) => ({ sheet: i + 1, title: p.title, note: p.empty ? 'нет данных' : undefined }))
  let general: PageDraft[] = []
  if (hasGeneral) {
    // the sheet list sits on the general pages, whose count shifts the numbering: settle it
    general = [{ kind: 'general', title: 'Общие данные', scale: 1, items: [] }]
    for (let i = 0; i < 4; i++) {
      const next = generalPages(ctx, tocOf(assemble(general)))
      const same = next.length === general.length
      general = next
      if (same) break
    }
  }
  const pages = assemble(general).map((p, i): AlbumPage => ({ ...p, no: i + 1 }))
  return { settings, paper: ctx.paper, pages, toc: tocOf(pages), object, date }
}

export function stampOf(album: Album, page: AlbumPage): StampInfo {
  const s = album.settings
  return {
    code: s.code,
    object: album.object,
    sheetTitle: page.title,
    stage: s.stage,
    sheet: page.no,
    sheets: album.pages.length,
    date: album.date,
    organization: s.organization || undefined,
    author: s.author || undefined,
    checker: s.checker || undefined,
    format: `Формат ${s.format.replace('A', 'А')}`,
  }
}

/** a sheet as a display list in paper mm (scale 1), with the frame and the title block */
export function pageDisplayList(album: Album, page: AlbumPage): DisplayList {
  const p = album.paper
  const items = [...page.items]
  if (!page.bare) items.push(...drawFrame(p), ...drawStamp(p, stampOf(album, page)))
  return { bounds: { minX: 0, minY: 0, maxX: p.width, maxY: p.height }, items, scale: 1, theme: 'light', background: '#ffffff' }
}

export function pageSvg(album: Album, page: AlbumPage): { svg: string; widthMm: number; heightMm: number } {
  const r = toSvg(pageDisplayList(album, page), { scale: 1, marginMm: 0, title: `${page.no}. ${page.title}`, background: true })
  return { svg: r.svg, widthMm: album.paper.width, heightMm: album.paper.height }
}

/**
 * A sheet as DXF: coordinates × the sheet's drawing scale, so the plan is in real millimetres and the
 * frame with the title block sits around it at 1:S (tables-only sheets stay in paper millimetres).
 */
export function pageDxf(album: Album, page: AlbumPage): string {
  return sheetToDxf(pageDisplayList(album, page).items, Math.max(1, page.scale))
}

/** «03 Обмерный план» — a file name for a sheet (no extension) */
export function pageFileName(page: AlbumPage, total: number): string {
  const n = String(page.no).padStart(Math.max(2, String(total).length), '0')
  return `${n} ${page.title}`
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** what the album contains (the dialog, the AI) */
export function albumSummary(album: Album): { sheet: number; kind: SheetKind; title: string; scale?: number; empty?: string }[] {
  return album.pages.map((p) => ({ sheet: p.no, kind: p.kind, title: p.title, scale: p.scale > 1 ? p.scale : undefined, empty: p.empty }))
}

export { ALBUM_STAGES, sheetInfo }
