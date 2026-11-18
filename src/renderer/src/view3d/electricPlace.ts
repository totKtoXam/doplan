/**
 * Electric points in the 3D view (orbit and walk): the «Электроточка» tool and moving points.
 *
 *  - tool `electric` (kind / posts / height from the «Электрика» panel): a ghost of the point follows
 *    the cursor on the wall face it points at (ceiling / floor kinds: on the ceiling / the floor), at
 *    the type's height (or the panel's); a click puts it there. Never inside a door or window opening
 *    (red ghost). Shift+click: at the height of the cursor. Alt: no snaps;
 *  - dragging a point (select tool): along its wall and in height, onto another wall the cursor moves
 *    to; floor / ceiling points slide on their plane. One drag = one history entry;
 *  - snaps (core/electricPlace): standard heights, the neighbours on the same face, clearances from
 *    the corners and the opening edges; live dimensions to the floor, the corner / opening, the neighbour;
 *  - keys: PgUp / PgDn height ±50 mm (Shift ±10), Home — the type's height, [ / ] previous / next type,
 *    + / − posts in the frame. For the tool (its next point) or for the selected point (one entry each);
 *  - walk mode with the mouse captured: everything aims with the centre crosshair, a click places,
 *    holding the button on a point and turning the view moves it. With the cursor free: at the cursor.
 *
 * Kept out of interaction.ts: it only forwards pointer events here first (see createElectricPlace).
 */
import * as THREE from 'three'
import {
  ELECTRIC_KINDS,
  MAX_GANGS,
  addElectric,
  cycleElectricKind,
  electricHalfWidth,
  electricType,
  electricWallDims,
  levelCeiling,
  nearestWallFace,
  placeElectricOnWall,
  rayElectricSurface,
  snapElectricOnWall,
  wallFacePoint,
  type ElectricDim,
  type ElectricSnap,
  type ElectricSurface,
  type PlanRay,
} from '@core'
import { electricHalfHeight } from '@core'
import type { Doc, ElectricKind, ElectricPoint, Id } from '@core/types'
import type { EngineContext } from '@/contracts'
import type { ElectricToolState } from '@/editor2d/tools/electric'
import { formatLen } from '@/editor2d/format'
import { docStore } from '@/store/document'
import { toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { walkPrefs } from '@/store/walkPrefs'
import { addTranslations, t } from '@/i18n'
import { buildElectricPoint } from './build/electrical'
import { worldPerPixel } from './resizeHandles'
import { walkPointerLocked } from './walkInput'

addTranslations('en', {
  Электроточка: 'Electric point',
  'Переместить электроточку': 'Move electric point',
  'Высота электроточки': 'Electric point height',
  'Тип электроточки': 'Electric point type',
  'Постов в рамке': 'Posts in the frame',
  'В проёме точку не поставить': 'Not inside a door or window opening',
  'Наведите на стену': 'Point at a wall',
  'Наведите на потолок': 'Point at the ceiling',
  'Наведите на пол': 'Point at the floor',
  'Щелчок — поставить · PgUp/PgDn — высота · [ ] — тип · +/− — посты · Shift+щелчок — на высоте курсора · Alt — без привязок · Esc — выход':
    'Click to place · PgUp/PgDn height · [ ] type · +/− posts · Shift+click at the cursor height · Alt no snaps · Esc to exit',
  'Щелчок — поставить · [ ] — тип · Alt — без привязки к сетке 10 мм · Esc — выход': 'Click to place · [ ] type · Alt off the 10 mm grid · Esc to exit',
  'Тяните по стене и по высоте · Alt — без привязок · Esc — отмена': 'Drag along the wall and in height · Alt no snaps · Esc to cancel',
  'по высоте соседней точки': 'at the height of the neighbour',
  'под соседней точкой': 'in line with the neighbour',
  'отступ от угла': 'clearance from the corner',
  'отступ от проёма': 'clearance from the opening',
  'стандартная высота': 'standard height',
  'высота по типу': 'the type height',
})

const DEG = Math.PI / 180
const CLICK_SLOP = 4 // px
const SNAP_PX = 10 // snap distance at the cursor, screen px
const HEIGHT_STEP = 50 // mm, PgUp / PgDn (Shift: 10)
const FACE_OFF = 4 // mm off the wall face for the dimension lines

export interface ElectricPlaceHost {
  ctx: EngineContext
  raycaster: THREE.Raycaster
  /** sets the raycaster from a screen point (clientX / clientY) */
  setRay(e: { clientX: number; clientY: number }): void
  levelId(): Id
  setHint(text: string): void
  setCursor(value: string): void
  lockControls(lock: boolean): void
  /** walls cut away / hidden in the scene are looked through */
  wallShown(id: Id): boolean
  /** the electric point under the ray (the ray must be set), if it can be edited */
  pickElectric(): { id: Id; point: THREE.Vector3 } | null
  walkMode(): boolean
}

export interface ElectricPlace {
  /** a press on the canvas; true: taken here (interaction does nothing else with it) */
  pointerDown(e: PointerEvent): boolean
  pointerMove(e: PointerEvent): boolean
  pointerUp(e: PointerEvent): boolean
  pointerLeave(): void
  /** a drag / placement is going on (interaction leaves the hover alone) */
  busy(): boolean
  dispose(): void
}

interface Target {
  surface: ElectricSurface
  x: number
  y: number
  /** centre height, mm */
  h: number
  rotation: number
  wallId?: Id
  side?: 'left' | 'right'
  t?: number
  snap?: ElectricSnap
  blocked: boolean
}

interface Drag {
  id: Id
  base: ElectricPoint
  /** grab offsets: along the wall and in height (wall points), in plan (floor / ceiling) */
  offT: number
  offH: number
  offX: number
  offY: number
  wallId?: Id
  /** the press has not moved far enough yet */
  armed: boolean
  pointerId: number
  x0: number
  y0: number
  /** captured mouse: accumulated movement of the press */
  moved: number
  applied: boolean
  last: Target | null
}

export function createElectricPlace(host: ElectricPlaceHost): ElectricPlace {
  const { ctx, raycaster } = host
  const { canvas, container, camera } = ctx

  // ── ghost ──
  let accent = new THREE.Color('#3d8bfd')
  try {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (css) accent = new THREE.Color(css)
  } catch {
    /* default */
  }
  const okMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false })
  const badMat = new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false })
  const okLine = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
  const badLine = new THREE.LineBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
  const ghost = new THREE.Group()
  ghost.name = 'doplan-electric-ghost'
  ghost.visible = false
  ghost.userData.noPick = true
  let ghostKey = ''
  let ghostBad = false
  let ghostPose = ''
  const frameGeo = new THREE.BufferGeometry()
  const frame = new THREE.LineLoop(frameGeo, okLine)
  frame.renderOrder = 1002

  function ghostPoint(kind: ElectricKind, gangs: number, tg: Target): ElectricPoint {
    const mount = tg.surface === 'wall' ? 'wall' : tg.surface
    return { id: 'ghost', levelId: host.levelId(), kind, mount, x: tg.x, y: tg.y, elevation: tg.h, rotation: tg.rotation, gangs: gangs > 1 ? gangs : undefined }
  }

  function showGhost(p: ElectricPoint, bad: boolean): void {
    if (ghost.parent !== ctx.roots.helpers) ctx.roots.helpers.add(ghost)
    const key = `${p.kind}:${p.gangs ?? 1}:${p.mount}`
    if (key !== ghostKey) {
      ghostKey = key
      ghost.clear()
      const model = buildElectricPoint({ ...p, x: 0, y: 0, elevation: 0, rotation: 0 })
      // only the shape: the pose is set below on the ghost itself
      model.position.set(0, 0, 0)
      model.rotation.set(0, 0, 0)
      model.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.material = bad ? badMat : okMat
          m.renderOrder = 1001
        }
        o.userData.noPick = true
      })
      ghost.add(model)
      const hw = electricHalfWidth(p) / 1000 + 0.012
      const hh = electricHalfHeight(p) / 1000 + 0.012
      frameGeo.setFromPoints([new THREE.Vector3(-hw, -hh, 0.003), new THREE.Vector3(hw, -hh, 0.003), new THREE.Vector3(hw, hh, 0.003), new THREE.Vector3(-hw, hh, 0.003)])
      ghost.add(frame)
      ghostBad = !bad
    }
    if (ghostBad !== bad) {
      ghostBad = bad
      ghostPose = ''
      ghost.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.material = bad ? badMat : okMat
      })
      frame.material = bad ? badLine : okLine
    }
    // the pose as buildElectricPoint sets it
    const pose = `${p.x.toFixed(1)}:${p.y.toFixed(1)}:${p.elevation.toFixed(1)}:${p.rotation.toFixed(2)}:${p.mount}`
    if (ghost.visible && pose === ghostPose) {
      if (outlineBad !== bad) {
        outlineBad = bad
        drawDims()
      }
      return
    }
    outlineBad = bad
    ghostPose = pose
    ghost.position.set(p.x / 1000, p.elevation / 1000, p.y / 1000)
    if (p.mount === 'wall') ghost.rotation.set(0, Math.PI / 2 - p.rotation * DEG, 0)
    else if (p.mount === 'ceiling') ghost.rotation.set(Math.PI / 2, 0, -p.rotation * DEG)
    else ghost.rotation.set(-Math.PI / 2, 0, -p.rotation * DEG)
    ghost.visible = true
    ghost.updateMatrixWorld(true)
    // the outline over the canvas: the 3D ghost is small and pale behind the post effects
    const hw = electricHalfWidth(p) / 1000 + 0.012
    const hh = electricHalfHeight(p) / 1000 + 0.012
    outline = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => ghost.localToWorld(new THREE.Vector3(x, y, 0.003)))
    ctx.invalidate()
  }

  function hideGhost(): void {
    if (ghost.visible) {
      ghost.visible = false
      ctx.invalidate()
    }
    if (outline) {
      outline = null
      drawDims()
    }
  }

  // ── dimension overlay (HTML/SVG over the canvas, like measure3d) ──
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3;font:600 11px/1 system-ui,sans-serif'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible')
  overlay.appendChild(svg)
  container.appendChild(overlay)
  let dims: Array<{ a: THREE.Vector3; b: THREE.Vector3; text: string }> = []
  /** the ghost's frame in world space, drawn in the overlay */
  let outline: THREE.Vector3[] | null = null
  let outlineBad = false
  let shownKey = ''
  const pv = new THREE.Vector3()

  function setDims(doc: Doc, tg: Target | null, p: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical'>, selfId?: Id): void {
    dims = []
    if (tg && tg.surface === 'wall' && tg.wallId && tg.side && tg.t !== undefined) {
      const wallId = tg.wallId
      const side = tg.side
      const units = doc.settings.units
      const world = (tt: number, h: number): THREE.Vector3 | null => {
        const f = wallFacePoint(doc, wallId, side, tt)
        if (!f) return null
        const nx = Math.cos(f.rotation * DEG)
        const ny = Math.sin(f.rotation * DEG)
        return new THREE.Vector3((f.point.x + nx * FACE_OFF) / 1000, h / 1000, (f.point.y + ny * FACE_OFF) / 1000)
      }
      for (const d of electricWallDims(doc, wallId, side, tg.t, tg.h, p, selfId) as ElectricDim[]) {
        const a = world(d.t0, d.h0)
        const b = world(d.t1, d.h1)
        if (a && b) dims.push({ a, b, text: formatLen(d.value, units) })
      }
    }
    drawDims()
  }

  function drawDims(): void {
    const w = container.clientWidth
    const h = container.clientHeight
    camera.updateMatrixWorld()
    const proj = (p: THREE.Vector3): { x: number; y: number } | null => {
      pv.copy(p).project(camera)
      if (pv.z < -1 || pv.z > 1) return null
      return { x: (pv.x * 0.5 + 0.5) * w, y: (-pv.y * 0.5 + 0.5) * h }
    }
    const parts: string[] = []
    const labels: Array<{ x: number; y: number; text: string }> = []
    if (outline && ghost.visible) {
      const pts = outline.map(proj)
      if (pts.every(Boolean)) {
        const d = pts.map((q) => `${q!.x.toFixed(1)},${q!.y.toFixed(1)}`).join(' ')
        const col = outlineBad ? '#e5484d' : `#${accent.getHexString()}`
        parts.push(
          `<polygon points="${d}" fill="${outlineBad ? 'rgba(229,72,77,.28)' : 'none'}" stroke="rgba(0,0,0,.55)" stroke-width="4" stroke-linejoin="round"/>` +
            `<polygon points="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`,
        )
        if (outlineBad) {
          const [a, , c] = pts
          const [, b, , e] = pts
          parts.push(`<g stroke="#e5484d" stroke-width="2" stroke-linecap="round"><line x1="${a!.x}" y1="${a!.y}" x2="${c!.x}" y2="${c!.y}"/><line x1="${b!.x}" y1="${b!.y}" x2="${e!.x}" y2="${e!.y}"/></g>`)
        }
      }
    }
    for (const d of dims) {
      const p = proj(d.a)
      const q = proj(d.b)
      if (!p || !q) continue
      const dx = q.x - p.x
      const dy = q.y - p.y
      const l = Math.hypot(dx, dy)
      if (l < 3) continue
      const nx = (-dy / l) * 4
      const ny = (dx / l) * 4
      parts.push(
        `<g stroke="#ffb547" stroke-width="1.5" stroke-linecap="round"><line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>` +
          `<line x1="${p.x - nx}" y1="${p.y - ny}" x2="${p.x + nx}" y2="${p.y + ny}"/><line x1="${q.x - nx}" y1="${q.y - ny}" x2="${q.x + nx}" y2="${q.y + ny}"/></g>`,
      )
      if (l > 18) labels.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, text: d.text })
    }
    const key = parts.join('') + labels.map((l) => `${l.x.toFixed(1)},${l.y.toFixed(1)},${l.text}`).join(';')
    if (key === shownKey) return
    shownKey = key
    svg.innerHTML = parts.join('')
    while (overlay.lastChild && overlay.lastChild !== svg) overlay.removeChild(overlay.lastChild)
    for (const l of labels) {
      const el = document.createElement('div')
      el.textContent = l.text
      el.style.cssText = `position:absolute;left:${l.x}px;top:${l.y}px;transform:translate(-50%,-50%);padding:2px 5px;border-radius:4px;background:rgba(20,24,31,.85);color:#ffb547;white-space:nowrap`
      overlay.appendChild(el)
    }
  }

  function clearDims(): void {
    if (!dims.length) return
    dims = []
    drawDims()
  }

  // ── state ──
  let lastPointer: { clientX: number; clientY: number } | null = null
  let press: { pointerId: number; x: number; y: number; shift: boolean; alt: boolean; moved: number } | null = null
  let drag: Drag | null = null
  let target: Target | null = null
  let mods = { shift: false, alt: false }
  let disposed = false

  const ui = () => uiStore.getState()
  const toolState = (): ElectricToolState => ui() as unknown as ElectricToolState
  const toolActive = (): boolean => ui().tool === 'electric' && ui().mode !== '2d'
  const locked = (): boolean => walkPointerLocked(canvas)

  function toolKind(): ElectricKind {
    return toolState().electricKind ?? 'socket'
  }
  function toolGangs(): number {
    const ty = electricType(toolKind())
    return ty.framed ? Math.min(MAX_GANGS, Math.max(1, toolState().electricGangs ?? 1)) : 1
  }
  function toolHeight(): number {
    const ty = electricType(toolKind())
    return toolState().electricElevation ?? ty.elevation
  }

  /** aims the raycaster: the crosshair when the mouse is captured, else the cursor */
  function aim(e?: { clientX: number; clientY: number } | null): boolean {
    if (locked()) {
      const r = canvas.getBoundingClientRect()
      host.setRay({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
      return true
    }
    const p = e ?? lastPointer
    if (!p) return false
    host.setRay(p)
    return true
  }

  function planRay(): PlanRay {
    const o = raycaster.ray.origin
    const d = raycaster.ray.direction
    return { ox: o.x * 1000, oy: o.z * 1000, oz: o.y * 1000, dx: d.x, dy: d.z, dz: d.y }
  }

  /** visible walls only: a cut-away wall is looked through */
  function visibleDoc(doc: Doc): Doc {
    const walls: Doc['walls'] = {}
    for (const id in doc.walls) if (host.wallShown(id)) walls[id] = doc.walls[id]
    return { ...doc, walls }
  }

  /** snap distance in mm at a plan point */
  function tolAt(x: number, y: number, z: number): number {
    const wpp = worldPerPixel(camera, new THREE.Vector3(x / 1000, z / 1000, y / 1000), canvas.clientHeight || 600)
    return Math.min(150, Math.max(5, wpp * 1000 * SNAP_PX))
  }

  /**
   * Where a point of this kind would go for the current ray. `heightFrom`: 'cursor' takes the
   * height of the hit, a number keeps that height. `prefer`: drag offsets on its own wall.
   */
  function computeTarget(
    p: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical'> & { mount: ElectricPoint['mount'] },
    height: number | 'cursor',
    alt: boolean,
    selfId?: Id,
    off?: { t: number; h: number; wallId?: Id; x: number; y: number },
  ): Target | null {
    const doc = docStore.getState().doc
    const lid = host.levelId()
    const vdoc = visibleDoc(doc)
    const ray = planRay()
    if (p.mount === 'wall') {
      let hit = rayElectricSurface(vdoc, lid, ray)
      if (hit && hit.surface !== 'wall') {
        // looking at the floor / ceiling next to a wall: the nearest face (as in 2D)
        const f = nearestWallFace(vdoc, lid, { x: hit.x, y: hit.y }, 400, { skipHidden: true, prefer: off?.wallId })
        hit = f ? { surface: 'wall', x: f.point.x, y: f.point.y, z: hit.z, s: hit.s, wallId: f.wallId, side: f.side, t: f.t } : null
      }
      if (!hit || !hit.wallId || !hit.side || hit.t === undefined) return null
      const sameWall = off && off.wallId === hit.wallId
      const rawT = hit.t - (sameWall ? off.t : 0)
      const rawH = height === 'cursor' ? hit.z - (off?.h ?? 0) : height
      const snap = snapElectricOnWall(doc, hit.wallId, hit.side, rawT, rawH, p, { tol: alt ? 0 : tolAt(hit.x, hit.y, hit.z), selfId })
      const f = wallFacePoint(doc, hit.wallId, hit.side, snap.t)
      if (!f) return null
      return { surface: 'wall', x: f.point.x, y: f.point.y, h: snap.h, rotation: f.rotation, wallId: hit.wallId, side: hit.side, t: snap.t, snap, blocked: !!snap.blocked }
    }
    const surface: ElectricSurface = p.mount === 'ceiling' ? 'ceiling' : 'floor'
    let hit = rayElectricSurface(vdoc, lid, ray, new Set([surface]))
    if (!hit && surface === 'ceiling') {
      // the orbit view looks down through the cut-away ceilings: aim at the ceiling plane from above
      const z = levelCeiling(doc, lid)
      const s = ray.dz < -1e-9 && ray.oz > z ? (z - ray.oz) / ray.dz : -1
      if (s > 0) hit = { surface, x: ray.ox + ray.dx * s, y: ray.oy + ray.dy * s, z, s }
    }
    if (!hit) return null
    let x = hit.x - (off?.x ?? 0)
    let y = hit.y - (off?.y ?? 0)
    if (!alt) {
      x = Math.round(x / 10) * 10
      y = Math.round(y / 10) * 10
    }
    return { surface, x, y, h: surface === 'ceiling' ? levelCeiling(doc, lid) : 0, rotation: 0, blocked: false }
  }

  function snapNote(s: ElectricSnap | undefined): string {
    if (!s) return ''
    const out: string[] = []
    const name = (k: string, axis: 'h' | 't'): string =>
      k === 'neighbour' ? (axis === 'h' ? t('по высоте соседней точки') : t('под соседней точкой')) : k === 'corner' ? t('отступ от угла') : k === 'opening' ? t('отступ от проёма') : k === 'preset' ? t('стандартная высота') : t('высота по типу')
    if (s.hSnap) out.push(name(s.hSnap.kind, 'h'))
    if (s.tSnap) out.push(name(s.tSnap.kind, 't'))
    return out.length ? ` — ${out.join(', ')}` : ''
  }

  // ── placing (tool) ──
  function updatePlacement(): void {
    if (!toolActive() || drag) return
    if (!aim()) {
      hideGhost()
      clearDims()
      return
    }
    const kind = toolKind()
    const ty = electricType(kind)
    const gangs = toolGangs()
    const shape = { kind, gangs, mount: ty.mount }
    const tg = computeTarget(shape, mods.shift ? 'cursor' : toolHeight(), mods.alt)
    target = tg
    if (!tg) {
      hideGhost()
      clearDims()
      host.setHint(ty.mount === 'wall' ? t('Наведите на стену') : ty.mount === 'ceiling' ? t('Наведите на потолок') : t('Наведите на пол'))
      return
    }
    showGhost(ghostPoint(kind, gangs, tg), tg.blocked)
    setDims(docStore.getState().doc, tg, shape)
    host.setCursor(tg.blocked ? 'not-allowed' : 'crosshair')
    host.setHint(
      tg.blocked
        ? t('В проёме точку не поставить')
        : tg.surface !== 'wall'
          ? t('Щелчок — поставить · [ ] — тип · Alt — без привязки к сетке 10 мм · Esc — выход')
          : `${t('Щелчок — поставить · PgUp/PgDn — высота · [ ] — тип · +/− — посты · Shift+щелчок — на высоте курсора · Alt — без привязок · Esc — выход')}${snapNote(tg.snap)}`,
    )
  }

  function place(): void {
    updatePlacement()
    const tg = target
    if (!tg) return
    if (tg.blocked) {
      toast(t('В проёме точку не поставить'), 'warning')
      return
    }
    const lid = host.levelId()
    const kind = toolKind()
    const gangs = toolGangs()
    let id: Id | null = null
    docStore.getState().transact(t('Электроточка'), (d) => {
      id = addElectric(d, lid, kind, tg.x, tg.y, tg.surface === 'wall' ? { wallId: tg.wallId, side: tg.side, gangs, elevation: tg.h, snap: 0 } : { gangs })
    })
    if (id && docStore.getState().doc.electrical?.[id]) ui().select([{ kind: 'electric', id }])
    updatePlacement()
  }

  // ── moving a point ──
  function beginDrag(id: Id, grab: THREE.Vector3, e: PointerEvent): void {
    const doc = docStore.getState().doc
    const p = doc.electrical?.[id]
    if (!p) return
    let offT = 0
    let offH = 0
    if (p.mount === 'wall' && p.wallId) {
      const f = wallFacePoint(doc, p.wallId, p.side ?? 'left', 0)
      const w = doc.walls[p.wallId]
      const a = w && doc.nodes[w.a]
      const b = w && doc.nodes[w.b]
      if (f && a && b) {
        const ux = (b.x - a.x) / f.len
        const uy = (b.y - a.y) / f.len
        const tp = (p.x - f.point.x) * ux + (p.y - f.point.y) * uy
        const tg = (grab.x * 1000 - f.point.x) * ux + (grab.z * 1000 - f.point.y) * uy
        offT = tg - tp
      }
      offH = grab.y * 1000 - p.elevation
    }
    drag = {
      id,
      base: { ...p },
      offT,
      offH,
      offX: grab.x * 1000 - p.x,
      offY: grab.z * 1000 - p.y,
      wallId: p.wallId,
      armed: true,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      moved: 0,
      applied: false,
      last: null,
    }
  }

  function updateDrag(): void {
    const d = drag
    if (!d || d.armed) return
    if (!aim()) return
    const store = docStore.getState()
    const cur = store.doc.electrical?.[d.id]
    if (!cur) return
    const shape = { kind: cur.kind, gangs: cur.gangs, vertical: cur.vertical, mount: cur.mount }
    const tg = computeTarget(shape, 'cursor', mods.alt, d.id, { t: d.offT, h: d.offH, wallId: d.wallId, x: d.offX, y: d.offY })
    if (!tg) return
    if (tg.blocked) {
      // stays where it last fitted; the ghost shows the forbidden spot
      showGhost(ghostPoint(cur.kind, cur.gangs ?? 1, tg), true)
      host.setHint(t('В проёме точку не поставить'))
      return
    }
    hideGhost()
    const same = d.last && d.last.wallId === tg.wallId && d.last.side === tg.side && Math.abs(d.last.x - tg.x) < 0.01 && Math.abs(d.last.y - tg.y) < 0.01 && Math.abs(d.last.h - tg.h) < 0.01
    if (same) {
      if (dims.length || outline) drawDims()
      return
    }
    d.last = tg
    if (tg.wallId !== d.wallId) {
      // onto another wall: the grab offset along the old wall means nothing there
      d.wallId = tg.wallId
      d.offT = 0
    }
    d.applied = true
    store.transact(
      t('Переместить электроточку'),
      (dr) => {
        const q = dr.electrical?.[d.id]
        if (!q) return
        if (tg.surface === 'wall' && tg.wallId && tg.side && tg.t !== undefined) {
          placeElectricOnWall(dr, d.id, tg.wallId, tg.side, tg.t)
          if (Math.abs(q.elevation - tg.h) > 1e-6) q.elevation = tg.h
        } else {
          if (Math.abs(q.x - tg.x) > 1e-6) q.x = tg.x
          if (Math.abs(q.y - tg.y) > 1e-6) q.y = tg.y
        }
      },
      { transient: true },
    )
    setDims(docStore.getState().doc, tg, shape, d.id)
    host.setHint(`${t('Тяните по стене и по высоте · Alt — без привязок · Esc — отмена')}${snapNote(tg.snap)}`)
  }

  function endDrag(commit: boolean): void {
    const d = drag
    drag = null
    hideGhost()
    clearDims()
    host.lockControls(false)
    host.setCursor('')
    host.setHint('')
    if (!d) return
    try {
      canvas.releasePointerCapture(d.pointerId)
    } catch {
      /* not captured */
    }
    if (d.applied) {
      if (commit) docStore.getState().commitTransient(t('Переместить электроточку'))
      else docStore.getState().cancelTransient()
    }
    ctx.invalidate()
  }

  // ── pointer events (forwarded by interaction first) ──
  function pointerDown(e: PointerEvent): boolean {
    if (disposed || e.button !== 0 || ui().mode === '2d') return false
    mods = { shift: e.shiftKey, alt: e.altKey }
    if (toolActive()) {
      press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, moved: 0 }
      // orbit / walk keep turning the view on a drag; only a click places
      return true
    }
    const tool = ui().tool
    if (tool !== 'select') return false
    if (!aim(e)) return false
    const hit = host.pickElectric()
    if (!hit) return false
    const ref = { kind: 'electric' as const, id: hit.id }
    const sel = ui().selection
    if (!sel.some((s) => s.kind === 'electric' && s.id === hit.id)) ui().select([ref], e.shiftKey || e.ctrlKey || e.metaKey)
    beginDrag(hit.id, hit.point, e)
    // a captured mouse keeps turning the view: the point follows the crosshair
    if (!locked()) {
      host.lockControls(true)
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* gone */
      }
    }
    return true
  }

  function pointerMove(e: PointerEvent): boolean {
    if (disposed) return false
    mods = { shift: e.shiftKey, alt: e.altKey }
    if (!locked()) lastPointer = { clientX: e.clientX, clientY: e.clientY }
    if (drag) {
      if (drag.armed) {
        const dist = locked() ? (drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY)) : Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0)
        if (dist <= CLICK_SLOP) return true
        drag.armed = false
        host.setCursor('grabbing')
      }
      if (!locked()) updateDrag()
      return true
    }
    if (press && locked()) press.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
    if (toolActive()) {
      if (!locked() && e.buttons === 0) updatePlacement()
      return true
    }
    return false
  }

  function pointerUp(e: PointerEvent): boolean {
    if (disposed) return false
    if (drag) {
      if (e.pointerId !== drag.pointerId) return true
      // a click on a point only selected it (done on the press)
      endDrag(e.type !== 'pointercancel')
      return true
    }
    const p = press
    press = null
    if (!p || e.pointerId !== p.pointerId) return toolActive()
    if (e.type === 'pointercancel' || e.button !== 0) return true
    const moved = locked() ? p.moved : Math.hypot(e.clientX - p.x, e.clientY - p.y)
    if (moved > CLICK_SLOP) return true // the view was turned
    // walk mode: the first click captures the mouse (controls), it places nothing
    if (host.walkMode() && !locked() && walkPrefs.getState().captureMouse) return true
    mods = { shift: p.shift, alt: p.alt }
    if (!locked()) lastPointer = { clientX: e.clientX, clientY: e.clientY }
    place()
    return true
  }

  function pointerLeave(): void {
    lastPointer = null
    if (!drag && !locked()) {
      hideGhost()
      clearDims()
    }
  }

  // ── keys ──
  function keysActive(e: KeyboardEvent): boolean {
    if (disposed || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false
    const el = e.target as HTMLElement | null
    if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return false
    if (ui().mode === '2d' || !container.isConnected || container.offsetParent === null) return false
    return locked() || lastPointer !== null || document.activeElement === canvas
  }

  function selectedPoint(): ElectricPoint | null {
    const sel = ui().selection
    if (sel.length !== 1 || sel[0].kind !== 'electric') return null
    return docStore.getState().doc.electrical?.[sel[0].id] ?? null
  }

  function editPoint(label: string, fn: (q: ElectricPoint, d: Doc) => void): void {
    const p = selectedPoint()
    if (!p) return
    docStore.getState().transact(t(label), (d) => {
      const q = d.electrical?.[p.id]
      if (q) fn(q, d)
    })
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (drag && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      endDrag(false)
      return
    }
    if (drag || !keysActive(e)) return
    const tool = toolActive()
    const point = !tool && ui().tool === 'select' ? selectedPoint() : null
    if (!tool && !point) return
    const code = e.code
    const step = e.shiftKey ? 10 : HEIGHT_STEP
    let handled = true
    if (code === 'PageUp' || code === 'PageDown') {
      const dir = code === 'PageUp' ? 1 : -1
      if (tool) {
        if (electricType(toolKind()).mount === 'wall') ui().set({ electricElevation: Math.max(0, Math.round((toolHeight() + dir * step) / step) * step) } as never)
      } else if (point?.mount === 'wall') {
        editPoint('Высота электроточки', (q, d) => {
          const wall = q.wallId ? d.walls[q.wallId] : undefined
          const max = (wall?.height ?? 2700) - electricHalfHeight(q)
          q.elevation = Math.min(max, Math.max(electricHalfHeight(q), Math.round((q.elevation + dir * step) / step) * step))
        })
      }
    } else if (code === 'Home') {
      if (tool) ui().set({ electricElevation: undefined } as never)
      else if (point?.mount === 'wall') editPoint('Высота электроточки', (q) => (q.elevation = electricType(q.kind).elevation || q.elevation))
    } else if (code === 'BracketLeft' || code === 'BracketRight') {
      const dir = code === 'BracketRight' ? 1 : -1
      if (tool) ui().set({ electricKind: cycleElectricKind(ELECTRIC_KINDS, toolKind(), dir) } as never)
      else if (point) {
        // a wall point keeps to the wall kinds, a ceiling point to the ceiling ones…
        const kinds = ELECTRIC_KINDS.filter((k) => electricType(k).mount === point.mount)
        const next = cycleElectricKind(kinds.length ? kinds : ELECTRIC_KINDS, point.kind, dir)
        editPoint('Тип электроточки', (q) => {
          const prev = electricType(q.kind)
          const ty = electricType(next)
          q.kind = next
          if (q.mount === 'wall' && ty.mount === 'wall' && Math.abs(q.elevation - prev.elevation) < 0.5) q.elevation = ty.elevation
          if (!ty.framed) {
            delete q.gangs
            delete q.vertical
          }
        })
      }
    } else if (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract') {
      const dir = code === 'Equal' || code === 'NumpadAdd' ? 1 : -1
      if (tool) {
        if (electricType(toolKind()).framed) ui().set({ electricGangs: Math.min(MAX_GANGS, Math.max(1, toolGangs() + dir)) } as never)
      } else if (point && electricType(point.kind).framed) {
        const n = Math.min(MAX_GANGS, Math.max(1, (point.gangs ?? 1) + dir))
        if (n !== (point.gangs ?? 1))
          editPoint('Постов в рамке', (q) => {
            if (n > 1) q.gangs = n
            else delete q.gangs
          })
      }
    } else handled = false
    if (!handled) return
    e.preventDefault()
    e.stopPropagation()
    if (tool) updatePlacement()
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if ((e.key === 'Shift' || e.key === 'Alt') && toolActive()) {
      mods = { shift: e.shiftKey, alt: e.altKey }
      updatePlacement()
    }
  }

  // every frame: the crosshair moves with the view; the overlay follows the camera
  const offFrame = ctx.onBeforeRender(() => {
    if (disposed) return
    if (locked()) {
      if (drag && !drag.armed) updateDrag()
      else if (toolActive() && !drag) updatePlacement()
    }
    if (dims.length || outline) drawDims()
  })

  const unsubUi = uiStore.subscribe((s, prev) => {
    if (s.tool !== prev.tool || s.mode !== prev.mode) {
      if (s.tool !== 'electric' || s.mode === '2d') {
        hideGhost()
        clearDims()
        if (prev.tool === 'electric') host.setHint('')
      } else updatePlacement()
    } else if (toolActive()) {
      const a = s as unknown as ElectricToolState
      const b = prev as unknown as ElectricToolState
      if (a.electricKind !== b.electricKind || a.electricGangs !== b.electricGangs || a.electricElevation !== b.electricElevation) updatePlacement()
    }
  })
  const onLockChange = (): void => {
    if (!locked() && !drag) {
      hideGhost()
      clearDims()
    }
    if (drag && !locked() && !drag.armed) endDrag(true)
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('pointerlockchange', onLockChange)

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    pointerLeave,
    busy: () => !!drag || toolActive(),
    dispose() {
      disposed = true
      if (drag) endDrag(false)
      offFrame()
      unsubUi()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('pointerlockchange', onLockChange)
      ghost.removeFromParent()
      overlay.remove()
      okMat.dispose()
      badMat.dispose()
      okLine.dispose()
      badLine.dispose()
      frameGeo.dispose()
    },
  }
}
