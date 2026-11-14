import type {
  AssetCategory,
  CeilingKind,
  CurtainKind,
  LightKind,
  MaterialCategory,
  MountKind,
  OpeningKind,
  QualityPreset,
  RoomType,
  TilePatternType,
  WallKind,
} from '@core/types'
import { ROOM_TYPE_NAMES } from '@core'
import { t } from '@/i18n'

/** Russian source strings (also the i18n keys); translate with t() at render time */
export const WALL_KIND_RU: Record<WallKind, string> = {
  wall: 'Стена',
  partition: 'Перегородка',
  parapet: 'Парапет',
  glazing: 'Остекление',
  virtual: 'Виртуальная граница',
}

export const OPENING_KIND_RU: Record<OpeningKind, string> = {
  door: 'Дверь',
  doubleDoor: 'Двустворчатая дверь',
  slidingDoor: 'Раздвижная дверь',
  entranceDoor: 'Входная дверь',
  arch: 'Арка',
  opening: 'Проём',
  window: 'Окно',
  frenchWindow: 'Французское окно',
  balconyDoor: 'Балконная дверь',
  balconyBlock: 'Балконный блок',
}

export const WINDOW_KINDS: OpeningKind[] = ['window', 'frenchWindow', 'balconyDoor', 'balconyBlock']
export const DOOR_KINDS: OpeningKind[] = ['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'arch', 'opening']
export const isWindowKind = (k: OpeningKind) => WINDOW_KINDS.includes(k)
/** kinds that have a swinging leaf */
export const hasLeaf = (k: OpeningKind) => k !== 'arch' && k !== 'opening'

export const CURTAIN_KIND_RU: Record<CurtainKind, string> = {
  none: 'Нет',
  drapes: 'Шторы',
  sheer: 'Тюль',
  drapesAndSheer: 'Шторы и тюль',
  roman: 'Римская штора',
  roller: 'Рулонная штора',
  blinds: 'Жалюзи',
}

export const PATTERN_RU: Record<TilePatternType, string> = {
  none: 'Без раскладки',
  grid: 'Прямая',
  brick: 'Вразбежку 1/2',
  brickThird: 'Вразбежку 1/3',
  herringbone: 'Ёлочка',
  chevron: 'Французская ёлка',
  hex: 'Шестигранник',
  basket: 'Плетёнка',
  diagonal: 'Диагональ',
  planks: 'Доска',
}

export const CEILING_KIND_RU: Record<CeilingKind, string> = {
  flat: 'Ровный',
  stretch: 'Натяжной',
  multilevel: 'Многоуровневый',
  coffered: 'Кессонный',
  beams: 'С балками',
}

export const MOUNT_RU: Record<MountKind, string> = {
  floor: 'На полу',
  wall: 'На стене',
  ceiling: 'На потолке',
  surface: 'На поверхности',
  free: 'Свободно',
}

export const MATERIAL_CATEGORY_RU: Record<MaterialCategory, string> = {
  paint: 'Краска',
  wallpaper: 'Обои',
  plaster: 'Штукатурка',
  wood: 'Дерево',
  parquet: 'Паркет',
  laminate: 'Ламинат',
  tile: 'Плитка',
  stone: 'Камень',
  marble: 'Мрамор',
  concrete: 'Бетон',
  brick: 'Кирпич',
  fabric: 'Ткань',
  carpet: 'Ковролин',
  leather: 'Кожа',
  metal: 'Металл',
  glass: 'Стекло',
  plastic: 'Пластик',
  ceiling: 'Потолок',
  outdoor: 'Улица',
  other: 'Прочее',
}

export const MATERIAL_CATEGORIES = Object.keys(MATERIAL_CATEGORY_RU) as MaterialCategory[]

/** categories that make sense for each surface (shown first in pickers) */
export const FLOOR_CATEGORIES: MaterialCategory[] = ['parquet', 'laminate', 'wood', 'tile', 'stone', 'marble', 'concrete', 'carpet']
export const WALL_CATEGORIES: MaterialCategory[] = ['paint', 'wallpaper', 'plaster', 'tile', 'brick', 'wood', 'stone', 'marble', 'concrete']
export const CEILING_CATEGORIES: MaterialCategory[] = ['ceiling', 'paint', 'plaster', 'wood', 'concrete']
export const FABRIC_CATEGORIES: MaterialCategory[] = ['fabric', 'leather', 'plastic']
export const FRAME_CATEGORIES: MaterialCategory[] = ['wood', 'plastic', 'metal', 'paint']

export const ASSET_CATEGORY_RU: Record<AssetCategory, string> = {
  sofa: 'Диваны',
  armchair: 'Кресла',
  chair: 'Стулья',
  table: 'Столы',
  bed: 'Кровати',
  storage: 'Хранение',
  kitchen: 'Кухня',
  appliance: 'Техника',
  bathroom: 'Ванная',
  lighting: 'Светильники',
  decor: 'Декор',
  plant: 'Растения',
  textile: 'Текстиль',
  electronics: 'Электроника',
  outdoor: 'Улица',
  kids: 'Детская',
  office: 'Офис',
  structure: 'Конструкции',
  other: 'Прочее',
}

export const ASSET_CATEGORIES = Object.keys(ASSET_CATEGORY_RU) as AssetCategory[]

export const LIGHT_KIND_RU: Record<LightKind, string> = {
  ceiling: 'Потолочный светильник',
  spot: 'Точечный спот',
  pendant: 'Подвесной светильник',
  point: 'Лампа / бра',
  strip: 'Светодиодная лента',
  area: 'Световая панель',
}

/** defaults used when placing a light of each kind (the editor may override) */
export const LIGHT_DEFAULTS: Record<LightKind, { elevation: number; lumens: number; temperature: number }> = {
  ceiling: { elevation: 2650, lumens: 2000, temperature: 3500 },
  spot: { elevation: 2700, lumens: 450, temperature: 3500 },
  pendant: { elevation: 2000, lumens: 1200, temperature: 2900 },
  point: { elevation: 1500, lumens: 600, temperature: 2700 },
  strip: { elevation: 2600, lumens: 800, temperature: 3000 },
  area: { elevation: 2700, lumens: 3600, temperature: 4000 },
}

export const QUALITY_RU: Record<QualityPreset, string> = {
  low: 'Низкое',
  medium: 'Среднее',
  high: 'Высокое',
  ultra: 'Максимальное',
}

export function roomTypeName(type: RoomType, lang: 'ru' | 'en'): string {
  const n = ROOM_TYPE_NAMES[type]
  return n ? (lang === 'en' ? n.en : n.ru) : type
}

export const ROOM_TYPES = Object.keys(ROOM_TYPE_NAMES) as RoomType[]

/** builds Select options from a Russian label record */
export function optionsOf<T extends string>(rec: Record<T, string>, keys?: readonly T[]): { value: T; label: string }[] {
  return (keys ?? (Object.keys(rec) as T[])).map((k) => ({ value: k, label: t(rec[k]) }))
}
