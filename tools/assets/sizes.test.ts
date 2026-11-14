import { describe, expect, it } from 'vitest'
import { gltfExtents, implausibleSize, sizeFromGltf, type GltfJson } from './sizes'

/** one mesh per root node; each mesh is a unit-ish box given by its accessor min/max */
function gltf(roots: { name: string; t?: number[]; s?: number[]; min: number[]; max: number[] }[]): GltfJson {
  return {
    scenes: [{ nodes: roots.map((_, i) => i) }],
    nodes: roots.map((r, i) => ({ name: r.name, mesh: i, translation: r.t, scale: r.s })),
    meshes: roots.map((_, i) => ({ primitives: [{ attributes: { POSITION: i } }] })),
    accessors: roots.map((r) => ({ min: r.min, max: r.max })),
  }
}

describe('gltfExtents / sizeFromGltf', () => {
  it('maps glTF x/y/z to w/h/d and applies node transforms', () => {
    const g = gltf([{ name: 'chair', t: [5, 0, 5], s: [2, 2, 2], min: [-0.2, 0, -0.25], max: [0.2, 0.45, 0.25] }])
    const ext = gltfExtents(g)
    expect(ext?.variant).toBe(false)
    expect(sizeFromGltf(ext!)).toEqual({ w: 800, d: 1000, h: 900 })
  })

  it('sizes a variant collection by its first variant, not the whole row', () => {
    const plant = (name: string, x: number) => ({ name, t: [x, 0, 0], min: [-0.35, 0, -0.3], max: [0.35, 1.3, 0.3] })
    const g = gltf([plant('pachira_a', -2), plant('pachira_b', 0), plant('pachira_c', 2), plant('pachira_d', 4)])
    const ext = gltfExtents(g)!
    expect(ext.variant).toBe(true)
    // Poly Haven `dimensions` describe the whole row (6.7 m); they must not leak into the size
    expect(sizeFromGltf(ext, [6.7, 0.6, 1.3])).toEqual({ w: 700, d: 600, h: 1300 })
  })

  it('repairs a model exported at the wrong unit scale using the API dimensions', () => {
    const g = gltf([{ name: 'shelves', min: [-5.5, 0, -2.5], max: [5.5, 21.4, 2.5] }])
    expect(sizeFromGltf(gltfExtents(g)!, [1.1, 0.5, 2.14])).toEqual({ w: 1100, d: 500, h: 2140 })
  })

  it('applies a source unit scale when there are no API dimensions', () => {
    const g = gltf([{ name: 'couch', min: [-1.5, 0, -0.75], max: [1.5, 1.2, 0.75] }])
    expect(sizeFromGltf(gltfExtents(g)!, undefined, 2 / 3)).toEqual({ w: 2000, d: 1000, h: 800 })
  })
})

describe('implausibleSize', () => {
  it('flags the sizes that slipped into the catalog before', () => {
    expect(implausibleSize('chair', { w: 688, d: 658, h: 2274 })).toMatch(/height/)
    expect(implausibleSize('plant', { w: 6869, d: 997, h: 1904 })).toMatch(/footprint/)
    expect(implausibleSize('chair', { w: 450, d: 500, h: 900 })).toBeNull()
    expect(implausibleSize('outdoor', { w: 2241, d: 3022, h: 746 })).toBeNull()
  })
})
