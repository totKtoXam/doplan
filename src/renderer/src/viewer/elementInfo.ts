/**
 * What the viewer's element card says about a plan object: its name, its kind and the sizes a visitor
 * asks about. Only what the drawing shows — never prices, product links, notes or hidden objects.
 * Pure: the strings come out translated by the `t` passed in.
 */
import { electricName, entityKind, ROOM_TYPE_NAMES } from '@core'
import type { Catalog, DerivedPlan, Doc, EntityRef, Id, Opening, OpeningKind } from '@core/types'

export interface InfoRow {
  label: string
  value: string
}

export interface ElementInfo {
  name: string
  type: string
  rows: InfoRow[]
}

export interface InfoEnv {
  doc: Doc
  plan: DerivedPlan | undefined
  catalog: Pick<Catalog, 'assets' | 'materials'>
  lang: 'ru' | 'en'
  t(ru: string): string
}

const WINDOWS: readonly OpeningKind[] = ['window', 'frenchWindow', 'balconyBlock']

/** «1 200 мм» */
export function mmText(v: number, env: Pick<InfoEnv, 'lang' | 't'>): string {
  return `${Math.round(v).toLocaleString(env.lang === 'ru' ? 'ru-RU' : 'en-GB')} ${env.t('мм')}`
}

/** «12,50 м²» */
function m2Text(v: number, env: InfoEnv): string {
  return `${v.toLocaleString(env.lang === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${env.t('м²')}`
}

/** «14,20 м» */
function mText(v: number, env: InfoEnv): string {
  return `${v.toLocaleString(env.lang === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${env.t('м')}`
}

function sizeText(w: number, d: number, h: number, env: InfoEnv): string {
  const r = (v: number) => Math.round(v).toLocaleString(env.lang === 'ru' ? 'ru-RU' : 'en-GB')
  return `${r(w)} × ${r(d)} × ${r(h)} ${env.t('мм')}`
}

function materialName(id: Id | undefined, env: InfoEnv): string | undefined {
  if (!id) return undefined
  const m = env.doc.materials?.[id] ?? env.catalog.materials.find((e) => e.id === id)
  if (!m) return undefined
  return env.lang === 'ru' ? (m.nameRu ?? m.name) : m.name
}

function materialsRow(ids: (Id | undefined)[], env: InfoEnv, label = 'Материалы'): InfoRow[] {
  const names = [...new Set(ids.map((id) => materialName(id, env)).filter((n): n is string => !!n))]
  return names.length ? [{ label: env.t(names.length > 1 ? label : label === 'Материалы' ? 'Материал' : label), value: names.join(', ') }] : []
}

function nameOf(ref: EntityRef, env: InfoEnv): string | undefined {
  const def = entityKind(ref.kind)
  const o = def && (env.doc as unknown as Record<string, Record<Id, unknown>>)[def.docKey]?.[ref.id]
  if (!def || !o) return undefined
  return def.name(o, {
    doc: env.doc,
    lang: env.lang,
    assetName: (id) => {
      const a = env.doc.assets?.[id] ?? env.catalog.assets.find((e) => e.id === id)
      return a && (env.lang === 'ru' ? (a.nameRu ?? a.name) : a.name)
    },
  })
}

function openingType(o: Opening, env: InfoEnv): string {
  return env.t(WINDOWS.includes(o.kind) ? 'Окно' : o.kind === 'arch' || o.kind === 'opening' ? 'Проём' : 'Дверь')
}

function ceilingOf(roomId: Id, env: InfoEnv): number | undefined {
  const rec = env.doc.rooms[roomId]
  if (rec?.ceiling?.height) return rec.ceiling.height
  const derived = env.plan?.rooms.find((r) => r.roomId === roomId)
  let h = Infinity
  for (const e of derived?.edges ?? []) {
    const w = env.doc.walls[e.wallId]
    if (w && (w.kind === 'wall' || w.kind === 'partition')) h = Math.min(h, w.height)
  }
  if (Number.isFinite(h)) return h
  const lid = rec?.levelId ?? derived?.levelId
  return lid ? env.doc.levels[lid]?.height : undefined
}

/** the card of one object, null when it is not in the document (or is a kind without a card) */
export function elementInfo(ref: EntityRef, env: InfoEnv): ElementInfo | null {
  const { doc, t } = env
  switch (ref.kind) {
    case 'item': {
      const it = doc.items[ref.id]
      if (!it) return null
      const asset = doc.assets?.[it.assetId] ?? env.catalog.assets.find((a) => a.id === it.assetId)
      const rows: InfoRow[] = [{ label: t('Размеры (Ш × Г × В)'), value: sizeText(it.size.w, it.size.d, it.size.h, env) }]
      if (it.elevation > 0) rows.push({ label: t('Над полом'), value: mmText(it.elevation, env) })
      const slots = { ...(asset?.slots ?? {}), ...(it.overrides ?? {}) }
      rows.push(...materialsRow(Object.values(slots), env))
      return { name: nameOf(ref, env) ?? it.assetId, type: asset ? t(categoryName(asset.category)) : t('Предмет'), rows }
    }
    case 'wall': {
      const w = doc.walls[ref.id]
      if (!w) return null
      const g = env.plan?.wallGeoms[ref.id]
      const a = doc.nodes[w.a]
      const b = doc.nodes[w.b]
      const length = g?.length ?? (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0)
      const rows: InfoRow[] = [
        { label: t('Длина'), value: mmText(length, env) },
        { label: t('Толщина'), value: mmText(w.thickness, env) },
        { label: t('Высота'), value: mmText(w.height, env) },
      ]
      if (w.kind !== 'virtual' && w.kind !== 'glazing') rows.push(...materialsRow([w.left.materialId, w.right.materialId, ...[...(w.left.zones ?? []), ...(w.right.zones ?? [])].map((z) => z.materialId)], env, 'Отделка'))
      return { name: nameOf(ref, env) ?? t('Стена'), type: entityKind('wall')?.subtype?.(w, { doc, lang: env.lang }) ?? t('Стена'), rows }
    }
    case 'opening': {
      const o = doc.openings[ref.id]
      if (!o) return null
      const rows: InfoRow[] = [
        { label: t('Ширина'), value: mmText(o.width, env) },
        { label: t('Высота'), value: mmText(o.height, env) },
      ]
      if (o.sill > 0 || WINDOWS.includes(o.kind)) rows.push({ label: t('Подоконник (от пола)'), value: mmText(o.sill, env) })
      rows.push(...materialsRow([o.frameMaterialId, o.leafMaterialId], env))
      return { name: nameOf(ref, env) ?? openingType(o, env), type: openingType(o, env), rows }
    }
    case 'room': {
      const derived = env.plan?.rooms.find((r) => r.roomId === ref.id)
      const rec = doc.rooms[ref.id]
      if (!derived && !rec) return null
      const rows: InfoRow[] = []
      if (derived) {
        rows.push({ label: t('Площадь'), value: m2Text(derived.area, env) })
        rows.push({ label: t('Периметр'), value: mText(derived.perimeter, env) })
      }
      const h = ceilingOf(ref.id, env)
      if (h) rows.push({ label: t('Высота потолка'), value: mmText(h, env) })
      if (rec) {
        const floor = materialName(rec.floor?.materialId, env)
        if (floor) rows.push({ label: t('Пол'), value: floor })
        const ceiling = materialName(rec.ceiling?.materialId, env)
        if (ceiling) rows.push({ label: t('Потолок'), value: ceiling })
      }
      const type = rec ? (ROOM_TYPE_NAMES[rec.type]?.[env.lang] ?? t('Помещение')) : t('Помещение')
      return { name: rec ? (nameOf(ref, env) ?? type) : type, type: t('Помещение'), rows }
    }
    case 'light': {
      const l = doc.lights[ref.id]
      if (!l) return null
      return {
        name: nameOf(ref, env) ?? t('Светильник'),
        type: t('Освещение'),
        rows: [
          { label: t('Над полом'), value: mmText(l.elevation, env) },
          { label: t('Световой поток'), value: `${Math.round(l.lumens)} ${t('лм')}` },
          { label: t('Цветовая температура'), value: `${Math.round(l.temperature)} K` },
        ],
      }
    }
    case 'electric': {
      const p = doc.electrical?.[ref.id]
      if (!p) return null
      // the comment is the author's note for the electrician: never on the card
      return { name: electricName(p, env.lang), type: t('Электрика'), rows: [{ label: t('Высота установки'), value: mmText(p.elevation, env) }] }
    }
    default:
      return null
  }
}

const CATEGORY_RU: Record<string, string> = {
  sofa: 'Диван',
  armchair: 'Кресло',
  chair: 'Стул',
  table: 'Стол',
  bed: 'Кровать',
  storage: 'Хранение',
  kitchen: 'Кухня',
  appliance: 'Техника',
  bathroom: 'Сантехника',
  lighting: 'Светильник',
  decor: 'Декор',
  plant: 'Растение',
  textile: 'Текстиль',
  electronics: 'Электроника',
  outdoor: 'Улица',
  kids: 'Детская',
  office: 'Офис',
  structure: 'Конструкция',
  other: 'Предмет',
}

export function categoryName(category: string): string {
  return CATEGORY_RU[category] ?? 'Предмет'
}

/** English for the card's words (the viewer registers them with its other strings) */
export const ELEMENT_INFO_EN: Record<string, string> = {
  мм: 'mm',
  м: 'm',
  'м²': 'm²',
  лм: 'lm',
  'Размеры (Ш × Г × В)': 'Size (W × D × H)',
  'Над полом': 'Above the floor',
  Материал: 'Material',
  Материалы: 'Materials',
  Отделка: 'Finish',
  Предмет: 'Object',
  Длина: 'Length',
  Толщина: 'Thickness',
  Высота: 'Height',
  Стена: 'Wall',
  Ширина: 'Width',
  'Подоконник (от пола)': 'Sill (above the floor)',
  Окно: 'Window',
  Проём: 'Opening',
  Дверь: 'Door',
  Площадь: 'Area',
  Периметр: 'Perimeter',
  'Высота потолка': 'Ceiling height',
  Пол: 'Floor',
  Потолок: 'Ceiling',
  Помещение: 'Room',
  Светильник: 'Light',
  Освещение: 'Lighting',
  'Световой поток': 'Luminous flux',
  'Цветовая температура': 'Colour temperature',
  Электрика: 'Electrical',
  'Высота установки': 'Mounting height',
  Диван: 'Sofa',
  Кресло: 'Armchair',
  Стул: 'Chair',
  Стол: 'Table',
  Кровать: 'Bed',
  Хранение: 'Storage',
  Кухня: 'Kitchen',
  Техника: 'Appliance',
  Сантехника: 'Bathroom fixture',
  Декор: 'Decor',
  Растение: 'Plant',
  Текстиль: 'Textile',
  Электроника: 'Electronics',
  Улица: 'Outdoor',
  Детская: 'Kids',
  Офис: 'Office',
  Конструкция: 'Structure',
}
