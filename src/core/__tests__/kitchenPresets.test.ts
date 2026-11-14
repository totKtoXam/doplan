import { describe, expect, it } from 'vitest'
import { BUILTIN_ASSETS } from '../defaults'
import { KITCHEN_PRESETS, layoutKitchenPreset } from '../kitchenPresets'

const byId = new Map(BUILTIN_ASSETS.map((a) => [a.id, a]))
const lookup = (id: string) => byId.get(id)

describe('kitchen presets', () => {
  it('reference only builtin assets', () => {
    for (const p of KITCHEN_PRESETS) for (const m of p.modules) expect(byId.has(`asset_${m.asset}`), `${p.id}: ${m.asset}`).toBe(true)
  })

  it('floor modules of leg a fill the run without gaps or overlaps', () => {
    for (const p of KITCHEN_PRESETS) {
      const floor = p.modules
        .filter((m) => (m.leg ?? 'a') === 'a')
        .map((m) => ({ m, a: byId.get(`asset_${m.asset}`)! }))
        .filter(({ a }) => a.mount === 'floor' && a.procedural !== 'box')
        .sort((x, y) => x.m.s - y.m.s)
      let end = 0
      for (const { m, a } of floor) {
        expect(m.s, `${p.id}: ${m.asset}`).toBe(end)
        end = m.s + a.size.w
      }
      expect(end, p.id).toBe(p.length)
    }
  })

  it('lays a straight run along +x with fronts looking along n', () => {
    const p = KITCHEN_PRESETS.find((x) => x.id === 'straight_2400')!
    const out = layoutKitchenPreset(p, { p0: { x: 0, y: 0 }, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: 2400 }, lookup)
    const sink = out.find((o) => o.assetId === 'asset_kitchen_base_sink_800')!
    expect(sink).toMatchObject({ x: 400, y: 300, rotation: 0 })
    const wall = out.find((o) => o.assetId === 'asset_kitchen_wall_400')!
    expect(wall).toMatchObject({ x: 2200, y: 160, rotation: 0 })
  })

  it('turns leg b to face back along -x against the far wall', () => {
    const p = KITCHEN_PRESETS.find((x) => x.id === 'corner_2700_2100')!
    const out = layoutKitchenPreset(p, { p0: { x: 0, y: 0 }, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: 2700 }, lookup)
    const oven = out.find((o) => o.assetId === 'asset_kitchen_base_oven_600')!
    expect(oven).toMatchObject({ x: 2400, y: 1200, rotation: 90 })
  })

  it('follows a rotated wall face', () => {
    const p = KITCHEN_PRESETS.find((x) => x.id === 'straight_2400')!
    // wall along +y, room on -x side: n = (-1, 0), item +x = (n.y, -n.x) = (0, 1)
    const out = layoutKitchenPreset(p, { p0: { x: 1000, y: 0 }, x: { x: 0, y: 1 }, n: { x: -1, y: 0 }, length: 2400 }, lookup)
    const sink = out.find((o) => o.assetId === 'asset_kitchen_base_sink_800')!
    expect(sink.x).toBe(700)
    expect(sink.y).toBe(400)
    expect(sink.rotation).toBe(90)
  })
})
