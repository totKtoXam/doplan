/**
 * Texels traced off the main thread. The scene's BVH arrives serialized with the first chunk of a
 * bake and is kept; every chunk then brings its texels and gets their light back.
 */
import * as THREE from 'three'
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh'
import { type BakeLights, type TraceOptions, traceTexels } from './trace'

export interface BakeChunk {
  /** the scene, with the first chunk only: its tree and its triangles (9 numbers each) */
  bvh?: SerializedBVH
  positions?: Float32Array
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
    if (e.data.bvh && e.data.positions) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(e.data.positions, 3))
      bvh = MeshBVH.deserialize(e.data.bvh, g, { setIndex: true })
    }
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
