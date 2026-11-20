import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { BakeChunk, BakeReply } from './bake.worker'
import { type BakeLights, DEFAULT_TRACE, sceneBvh, traceTexels } from './trace'

/** world-space triangles of a box */
function box(min: [number, number, number], max: [number, number, number]): Float32Array {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]).toNonIndexed()
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  return new Float32Array(g.getAttribute('position').array)
}

describe('bake worker', () => {
  it('builds the casters tree from the first chunk and traces every chunk as this thread would', async () => {
    const replies: BakeReply[] = []
    const scope = { onmessage: null as ((e: MessageEvent<BakeChunk>) => void) | null, postMessage: (m: BakeReply) => void replies.push(m) }
    vi.stubGlobal('self', scope)
    await import('./bake.worker')
    const casters = box([-1, 1, -1], [1, 1.2, 1]) // a roof over the points
    const lights: BakeLights = { sun: null, points: [], areas: [], hemi: { sky: [1, 1, 1], ground: [0.2, 0.2, 0.2], intensity: 1 }, ambient: null, sky: [1, 1, 1] }
    const opts = { ...DEFAULT_TRACE, skyRays: 8, sunRays: 1, texel: 0.05 }
    const points = new Float32Array([0, 0, 0, 0, 1, 0, 3, 0, 0, 0, 1, 0])
    const send = (c: BakeChunk) => scope.onmessage?.({ data: c } as MessageEvent<BakeChunk>)
    send({ casters, points: points.slice(0, 6), lights, opts, seed: 0 })
    send({ points: points.slice(6), lights, opts, seed: 1 })
    const results = replies.filter((r): r is { rgb: Float32Array; valid: Uint8Array } => 'rgb' in r)
    expect(replies.some((r) => 'error' in r)).toBe(false)
    expect(results).toHaveLength(2)
    // lit, and the roof changes the light under it
    expect(results[1].rgb[0]).toBeGreaterThan(0)
    expect(results[0].rgb[0]).not.toBe(results[1].rgb[0])
    const here = traceTexels(sceneBvh(casters), points, lights, opts, 0)
    expect(Array.from(results[0].rgb)).toEqual(Array.from(here.rgb.slice(0, 3)))
    const second = traceTexels(sceneBvh(casters), points.slice(6), lights, opts, 1)
    expect(Array.from(results[1].rgb)).toEqual(Array.from(second.rgb))
    vi.unstubAllGlobals()
  })
})
