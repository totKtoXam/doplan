/**
 * The 3D engine: owns the WebGPURenderer, the scene graph roots and the frame scheduler,
 * wires the view3d sub-modules together and keeps the scene in sync with the document.
 *
 *  - renderer: `WebGPURenderer` (WebGPU backend, WebGL2 fallback via `forceWebGL`); never the
 *    classic WebGLRenderer
 *  - on-demand rendering: a frame is drawn only after `invalidate()` or while the controls move
 *  - adaptive pixel ratio: lower while the camera moves, refined when it rests
 *  - incremental scene sync: architecture and items are diffed per entity
 *  - device loss: a new renderer is created and the sub-modules are re-attached; the scene
 *    graph and all CPU-side data survive
 */
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import type { Asset, DerivedPlan, Doc, EntityRef, Id, Material, QualityPreset } from '@core/types'
import type {
  CameraControls,
  Engine3DHandle,
  EngineContext,
  LightingRig,
  PostPipeline,
  ProceduralFactory,
  StillOptions,
} from '@/contracts'
import { visibleDoc, visiblePlan } from '@core/layers'
import { docStore } from '@/store/document'
import { isLiveResizing, onLiveResizeEnd } from '@/store/liveResize'
import { uiStore } from '@/store/ui'
import { createBakedLight } from './bake/apply'
import { Architecture } from './build/architecture'
import { ElectricalBuilder } from './build/electrical'
import { createControls } from './controls'
import { ThumbRenderer, convertModel, exportSceneGlb, imageToBlob, readTarget } from './export'
import { createInteraction } from './interaction'
import { ItemsLayer } from './items'
import { createLighting } from './lighting'
import { type MaterialLibraryEx, createMaterialLibrary } from './materials'
import { createPost } from './post'
import { createProceduralFactory } from './procedural'
import { mountPerfOverlay, perfBegin, perfBeginOnce, perfEnabled, perfEnd, perfPending, perfRecord, perfTime } from './perf'
import { frameDpr, getQuality, getShared } from './quality'
import { createMeasure3D } from './measure3d'
import { isViewOnly, keepsHole } from '@/store/viewOnly'
import { createViewerPick, type ViewerPick } from './viewerPick'
import { markRendererSwapped, markStruggling, setPreparing } from './status'
import { CompiledMaterials, precompile } from './precompile'

type CameraMode = 'orbit' | 'walk' | 'top'

interface ControlsWithView extends CameraControls {
  setView?(position: THREE.Vector3, target: THREE.Vector3, fov?: number, animate?: boolean): void
}

interface SubModules {
  lighting: LightingRig
  post: PostPipeline
  controls: ControlsWithView
  interaction: { dispose(): void }
}

const DEFAULT_BOUNDS = new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2.7, 3))

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none'
  canvas.tabIndex = -1
  return canvas
}

async function makeRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): Promise<any> {
  const renderer: any = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL,
    powerPreference: 'high-performance',
  })
  await renderer.init()
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1
  return renderer
}

export async function createEngine(container: HTMLElement): Promise<Engine3DHandle> {
  const openStart = performance.now()
  perfBegin('open', openStart)
  // ── renderer ──
  let forceWebGL = false
  // the shell publishes the live preference (e.g. "retry with WebGL" before the settings save lands)
  const published = (globalThis as unknown as { __DOPLAN_BACKEND__?: string }).__DOPLAN_BACKEND__
  if (published === 'webgl' || published === 'webgpu') forceWebGL = published === 'webgl'
  else {
    try {
      const settings = await window.doplan?.settings?.get()
      forceWebGL = settings?.backend === 'webgl'
    } catch {
      /* settings are optional (tests, storybook) */
    }
  }
  if (typeof navigator !== 'undefined' && !('gpu' in navigator)) forceWebGL = true

  let canvas = makeCanvas()
  container.appendChild(canvas)

  const createRendererWithFallback = async (): Promise<any> => {
    try {
      return await makeRenderer(canvas, forceWebGL)
    } catch (err) {
      if (forceWebGL) throw err
      console.warn('[doplan] WebGPU initialisation failed, falling back to WebGL2', err)
      // a canvas that already handed out a WebGPU context cannot create a WebGL2 one
      const fresh = makeCanvas()
      canvas.replaceWith(fresh)
      canvas = fresh
      forceWebGL = true
      return makeRenderer(canvas, true)
    }
  }
  let renderer: any
  try {
    const t0 = performance.now()
    renderer = await createRendererWithFallback()
    perfRecord('3d.rendererInit', t0)
  } catch (err) {
    canvas.remove()
    throw err
  }

  // ── scene graph ──
  const scene = new THREE.Scene()
  scene.name = 'doplan'
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400)
  const measure = createMeasure3D(container, camera)
  const group = (name: string): THREE.Group => {
    const g = new THREE.Group()
    g.name = name
    scene.add(g)
    return g
  }
  const roots = {
    architecture: group('architecture'),
    items: group('items'),
    lights: group('lights'),
    electrical: group('electrical'),
    helpers: group('helpers'),
  }
  roots.helpers.userData.helper = true

  const bounds = DEFAULT_BOUNDS.clone()
  const sceneListeners = new Set<() => void>()
  const frameListeners = new Set<(dt: number) => void>()

  // ── frame scheduler state ──
  let destroyed = false
  let suspended = false
  let running = false
  let dirtyFrames = 0
  /** new materials are being compiled: the canvas keeps the last frame meanwhile (precompile.ts) */
  let compiling = false
  /** look for materials that were never compiled before the next frame */
  let compileCheck = true
  let firstCompileDone = false
  /** a frame was drawn: until then what arrives during the first compile does not hold the picture */
  let drawnOnce = false
  const compiled = new CompiledMaterials()
  let lastTime = 0
  let lastMoveAt = -1e9
  let currentDpr = 0
  let holesFor: Doc['openings'] | null = null
  let holesOut: Doc['openings'] = {}
  /** the openings that cut walls in the viewer, the same object while the openings stay the same */
  function holesOf(openings: Doc['openings']): Doc['openings'] {
    if (openings !== holesFor) {
      holesFor = openings
      holesOut = Object.fromEntries(Object.entries(openings).filter(([id]) => keepsHole(id)))
    }
    return holesOut
  }
  let dynScale = 1
  // the moving-DPR floor, off from the second drop until the factor is back to 1
  let dprFloor = true
  let frameEma = 16
  let lastDynChange = 0
  let pendingSync = true

  const invalidate = (frames = 2): void => {
    dirtyFrames = Math.max(dirtyFrames, frames)
    start()
  }

  const ctx: EngineContext = {
    renderer,
    scene,
    camera,
    container,
    canvas,
    roots,
    invalidate: () => invalidate(),
    onSceneChanged(cb) {
      sceneListeners.add(cb)
      return () => {
        sceneListeners.delete(cb)
      }
    },
    onBeforeRender(cb) {
      frameListeners.add(cb)
      return () => {
        frameListeners.delete(cb)
      }
    },
    quality: docStore.getState().doc.render.quality ?? 'medium',
    getBounds: () => bounds.clone(),
  }
  const shared = getShared(ctx)
  // a light added, a shadow switched or the baked light on or off: every lit shader is built again
  const offLighting = shared.onLightingChanged((c) => {
    if (!c.structure) return
    compiled.reset()
    compileCheck = true
  })
  const offBaked = shared.onBakedChanged(() => {
    compiled.reset()
    compileCheck = true
  })

  const emitSceneChanged = (): void => {
    for (const cb of Array.from(sceneListeners)) {
      try {
        cb()
      } catch (err) {
        console.error('[doplan] scene listener failed', err)
      }
    }
  }

  // ── scene builders (independent of the renderer instance) ──
  const lib = createMaterialLibrary(ctx) as MaterialLibraryEx
  const factory: ProceduralFactory = createProceduralFactory()
  const arch = new Architecture(roots.architecture, lib, factory)
  let collectTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleCollect = (): void => {
    if (collectTimer) return
    collectTimer = setTimeout(() => {
      collectTimer = null
      if (!destroyed) lib.collect([scene])
    }, 2500)
  }
  const afterSceneChange = (): void => {
    compileCheck = true
    emitSceneChanged()
    refreshOutline()
    scheduleCollect()
    invalidate()
  }
  const baked = createBakedLight(ctx, shared, {
    shown() {
      const doc = visibleDoc(docStore.getState().doc)
      return { doc, levelId: activeLevel(doc) }
    },
    flush: () => flushSync(),
    ceilingsShown: () => arch.ceilingsShown(),
    whenIdle: () => lib.whenIdle(8000),
    withFullScene(ceilings, fn) {
      arch.setExportMode(true)
      arch.setCeilingsShown(ceilings)
      try {
        return fn()
      } finally {
        arch.setExportMode(false)
        arch.updateVisibility(camera, uiStore.getState().cameraMode, docStore.getState().doc.render, bounds)
        invalidate(3)
      }
    },
  })
  const items = new ItemsLayer(ctx, lib, factory, afterSceneChange)
  const electrical = new ElectricalBuilder(roots.electrical)
  const thumbs = new ThumbRenderer(ctx, lib, items)

  // ── document → scene ──
  let lastDoc: Doc | null = null
  let lastPlan: DerivedPlan | undefined
  let lastLevel: Id = ''
  let lastCatalog: unknown = null
  let lastDocQuality: QualityPreset | null = null
  let lastFile: string | null | undefined
  let lastCreated = ''
  let catalogEpoch = 0
  let lastEpoch = -1
  let hadContent = false
  let wantsFit = true
  let mods: SubModules | null = null

  const activeLevel = (doc: Doc): Id => {
    const id = uiStore.getState().activeLevelId
    return doc.levels[id] ? id : (doc.levelOrder[0] ?? Object.keys(doc.levels)[0] ?? '')
  }

  const updateBounds = (plan: DerivedPlan | undefined, doc: Doc, levelId: Id): void => {
    const b = plan?.bounds
    const level = doc.levels[levelId]
    const height = Math.max(arch.maxHeight(), (level?.height ?? 2700) / 1000, 1)
    if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX - b.minX > 1 && b.maxY - b.minY > 1) {
      bounds.min.set(b.minX / 1000, 0, b.minY / 1000)
      bounds.max.set(b.maxX / 1000, height, b.maxY / 1000)
    } else {
      // no walls yet: frame the items, or a default room-sized box
      const box = new THREE.Box3()
      for (const child of roots.items.children) box.expandByObject(child)
      if (box.isEmpty()) bounds.copy(DEFAULT_BOUNDS)
      else {
        bounds.copy(box)
        bounds.min.y = 0
        bounds.max.y = Math.max(bounds.max.y, height)
      }
    }
  }

  function objectsFor(ref: EntityRef): THREE.Object3D[] {
    if (ref.kind === 'item') {
      const o = items.objectFor(ref.id)
      return o && o.visible ? [o] : []
    }
    if (ref.kind === 'wall' || ref.kind === 'opening' || ref.kind === 'room') return arch.objectsFor(ref)
    if (ref.kind === 'light') {
      const found: THREE.Object3D[] = []
      for (const child of roots.lights.children) {
        const r = child.userData.ref as EntityRef | undefined
        if (r && r.kind === 'light' && r.id === ref.id) found.push(child)
      }
      return found
    }
    if (ref.kind === 'electric') {
      const o = electrical.objectFor(ref.id)
      return o ? [o] : []
    }
    return []
  }

  function refreshOutline(): void {
    if (!mods) return
    const ui = uiStore.getState()
    const selected: THREE.Object3D[] = []
    for (const ref of ui.selection) for (const o of objectsFor(ref)) if (!selected.includes(o)) selected.push(o)
    const hovered = ui.hover ? (objectsFor(ui.hover)[0] ?? null) : null
    try {
      mods.post.setOutline(selected, hovered)
    } catch (err) {
      console.warn('[doplan] outline failed', err)
    }
  }

  function applyQuality(q: QualityPreset): void {
    ctx.quality = q
    if (mods) mods.post.setQuality(q)
    else shared.setQuality(q)
    if (lib.syncQuality()) pendingSync = true
    currentDpr = 0
    // other shadow maps and light counts: every shader again
    compiled.reset()
    compileCheck = true
    invalidate()
  }

  /** applies pending document / ui changes to the scene graph */
  function flushSync(): void {
    if (!pendingSync || destroyed) return
    const syncStart = performance.now()
    try {
      flushSyncInner()
    } finally {
      if (lastSyncChanged) perfRecord('3d.sync', syncStart)
    }
  }
  let lastSyncChanged = false
  function flushSyncInner(): void {
    pendingSync = false
    lastSyncChanged = false
    const ds = docStore.getState()
    const ui = uiStore.getState()
    // the scene is built from what the layers panel shows (hidden objects are left out)
    const doc = visibleDoc(ds.doc)
    const levelId = activeLevel(doc)
    const fullPlan = ds.derived[levelId]
    const plan = fullPlan && visiblePlan(ds.doc, fullPlan)
    // the viewer hides a door or a window but keeps its hole in the wall (not one the author hid)
    const holes = isViewOnly() && doc.openings !== ds.doc.openings ? holesOf(ds.doc.openings) : undefined

    if (doc.render.quality && doc.render.quality !== lastDocQuality) {
      lastDocQuality = doc.render.quality
      if (doc.render.quality !== ctx.quality) applyQuality(doc.render.quality)
      pendingSync = false
    }
    if (lastDoc && (lastDoc.materials !== doc.materials || lastDoc.assets !== doc.assets)) catalogEpoch++
    if (lastCatalog !== null && lastCatalog !== ui.catalog) catalogEpoch++
    lastCatalog = ui.catalog
    const epoch = lib.epoch * 100000 + catalogEpoch
    const epochChanged = epoch !== lastEpoch
    const levelChanged = levelId !== lastLevel
    const replaced = lastDoc !== null && (ds.filePath !== lastFile || doc.meta.createdAt !== lastCreated)

    let sceneChanged = false
    let moved = false
    const archDirty =
      !lastDoc ||
      epochChanged ||
      levelChanged ||
      plan !== lastPlan ||
      doc.nodes !== lastDoc.nodes ||
      doc.walls !== lastDoc.walls ||
      doc.openings !== lastDoc.openings ||
      doc.rooms !== lastDoc.rooms ||
      doc.levels !== lastDoc.levels
    if (archDirty) {
      try {
        const t0 = performance.now()
        if (arch.sync({ doc, plan, levelId, epoch, holes })) {
          sceneChanged = true
          perfRecord('3d.sync.architecture', t0)
        }
      } catch (err) {
        console.error('[doplan] architecture build failed', err)
      }
    }
    if (!lastDoc || epochChanged || levelChanged || doc.items !== lastDoc.items) {
      try {
        const t0 = performance.now()
        const r = items.sync(doc, levelId, epoch)
        if (r.changed) {
          sceneChanged = true
          perfRecord('3d.sync.items', t0)
        }
        moved = r.moved
      } catch (err) {
        console.error('[doplan] items build failed', err)
      }
    }
    if (!lastDoc || levelChanged || doc.electrical !== lastDoc.electrical) {
      try {
        if (electrical.sync(doc, levelId)) sceneChanged = true
      } catch (err) {
        console.error('[doplan] electrical build failed', err)
      }
    }
    if (archDirty || sceneChanged || moved) updateBounds(plan, doc, levelId)
    if (archDirty || sceneChanged) compileCheck = true
    lastSyncChanged = sceneChanged || moved

    const lightsDirty = !lastDoc || levelChanged || doc.lights !== lastDoc.lights || doc.render !== lastDoc.render
    lastDoc = doc
    lastPlan = plan
    lastLevel = levelId
    lastEpoch = epoch
    lastFile = ds.filePath
    lastCreated = doc.meta.createdAt

    const hasContent = roots.architecture.children.length > 0 || roots.items.children.length > 0
    if (replaced || levelChanged || (hasContent && !hadContent)) wantsFit = true
    hadContent = hasContent

    // the published light shows while the plan is what was baked
    if (archDirty || sceneChanged || lightsDirty || levelChanged) baked.refresh()
    if (!mods) return
    if (sceneChanged || moved) {
      emitSceneChanged()
      scheduleCollect()
    }
    if (lightsDirty) {
      try {
        mods.lighting.sync()
      } catch (err) {
        console.error('[doplan] lighting sync failed', err)
      }
    }
    if (sceneChanged || moved) refreshOutline()
    if (wantsFit && hasContent) {
      wantsFit = false
      placeDefaultView(false)
    }
  }

  function requestSync(): void {
    pendingSync = true
    invalidate()
  }

  // ── sub-modules bound to the renderer ──
  function createSubModules(): SubModules {
    const lighting = createLighting(ctx)
    const post = createPost(ctx)
    const controls = createControls(ctx) as ControlsWithView
    // the published viewer never edits: no picking, dragging or gizmos
    const interaction = isViewOnly() ? { dispose() {} } : createInteraction(ctx, { controls, post })
    return { lighting, post, controls, interaction }
  }
  function disposeSubModules(m: SubModules): void {
    const safely = (fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        console.warn('[doplan] dispose failed', err)
      }
    }
    safely(() => m.interaction.dispose())
    safely(() => m.controls.dispose())
    safely(() => m.post.dispose())
    safely(() => m.lighting.dispose())
  }

  // ── sizing / adaptive DPR ──
  function targetDpr(moving: boolean): number {
    return frameDpr(ctx.quality, window.devicePixelRatio || 1, moving, dynScale, undefined, dprFloor)
  }
  function applySize(dpr: number): void {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w < 2 || h < 2) return
    currentDpr = dpr
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    mods?.post.setSize(w, h, dpr)
  }
  function updateDpr(moving: boolean, dtMs: number, now: number): void {
    if (moving) {
      lastMoveAt = now
      frameEma = frameEma * 0.9 + dtMs * 0.1
      if (now - lastDynChange > 1500) {
        if (frameEma > 25 && dynScale > 0.6) {
          dynScale = Math.max(0.6, dynScale - 0.12)
          if (dynScale <= 0.8) dprFloor = false
          lastDynChange = now
          frameEma = 18
        } else if (frameEma < 17.5 && dynScale < 1) {
          dynScale = Math.min(1, dynScale + 0.06)
          if (dynScale >= 1) dprFloor = true
          lastDynChange = now
        } else if (frameEma > 33 && dynScale <= 0.6 && now - lastDynChange > 3000) {
          // the lowest resolution and still slow: the preset itself is too heavy here
          lastDynChange = now
          frameEma = 25
          markStruggling()
        }
      }
    }
    const lowRes = moving || now - lastMoveAt < 160
    const dpr = targetDpr(lowRes)
    if (Math.abs(dpr - currentDpr) > 0.01) {
      applySize(dpr)
      dirtyFrames = Math.max(dirtyFrames, 2)
    }
    // keep ticking until the idle refinement happened
    if (lowRes && !moving) dirtyFrames = Math.max(dirtyFrames, 1)
  }
  let liveTimer = 0
  function resize(): void {
    if (destroyed) return
    if (isLiveResizing()) {
      // a panel border is being dragged: reallocating every target each frame halves the frame
      // rate, so the canvas stretches with CSS in between and is resized a few times a second at the
      // moving resolution; the drag's end resizes it in full (onLiveResizeEnd below)
      if (!liveTimer) {
        liveTimer = window.setTimeout(() => {
          liveTimer = 0
          if (!isLiveResizing()) return
          lastMoveAt = performance.now()
          resizeTo(targetDpr(true))
        }, 120)
      }
      return
    }
    resizeTo(targetDpr(false))
  }
  function resizeTo(dpr: number): void {
    if (destroyed) return
    const w0 = canvas.width
    const h0 = canvas.height
    applySize(dpr)
    invalidate()
    // a new canvas size clears it; ResizeObserver callbacks run after this frame's animation
    // callbacks, so without drawing now the cleared canvas would reach the screen (flicker while
    // a panel border is dragged)
    if (running && (canvas.width !== w0 || canvas.height !== h0)) tick()
  }

  // ── frame loop ──
  function start(): void {
    if (running || destroyed || suspended || document.hidden) return
    running = true
    lastTime = performance.now()
    renderer.setAnimationLoop(tick)
  }
  function stop(): void {
    if (!running) return
    running = false
    try {
      renderer.setAnimationLoop(null)
    } catch {
      /* renderer may be gone after a device loss */
    }
  }
  function tick(): void {
    if (destroyed || suspended || !mods) {
      stop()
      return
    }
    // a hidden view (the 2D mode keeps the engine behind display:none) draws nothing and leaves the
    // scene to catch up once it shows again (the resize observer restarts the loop): a plan edit in
    // 2D then costs no 3D work at all
    if (container.clientWidth < 2 || container.clientHeight < 2) {
      stop()
      return
    }
    const now = performance.now()
    const dtMs = Math.min(100, Math.max(0, now - lastTime))
    lastTime = now
    const dt = dtMs / 1000
    try {
      flushSync()
      if (compiling) {
        stop()
        return
      }
      // the first picture does not wait for what arrived while the first compile ran (models, their
      // finishes): it is drawn without them, and they are compiled right after and show up then
      let later: THREE.Material[] = []
      if (compileCheck) {
        compileCheck = false
        const fresh = compiled.pending(compileRoots())
        if (fresh.length && firstCompileDone && !drawnOnce) later = fresh
        else if (fresh.length) {
          startPrecompile(fresh)
          stop()
          return
        }
      }
      for (const cb of Array.from(frameListeners)) cb(dt)
      const moving = mods.controls.update(dt) === true
      const ui = uiStore.getState()
      const render = docStore.getState().doc.render
      if (!shared.stillBusy && arch.updateVisibility(camera, ui.cameraMode as CameraMode, render, bounds)) {
        refreshOutline()
        shared.refreshShadows?.()
      }
      updateDpr(moving, dtMs, now)
      const firstFrame = perfPending('open')
      const frameStart = performance.now()
      const withheld = later.length ? withhold(later) : []
      try {
        mods.post.render()
      } finally {
        for (const o of withheld) o.visible = true
      }
      drawnOnce = true
      measure.update()
      if (firstFrame) perfRecord('3d.firstFrame.cpu', frameStart)
      afterFrame()
      if (later.length) {
        startPrecompile(later)
        stop()
        return
      }
      dirtyFrames = Math.max(0, dirtyFrames - 1)
      if (!moving && dirtyFrames === 0) stop()
    } catch (err) {
      console.error('[doplan] frame failed', err)
      dirtyFrames = 0
      stop()
    }
  }

  /** hides what is drawn with `materials` (not compiled yet) for one frame; returns it to show again */
  function withhold(materials: THREE.Material[]): THREE.Object3D[] {
    const set = new Set(materials)
    const out: THREE.Object3D[] = []
    for (const root of compileRoots()) {
      root.traverseVisible((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
        if (m && (Array.isArray(m) ? m.some((x) => set.has(x)) : set.has(m))) out.push(o)
      })
    }
    for (const o of out) o.visible = false
    return out
  }

  function compileRoots(): THREE.Object3D[] {
    return [roots.architecture, roots.items, roots.lights, roots.electrical]
  }

  /** compiles the new materials without blocking; the next frame is drawn once they are ready */
  function startPrecompile(fresh: THREE.Material[]): void {
    compiling = true
    const first = !firstCompileDone
    if (first) setPreparing(true)
    const t0 = performance.now()
    void precompile(renderer, scene, camera, compileRoots(), shared.post?.sceneCompiler() ?? null).then(() => {
      compiled.mark(fresh)
      compiling = false
      perfRecord(first ? '3d.precompile.first' : '3d.precompile', t0)
      if (first) {
        firstCompileDone = true
        setPreparing(false)
      }
      if (!destroyed) invalidate()
    })
  }

  /** closes the open / edit spans once the GPU finished the frame that shows them */
  function afterFrame(): void {
    const open = perfPending('open')
    const edit = perfPending('edit')
    if (!open && !edit) return
    const done = (): void => {
      if (open) perfEnd('open', '3d.open→firstFrame')
      if (edit) perfEnd('edit', '3d.edit→frame')
    }
    const queue = renderer?.backend?.device?.queue as { onSubmittedWorkDone?: () => Promise<void> } | undefined
    if (queue?.onSubmittedWorkDone) queue.onSubmittedWorkDone().then(done, done)
    else done()
  }

  // ── camera helpers ──
  function placeDefaultView(animate: boolean): void {
    if (!mods) return
    const box = bounds.clone()
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(2, Math.hypot(size.x, size.z) * 0.5)
    const target = new THREE.Vector3(center.x, Math.min(1.0, size.y * 0.35), center.z)
    const position = target.clone().add(new THREE.Vector3(0.55, 0.95, 0.85).normalize().multiplyScalar(radius * 2.4))
    const mode = uiStore.getState().cameraMode
    if (mode === 'orbit' && mods.controls.setView) mods.controls.setView(position, target, undefined, animate)
    else if (mode === 'orbit') {
      camera.position.copy(position)
      mods.controls.target.copy(target)
      camera.lookAt(target)
      mods.controls.fit(box)
    } else mods.controls.fit(box)
    invalidate()
  }

  // ── boot ──
  perfTime('3d.sceneBuild', () => flushSync()) // builds the scene so that controls / lighting start from real bounds
  mods = perfTime('3d.subModules', () => createSubModules())
  const unmountPerf = mountPerfOverlay(container)
  void lib.whenIdle(30000).then(() => perfRecord('3d.open→texturesIdle', openStart))
  const initialMode = uiStore.getState().cameraMode
  if (initialMode !== 'orbit') mods.controls.setMode(initialMode)
  applySize(targetDpr(false))
  emitSceneChanged()
  try {
    mods.lighting.sync()
  } catch (err) {
    console.error('[doplan] lighting sync failed', err)
  }
  refreshOutline()
  if (hadContent) {
    wantsFit = false
    placeDefaultView(false)
  }

  // ── device loss ──
  let recovering = false
  let losses = 0
  async function recover(info: unknown): Promise<void> {
    if (destroyed || recovering) return
    recovering = true
    suspended = true
    stop()
    losses++
    console.warn('[doplan] GPU device lost, restoring…', info)
    try {
      const mode = uiStore.getState().cameraMode
      const target = mods ? mods.controls.target.clone() : new THREE.Vector3()
      const position = camera.position.clone()
      const fov = camera.fov
      if (mods) disposeSubModules(mods)
      mods = null
      items.resetLoaders()
      const old = renderer
      try {
        await old.dispose?.()
      } catch {
        /* the device is already gone */
      }
      const fresh = makeCanvas()
      canvas.replaceWith(fresh)
      canvas = fresh
      // a second loss in one session: stay on the compatibility backend
      if (losses >= 2) forceWebGL = true
      renderer = await createRendererWithFallback()
      hookRenderer(renderer)
      ctx.renderer = renderer
      ctx.canvas = canvas
      camera.position.copy(position)
      camera.fov = fov
      mods = createSubModules()
      if (mode !== 'orbit') mods.controls.setMode(mode)
      if (mods.controls.setView) mods.controls.setView(position, target, fov, false)
      else {
        mods.controls.target.copy(target)
        camera.lookAt(target)
      }
      suspended = false
      markRendererSwapped()
      currentDpr = 0
      applySize(targetDpr(false))
      emitSceneChanged()
      mods.lighting.sync()
      refreshOutline()
      invalidate(3)
    } catch (err) {
      console.error('[doplan] could not restore the 3D view', err)
    } finally {
      recovering = false
    }
  }
  function hookRenderer(r: any): void {
    const original = typeof r.onDeviceLost === 'function' ? r.onDeviceLost.bind(r) : null
    r.onDeviceLost = (info: { reason?: string | null }) => {
      try {
        original?.(info)
      } catch {
        /* logging only */
      }
      if (destroyed || r !== renderer || info?.reason === 'destroyed') return
      void recover(info)
    }
  }
  hookRenderer(renderer)

  // ── subscriptions ──
  const unsubDoc = docStore.subscribe((s, p) => {
    if (s.revision !== p.revision || s.doc !== p.doc || s.derived !== p.derived) {
      if (s.doc !== p.doc) perfBeginOnce('edit')
      requestSync()
    }
  })
  const unsubUi = uiStore.subscribe((s, p) => {
    if (s.activeLevelId !== p.activeLevelId || s.catalog !== p.catalog) requestSync()
    if (s.selection !== p.selection || s.hover !== p.hover) refreshOutline()
    if (s.cameraMode !== p.cameraMode && mods) {
      mods.controls.setMode(s.cameraMode)
      invalidate()
    }
  })
  let resizeRaf = 0
  const observer = new ResizeObserver(() => {
    if (resizeRaf) return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      resize()
    })
  })
  observer.observe(container)
  const offLiveResize = onLiveResizeEnd(() => resize())
  const onVisibility = (): void => {
    if (document.hidden) stop()
    else invalidate()
  }
  document.addEventListener('visibilitychange', onVisibility)
  let dprQuery: MediaQueryList | null = null
  const onDprChange = (): void => {
    dprQuery?.removeEventListener('change', onDprChange)
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprQuery.addEventListener('change', onDprChange)
    resize()
  }
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprQuery.addEventListener('change', onDprChange)

  invalidate(3)

  // ── stills ──
  async function renderRealtimeStill(opts: StillOptions): Promise<Blob> {
    const w = Math.max(16, Math.min(8192, Math.round(opts.width)))
    const h = Math.max(16, Math.min(8192, Math.round(opts.height)))
    const ss = w * 2 <= 4096 && h * 2 <= 4096 ? 2 : 1
    const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    flushSync()
    await lib.whenIdle(5000)
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!mods) throw new Error('3D view is not ready')
    shared.stillBusy = true
    try {
      opts.onProgress?.(0, 1)
      if (shared.post) {
        const target = new THREE.RenderTarget(w * ss, h * ss, { type: THREE.UnsignedByteType, depthBuffer: true })
        try {
          shared.post.renderToTarget(target, w * ss, h * ss)
          const image = await readTarget(renderer, target, false)
          return await imageToBlob(image, w, h, { type, opaque: true })
        } finally {
          target.dispose()
        }
      }
      // fallback without post internals: draw into the canvas at the requested size and copy it out
      const helpers = roots.helpers.visible
      roots.helpers.visible = false
      try {
        renderer.setPixelRatio(1)
        renderer.setSize(w * ss, h * ss, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        mods.post.setSize(w * ss, h * ss, 1)
        for (let i = 0; i < 4; i++) mods.post.render()
        const out = document.createElement('canvas')
        out.width = w
        out.height = h
        const c2 = out.getContext('2d')
        if (!c2) throw new Error('2D canvas unavailable')
        c2.imageSmoothingQuality = 'high'
        c2.drawImage(canvas, 0, 0, w, h)
        return await new Promise<Blob>((resolve, reject) =>
          out.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, 0.92),
        )
      } finally {
        roots.helpers.visible = helpers
        currentDpr = 0
        applySize(targetDpr(false))
      }
    } finally {
      shared.stillBusy = false
      opts.onProgress?.(1, 1)
      invalidate(3)
    }
  }

  let viewerPick: ViewerPick | null = null
  // ── public handle ──
  const handle: Engine3DHandle = {
    pickAt(clientX, clientY) {
      flushSync()
      return (viewerPick ??= createViewerPick(ctx)).pick(clientX, clientY)
    },
    projectPoint(p) {
      return (viewerPick ??= createViewerPick(ctx)).project(p)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      stop()
      // the debug handle must not hold the closed scene: only the stores stay reachable
      const dbg = globalThis as unknown as { __doplan3d?: { engine?: unknown; docStore?: unknown; uiStore?: unknown } }
      if (dbg.__doplan3d?.engine === handle) dbg.__doplan3d = { docStore, uiStore }
      unmountPerf()
      unsubDoc()
      unsubUi()
      measure.dispose()
      observer.disconnect()
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      if (liveTimer) clearTimeout(liveTimer)
      offLiveResize()
      if (collectTimer) clearTimeout(collectTimer)
      baked.dispose()
      offLighting()
      offBaked()
      document.removeEventListener('visibilitychange', onVisibility)
      dprQuery?.removeEventListener('change', onDprChange)
      if (mods) disposeSubModules(mods)
      mods = null
      thumbs.dispose()
      arch.clear()
      items.dispose()
      lib.dispose()
      sceneListeners.clear()
      frameListeners.clear()
      try {
        void Promise.resolve(renderer.dispose?.()).catch(() => undefined)
      } catch {
        /* already disposed */
      }
      canvas.remove()
    },
    resize,
    get backend(): string {
      return renderer?.backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl2'
    },
    setCameraMode(mode) {
      const ui = uiStore.getState()
      if (ui.cameraMode !== mode) ui.set({ cameraMode: mode })
      else {
        mods?.controls.setMode(mode)
        invalidate()
      }
    },
    focusSelection() {
      if (!mods) return
      flushSync()
      const box = new THREE.Box3()
      for (const ref of uiStore.getState().selection) for (const o of objectsFor(ref)) box.expandByObject(o)
      mods.controls.fit(box.isEmpty() ? bounds.clone() : box)
      invalidate()
    },
    resetCamera() {
      flushSync()
      placeDefaultView(true)
    },
    getCamera() {
      const t = mods ? mods.controls.target : new THREE.Vector3()
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [t.x, t.y, t.z],
        fov: camera.fov,
      }
    },
    setCamera(c) {
      if (!mods) return
      const position = new THREE.Vector3(c.position[0], c.position[1], c.position[2])
      const target = new THREE.Vector3(c.target[0], c.target[1], c.target[2])
      if (mods.controls.setView) mods.controls.setView(position, target, c.fov, false)
      else {
        camera.position.copy(position)
        if (c.fov && c.fov > 1 && c.fov < 170) {
          camera.fov = c.fov
          camera.updateProjectionMatrix()
        }
        mods.controls.target.copy(target)
        camera.lookAt(target)
        mods.controls.update(0)
      }
      invalidate(3)
    },
    setQuality(q) {
      applyQuality(q)
    },
    renderStill(opts) {
      if (!mods) return Promise.reject(new Error('3D view is not ready'))
      return renderRealtimeStill(opts)
    },
    async exportGlb() {
      flushSync()
      await lib.whenIdle(8000)
      const release = baked.hold()
      // full-height walls, ceilings and everything a cut-away pass has hidden
      arch.setExportMode(true)
      const shown: THREE.Object3D[] = []
      roots.architecture.traverse((o) => {
        if (!o.visible && !o.userData.lowered) {
          o.visible = true
          shown.push(o)
        }
      })
      try {
        return await exportSceneGlb([roots.architecture, roots.items, roots.electrical])
      } finally {
        for (const o of shown) o.visible = false
        release()
        arch.setExportMode(false)
        arch.updateVisibility(camera, uiStore.getState().cameraMode, docStore.getState().doc.render, bounds)
        invalidate(3)
      }
    },
    bakeLighting(opts) {
      return baked.bake(opts)
    },
    setBakedLight(bake) {
      baked.set(bake)
    },
    renderAssetThumb(asset: Asset, size: number) {
      return thumbs.renderAsset(asset, size)
    },
    renderMaterialThumb(material: Material, size: number) {
      return thumbs.renderMaterial(material, size)
    },
    convertModel(file, aux) {
      return convertModel(renderer, file, aux)
    },
  }
  // measurement hook (debug flag only): scripted edits and camera moves for the timing runs
  if (perfEnabled()) (globalThis as unknown as { __doplan3d?: unknown }).__doplan3d = { docStore, uiStore, engine: handle, scene, camera, renderer, loop: () => ({ running, dirtyFrames, suspended }) }
  return handle
}
