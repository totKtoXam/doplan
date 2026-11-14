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
 * Interactive sessions never show a noisy image: while the camera moves or anything changes the
 * engine draws the realtime raster frame (`rasterFrame`), tracing resumes once things rest and the
 * traced image replaces the raster frame when it has a few samples. On resume only what changed is
 * updated: camera, transforms + visibility (cut-away, ceilings), materials, lights in place; a new
 * scene capture only when meshes or geometries changed (the geometry BVHs are cached on the
 * geometries, so it costs the new geometries' BVHs plus packing).
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
import { perfBegin, perfEnabled, perfEnd, perfRecord, perfTime } from './perf'
import { currentQuality, getShared, isWebGPU, type QualitySettings } from './quality'
import type { AtrousDenoiser } from './denoise'
import { prefs3dStore, type DenoiseMode } from './prefs'
import { setPtStage } from './status'

// The TSL typings are stricter than what a dynamically assembled graph satisfies.
const TSL: any = TSLModule

type PTModule = typeof import('three-gpu-pathtracer/webgpu')
type PathTracer = InstanceType<PTModule['WebGPUPathTracer']>

interface Runtime {
  mod: PTModule
  pt: PathTracer
  denoiser: AtrousDenoiser | null
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
/** the camera has to rest this long before tracing resumes (the raster frame shows meanwhile) */
const CAMERA_REST_MS = 450
/** walking stops between key presses: wait for a real pause before tracing again */
const WALK_REST_MS = 1500

function cameraRestMs(): number {
  return uiStore.getState().cameraMode === 'walk' ? WALK_REST_MS : CAMERA_REST_MS
}

/** lets the overlay paint a status before blocking work starts */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}
/** the same after an edit of the document, lights or materials */
const EDIT_REST_MS = 1200
/**
 * The traced image replaces the raster frame once it has SWAP_SAMPLES samples per pixel, or
 * SWAP_SAMPLES_LATE after SWAP_LATE_MS on slow GPUs / heavy presets.
 */
const SWAP_SAMPLES = 8
const SWAP_SAMPLES_LATE = 3
const SWAP_LATE_MS = 1500
/** with the denoiser the filtered image is presentable much earlier */
const SWAP_SAMPLES_DENOISED = 4
const SWAP_SAMPLES_DENOISED_LATE = 2
/** the denoiser runs at most this often while the image accumulates */
const DENOISE_INTERVAL_MS = 120

/** how much of the filtered image is shown: "Авто" fades the filter out as the image converges */
function denoiseAmount(mode: DenoiseMode, spp: number): number {
  if (mode === 'off') return 0
  if (mode === 'on') return 1
  return spp <= 64 ? 1 : Math.max(0, 1 - (spp - 64) / 960)
}
/** an item model still loading (placeholder shown) delays the capture by up to this long */
const MODEL_WAIT_MS = 4000
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

export type InteractivePathTracer = PathTracerHandle & { readonly rasterFrame: boolean }

export function createPathTracer(ctx: EngineContext): InteractivePathTracer {
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
  let ready = false // the interactive scene is captured (the BVH matches the scene's structure)
  let sceneToken = 0
  /**
   * What the viewport shows while a session runs:
   *  - 'hold': the realtime raster frame (camera moving, document edited, scene being captured);
   *    tracing resumes at `holdUntil`
   *  - 'warm': accumulating off screen, the canvas keeps the last raster frame
   *  - 'trace': the traced image is presented
   */
  let phase: 'hold' | 'warm' | 'trace' = 'hold'
  let holdUntil = 0
  let warmSince = 0
  let placeholders = 0 // placeholder meshes seen by the last computeStructSig()
  let modelWaitSince = 0
  let captureReason = 'start'
  let sceneEvents = 0
  let capturedPlaceholders = 0 // placeholders in the captured scene (models that failed stay so)
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let capturing = false
  // pending work applied when the hold ends
  let needCapture = true
  let needSceneUpdate = false
  let needTransforms = false
  let needCamera = false
  let structSig = 0
  let avgSamples = 0
  let minSamples = 0
  /** the denoiser's last run (ms) and whether it ran on the finished image */
  let lastDenoise = 0
  let denoisedFinal = false
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
      const [mod, workers, dn] = await Promise.all([import('three-gpu-pathtracer/webgpu'), import('three-mesh-bvh/worker'), import('./denoise')])
      if (disposed) throw new Error(t('3D-вид закрыт'))
      const pt = new mod.WebGPUPathTracer(renderer)
      let denoiser: AtrousDenoiser | null = null
      try {
        denoiser = new dn.AtrousDenoiser()
        if (prefs3dStore.getState().denoiseMode !== 'off') pt.setDenoiser(denoiser as any)
      } catch (err) {
        console.warn('[pathtracer] denoiser unavailable', err)
        denoiser = null
      }
      try {
        pt.setBVHWorker(workers.GenerateMeshBVHWorker as any)
      } catch (err) {
        console.warn('[pathtracer] BVH worker unavailable, building on the main thread', err)
      }
      pt.transmissiveBackground = mod.TRANSMISSIVE_BACKGROUND_ENVIRONMENT
      pt.addEventListener('progress', onProgress)
      runtime = { mod, pt, denoiser }
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
    // no noisy low-resolution preview: the raster frame stays on screen until the traced image
    // has SWAP_SAMPLES samples, then the tracer presents it at once
    pt.renderToCanvas = phase === 'trace'
    pt.dynamicLowRes = false
    pt.renderDelay = 0
    pt.fadeDuration = 0
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
  let holdReason = ''
  function computeVisSig(): number {
    let h = 0
    ctx.roots.architecture.traverseVisible((o) => {
      h = (Math.imul(h, 31) + o.id) | 0
    })
    return h
  }

  /** hash of the meshes and their geometries: a change needs a new BVH (`setScene`) */
  function computeStructSig(): number {
    let h = 0
    placeholders = 0
    const helpers = ctx.roots.helpers
    const visit = (o: THREE.Object3D): void => {
      if (o === helpers) return
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
      if (g) {
        if (o.userData.placeholder) placeholders++
        h = (Math.imul(h, 31) + o.id) | 0
        h = (Math.imul(h, 31) + g.id) | 0
        h = (Math.imul(h, 31) + ((g.attributes.position as THREE.BufferAttribute | undefined)?.version ?? 0)) | 0
        // not the index version: the BVH build itself flags the index for upload
        h = (Math.imul(h, 31) + (g.index ? g.index.count : -1)) | 0
      }
      for (const c of o.children) visit(c)
    }
    visit(ctx.scene)
    return h
  }

  function resetCounters(): void {
    avgSamples = 0
    minSamples = 0
    lastDenoise = 0
    denoisedFinal = false
    report(0)
  }

  /** filters the tracer's current image; the next blit presents it. False when nothing ran */
  function runDenoiser(rt: Runtime, spp: number): boolean {
    const mode = prefs3dStore.getState().denoiseMode
    if (!rt.denoiser || mode === 'off') return false
    const target = rt.pt.target
    const aux = (rt.pt as unknown as { _pathTracer?: { auxTarget?: THREE.Texture | null } })._pathTracer?.auxTarget ?? null
    if (!target) return false
    try {
      perfTime('pt.denoise', () => rt.denoiser!.run(target, aux, spp, denoiseAmount(mode, spp)))
    } catch (err) {
      // a failing filter must not stop tracing: drop it and show the raw image
      console.warn('[pathtracer] denoiser failed', err)
      rt.pt.setDenoiser(null)
      rt.denoiser = null
      return false
    }
    lastDenoise = performance.now()
    return true
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
    // a late measurement of the image before the pause
    if (phase === 'hold') return
    avgSamples = e.samples.avg
    minSamples = e.samples.min
    if (avgSamples >= 1) perfEnd('ptRest1', 'pt.rest→1spp')
    if (interactive && !stillRunning) {
      report(minSamples >= target ? target : Math.min(target - 1, avgSamples))
      ctx.invalidate()
    }
  }

  // ── interactive scene capture ──
  async function captureScene(pt: PathTracer, camera: THREE.Camera): Promise<void> {
    const t0 = performance.now()
    instrumentSetScene(pt)
    try {
      await pt.setSceneAsync(ctx.scene, camera)
    } catch (err) {
      // a failing worker (CSP, bundling) must not make path tracing unusable
      console.warn('[pathtracer] async scene build failed, building synchronously', err)
      pt.setScene(ctx.scene, camera)
    }
    perfRecord('pt.setScene.total', t0, captureReason)
    firstSampleTimed = false
  }

  /** times the synchronous part of `setScene` (TLAS + buffer packing + texture atlas) */
  function instrumentSetScene(pt: PathTracer): void {
    const anyPt = pt as unknown as { setScene: (s: THREE.Scene, c: THREE.Camera) => void; __timed?: boolean }
    if (anyPt.__timed) return
    anyPt.__timed = true
    const original = anyPt.setScene.bind(pt)
    anyPt.setScene = (s, c) => {
      const t = performance.now()
      try {
        original(s, c)
      } finally {
        perfRecord('pt.setScene.pack', t)
      }
    }
  }
  let firstSampleTimed = true

  /** captures the scene (BVHs of new geometries in workers, then the packed scene) */
  async function capture(): Promise<void> {
    const token = ++sceneToken
    capturing = true
    setPtStage('preparing')
    const done = (): boolean => {
      if (token !== sceneToken) return true
      capturing = false
      setPtStage('idle')
      return disposed || !interactive || stillRunning
    }
    let rt: Runtime
    try {
      rt = await ensureRuntime()
    } catch (err) {
      if (token === sceneToken) {
        capturing = false
        fail(err)
      }
      return
    }
    if (token !== sceneToken || disposed || !interactive || stillRunning) {
      done()
      return
    }
    await nextPaint()
    if (token !== sceneToken || disposed || !interactive || stillRunning) {
      done()
      return
    }
    const pt = rt.pt
    configureInteractive(pt, currentQuality(ctx))
    hideHelpers()
    ctx.scene.updateMatrixWorld(true)
    // taken before the (async) capture: changes during the BVH build set the flags again
    const vis = computeVisSig()
    const events = sceneEvents
    needCapture = false
    needSceneUpdate = false
    needTransforms = false
    needCamera = false
    try {
      await captureScene(pt, ctx.camera)
    } catch (err) {
      if (token === sceneToken) {
        capturing = false
        fail(err)
      }
      return
    }
    if (done()) return
    // the first sample after a capture compiles the kernel (blocking): keep the status up
    setPtStage('preparing')
    visSig = vis
    // taken after the capture: the BVH build indexes non-indexed geometries. A scene change
    // during the build may have been missed by the snapshot, so it captures again
    structSig = computeStructSig()
    capturedPlaceholders = placeholders
    if (sceneEvents !== events) needCapture = true
    pt.setCamera(ctx.camera)
    cameraChanged()
    lightSig = computeLightSig()
    envSig = computeEnvSig()
    pt.reset()
    ready = true
    resetCounters()
    if (uiStore.getState().hint === t('Трассировка пути: подготовка сцены…')) hint(t('Трассировка пути'))
    ctx.invalidate()
  }

  /**
   * Applies what changed during the hold with the cheapest update: a new BVH only when meshes or
   * geometries changed, otherwise materials / transforms / lights / camera in place.
   * @returns false while an asynchronous capture runs
   */
  function applyPending(rt: Runtime): boolean {
    ctx.scene.updateMatrixWorld(true)
    const structChanged = computeStructSig() !== structSig
    if (!ready || needCapture || structChanged) {
      // an item model that is still loading would make this capture stale right away
      const now = performance.now()
      if (placeholders > capturedPlaceholders && ready) {
        if (!modelWaitSince) modelWaitSince = now
        if (now - modelWaitSince < MODEL_WAIT_MS) {
          hold(150)
          return false
        }
      }
      modelWaitSince = 0
      captureReason = !ready ? 'start' : needCapture ? 'lights' : 'geometry'
      if (!capturing) void capture()
      return false
    }
    modelWaitSince = 0
    const pt = rt.pt
    const kinds: string[] = []
    const t0 = performance.now()
    if (needSceneUpdate) {
      pt.updateMaterials()
      pt.updateTransforms()
      kinds.push('materials', 'transforms')
    } else if (needTransforms) {
      pt.updateTransforms()
      kinds.push('transforms')
    }
    visSig = computeVisSig()
    const ls = computeLightSig()
    if (ls !== lightSig) {
      lightSig = ls
      pt.updateLights()
      kinds.push('lights')
    }
    const es = computeEnvSig()
    if (es !== envSig) {
      envSig = es
      pt.updateEnvironment()
      kinds.push('environment')
    }
    if (needCamera) {
      pt.updateCamera()
      kinds.push('camera')
    }
    pt.reset()
    needSceneUpdate = false
    needTransforms = false
    needCamera = false
    perfRecord('pt.apply', t0, kinds.join('+') || 'reset')
    resetCounters()
    return true
  }

  function clearHoldTimer(): void {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
  }

  /** shows the raster frame and resumes tracing once nothing changed for `ms` */
  function hold(ms: number): void {
    if (!interactive || disposed) return
    if (phase !== 'hold') {
      phase = 'hold'
      if (runtime) runtime.pt.renderToCanvas = false
      resetCounters()
    }
    if (!capturing) setPtStage('idle')
    holdUntil = Math.max(holdUntil, performance.now() + ms)
    clearHoldTimer()
    holdTimer = setTimeout(() => {
      holdTimer = null
      ctx.invalidate()
    }, Math.max(0, holdUntil - performance.now()) + 5)
    ctx.invalidate()
  }

  /** a fresh capture for the running session (after a still, or when it starts) */
  function restartSession(): void {
    ready = false
    needCapture = true
    phase = 'hold'
    holdUntil = 0
    cameraChanged() // the capture takes the current camera
    hold(0)
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
    setPtStage('idle')
    interactive = false
    ready = false
    capturing = false
    phase = 'hold'
    sceneToken++
    clearHoldTimer()
    progressCb = null
    lastReported = -1
    if (runtime) runtime.pt.renderToCanvas = false
    if (!stillRunning) {
      restoreHelpers()
      shared.setPathTracing(false)
    }
    ctx.invalidate()
  }

  // ── subscriptions ──
  // every change pauses tracing (the raster frame shows) and resumes it once things rest
  const unsubScene = ctx.onSceneChanged(() => {
    if (!interactive || stillRunning) return
    sceneEvents++
    needSceneUpdate = true
    hold(EDIT_REST_MS)
  })
  const unsubLighting = shared.onLightingChanged((c) => {
    if (!interactive || stillRunning) return
    if (c.structure) {
      needCapture = true
      hold(EDIT_REST_MS)
      return
    }
    if (ready && (computeLightSig() !== lightSig || computeEnvSig() !== envSig)) {
      hold(EDIT_REST_MS)
      return
    }
    // tone mapping / exposure only change the blit: draw again
    ctx.invalidate()
  })
  const unsubQuality = shared.onQualityChanged(() => {
    if (!interactive || stillRunning || !runtime) return
    configureInteractive(runtime.pt, currentQuality(ctx))
    hold(0)
  })
  const unsubDenoise = prefs3dStore.subscribe((s, prev) => {
    if (s.denoiseMode === prev.denoiseMode || !runtime?.denoiser) return
    const wasOn = prev.denoiseMode !== 'off'
    const isOn = s.denoiseMode !== 'off'
    if (wasOn !== isOn) {
      // attaching / detaching switches the albedo / normal accumulation: the image starts over
      runtime.pt.setDenoiser(isOn ? (runtime.denoiser as any) : null)
      if (interactive && !stillRunning) hold(0)
      return
    }
    // "Авто" ⇄ "Вкл" only changes the mix: filter the current image again
    denoisedFinal = false
    lastDenoise = 0
    if (interactive && !stillRunning && phase === 'trace') {
      runDenoiser(runtime, avgSamples)
      ctx.invalidate()
    }
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
    capturing = false
    clearHoldTimer()
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

      // final blit of the accumulated image (linear) into our own target, filtered when the
      // denoiser is on
      if (runtime) runDenoiser(runtime, total)
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
        phase = 'hold'
        configureInteractive(pt, currentQuality(ctx))
        restartSession()
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

  if (perfEnabled()) {
    ;(globalThis as unknown as { __doplanPT?: unknown }).__doplanPT = {
      get runtime() { return runtime },
      get state() { return { interactive, ready, stillRunning, phase, capturing, holdIn: holdUntil - performance.now(), holdReason, sceneToken, avgSamples, minSamples, target } },
    }
  }

  // ── public handle ──
  const handle: InteractivePathTracer = {
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
            hold(0)
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
      restartSession()
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
    /** true while the engine should draw the realtime raster frame instead of the traced one */
    get rasterFrame() {
      return interactive && !stillRunning && !disposed && phase === 'hold'
    },
    step() {
      if (!interactive || stillRunning || disposed) return 0
      // camera motion and cut-away / ceiling visibility pause tracing until the camera rests;
      // they never rebuild the BVH (visibility is a per-object flag of the packed scene)
      if (cameraChanged()) {
        needCamera = true
        holdReason = 'camera'
        hold(cameraRestMs())
      }
      if (ready && !capturing) {
        // remember the new state right away: comparing with the last *applied* one would extend
        // the hold on every frame and tracing would never resume (stuck at 0/N)
        const vis = computeVisSig()
        if (vis !== visSig) {
          visSig = vis
          needTransforms = true
          holdReason = 'visibility'
          hold(cameraRestMs())
        }
      }
      if (phase === 'hold') {
        if (capturing || performance.now() < holdUntil) return 0
        if (!runtime) {
          void capture()
          return 0
        }
        try {
          if (!applyPending(runtime)) return 0
        } catch (err) {
          fail(err)
          return 0
        }
        phase = 'warm'
        if (firstSampleTimed) setPtStage('tracing')
        warmSince = performance.now()
        perfBegin('ptRest1')
        perfBegin('ptRestShown')
      }
      const pt = runtime!.pt
      try {
        if (!firstSampleTimed) {
          firstSampleTimed = true
          perfTime('pt.firstSample.cpu', () => pt.renderSample())
          if (phase === 'warm') setPtStage('tracing')
        } else pt.renderSample()
      } catch (err) {
        fail(err)
        return 0
      }
      const rt = runtime!
      const denoising = !!rt.denoiser && prefs3dStore.getState().denoiseMode !== 'off'
      const late = performance.now() - warmSince > SWAP_LATE_MS
      const swapAt = denoising ? (late ? SWAP_SAMPLES_DENOISED_LATE : SWAP_SAMPLES_DENOISED) : late ? SWAP_SAMPLES_LATE : SWAP_SAMPLES
      const done = minSamples >= target
      let filtered = false
      if (phase === 'warm' && (avgSamples >= Math.min(swapAt, target) || done)) {
        // enough samples to beat the raster frame: present the traced image from the next frame on
        phase = 'trace'
        setPtStage('idle')
        pt.renderToCanvas = true
        if (denoising) filtered = runDenoiser(rt, avgSamples)
        perfEnd('ptRestShown', 'pt.rest→shown')
        ctx.invalidate()
      } else if (phase === 'trace' && denoising && !denoisedFinal && (done || performance.now() - lastDenoise >= DENOISE_INTERVAL_MS)) {
        filtered = runDenoiser(rt, done ? target : avgSamples)
        if (filtered) ctx.invalidate()
      }
      if (done && filtered) denoisedFinal = true
      // one more frame presents the final filtered image before the loop stops
      if (done && filtered) return target - 1
      return done ? target : Math.min(target - 1, Math.floor(avgSamples))
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
      unsubDenoise()
      clearHoldTimer()
      setPtStage('idle')
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
