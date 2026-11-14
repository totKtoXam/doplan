import { describe, expect, it } from 'vitest'
import {
  clampItemSize,
  convexOverlapArea,
  faceTargets,
  findSupport,
  footprintEdges,
  itemFootprint,
  minItemSize,
  mountForElevation,
  planResizeTargets,
  resizeFromFace,
  resizedParams,
  snapValue,
  supportCoverage,
  wallFaceSegments,
  type ItemPose,
  type SupportCandidate,
} from '../manipulate'
import { createEmptyDoc } from '../defaults'
import { parseDoc, serializeDoc } from '../io'
import type { Asset } from '../types'

const pose = (x: number, y: number, rotation: number, w: number, d: number, h: number, elevation = 0): ItemPose => ({ x, y, rotation, elevation, size: { w, d, h } })

/** plan position of the face centre along an axis */
function faceCentre(p: ItemPose, axis: 'w' | 'd', side: 1 | -1) {
  const c = Math.cos((p.rotation * Math.PI) / 180)
  const s = Math.sin((p.rotation * Math.PI) / 180)
  const half = p.size[axis] / 2
  return axis === 'w' ? { x: p.x + c * half * side, y: p.y + s * half * side } : { x: p.x - s * half * side, y: p.y + c * half * side }
}

describe('resizeFromFace', () => {
  it('stretches a bar counter to the right, its left end stays put', () => {
    const p = pose(1000, 500, 0, 1600, 450, 60, 1000)
    const r = resizeFromFace(p, 'w', 1, 2000)
    expect(r.size).toEqual({ w: 2000, d: 450, h: 60 })
    expect(r.x).toBeCloseTo(1200)
    expect(r.y).toBeCloseTo(500)
    expect(r.elevation).toBe(1000)
    expect(faceCentre(r, 'w', -1).x).toBeCloseTo(faceCentre(p, 'w', -1).x)
  })

  it('keeps the opposite face in the rotated frame', () => {
    for (const rot of [0, 30, 90, 135, 217, 300]) {
      for (const axis of ['w', 'd'] as const) {
        for (const side of [1, -1] as const) {
          const p = pose(-300, 700, rot, 800, 600, 900)
          const r = resizeFromFace(p, axis, side, p.size[axis] + 437)
          const a = faceCentre(p, axis, -side as 1 | -1)
          const b = faceCentre(r, axis, -side as 1 | -1)
          expect(b.x).toBeCloseTo(a.x, 6)
          expect(b.y).toBeCloseTo(a.y, 6)
          // the moved face went out by the size change
          const m0 = faceCentre(p, axis, side)
          const m1 = faceCentre(r, axis, side)
          expect(Math.hypot(m1.x - m0.x, m1.y - m0.y)).toBeCloseTo(437, 6)
        }
      }
    }
  })

  it('top handle keeps the bottom, bottom handle keeps the top', () => {
    const p = pose(0, 0, 0, 800, 300, 2000, 100)
    const up = resizeFromFace(p, 'h', 1, 2200)
    expect(up.elevation).toBe(100)
    expect(up.size.h).toBe(2200)
    const down = resizeFromFace(p, 'h', -1, 2200)
    expect(down.elevation + down.size.h).toBe(2100)
  })

  it('clamps to the minimum', () => {
    const r = resizeFromFace(pose(0, 0, 0, 600, 600, 900), 'w', 1, 10, { min: { w: 150, d: 250, h: 300 } })
    expect(r.size.w).toBe(150)
    expect(r.x).toBeCloseTo(-225)
  })

  it('proportion lock scales every axis, the other plan axis stays centred, the bottom stays', () => {
    const p = pose(0, 0, 90, 1000, 500, 400, 50)
    const r = resizeFromFace(p, 'w', 1, 1500, { lockRatio: true })
    expect(r.size.w).toBeCloseTo(1500)
    expect(r.size.d).toBeCloseTo(750)
    expect(r.size.h).toBeCloseTo(600)
    expect(r.elevation).toBe(50)
    // rotated 90°: width runs along +y; the left face (y = −500) is fixed
    expect(r.y).toBeCloseTo(250)
    expect(r.x).toBeCloseTo(0)
  })

  it('wall items keep their back against the wall', () => {
    const p = pose(0, 100, 0, 800, 200, 300, 1500)
    const r = resizeFromFace(p, 'w', 1, 1600, { lockRatio: true, fixedBack: true })
    // back face at y = 0 (front is +y at θ = 0)
    expect(r.y - r.size.d / 2).toBeCloseTo(0)
  })
})

describe('snapping', () => {
  it('finds a wall face parallel to the moving face', () => {
    const p = pose(1000, 1000, 0, 1600, 450, 60)
    // a wall face at x = 2000 running along y, and one at y = 2000 (perpendicular: ignored)
    const t = faceTargets(p, 'w', 1, [{ a: { x: 2000, y: 0 }, b: { x: 2000, y: 3000 } }, { a: { x: 0, y: 2000 }, b: { x: 3000, y: 2000 } }], 'wall')
    expect(t).toEqual([{ value: 1800, kind: 'wall' }])
  })

  it('ignores segments that do not overlap the face laterally and those behind the fixed face', () => {
    const p = pose(0, 0, 0, 1000, 400, 500)
    const segs = [
      { a: { x: 900, y: 1000 }, b: { x: 900, y: 2000 } }, // off to the side
      { a: { x: -900, y: -100 }, b: { x: -900, y: 100 } }, // behind the left (fixed) face
    ]
    expect(faceTargets(p, 'w', 1, segs, 'wall')).toEqual([])
  })

  it('works in a rotated frame with other items’ edges', () => {
    const p = pose(0, 0, 90, 1000, 400, 500)
    const other = pose(0, 1500, 90, 1000, 400, 500)
    // at 90° the +w face looks at +y; the other item's near edge is at y = 1000
    const t = faceTargets(p, 'w', 1, footprintEdges(other), 'item')
    expect(t.map((x) => Math.round(x.value)).sort((a, b) => a - b)).toEqual([1500, 2500])
  })

  it('snapValue prefers targets within tolerance, then the step', () => {
    expect(snapValue(1792, [{ value: 1800, kind: 'wall' }], 20, 50)).toEqual({ value: 1800, kind: 'wall' })
    expect(snapValue(1730, [{ value: 1800, kind: 'wall' }], 20, 50)).toEqual({ value: 1750, kind: 'grid' })
    expect(snapValue(1730.4, [], 20)).toEqual({ value: 1730, kind: null })
  })
})

describe('stacking', () => {
  const stand: SupportCandidate = { id: 'stand', x: 0, y: 0, rotation: 0, size: { w: 1600, d: 400, h: 450 }, elevation: 0, mount: 'floor' }
  const rug: SupportCandidate = { id: 'rug', x: 0, y: 0, rotation: 0, size: { w: 3000, d: 2000, h: 10 }, elevation: 0, mount: 'floor' }

  it('overlap of rotated rectangles', () => {
    const a = itemFootprint(pose(0, 0, 0, 100, 100, 1))
    const b = itemFootprint(pose(50, 0, 0, 100, 100, 1))
    expect(convexOverlapArea(a, b)).toBeCloseTo(5000)
    const c = itemFootprint(pose(0, 0, 45, 100, 100, 1))
    // a square and the same square turned 45°: a regular octagon
    expect(convexOverlapArea(a, c)).toBeCloseTo(100 * 100 * 2 * (Math.SQRT2 - 1), 3)
  })

  it('a TV on a stand gets the stand top; rugs do not count', () => {
    const tv = pose(100, 0, 0, 1200, 250, 700)
    expect(findSupport(tv, [stand, rug])).toEqual({ top: 450, cover: 1 })
    const beside = pose(1500, 0, 0, 1200, 250, 700)
    expect(findSupport(beside, [stand, rug])).toBeNull()
  })

  it('a bar counter across three base units sums their tops', () => {
    const units: SupportCandidate[] = [-600, 0, 600].map((x, i) => ({ id: `u${i}`, x, y: 0, rotation: 0, size: { w: 600, d: 600, h: 900 }, elevation: 0, mount: 'floor' }))
    const counter = pose(0, 0, 0, 1600, 450, 40)
    expect(supportCoverage(counter, units, 900)).toBeCloseTo(1)
    expect(findSupport(counter, units)?.top).toBe(900)
  })

  it('maxTop picks the surface below the item, exclude skips itself', () => {
    const table: SupportCandidate = { id: 'table', x: 0, y: 0, rotation: 0, size: { w: 1200, d: 800, h: 750 }, elevation: 0, mount: 'floor' }
    const shelf: SupportCandidate = { id: 'shelf', x: 0, y: 0, rotation: 0, size: { w: 1200, d: 300, h: 30 }, elevation: 1500, mount: 'wall' }
    const vase = pose(0, 0, 0, 150, 150, 300, 800)
    expect(findSupport(vase, [table, shelf], { maxTop: 800 })?.top).toBe(750)
    expect(findSupport(vase, [table, shelf])?.top).toBe(1530)
    expect(findSupport({ ...table, size: table.size }, [table], { exclude: new Set(['table']) })).toBeNull()
  })

  it('mount follows the elevation', () => {
    expect(mountForElevation('floor', 300, false)).toBe('free')
    expect(mountForElevation('floor', 450, true)).toBe('surface')
    expect(mountForElevation('free', 0, false)).toBe('free')
    expect(mountForElevation('wall', 1500, true)).toBe('wall')
    expect(mountForElevation('floor', 0, false)).toBe('floor')
  })
})

describe('per-type sizes and params', () => {
  const base: Pick<Asset, 'kind' | 'procedural' | 'defaultParams'> = { kind: 'procedural', procedural: 'kitchenBase', defaultParams: { doors: 1, drawers: 0, plinth: 100, worktop: true } }

  it('a stretched base unit gets more doors, a drawer unit keeps none', () => {
    expect(resizedParams(base, undefined, { w: 600, d: 600, h: 900 }, { w: 1200, d: 600, h: 900 })).toEqual({ doors: 2 })
    expect(resizedParams(base, { doors: 2 }, { w: 800, d: 600, h: 900 }, { w: 400, d: 600, h: 900 })).toEqual({ doors: 1 })
    expect(resizedParams(base, undefined, { w: 600, d: 600, h: 900 }, { w: 650, d: 600, h: 900 })).toBeUndefined()
    const drawers = { ...base, defaultParams: { doors: 0, drawers: 3 } }
    expect(resizedParams(drawers, undefined, { w: 600, d: 600, h: 900 }, { w: 1200, d: 600, h: 900 })).toBeUndefined()
    const corner = { ...base, defaultParams: { doors: 1, corner: true } }
    expect(resizedParams(corner, undefined, { w: 900, d: 900, h: 900 }, { w: 1800, d: 900, h: 900 })).toBeUndefined()
  })

  it('shelving spreads shelves over the height, models are left alone', () => {
    const shelf: Pick<Asset, 'kind' | 'procedural' | 'defaultParams'> = { kind: 'procedural', procedural: 'shelf', defaultParams: { shelves: 5, back: true } }
    expect(resizedParams(shelf, { back: false }, { w: 800, d: 300, h: 2000 }, { w: 800, d: 300, h: 1000 })).toEqual({ back: false, shelves: 3 })
    expect(resizedParams({ kind: 'model' }, undefined, { w: 1, d: 1, h: 1 }, { w: 2, d: 2, h: 2 })).toBeUndefined()
  })

  it('minimum sizes', () => {
    expect(minItemSize(base).w).toBe(150)
    expect(clampItemSize({ w: 10, d: 10, h: 10 }, undefined)).toEqual({ w: 20, d: 10, h: 10 })
  })
})

describe('free mount in files', () => {
  it('reads «free» and its aliases, lifts floor items with an elevation', () => {
    const doc = createEmptyDoc()
    const lid = doc.levelOrder[0]
    const raw = JSON.parse(serializeDoc(doc))
    const it = (id: string, mount: string, elevation: number) => ({ id, levelId: lid, assetId: 'asset_box', x: 0, y: 0, elevation, rotation: 0, size: { w: 1, d: 1, h: 1 }, mount })
    raw.items = { i_a: it('i_a', 'free', 300), i_b: it('i_b', 'floating', 0), i_c: it('i_c', 'floor', 150), i_d: it('i_d', 'floor', 0), i_e: it('i_e', 'wall', 1500) }
    const back = parseDoc(raw)
    expect(back.items.i_a.mount).toBe('free')
    expect(back.items.i_b.mount).toBe('free')
    expect(back.items.i_c.mount).toBe('free')
    expect(back.items.i_d.mount).toBe('floor')
    expect(back.items.i_e.mount).toBe('wall')
  })
})

describe('planResizeTargets', () => {
  it('offers the wall face and a neighbour edge, skipping self, hidden and ceiling items', () => {
    // counter 1000 wide centred at x=1000 → right face at 1500, fixed left face at 500
    const p = pose(1000, 1000, 0, 1000, 400, 900)
    const walls = wallFaceSegments(
      { w1: { levelId: 'L', kind: 'wall' }, w2: { levelId: 'L', kind: 'virtual' }, w3: { levelId: 'X', kind: 'wall' } },
      {
        w1: { left: [{ x: 3000, y: 0 }, { x: 3000, y: 3000 }], right: [{ x: 3200, y: 0 }, { x: 3200, y: 3000 }], length: 3000 },
        w2: { left: [{ x: 2000, y: 0 }, { x: 2000, y: 3000 }], right: [{ x: 2000, y: 0 }, { x: 2000, y: 3000 }], length: 3000 },
        w3: { left: [{ x: 2500, y: 0 }, { x: 2500, y: 3000 }], right: [{ x: 2500, y: 0 }, { x: 2500, y: 3000 }], length: 3000 },
      },
      'L',
    )
    expect(walls).toHaveLength(2)
    const item = (id: string, x: number, extra: object = {}) => ({ id, x, y: 1000, rotation: 0, size: { w: 600, d: 600, h: 850 }, mount: 'floor' as const, ...extra })
    const targets = planResizeTargets(p, 'w', 1, {
      walls,
      items: [item('self', 1000), item('n', 2100), item('hid', 1900, { hidden: true }), item('ceil', 1700, { mount: 'ceiling' })],
      selfId: 'self',
    })
    const values = targets.map((t) => `${t.kind}:${Math.round(t.value)}`).sort()
    // wall faces at 3000 / 3200 → 2500 / 2700; neighbour's edges at 1800 / 2400 → 1300 / 1900
    expect(values).toEqual(['item:1300', 'item:1900', 'wall:2500', 'wall:2700'])
    expect(snapValue(1310, targets, 20).value).toBe(1300)
  })
})
