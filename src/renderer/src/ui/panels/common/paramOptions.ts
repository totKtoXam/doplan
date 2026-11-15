import type { ProceduralKind } from '@core/types'

/**
 * Choice lists for string params of procedural generators, so the inspector can show a select
 * instead of a free text field. Values must match the generators' `c.str(key, def, allowed)` lists.
 */
const HANDLE = ['bar', 'knob', 'edge', 'cup', 'gola', 'none'] as const
const FRONT = ['flat', 'shaker', 'classic'] as const
const SIDE = ['left', 'right'] as const

const BY_KIND: Partial<Record<ProceduralKind, Record<string, readonly string[]>>> = {
  kitchenBase: {
    layout: ['doors', 'drawers', 'mixed', 'glass', 'dishwasher', 'oven', 'open'],
    cutout: ['none', 'sink', 'hob'],
    hob: ['induction', 'gas', 'electric'],
    cornerType: ['blind', 'L'],
    cornerSide: SIDE,
    handle: HANDLE,
    frontStyle: FRONT,
  },
  kitchenWall: {
    layout: ['doors', 'glass', 'lift', 'lift2', 'open'],
    cornerType: ['blind', 'L'],
    cornerSide: SIDE,
    handle: HANDLE,
    frontStyle: FRONT,
  },
  kitchenTall: {
    layout: ['doors', 'oven', 'fridge', 'pantry'],
    handle: HANDLE,
    frontStyle: FRONT,
  },
  wardrobe: { doorType: ['hinged', 'sliding'], handle: HANDLE, frontStyle: FRONT },
  hood: { type: ['chimney', 'flat', 'inclined', 'island'], style: ['chimney', 'flat', 'inclined', 'island'] },
  tv: { variant: ['tv', 'soundbar', 'bracket'], standStyle: ['pedestal', 'feet'] },
  dishwasher: { handle: HANDLE },
  fridge: { layout: ['bottomFreezer', 'topFreezer', 'sideBySide', 'single'], hinge: SIDE },
  stove: { type: ['gas', 'induction', 'electric'] },
  shelf: { style: ['bookcase', 'floating', 'ladder'] },
  radiator: { type: ['sectional', 'panel', 'ladder'] },
}

export const PARAM_VALUE_RU: Record<string, string> = {
  doors: 'Дверцы',
  drawers: 'Ящики',
  mixed: 'Ящик + дверцы',
  glass: 'Стекло',
  dishwasher: 'Под посудомойку',
  oven: 'Под духовку',
  open: 'Открытая',
  lift: 'Подъёмный фасад',
  lift2: 'Два подъёмных фасада',
  fridge: 'Под холодильник',
  pantry: 'Ящики снизу + дверцы',
  none: 'Нет',
  sink: 'Мойка',
  hob: 'Варочная панель',
  induction: 'Индукция',
  gas: 'Газ',
  electric: 'Электро',
  blind: 'Глухой угол',
  L: 'Г-образный',
  left: 'Слева',
  right: 'Справа',
  bar: 'Рейлинг',
  knob: 'Кнопка',
  edge: 'Профиль на торце',
  cup: 'Ракушка',
  gola: 'Gola (без ручек)',
  flat: 'Гладкие',
  shaker: 'Шейкер (рамка)',
  classic: 'Классика (филёнка)',
  hinged: 'Распашные',
  sliding: 'Раздвижные',
  chimney: 'Купольная',
  inclined: 'Наклонная',
  island: 'Островная',
  tv: 'Телевизор',
  soundbar: 'Саундбар',
  bracket: 'Кронштейн',
  pedestal: 'Центральная',
  feet: 'Ножки',
  bottomFreezer: 'Морозилка снизу',
  topFreezer: 'Морозилка сверху',
  sideBySide: 'Side-by-side',
  single: 'Однокамерный',
  bookcase: 'Стеллаж',
  floating: 'Скрытый крепёж',
  ladder: 'Лесенка',
  sectional: 'Секционный',
  panel: 'Панельный',
}

/** select options for a string param of a procedural asset, or undefined for a free text field */
export function paramChoices(kind: ProceduralKind | undefined, key: string): readonly string[] | undefined {
  if (!kind) return undefined
  return BY_KIND[kind]?.[key]
}

/** the flat-front 'hood' adapter treats 'flat' as built-under; label it accordingly */
export function paramValueLabel(kind: ProceduralKind | undefined, key: string, v: string): string {
  if (kind === 'hood' && v === 'flat') return 'Встраиваемая'
  if (kind === 'kitchenWall' && key === 'layout' && v === 'open') return 'Открытая полка'
  return PARAM_VALUE_RU[v] ?? v
}
