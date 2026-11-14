/**
 * Camera controls of the 3D view (area: 3d-rendering).
 *
 *  - orbit: OrbitControls with damping, limits and zoom-to-cursor;
 *  - top:   straight-down, near-orthographic view (narrow FOV), pan + zoom only, plan "up" on top;
 *  - walk:  first person at 1.6 m eye height — WASD / arrows, mouse-drag look, Shift to run,
 *           collision against the 2D wall geometry with door openings left passable;
 *  - smooth transitions between modes and for fit();
 *  - wall cut-away (doc.render.wallCutaway): walls standing between the orbit camera and its
 *    target and ceilings seen from above are hidden while orbiting.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Id, OpeningKind } from '@core/types'
import type { CameraControls, EngineContext } from '@/contracts'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { getShared, type ControlsInternals } from './quality'

export type CameraMode = 'orbit' | 'walk' | 'top'

/** What `createControls` really returns (a superset of the CameraControls contract). */
export interface CameraControlsEx extends CameraControls, ControlsInternals {
  /** false while something else (item drag, still render) owns the pointer */
  enabled: boolean
  readonly mode: CameraMode
  /** jump or glide to an explicit view (camera bookmarks) */
  setView(position: THREE.Vector3, target: THREE.Vector3, fov?: number, animate?: boolean): void
}

const EYE_HEIGHT = 1.6
const BODY_RADIUS = 200 // mm
const WALK_SPEED = 1.4 // m/s
const RUN_SPEED = 3.6
const TURN_SPEED = 1.9 // rad/s for the arrow keys
const LOOK_SPEED = 0.0034 // rad per px
const MAX_PITCH = 80 * (Math.PI / 180)
const TOP_FOV = 14
const DEFAULT_FOV = 50
const TRANSITION_SEC = 0.55

const PASSABLE: ReadonlySet<OpeningKind> = new Set<OpeningKind>([
  'door',
  'doubleDoor',
  'slidingDoor',
  'entranceDoor',
  'arch',
  'opening',
  'frenchWindow',
  'balconyDoor',
  'balconyBlock',
])

/** A solid stretch of wall in plan millimetres. */
interface Solid {
  ax: number
  ay: number
  dx: number
  dy: number
  len: number
  half: number
}

interface Transition {
  t: number
  duration: number
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  toQuat: THREE.Quaternion
  fromFov: number
  toFov: number
  done: () => void
}

interface CutEntry {
  object: THREE.Object3D
  wallId: Id | null
  ceiling: boolean
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
}

export function createControls(ctx: EngineContext): CameraControlsEx {
  const camera = ctx.camera
  const canvas = ctx.canvas
  const shared = getShared(ctx)

  let mode: CameraMode = 'orbit'
  let enabled = true
  let disposed = false
  let transition: Transition | null = null
  let orbitInteracting = false
  let orbitFov = camera.fov || DEFAULT_FOV
  let savedOrbit: { position: THREE.Vector3; target: THREE.Vector3 } | null = null
  let pointerInside = false

  // ── orbit / top ──
  const orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.12
  orbit.rotateSpeed = 0.8
  orbit.zoomSpeed = 0.6
  orbit.panSpeed = 1
  orbit.screenSpacePanning = true
  orbit.zoomToCursor = true
  orbit.minDistance = 0.35
  orbit.maxDistance = 250

  function configureOrbit(): void {
    if (mode === 'top') {
      orbit.enableRotate = false
      orbit.minPolarAngle = 0
      orbit.maxPolarAngle = 0
      orbit.minAzimuthAngle = 0
      orbit.maxAzimuthAngle = 0
      orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
      orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
    } else {
      orbit.enableRotate = true
      orbit.minPolarAngle = 0.02
      orbit.maxPolarAngle = Math.PI * 0.495
      orbit.minAzimuthAngle = -Infinity
      orbit.maxAzimuthAngle = Infinity
      orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
      orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    }
    orbit.enabled = enabled && mode !== 'walk' && transition === null
  }

  const onOrbitChange = (): void => {
    if (mode !== 'walk') ctx.invalidate()
  }
  const onOrbitStart = (): void => {
    orbitInteracting = true
    ctx.invalidate()
  }
  const onOrbitEnd = (): void => {
    orbitInteracting = false
    ctx.invalidate()
  }
  orbit.addEventListener('change', onOrbitChange)
  orbit.addEventListener('start', onOrbitStart)
  orbit.addEventListener('end', onOrbitEnd)

  // ── walk state ──
  let yaw = 0
  let pitch = 0
  const velocity = new THREE.Vector3()
  const keys = new Set<string>()
  let looking = false
  let lookPointer = -1
  let lookX = 0
  let lookY = 0
  let walkDirty = false
  let nearBeforeWalk = camera.near
  const walkTarget = new THREE.Vector3()
  const lastWalkPos = new THREE.Vector3()
  const lastWalkQuat = new THREE.Quaternion()

  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  const m1 = new THREE.Matrix4()
  const q1 = new THREE.Quaternion()
  const euler = new THREE.Euler(0, 0, 0, 'YXZ')
  const sphere = new THREE.Sphere()
  const box = new THREE.Box3()

  function safeBounds(): THREE.Box3 {
    box.copy(ctx.getBounds())
    if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
      box.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 2.7, 4))
    }
    return box
  }

  // ── collision geometry (rebuilt when the plan changes) ──
  let solids: Solid[] = []
  let solidsKey: unknown[] = []

  function activeLevelId(): Id {
    const doc = docStore.getState().doc
    const id = uiStore.getState().activeLevelId
    return doc.levels[id] ? id : doc.levelOrder[0]
  }

  function ensureSolids(): Solid[] {
    const state = docStore.getState()
    const doc = state.doc
    const levelId = activeLevelId()
    const plan = state.derived[levelId]
    const key = [doc.walls, doc.openings, doc.nodes, plan, levelId]
    if (key.every((k, i) => k === solidsKey[i]) && solidsKey.length === key.length) return solids
    solidsKey = key
    solids = []
    if (!plan) return solids
    const byWall = new Map<Id, Array<[number, number]>>()
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (!PASSABLE.has(o.kind)) continue
      let list = byWall.get(o.wallId)
      if (!list) {
        list = []
        byWall.set(o.wallId, list)
      }
      list.push([o.offset - o.width / 2 + 25, o.offset + o.width / 2 - 25])
    }
    for (const id in doc.walls) {
      const wall = doc.walls[id]
      if (wall.levelId !== levelId || wall.kind === 'virtual') continue
      const geom = plan.wallGeoms[id]
      if (!geom || !(geom.length > 1)) continue
      const dx = (geom.b.x - geom.a.x) / geom.length
      const dy = (geom.b.y - geom.a.y) / geom.length
      const gaps = (byWall.get(id) ?? []).filter((g) => g[1] > g[0]).sort((a, b) => a[0] - b[0])
      const ext = Math.min(60, wall.thickness / 2)
      let from = -ext
      const end = geom.length + ext
      const pushSolid = (s: number, e: number): void => {
        if (e - s < 5) return
        solids.push({ ax: geom.a.x + dx * s, ay: geom.a.y + dy * s, dx, dy, len: e - s, half: Math.max(10, wall.thickness / 2) })
      }
      for (const [g0, g1] of gaps) {
        pushSolid(from, Math.min(g0, end))
        from = Math.max(from, g1)
      }
      pushSolid(from, end)
    }
    return solids
  }

  /** Pushes a plan point (mm) out of every wall so a body of BODY_RADIUS fits. */
  function resolveCollisions(p: { x: number; y: number }): void {
    const list = ensureSolids()
    const r = BODY_RADIUS
    for (let iter = 0; iter < 4; iter++) {
      let moved = false
      for (const s of list) {
        const rx = p.x - s.ax
        const ry = p.y - s.ay
        const u = rx * s.dx + ry * s.dy
        // left normal on the y-down plan: (dy, −dx)
        const v = rx * s.dy - ry * s.dx
        const du = u < 0 ? -u : u > s.len ? u - s.len : 0
        const dv = Math.abs(v) - s.half
        if (du >= r || dv >= r) continue
        const sv = v >= 0 ? 1 : -1
        if (du === 0) {
          // beside (or inside) the wall body: leave through the nearer face
          const push = r - dv
          p.x += s.dy * sv * push
          p.y += -s.dx * sv * push
          moved = true
        } else if (dv <= 0) {
          // in front of a wall end (door jamb): leave along the axis
          const su = u < 0 ? -1 : 1
          const push = r - du
          p.x += s.dx * su * push
          p.y += s.dy * su * push
          moved = true
        } else {
          const d = Math.hypot(du, dv)
          if (d < r && d > 1e-6) {
            const su = u < 0 ? -1 : 1
            const push = (r - d) / d
            p.x += (s.dx * su * du + s.dy * sv * dv) * push
            p.y += (s.dy * su * du - s.dx * sv * dv) * push
            moved = true
          }
        }
      }
      if (!moved) break
    }
  }

  // ── transitions ──
  function startTransition(toPos: THREE.Vector3, toQuat: THREE.Quaternion, toFov: number, done: () => void, animate = true): void {
    if (!animate) {
      transition = null
      camera.position.copy(toPos)
      camera.quaternion.copy(toQuat)
      if (camera.fov !== toFov) {
        camera.fov = toFov
        camera.updateProjectionMatrix()
      }
      done()
      configureOrbit()
      shared.post?.kick()
      ctx.invalidate()
      return
    }
    transition = {
      t: 0,
      duration: TRANSITION_SEC,
      fromPos: camera.position.clone(),
      toPos: toPos.clone(),
      fromQuat: camera.quaternion.clone(),
      toQuat: toQuat.clone(),
      fromFov: camera.fov,
      toFov,
      done,
    }
    orbit.enabled = false
    ctx.invalidate()
  }

  function stepTransition(dt: number): void {
    const tr = transition
    if (!tr) return
    tr.t += Math.min(Math.max(dt, 0), 0.1) / tr.duration
    const k = easeInOut(Math.min(1, tr.t))
    camera.position.lerpVectors(tr.fromPos, tr.toPos, k)
    camera.quaternion.slerpQuaternions(tr.fromQuat, tr.toQuat, k)
    const fov = tr.fromFov + (tr.toFov - tr.fromFov) * k
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
    if (tr.t >= 1) {
      transition = null
      tr.done()
      configureOrbit()
    }
  }

  function lookQuat(position: THREE.Vector3, target: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
    m1.lookAt(position, target, camera.up)
    return out.setFromRotationMatrix(m1)
  }

  function goOrbitView(position: THREE.Vector3, target: THREE.Vector3, fov: number, animate: boolean): void {
    const pos = position.clone()
    const tgt = target.clone()
    startTransition(
      pos,
      lookQuat(pos, tgt, new THREE.Quaternion()),
      fov,
      () => {
        orbit.target.copy(tgt)
        camera.position.copy(pos)
        orbit.update()
      },
      animate,
    )
  }

  function defaultOrbitView(b: THREE.Box3): { position: THREE.Vector3; target: THREE.Vector3 } {
    b.getBoundingSphere(sphere)
    const target = sphere.center.clone()
    target.y = Math.min(target.y, b.min.y + 1.2)
    const fov = (orbitFov * Math.PI) / 180
    const aspect = camera.aspect || 1.5
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect))
    const distance = Math.max(2, (sphere.radius / Math.sin(fit / 2)) * 1.05)
    // keep the current viewing direction when it is a sensible orbit direction
    const dir = v1.copy(camera.position).sub(orbit.target)
    if (dir.lengthSq() < 1e-6 || dir.y / dir.length() < 0.25 || dir.y / dir.length() > 0.97) {
      dir.set(0.55, 0.75, 0.75)
    }
    dir.normalize()
    return { position: target.clone().addScaledVector(dir, distance), target }
  }

  function topView(b: THREE.Box3): { position: THREE.Vector3; target: THREE.Vector3 } {
    const size = b.getSize(v1)
    const centre = b.getCenter(v2)
    const aspect = camera.aspect || 1.5
    const half = Math.max(size.z / 2, size.x / 2 / aspect, 1) * 1.12
    const distance = half / Math.tan((TOP_FOV * Math.PI) / 360) + b.max.y
    const target = new THREE.Vector3(centre.x, 0, centre.z)
    // the tiny +z offset fixes the roll: plan "up" (−z) ends at the top of the screen
    const position = new THREE.Vector3(centre.x, distance, centre.z + distance * 1e-6)
    return { position, target }
  }

  function walkQuat(y: number, p: number, out: THREE.Quaternion): THREE.Quaternion {
    euler.set(p, y, 0, 'YXZ')
    return out.setFromEuler(euler)
  }

  function updateWalkTarget(): void {
    camera.getWorldDirection(v1)
    walkTarget.copy(camera.position).addScaledVector(v1, 2)
  }

  // ── public: mode switching ──
  function setMode(next: CameraMode): void {
    if (disposed) return
    if (next === mode && transition === null) return
    const prev = mode
    if (prev === 'orbit' && transition === null) {
      savedOrbit = { position: camera.position.clone(), target: orbit.target.clone() }
      orbitFov = camera.fov
    }
    if (prev === 'walk' && next !== 'walk') {
      camera.near = nearBeforeWalk
      camera.updateProjectionMatrix()
      keys.clear()
      velocity.set(0, 0, 0)
      looking = false
    }
    mode = next
    restoreCutaway()
    if (next === 'walk') {
      nearBeforeWalk = camera.near
      if (camera.near > 0.05) {
        camera.near = 0.05
        camera.updateProjectionMatrix()
      }
      // stand where the orbit camera was looking at, facing the same way
      const b = safeBounds()
      const focus = prev === 'walk' ? camera.position.clone() : orbit.target.clone()
      focus.x = THREE.MathUtils.clamp(focus.x, b.min.x - 1, b.max.x + 1)
      focus.z = THREE.MathUtils.clamp(focus.z, b.min.z - 1, b.max.z + 1)
      const plan = { x: focus.x * 1000, y: focus.z * 1000 }
      resolveCollisions(plan)
      const position = new THREE.Vector3(plan.x / 1000, EYE_HEIGHT, plan.y / 1000)
      camera.getWorldDirection(v1)
      if (Math.hypot(v1.x, v1.z) < 0.05) v1.set(0, 0, -1)
      yaw = Math.atan2(-v1.x, -v1.z)
      pitch = 0
      startTransition(position, walkQuat(yaw, pitch, new THREE.Quaternion()), orbitFov < 55 ? 65 : orbitFov, () => {
        lastWalkPos.copy(camera.position)
        lastWalkQuat.copy(camera.quaternion)
        updateWalkTarget()
      })
    } else if (next === 'top') {
      const view = topView(safeBounds())
      if (prev === 'walk') {
        view.target.x = camera.position.x
        view.target.z = camera.position.z
        view.position.x = camera.position.x
        view.position.z = camera.position.z + view.position.y * 1e-6
      }
      goOrbitView(view.position, view.target, TOP_FOV, true)
    } else {
      const view = savedOrbit ?? defaultOrbitView(safeBounds())
      goOrbitView(view.position, view.target, orbitFov, true)
    }
    configureOrbit()
    cutDirty = true
    ctx.invalidate()
  }

  function fit(target: THREE.Box3): void {
    if (disposed) return
    const b = target.isEmpty() ? safeBounds().clone() : target.clone()
    if (mode === 'top') {
      const view = topView(b)
      goOrbitView(view.position, view.target, TOP_FOV, true)
    } else if (mode === 'walk') {
      const c = b.getCenter(new THREE.Vector3())
      const plan = { x: c.x * 1000, y: c.z * 1000 }
      resolveCollisions(plan)
      startTransition(new THREE.Vector3(plan.x / 1000, EYE_HEIGHT, plan.y / 1000), walkQuat(yaw, pitch, new THREE.Quaternion()), camera.fov, () => {
        lastWalkPos.copy(camera.position)
        lastWalkQuat.copy(camera.quaternion)
        updateWalkTarget()
      })
    } else {
      const view = defaultOrbitView(b)
      // a single object: look at its centre, not at the floor below it
      b.getCenter(view.target)
      b.getBoundingSphere(sphere)
      const dir = v1.copy(view.position).sub(sphere.center).normalize()
      const fov = (camera.fov * Math.PI) / 180
      const fitAngle = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * (camera.aspect || 1.5)))
      const distance = Math.max(0.8, (sphere.radius / Math.sin(fitAngle / 2)) * 1.1)
      view.position.copy(view.target).addScaledVector(dir, distance)
      goOrbitView(view.position, view.target, camera.fov, true)
    }
  }

  function setView(position: THREE.Vector3, target: THREE.Vector3, fov?: number, animate = true): void {
    if (disposed) return
    if (mode === 'walk') {
      const dir = v1.copy(target).sub(position)
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1)
      dir.normalize()
      yaw = Math.atan2(-dir.x, -dir.z)
      pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), -MAX_PITCH, MAX_PITCH)
      startTransition(
        position.clone(),
        walkQuat(yaw, pitch, new THREE.Quaternion()),
        fov ?? camera.fov,
        () => {
          lastWalkPos.copy(camera.position)
          lastWalkQuat.copy(camera.quaternion)
          updateWalkTarget()
        },
        animate,
      )
    } else {
      if (mode === 'orbit' && fov) orbitFov = fov
      goOrbitView(position, target, mode === 'top' ? TOP_FOV : (fov ?? camera.fov), animate)
    }
  }

  // ── walk update ──
  function updateWalk(dt: number): boolean {
    // somebody else (engine.setCamera, bookmarks) may have moved the camera
    if (!camera.position.equals(lastWalkPos) || !camera.quaternion.equals(lastWalkQuat)) {
      euler.setFromQuaternion(camera.quaternion, 'YXZ')
      yaw = euler.y
      pitch = THREE.MathUtils.clamp(euler.x, -MAX_PITCH, MAX_PITCH)
      velocity.set(0, 0, 0)
    }
    const step = Math.min(Math.max(dt, 0), 0.1)
    let moving = walkDirty
    walkDirty = false

    if (enabled) {
      const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)
      if (turn !== 0) {
        yaw += turn * TURN_SPEED * step
        moving = true
      }
    }
    const forward = enabled ? (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) : 0
    const strafe = enabled ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight')
    const speed = run ? RUN_SPEED : WALK_SPEED
    // camera looks along −Z at yaw 0
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const rx = Math.cos(yaw)
    const rz = -Math.sin(yaw)
    v1.set(fx * forward + rx * strafe, 0, fz * forward + rz * strafe)
    if (v1.lengthSq() > 1) v1.normalize()
    v1.multiplyScalar(speed)
    velocity.lerp(v1, 1 - Math.exp(-12 * step))
    if (velocity.lengthSq() < 1e-5 && v1.lengthSq() === 0) velocity.set(0, 0, 0)

    if (velocity.lengthSq() > 0) {
      const plan = { x: (camera.position.x + velocity.x * step) * 1000, y: (camera.position.z + velocity.z * step) * 1000 }
      resolveCollisions(plan)
      camera.position.set(plan.x / 1000, EYE_HEIGHT, plan.y / 1000)
      moving = true
    } else if (Math.abs(camera.position.y - EYE_HEIGHT) > 1e-4) {
      camera.position.y = EYE_HEIGHT
      moving = true
    }
    walkQuat(yaw, pitch, q1)
    if (!camera.quaternion.equals(q1)) {
      camera.quaternion.copy(q1)
      moving = true
    }
    lastWalkPos.copy(camera.position)
    lastWalkQuat.copy(camera.quaternion)
    updateWalkTarget()
    return moving
  }

  // ── wall cut-away ──
  let cutEntries: CutEntry[] | null = null
  let cutDirty = true
  const hiddenByMe = new Set<THREE.Object3D>()
  const cutCamera = new Float32Array(6)
  let lastCutFlag: boolean | null = null

  function collectCutEntries(): CutEntry[] {
    const entries: CutEntry[] = []
    const doc = docStore.getState().doc
    const visit = (o: THREE.Object3D): void => {
      const ud = o.userData
      const ref = ud?.ref as { kind?: string; id?: string } | undefined
      if (ud?.surface === 'ceiling') {
        entries.push({ object: o, wallId: null, ceiling: true })
        return
      }
      if (ref && typeof ref.id === 'string') {
        if (ref.kind === 'wall') {
          entries.push({ object: o, wallId: ref.id, ceiling: false })
          return
        }
        if (ref.kind === 'opening') {
          const wallId = doc.openings[ref.id]?.wallId ?? null
          if (wallId) entries.push({ object: o, wallId, ceiling: false })
          return
        }
      }
      for (const child of o.children) visit(child)
    }
    visit(ctx.roots.architecture)
    return entries
  }

  function restoreCutaway(): void {
    if (hiddenByMe.size === 0) return
    for (const o of hiddenByMe) o.visible = true
    hiddenByMe.clear()
    shared.post?.kick()
    ctx.invalidate()
  }

  function applyCutaway(): void {
    const state = docStore.getState()
    const flag = state.doc.render.wallCutaway === true && mode !== 'walk'
    if (!flag) {
      if (lastCutFlag !== false) restoreCutaway()
      lastCutFlag = false
      return
    }
    const cx = camera.position.x
    const cy = camera.position.y
    const cz = camera.position.z
    const tx = orbit.target.x
    const ty = orbit.target.y
    const tz = orbit.target.z
    if (
      !cutDirty &&
      lastCutFlag === true &&
      cutCamera[0] === cx && cutCamera[1] === cy && cutCamera[2] === cz &&
      cutCamera[3] === tx && cutCamera[4] === ty && cutCamera[5] === tz
    ) {
      return
    }
    cutCamera.set([cx, cy, cz, tx, ty, tz])
    lastCutFlag = true
    cutDirty = false
    if (!cutEntries) cutEntries = collectCutEntries()
    const plan = state.derived[activeLevelId()]
    const bounds = safeBounds()
    const horizontal = Math.hypot(cx - tx, cz - tz)
    const elevation = Math.atan2(cy - ty, Math.max(horizontal, 1e-6))
    // seen from steeply above nothing is in the way; keep the walls for context
    const cutWalls = mode === 'orbit' && elevation < (68 * Math.PI) / 180
    const cutCeilings = cy > bounds.max.y - 0.15
    const decided = new Map<Id, boolean>()
    let changed = false
    for (const entry of cutEntries) {
      let hide = false
      if (entry.ceiling) {
        hide = cutCeilings
      } else if (entry.wallId && cutWalls && plan) {
        let d = decided.get(entry.wallId)
        if (d === undefined) {
          d = false
          const g = plan.wallGeoms[entry.wallId]
          if (g && g.length > 1) {
            const mx = (g.a.x + g.b.x) / 2
            const my = (g.a.y + g.b.y) / 2
            const nx = (g.b.y - g.a.y) / g.length
            const ny = -(g.b.x - g.a.x) / g.length
            const sc = (cx * 1000 - mx) * nx + (cz * 1000 - my) * ny
            const st = (tx * 1000 - mx) * nx + (tz * 1000 - my) * ny
            // the wall line separates the camera from what it looks at
            d = sc * st < 0 && Math.abs(sc) > 150 && Math.abs(st) > 40
          }
          decided.set(entry.wallId, d)
        }
        hide = d
      }
      const o = entry.object
      if (hide) {
        if (o.visible) {
          o.visible = false
          hiddenByMe.add(o)
          changed = true
        }
      } else if (hiddenByMe.has(o)) {
        o.visible = true
        hiddenByMe.delete(o)
        changed = true
      }
    }
    if (changed) {
      shared.post?.kick()
      ctx.invalidate()
    }
  }

  // ── per-frame update ──
  function update(dt: number): boolean {
    if (disposed) return false
    let moving = false
    if (transition) {
      stepTransition(dt)
      moving = true
    } else if (mode === 'walk') {
      moving = updateWalk(dt)
    } else {
      orbit.enabled = enabled
      const changed = orbit.update(dt)
      moving = changed || orbitInteracting
      if (mode === 'orbit' && Math.abs(camera.fov - TOP_FOV) > 0.01) orbitFov = camera.fov
    }
    applyCutaway()
    if (moving) ctx.invalidate()
    return moving
  }

  // ── input (walk mode) ──
  function keysActive(): boolean {
    if (!enabled || mode !== 'walk' || shared.stillBusy) return false
    if (!ctx.container.isConnected || ctx.container.offsetParent === null) return false
    return pointerInside || document.activeElement === canvas
  }

  const WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!WALK_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return
    if (isEditable(e.target) || !keysActive()) return
    keys.add(e.code)
    if (e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') {
      e.preventDefault()
      e.stopPropagation()
    }
    ctx.invalidate()
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if (keys.delete(e.code)) ctx.invalidate()
  }
  const onBlur = (): void => {
    keys.clear()
    looking = false
  }
  const onPointerEnter = (): void => {
    pointerInside = true
  }
  const onPointerLeave = (): void => {
    pointerInside = false
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (mode !== 'walk' || !enabled || transition || shared.stillBusy) return
    if (e.button !== 0 && e.button !== 2) return
    looking = true
    lookPointer = e.pointerId
    lookX = e.clientX
    lookY = e.clientY
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* the pointer may already be gone */
    }
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (!looking || e.pointerId !== lookPointer) return
    if (mode !== 'walk' || !enabled) {
      looking = false
      return
    }
    const dx = e.clientX - lookX
    const dy = e.clientY - lookY
    lookX = e.clientX
    lookY = e.clientY
    if (dx === 0 && dy === 0) return
    yaw -= dx * LOOK_SPEED
    pitch = THREE.MathUtils.clamp(pitch - dy * LOOK_SPEED, -MAX_PITCH, MAX_PITCH)
    walkDirty = true
    ctx.invalidate()
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== lookPointer) return
    looking = false
    lookPointer = -1
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
  }
  const onWheel = (e: WheelEvent): void => {
    if (mode !== 'walk' || !enabled || transition) return
    e.preventDefault()
    const stepM = THREE.MathUtils.clamp(-e.deltaY * 0.004, -0.8, 0.8)
    const plan = { x: (camera.position.x - Math.sin(yaw) * stepM) * 1000, y: (camera.position.z - Math.cos(yaw) * stepM) * 1000 }
    resolveCollisions(plan)
    camera.position.set(plan.x / 1000, EYE_HEIGHT, plan.y / 1000)
    lastWalkPos.copy(camera.position)
    walkDirty = true
    ctx.invalidate()
  }
  const onContextMenu = (e: Event): void => {
    if (mode === 'walk') e.preventDefault()
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  ctx.container.addEventListener('pointerenter', onPointerEnter)
  ctx.container.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)

  const unsubScene = ctx.onSceneChanged(() => {
    // objects were replaced: forget the old ones (they are gone together with their flags)
    cutEntries = null
    hiddenByMe.clear()
    cutDirty = true
  })
  let lastCutaway = docStore.getState().doc.render.wallCutaway
  const unsubDoc = docStore.subscribe((state) => {
    const flag = state.doc.render.wallCutaway
    if (flag !== lastCutaway) {
      lastCutaway = flag
      cutDirty = true
      ctx.invalidate()
    }
  })

  // start from a sensible overview when the camera has never been placed
  configureOrbit()
  if (camera.position.lengthSq() < 1e-8) {
    const view = defaultOrbitView(safeBounds())
    camera.position.copy(view.position)
    orbit.target.copy(view.target)
  }
  orbit.update()

  const api: CameraControlsEx = {
    setMode,
    update,
    fit,
    setView,
    get target(): THREE.Vector3 {
      return mode === 'walk' ? walkTarget : orbit.target
    },
    get mode(): CameraMode {
      return mode
    },
    get enabled(): boolean {
      return enabled
    },
    set enabled(value: boolean) {
      enabled = value
      if (!value) {
        looking = false
        keys.clear()
      }
      orbit.enabled = value && mode !== 'walk' && transition === null
    },
    dispose() {
      if (disposed) return
      disposed = true
      restoreCutaway()
      unsubScene()
      unsubDoc()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      ctx.container.removeEventListener('pointerenter', onPointerEnter)
      ctx.container.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      orbit.removeEventListener('change', onOrbitChange)
      orbit.removeEventListener('start', onOrbitStart)
      orbit.removeEventListener('end', onOrbitEnd)
      orbit.dispose()
      if (shared.controls === api) shared.controls = null
    },
  }
  shared.controls = api
  return api
}
