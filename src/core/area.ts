/**
 * Room area summary the way Russian BTI / SP 54.13330 counts it:
 * - общая площадь = heated rooms + balcony ×0.3 + loggia ×0.5 (summer rooms with reduction coefficients);
 * - жилая площадь = living rooms only (living / bedroom / kids / office);
 * - technical closed areas (ventilation shafts, risers, boxed niches: < 1 m², type other/storage)
 *   are not rooms — they are excluded from the count and from every total; so is a room marked
 *   `technical` (a shaft / box void cut out of a room by a PlanSpec, any size).
 * Mirrors the PlanSpec metrics in planspec.ts (AREA_COEF / LIVING_TYPES / the `technical` rule).
 */
import type { Doc, DerivedRoom, RoomType } from './types'

/** reduction coefficients of summer rooms for общая площадь */
export const ROOM_AREA_COEF: Partial<Record<RoomType, number>> = { balcony: 0.3, loggia: 0.5 }
/** room types that make up жилая площадь */
export const LIVING_ROOM_TYPES: readonly RoomType[] = ['living', 'bedroom', 'kids', 'office']
/** closed areas below this (m²) with a non-specific type are technical (shafts, risers) */
export const TECHNICAL_ROOM_MAX_AREA = 1

export const isOutdoorRoomType = (type: RoomType | undefined): boolean => type !== undefined && ROOM_AREA_COEF[type] !== undefined

/** shaft / riser / boxed niche: no specific purpose and a tiny area or an explicit `technical` mark */
export function isTechnicalRoom(type: RoomType | undefined, area: number, technical = false): boolean {
  return (technical || area < TECHNICAL_ROOM_MAX_AREA) && (type === undefined || type === 'other' || type === 'storage')
}

export interface RoomAreaSummary {
  /** rooms that count (technical areas excluded) */
  count: number
  /** общая площадь with coefficients (balcony ×0.3, loggia ×0.5), m² */
  total: number
  /** жилая площадь, m² */
  living: number
  /** balconies + loggias at their actual (unreduced) area, m² */
  outdoor: number
  /** technical areas left out of count and totals */
  technicalCount: number
}

const r2 = (v: number): number => Math.round(v * 100) / 100

/** Summarise rooms given as {type, area m²}. `type` undefined = unassigned (treated like 'other'). */
export function summarizeRoomAreas(rooms: readonly { type?: RoomType; area: number; technical?: boolean }[]): RoomAreaSummary {
  let count = 0
  let total = 0
  let living = 0
  let outdoor = 0
  let technicalCount = 0
  for (const r of rooms) {
    if (isTechnicalRoom(r.type, r.area, r.technical)) {
      technicalCount++
      continue
    }
    count++
    const coef = r.type !== undefined ? ROOM_AREA_COEF[r.type] : undefined
    if (coef !== undefined) outdoor += r.area
    total += r.area * (coef ?? 1)
    if (r.type !== undefined && LIVING_ROOM_TYPES.includes(r.type)) living += r.area
  }
  return { count, total: r2(total), living: r2(living), outdoor: r2(outdoor), technicalCount }
}

/** Summarise a level's derived rooms, taking room types from the doc's Room records. */
export function summarizeLevelRooms(doc: Pick<Doc, 'rooms'>, rooms: readonly DerivedRoom[]): RoomAreaSummary {
  return summarizeRoomAreas(rooms.map((r) => ({ type: doc.rooms[r.roomId]?.type, area: r.area, technical: doc.rooms[r.roomId]?.technical })))
}
