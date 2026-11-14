import { describe, expect, it } from 'vitest'
import type { Asset } from '@core/types'
import { BUILTIN_ASSETS } from '@core/defaults'
import { footprintPolygon, sketchKind } from '../symbols'

const byId = (id: string) => BUILTIN_ASSETS.find((a) => a.id === id)!

describe('2D footprints', () => {
  it('draws the L corner base unit as an L (side leg on the corner side)', () => {
    const a = byId('asset_kitchen_base_corner_l_900')
    const left = footprintPolygon(a, { cornerSide: 'left' }, 900, 900)!
    expect(left).toHaveLength(6)
    // legs 600 deep: the notch is the 300 × 300 square at the front, away from the corner side
    expect(left).toContainEqual([150, 450])
    expect(left).toContainEqual([450, 150])
    expect(left).toContainEqual([150, 150])
    const right = footprintPolygon(a, { cornerSide: 'right' }, 900, 900)!
    expect(right).toContainEqual([-150, 450])
    expect(right).toContainEqual([-450, 150])
  })

  it('keeps plain rectangles for ordinary units', () => {
    expect(footprintPolygon(byId('asset_kitchen_base_600'), undefined, 600, 600)).toBeNull()
  })

  it('picks sketches for models by id and for TV variants', () => {
    const model = (id: string, category: Asset['category']): Asset => ({ id, name: id, category, kind: 'model', size: { w: 1, d: 1, h: 1 }, mount: 'floor' })
    expect(sketchKind(model('asset_sf_toilet_adb3', 'bathroom'))).toBe('toilet')
    expect(sketchKind(model('asset_sf_curtain_7187', 'textile'))).toBe('curtain')
    expect(sketchKind(byId('asset_soundbar'))).toBe('soundbar')
    expect(sketchKind(byId('asset_tv_55_stand'))).toBe('tv')
  })
})
