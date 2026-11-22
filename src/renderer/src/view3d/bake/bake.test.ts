import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { dilate, encode, pageOf, smooth } from './page'
import { type BakeLights, DEFAULT_TRACE, distanceAttenuation, traceTexels } from './trace'
import { fingerprint, texelsOf, unwrap } from './unwrap'

/** world-space triangles of a box (12 triangles, faces outward) */
function box(min: [number, number, number], max: [number, number, number]): Float32Array {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]).toNonIndexed()
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  return new Float32Array(g.getAttribute('position').array)
}

/** a floor quad (two triangles facing up) */
function floor(x0: number, z0: number, x1: number, z1: number, y = 0): Float32Array {
  return new Float32Array([x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0])
}

function bvhOf(...parts: Float32Array[]): MeshBVH {
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(all, 3))
  return new MeshBVH(g)
}

const none: BakeLights = { sun: null, points: [], areas: [], hemi: null, ambient: null, sky: null }

describe('light-map layout', () => {
  it('lays each face of a box flat as its own chart, inside the page, with gaps', () => {
    const meshes = [{ key: 'wall', positions: box([0, 0, 0], [4, 2.7, 0.2]) }]
    const l = unwrap(meshes, { density: 20, pad: 2 })
    expect(l.charts).toHaveLength(6)
    expect(l.size).toBeGreaterThanOrEqual(256)
    // the 4 m × 2.7 m faces: 80 × 54 texels plus the gap
    expect(l.charts.some((c) => c.w === 84 && c.h === 58)).toBe(true)
    for (const v of l.uv[0]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    // no two charts overlap
    for (const a of l.charts)
      for (const b of l.charts) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
  })

  it('is the same every time, and lowers the density when the page would be too large', () => {
    const meshes = [{ key: 'f', positions: floor(0, 0, 30, 30) }]
    const a = unwrap(meshes, { density: 40, maxSize: 512 })
    const b = unwrap(meshes, { density: 40, maxSize: 512 })
    expect(Array.from(a.uv[0])).toEqual(Array.from(b.uv[0]))
    expect(a.size).toBe(512)
    expect(a.density).toBeLessThan(40)
    expect(fingerprint(meshes[0].positions)).toBe(fingerprint(new Float32Array(meshes[0].positions)))
    expect(fingerprint(meshes[0].positions)).not.toBe(fingerprint(floor(0, 0, 30, 31)))
  })

  it('a surface cut into many triangles covers the same texels with the same points', () => {
    const fine = new THREE.PlaneGeometry(2, 1, 12, 7).rotateX(-Math.PI / 2).translate(1, 0, 0.5).toNonIndexed()
    const many = [{ key: 'f', positions: new Float32Array(fine.getAttribute('position').array) }]
    const two = [{ key: 'f', positions: floor(0, 0, 2, 1) }]
    const a = texelsOf(many, unwrap(many, { density: 10, pad: 1 }))
    const b = texelsOf(two, unwrap(two, { density: 10, pad: 1 }))
    expect(Array.from(a.index)).toEqual(Array.from(b.index))
    for (let i = 0; i < a.points.length; i++) expect(a.points[i]).toBeCloseTo(b.points[i], 5)
  })

  it('gives every covered texel the surface point and normal it stands for', () => {
    const meshes = [{ key: 'f', positions: floor(0, 0, 2, 1) }]
    const l = unwrap(meshes, { density: 10, pad: 1 })
    const t = texelsOf(meshes, l)
    // 20 × 10 texels inside, the edges snapped onto the floor
    expect(t.index.length).toBeGreaterThanOrEqual(200)
    for (let i = 0; i < t.index.length; i++) {
      expect(t.points[i * 6 + 1]).toBeCloseTo(0)
      expect(t.points[i * 6 + 4]).toBeCloseTo(1)
      expect(t.points[i * 6]).toBeGreaterThanOrEqual(-1e-6)
      expect(t.points[i * 6]).toBeLessThanOrEqual(2 + 1e-6)
    }
  })
})

describe('tracing', () => {
  const opts = { ...DEFAULT_TRACE, skyRays: 16, sunRays: 4, texel: 0.05 }
  const at = (x: number, y: number, z: number, nx = 0, ny = 1, nz = 0) => new Float32Array([x, y, z, nx, ny, nz])

  it('the sun casts a shadow behind a box and lights the floor beside it', () => {
    const blocker = box([-0.5, 0.5, -0.5], [0.5, 1.5, 0.5])
    const bvh = bvhOf(floor(-5, -5, 5, 5), blocker)
    const lights: BakeLights = { ...none, sun: { dir: [0, 1, 0], color: [3, 3, 3], spread: 0.01 } }
    const lit = traceTexels(bvh, at(3, 0, 0), lights, opts)
    const shade = traceTexels(bvh, at(0, 0, 0), lights, opts)
    expect(lit.rgb[0]).toBeCloseTo(3, 1)
    expect(shade.rgb[0]).toBe(0)
  })

  it('a lamp falls off with distance and does not light what faces away', () => {
    const bvh = bvhOf(floor(-5, -5, 5, 5))
    const lights: BakeLights = { ...none, points: [{ pos: [0, 2, 0], color: [10, 10, 10], distance: 0, decay: 2 }] }
    const below = traceTexels(bvh, at(0, 0, 0), lights, opts).rgb[0]
    expect(below).toBeCloseTo(10 * distanceAttenuation(2, 0, 2), 3)
    const away = traceTexels(bvh, at(0, 0, 0, 0, -1, 0), lights, opts).rgb[0]
    expect(away).toBe(0)
  })

  it('inside a room the sky comes in through the window only, and corners are darker', () => {
    // a closed 4 × 3 × 4 room with a 1 m hole in one wall (the room's walls as separate quads)
    const parts = [
      floor(0, 0, 4, 4, 0),
      floor(0, 0, 4, 4, 3),
      box([0, 0, -0.1], [4, 3, 0]),
      box([-0.1, 0, 0], [0, 3, 4]),
      box([0, 0, 4], [4, 3, 4.1]),
      // the wall at x = 4 with a window from z 1.5 to 2.5, y 1 to 2
      box([4, 0, 0], [4.1, 3, 1.5]),
      box([4, 0, 2.5], [4.1, 3, 4]),
      box([4, 0, 1.5], [4.1, 1, 2.5]),
      box([4, 2, 1.5], [4.1, 3, 2.5]),
    ]
    const bvh = bvhOf(...parts)
    const lights: BakeLights = { ...none, sky: [1, 1, 1], hemi: { sky: [0.3, 0.3, 0.3], ground: [0.3, 0.3, 0.3], intensity: 1 } }
    const o = { ...opts, skyRays: 256 }
    // the floor in front of the window gets sky; a back corner much less
    const front = traceTexels(bvh, at(3.5, 0, 2), lights, o).rgb[0]
    const back = traceTexels(bvh, at(0.05, 0, 0.05), lights, o).rgb[0]
    expect(front).toBeGreaterThan(back * 1.5)
    // without the window light: only the fill, darkened in the corner by occlusion
    const fillOnly = { ...lights, sky: null }
    expect(traceTexels(bvh, at(0.05, 0, 0.05), fillOnly, o).rgb[0]).toBeLessThan(traceTexels(bvh, at(2, 0, 2), fillOnly, o).rgb[0])
  })

  it('a texel under a wall is marked as not seen, to be filled from its neighbours', () => {
    const bvh = bvhOf(floor(-5, -5, 5, 5), box([-0.1, 0, -2], [0.1, 3, 2]))
    const r = traceTexels(bvh, at(0, 0, 0), { ...none, hemi: { sky: [1, 1, 1], ground: [1, 1, 1], intensity: 1 } }, opts)
    expect(r.valid[0]).toBe(0)
  })
})

describe('page', () => {
  it('fills the gaps around a chart and scales the brightest texels to white', () => {
    const size = 8
    const index = new Int32Array([3 * 8 + 3, 3 * 8 + 4, 4 * 8 + 3, 4 * 8 + 4])
    const chart = new Int32Array([0, 0, 0, 0])
    const rgb = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2])
    const page = dilate(smooth(pageOf(size, index, chart, rgb, new Uint8Array([1, 1, 1, 1]))), 2)
    // two rings around the 2 × 2 chart are filled, the corner of the page is not
    expect(page.rgb[(1 * 8 + 1) * 3]).toBeGreaterThan(0)
    expect(page.rgb[0]).toBe(0)
    const { rgba, scale } = encode(page)
    expect(scale).toBeGreaterThan(1)
    expect(rgba[(4 * 8 + 4) * 4]).toBe(255)
    expect(rgba[3]).toBe(255)
  })
})
