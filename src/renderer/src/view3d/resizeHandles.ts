/**
 * Resize / height handles of the selected item in the 3D view (area: 3d-rendering).
 *
 *  - a ball on the centre of each side face (±width, ±depth; a wall item has no back handle) and a
 *    cube on the top face: dragging one moves only that face;
 *  - a vertical double arrow above the right end raises / lowers the whole item (not for ceiling
 *    items and not in the top view, where vertical drags are invisible).
 *
 * Handles keep a constant size on screen (any camera distance, orbit / walk / top) and are hit-tested
 * in screen pixels, so they are easy to grab far away and never hide behind the item (no depth test).
 * The drag itself lives in interaction.ts; this module only draws, positions and hit-tests.
 */
import * as THREE from 'three'
import type { Item } from '@core/types'

const DEG = Math.PI / 180

export type HandleAxis = 'w' | 'd' | 'h' | 'elev'

export interface HandleSpec {
  id: string
  axis: HandleAxis
  /** +1 right / front / top, −1 left / back */
  side: 1 | -1
  /** world position of the handle (metres) */
  pos: THREE.Vector3
  /** world unit direction the handle is dragged along */
  dir: THREE.Vector3
}

/** handle radius on screen, px */
const BALL_PX = 6.5
const CUBE_PX = 5
const ARROW_PX = 30
/** gap between the item's top and the height arrow, px */
const ARROW_GAP_PX = 22
const HIT_PX = 12

/**
 * World handle positions of an item: local x = width (plan u), local z = depth to the front (plan f),
 * y up. `arrowLift` is the world offset of the height arrow above the top.
 */
export function handleSpecs(item: Item, opts: { top: boolean; arrowLift: number }): HandleSpec[] {
  const a = item.rotation * DEG
  const u = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
  const f = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a))
  const c = new THREE.Vector3(item.x / 1000, item.elevation / 1000, item.y / 1000)
  const w = item.size.w / 2000
  const d = item.size.d / 2000
  const h = item.size.h / 1000
  const mid = c.clone().setY(c.y + h / 2)
  const out: HandleSpec[] = [
    { id: 'w+', axis: 'w', side: 1, pos: mid.clone().addScaledVector(u, w), dir: u.clone() },
    { id: 'w-', axis: 'w', side: -1, pos: mid.clone().addScaledVector(u, -w), dir: u.clone().negate() },
    { id: 'd+', axis: 'd', side: 1, pos: mid.clone().addScaledVector(f, d), dir: f.clone() },
  ]
  if (item.mount !== 'wall') out.push({ id: 'd-', axis: 'd', side: -1, pos: mid.clone().addScaledVector(f, -d), dir: f.clone().negate() })
  if (!opts.top) {
    out.push({ id: 'h+', axis: 'h', side: 1, pos: c.clone().setY(c.y + h), dir: new THREE.Vector3(0, 1, 0) })
    if (item.mount !== 'ceiling') {
      const p = c.clone().addScaledVector(u, w).setY(c.y + h + opts.arrowLift)
      out.push({ id: 'elev', axis: 'elev', side: 1, pos: p, dir: new THREE.Vector3(0, 1, 0) })
    }
  }
  return out
}

/** metres per screen pixel at a world point (perspective camera) */
export function worldPerPixel(camera: THREE.Camera, p: THREE.Vector3, viewportH: number): number {
  const cam = camera as THREE.PerspectiveCamera
  if (cam.isPerspectiveCamera) {
    const depth = Math.max(0.05, p.clone().applyMatrix4(cam.matrixWorldInverse).z * -1)
    return (2 * depth * Math.tan((cam.fov * DEG) / 2)) / (cam.zoom || 1) / Math.max(1, viewportH)
  }
  const o = camera as THREE.OrthographicCamera
  return (o.top - o.bottom) / (o.zoom || 1) / Math.max(1, viewportH)
}

export class ResizeHandles {
  readonly group = new THREE.Group()
  private specs: HandleSpec[] = []
  private meshes = new Map<string, THREE.Object3D>()
  private hovered: string | null = null
  private active: string | null = null
  private readonly ballGeo = new THREE.SphereGeometry(1, 18, 12)
  private readonly cubeGeo = new THREE.BoxGeometry(2, 2, 2)
  private readonly coneGeo = new THREE.ConeGeometry(0.32, 0.38, 16)
  private readonly stemGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8)
  private readonly fill: THREE.MeshBasicMaterial
  private readonly rim: THREE.MeshBasicMaterial
  private readonly hot: THREE.MeshBasicMaterial

  constructor(accent: THREE.Color) {
    const base = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false } as const
    this.fill = new THREE.MeshBasicMaterial({ ...base, color: 0xffffff, opacity: 0.96 })
    this.rim = new THREE.MeshBasicMaterial({ ...base, color: accent, opacity: 1 })
    this.hot = new THREE.MeshBasicMaterial({ ...base, color: 0xffd23f, opacity: 1 })
    this.group.name = 'doplan-resize-handles'
    this.group.visible = false
    this.group.userData.noPick = true
    for (const id of ['w+', 'w-', 'd+', 'd-']) this.meshes.set(id, this.makeBall())
    this.meshes.set('h+', this.makeCube())
    this.meshes.set('elev', this.makeArrow())
    for (const m of this.meshes.values()) this.group.add(m)
  }

  private layered(geo: THREE.BufferGeometry, rimScale: number): THREE.Group {
    const g = new THREE.Group()
    const rim = new THREE.Mesh(geo, this.rim)
    rim.scale.setScalar(rimScale)
    rim.renderOrder = 1002
    const core = new THREE.Mesh(geo, this.fill)
    core.renderOrder = 1003
    core.name = 'core'
    g.add(rim, core)
    return g
  }

  private makeBall(): THREE.Object3D {
    return this.layered(this.ballGeo, 1.4)
  }

  private makeCube(): THREE.Object3D {
    return this.layered(this.cubeGeo, 1.45)
  }

  private makeArrow(): THREE.Object3D {
    const g = new THREE.Group()
    const parts: Array<[THREE.BufferGeometry, number, number]> = [
      [this.stemGeo, 0, 0],
      [this.coneGeo, 0.42, 0],
      [this.coneGeo, -0.42, Math.PI],
    ]
    for (const [geo, y, rx] of parts) {
      const rim = new THREE.Mesh(geo, this.rim)
      rim.position.y = y
      rim.rotation.x = rx
      rim.scale.setScalar(1.35)
      rim.renderOrder = 1002
      const core = new THREE.Mesh(geo, this.fill)
      core.name = 'core'
      core.position.y = y
      core.rotation.x = rx
      core.renderOrder = 1003
      g.add(rim, core)
    }
    return g
  }

  /** hides the handles; returns true when that changed anything */
  hide(): boolean {
    const was = this.group.visible
    this.group.visible = false
    this.specs = []
    return was
  }

  get visible(): boolean {
    return this.group.visible
  }

  /** places the handles for `item` as seen from `camera` */
  sync(item: Item, camera: THREE.Camera, viewportH: number, top: boolean): void {
    camera.updateMatrixWorld()
    const topC = new THREE.Vector3(item.x / 1000, (item.elevation + item.size.h) / 1000, item.y / 1000)
    const lift = worldPerPixel(camera, topC, viewportH) * (ARROW_GAP_PX + ARROW_PX / 2)
    this.specs = handleSpecs(item, { top, arrowLift: lift })
    const shown = new Set(this.specs.map((s) => s.id))
    for (const [id, m] of this.meshes) m.visible = shown.has(id)
    for (const s of this.specs) {
      const m = this.meshes.get(s.id)
      if (!m) continue
      m.position.copy(s.pos)
      const wpp = worldPerPixel(camera, s.pos, viewportH)
      const hot = s.id === this.hovered || s.id === this.active
      const k = hot ? 1.3 : 1
      if (s.axis === 'elev') m.scale.setScalar((wpp * ARROW_PX * k) / 1.22)
      else if (s.axis === 'h') m.scale.setScalar(wpp * CUBE_PX * k)
      else m.scale.setScalar(wpp * BALL_PX * k)
      if (s.axis === 'h') m.rotation.set(0, -item.rotation * DEG, 0)
      m.traverse((o) => {
        if (o.name === 'core') (o as THREE.Mesh).material = hot ? this.hot : this.fill
      })
    }
    this.group.visible = true
    this.group.updateMatrixWorld(true)
  }

  setHover(id: string | null): boolean {
    if (this.hovered === id) return false
    this.hovered = id
    return true
  }

  setActive(id: string | null): void {
    this.active = id
  }

  spec(id: string): HandleSpec | undefined {
    return this.specs.find((s) => s.id === id)
  }

  /** handle under the screen point (client px), nearest first within HIT_PX */
  hit(clientX: number, clientY: number, camera: THREE.Camera, rect: DOMRect): HandleSpec | null {
    if (!this.group.visible) return null
    let best: HandleSpec | null = null
    let bestD = HIT_PX
    const v = new THREE.Vector3()
    for (const s of this.specs) {
      v.copy(s.pos).project(camera)
      if (v.z < -1 || v.z > 1) continue
      const x = rect.left + (v.x * 0.5 + 0.5) * rect.width
      const y = rect.top + (-v.y * 0.5 + 0.5) * rect.height
      // the arrow is long: measure to its axis segment
      let d: number
      if (s.axis === 'elev') {
        const half = ARROW_PX / 2
        d = Math.hypot(clientX - x, Math.max(0, Math.abs(clientY - y) - half))
      } else d = Math.hypot(clientX - x, clientY - y)
      if (d < bestD) {
        best = s
        bestD = d
      }
    }
    return best
  }

  dispose(): void {
    this.group.removeFromParent()
    this.ballGeo.dispose()
    this.cubeGeo.dispose()
    this.coneGeo.dispose()
    this.stemGeo.dispose()
    this.fill.dispose()
    this.rim.dispose()
    this.hot.dispose()
  }
}
