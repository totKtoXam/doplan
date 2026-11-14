import type { Id, Material } from '@core/types'
import { applyStyle, findStyle, type ApplyStyleParts, type ApplyStyleReport } from '@core'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { addTranslations } from '@/i18n'
import { tx } from './catalog'

addTranslations('en', {
  Стиль: 'Style',
  'Стили интерьера': 'Interior styles',
  'Стиль интерьера': 'Interior style',
  'Что менять': 'What to change',
  'Отделка: стены, пол, потолок, плинтус, мокрые зоны, фартук': 'Finishes: walls, floor, ceiling, skirting, wet zones, splashback',
  'Акцентная стена': 'Accent wall',
  'Двери и шторы': 'Doors and curtains',
  'Материалы мебели': 'Furniture materials',
  'Цветовая температура света': 'Light colour temperature',
  'К выбранным помещениям': 'To selected rooms',
  'Ко всей квартире': 'To the whole apartment',
  'Выберите помещения на плане или примените ко всей квартире': 'Select rooms on the plan or apply to the whole apartment',
  'Палитра 60/30/10': '60/30/10 palette',
  'Материалы стиля': 'Style materials',
  'Клик по образцу — кисть этим материалом': 'Click a swatch to paint with that material',
  'Применено: помещений {rooms}, стен {faces}, проёмов {openings}, предметов {items}, светильников {lights}':
    'Applied: {rooms} rooms, {faces} wall faces, {openings} openings, {items} items, {lights} lights',
  'Нет замкнутых помещений': 'No closed rooms',
  Дизайн: 'Design',
  'Без стиля': 'No style',
  'Применить стиль': 'Apply style',
  'Применить стиль к помещению': 'Apply style to the room',
  'Код цвета': 'Colour code',
  'Система цвета': 'Colour system',
  Другая: 'Other',
  'NCS / RAL / код производителя; цвет на экране — приближённый': 'NCS / RAL / brand code; the on-screen colour is approximate',
  Основной: 'Base',
  Вторичный: 'Secondary',
  Акцент: 'Accent',
  Пол: 'Floor',
  Дерево: 'Wood',
  'Стены': 'Walls',
  'Стена-акцент': 'Accent wall',
  'Стены с/у': 'Bathroom walls',
  Фартук: 'Splashback',
  'Пол сухих зон': 'Floor, dry rooms',
  'Пол с/у': 'Floor, bathrooms',
  'Пол прихожей': 'Floor, hallway',
  Потолок: 'Ceiling',
  Плинтус: 'Skirting',
  'Полотно двери': 'Door leaf',
  'Коробка двери': 'Door frame',
  'Мебель, дерево': 'Furniture wood',
  'Фасады': 'Cabinet fronts',
  'Корпус кухни': 'Kitchen carcass',
  Столешница: 'Worktop',
  'Обивка': 'Upholstery',
  'Текстиль-акцент': 'Accent textile',
  Бельё: 'Bed linen',
  Ковёр: 'Rug',
  Шторы: 'Curtains',
  Тюль: 'Sheer',
})

export const STYLE_PART_LABELS: Record<keyof ApplyStyleParts, string> = {
  finishes: 'Отделка: стены, пол, потолок, плинтус, мокрые зоны, фартук',
  accent: 'Акцентная стена',
  openings: 'Двери и шторы',
  furniture: 'Материалы мебели',
  lights: 'Цветовая температура света',
}

export const SWATCH_LABELS = {
  base: 'Основной',
  secondary: 'Вторичный',
  accent: 'Акцент',
  floor: 'Пол',
  wood: 'Дерево',
  metal: 'Металл',
} as const

export const FINISH_LABELS: Record<string, string> = {
  wallMain: 'Стены',
  wallAccent: 'Стена-акцент',
  wallWet: 'Стены с/у',
  apron: 'Фартук',
  floorDry: 'Пол сухих зон',
  floorWet: 'Пол с/у',
  floorHall: 'Пол прихожей',
  ceiling: 'Потолок',
  skirting: 'Плинтус',
  doorLeaf: 'Полотно двери',
  doorFrame: 'Коробка двери',
  woodFurniture: 'Мебель, дерево',
  cabinetFront: 'Фасады',
  kitchenBody: 'Корпус кухни',
  worktop: 'Столешница',
  textileMain: 'Обивка',
  textileAccent: 'Текстиль-акцент',
  linen: 'Бельё',
  metal: 'Металл',
  rug: 'Ковёр',
  curtain: 'Шторы',
  sheer: 'Тюль',
}

/** "NCS S 1002-Y" / "RAL 9010" for coded paints, else '' */
export function colorCodeText(m: Material | undefined): string {
  const c = m?.colorCode
  if (!c) return ''
  return c.system === 'custom' ? c.code : `${c.system} ${c.code}`
}

/** the colour code when the shown name does not already carry it (built-in coded paints do) */
export function extraCodeText(m: Material | undefined, shownName: string): string {
  const code = colorCodeText(m)
  return code && !shownName.includes(m!.colorCode!.code) ? code : ''
}

/** apply a style as one undo step; returns what changed (null if the style is unknown) */
export function applyStyleTo(styleId: Id, rooms: Id[] | 'all', parts?: Partial<ApplyStyleParts>): ApplyStyleReport | null {
  const style = findStyle(styleId)
  if (!style) return null
  const derived = docStore.getState().derived
  const catalog = uiStore.getState().catalog
  let report: ApplyStyleReport | null = null
  tx(`Стиль «${style.nameRu}»`, (d) => {
    report = applyStyle(d, style, { rooms, parts, catalog, derived })
  })
  return report
}
