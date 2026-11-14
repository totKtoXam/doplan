/**
 * doplan 2D plan editor (PixiJS 8, WebGL, render on demand).
 *
 * stage
 *  ├─ worldUnder   camera transform: underlay images, faint ghost of the level below
 *  ├─ grid         screen space, rebuilt on camera change
 *  ├─ world        camera transform: room fills, walls, openings, items (hairline strokes)
 *  └─ screen       screen space: annotations, selection, handles, guides, tool previews, text
 *
 * The scene is derived from docStore / uiStore; nothing is ticking while idle.
 */
// the renderer CSP forbids 'unsafe-eval': Pixi must use its pre-compiled shader/uniform sync paths
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics } from 'pixi.js'
import type { Doc, EntityRef, Id } from '@core/types'
import type { CreateEditor2D, Editor2DHandle, ToolId } from '@/contracts'
import { docStore } from '@/store/document'
import { handles as appHandles } from '@/store/handles'
import { uiStore } from '@/store/ui'
import { accuracyStore } from '@/store/accuracy'
import { fitBounds } from './bounds'
import { buildContextMenu } from './contextMenu'
import { EMPTY_DERIVED, type ContextMenuItem, type EditorCtx } from './context'
import { computeHandles } from './handles'
import { HitIndex } from './hit'
import { HtmlOverlay } from './htmlOverlay'
import { registerEditorTranslations } from './i18n'
import { attachInput } from './input'
import { AnnotationsLayer } from './layers/annotations'
import { GhostLevelLayer } from './layers/ghost'
import { GridLayer } from './layers/grid'
import { ItemsLayer } from './layers/items'
import { OpeningsLayer } from './layers/openings'
import { drawCameraGizmo, drawSelection, drawSnapFeedback } from './layers/overlay'
import { RoomsLayer } from './layers/rooms'
import { UnderlaysLayer } from './layers/underlays'
import { WallsLayer } from './layers/walls'
import { Painter, TextPool } from './painter'
import { snapshotPng } from './snapshot'
import { paletteFor, type Palette } from './theme'
import { createTools, type Tool } from './tools'
import { Camera } from './view'

export const createEditor2D: CreateEditor2D = async (container: HTMLElement): Promise<Editor2DHandle> => {
  registerEditorTranslations()

  // ── DOM ──
  const root = document.createElement('div')
  root.className = 'doplan-editor2d'
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;'
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
  container.appendChild(root)

  let dpr = Math.max(1, window.devicePixelRatio || 1)
  let palette: Palette = paletteFor(uiStore.getState().theme)

  const app = new Application()
  await app.init({
    preference: 'webgl',
    antialias: true,
    resolution: dpr,
    autoDensity: true,
    autoStart: false,
    sharedTicker: false,
    background: palette.bg,
    width: Math.max(1, root.clientWidth),
    height: Math.max(1, root.clientHeight),
  })
  app.ticker.stop()
  const canvas = app.canvas
  canvas.style.display = 'block'
  canvas.style.outline = 'none'
  canvas.style.touchAction = 'none'
  root.appendChild(canvas)

  // ── scene ──
  const camera = new Camera()
  const worldUnder = new Container()
  const world = new Container()
  const screen = new Container()
  const overlayG = new Graphics()
  overlayG.eventMode = 'none'
  const texts = new TextPool()
  texts.resolution = dpr
  for (const c of [app.stage, worldUnder, world, screen, texts.container]) c.eventMode = 'none'

  const grid = new GridLayer()
  const underlays = new UnderlaysLayer()
  const ghost = new GhostLevelLayer()
  const rooms = new RoomsLayer()
  const walls = new WallsLayer()
  const openings = new OpeningsLayer()
  const items = new ItemsLayer()
  const annotations = new AnnotationsLayer()

  worldUnder.addChild(underlays.container, ghost.g)
  world.addChild(rooms.container, items.g, walls.g, openings.g)
  screen.addChild(overlayG, texts.container)
  app.stage.addChild(worldUnder, grid.g, world, screen)

  const painter = new Painter(overlayG, texts, camera, palette)

  // ── state ──
  let destroyed = false
  let raf = 0
  // a fit was requested while the viewport had no real size (hidden / not laid out): run it on resize
  let fitPending = true
  // camera.version right after the last fit; still equal → the user has not panned/zoomed since
  let fitVersion = -1

  const levelId = (): Id => {
    const doc = docStore.getState().doc
    const id = uiStore.getState().activeLevelId
    return doc.levels[id] ? id : (doc.levelOrder[0] ?? id)
  }

  function requestRender(): void {
    if (destroyed || raf) return
    raf = requestAnimationFrame(frame)
  }

  const html = new HtmlOverlay(root, requestRender)

  const ctx: EditorCtx = {
    root,
    canvas,
    camera,
    hit: undefined as unknown as HitIndex,
    html,
    keys: { shift: false, alt: false, ctrl: false, space: false },
    pointer: { plan: null, screen: null, inside: false },
    snapFeedback: null,
    requestRender,
    palette: () => palette,
    doc: () => docStore.getState().doc,
    ui: () => uiStore.getState(),
    levelId,
    derived: () => docStore.getState().derived[levelId()] ?? EMPTY_DERIVED,
    setHint(text: string) {
      // compare with the store, not a local copy: the shell also writes tool hints
      if (uiStore.getState().hint === text) return
      uiStore.getState().set({ hint: text })
    },
    setCursor() {
      /* replaced by the input layer */
    },
    mm: (px: number) => camera.mm(px),
    showContextMenu(at, list: ContextMenuItem[]) {
      html.showMenu(at.x, at.y, list)
    },
    isSelected(ref: EntityRef) {
      return uiStore.getState().selection.some((r) => r.kind === ref.kind && r.id === ref.id)
    },
  }
  ctx.hit = new HitIndex(ctx)

  const tools = createTools(ctx)
  let toolId: ToolId = uiStore.getState().tool
  let tool: Tool = tools[toolId] ?? tools.select

  function zoomToFit(): void {
    if (destroyed) return
    if (!syncSize()) {
      fitPending = true
      return
    }
    fitPending = false
    const s = docStore.getState()
    const box = fitBounds(s.doc, s.derived, levelId(), ctx.derived())
    if (box) camera.fit(box)
    else camera.reset()
    fitVersion = camera.version
    requestRender()
  }

  function zoomBy(factor: number): void {
    const at = ctx.pointer.inside && ctx.pointer.screen ? ctx.pointer.screen : { x: camera.width / 2, y: camera.height / 2 }
    camera.zoomAt(at.x, at.y, factor)
    requestRender()
  }

  const input = attachInput({
    ctx,
    tool: () => tool,
    toolId: () => toolId,
    zoomBy,
    onContextMenu(info) {
      const list = buildContextMenu(ctx, info.plan, zoomToFit)
      html.showMenu(info.screen.x, info.screen.y, list)
      requestRender()
    },
  })

  function switchTool(next: ToolId): void {
    if (next === toolId) return
    tool.deactivate?.()
    ctx.snapFeedback = null
    toolId = next
    tool = tools[next] ?? tools.select
    ctx.setCursor(tool.cursor)
    tool.activate?.()
    requestRender()
  }

  // ── frame ──
  function frame(): void {
    raf = 0
    if (destroyed) return
    input.flush()

    const wantPalette = paletteFor(uiStore.getState().theme)
    if (wantPalette !== palette) {
      palette = wantPalette
      app.renderer.background.color = palette.bg
    }

    const doc = ctx.doc()
    const lv = levelId()
    world.position.set(camera.tx, camera.ty)
    world.scale.set(camera.scale)
    worldUnder.position.set(camera.tx, camera.ty)
    worldUnder.scale.set(camera.scale)

    underlays.update(ctx)
    ghost.update(ctx, docStore.getState().derived)
    grid.update(ctx)
    rooms.update(ctx)
    walls.update(ctx)
    openings.update(ctx)
    items.update(ctx)

    // keep a traced image visible through room fills
    let tracing = false
    for (const id in doc.underlays) {
      const u = doc.underlays[id]
      if (u.levelId === lv && u.visible) {
        tracing = true
        break
      }
    }
    rooms.container.alpha = tracing ? 0.35 : 1

    painter.begin(palette)
    annotations.draw(ctx, painter)
    drawSelection(ctx, painter, computeHandles(ctx), tool.activeHandle?.() ?? null)
    drawCameraGizmo(ctx, painter)
    tool.draw?.(painter)
    drawSnapFeedback(ctx, painter)
    painter.end()

    app.render()
  }

  // ── sizing ──
  /** applies the viewport size to the renderer and camera; false while the viewport has no real size */
  function syncSize(): boolean {
    const w = root.clientWidth
    const h = root.clientHeight
    if (w < 2 || h < 2) return false
    const nextDpr = Math.max(1, window.devicePixelRatio || 1)
    if (w !== camera.width || h !== camera.height || nextDpr !== dpr) {
      dpr = nextDpr
      texts.resolution = dpr
      app.renderer.resize(w, h, dpr)
      camera.setSize(w, h)
    }
    return true
  }

  function resize(): void {
    if (destroyed) return
    const untouched = camera.version === fitVersion
    const { width, height } = camera
    if (!syncSize()) return
    // an untouched fitted view is refit to the new size; otherwise setSize kept the centre point fixed
    if (fitPending || (untouched && (camera.width !== width || camera.height !== height))) zoomToFit()
    else requestRender()
  }

  const ro = new ResizeObserver(() => resize())
  ro.observe(root)

  // ── stores ──
  const docIdentity = (s: { doc: Doc; filePath: string | null }): string => `${s.doc.meta.createdAt}|${s.filePath ?? ''}`
  const isEmpty = (doc: Doc, lv: Id): boolean => {
    for (const id in doc.walls) if (doc.walls[id].levelId === lv) return false
    for (const id in doc.items) if (doc.items[id].levelId === lv) return false
    for (const id in doc.underlays) if (doc.underlays[id].levelId === lv) return false
    return true
  }
  let lastIdentity = docIdentity(docStore.getState())

  const unsubDoc = docStore.subscribe((s, prev) => {
    if (s.doc === prev.doc && s.derived === prev.derived) return
    const identity = docIdentity(s)
    const lv = levelId()
    if (identity !== lastIdentity) {
      // another project was loaded
      lastIdentity = identity
      tool.cancel?.()
      zoomToFit()
    } else if ((toolId === 'select' || toolId === 'pan') && isEmpty(prev.doc, lv) && !isEmpty(s.doc, lv)) {
      // first content arrived from outside the editor (import, PlanSpec, underlay)
      zoomToFit()
    }
    requestRender()
  })

  const unsubUi = uiStore.subscribe((s, prev) => {
    if (s.tool !== prev.tool) switchTool(s.tool)
    if (
      s.tool !== prev.tool ||
      s.activeLevelId !== prev.activeLevelId ||
      s.selection !== prev.selection ||
      s.hover !== prev.hover ||
      s.theme !== prev.theme ||
      s.mode !== prev.mode ||
      s.lang !== prev.lang ||
      s.catalog !== prev.catalog ||
      s.wallKind !== prev.wallKind ||
      s.wallThickness !== prev.wallThickness ||
      s.openingKind !== prev.openingKind ||
      s.placingAssetId !== prev.placingAssetId ||
      s.paintFinish !== prev.paintFinish
    ) {
      requestRender()
    }
  })

  // provenance legend / «Обмер» hover and target are drawn by the annotations layer
  const unsubAccuracy = accuracyStore.subscribe(() => requestRender())

  // the 3D camera has no change event: poll it cheaply while a 3D view is visible
  let cameraSig = ''
  const cameraTimer = window.setInterval(() => {
    const engine = appHandles.engine3d
    if (!engine || uiStore.getState().mode === '2d') {
      if (cameraSig) {
        cameraSig = ''
        requestRender()
      }
      return
    }
    try {
      const c = engine.getCamera()
      const sig = `${c.position.map((v) => v.toFixed(3)).join(',')}|${c.target.map((v) => v.toFixed(3)).join(',')}|${c.fov}`
      if (sig !== cameraSig) {
        cameraSig = sig
        requestRender()
      }
    } catch {
      /* engine is being torn down */
    }
  }, 150)

  // WebGL context loss: everything is derived from the stores, a fresh frame restores the picture
  const onContextRestored = (): void => requestRender()
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  ctx.setCursor(tool.cursor)
  tool.activate?.()
  resize()
  requestRender()

  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      window.clearInterval(cameraTimer)
      ro.disconnect()
      unsubDoc()
      unsubUi()
      unsubAccuracy()
      try {
        tool.deactivate?.()
      } catch {
        /* stores may already be gone */
      }
      input.dispose()
      html.destroy()
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      underlays.destroy()
      texts.destroy()
      app.destroy({ removeView: true }, { children: true })
      root.remove()
    },
    resize,
    zoomToFit,
    zoomBy,
    toScreen(p) {
      const r = canvas.getBoundingClientRect()
      const s = camera.toScreen(p)
      return { x: s.x + r.left, y: s.y + r.top }
    },
    toPlan(clientX, clientY) {
      const r = canvas.getBoundingClientRect()
      return camera.toPlan(clientX - r.left, clientY - r.top)
    },
    snapshotPng(pixelsPerMetre) {
      return snapshotPng(levelId(), pixelsPerMetre)
    },
  }
}

export default createEditor2D
