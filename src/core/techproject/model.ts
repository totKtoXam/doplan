/**
 * Technical project album (технический проект / альбом рабочих чертежей дизайн-проекта):
 * the sheet catalogue, album settings and the context sheet builders work in.
 *
 * Composition of an apartment design project album as practised in KZ / RU studios:
 * титул → общие данные (ведомость листов, общие указания, экспликация) → обмерный план →
 * демонтаж / монтаж перегородок → расстановка мебели → полы → потолки → освещение и группы
 * выключателей → розетки (электрика с привязками) → сантехника → тёплый пол → развёртки
 * санузлов и кухни → спецификации (двери и окна, сантехника, светильники) → ведомость отделки.
 */
import type { DisplayItem } from '../display'
import type { Catalog, DerivedPlan, Doc, Id } from '../types'
import type { PaperFormat, PaperOrientation, PaperSize } from './paper'

export type SheetKind =
  | 'title'
  | 'general'
  | 'measure'
  | 'demolition'
  | 'construction'
  | 'furniture'
  | 'floors'
  | 'ceilings'
  | 'lighting'
  | 'sockets'
  | 'plumbing'
  | 'underfloor'
  | 'elevations'
  | 'specOpenings'
  | 'specPlumbing'
  | 'specLights'
  | 'finishes'

export type SheetGroup = 'general' | 'plans' | 'engineering' | 'elevations' | 'specs'

export interface SheetInfo {
  kind: SheetKind
  /** sheet name (stamp, ведомость листов) */
  title: string
  group: SheetGroup
  /** one sheet per level (plans) */
  perLevel: boolean
  /** default drawing scales tried, ascending 1:S */
  scales: number[]
  /** what the sheet shows (the dialog, the AI) */
  description: string
}

const PLAN = [50, 75, 100, 125, 150, 200]

export const SHEET_CATALOG: readonly SheetInfo[] = [
  { kind: 'title', title: 'Титульный лист', group: 'general', perLevel: false, scales: [], description: 'Название объекта, стадия, год; без личных данных' },
  { kind: 'general', title: 'Общие данные', group: 'general', perLevel: false, scales: [], description: 'Ведомость листов, общие указания, экспликация помещений' },
  { kind: 'measure', title: 'Обмерный план', group: 'plans', perLevel: true, scales: PLAN, description: 'Стены и проёмы до ремонта (зафиксированный обмер или текущий план), размеры, площади, высоты' },
  { kind: 'demolition', title: 'План демонтажа', group: 'plans', perLevel: true, scales: PLAN, description: 'Демонтируемые стены и проёмы относительно обмера, п. м' },
  { kind: 'construction', title: 'План монтажа перегородок', group: 'plans', perLevel: true, scales: PLAN, description: 'Возводимые стены и новые проёмы с привязками, п. м' },
  { kind: 'furniture', title: 'План расстановки мебели', group: 'plans', perLevel: true, scales: PLAN, description: 'Мебель и оборудование с позициями и спецификацией' },
  { kind: 'floors', title: 'План полов', group: 'plans', perLevel: true, scales: PLAN, description: 'Покрытия, раскладка плитки, направление ламината, площади с запасом' },
  { kind: 'ceilings', title: 'План потолков', group: 'plans', perLevel: true, scales: PLAN, description: 'Типы потолков, отметки, короба и уровни, карнизы' },
  { kind: 'lighting', title: 'План освещения и выключателей', group: 'engineering', perLevel: true, scales: PLAN, description: 'Светильники с привязками, выключатели, группы' },
  { kind: 'sockets', title: 'План розеток и выводов', group: 'engineering', perLevel: true, scales: PLAN, description: 'Розетки, слаботочка, выводы под технику: высоты и привязки к углам' },
  { kind: 'plumbing', title: 'План сантехники', group: 'engineering', perLevel: true, scales: [25, 50, 75, 100], description: 'Сантехприборы, выводы ХВС/ГВС/К с высотами, стояки' },
  { kind: 'underfloor', title: 'План тёплого пола', group: 'engineering', perLevel: true, scales: PLAN, description: 'Зоны тёплого пола, терморегуляторы, датчики' },
  { kind: 'elevations', title: 'Развёртки стен', group: 'elevations', perLevel: false, scales: [20, 25, 50], description: 'Развёртки санузлов и кухни: раскладка плитки, электрика, сантехника, мебель' },
  { kind: 'specOpenings', title: 'Спецификация дверей и окон', group: 'specs', perLevel: false, scales: [], description: 'Двери, окна, проёмы: размеры, открывание, помещения' },
  { kind: 'specPlumbing', title: 'Спецификация сантехники', group: 'specs', perLevel: false, scales: [], description: 'Сантехприборы и оборудование по помещениям' },
  { kind: 'specLights', title: 'Спецификация светильников', group: 'specs', perLevel: false, scales: [], description: 'Светильники по типам и помещениям: мощность, цветовая температура' },
  { kind: 'finishes', title: 'Ведомость отделки помещений', group: 'specs', perLevel: false, scales: [], description: 'Пол, стены, потолок, плинтус по помещениям с площадями' },
]

export function sheetInfo(kind: SheetKind): SheetInfo {
  return SHEET_CATALOG.find((s) => s.kind === kind) ?? SHEET_CATALOG[0]
}

export const SHEET_KINDS: readonly SheetKind[] = SHEET_CATALOG.map((s) => s.kind)

export function isSheetKind(s: unknown): s is SheetKind {
  return typeof s === 'string' && (SHEET_KINDS as readonly string[]).includes(s)
}

export interface AlbumSheetSetting {
  kind: SheetKind
  on: boolean
  /** fixed scale 1:S (absent = the largest that fits) */
  scale?: number
}

export const ALBUM_STAGES = ['ЭП', 'П', 'РП', 'Р'] as const

export interface AlbumSettings {
  format: PaperFormat
  orientation: PaperOrientation
  /** стадия (графа «Стадия»): ЭП — эскизный, П — проект, РП / Р — рабочий */
  stage: string
  /** обозначение документа */
  code: string
  /** object name (default: the project name) */
  object?: string
  /** ISO date; default today */
  date?: string
  organization?: string
  author?: string
  checker?: string
  /** order and choice of sheets */
  sheets: AlbumSheetSetting[]
  /** levels to draw (default all) */
  levels?: Id[]
  /** rooms that get wall elevations (default: bathrooms, toilets and kitchens) */
  elevationRooms?: Id[]
  /** furnishing variant to draw (default the active one) */
  variantId?: Id
  /** general notes («Общие указания»); default the standard list */
  notes?: string[]
}

export const DEFAULT_NOTES: readonly string[] = [
  'Все размеры даны в миллиметрах, отметки — в метрах от уровня чистого пола.',
  'Размеры уточнить по месту после выравнивания стен. Расхождения с проектом согласовать с дизайнером до начала работ.',
  'Высоты электроустановочных изделий даны до центра изделия от уровня чистого пола.',
  'Раскладку плитки начинать от отмеченной точки; подрезку размещать в наименее заметных местах.',
  'Изменения проекта после утверждения вносятся по согласованию сторон.',
]

export interface AlbumCtx {
  /** the drawn document (the chosen furnishing variant) */
  doc: Doc
  catalog?: Catalog
  settings: AlbumSettings
  /** derived plan per level */
  plans: Record<Id, DerivedPlan>
  /** levels to draw, in order */
  levels: Id[]
  paper: PaperSize
  /** ISO date of the album */
  date: string
}

/** One sheet before numbering. */
export interface PageDraft {
  kind: SheetKind
  /** sheet title in the stamp and the sheet list */
  title: string
  /** main drawing scale 1:S (1 for tables): DXF units of the sheet */
  scale: number
  /** paper-mm items without the frame and the stamp */
  items: DisplayItem[]
  levelId?: Id
  /** the title page: no frame or title block */
  bare?: boolean
  /** «нет данных» — the sheet is empty for lack of data (a hint for the user) */
  empty?: string
}

export interface TocEntry {
  sheet: number
  title: string
  note?: string
}
