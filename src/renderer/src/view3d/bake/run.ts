/**
 * A whole bake: the receivers are laid out on one page, every covered texel is traced against the
 * casters (in workers when there are any, here otherwise) and the page is smoothed, filled around
 * the charts and stored as 8-bit sRGB with its brightness scale.
 */
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { dilate, encode, pageOf, smooth } from './page'
import { type BakeLights, DEFAULT_TRACE, type TraceOptions, traceTexels } from './trace'
import { type BakeLayoutOptions, DEFAULT_LAYOUT, type Layout, layoutHash, layoutOf, type UnwrapMesh, texelsOf } from './unwrap'

export { type BakeLayoutOptions, DEFAULT_LAYOUT, layoutHash, layoutOf }

export interface BakeResult {
  layout: Layout
  /** a short hash of where the charts went: the viewer's layout must give the same */
  layoutHash: string
  rgba: Uint8ClampedArray
  scale: number
}

export interface BakeRunOptions {
  layout?: BakeLayoutOptions
  trace?: Partial<TraceOptions>
  /** worker count; 0 traces on this thread */
  workers?: number
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}

const aborted = () => new DOMException('The bake was cancelled', 'AbortError')

async function traceInWorkers(
  bvh: MeshBVH,
  points: Float32Array,
  lights: BakeLights,
  opts: TraceOptions,
  count: number,
  onDone: (texels: number) => void,
  signal?: AbortSignal,
): Promise<{ rgb: Float32Array; valid: Uint8Array }> {
  const n = points.length / 6
  const rgb = new Float32Array(n * 3)
  const valid = new Uint8Array(n)
  const chunk = Math.max(256, Math.ceil(n / (count * 8)))
  const starts: number[] = []
  for (let s = 0; s < n; s += chunk) starts.push(s)
  const data = MeshBVH.serialize(bvh)
  const positions = (bvh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
  const workers: Worker[] = []
  let next = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let running = 0
      let failed = false
      const fail = (err: unknown) => {
        if (failed) return
        failed = true
        reject(err)
      }
      signal?.addEventListener('abort', () => fail(aborted()), { once: true })
      const feed = (w: Worker, first: boolean) => {
        if (failed) return
        if (next >= starts.length) {
          if (running === 0) resolve()
          return
        }
        const s = starts[next++]
        const e = Math.min(n, s + chunk)
        let reported = 0
        running++
        w.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { progress?: number; rgb?: Float32Array; valid?: Uint8Array; error?: string }
          if (m.error) return fail(new Error(m.error))
          if (m.progress !== undefined) {
            const now = Math.floor(m.progress * (e - s))
            onDone(now - reported)
            reported = now
            return
          }
          if (m.rgb && m.valid) {
            rgb.set(m.rgb, s * 3)
            valid.set(m.valid, s)
            onDone(e - s - reported)
            running--
            feed(w, false)
          }
        }
        w.onerror = (ev) => fail(new Error(ev.message || 'bake worker failed'))
        w.postMessage({ bvh: first ? data : undefined, positions: first ? positions : undefined, points: points.slice(s * 6, e * 6), lights, opts, seed: s })
      }
      for (let i = 0; i < Math.min(count, starts.length); i++) {
        const w = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' })
        workers.push(w)
        feed(w, true)
      }
      if (!starts.length) resolve()
    })
  } finally {
    for (const w of workers) w.terminate()
  }
  return { rgb, valid }
}

/** bakes the receivers' light map; `casters` are world-space triangles (9 numbers each) */
export async function bakeLightMap(receivers: UnwrapMesh[], casters: Float32Array, lights: BakeLights, o: BakeRunOptions = {}): Promise<BakeResult> {
  const lo = o.layout ?? DEFAULT_LAYOUT
  const layout = layoutOf(receivers, lo)
  const texels = texelsOf(receivers, layout)
  const opts: TraceOptions = { ...DEFAULT_TRACE, texel: 1 / layout.density, ...o.trace }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(casters, 3))
  const bvh = new MeshBVH(g)
  const total = texels.index.length
  let done = 0
  const step = (k: number) => {
    done += k
    o.onProgress?.(Math.min(done, total), total)
  }
  o.onProgress?.(0, total)
  if (o.signal?.aborted) throw aborted()
  const workers = o.workers ?? 0
  const traced =
    workers > 0 && typeof Worker !== 'undefined'
      ? await traceInWorkers(bvh, texels.points, lights, opts, workers, step, o.signal)
      : traceTexels(bvh, texels.points, lights, opts, 0, (k) => step(Math.floor(k * total) - done))
  if (o.signal?.aborted) throw aborted()
  const page = dilate(smooth(pageOf(layout.size, texels.index, texels.chart, traced.rgb, traced.valid)), lo.pad + 2)
  const { rgba, scale } = encode(page)
  return { layout, layoutHash: layoutHash(layout), rgba, scale }
}
