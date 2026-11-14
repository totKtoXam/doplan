import { describe, expect, it } from 'vitest'
import { isTechnicalRoom, summarizeLevelRooms, summarizeRoomAreas } from '../area'
import type { DerivedRoom, Room } from '../types'

describe('summarizeRoomAreas (BTI rules)', () => {
  it('applies balcony ×0.3 / loggia ×0.5 and sums living rooms', () => {
    const s = summarizeRoomAreas([
      { type: 'living', area: 18 },
      { type: 'bedroom', area: 12 },
      { type: 'kitchen', area: 9 },
      { type: 'bathroom', area: 4 },
      { type: 'loggia', area: 4 },
      { type: 'balcony', area: 3 },
    ])
    expect(s.count).toBe(6)
    expect(s.total).toBe(18 + 12 + 9 + 4 + 4 * 0.5 + 3 * 0.3)
    expect(s.living).toBe(30)
    expect(s.outdoor).toBe(7)
    expect(s.technicalCount).toBe(0)
  })

  it('excludes ventilation shafts (< 1 m², other/storage/untyped) from count and totals', () => {
    const s = summarizeRoomAreas([
      { type: 'living', area: 20 },
      { type: 'other', area: 0.35 },
      { area: 0.7 },
      { type: 'storage', area: 0.5 },
      // a real small room of a specific type is kept
      { type: 'toilet', area: 0.9 },
      // ≥ 1 m² "other" is a room, not a shaft
      { type: 'other', area: 1.2 },
    ])
    expect(s.count).toBe(3)
    expect(s.technicalCount).toBe(3)
    expect(s.total).toBe(22.1)
    expect(s.living).toBe(20)
    expect(s.outdoor).toBe(0)
  })

  it('rounds to 0.01 m² and handles an empty level', () => {
    expect(summarizeRoomAreas([{ type: 'kitchen', area: 1 / 3 + 5 }]).total).toBe(5.33)
    expect(summarizeRoomAreas([])).toEqual({ count: 0, total: 0, living: 0, outdoor: 0, technicalCount: 0 })
  })

  it('isTechnicalRoom mirrors the PlanSpec rule', () => {
    expect(isTechnicalRoom(undefined, 0.4)).toBe(true)
    expect(isTechnicalRoom('other', 0.99)).toBe(true)
    expect(isTechnicalRoom('other', 1)).toBe(false)
    expect(isTechnicalRoom('wardrobe', 0.8)).toBe(false)
  })
})

describe('summarizeLevelRooms', () => {
  it('takes types from Room records; unmatched faces count as untyped', () => {
    const dr = (roomId: string, area: number) => ({ roomId, area }) as DerivedRoom
    const rooms = { r1: { id: 'r1', type: 'loggia' } as Room, r2: { id: 'r2', type: 'kids' } as Room }
    const s = summarizeLevelRooms({ rooms }, [dr('r1', 6), dr('r2', 10), dr('auto_x', 0.3), dr('auto_y', 5)])
    expect(s).toEqual({ count: 3, total: 18, living: 10, outdoor: 6, technicalCount: 1 })
  })
})
