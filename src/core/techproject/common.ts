/** Shared lookups and the base plan of the album sheets. */
import { BUILTIN_ASSETS, BUILTIN_MATERIALS, ROOM_TYPE_NAMES } from '../defaults'
import { buildDisplayList, type DisplayItem, type DisplayOptions } from '../display'
import { layBlockSheets, layDrawingSheet, type SheetBlock } from './layout'
import type { Asset, Catalog, DerivedRoom, Doc, Id, Item, Material, Room } from '../types'
import { type AlbumCtx, type PageDraft, type SheetKind, sheetInfo } from './model'

export function lookupMaterial(doc: Doc, catalog: Catalog | undefined, id: Id | undefined): Material | undefined {
  if (!id) return undefined
  return doc.materials[id] ?? catalog?.materials.find((m) => m.id === id) ?? BUILTIN_MATERIALS.find((m) => m.id === id)
}

export function lookupAsset(doc: Doc, catalog: Catalog | undefined, id: Id): Asset | undefined {
  return doc.assets[id] ?? catalog?.assets.find((a) => a.id === id) ?? BUILTIN_ASSETS.find((a) => a.id === id)
}

export function materialTitle(m: Material | undefined, id: Id | undefined): string {
  if (!m) return id ?? '—'
  return m.nameRu || m.name || m.id
}

export function itemTitle(doc: Doc, catalog: Catalog | undefined, it: Item): string {
  const a = lookupAsset(doc, catalog, it.assetId)
  return it.name || a?.nameRu || a?.name || it.assetId
}

export function roomTitle(doc: Doc, r: DerivedRoom | Room | undefined): string {
  if (!r) return '—'
  const rec = 'roomId' in r ? doc.rooms[r.roomId] : r
  if (!rec) return '—'
  return rec.name || ROOM_TYPE_NAMES[rec.type]?.ru || rec.id
}

export function settingOf(ctx: AlbumCtx, kind: SheetKind) {
  return ctx.settings.sheets.find((s) => s.kind === kind)
}

export function levelCaption(ctx: AlbumCtx, title: string, levelId: Id | undefined): string {
  if (!levelId || ctx.levels.length < 2) return title
  const name = ctx.doc.levels[levelId]?.name
  return name ? `${title}. ${name}` : title
}

/** the plan of a level as a world display list for 1:S (no sheet chrome) */
export function basePlan(ctx: AlbumCtx, levelId: Id, S: number, o: DisplayOptions = {}, doc: Doc = ctx.doc): DisplayItem[] {
  // working drawings are dimensioned in millimetres whatever the editor shows
  const mmDoc = doc.settings.units === 'mm' ? doc : { ...doc, settings: { ...doc.settings, units: 'mm' as const } }
  const dl = buildDisplayList(mmDoc, levelId, {
    dimensions: false,
    areas: false,
    furniture: false,
    labels: true,
    grid: false,
    titleBlock: false,
    northArrow: false,
    scaleBar: false,
    lights: false,
    electrical: false,
    manualDimensions: false,
    theme: 'light',
    lang: 'ru',
    catalog: ctx.catalog,
    derived: doc.walls === ctx.doc.walls ? ctx.plans[levelId] : undefined,
    ...o,
    scale: S,
  })
  return dl.items
}

/** A plan sheet of a level (and continuation sheets for blocks that did not fit). */
export function planPages(
  ctx: AlbumCtx,
  kind: SheetKind,
  levelId: Id,
  build: (S: number) => DisplayItem[],
  blocks: SheetBlock[],
  extra: { empty?: string; title?: string; scales?: number[] } = {},
): PageDraft[] {
  const info = sheetInfo(kind)
  const set = settingOf(ctx, kind)
  const scales = set?.scale ? [set.scale] : (extra.scales ?? info.scales)
  const title = levelCaption(ctx, extra.title ?? info.title, levelId)
  const laid = layDrawingSheet(ctx.paper, { build, scales, caption: title }, blocks)
  const pages: PageDraft[] = [{ kind, title, scale: laid.scale, items: laid.items, levelId, empty: extra.empty }]
  if (laid.overflow.length) {
    for (const items of layBlockSheets(ctx.paper, laid.overflow)) pages.push({ kind, title: `${title} (продолжение)`, scale: 1, items, levelId })
  }
  return pages
}

/** a lighter tint of a colour (floor fills on the floor plan) */
export function tint(hex: string, k = 0.75): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#f2f2f2'
  const n = Number.parseInt(m[1], 16)
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - k) + 255 * k)
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`
}

export function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0
  for (const x of xs) s += f(x)
  return s
}
