/**
 * Path tracing (area: 3d-rendering): interactive progressive path tracing in the viewport and
 * still rendering for both modes.
 *
 * Built on `three-gpu-pathtracer/webgpu` (`WebGPUPathTracer`, 0.0.28). Facts checked against the
 * package source:
 *  - it needs a real WebGPU device; on the WebGL2 fallback backend it cannot run at all
 *  - `setSceneAsync()` builds the geometry BVHs in workers (`setBVHWorker(GenerateMeshBVHWorker)`),
 *    geometry edits need a new `setScene*`, light/env/camera edits the matching `update*()`
 *  - `renderSample()` blits into the *current* render target (the canvas by default) through a
 *    full-screen quad without its own tone mapping; on the canvas the renderer's output pass then
 *    applies `renderer.toneMapping` + sRGB, into a render target the result stays linear
 *  - `adaptiveFrameBudget` needs `trackTimestamp`, which the engine does not request, so the frame
 *    budget comes from the quality preset (kept small for Intel Arc iGPUs: avoids TDR resets)
 *  - `OIDNDenoiser` needs `oidn-webgpu` + bundled weights; neither is installed, so stills are
 *    returned without denoising (more samples instead)
 *
 * The module is imported lazily so the WebGPU kernels and three-mesh-bvh only load when the user
 * actually asks for path tracing.
 */
import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import * as TSLModule from 'three/tsl'
import type { EngineContext, PathTracerHandle, StillOptions } from '@/contracts'
import { uiStore } from '@/store/ui'
import { addTranslations, t } from '@/i18n'
import { imageToBlob, readTarget } from './export'
import { currentQuality, getShared, isWebGPU, type QualitySettings } from './quality'

// The TSL typings are stricter than what a dynamically assembled graph satisfies.
const TSL: any = TSLModule

type PTModule = typeof import('three-gpu-pathtracer/webgpu')
type PathTracer = InstanceType<PTModule['WebGPUPathTracer']>

interface Runtime {
  mod: PTModule
  pt: PathTracer
}

addTranslations('en', {
  'Рендер отменён': 'Render cancelled',
  '3D-вид закрыт': 'The 3D view was closed',
  '3D-вид ещё не готов': 'The 3D view is not ready yet',
  'Трассировка пути недоступна: нужен WebGPU, а 3D-вид работает через WebGL2. Включите WebGPU в настройках или используйте режим «Реальное время».':
    'Path tracing is unavailable: it needs WebGPU, but the 3D view runs on WebGL2. Enable WebGPU in Settings or use the "Realtime" mode.',
  'Трассировка пути остановлена: {msg}': 'Path tracing stopped: {msg}',
  'Не удалось запустить трассировку пути: {msg}': 'Could not start path tracing: {msg}',
  'Рендер уже выполняется — дождитесь его окончания': 'A render is already running, wait for it to finish',
  'Трассировка пути: подготовка сцены…': 'Path tracing: preparing the scene…',
  'Трассировка пути': 'Path tracing',
})

const MAX_STILL_EDGE = 8192
const DEFAULT_STILL_SAMPLES = 256
const SCENE_REBUILD_DELAY = 150
const COUNT_INTERVAL_MS = 300

function abortError(): DOMException {
  return new DOMException(t('Рендер отменён'), 'AbortError')
}

/** yields to the event loop without the timer throttling of hidden windows */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(0)
  })
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** ImageData → PNG/JPEG, resized with high quality smoothing; prefers OffscreenCanvas */
async function encodeImage(image: ImageData, width: number, height: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const d = image.data
  for (let i = 3; i < d.length; i += 4) d[i] = 255
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const src = new OffscreenCanvas(image.width, image.height)
      const sctx = src.getContext('2d')
      if (!sctx) throw new Error('2D context unavailable')
      sctx.putImageData(image, 0, 0)
      if (image.width === width && image.height === height) return await src.convertToBlob({ type, quality: 0.92 })
      const dst = new OffscreenCanvas(width, height)
      const dctx = dst.getContext('2d')
      if (!dctx) throw new Error('2D context unavailable')
      dctx.imageSmoothingEnabled = true
      dctx.imageSmoothingQuality = 'high'
      dctx.drawImage(src, 0, 0, width, height)
      return await dst.convertToBlob({ type, quality: 0.92 })
    } catch (err) {
      console.warn('[pathtracer] OffscreenCanvas encoding failed, using a DOM canvas', err)
    }
  }
  return imageToBlob(image, width, height, { type, opaque: true })
}

export function createPathTracer(ctx: EngineContext): PathTracerHandle {
  const shared = getShared(ctx)
  const renderer = ctx.renderer
  const supported = isWebGPU(renderer)
  const trackTimestamp = renderer?.backend?.trackTimestamp === true

  let disposed = false
  let runtime: Runtime | null = null
  let loading: Promise<Runtime> | null = null
  let initError: string | null = null

  // interactive state
  let interactive = false
  let target = 0
  let progressCb: ((s: number) => void) | null = null
  let ready = false // the interactive scene is captured and tracing
  let sceneToken = 0
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let avgSamples = 0
  let minSamples = 0
  let lastReported = -1
  const camSig = new Float64Array(33)
  let lightSig = ''
  let envSig = ''
  let visSig = 0

  // still state
  let stillRunning = false

  // helpers root is hidden while anything is traced
  let helpersHidden = false
  let helpersWereVisible = true

  // ── messages ──
  const unsupportedText = (): string =>
    t('Трассировка пути недоступна: нужен WebGPU, а 3D-вид работает через WebGL2. Включите WebGPU в настройках или используйте режим «Реальное время».')

  function hint(text: string): void {
    try {
      uiStore.getState().set({ hint: text })
    } catch {
      /* the store may be gone during teardown */
    }
  }

  // ── lazy initialisation ──
  function ensureRuntime(): Promise<Runtime> {
    if (runtime) return Promise.resolve(runtime)
    if (loading) return loading
    loading = (async () => {
      if (!supported) throw new Error(unsupportedText())
      const [mod, workers] = await Promise.all([import('three-gpu-pathtracer/webgpu'), import('three-mesh-bvh/worker')])
      if (disposed) throw new Error(t('3D-вид закрыт'))
      const pt = new mod.WebGPUPathTracer(renderer)
      try {
        pt.setBVHWorker(workers.GenerateMeshBVHWorker as any)
      } catch (err) {
        console.warn('[pathtracer] BVH worker unavailable, building on the main thread', err)
      }
      pt.transmissiveBackground = mod.TRANSMISSIVE_BACKGROUND_ENVIRONMENT
      pt.addEventListener('progress', onProgress)
      runtime = { mod, pt }
      return runtime
    })()
    loading.catch((err) => {
      initError = errorText(err)
      loading = null
    })
    return loading
  }

  function configureInteractive(pt: PathTracer, q: QualitySettings): void {
    pt.maxBounces = q.ptBounces
    pt.maxTransparentBounces = 8
    pt.filterGlossyFactor = 0.5
    pt.clampIndirect = q.preset === 'low' ? 5 : 10
    pt.adaptiveFrameBudget = trackTimestamp
    pt.targetFrameTime = q.ptTargetFrameTime
    if (!trackTimestamp || pt.frameBudget <= 0) pt.frameBudget = q.ptFrameBudget
    pt.renderScale = q.ptRenderScale
    pt.synchronizeRenderSize = true
    pt.renderToCanvas = true
    pt.dynamicLowRes = true
    pt.renderDelay = 16
    pt.fadeDuration = 250
    pt.minSamples = 1
    pt.pause = false
    pt.maxSamples = Math.max(1, target)
  }

  function configureStill(pt: PathTracer, q: QualitySettings, samples: number, width: number, height: number): void {
    pt.maxBounces = Math.max(q.ptBounces, 8)
    pt.maxTransparentBounces = 8
    pt.filterGlossyFactor = 0.5
    pt.clampIndirect = 10
    pt.adaptiveFrameBudget = trackTimestamp
    pt.targetFrameTime = Math.max(q.ptTargetFrameTime, 24)
    pt.frameBudget = Math.round(q.ptFrameBudget * 1.5)
    pt.synchronizeRenderSize = false
    pt.renderToCanvas = false
    pt.dynamicLowRes = false
    pt.renderDelay = 0
    pt.fadeDuration = 0
    pt.minSamples = 1
    pt.pause = false
    pt.maxSamples = samples
    pt.setSize(width, height)
  }

  // ── helpers visibility ──
  function hideHelpers(): void {
    if (helpersHidden) return
    helpersWereVisible = ctx.roots.helpers.visible
    ctx.roots.helpers.visible = false
    helpersHidden = true
  }
  function restoreHelpers(): void {
    if (!helpersHidden) return
    ctx.roots.helpers.visible = helpersWereVisible
    helpersHidden = false
  }

  // ── change tracking ──
  function cameraChanged(): boolean {
    const cam = ctx.camera
    cam.updateMatrixWorld()
    const a = cam.matrixWorld.elements
    const b = cam.projectionMatrix.elements
    let changed = false
    for (let i = 0; i < 16; i++) {
      if (camSig[i] !== a[i]) {
        camSig[i] = a[i]
        changed = true
      }
      if (camSig[16 + i] !== b[i]) {
        camSig[16 + i] = b[i]
        changed = true
      }
    }
    if (camSig[32] !== cam.fov) {
      camSig[32] = cam.fov
      changed = true
    }
    return changed
  }

  function computeLightSig(): string {
    const parts: string[] = []
    ctx.scene.traverseVisible((o) => {
      const l = o as THREE.Light & { isRectAreaLight?: boolean; isSpotLight?: boolean; isPointLight?: boolean; isDirectionalLight?: boolean }
      if (!(l.isRectAreaLight || l.isSpotLight || l.isPointLight || l.isDirectionalLight)) return
      o.updateWorldMatrix(true, false)
      const e = o.matrixWorld.elements
      parts.push(`${o.uuid}:${l.intensity.toFixed(4)}:${l.color.getHexString()}:${e.map((v) => v.toFixed(3)).join(',')}`)
    })
    return parts.join('|')
  }

  function computeEnvSig(): string {
    const s = ctx.scene
    const env = s.environment as THREE.Texture | null
    const bg = s.background as THREE.Texture | THREE.Color | null
    const bgKey = bg ? ((bg as THREE.Texture).isTexture ? (bg as THREE.Texture).uuid + ':' + (bg as THREE.Texture).version : (bg as THREE.Color).getHexString()) : 'none'
    return [
      env ? `${env.uuid}:${env.version}` : 'none',
      bgKey,
      s.environmentIntensity.toFixed(4),
      s.backgroundIntensity.toFixed(4),
      s.environmentRotation.y.toFixed(4),
      s.backgroundRotation.y.toFixed(4),
    ].join('|')
  }

  /**
   * Hash of what is visible in the architecture: the wall cut-away (engine + controls) and the
   * ceiling auto-hide only toggle `visible`, which emits no scene change, but the tracer's BVH is
   * a snapshot of the visible scene.
   */
  function computeVisSig(): number {
    let h = 0
    ctx.roots.architecture.traverseVisible((o) => {
      h = (Math.imul(h, 31) + o.id) | 0
    })
    return h
  }

  function resetCounters(): void {
    avgSamples = 0
    minSamples = 0
    report(0)
  }

  function report(samples: number): void {
    if (!interactive || stillRunning) return
    const s = Math.max(0, Math.min(target, Math.floor(samples)))
    if (s === lastReported) return
    lastReported = s
    try {
      progressCb?.(s)
    } catch (err) {
      console.warn('[pathtracer] progress callback failed', err)
    }
  }

  function onProgress(e: { stage: string; progress: number | null; samples?: { min: number; avg: number } }): void {
    if (e.stage !== 'rendering' || !e.samples) return
    avgSamples = e.samples.avg
    minSamples = e.samples.min
    if (interactive && !stillRunning) {
      report(minSamples >= target ? target : Math.min(target - 1, avgSamples))
      ctx.invalidate()
    }
  }

  // ── interactive scene capture ──
  async function captureScene(pt: PathTracer, camera: THREE.Camera): Promise<void> {
    try {
      await pt.setSceneAsync(ctx.scene, camera)
    } catch (err) {
      // a failing worker (CSP, bundling) must not make path tracing unusable
      console.warn('[pathtracer] async scene build failed, building synchronously', err)
      pt.setScene(ctx.scene, camera)
    }
  }

  async function rebuildInteractive(): Promise<void> {
    const token = ++sceneToken
    ready = false
    let rt: Runtime
    try {
      rt = await ensureRuntime()
    } catch (err) {
      if (token === sceneToken) fail(err)
      return
    }
    if (disposed || token !== sceneToken || !interactive || stillRunning) return
    const pt = rt.pt
    configureInteractive(pt, currentQuality(ctx))
    hideHelpers()
    ctx.scene.updateMatrixWorld(true)
    // taken before the (async) capture: a change during the BVH build triggers another rebuild
    const vis = computeVisSig()
    try {
      await captureScene(pt, ctx.camera)
    } catch (err) {
      if (token === sceneToken) fail(err)
      return
    }
    if (disposed || token !== sceneToken || !interactive || stillRunning) return
    visSig = vis
    pt.setCamera(ctx.camera)
    pt.reset()
    cameraChanged()
    lightSig = computeLightSig()
    envSig = computeEnvSig()
    ready = true
    resetCounters()
    if (uiStore.getState().hint === t('Трассировка пути: подготовка сцены…')) hint(t('Трассировка пути'))
    ctx.invalidate()
  }

  /** keepTracing: the old capture stays on screen (and accumulating) until the rebuild starts */
  function scheduleRebuild(keepTracing = false): void {
    if (!interactive || disposed) return
    if (!keepTracing) ready = false
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      void rebuildInteractive()
    }, SCENE_REBUILD_DELAY)
    ctx.invalidate()
  }

  function fail(err: unknown): void {
    const msg = errorText(err)
    console.error('[pathtracer] path tracing failed', err)
    const wasTarget = target
    endInteractive()
    hint(t('Трассировка пути остановлена: {msg}', { msg }))
    try {
      uiStore.getState().set({ pathTracing: { active: false, samples: 0, target: wasTarget } })
    } catch {
      /* teardown */
    }
  }

  function endInteractive(): void {
    interactive = false
    ready = false
    sceneToken++
    if (rebuildTimer) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    progressCb = null
    lastReported = -1
    if (!stillRunning) {
      restoreHelpers()
      shared.setPathTracing(false)
    }
    ctx.invalidate()
  }

  // ── subscriptions ──
  const unsubScene = ctx.onSceneChanged(() => {
    if (interactive && !stillRunning) scheduleRebuild()
  })
  const unsubLighting = shared.onLightingChanged((c) => {
    if (!interactive || stillRunning || !ready || !runtime) return
    if (c.structure) {
      scheduleRebuild()
      return
    }
    const pt = runtime.pt
    try {
      const ls = computeLightSig()
      if (ls !== lightSig) {
        lightSig = ls
        pt.updateLights()
        resetCounters()
      }
      const es = computeEnvSig()
      if (es !== envSig) {
        envSig = es
        pt.updateEnvironment()
        resetCounters()
      }
    } catch (err) {
      fail(err)
      return
    }
    // tone mapping / exposure only change the blit: draw again
    ctx.invalidate()
  })
  const unsubQuality = shared.onQualityChanged(() => {
    if (!interactive || stillRunning || !runtime) return
    configureInteractive(runtime.pt, currentQuality(ctx))
    runtime.pt.reset()
    resetCounters()
    ctx.invalidate()
  })

  // ── still rendering ──
  async function renderRealtime(opts: StillOptions, width: number, height: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
    const post = shared.post
    if (!post) throw new Error(t('3D-вид ещё не готов'))
    const ss = width * 2 <= 4096 && height * 2 <= 4096 ? 2 : 1
    const rt = new THREE.RenderTarget(width * ss, height * ss, { type: THREE.UnsignedByteType, depthBuffer: true })
    shared.stillBusy = true
    try {
      opts.onProgress?.(0, 1)
      if (opts.signal?.aborted) throw abortError()
      post.renderToTarget(rt, width * ss, height * ss)
      const image = await readTarget(renderer, rt, false)
      if (opts.signal?.aborted) throw abortError()
      const blob = await encodeImage(image, width, height, type)
      opts.onProgress?.(1, 1)
      return blob
    } finally {
      rt.dispose()
      shared.stillBusy = false
      ctx.invalidate()
    }
  }

  /** linear HDR image of the tracer (blitted by the tracer itself) → tone mapped linear [0,1] target */
  function toneMapInto(src: THREE.RenderTarget, dst: THREE.RenderTarget): void {
    const exposure = Number.isFinite(renderer.toneMappingExposure) ? renderer.toneMappingExposure : 1
    const mapping = renderer.toneMapping ?? THREE.NeutralToneMapping
    const material = new MeshBasicNodeMaterial()
    const sample = TSL.texture(src.texture)
    material.colorNode = TSL.vec4(TSL.toneMapping(mapping, TSL.float(exposure), sample.rgb), 1)
    material.toneMapped = false
    material.depthTest = false
    material.depthWrite = false
    const quad = new QuadMesh(material)
    const prev = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(dst)
      quad.render(renderer)
    } finally {
      renderer.setRenderTarget(prev)
      material.dispose()
    }
  }

  async function renderPathTraced(opts: StillOptions, width: number, height: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
    if (!supported) throw new Error(unsupportedText())
    let rt: Runtime
    try {
      rt = await ensureRuntime()
    } catch (err) {
      throw new Error(t('Не удалось запустить трассировку пути: {msg}', { msg: errorText(err) }))
    }
    if (disposed) throw new Error(t('3D-вид закрыт'))
    const pt = rt.pt
    const limit = Math.min(MAX_STILL_EDGE, Number(renderer?.backend?.device?.limits?.maxTextureDimension2D) || MAX_STILL_EDGE)
    const w = Math.max(16, Math.min(limit, width))
    const h = Math.max(16, Math.min(limit, height))
    const total = Math.max(1, Math.min(65536, Math.round(opts.samples ?? DEFAULT_STILL_SAMPLES)))
    const q = currentQuality(ctx)

    const resumeInteractive = interactive
    stillRunning = true
    sceneToken++ // cancels an interactive capture in flight
    ready = false
    if (rebuildTimer) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    shared.stillBusy = true
    shared.setPathTracing(true)
    hideHelpers()

    const camera = ctx.camera.clone()
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)

    const hdr = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false })
    const out = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false })
    const prevTarget = renderer.getRenderTarget()
    try {
      opts.onProgress?.(0, total)
      configureStill(pt, q, total, w, h)
      ctx.scene.updateMatrixWorld(true)
      await captureScene(pt, camera)
      if (disposed) throw new Error(t('3D-вид закрыт'))
      if (opts.signal?.aborted) throw abortError()
      pt.setCamera(camera)
      pt.reset()

      const device = renderer?.backend?.device as { queue?: { onSubmittedWorkDone?: () => Promise<void> } } | undefined
      let lastCount = 0
      let reported = -1
      for (;;) {
        if (disposed) throw new Error(t('3D-вид закрыт'))
        if (opts.signal?.aborted) throw abortError()
        renderer.setRenderTarget(null)
        pt.renderSample()
        // one submit at a time keeps the GPU queue short (Windows TDR, UI responsiveness)
        if (device?.queue?.onSubmittedWorkDone) await device.queue.onSubmittedWorkDone()
        await nextTask()
        const now = performance.now()
        if (now - lastCount >= COUNT_INTERVAL_MS) {
          lastCount = now
          const counts = await pt.getSampleCountsAsync()
          const shown = Math.min(total, Math.floor(counts.avg))
          if (shown !== reported) {
            reported = shown
            opts.onProgress?.(shown, total)
          }
          // `min` is the convergence criterion; a few straggling pixels must not hold the export forever
          if (counts.min >= total || counts.avg >= total * 1.25) break
        }
      }

      // final blit of the accumulated image (linear) into our own target
      pt.pause = true
      pt.renderToCanvas = true
      const prevClear = new THREE.Color()
      renderer.getClearColor(prevClear)
      const prevAlpha = renderer.getClearAlpha()
      try {
        renderer.setClearColor(0x000000, 1)
        renderer.setRenderTarget(hdr)
        renderer.clear()
        pt.renderSample()
      } finally {
        renderer.setClearColor(prevClear, prevAlpha)
        renderer.setRenderTarget(prevTarget)
      }
      toneMapInto(hdr, out)
      const image = await readTarget(renderer, out, true)
      if (opts.signal?.aborted) throw abortError()
      const blob = await encodeImage(image, Math.round(width), Math.round(height), type)
      opts.onProgress?.(total, total)
      return blob
    } finally {
      renderer.setRenderTarget(prevTarget)
      hdr.dispose()
      out.dispose()
      pt.pause = false
      stillRunning = false
      shared.stillBusy = false
      if (resumeInteractive && interactive && !disposed) {
        // the interactive session continues from scratch with the viewport camera
        configureInteractive(pt, currentQuality(ctx))
        void rebuildInteractive()
      } else {
        try {
          configureInteractive(pt, q)
          pt.setCamera(ctx.camera)
        } catch {
          /* tracer disposed */
        }
        restoreHelpers()
        shared.setPathTracing(false)
      }
      ctx.invalidate()
    }
  }

  // ── public handle ──
  const handle: PathTracerHandle = {
    start(targetSamples, onProgressCb) {
      if (disposed) return
      if (!supported) {
        const msg = unsupportedText()
        hint(msg)
        throw new Error(msg)
      }
      if (initError) {
        // a previous attempt failed: try again, but tell the user what happened last time
        initError = null
      }
      target = Math.max(1, Math.round(targetSamples))
      progressCb = onProgressCb
      lastReported = -1
      if (interactive) {
        if (runtime) {
          runtime.pt.maxSamples = target
          if (ready && minSamples >= target) {
            // already converged for this target: start over (a higher target just continues)
            runtime.pt.reset()
            resetCounters()
          } else if (ready) report(Math.min(target - 1, avgSamples))
        }
        ctx.invalidate()
        return
      }
      interactive = true
      avgSamples = 0
      minSamples = 0
      if (stillRunning) {
        // the still owns the tracer; the interactive session starts when it finishes
        ctx.invalidate()
        return
      }
      shared.setPathTracing(true)
      hideHelpers()
      hint(t('Трассировка пути: подготовка сцены…'))
      void rebuildInteractive()
      ctx.invalidate()
    },
    stop() {
      if (!interactive) return
      endInteractive()
      if (runtime && !stillRunning) {
        try {
          runtime.pt.reset()
        } catch {
          /* already disposed */
        }
      }
    },
    get active() {
      return interactive && !stillRunning && !disposed
    },
    step() {
      if (!interactive || stillRunning || disposed) return 0
      if (!ready || !runtime) return 0
      const pt = runtime.pt
      try {
        if (cameraChanged()) {
          pt.updateCamera()
          resetCounters()
          // a pending visibility recapture (the only kind that keeps `ready`) waits for the camera to rest
          if (rebuildTimer) scheduleRebuild(true)
        } else if (!rebuildTimer && computeVisSig() !== visSig) {
          // cut-away / ceilings changed: recapture once the camera rests (not on every drag frame)
          scheduleRebuild(true)
        }
        pt.renderSample()
      } catch (err) {
        fail(err)
        return 0
      }
      return minSamples >= target ? target : Math.min(target - 1, Math.floor(avgSamples))
    },
    async renderStill(opts) {
      if (disposed) throw new Error(t('3D-вид закрыт'))
      if (stillRunning) throw new Error(t('Рендер уже выполняется — дождитесь его окончания'))
      if (opts.signal?.aborted) throw abortError()
      const width = Math.max(16, Math.min(MAX_STILL_EDGE, Math.round(opts.width) || 16))
      const height = Math.max(16, Math.min(MAX_STILL_EDGE, Math.round(opts.height) || 16))
      const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png'
      if (opts.mode === 'realtime') return renderRealtime(opts, width, height, type)
      return renderPathTraced(opts, width, height, type)
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubScene()
      unsubLighting()
      unsubQuality()
      if (rebuildTimer) clearTimeout(rebuildTimer)
      rebuildTimer = null
      interactive = false
      ready = false
      sceneToken++
      progressCb = null
      restoreHelpers()
      shared.setPathTracing(false)
      if (runtime) {
        try {
          runtime.pt.removeEventListener('progress', onProgress)
          runtime.pt.dispose()
        } catch (err) {
          console.warn('[pathtracer] dispose failed', err)
        }
        runtime = null
      }
    },
  }
  return handle
}
