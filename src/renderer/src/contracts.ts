/**
 * Renderer-side contracts between modules. Each module is owned by one implementer:
 *   store/      → stores below (zustand vanilla + React hooks)
 *   editor2d/   → createEditor2D
 *   view3d/     → createEngine3D (+ internal sub-contracts at the bottom)
 *   ui/         → React shell, inspector, catalog panels
 * Modules talk ONLY through these interfaces and through the stores.
 */
import type * as THREE from 'three'
import type {
  Asset,
  Catalog,
  DerivedPlan,
  Doc,
  EntityRef,
  Hdri,
  Id,
  Item,
  Material,
  Opening,
  OpeningKind,
  QualityPreset,
  SurfaceFinish,
  Vec2,
  WallKind,
} from '@core/types'

/** a door look picked from the Construction panel (kind + fields copied onto the new opening) */
export interface OpeningPreset {
  id: string
  kind: OpeningKind
  patch: Partial<Pick<Opening, 'width' | 'height' | 'style' | 'slide' | 'leafMaterialId' | 'frameMaterialId'>>
}

// ───────────────────────────── stores ─────────────────────────────

/** store/document.ts — `docStore` (zustand vanilla) + `useDoc(selector)` hook */
export interface DocState {
  doc: Doc
  /** derived geometry per level id, recomputed synchronously inside every commit */
  derived: Record<Id, DerivedPlan>
  /** monotonically increasing; bumped on every commit/undo/redo/load */
  revision: number
  filePath: string | null
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /**
   * The ONLY way to change the document. Runs `fn` on an Immer draft, then normalises
   * (core `normalize` + `syncRooms`), recomputes `derived`, pushes inverse patches to history.
   * `opts.merge` — coalesce with the previous history entry carrying the same key (for drags).
   * `opts.transient` — apply without history (live drag preview); call `commitTransient(label)`
   * to turn the accumulated transient changes into one history entry or `cancelTransient()`.
   */
  transact(label: string, fn: (draft: Doc) => void, opts?: { merge?: string; transient?: boolean }): void
  commitTransient(label: string): void
  cancelTransient(): void
  undo(): void
  redo(): void
  load(doc: Doc, filePath: string | null): void
  newDoc(name?: string): void
  markSaved(filePath: string): void
}

export type ToolId =
  | 'select'
  | 'pan'
  | 'wall'
  | 'room' // rectangle room
  | 'door'
  | 'window'
  | 'item' // placing `placing` asset
  | 'light'
  | 'dimension'
  | 'label'
  | 'measure'
  | 'survey' // «Обмер»: replace a dimension with a tape measurement
  | 'paint' // apply `paintMaterialId` to clicked surface
  | 'eyedropper'
  | 'calibrate' // underlay scale calibration: two clicks + typed length
  | 'split' // split wall at point
  | 'erase'

export type ViewMode = '2d' | '3d' | 'split'

/** store/ui.ts — `uiStore` + `useUi(selector)` */
export interface UiState {
  mode: ViewMode
  tool: ToolId
  activeLevelId: Id
  selection: EntityRef[]
  hover: EntityRef | null
  /** options for drawing tools */
  wallKind: WallKind
  wallThickness: number
  wallHeight: number
  openingKind: OpeningKind
  /** door preset picked in the Construction panel: applied by the opening tool to new openings of its kind */
  openingPreset: OpeningPreset | null
  /** asset being placed by the `item` tool */
  placingAssetId: Id | null
  /** finish applied by the `paint` tool */
  paintFinish: SurfaceFinish | null
  catalog: Catalog
  lang: 'ru' | 'en'
  theme: 'dark' | 'light'
  /** live cursor position on the plan, mm (status bar) */
  cursor: Vec2 | null
  /** status-bar hint text */
  hint: string
  cameraMode: 'orbit' | 'walk' | 'top'
  pathTracing: { active: boolean; samples: number; target: number }
  setMode(m: ViewMode): void
  setTool(t: ToolId): void
  select(refs: EntityRef[], additive?: boolean): void
  clearSelection(): void
  set(patch: Partial<UiState>): void
  /** lookups that consider project-local entries first, then the catalog */
  getMaterial(id: Id): Material | undefined
  getAsset(id: Id): Asset | undefined
  getHdri(id: Id): Hdri | undefined
  setCatalog(c: Catalog): void
}

// ───────────────────────────── 2D editor ─────────────────────────────

export interface Editor2DHandle {
  destroy(): void
  resize(): void
  zoomToFit(): void
  zoomBy(factor: number): void
  /** plan mm → client px and back */
  toScreen(p: Vec2): Vec2
  toPlan(clientX: number, clientY: number): Vec2
  /** raster snapshot of the current level without UI chrome */
  snapshotPng(pixelsPerMetre: number): Promise<Blob>
}

/** editor2d/index.ts */
export type CreateEditor2D = (container: HTMLElement) => Promise<Editor2DHandle>

// ───────────────────────────── 3D engine ─────────────────────────────

export interface StillOptions {
  width: number
  height: number
  /** 'realtime' = current post stack supersampled; 'pathtraced' = three-gpu-pathtracer */
  mode: 'realtime' | 'pathtraced'
  samples?: number
  format?: 'png' | 'jpeg'
  onProgress?(samples: number, total: number): void
  signal?: AbortSignal
}

export interface Engine3DHandle {
  destroy(): void
  resize(): void
  /** 'webgpu' | 'webgl2' actually in use */
  readonly backend: string
  setCameraMode(mode: 'orbit' | 'walk' | 'top'): void
  focusSelection(): void
  resetCamera(): void
  getCamera(): { position: [number, number, number]; target: [number, number, number]; fov: number }
  setCamera(c: { position: [number, number, number]; target: [number, number, number]; fov?: number }): void
  setQuality(q: QualityPreset): void
  /** interactive progressive path tracing in the viewport */
  startPathTracing(targetSamples: number): void
  stopPathTracing(): void
  renderStill(opts: StillOptions): Promise<Blob>
  exportGlb(): Promise<ArrayBuffer>
  /** square PNG thumbnail of an asset / material sphere on neutral background */
  renderAssetThumb(asset: Asset, size: number): Promise<Blob>
  renderMaterialThumb(material: Material, size: number): Promise<Blob>
  /** converts user model files (glb/gltf/obj/fbx) to a normalised GLB (metres, Y-up, origin at footprint centre on floor) */
  convertModel(file: { name: string; data: ArrayBuffer }, aux?: { name: string; data: ArrayBuffer }[]): Promise<{
    glb: ArrayBuffer
    size: { w: number; d: number; h: number }
    slots: string[]
  }>
}

/** view3d/index.ts — lazy-loaded chunk */
export type CreateEngine3D = (container: HTMLElement) => Promise<Engine3DHandle>

// ───────────── view3d internal sub-contracts (three implementers share the folder) ─────────────

/** view3d/engine.ts owns this object and passes it to every sub-module. */
export interface EngineContext {
  renderer: any // THREE.WebGPURenderer from 'three/webgpu'
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  container: HTMLElement
  canvas: HTMLCanvasElement
  /** root groups rebuilt from the document */
  roots: {
    architecture: THREE.Group // walls, floors, ceilings, openings, skirting — children carry userData.ref
    items: THREE.Group // one child per Item, userData.ref = {kind:'item', id}
    lights: THREE.Group // fixtures + THREE lights from doc.lights
    helpers: THREE.Group // gizmos, outlines — excluded from stills/path tracing/export
  }
  /** request a frame (on-demand rendering). Pass true while something animates. */
  invalidate(): void
  /** fired after the scene graph was rebuilt from the document (path tracer must reset) */
  onSceneChanged(cb: () => void): () => void
  /** fired every rendered frame before render; dt seconds */
  onBeforeRender(cb: (dt: number) => void): () => void
  quality: QualityPreset
  /** current level bounds in world metres */
  getBounds(): THREE.Box3
}

/** view3d/materials.ts (implementer: 3D-architecture) */
export interface MaterialLibrary {
  /** cached PBR material for a finish; real-world UVs assumed (1 UV unit = 1 metre) */
  get(finish: SurfaceFinish | Id, opts?: { doubleSided?: boolean }): THREE.Material
  /** material for an item slot */
  getForItem(materialId: Id, tint?: string): THREE.Material
  dispose(): void
}

/** view3d/procedural/index.ts (implementer: 3D-procedural) */
export interface ProceduralFactory {
  /**
   * Builds a procedural asset. Local frame: metres, Y-up, origin at the footprint centre on the floor,
   * +Z = front (faces the room). Must exactly fill size (w→X, h→Y, d→Z). Meshes must set
   * `userData.slot` (e.g. 'body', 'front', 'worktop', 'fabric', 'legs', 'metal', 'glass', 'screen').
   */
  build(asset: Asset, item: Item, mats: MaterialLibrary): THREE.Object3D
  /** curtain / blind geometry for an opening; local frame: X along the wall, Y up, origin at floor under opening centre */
  buildCurtain(
    spec: import('@core/types').CurtainSpec,
    dims: { width: number; top: number; bottom: number },
    mats: MaterialLibrary,
  ): THREE.Object3D
}

/** view3d/lighting.ts, post.ts, controls.ts, interaction.ts, pathtracer.ts (implementer: 3D-rendering) */
export interface LightingRig {
  /** (re)build sun, sky/HDRI environment, window portals and doc lights from doc.render + doc.lights */
  sync(): void
  dispose(): void
}
export interface PostPipeline {
  render(): void
  setSize(w: number, h: number, dpr: number): void
  setQuality(q: QualityPreset): void
  /** outline these objects (selection / hover) */
  setOutline(selected: THREE.Object3D[], hovered: THREE.Object3D | null): void
  dispose(): void
}
export interface CameraControls {
  setMode(mode: 'orbit' | 'walk' | 'top'): void
  update(dt: number): boolean // true while moving
  fit(box: THREE.Box3): void
  get target(): THREE.Vector3
  dispose(): void
}
export interface PathTracerHandle {
  start(targetSamples: number, onProgress: (s: number) => void): void
  stop(): void
  readonly active: boolean
  /** render one progressive sample to screen; returns current sample count */
  step(): number
  renderStill(opts: StillOptions): Promise<Blob>
  dispose(): void
}
