/** Names of wall and opening kinds the user reads (keys of the translations) */
import type { OpeningKind, WallKind } from '@core/types'

export const OPENING_NAMES: Record<OpeningKind, string> = {
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

export const WALL_KIND_NAMES: Record<WallKind, string> = {
  wall: 'Стена',
  partition: 'Перегородка',
  parapet: 'Парапет',
  glazing: 'Остекление',
  virtual: 'Граница зоны',
}
