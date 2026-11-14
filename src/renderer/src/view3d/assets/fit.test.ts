import { describe, expect, it } from 'vitest'
import { aspectMismatch, fitScale, pickVariant, type NamedBox, type Vec3 } from './fit'

const box = (name: string, min: Vec3, size: Vec3): NamedBox => ({ name, min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] })

describe('pickVariant', () => {
  it('keeps variant a of a lettered collection laid out in a row', () => {
    const roots = [
      box('pachira_bark_a', [-2.1, 0, -0.1], [0.2, 0.85, 0.2]),
      box('pachira_bark_b', [0, 0, 0], [0.15, 0.6, 0.2]),
      box('pachira_bark_c', [1.8, 0, -0.3], [0.6, 1, 0.5]),
      box('pachira_leaves_a', [-2.3, 0.5, -0.3], [0.74, 0.74, 0.65]),
      box('pachira_leaves_b', [-0.2, 0.2, -0.2], [0.5, 0.5, 0.6]),
      box('pachira_leaves_c', [1.6, 0.25, -0.5], [1, 0.9, 0.9]),
    ]
    expect(pickVariant(roots)).toEqual([0, 3])
  })

  it('keeps the base of a two-model collection (clean + rusted)', () => {
    const roots = [box('aircon', [-0.9, 0, 0], [0.8, 0.93, 0.37]), box('aircon_rusted', [0.1, 0, 0], [0.8, 0.93, 0.37])]
    expect(pickVariant(roots)).toEqual([0])
  })

  it('leaves real multi-part models alone', () => {
    // lid overlaps the body
    expect(pickVariant([box('pot', [0, 0, 0], [0.26, 0.15, 0.18]), box('pot_lid', [0, 0.15, 0], [0.26, 0.03, 0.18])])).toBeNull()
    // left/right doors are not variants
    expect(pickVariant([box('cab_door_l', [0, 0, 0], [0.5, 2, 0.02]), box('cab_door_r', [0.5, 0, 0], [0.5, 2, 0.02])])).toBeNull()
    // a set of similar but differently named parts (books, bottles)
    expect(pickVariant([box('book01', [0, 0, 0], [0.05, 0.2, 0.15]), box('book02', [0.06, 0, 0], [0.05, 0.2, 0.15]), box('book03', [0.12, 0, 0], [0.05, 0.2, 0.15])])).toBeNull()
    // a table and a chair: different extents
    expect(pickVariant([box('set', [0, 0, 0], [1, 0.75, 1]), box('set_chair', [1.5, 0, 0], [0.5, 0.9, 0.5])])).toBeNull()
  })
})

describe('fitScale', () => {
  const model: Vec3 = [0.5, 1, 0.4] // w, h, d in metres

  it('stretches per axis when the catalog size has the model proportions', () => {
    const r = fitScale(model, { w: 1000, h: 2000, d: 800 }, { w: 500, h: 1000, d: 400 })
    expect(r.uniform).toBe(false)
    expect(r.scale).toEqual([2, 2, 2])
    // a user resize of one axis still stretches that axis
    expect(fitScale(model, { w: 600, h: 1000, d: 400 }, { w: 500, h: 1000, d: 400 }).scale[0]).toBeCloseTo(1.2)
  })

  it('scales uniformly inside the catalog box when its proportions are wrong', () => {
    // catalog says 2 m tall for a 1 m model whose footprint is right: keep proportions, fit in the box
    const cat = { w: 500, h: 2000, d: 400 }
    const r = fitScale(model, cat, cat)
    expect(r.uniform).toBe(true)
    expect(r.mismatch).toBeCloseTo(2)
    expect(r.scale[0]).toBeCloseTo(1)
    expect(r.scale[1]).toBeCloseTo(1)
    expect(r.scale[2]).toBeCloseTo(1)
    // a user resize relative to the catalog size is applied on top
    const wide = fitScale(model, { ...cat, w: 750 }, cat)
    expect(wide.scale[0]).toBeCloseTo(1.5)
    expect(wide.scale[1]).toBeCloseTo(1)
  })

  it('ignores thin axes when comparing proportions', () => {
    // a rug: 2 cm model thickness vs 1 cm catalog thickness is not a proportion error
    expect(aspectMismatch([2, 0.02, 3], { w: 2000, h: 10, d: 3000 })).toBe(1)
    expect(fitScale([2, 0.02, 3], { w: 2000, h: 10, d: 3000 }, { w: 2000, h: 10, d: 3000 }).uniform).toBe(false)
  })

  it('without a catalog size behaves like a plain stretch', () => {
    expect(fitScale(model, { w: 250, h: 500, d: 400 }).scale).toEqual([0.5, 0.5, 1])
  })
})
