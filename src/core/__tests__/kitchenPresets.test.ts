import { describe, expect, it } from 'vitest'
import { BUILTIN_ASSETS, createEmptyDoc } from '../defaults'
import { derivePlan } from '../derive'
import { checkPresetFit, faceOfRun, KITCHEN_PRESETS, layoutKitchenPreset } from '../kitchenPresets'
import { addWall, normalize, syncRooms } from '../ops'
import { roomEdgeRuns } from '../provenance'

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

  it('keeps both legs of an L set meeting in the corner on a wall longer than the preset', () => {
    const p = KITCHEN_PRESETS.find((x) => x.id === 'corner_2700_2100')!
    for (const L of [2700, 3500, 4210]) {
      const out = layoutKitchenPreset(p, { p0: { x: 0, y: 0 }, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: L }, lookup)
      const corner = out.find((o) => o.assetId === 'asset_kitchen_base_corner_l_900')!
      // corner unit 900 wide: its right edge touches the side wall at u = L
      expect(corner.x + 450, `L=${L}`).toBe(L)
      // leg b: the oven backs against the side wall (depth 600 → centre 300 from it), right after the 900 wing
      const oven = out.find((o) => o.assetId === 'asset_kitchen_base_oven_600')!
      expect(oven, `L=${L}`).toMatchObject({ x: L - 300, y: 1200, rotation: 90 })
      // leg b wall units hang on the same side wall
      const hood = out.find((o) => o.assetId === 'asset_kitchen_wall_hood_600')!
      expect(hood.x + byId.get('asset_kitchen_wall_hood_600')!.size.d / 2, `L=${L}`).toBe(L)
      // the run of leg a still has no gaps: the fridge starts L - 2700 from p0
      const fridge = out.find((o) => o.assetId === 'asset_kitchen_tall_fridge_600')!
      expect(fridge.x - 300, `L=${L}`).toBe(L - 2700)
    }
  })

  it('reports a set longer than the wall or deeper than the room', () => {
    const face = (L: number) => ({ p0: { x: 0, y: 0 }, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: L })
    const straight = KITCHEN_PRESETS.find((x) => x.id === 'straight_2400')!
    expect(checkPresetFit(straight, face(2000), lookup)).toEqual({ ok: false, reason: 'length', need: 2400, have: 2000 })
    expect(checkPresetFit(straight, face(2400), lookup)).toEqual({ ok: true })
    const island = KITCHEN_PRESETS.find((x) => x.id === 'island_3000')!
    const room = (w: number, h: number) => ({ polygon: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] })
    const shallow = checkPresetFit(island, face(3500), lookup, room(3500, 2500))
    expect(shallow).toMatchObject({ ok: false, reason: 'depth', have: 2500 })
    expect(checkPresetFit(island, face(3500), lookup, room(3500, 3600))).toEqual({ ok: true })
    const corner = KITCHEN_PRESETS.find((x) => x.id === 'corner_2700_2100')!
    expect(checkPresetFit(corner, face(3000), lookup, room(3000, 1800))).toMatchObject({ ok: false, reason: 'depth', need: 2100, have: 1800 })
    expect(checkPresetFit(corner, face(3000), lookup, room(3000, 2400))).toEqual({ ok: true })
  })

  it('takes the room side from the run normal, also for a reflex wall of an L-shaped room', () => {
    const doc = createEmptyDoc('t')
    const lv = doc.levelOrder[0]
    // L-shaped room: 6000 × 4000 with the top-right 3000 × 2000 cut away
    const pts = [
      { x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 }, { x: 6000, y: 2000 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 },
    ]
    for (let i = 0; i < pts.length; i++) addWall(doc, lv, pts[i], pts[(i + 1) % pts.length], { thickness: 100 })
    normalize(doc)
    syncRooms(doc)
    const plan = derivePlan(doc, lv)
    expect(plan.rooms).toHaveLength(1)
    const runs = roomEdgeRuns(plan.rooms[0])
    // the inner step wall x = 3000, y 0…2000: the room lies at x < 3000
    const step = runs.find((r) => Math.abs(r.a.x - 2950) < 1 && Math.abs(r.b.x - 2950) < 1)!
    const f = faceOfRun(step)
    expect(f.n.x).toBeCloseTo(-1)
    // the bottom wall: room above it (y < 3950)
    const bottom = runs.find((r) => Math.abs(r.a.y - 3950) < 1 && Math.abs(r.b.y - 3950) < 1)!
    expect(faceOfRun(bottom).n.y).toBeCloseTo(-1)
    // p0 is the left end seen from the room, so +x runs to the viewer's right
    const fb = faceOfRun(bottom)
    expect(fb.x.x).toBeCloseTo(-1)
    expect(fb.p0.x).toBeCloseTo(5950)
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
