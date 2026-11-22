/**
 * Texels traced off the main thread. The casters' triangles arrive with the first chunk of a bake;
 * the worker builds their tree itself (the editor would stop for seconds building it) and keeps it;
 * every chunk then brings its texels and gets their light back.
 */
import type { MeshBVH } from 'three-mesh-bvh'
import { type BakeLights, sceneBvh, type TraceOptions, traceTexels } from './trace'

export interface BakeChunk {
  /** the casters, with the first chunk only: world-space triangles (9 numbers each) */
  casters?: Float32Array
  points: Float32Array
  lights: BakeLights
  opts: TraceOptions
  /** index of the chunk's first texel in the whole bake (the random sequence follows the texel) */
  seed: number
}

export type BakeReply = { progress: number } | { rgb: Float32Array; valid: Uint8Array } | { error: string }

const scope = self as unknown as { onmessage: ((e: MessageEvent<BakeChunk>) => void) | null; postMessage(m: BakeReply, t?: Transferable[]): void }
let bvh: MeshBVH | null = null

scope.onmessage = (e) => {
  try {
    const { points, lights, opts, seed } = e.data
    if (e.data.casters) bvh = sceneBvh(e.data.casters)
    if (!bvh) throw new Error('no scene')
    let last = 0
    const r = traceTexels(bvh, points, lights, opts, seed, (k) => {
      if (k - last >= 0.05) {
        last = k
        scope.postMessage({ progress: k })
      }
    })
    scope.postMessage({ rgb: r.rgb, valid: r.valid }, [r.rgb.buffer, r.valid.buffer])
  } catch (err) {
    scope.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
