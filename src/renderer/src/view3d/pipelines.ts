/**
 * Render pipelines are created asynchronously.
 *
 * three r187 creates the GPU pipeline of an object it meets for the first time during a normal
 * render with the synchronous `device.createRenderPipeline`. In Chromium that compiles the D3D12 /
 * Metal / Vulkan pipeline on the GPU process main thread, which also composites the whole window:
 * while a new scene, a new model, the first shadow pass or a still at another target format is
 * being compiled, the entire app (2D, panels, menus) stops for seconds — on a cold driver shader
 * cache up to 18 s for one apartment.
 *
 * Here every pipeline the WebGPU backend makes during a normal render goes through
 * `createRenderPipelineAsync`, which Dawn compiles on worker threads. three already skips an object
 * whose pipeline is not ready yet (`Pipelines.isReady`), so the object simply appears a few frames
 * later; when pipelines arrive, `onReady` redraws the view (and the shadow maps). Full-screen passes
 * (`QuadMesh`: tone mapping, FXAA, AO, bloom, output) stay synchronous — they are few, cheap, and
 * without them the canvas would be blank.
 *
 * Offscreen renders that must be complete (stills, thumbnails) draw with `drawWhenReady`: draw, wait
 * for the pipelines that draw asked for, draw again.
 */

interface Tracker {
  pending: number
  waiters: Array<() => void>
}

const trackers = new WeakMap<object, Tracker>()

/** routes the renderer's render-pipeline creation through the async path (WebGPU backend only) */
export function useAsyncPipelines(renderer: any, onReady: () => void): void {
  const backend = renderer?.backend
  if (!backend || backend.isWebGPUBackend !== true || trackers.has(renderer)) return
  const original = backend.createRenderPipeline
  if (typeof original !== 'function') return
  const tracker: Tracker = { pending: 0, waiters: [] }
  trackers.set(renderer, tracker)
  let notify = 0
  const settle = (): void => {
    tracker.pending--
    // one redraw per burst of finished pipelines, not one per pipeline
    if (!notify)
      notify = requestAnimationFrame(() => {
        notify = 0
        onReady()
      })
    if (tracker.pending === 0) {
      const waiters = tracker.waiters.splice(0)
      for (const w of waiters) w()
    }
  }
  backend.createRenderPipeline = function (renderObject: any, promises: Promise<void>[] | null) {
    // compileAsync passes its own list; full-screen passes stay synchronous
    if (promises !== null || renderObject?.object?.isQuadMesh === true) return original.call(this, renderObject, promises)
    const local: Promise<void>[] = []
    const result = original.call(this, renderObject, local)
    for (const p of local) {
      tracker.pending++
      p.then(settle, settle)
    }
    return result
  }
}

/** number of pipelines still compiling for this renderer */
export function pendingPipelines(renderer: any): number {
  return trackers.get(renderer)?.pending ?? 0
}

/** resolves when no pipeline is compiling (immediately when none is), or after `timeoutMs` */
export function pipelinesSettled(renderer: any, timeoutMs = 20000): Promise<void> {
  const tracker = trackers.get(renderer)
  if (!tracker || tracker.pending === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done(): void {
      clearTimeout(timer)
      const i = tracker!.waiters.indexOf(done)
      if (i >= 0) tracker!.waiters.splice(i, 1)
      resolve()
    }
    tracker.waiters.push(done)
  })
}

/**
 * Draws an offscreen picture that must show everything: draws, and while that draw started
 * pipelines, waits for them and draws again (a new pipeline can only show up on the next draw).
 */
export async function drawWhenReady(renderer: any, draw: () => void, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    draw()
    if (pendingPipelines(renderer) === 0) return
    await pipelinesSettled(renderer)
  }
  draw()
}
