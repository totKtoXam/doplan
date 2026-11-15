/**
 * Pointer / keyboard interaction of the 3D view (area: 3d-rendering).
 *
 *  - picking on ctx.roots (items, lights, architecture) → uiStore.select / hover + outline;
 *  - click selects objects, double click selects the wall / room under the cursor;
 *  - dragging items: floor items slide on the floor and snap with their back to walls (rotation
 *    aligned) and to other items' bounding boxes, wall items slide on wall faces, ceiling items
 *    on the ceiling plane; one drag = transient transaction → one history entry on release;
 *  - gizmo for a single selected item (ring = rotate, puck = move) drawn in ctx.roots.helpers;
 *  - keyboard: R rotates 45°, Delete removes, arrows nudge, Esc cancels;
 *  - tools: `item` (ghost preview + click to place), `paint`, `eyedropper`, `erase`.
 *
 * Scene conventions relied upon (set by the scene builder): objects carry `userData.ref`
 * ({kind, id}); floors / ceilings `userData.surface` ('floor' | 'ceiling' | 'skirting'), wall
 * faces `userData.side` ('left' | 'right'), item meshes `userData.slot`.
 */
import * as THREE from 'three'
import {
  addItem,
  applyFinishToWallSide,
  canSupport,
  clampItemSize,
  findSupport,
  layerIndex,
  minItemSize,
  mountForElevation,
  planResizeTargets,
  pointInPolygon,
  removeEntities,
  resizeFromFace,
  resizedParams,
  snapValue,
  supportCoverage,
  wallFaceSegments,
  type ItemPose,
  type PlanSeg,
  type SnapTarget,
} from '@core'
import type { Asset, DerivedPlan, Doc, EntityKind, EntityRef, Id, Item, MountKind, SurfaceFinish, Wall, WallGeom } from '@core/types'
import type { CameraControls, EngineContext, PostPipeline } from '@/contracts'
import { formatLen, isLengthChar, parseLengthInput } from '@/editor2d/format'
import { docStore } from '@/store/document'
import { toast } from '@/store/notify'
import { resizePrefs } from '@/store/resizePrefs'
import { uiStore } from '@/store/ui'
import { t } from '@/i18n'
import { getShared } from './quality'
import { type HandleSpec, ResizeHandles, worldPerPixel } from './resizeHandles'

const DEG = Math.PI / 180
const CLICK_SLOP = 4 // px
const WALL_SNAP = 180 // mm
const ITEM_SNAP = 60 // mm
const ROTATE_STEP = 15 // degrees while dragging the ring
const ENTITY_KINDS: ReadonlySet<string> = new Set<EntityKind>(['node', 'wall', 'opening', 'room', 'item', 'light', 'dimension', 'label', 'underlay'])

interface Hit {
  ref: EntityRef | null
  /** object that carries the ref (or the mesh itself when there is none) */
  object: THREE.Object3D
  mesh: THREE.Object3D
  point: THREE.Vector3
  distance: number
  surface?: string
  side?: 'left' | 'right'
  slot?: string
  zone?: { from: number; to: number }
  root: 'items' | 'lights' | 'architecture'
}

interface WallFaceHit {
  wall: Wall
  side: 'left' | 'right'
  /** point on the face, plan mm */
  x: number
  y: number
  /** mm above the floor */
  height: number
  /** unit normal of the face pointing into the room, plan coords */
  nx: number
  ny: number
  distance: number
}

interface Placement {
  x: number
  y: number
  rotation: number
  elevation: number
}

interface StartPose {
  x: number
  y: number
  rotation: number
  elevation: number
}

type DragState =
  | {
      kind: 'move'
      primary: EntityRef
      refs: EntityRef[]
      start: Map<Id, StartPose>
      /** world height of the plane the pointer slides on */
      planeY: number
      /** primary centre − grabbed point, plan mm */
      offX: number
      offY: number
      /** grabbed height − item elevation, mm (wall items) */
      offH: number
      /** surface items: tops (mm) of the items they can be put on, highest first */
      tops: number[]
      /** surface items: elevation off any support (the floor for a vase lifted off its table) */
      rest: number
      applied: boolean
    }
  | {
      /** one face of the item follows the pointer, the opposite face stays */
      kind: 'resize'
      id: Id
      handle: string
      axis: 'w' | 'd' | 'h'
      side: 1 | -1
      start: ItemPose
      startParams: Item['params']
      asset: Asset | undefined
      /** world line the handle slides on */
      origin: THREE.Vector3
      dir: THREE.Vector3
      t0: number
      /** digits typed during the drag (exact size) */
      typed: string
      len: number
      applied: boolean
    }
  | {
      /** the vertical arrow: raise / lower the whole item */
      kind: 'elevate'
      id: Id
      start: ItemPose
      startMount: MountKind
      origin: THREE.Vector3
      dir: THREE.Vector3
      t0: number
      typed: string
      applied: boolean
    }
  | {
      kind: 'rotate'
      id: Id
      startRotation: number
      startAngle: number
      cx: number
      cy: number
      planeY: number
      applied: boolean
    }

interface PendingDrag {
  hit: Hit
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function refKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`
}

function sameRef(a: EntityRef | null, b: EntityRef | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.id === b.id
}

function normDeg(a: number): number {
  const r = ((a % 360) + 360) % 360
  return Math.abs(r - 360) < 1e-6 ? 0 : r
}

/** Half extents of the plan-axis-aligned box around a rotated footprint. */
function aabbHalf(w: number, d: number, rotationDeg: number): { hx: number; hy: number } {
  const c = Math.abs(Math.cos(rotationDeg * DEG))
  const s = Math.abs(Math.sin(rotationDeg * DEG))
  return { hx: (w / 2) * c + (d / 2) * s, hy: (w / 2) * s + (d / 2) * c }
}

/** Plan rotation whose front (+Z local → plan +y at 0°) points along the unit normal (nx, ny). */
function rotationFacing(nx: number, ny: number): number {
  return normDeg(Math.atan2(-nx, ny) / DEG)
}

export function createInteraction(ctx: EngineContext, deps: { controls: CameraControls; post: PostPipeline }): { dispose(): void } {
  const { camera, canvas, container } = ctx
  const shared = getShared(ctx)
  const controls = deps.controls as CameraControls & { enabled?: boolean; mode?: string }
  const post = deps.post

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const plane = new THREE.Plane()
  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  const v3 = new THREE.Vector3()

  let disposed = false
  let pointerInside = false
  let down: { x: number; y: number; button: number; pointerId: number; shift: boolean; ctrl: boolean } | null = null
  let pending: PendingDrag | null = null
  let drag: DragState | null = null
  let lastMove: PointerEvent | null = null
  let lastPointer: PointerEvent | null = null
  let frame = 0
  let hoverHit: Hit | null = null
  let placement: Placement | null = null
  let placementRotation = 0
  let controlsLocked = false

  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0
  canvas.style.outline = 'none'

  // ───────────────────────────── scene index ─────────────────────────────

  let index: Map<string, THREE.Object3D[]> | null = null

  function buildIndex(): Map<string, THREE.Object3D[]> {
    const map = new Map<string, THREE.Object3D[]>()
    const visit = (o: THREE.Object3D): void => {
      const ref = o.userData?.ref as EntityRef | undefined
      if (ref && typeof ref.id === 'string' && ENTITY_KINDS.has(ref.kind)) {
        const key = refKey(ref)
        const list = map.get(key)
        if (list) list.push(o)
        else map.set(key, [o])
        // nested refs (e.g. an opening inside a wall group) are still indexed
      }
      for (const child of o.children) visit(child)
    }
    visit(ctx.roots.architecture)
    visit(ctx.roots.items)
    visit(ctx.roots.lights)
    return map
  }

  function objectsOf(ref: EntityRef): THREE.Object3D[] {
    if (!index) index = buildIndex()
    return index.get(refKey(ref)) ?? []
  }

  function isShown(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (!p.visible) return false
    }
    return true
  }

  function entityVisible(ref: EntityRef): boolean {
    const list = objectsOf(ref)
    if (list.length === 0) return true
    return list.some(isShown)
  }

  // ───────────────────────────── document helpers ─────────────────────────────

  function levelId(): Id {
    const doc = docStore.getState().doc
    const id = uiStore.getState().activeLevelId
    return doc.levels[id] ? id : doc.levelOrder[0]
  }

  function planOf(): DerivedPlan | undefined {
    return docStore.getState().derived[levelId()]
  }

  function levelHeight(doc: Doc): number {
    return doc.levels[levelId()]?.height ?? doc.settings.wallHeight ?? 2700
  }

  function roomAt(x: number, y: number): Id | null {
    const plan = planOf()
    if (!plan) return null
    for (const room of plan.rooms) {
      if (pointInPolygon({ x, y }, room.polygon)) return room.roomId
    }
    return null
  }

  function ceilingHeightAt(doc: Doc, x: number, y: number): number {
    const roomId = roomAt(x, y)
    const room = roomId ? doc.rooms[roomId] : undefined
    return room?.ceiling?.height ?? levelHeight(doc)
  }

  function setHint(text: string): void {
    const ui = uiStore.getState()
    if (ui.hint !== text) ui.set({ hint: text })
  }

  // ───────────────────────────── picking ─────────────────────────────

  function setRay(e: { clientX: number; clientY: number }): void {
    const rect = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1)
    camera.updateMatrixWorld()
    raycaster.setFromCamera(ndc, camera)
  }

  function collect(o: THREE.Object3D, out: THREE.Intersection[]): void {
    if (!o.visible || o.userData?.noPick === true) return
    if (o.layers.test(raycaster.layers)) o.raycast(raycaster, out)
    const children = o.children
    for (let i = 0; i < children.length; i++) collect(children[i], out)
  }

  function describe(hit: THREE.Intersection, root: Hit['root']): Hit {
    let ref: EntityRef | null = null
    let owner: THREE.Object3D = hit.object
    let surface: string | undefined
    let side: 'left' | 'right' | undefined
    let slot: string | undefined
    let zone: { from: number; to: number } | undefined
    const stop = ctx.roots[root]
    for (let o: THREE.Object3D | null = hit.object; o && o !== stop; o = o.parent) {
      const ud = o.userData
      if (!ud) continue
      if (surface === undefined && typeof ud.surface === 'string') surface = ud.surface
      if (side === undefined && (ud.side === 'left' || ud.side === 'right')) side = ud.side
      if (slot === undefined && typeof ud.slot === 'string') slot = ud.slot
      if (zone === undefined && ud.zone && typeof ud.zone.from === 'number' && typeof ud.zone.to === 'number') zone = ud.zone
      // geometry groups may carry per-group slots
      if (!ref && ud.ref && typeof ud.ref.id === 'string' && ENTITY_KINDS.has(ud.ref.kind)) {
        ref = { kind: ud.ref.kind, id: ud.ref.id }
        owner = o
      }
    }
    // locked (layers panel) objects block the ray but are not touchable on the canvas
    if (ref && !layerIndex(docStore.getState().doc).pickable(ref.kind, ref.id)) {
      ref = null
      owner = hit.object
    }
    if (slot === undefined && hit.face && Array.isArray((hit.object as THREE.Mesh).material)) {
      const mats = (hit.object as THREE.Mesh).material as THREE.Material[]
      const m = mats[hit.face.materialIndex]
      if (m && typeof m.userData?.slot === 'string') slot = m.userData.slot
    }
    return { ref, object: owner, mesh: hit.object, point: hit.point.clone(), distance: hit.distance, surface, side, slot, zone, root }
  }

  /** Nearest visible hit over the given roots (the ray must be set). */
  function pick(roots: Array<Hit['root']> = ['items', 'lights', 'architecture']): Hit | null {
    let best: THREE.Intersection | null = null
    let bestRoot: Hit['root'] = 'architecture'
    const list: THREE.Intersection[] = []
    for (const name of roots) {
      list.length = 0
      collect(ctx.roots[name], list)
      for (const h of list) {
        if (!best || h.distance < best.distance) {
          best = h
          bestRoot = name
        }
      }
    }
    return best ? describe(best, bestRoot) : null
  }

  function rayPlane(y: number, out: THREE.Vector3): THREE.Vector3 | null {
    plane.set(v1.set(0, 1, 0), -y)
    const p = raycaster.ray.intersectPlane(plane, out)
    if (!p) return null
    // ignore intersections near the horizon: they fling objects kilometres away
    if (raycaster.ray.origin.distanceTo(p) > 400) return null
    return p
  }

  /** Analytic ray ∩ wall faces (independent of how the wall meshes are built). */
  function rayWallFace(): WallFaceHit | null {
    const state = docStore.getState()
    const doc = state.doc
    const plan = planOf()
    if (!plan) return null
    const lid = levelId()
    const o = raycaster.ray.origin
    const d = raycaster.ray.direction
    let best: WallFaceHit | null = null
    for (const id in doc.walls) {
      const wall = doc.walls[id]
      if (wall.levelId !== lid || wall.kind === 'virtual') continue
      const g = plan.wallGeoms[id]
      if (!g || !(g.length > 1)) continue
      if (!entityVisible({ kind: 'wall', id })) continue
      const lx = (g.b.y - g.a.y) / g.length
      const ly = -(g.b.x - g.a.x) / g.length
      const faces: Array<['left' | 'right', WallGeom['left'], number, number]> = [
        ['left', g.left, lx, ly],
        ['right', g.right, -lx, -ly],
      ]
      for (const [side, seg, nx, ny] of faces) {
        const denom = d.x * nx + d.z * ny
        if (denom > -1e-5) continue // back face or parallel
        const p0x = seg[0].x / 1000
        const p0z = seg[0].y / 1000
        const s = ((p0x - o.x) * nx + (p0z - o.z) * ny) / denom
        if (s <= 0 || (best && s >= best.distance)) continue
        const hx = (o.x + d.x * s) * 1000
        const hy = (o.z + d.z * s) * 1000
        const height = (o.y + d.y * s) * 1000
        if (height < 0 || height > wall.height) continue
        const ex = seg[1].x - seg[0].x
        const ey = seg[1].y - seg[0].y
        const len = Math.hypot(ex, ey)
        if (len < 1) continue
        const along = ((hx - seg[0].x) * ex + (hy - seg[0].y) * ey) / len
        if (along < 0 || along > len) continue
        best = { wall, side, x: hx, y: hy, height, nx, ny, distance: s }
      }
    }
    return best
  }

  // ───────────────────────────── snapping ─────────────────────────────

  function snapFloor(
    doc: Doc,
    size: { w: number; d: number },
    x: number,
    y: number,
    rotation: number,
    exclude: ReadonlySet<Id>,
    allowRotate: boolean,
  ): { x: number; y: number; rotation: number } {
    const plan = planOf()
    const lid = levelId()
    let rx = x
    let ry = y
    let rot = rotation
    let tangentX = 0
    let tangentY = 0
    let wallSnapped = false

    if (plan) {
      // 1. back to the nearest wall face
      let bestGap = Infinity
      let bestNx = 0
      let bestNy = 0
      let bestDist = 0
      let bestWall: Id | null = null
      for (const id in doc.walls) {
        const wall = doc.walls[id]
        if (wall.levelId !== lid || wall.kind === 'virtual') continue
        const g = plan.wallGeoms[id]
        if (!g || !(g.length > 1)) continue
        const lx = (g.b.y - g.a.y) / g.length
        const ly = -(g.b.x - g.a.x) / g.length
        const faces: Array<[WallGeom['left'], number, number]> = [
          [g.left, lx, ly],
          [g.right, -lx, -ly],
        ]
        for (const [seg, nx, ny] of faces) {
          const ex = seg[1].x - seg[0].x
          const ey = seg[1].y - seg[0].y
          const len = Math.hypot(ex, ey)
          if (len < 1) continue
          const along = ((x - seg[0].x) * ex + (y - seg[0].y) * ey) / len
          if (along < -40 || along > len + 40) continue
          const dist = (x - seg[0].x) * nx + (y - seg[0].y) * ny
          if (dist < -wall.thickness / 2) continue // behind the wall axis
          // depth the item will have against this wall
          const depth = allowRotate ? size.d : 2 * (Math.abs((size.w / 2) * (Math.cos(rot * DEG) * nx + Math.sin(rot * DEG) * ny)) + Math.abs((size.d / 2) * (-Math.sin(rot * DEG) * nx + Math.cos(rot * DEG) * ny)))
          const gap = dist - depth / 2
          if (gap < WALL_SNAP && gap < bestGap) {
            bestGap = gap
            bestNx = nx
            bestNy = ny
            bestDist = dist
            bestWall = id
          }
        }
      }
      if (bestWall) {
        wallSnapped = true
        if (allowRotate) rot = rotationFacing(bestNx, bestNy)
        const half = allowRotate
          ? size.d / 2
          : Math.abs((size.w / 2) * (Math.cos(rot * DEG) * bestNx + Math.sin(rot * DEG) * bestNy)) + Math.abs((size.d / 2) * (-Math.sin(rot * DEG) * bestNx + Math.cos(rot * DEG) * bestNy))
        const shift = half + 2 - bestDist
        rx += bestNx * shift
        ry += bestNy * shift
        tangentX = -bestNy
        tangentY = bestNx

        // 2. corners: do not let the sides sink into the other walls
        const ux = Math.cos(rot * DEG)
        const uy = Math.sin(rot * DEG)
        const fx = -Math.sin(rot * DEG)
        const fy = Math.cos(rot * DEG)
        for (const id in doc.walls) {
          const wall = doc.walls[id]
          if (wall.levelId !== lid || wall.kind === 'virtual') continue
          const g = plan.wallGeoms[id]
          if (!g || !(g.length > 1)) continue
          const lx = (g.b.y - g.a.y) / g.length
          const ly = -(g.b.x - g.a.x) / g.length
          const faces: Array<[WallGeom['left'], number, number]> = [
            [g.left, lx, ly],
            [g.right, -lx, -ly],
          ]
          for (const [seg, nx, ny] of faces) {
            if (Math.abs(nx * bestNx + ny * bestNy) > 0.9) continue
            const ex = seg[1].x - seg[0].x
            const ey = seg[1].y - seg[0].y
            const len = Math.hypot(ex, ey)
            if (len < 1) continue
            const along = ((rx - seg[0].x) * ex + (ry - seg[0].y) * ey) / len
            if (along < -60 || along > len + 60) continue
            const dist = (rx - seg[0].x) * nx + (ry - seg[0].y) * ny
            if (dist < -wall.thickness / 2) continue
            const extent = Math.abs((size.w / 2) * (ux * nx + uy * ny)) + Math.abs((size.d / 2) * (fx * nx + fy * ny))
            const gap = dist - extent
            if (gap < WALL_SNAP * 0.7) {
              const push = extent + 2 - dist
              rx += nx * push
              ry += ny * push
            }
          }
        }
      }
    }

    // 3. neighbours' bounding boxes
    const mine = aabbHalf(size.w, size.d, rot)
    const allowX = !wallSnapped || Math.abs(tangentX) > 0.95
    const allowY = !wallSnapped || Math.abs(tangentY) > 0.95
    let bestDx = ITEM_SNAP
    let bestDy = ITEM_SNAP
    let snapX: number | null = null
    let snapY: number | null = null
    for (const id in doc.items) {
      if (exclude.has(id)) continue
      const other = doc.items[id]
      if (other.levelId !== lid || other.hidden || other.mount === 'ceiling') continue
      const oh = aabbHalf(other.size.w, other.size.d, other.rotation)
      const gapX = Math.abs(rx - other.x) - mine.hx - oh.hx
      const gapY = Math.abs(ry - other.y) - mine.hy - oh.hy
      if (gapX > 400 || gapY > 400) continue
      if (allowX && gapY < 300) {
        const candidates = [other.x + oh.hx + mine.hx, other.x - oh.hx - mine.hx, other.x - oh.hx + mine.hx, other.x + oh.hx - mine.hx, other.x]
        for (const c of candidates) {
          const dd = Math.abs(c - rx)
          if (dd < bestDx) {
            bestDx = dd
            snapX = c
          }
        }
      }
      if (allowY && gapX < 300) {
        const candidates = [other.y + oh.hy + mine.hy, other.y - oh.hy - mine.hy, other.y - oh.hy + mine.hy, other.y + oh.hy - mine.hy, other.y]
        for (const c of candidates) {
          const dd = Math.abs(c - ry)
          if (dd < bestDy) {
            bestDy = dd
            snapY = c
          }
        }
      }
    }
    if (snapX !== null) rx = snapX
    if (snapY !== null) ry = snapY
    return { x: rx, y: ry, rotation: rot }
  }

  function snappingOn(e: { altKey: boolean } | null): boolean {
    if (e?.altKey) return false
    return docStore.getState().doc.settings.snapObjects !== false
  }

  // ───────────────────────────── outline / hover ─────────────────────────────

  function syncOutline(): void {
    const ui = uiStore.getState()
    const selected: THREE.Object3D[] = []
    for (const ref of ui.selection) {
      for (const o of objectsOf(ref)) selected.push(o)
    }
    let hovered: THREE.Object3D | null = null
    if (ui.hover && !drag) {
      if (hoverHit && sameRef(hoverHit.ref, ui.hover) && hoverHit.object.parent) hovered = hoverHit.object
      else hovered = objectsOf(ui.hover)[0] ?? null
      if (hovered && ui.selection.some((s) => sameRef(s, ui.hover))) hovered = null
    }
    post.setOutline(selected, hovered)
  }

  function setHover(hit: Hit | null): void {
    hoverHit = hit
    const ref = hit?.ref ?? null
    const ui = uiStore.getState()
    if (!sameRef(ui.hover, ref)) ui.set({ hover: ref })
    else syncOutline()
  }

  function setCursor(value: string): void {
    if (canvas.style.cursor !== value) canvas.style.cursor = value
  }

  function lockControls(lock: boolean): void {
    if (controlsLocked === lock) return
    controlsLocked = lock
    if ('enabled' in controls) controls.enabled = !lock
  }

  // ───────────────────────────── gizmo ─────────────────────────────

  const accent = new THREE.Color(0x4c9aff)
  try {
    const css = getComputedStyle(container).getPropertyValue('--accent').trim()
    if (css) accent.setStyle(css)
  } catch {
    /* default accent */
  }
  const gizmoMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  const gizmoSoftMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false })
  const ghostLineMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
  const unitBox = new THREE.BoxGeometry(1, 1, 1)
  const unitEdges = new THREE.EdgesGeometry(unitBox)
  const knobGeometry = new THREE.SphereGeometry(1, 16, 12)
  const puckGeometry = new THREE.RingGeometry(0.55, 1, 28)
  const arrowGeometry = new THREE.ConeGeometry(0.5, 1, 3)

  const gizmo = new THREE.Group()
  gizmo.name = 'doplan-gizmo'
  gizmo.renderOrder = 1000
  gizmo.visible = false
  let ringMesh: THREE.Mesh | null = null
  let ringRadius = 0
  const knob = new THREE.Mesh(knobGeometry, gizmoSoftMaterial)
  knob.renderOrder = 1001
  const puck = new THREE.Mesh(puckGeometry, gizmoSoftMaterial)
  puck.rotation.x = -Math.PI / 2
  puck.renderOrder = 1001
  gizmo.add(knob, puck)
  let gizmoItem: Id | null = null
  const resizeHandles = new ResizeHandles(accent)
  /** a typed-size Enter ended the drag while the button is still down: ignore that release */
  let swallowUp = false
  /** the status hint currently describes a hovered handle */
  let handleHint = false

  const ghost = new THREE.Group()
  ghost.name = 'doplan-placement-ghost'
  ghost.visible = false
  const ghostBox = new THREE.Mesh(unitBox, ghostMaterial)
  const ghostEdges = new THREE.LineSegments(unitEdges, ghostLineMaterial)
  const ghostArrow = new THREE.Mesh(arrowGeometry, gizmoMaterial)
  ghostEdges.renderOrder = 1000
  ghostArrow.renderOrder = 1001
  ghost.add(ghostBox, ghostEdges, ghostArrow)

  function ensureHelpers(): void {
    const root = ctx.roots.helpers
    if (gizmo.parent !== root) root.add(gizmo)
    if (resizeHandles.group.parent !== root) root.add(resizeHandles.group)
    if (ghost.parent !== root) root.add(ghost)
  }

  /** the camera looks (almost) straight down: vertical handles make no sense */
  function topView(): boolean {
    if (controls.mode === 'top' || uiStore.getState().cameraMode === 'top') return true
    camera.getWorldDirection(v1)
    return v1.y < -0.985
  }

  /** the item whose resize handles are shown, if any */
  function handleItem(): Item | undefined {
    const ui = uiStore.getState()
    if (ui.selection.length !== 1 || ui.selection[0].kind !== 'item' || !selectLike(ui.tool) || shared.stillBusy) return undefined
    const it = docStore.getState().doc.items[ui.selection[0].id]
    if (!it || it.locked || it.hidden || it.levelId !== levelId()) return undefined
    return it
  }

  function refreshHandles(): void {
    const d = drag
    // while moving / rotating the item the handles would only flicker along
    const it = d && (d.kind === 'move' || d.kind === 'rotate') ? undefined : handleItem()
    if (!it) {
      if (resizeHandles.hide()) ctx.invalidate()
      return
    }
    resizeHandles.sync(it, camera, Math.max(1, canvas.clientHeight), topView())
    ctx.invalidate()
  }

  function refreshGizmo(): void {
    ensureHelpers()
    refreshHandles()
    const ui = uiStore.getState()
    const doc = docStore.getState().doc
    const only = ui.selection.length === 1 && ui.selection[0].kind === 'item' ? doc.items[ui.selection[0].id] : undefined
    const show = !!only && !only.locked && !only.hidden && only.levelId === levelId() && ui.tool !== 'item' && !shared.stillBusy && (only.mount === 'floor' || only.mount === 'surface' || only.mount === 'free')
    if (!show || !only) {
      if (gizmo.visible) {
        gizmo.visible = false
        ctx.invalidate()
      }
      gizmoItem = null
      return
    }
    const radius = Math.hypot(only.size.w, only.size.d) / 2000 + 0.16
    if (!ringMesh || Math.abs(radius - ringRadius) > 1e-3) {
      if (ringMesh) {
        gizmo.remove(ringMesh)
        ringMesh.geometry.dispose()
      }
      ringRadius = radius
      ringMesh = new THREE.Mesh(new THREE.RingGeometry(radius - 0.011, radius + 0.011, 96), gizmoMaterial)
      ringMesh.rotation.x = -Math.PI / 2
      ringMesh.renderOrder = 1000
      gizmo.add(ringMesh)
    }
    gizmoItem = only.id
    gizmo.position.set(only.x / 1000, only.elevation / 1000 + 0.015, only.y / 1000)
    // front of the item on the plan at rotation θ: (−sin θ, cos θ)
    const a = only.rotation * DEG
    knob.position.set(-Math.sin(a) * radius, 0, Math.cos(a) * radius)
    const dist = camera.position.distanceTo(gizmo.position)
    const k = THREE.MathUtils.clamp(dist * 0.012, 0.035, 0.2)
    knob.scale.setScalar(k)
    puck.scale.setScalar(THREE.MathUtils.clamp(dist * 0.02, 0.06, 0.3))
    gizmo.visible = true
    gizmo.updateMatrixWorld(true)
    ctx.invalidate()
  }

  /** 'rotate' | 'move' when the ray (already set) touches a gizmo handle. */
  function gizmoHit(): 'rotate' | 'move' | null {
    if (!gizmo.visible || !gizmoItem) return null
    const p = rayPlane(gizmo.position.y, v2)
    if (!p) return null
    const dist = camera.position.distanceTo(gizmo.position)
    const dx = p.x - gizmo.position.x
    const dz = p.z - gizmo.position.z
    const r = Math.hypot(dx, dz)
    const knobTol = Math.max(0.07, dist * 0.022)
    if (Math.hypot(dx - knob.position.x, dz - knob.position.z) < knobTol) return 'rotate'
    if (Math.abs(r - ringRadius) < Math.max(0.045, dist * 0.014)) return 'rotate'
    if (r < Math.max(0.07, dist * 0.022)) return 'move'
    return null
  }

  // ───────────────────────────── placement ghost (tool: item) ─────────────────────────────

  function placingAsset(): Asset | undefined {
    const ui = uiStore.getState()
    if (ui.tool !== 'item' || !ui.placingAssetId) return undefined
    return ui.getAsset(ui.placingAssetId)
  }

  function hideGhost(): void {
    placement = null
    if (ghost.visible) {
      ghost.visible = false
      ctx.invalidate()
    }
  }

  function computePlacement(asset: Asset, e: PointerEvent | null): Placement | null {
    const doc = docStore.getState().doc
    const size = asset.size
    if (asset.mount === 'wall') {
      const face = rayWallFace()
      if (!face) return null
      const elevation = THREE.MathUtils.clamp(asset.elevation ?? face.height - size.h / 2, 0, Math.max(0, face.wall.height - size.h))
      return { x: face.x + face.nx * (size.d / 2 + 1), y: face.y + face.ny * (size.d / 2 + 1), rotation: rotationFacing(face.nx, face.ny), elevation }
    }
    if (asset.mount === 'ceiling') {
      const top = levelHeight(doc)
      const p = rayPlane(top / 1000, v2)
      if (!p) return null
      const x = p.x * 1000
      const y = p.z * 1000
      return { x, y, rotation: normDeg(placementRotation), elevation: Math.max(0, ceilingHeightAt(doc, x, y) - size.h) }
    }
    if (asset.mount === 'surface') {
      // put it on the item under the pointer (vase on a table, TV on a stand)
      const others = supportsOf(doc, new Set())
      const land = landOnSupport(size, normDeg(placementRotation), 0, 0, others, topsOf(others))
      if (land) return { x: land.x, y: land.y, rotation: normDeg(placementRotation), elevation: land.elevation }
    }
    const elevation = asset.mount === 'surface' || asset.mount === 'free' ? (asset.elevation ?? 0) : 0
    const p = rayPlane(elevation / 1000, v2)
    if (!p) return null
    let x = p.x * 1000
    let y = p.z * 1000
    let rotation = normDeg(placementRotation)
    if (snappingOn(e) && asset.mount === 'floor') {
      const s = snapFloor(doc, size, x, y, rotation, new Set<Id>(), true)
      x = s.x
      y = s.y
      rotation = s.rotation
    }
    return { x, y, rotation, elevation }
  }

  function updateGhost(e: PointerEvent | null): void {
    const asset = placingAsset()
    if (!asset) {
      hideGhost()
      return
    }
    ensureHelpers()
    if (e) setRay(e)
    const p = computePlacement(asset, e)
    if (!p) {
      hideGhost()
      setHint(asset.mount === 'wall' ? t('Наведите на стену, чтобы разместить объект') : t('Наведите на пол, чтобы разместить объект'))
      return
    }
    placement = p
    const w = asset.size.w / 1000
    const d = asset.size.d / 1000
    const h = asset.size.h / 1000
    ghost.position.set(p.x / 1000, p.elevation / 1000, p.y / 1000)
    ghost.rotation.set(0, -p.rotation * DEG, 0)
    ghostBox.scale.set(w, h, d)
    ghostBox.position.set(0, h / 2, 0)
    ghostEdges.scale.copy(ghostBox.scale)
    ghostEdges.position.copy(ghostBox.position)
    const arrow = Math.min(0.18, Math.max(0.06, w * 0.25))
    ghostArrow.scale.set(arrow, arrow, arrow)
    // points along local +Z = the front of the object
    ghostArrow.rotation.set(Math.PI / 2, 0, 0)
    ghostArrow.position.set(0, 0.01, d / 2 + arrow * 0.6)
    ghost.visible = true
    ghost.updateMatrixWorld(true)
    setHint(t('Щелчок — поставить объект, R — повернуть, Shift+щелчок — поставить ещё, Esc — отмена'))
    ctx.invalidate()
  }

  function placeItem(keepPlacing: boolean): void {
    const asset = placingAsset()
    const p = placement
    if (!asset || !p) return
    const lid = levelId()
    let created: Id | null = null
    docStore.getState().transact(t('Добавить объект'), (d) => {
      created = addItem(d, lid, asset, p.x, p.y, { rotation: p.rotation, elevation: p.elevation, mount: asset.mount })
    })
    const ui = uiStore.getState()
    if (created) ui.select([{ kind: 'item', id: created }])
    if (!keepPlacing) {
      ui.setTool('select')
      hideGhost()
      setHint('')
    }
  }

  // ───────────────────────────── paint / eyedropper ─────────────────────────────

  function wallSideAt(wallId: Id, point: THREE.Vector3): 'left' | 'right' {
    const g = planOf()?.wallGeoms[wallId]
    if (!g || !(g.length > 1)) return 'left'
    const lx = (g.b.y - g.a.y) / g.length
    const ly = -(g.b.x - g.a.x) / g.length
    const s = (point.x * 1000 - g.a.x) * lx + (point.z * 1000 - g.a.y) * ly
    return s >= 0 ? 'left' : 'right'
  }

  /** Resolves a hit to a room id for floors / ceilings even when the mesh carries no ref. */
  function roomOfHit(hit: Hit): Id | null {
    if (hit.ref?.kind === 'room') return hit.ref.id
    return roomAt(hit.point.x * 1000, hit.point.z * 1000)
  }

  function applyPaint(hit: Hit, finish: SurfaceFinish): void {
    const state = docStore.getState()
    const doc = state.doc
    const label = t('Отделка')
    const ref = hit.ref
    if (ref?.kind === 'item') {
      const item = doc.items[ref.id]
      if (!item) return
      const asset = uiStore.getState().getAsset(item.assetId)
      const slot = hit.slot ?? (asset?.slots ? Object.keys(asset.slots)[0] : undefined)
      if (!slot) {
        state.transact(label, (d) => {
          const it = d.items[ref.id]
          if (it) it.tint = finish.tint ?? uiStore.getState().getMaterial(finish.materialId)?.color ?? it.tint
        })
        return
      }
      state.transact(label, (d) => {
        const it = d.items[ref.id]
        if (it) it.overrides = { ...(it.overrides ?? {}), [slot]: finish.materialId }
      })
      return
    }
    if (ref?.kind === 'opening') {
      const slot = hit.slot ?? 'leaf'
      state.transact(label, (d) => {
        const o = d.openings[ref.id]
        if (!o) return
        if (slot === 'frame') o.frameMaterialId = finish.materialId
        else if (slot === 'curtain' || slot === 'fabric') {
          if (o.curtain) o.curtain.materialId = finish.materialId
        } else if (slot === 'sheer') {
          if (o.curtain) o.curtain.sheerMaterialId = finish.materialId
        } else if (slot !== 'glass') o.leafMaterialId = finish.materialId
      })
      return
    }
    if (ref?.kind === 'wall' && hit.surface !== 'floor' && hit.surface !== 'ceiling') {
      if (!doc.walls[ref.id]) return
      const side = hit.side ?? wallSideAt(ref.id, hit.point)
      state.transact(label, (d) => {
        applyFinishToWallSide(d, ref.id, side, finish.materialId, hit.zone)
      })
      return
    }
    if (hit.surface === 'floor' || hit.surface === 'ceiling' || hit.surface === 'skirting' || ref?.kind === 'room') {
      const roomId = roomOfHit(hit)
      if (!roomId || !doc.rooms[roomId]) {
        setHint(t('Комната не найдена: замкните контур стен'))
        return
      }
      // without an explicit surface decide by height: the upper half of the room is the ceiling
      const surface = hit.surface ?? (hit.point.y * 1000 > levelHeight(doc) / 2 ? 'ceiling' : 'floor')
      state.transact(label, (d) => {
        const room = d.rooms[roomId]
        if (!room) return
        if (surface === 'ceiling') room.ceiling = { ...room.ceiling, materialId: finish.materialId, pattern: finish.pattern, tint: finish.tint }
        else if (surface === 'skirting') room.skirtingMaterialId = finish.materialId
        else room.floor = { materialId: finish.materialId, pattern: finish.pattern, tint: finish.tint }
      })
      return
    }
    setHint(t('Эту поверхность нельзя окрасить'))
  }

  function finishOfHit(hit: Hit): SurfaceFinish | null {
    const doc = docStore.getState().doc
    const ref = hit.ref
    if (ref?.kind === 'item') {
      const item = doc.items[ref.id]
      if (!item) return null
      const asset = uiStore.getState().getAsset(item.assetId)
      const slot = hit.slot ?? (asset?.slots ? Object.keys(asset.slots)[0] : undefined)
      const id = (slot && item.overrides?.[slot]) || (slot && asset?.slots?.[slot]) || undefined
      return id ? { materialId: id } : null
    }
    if (ref?.kind === 'opening') {
      const o = doc.openings[ref.id]
      if (!o) return null
      const id = hit.slot === 'frame' ? o.frameMaterialId : hit.slot === 'curtain' || hit.slot === 'fabric' ? o.curtain?.materialId : o.leafMaterialId
      return id ? { materialId: id } : null
    }
    if (ref?.kind === 'wall' && hit.surface !== 'floor' && hit.surface !== 'ceiling') {
      const wall = doc.walls[ref.id]
      if (!wall) return null
      const side = hit.side ?? wallSideAt(ref.id, hit.point)
      const face = wall[side]
      const h = hit.point.y * 1000
      const zone = face.zones?.find((z) => h >= z.from && h <= z.to)
      return { materialId: zone?.materialId ?? face.materialId }
    }
    const roomId = roomOfHit(hit)
    const room = roomId ? doc.rooms[roomId] : undefined
    if (!room) return null
    const surface = hit.surface ?? (hit.point.y * 1000 > levelHeight(doc) / 2 ? 'ceiling' : 'floor')
    if (surface === 'ceiling') return { materialId: room.ceiling.materialId, pattern: room.ceiling.pattern, tint: room.ceiling.tint }
    if (surface === 'skirting') return room.skirtingMaterialId ? { materialId: room.skirtingMaterialId } : null
    return { materialId: room.floor.materialId, pattern: room.floor.pattern, tint: room.floor.tint }
  }

  // ───────────────────────────── dragging ─────────────────────────────

  function movableRefs(primary: EntityRef): EntityRef[] {
    const ui = uiStore.getState()
    const doc = docStore.getState().doc
    const selected = ui.selection.some((s) => sameRef(s, primary))
    const base = selected ? ui.selection : [primary]
    const refs: EntityRef[] = []
    for (const ref of base) {
      if (ref.kind === 'item') {
        const it = doc.items[ref.id]
        if (it && !it.locked) refs.push(ref)
      } else if (ref.kind === 'light') {
        if (doc.lights[ref.id]) refs.push(ref)
      }
    }
    // the grabbed entity always comes first
    refs.sort((a, b) => (sameRef(a, primary) ? -1 : sameRef(b, primary) ? 1 : 0))
    return refs
  }

  function poseOf(doc: Doc, ref: EntityRef): StartPose | null {
    if (ref.kind === 'item') {
      const it = doc.items[ref.id]
      return it ? { x: it.x, y: it.y, rotation: it.rotation, elevation: it.elevation } : null
    }
    if (ref.kind === 'light') {
      const l = doc.lights[ref.id]
      return l ? { x: l.x, y: l.y, rotation: l.rotation ?? 0, elevation: l.elevation } : null
    }
    return null
  }

  function beginMove(hit: Hit, viaGizmo: boolean): boolean {
    const primary = hit.ref
    if (!primary) return false
    const doc = docStore.getState().doc
    const refs = movableRefs(primary)
    if (refs.length === 0 || !sameRef(refs[0], primary)) return false
    const ui = uiStore.getState()
    if (!ui.selection.some((s) => sameRef(s, primary))) ui.select([primary], down?.shift || down?.ctrl)
    const start = new Map<Id, StartPose>()
    for (const ref of refs) {
      const pose = poseOf(doc, ref)
      if (pose) start.set(ref.id, pose)
    }
    const p0 = start.get(primary.id)
    if (!p0) return false
    const item = primary.kind === 'item' ? doc.items[primary.id] : undefined
    let planeY = hit.point.y
    if (viaGizmo) planeY = gizmo.position.y
    if (item?.mount === 'ceiling') planeY = (item.elevation + item.size.h) / 1000
    const grab = viaGizmo || item?.mount === 'ceiling' ? rayPlane(planeY, v3) : hit.point
    const gx = grab ? grab.x * 1000 : p0.x
    const gy = grab ? grab.z * 1000 : p0.y
    // surface items (vase, TV, worktop) are put on whatever is under them
    let tops: number[] = []
    let rest = p0.elevation
    if (item?.mount === 'surface' && refs.length === 1) {
      const others = supportsOf(doc, new Set([item.id]))
      tops = topsOf(others)
      const under = findSupport(item, others, { maxTop: item.elevation + 5 })
      if (under && Math.abs(under.top - item.elevation) <= 5) {
        const asset = uiStore.getState().getAsset(item.assetId)
        rest = asset?.elevation ?? 0
      }
    }
    drag = {
      kind: 'move',
      primary,
      refs,
      start,
      planeY,
      offX: p0.x - gx,
      offY: p0.y - gy,
      offH: hit.point.y * 1000 - p0.elevation,
      tops,
      rest,
      applied: false,
    }
    lockControls(true)
    setCursor('grabbing')
    setHover(null)
    return true
  }

  // ───────────────────────────── stacking / resizing ─────────────────────────────

  /** items of the active level that could carry another item (without `exclude`) */
  function supportsOf(doc: Doc, exclude: ReadonlySet<Id>): Item[] {
    const lid = levelId()
    const out: Item[] = []
    for (const id in doc.items) {
      const o = doc.items[id]
      if (o.levelId === lid && !exclude.has(id) && canSupport(o)) out.push(o)
    }
    return out
  }

  /** distinct support tops, highest first */
  function topsOf(list: readonly Item[]): number[] {
    const tops: number[] = []
    for (const o of list) {
      const top = o.elevation + o.size.h
      if (!tops.some((x) => Math.abs(x - top) <= 5)) tops.push(top)
    }
    return tops.sort((a, b) => b - a)
  }

  /**
   * Where a surface item under the pointer lands: on the highest support whose top plane, hit by the
   * ray, puts at least half of the footprint on it (TV on a stand, vase on a table), else null.
   */
  function landOnSupport(size: Item['size'], rotation: number, offX: number, offY: number, others: readonly Item[], tops: readonly number[]): { x: number; y: number; elevation: number } | null {
    for (const top of tops) {
      const p = rayPlane(top / 1000, v3)
      if (!p) continue
      const x = p.x * 1000 + offX
      const y = p.z * 1000 + offY
      if (supportCoverage({ x, y, rotation, size }, others, top) >= 0.5) return { x, y, elevation: top }
    }
    return null
  }

  /** parameter along the world line (origin + t·dir, metres) closest to the pointer ray, or null */
  function rayLineParam(origin: THREE.Vector3, dir: THREE.Vector3): number | null {
    const o = raycaster.ray.origin
    const dr = raycaster.ray.direction
    v1.copy(origin).sub(o)
    const b = dir.dot(dr)
    const denom = 1 - b * b
    if (denom < 2e-3) return null // looking along the line
    const d = dir.dot(v1)
    const e = dr.dot(v1)
    if ((e - b * d) / denom < 0) return null // behind the camera
    return (b * e - d) / denom
  }

  function poseOfItem(it: Item): ItemPose {
    return { x: it.x, y: it.y, rotation: it.rotation, elevation: it.elevation, size: { ...it.size } }
  }

  /** mm per screen pixel at a world point */
  function mmPerPx(p: THREE.Vector3): number {
    return worldPerPixel(camera, p, Math.max(1, canvas.clientHeight)) * 1000
  }

  /** length rounding step that stays visible on screen (as the 2D grid: grid/10, grid/2, grid…) */
  function lengthStep(doc: Doc, mmPx: number): number {
    if (!doc.settings.snapGrid) return 0
    const g = doc.settings.gridMm > 0 ? doc.settings.gridMm : 100
    for (const s of [g / 10, g / 2, g, g * 5]) if (s / mmPx >= 6) return s
    return g * 5
  }

  function wallFaceSegs(doc: Doc): PlanSeg[] {
    const plan = planOf()
    return plan ? wallFaceSegments(doc.walls, plan.wallGeoms, levelId()) : []
  }

  /** other items of the level near the given pose (plan distance between bounding circles) */
  function neighbours(doc: Doc, p: ItemPose, selfId: Id, reach: number): Item[] {
    const lid = levelId()
    const r = Math.hypot(p.size.w, p.size.d) / 2 + reach
    const out: Item[] = []
    for (const id in doc.items) {
      const o = doc.items[id]
      if (id === selfId || o.levelId !== lid || o.hidden) continue
      if (Math.hypot(o.x - p.x, o.y - p.y) > r + Math.hypot(o.size.w, o.size.d) / 2) continue
      out.push(o)
    }
    return out
  }

  /** snap targets for the dragged face: wall faces, neighbours' edges / tops, the ceiling */
  function resizeTargets(doc: Doc, d: Extract<DragState, { kind: 'resize' }>): SnapTarget[] {
    const near = neighbours(doc, d.start, d.id, 3000)
    if (d.axis !== 'h') return planResizeTargets(d.start, d.axis, d.side, { walls: wallFaceSegs(doc), items: near, selfId: d.id })
    const el = d.start.elevation
    const out: SnapTarget[] = []
    for (const o of near) {
      for (const z of [o.elevation, o.elevation + o.size.h]) if (z - el > 5) out.push({ value: z - el, kind: 'item' })
    }
    const ceil = ceilingHeightAt(doc, d.start.x, d.start.y) - el
    if (ceil > 5) out.push({ value: ceil, kind: 'ceiling' })
    return out
  }

  function beginResize(spec: HandleSpec): boolean {
    const it = handleItem()
    if (!it) return false
    const t0 = rayLineParam(spec.pos, spec.dir)
    if (t0 === null) return false
    if (spec.axis === 'elev') {
      drag = { kind: 'elevate', id: it.id, start: poseOfItem(it), startMount: it.mount, origin: spec.pos.clone(), dir: spec.dir.clone(), t0, typed: '', applied: false }
    } else {
      const asset = uiStore.getState().getAsset(it.assetId)
      drag = {
        kind: 'resize',
        id: it.id,
        handle: spec.id,
        axis: spec.axis,
        side: spec.side,
        start: poseOfItem(it),
        startParams: it.params ? { ...it.params } : undefined,
        asset,
        origin: spec.pos.clone(),
        dir: spec.dir.clone(),
        t0,
        typed: '',
        len: it.size[spec.axis],
        applied: false,
      }
      const prefs = resizePrefs.getState()
      if (asset?.kind === 'model' && !prefs.lockRatio && !prefs.stretchHintShown) {
        prefs.markStretchHint()
        toast(t('Модель растягивается: пропорции искажаются'), 'info', 9000, { label: t('Сохранять пропорции'), run: () => resizePrefs.getState().setLockRatio(true) })
      }
    }
    resizeHandles.setActive(spec.id)
    lockControls(true)
    setCursor(spec.axis === 'elev' || spec.axis === 'h' ? 'ns-resize' : 'ew-resize')
    setHover(null)
    return true
  }

  function typedLength(text: string): number | null {
    if (/^\s*0+([.,]0*)?\s*$/.test(text)) return 0
    return parseLengthInput(text, docStore.getState().doc.settings.units)?.length ?? null
  }

  const AXIS_RU = { w: 'Ширина', d: 'Глубина', h: 'Высота' } as const

  function updateResize(e: { shiftKey: boolean; altKey: boolean } | null, d: Extract<DragState, { kind: 'resize' }>): void {
    const store = docStore.getState()
    const doc = store.doc
    const units = doc.settings.units
    let len: number
    if (d.typed) {
      const v = typedLength(d.typed)
      if (v === null || v <= 0) {
        setHint(`${t(AXIS_RU[d.axis])}: ${d.typed}▏ · ${t('Enter — применить, Esc — отмена')}`)
        return
      }
      len = v
    } else {
      const tt = rayLineParam(d.origin, d.dir)
      if (tt === null) return
      const raw = d.start.size[d.axis] + (tt - d.t0) * 1000
      const snap = !e?.shiftKey && !e?.altKey && doc.settings.snapObjects !== false
      const mmPx = mmPerPx(d.origin)
      if (snap) {
        const tol = THREE.MathUtils.clamp(mmPx * 10, 8, 250)
        len = snapValue(raw, resizeTargets(doc, d), tol, lengthStep(doc, mmPx)).value
      } else len = Math.round(raw)
    }
    d.len = len
    const it = doc.items[d.id]
    if (!it) return
    const lock = resizePrefs.getState().lockRatio
    const p = resizeFromFace(d.start, d.axis, d.side, len, { lockRatio: lock, min: minItemSize(d.asset), fixedBack: it.mount === 'wall' })
    const size = clampItemSize({ w: Math.round(p.size.w), d: Math.round(p.size.d), h: Math.round(p.size.h) }, d.asset)
    const params = resizedParams(d.asset, d.startParams, d.start.size, size) ?? d.startParams
    d.applied = true
    store.transact(
      t('Изменить размер'),
      (draft) => {
        const x = draft.items[d.id]
        if (!x) return
        x.size = size
        x.x = p.x
        x.y = p.y
        x.elevation = p.elevation
        if (params) x.params = { ...params }
        else delete x.params
      },
      { transient: true },
    )
    const typed = d.typed ? `${d.typed}▏` : formatLen(size[d.axis], units)
    setHint(
      `${t(AXIS_RU[d.axis])}: ${typed} · ${formatLen(size.w, units)} × ${formatLen(size.d, units)} × ${formatLen(size.h, units)}${lock ? ` · ${t('пропорции сохраняются')}` : ''} · ` +
        t('цифры и Enter — точный размер · Shift — без привязки · Esc — отмена'),
    )
  }

  function updateElevate(e: { shiftKey: boolean; altKey: boolean } | null, d: Extract<DragState, { kind: 'elevate' }>): void {
    const store = docStore.getState()
    const doc = store.doc
    const units = doc.settings.units
    const it = doc.items[d.id]
    if (!it) return
    let elev: number
    let onSupport = false
    const others = supportsOf(doc, new Set([d.id]))
    if (d.typed) {
      const v = typedLength(d.typed)
      if (v === null) {
        setHint(`${t('Высота над полом')}: ${d.typed}▏ · ${t('Enter — применить, Esc — отмена')}`)
        return
      }
      elev = v
    } else {
      const tt = rayLineParam(d.origin, d.dir)
      if (tt === null) return
      const raw = d.start.elevation + (tt - d.t0) * 1000
      const snap = !e?.shiftKey && !e?.altKey && doc.settings.snapObjects !== false
      if (snap) {
        const mmPx = mmPerPx(d.origin)
        const targets: SnapTarget[] = [{ value: 0, kind: 'floor' }]
        // tops of the items under the footprint: put it on them
        for (const top of topsOf(others)) {
          if (supportCoverage(d.start, others, top) >= 0.5) targets.push({ value: top, kind: 'support' })
        }
        // align with the neighbours' bottoms and tops
        for (const o of neighbours(doc, d.start, d.id, 1500)) {
          targets.push({ value: o.elevation, kind: 'item' }, { value: o.elevation + o.size.h - d.start.size.h, kind: 'item' })
        }
        targets.push({ value: ceilingHeightAt(doc, d.start.x, d.start.y) - d.start.size.h, kind: 'ceiling' })
        const s = snapValue(raw, targets, THREE.MathUtils.clamp(mmPx * 10, 8, 250), Math.max(10, lengthStep(doc, mmPx)))
        elev = s.value
        onSupport = s.kind === 'support'
      } else elev = Math.round(raw)
    }
    const hi = Math.max(0, ceilingHeightAt(doc, it.x, it.y) - it.size.h)
    elev = THREE.MathUtils.clamp(elev, 0, Math.max(hi, d.start.elevation))
    if (!onSupport) onSupport = elev > 0.5 && supportCoverage(d.start, others, elev) >= 0.5
    const mount = mountForElevation(d.startMount, elev, onSupport)
    d.applied = true
    store.transact(
      t('Изменить высоту'),
      (draft) => {
        const x = draft.items[d.id]
        if (!x) return
        x.elevation = elev
        x.mount = mount
      },
      { transient: true },
    )
    const where = onSupport ? ` · ${t('на поверхности')}` : elev <= 0.5 ? ` · ${t('на полу')}` : ''
    setHint(
      `${t('Высота над полом')}: ${d.typed ? `${d.typed}▏` : formatLen(elev, units)}${where} · ` + t('цифры и Enter — точная высота · Shift — без привязки · Esc — отмена'),
    )
  }

  function beginRotate(): boolean {
    if (!gizmoItem) return false
    const item = docStore.getState().doc.items[gizmoItem]
    if (!item) return false
    const p = rayPlane(gizmo.position.y, v3)
    if (!p) return false
    drag = {
      kind: 'rotate',
      id: item.id,
      startRotation: item.rotation,
      startAngle: Math.atan2(p.z * 1000 - item.y, p.x * 1000 - item.x),
      cx: item.x,
      cy: item.y,
      planeY: gizmo.position.y,
      applied: false,
    }
    lockControls(true)
    setCursor('grabbing')
    setHover(null)
    return true
  }

  function updateDrag(e: PointerEvent): void {
    const d = drag
    if (!d) return
    setRay(e)
    const store = docStore.getState()
    const doc = store.doc

    if (d.kind === 'resize') {
      updateResize(e, d)
      return
    }
    if (d.kind === 'elevate') {
      updateElevate(e, d)
      return
    }

    if (d.kind === 'rotate') {
      const p = rayPlane(d.planeY, v3)
      if (!p) return
      const angle = Math.atan2(p.z * 1000 - d.cy, p.x * 1000 - d.cx)
      let rotation = d.startRotation + (angle - d.startAngle) / DEG
      if (!e.altKey) rotation = Math.round(rotation / (e.shiftKey ? 45 : ROTATE_STEP)) * (e.shiftKey ? 45 : ROTATE_STEP)
      rotation = normDeg(rotation)
      const current = doc.items[d.id]
      if (!current || Math.abs(current.rotation - rotation) < 1e-6) return
      d.applied = true
      store.transact(
        t('Поворот'),
        (draft) => {
          const it = draft.items[d.id]
          if (it) it.rotation = rotation
        },
        { transient: true },
      )
      return
    }

    const primary = d.primary
    const p0 = d.start.get(primary.id)
    if (!p0) return
    let nx = p0.x
    let ny = p0.y
    let rotation = p0.rotation
    let elevation = p0.elevation
    const item = primary.kind === 'item' ? doc.items[primary.id] : undefined
    const single = d.refs.length === 1

    if (item && item.mount === 'wall') {
      const face = rayWallFace()
      if (!face) return
      nx = face.x + face.nx * (item.size.d / 2 + 1)
      ny = face.y + face.ny * (item.size.d / 2 + 1)
      rotation = rotationFacing(face.nx, face.ny)
      elevation = THREE.MathUtils.clamp(face.height - d.offH, 0, Math.max(0, face.wall.height - item.size.h))
      if (!e.altKey) elevation = Math.round(elevation / 10) * 10
    } else if (item && item.mount === 'surface' && single) {
      // stacking: on the highest support under the pointer, else down to the rest height
      const others = supportsOf(doc, new Set([item.id]))
      const land = landOnSupport(item.size, p0.rotation, d.offX, d.offY, others, d.tops)
      if (land) {
        nx = land.x
        ny = land.y
        elevation = land.elevation
      } else {
        const p = rayPlane(d.rest / 1000, v3) ?? rayPlane(d.planeY, v3)
        if (!p) return
        nx = p.x * 1000 + d.offX
        ny = p.z * 1000 + d.offY
        elevation = d.rest
      }
      if (snappingOn(e)) {
        const s = snapFloor(doc, item.size, nx, ny, p0.rotation, new Set([item.id]), false)
        nx = s.x
        ny = s.y
      }
    } else {
      const p = rayPlane(d.planeY, v3)
      if (!p) return
      nx = p.x * 1000 + d.offX
      ny = p.z * 1000 + d.offY
      if (item && item.mount === 'ceiling') {
        elevation = Math.max(0, ceilingHeightAt(doc, nx, ny) - item.size.h)
      } else if (item && snappingOn(e)) {
        const exclude = new Set<Id>(d.refs.filter((r) => r.kind === 'item').map((r) => r.id))
        const s = snapFloor(doc, item.size, nx, ny, p0.rotation, exclude, single && item.mount === 'floor')
        nx = s.x
        ny = s.y
        rotation = s.rotation
      }
    }

    const dx = nx - p0.x
    const dy = ny - p0.y
    d.applied = true
    store.transact(
      t('Перемещение'),
      (draft) => {
        for (const ref of d.refs) {
          const s = d.start.get(ref.id)
          if (!s) continue
          if (ref.kind === 'item') {
            const it = draft.items[ref.id]
            if (!it) continue
            it.x = s.x + dx
            it.y = s.y + dy
            if (sameRef(ref, primary)) {
              it.rotation = rotation
              it.elevation = elevation
            }
          } else if (ref.kind === 'light') {
            const l = draft.lights[ref.id]
            if (!l) continue
            l.x = s.x + dx
            l.y = s.y + dy
          }
        }
      },
      { transient: true },
    )
  }

  function endDrag(commit: boolean): void {
    const d = drag
    drag = null
    pending = null
    lockControls(false)
    setCursor('')
    if (!d) return
    const store = docStore.getState()
    if (d.applied) {
      const label = d.kind === 'rotate' ? t('Повернуть объект') : d.kind === 'resize' ? t('Изменить размер') : d.kind === 'elevate' ? t('Изменить высоту') : t('Переместить объект')
      if (commit) store.commitTransient(label)
      else store.cancelTransient()
    }
    if (d.kind === 'resize' || d.kind === 'elevate') {
      resizeHandles.setActive(null)
      setHint('')
    }
    refreshGizmo()
    syncOutline()
    ctx.invalidate()
  }

  // ───────────────────────────── clicks ─────────────────────────────

  function toggleSelect(ref: EntityRef, additive: boolean): void {
    const ui = uiStore.getState()
    if (!additive) {
      if (ui.selection.length !== 1 || !sameRef(ui.selection[0], ref)) ui.select([ref])
      return
    }
    if (ui.selection.some((s) => sameRef(s, ref))) ui.select(ui.selection.filter((s) => !sameRef(s, ref)))
    else ui.select([ref], true)
  }

  function handleClick(e: PointerEvent, additive: boolean): void {
    setRay(e)
    const ui = uiStore.getState()
    const tool = ui.tool
    if (tool === 'item') {
      updateGhost(e)
      placeItem(e.shiftKey)
      return
    }
    const hit = pick()
    if (tool === 'paint') {
      if (!hit) return
      if (!ui.paintFinish) {
        setHint(t('Выберите материал в каталоге'))
        return
      }
      applyPaint(hit, ui.paintFinish)
      return
    }
    if (tool === 'eyedropper') {
      if (!hit) return
      const finish = finishOfHit(hit)
      if (finish) ui.set({ paintFinish: finish, tool: 'paint' })
      else setHint(t('Не удалось определить материал'))
      return
    }
    if (tool === 'erase') {
      const ref = hit?.ref
      if (!ref) return
      docStore.getState().transact(t('Удалить'), (d) => removeEntities(d, [ref]))
      if (ui.selection.some((s) => sameRef(s, ref))) ui.select(ui.selection.filter((s) => !sameRef(s, ref)))
      return
    }
    // select (and every 2D-only tool) — objects by single click, walls / rooms by double click
    const ref = hit?.ref
    if (ref && (ref.kind === 'item' || ref.kind === 'light' || ref.kind === 'opening')) {
      toggleSelect(ref, additive)
    } else if (!additive && ui.selection.length > 0) {
      ui.clearSelection()
    }
  }

  const onDoubleClick = (e: MouseEvent): void => {
    if (disposed || shared.stillBusy) return
    const ui = uiStore.getState()
    if (ui.tool === 'item' || ui.tool === 'paint' || ui.tool === 'eyedropper' || ui.tool === 'erase') return
    setRay(e)
    const hit = pick()
    if (!hit) return
    if (hit.ref && (hit.ref.kind === 'wall' || hit.ref.kind === 'room') && hit.surface !== 'floor' && hit.surface !== 'ceiling') {
      ui.select([hit.ref], e.shiftKey || e.ctrlKey || e.metaKey)
      return
    }
    if (hit.root === 'architecture' && (hit.surface === 'floor' || hit.surface === 'ceiling' || hit.ref?.kind === 'room' || !hit.ref)) {
      const roomId = roomOfHit(hit)
      if (roomId && docStore.getState().doc.rooms[roomId]) ui.select([{ kind: 'room', id: roomId }], e.shiftKey || e.ctrlKey || e.metaKey)
    }
  }

  // ───────────────────────────── pointer events ─────────────────────────────

  function selectLike(tool: string): boolean {
    return tool !== 'item' && tool !== 'paint' && tool !== 'eyedropper' && tool !== 'erase'
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed || shared.stillBusy) return
    try {
      canvas.focus({ preventScroll: true })
    } catch {
      /* focus is a nicety */
    }
    down = { x: e.clientX, y: e.clientY, button: e.button, pointerId: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    pending = null
    if (e.button !== 0) return
    const ui = uiStore.getState()
    if (!selectLike(ui.tool)) return
    setRay(e)
    // resize / height handles win over the ring and the item under them
    const rh = resizeHandles.hit(e.clientX, e.clientY, camera, canvas.getBoundingClientRect())
    if (rh) {
      if (beginResize(rh)) capture(e)
      return
    }
    const handle = gizmoHit()
    if (handle === 'rotate') {
      if (beginRotate()) capture(e)
      return
    }
    const hit = pick()
    if (handle === 'move' && gizmoItem) {
      // the puck moves the selected item even when something else is under the cursor
      const fake: Hit = {
        ref: { kind: 'item', id: gizmoItem },
        object: gizmo,
        mesh: gizmo,
        point: gizmo.position.clone(),
        distance: 0,
        root: 'items',
      }
      if (beginMove(fake, true)) capture(e)
      return
    }
    if (!hit?.ref) return
    const doc = docStore.getState().doc
    const draggable = (hit.ref.kind === 'item' && !!doc.items[hit.ref.id] && !doc.items[hit.ref.id].locked) || (hit.ref.kind === 'light' && !!doc.lights[hit.ref.id])
    if (!draggable) return
    // keep the camera still: this press either selects or drags the object
    pending = { hit }
    lockControls(true)
    capture(e)
  }

  function capture(e: PointerEvent): void {
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }

  function processMove(): void {
    frame = 0
    const e = lastMove
    lastMove = null
    if (!e || disposed) return
    if (drag) {
      updateDrag(e)
      return
    }
    if (pending && down) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) {
        const p = pending
        pending = null
        setRay({ clientX: down.x, clientY: down.y })
        if (!beginMove(p.hit, false)) lockControls(false)
        else updateDrag(e)
      }
      return
    }
    if (e.buttons !== 0) return // the camera is being moved
    const ui = uiStore.getState()
    setRay(e)
    if (ui.tool === 'item') {
      updateGhost(e)
      setCursor('crosshair')
      return
    }
    if (selectLike(ui.tool)) {
      const rh = resizeHandles.hit(e.clientX, e.clientY, camera, canvas.getBoundingClientRect())
      if (resizeHandles.setHover(rh?.id ?? null)) refreshHandles()
      if (rh) {
        setCursor(rh.axis === 'elev' || rh.axis === 'h' ? 'ns-resize' : 'ew-resize')
        setHover(null)
        setHint(
          rh.axis === 'elev'
            ? t('Тяните, чтобы поднять или опустить объект · цифры — точная высота')
            : t('Тяните грань, чтобы изменить размер · противоположная грань остаётся на месте'),
        )
        handleHint = true
        return
      }
      if (handleHint) {
        handleHint = false
        setHint('')
      }
      const handle = gizmoHit()
      if (handle) {
        setCursor(handle === 'rotate' ? 'alias' : 'move')
        setHover(null)
        return
      }
    }
    const hit = pick()
    if (ui.tool === 'paint' || ui.tool === 'eyedropper') {
      setCursor(hit ? 'crosshair' : '')
      setHover(hit && hit.ref ? hit : null)
      return
    }
    const ref = hit?.ref
    const doc = docStore.getState().doc
    if (ref && (ref.kind === 'item' || ref.kind === 'light' || ref.kind === 'opening')) {
      const movable = (ref.kind === 'item' && !doc.items[ref.id]?.locked) || ref.kind === 'light'
      setCursor(ui.tool === 'erase' ? 'pointer' : movable ? 'grab' : 'pointer')
      setHover(hit)
    } else {
      setCursor('')
      setHover(null)
    }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed || shared.stillBusy) return
    lastMove = e
    lastPointer = e
    if (!frame) frame = requestAnimationFrame(processMove)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (disposed) return
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    const d = down
    down = null
    if (swallowUp) {
      swallowUp = false
      pending = null
      lockControls(false)
      return
    }
    if (drag) {
      if (lastMove) {
        updateDrag(lastMove)
        lastMove = null
      }
      endDrag(e.type !== 'pointercancel')
      return
    }
    const wasPending = pending
    pending = null
    lockControls(false)
    if (!d || e.type === 'pointercancel' || shared.stillBusy) return
    if (d.button !== 0 || e.button !== 0) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return
    if (wasPending?.hit.ref && selectLike(uiStore.getState().tool)) {
      toggleSelect(wasPending.hit.ref, d.shift || d.ctrl)
      return
    }
    handleClick(e, d.shift || d.ctrl)
  }

  const onPointerEnter = (): void => {
    pointerInside = true
  }
  const onPointerLeave = (): void => {
    pointerInside = false
    lastPointer = null
    if (!drag) {
      setHover(null)
      hideGhost()
    }
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  function keyboardActive(e: KeyboardEvent): boolean {
    if (disposed || shared.stillBusy || e.defaultPrevented) return false
    if (isEditable(e.target)) return false
    if (!container.isConnected || container.offsetParent === null) return false
    return pointerInside || document.activeElement === canvas
  }

  function selectedMovables(): EntityRef[] {
    const doc = docStore.getState().doc
    return uiStore.getState().selection.filter((r) => (r.kind === 'item' && !!doc.items[r.id] && !doc.items[r.id].locked) || (r.kind === 'light' && !!doc.lights[r.id]))
  }

  function consume(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopPropagation()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!keyboardActive(e)) return
    if (e.ctrlKey || e.metaKey) return
    const ui = uiStore.getState()
    const store = docStore.getState()

    if (e.key === 'Escape') {
      if (drag) {
        endDrag(false)
        consume(e)
      } else if (ui.tool === 'item' || ui.tool === 'paint' || ui.tool === 'eyedropper' || ui.tool === 'erase') {
        ui.setTool('select')
        hideGhost()
        setHint('')
        consume(e)
      }
      return
    }
    // typed exact size / height while dragging a handle (as the wall tool: digits, Backspace, Enter)
    if (drag && (drag.kind === 'resize' || drag.kind === 'elevate')) {
      const d = drag
      const reapply = (): void => {
        if (d.kind === 'resize') updateResize(lastPointer, d)
        else updateElevate(lastPointer, d)
      }
      if (e.key === 'Enter') {
        if (d.typed) {
          reapply()
          swallowUp = !!down
          endDrag(true)
        }
        consume(e)
        return
      }
      if (e.key === 'Backspace') {
        if (d.typed) {
          d.typed = d.typed.slice(0, -1)
          reapply()
        }
        consume(e)
        return
      }
      if (e.key.length === 1 && isLengthChar(e.key) && (d.typed || /[0-9.,]/.test(e.key))) {
        if (d.typed.length < 16) d.typed += e.key
        reapply()
        consume(e)
        return
      }
      return
    }
    if (drag) return

    if (e.code === 'KeyR') {
      const stepDeg = e.shiftKey ? -45 : 45
      if (ui.tool === 'item') {
        placementRotation = normDeg(placementRotation + stepDeg)
        if (lastPointer && pointerInside) updateGhost(lastPointer)
        else if (placement) {
          placement.rotation = normDeg(placement.rotation + stepDeg)
          ghost.rotation.y = -placement.rotation * DEG
          ctx.invalidate()
        }
        consume(e)
        return
      }
      const items = ui.selection.filter((r) => r.kind === 'item' && !!store.doc.items[r.id] && !store.doc.items[r.id].locked)
      if (items.length === 0) return
      store.transact(
        t('Повернуть объект'),
        (d) => {
          for (const ref of items) {
            const it = d.items[ref.id]
            if (it) it.rotation = normDeg(it.rotation + stepDeg)
          }
        },
        { merge: `rotate3d:${items.map((r) => r.id).join(',')}` },
      )
      consume(e)
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (ui.selection.length === 0) return
      const refs = ui.selection.slice()
      store.transact(t('Удалить'), (d) => removeEntities(d, refs))
      ui.clearSelection()
      consume(e)
      return
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ui.cameraMode === 'walk' || controls.mode === 'walk') return
      const refs = selectedMovables()
      if (refs.length === 0) return
      const stepMm = e.shiftKey ? 100 : e.altKey ? 1 : 10
      // "up" moves away from the camera along the nearest plan axis
      camera.getWorldDirection(v1)
      let fx = 0
      let fy = -1
      if (Math.hypot(v1.x, v1.z) > 0.05) {
        if (Math.abs(v1.x) > Math.abs(v1.z)) {
          fx = Math.sign(v1.x)
          fy = 0
        } else {
          fx = 0
          fy = Math.sign(v1.z)
        }
      }
      // clockwise quarter turn on the y-down plan
      const rx = -fy
      const ry = fx
      const sf = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
      const sr = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const dx = (fx * sf + rx * sr) * stepMm
      const dy = (fy * sf + ry * sr) * stepMm
      store.transact(
        t('Сдвиг'),
        (d) => {
          for (const ref of refs) {
            const target = ref.kind === 'item' ? d.items[ref.id] : d.lights[ref.id]
            if (!target) continue
            target.x += dx
            target.y += dy
          }
        },
        { merge: `nudge3d:${refs.map((r) => r.id).join(',')}` },
      )
      consume(e)
    }
  }

  // ───────────────────────────── subscriptions ─────────────────────────────

  let lastUi = uiStore.getState()
  const unsubUi = uiStore.subscribe((state) => {
    const prev = lastUi
    lastUi = state
    if (state.selection !== prev.selection || state.hover !== prev.hover) syncOutline()
    if (state.selection !== prev.selection || state.tool !== prev.tool || state.activeLevelId !== prev.activeLevelId) refreshGizmo()
    if (state.tool !== prev.tool || state.placingAssetId !== prev.placingAssetId) {
      placementRotation = 0
      if (state.tool !== 'item') hideGhost()
      if (prev.tool === 'item' || prev.tool === 'paint' || prev.tool === 'eyedropper') setCursor('')
      if (state.tool === 'paint') setHint(t('Щёлкните по поверхности, чтобы применить материал'))
      else if (state.tool === 'eyedropper') setHint(t('Щёлкните по поверхности, чтобы взять её материал'))
    }
  })
  let lastDoc = docStore.getState().doc
  const unsubDoc = docStore.subscribe((state) => {
    if (state.doc === lastDoc) return
    const itemsChanged = state.doc.items !== lastDoc.items
    lastDoc = state.doc
    if (itemsChanged) refreshGizmo()
  })
  const onSceneChanged = (): void => {
    index = null
    hoverHit = null
    ensureHelpers()
    syncOutline()
    refreshGizmo()
  }
  const unsubScene = ctx.onSceneChanged(onSceneChanged)
  const unsubLighting = shared.onLightingChanged((c) => {
    if (!c.structure) return
    index = null
    syncOutline()
  })
  // keep the screen-space size of the handles while the camera moves
  let lastCamDist = 0
  const unsubFrame = ctx.onBeforeRender(() => {
    if (resizeHandles.visible) {
      const it = handleItem()
      if (it) resizeHandles.sync(it, camera, Math.max(1, canvas.clientHeight), topView())
    }
    if (!gizmo.visible) return
    const dist = camera.position.distanceTo(gizmo.position)
    if (Math.abs(dist - lastCamDist) < 0.01) return
    lastCamDist = dist
    knob.scale.setScalar(THREE.MathUtils.clamp(dist * 0.012, 0.035, 0.2))
    puck.scale.setScalar(THREE.MathUtils.clamp(dist * 0.02, 0.06, 0.3))
  })

  canvas.addEventListener('pointerdown', onPointerDown, true)
  canvas.addEventListener('pointermove', onPointerMove, true)
  canvas.addEventListener('pointerup', onPointerUp, true)
  canvas.addEventListener('pointercancel', onPointerUp, true)
  canvas.addEventListener('dblclick', onDoubleClick)
  container.addEventListener('pointerenter', onPointerEnter)
  container.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('keydown', onKeyDown, true)

  ensureHelpers()
  syncOutline()
  refreshGizmo()

  return {
    dispose() {
      if (disposed) return
      if (drag) endDrag(false)
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      lockControls(false)
      unsubUi()
      unsubDoc()
      unsubScene()
      unsubLighting()
      unsubFrame()
      canvas.removeEventListener('pointerdown', onPointerDown, true)
      canvas.removeEventListener('pointermove', onPointerMove, true)
      canvas.removeEventListener('pointerup', onPointerUp, true)
      canvas.removeEventListener('pointercancel', onPointerUp, true)
      canvas.removeEventListener('dblclick', onDoubleClick)
      container.removeEventListener('pointerenter', onPointerEnter)
      container.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keydown', onKeyDown, true)
      setCursor('')
      post.setOutline([], null)
      gizmo.removeFromParent()
      ghost.removeFromParent()
      resizeHandles.dispose()
      if (ringMesh) ringMesh.geometry.dispose()
      gizmoMaterial.dispose()
      gizmoSoftMaterial.dispose()
      ghostMaterial.dispose()
      ghostLineMaterial.dispose()
      unitBox.dispose()
      unitEdges.dispose()
      knobGeometry.dispose()
      puckGeometry.dispose()
      arrowGeometry.dispose()
    },
  }
}
