/**
 * Curtains and blinds for openings.
 *
 * Local frame (ProceduralFactory.buildCurtain): metres, X along the wall, Y up, origin on the floor
 * under the opening centre, +Z towards the room. The caller places the frame ~10 cm in front of the
 * wall face, so brackets reach back to z = -0.1.
 */
import * as THREE from 'three'
import { DEFAULT_MATERIALS } from '@core'
import type { CurtainSpec, Id, Material } from '@core/types'
import type { MaterialLibrary } from '@/contracts'
import { F, type MatFallback, cached, clamp, cyl, cylX, fallbackId, gkey, mat4, merge, rbox, rng, sphere, torus } from './common'

/** distance from the curtain frame origin back to the wall face */
const WALL_Z = -0.1

interface CurtainDims {
  width: number
  top: number
  bottom: number
}

/** optional MaterialLibraryEx.variant (view3d/materials.ts), used to make an opaque fabric sheer */
type VariantFn = (finish: Id, overrides: Partial<Material>, opts?: { doubleSided?: boolean }) => THREE.Material

function fabricMaterial(mats: MaterialLibrary, id: Id, sheer: boolean): THREE.Material {
  const m = mats.get(id, { doubleSided: true })
  if (!sheer) return m
  const pm = m as THREE.Material & { transmission?: number }
  if (m.transparent || (pm.transmission ?? 0) > 0.1) return m
  const variant = (mats as MaterialLibrary & { variant?: VariantFn }).variant
  if (typeof variant === 'function') return variant.call(mats, id, { opacity: 0.5, sheen: 0.5 }, { doubleSided: true })
  return m
}

function hardware(mats: MaterialLibrary, f: MatFallback): THREE.Material {
  return mats.getForItem(fallbackId(f))
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, slot: string, parent: THREE.Object3D, pos?: [number, number, number], shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  if (pos) m.position.set(pos[0], pos[1], pos[2])
  m.castShadow = shadow
  m.receiveShadow = true
  m.userData.slot = slot
  parent.add(m)
  return m
}

// ───────────────────────────── geometry builders ─────────────────────────────

/**
 * Pleated drape panel centred on x = 0, top edge at y = 0 hanging down to y = -h, centred on z = 0.
 * `fabric`: flat fabric width (m); `pw`: current (gathered) panel width; `pleats`: pleat count.
 * UVs are in metres of flat fabric so textures do not stretch when the curtain is gathered.
 */
function drapePanel(pw: number, h: number, fabric: number, pleats: number, maxAmp: number, flare: number, seed: number): THREE.BufferGeometry {
  return cached(gkey('drape', pw, h, fabric, pleats, maxAmp, flare, seed), () => {
    const n = Math.max(2, pleats)
    const lambda = pw / n
    const ratio = Math.max(1, fabric / pw)
    const A = clamp((lambda / Math.PI) * Math.sqrt(ratio - 1), 0.003, maxAmp)
    const cols = n * 10 + 1
    const rows = clamp(Math.round(h / 0.04), 14, 64) + 1
    const R = rng(seed)
    const jitter: number[] = []
    for (let i = 0; i <= n; i++) jitter.push(0.85 + R() * 0.3)
    const pos = new Float32Array(cols * rows * 3)
    const uv = new Float32Array(cols * rows * 2)
    let k = 0
    for (let j = 0; j < rows; j++) {
      const v = j / (rows - 1)
      for (let i = 0; i < cols; i++) {
        const u = i / (cols - 1)
        const phase = u * n * Math.PI * 2
        const pleat = Math.min(n - 1, Math.floor(u * n))
        // pleats get deeper towards the hem, header slightly flatter
        const amp = A * jitter[pleat] * (0.82 + 0.3 * v) * (v < 0.03 ? 0.85 : 1)
        const sway = A * 0.18 * Math.sin(phase * 0.5 + seed * 0.7 + v * 2.4)
        const z = amp * Math.sin(phase) + sway * v
        // gathered stacks splay out a little at the bottom
        const x = (u - 0.5) * pw * (1 + flare * v * v)
        // hem: the pleat crests lift slightly
        const y = -v * h + (v > 0.97 ? 0.004 * (1 - Math.cos(phase)) * (v - 0.97) / 0.03 : 0)
        pos[k * 3] = x
        pos[k * 3 + 1] = y
        pos[k * 3 + 2] = z
        uv[k * 2] = u * fabric
        uv[k * 2 + 1] = (1 - v) * h
        k++
      }
    }
    const idx: number[] = []
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i
        const b = a + 1
        const c = a + cols
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  })
}

/**
 * Ruled sheet of width w along X following a side-view profile [(y, z)] from the top down.
 * UV: u = x in metres, v = arc length in metres (top = 0).
 */
function sheetFromProfile(key: string, w: number, profile: [number, number][]): THREE.BufferGeometry {
  return cached(gkey('sheet', w) + '|' + key, () => {
    const cols = 9
    const rows = profile.length
    const pos = new Float32Array(cols * rows * 3)
    const uv = new Float32Array(cols * rows * 2)
    let arc = 0
    let k = 0
    for (let j = 0; j < rows; j++) {
      if (j > 0) arc += Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1])
      for (let i = 0; i < cols; i++) {
        const x = -w / 2 + (i / (cols - 1)) * w
        pos[k * 3] = x
        pos[k * 3 + 1] = profile[j][0]
        pos[k * 3 + 2] = profile[j][1]
        uv[k * 2] = x
        uv[k * 2 + 1] = -arc
        k++
      }
    }
    const idx: number[] = []
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i
        const b = a + 1
        const c = a + cols
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  })
}

/** slightly crowned venetian slat (depth along Z), centred */
function slatGeometry(w: number, depth: number, t: number): THREE.BufferGeometry {
  return cached(gkey('slat', w, depth, t), () => {
    const s = new THREE.Shape()
    const crown = depth * 0.08
    s.moveTo(-depth / 2, 0)
    s.quadraticCurveTo(0, crown * 2, depth / 2, 0)
    s.lineTo(depth / 2, -t)
    s.quadraticCurveTo(0, crown * 2 - t, -depth / 2, -t)
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false, curveSegments: 6 })
    g.translate(0, 0, -w / 2)
    // profile was drawn in XY with depth along X; extrusion along Z → rotate so the slat runs along X
    g.rotateY(Math.PI / 2)
    g.computeVertexNormals()
    return g
  })
}

// ───────────────────────────── rods & rails ─────────────────────────────

/** round curtain rod with finials, rings and wall brackets; z = rod axis */
function addRod(root: THREE.Group, mats: MaterialLibrary, len: number, y: number, z: number, ringXs: number[]): void {
  const metal = hardware(mats, F.curtainRail)
  const r = 0.0125
  mesh(cylX(r, len, 20), metal, 'rod', root, [0, y, z])
  for (const s of [-1, 1]) {
    mesh(sphere(0.024, 1, 1, 1, 18), metal, 'rod', root, [s * (len / 2 + 0.018), y, z])
    mesh(cylX(0.016, 0.012, 16), metal, 'rod', root, [s * (len / 2 + 0.002), y, z])
  }
  const brackets = len > 2.6 ? [-len / 2 + 0.12, 0, len / 2 - 0.12] : [-len / 2 + 0.12, len / 2 - 0.12]
  const armLen = Math.max(0.02, z - WALL_Z)
  for (const x of brackets) {
    const arm = cached(gkey('rodArm', armLen), () => {
      const a = new THREE.CylinderGeometry(0.006, 0.006, armLen, 10)
      a.rotateX(Math.PI / 2)
      const plate = new THREE.CylinderGeometry(0.022, 0.022, 0.008, 20)
      plate.rotateX(Math.PI / 2)
      const cup = new THREE.TorusGeometry(r + 0.003, 0.003, 6, 20, Math.PI)
      cup.rotateY(Math.PI / 2)
      cup.rotateX(Math.PI)
      return merge([
        { g: a, m: mat4([0, 0, -armLen / 2]) },
        { g: plate, m: mat4([0, 0, -armLen + 0.004]) },
        { g: cup, m: mat4([0, 0, 0]) },
      ])
    })
    mesh(arm, metal, 'rod', root, [x, y, z])
  }
  const ring = torus(0.02, 0.0028, 8, 24)
  for (const x of ringXs) {
    const m = mesh(ring, metal, 'rod', root, [x, y - 0.006, z])
    m.rotation.y = Math.PI / 2
  }
}

/** flat headrail box (blinds, roman, roller cassette) */
function addHeadrail(root: THREE.Group, mats: MaterialLibrary, w: number, y: number, h: number, d: number, z: number, f: MatFallback): void {
  mesh(rbox(w, h, d, 0.004), hardware(mats, f), 'rail', root, [0, y, z])
  // brackets to the wall
  const armLen = Math.max(0.01, z - d / 2 - WALL_Z)
  for (const s of [-1, 1]) {
    mesh(rbox(0.03, h * 0.8, armLen, 0.002), hardware(mats, F.curtainRail), 'rail', root, [s * (w / 2 - 0.08), y, z - d / 2 - armLen / 2])
  }
}

// ───────────────────────────── curtain kinds ─────────────────────────────

interface DrapeLayer {
  materialId: Id
  sheer: boolean
  closed: number
  z: number
}

function addDrapes(root: THREE.Group, mats: MaterialLibrary, W: number, top: number, bottom: number, layer: DrapeLayer, withRod: boolean): void {
  const rodY = top - 0.03
  const fabricTop = rodY - 0.032
  const h = Math.max(0.1, fabricTop - bottom)
  const fullness = layer.sheer ? 2.4 : 2.0
  const half = W / 2
  const fabric = half * fullness
  const closed = clamp(layer.closed, 0, 1)
  const stack = Math.max(0.1, fabric * (layer.sheer ? 0.09 : 0.13))
  const pw = Math.max(stack, Math.min(half + 0.02, half * closed + 0.02))
  const pleats = Math.max(4, Math.round(fabric / (layer.sheer ? 0.13 : 0.19)))
  const maxAmp = layer.sheer ? 0.028 : 0.05
  const flare = (1 - closed) * (layer.sheer ? 0.12 : 0.22)
  const mat = fabricMaterial(mats, layer.materialId, layer.sheer)
  const ringXs: number[] = []
  for (const side of [-1, 1]) {
    const cx = side * (half - pw / 2)
    const geo = drapePanel(pw, h, fabric, pleats, maxAmp, flare, side < 0 ? 11 : 29)
    // the right panel sits a few mm in front so that overlapping closed panels never z-fight
    mesh(geo, mat, layer.sheer ? 'sheer' : 'fabric', root, [cx, fabricTop, layer.z + (side > 0 ? 0.006 : 0)], !layer.sheer)
    const nr = Math.max(3, Math.round(pleats / 2))
    for (let i = 0; i < nr; i++) ringXs.push(cx - pw / 2 + (pw * (i + 0.5)) / nr)
  }
  if (withRod) addRod(root, mats, W + 0.1, rodY, layer.z, layer.sheer ? [] : ringXs)
}

function addRoman(root: THREE.Group, mats: MaterialLibrary, W: number, top: number, bottom: number, materialId: Id, closed: number): void {
  const railH = 0.04
  const z = 0
  addHeadrail(root, mats, W + 0.02, top - railH / 2, railH, 0.05, z, F.curtainRail)
  const y0 = top - railH
  const L = Math.max(0.1, y0 - bottom)
  const c = clamp(closed, 0, 1)
  const pitch = 0.22
  const k = c >= 0.98 ? 0 : clamp(Math.round(((1 - c) * L) / (2 * pitch)), 1, 12)
  const flat = Math.max(0, L - 2 * k * pitch)
  const prof: [number, number][] = []
  const zf = z + 0.012
  if (k === 0) {
    // fully lowered: flat face with soft horizontal tucks
    const steps = Math.max(12, Math.round(L / 0.02))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      prof.push([y0 - t * L, zf + 0.006 * Math.sin((t * L * Math.PI * 2) / (pitch * 1.6)) ** 2])
    }
  } else {
    const flatSteps = Math.max(2, Math.round(flat / 0.05))
    for (let i = 0; i <= flatSteps; i++) prof.push([y0 - (i / flatSteps) * flat, zf])
    const fh = 0.055
    let ya = y0 - flat
    for (let j = 0; j < k; j++) {
      // folds get slightly fuller towards the bottom of the stack
      const bulge = 0.045 + 0.012 * (j / Math.max(1, k - 1))
      for (let s = 1; s <= 10; s++) {
        const t = s / 10
        prof.push([ya - fh * t, zf + bulge * Math.sin(Math.PI * t)])
      }
      ya -= fh
    }
  }
  const key = gkey('roman', y0, L, c, k, zf)
  const geo = sheetFromProfile(key, W, prof)
  mesh(geo, fabricMaterial(mats, materialId, false), 'fabric', root)
  // weighted batten at the hem
  const last = prof[prof.length - 1]
  mesh(cylX(0.006, W - 0.01, 12), hardware(mats, F.aluminium), 'rail', root, [0, last[0] + 0.004, last[1]])
}

function addRoller(root: THREE.Group, mats: MaterialLibrary, W: number, top: number, bottom: number, materialId: Id, closed: number): void {
  const c = clamp(closed, 0, 1)
  const L = Math.max(0.1, top - 0.05 - bottom)
  const rolled = (1 - c) * L
  const r = Math.sqrt(0.016 * 0.016 + (0.0006 * rolled) / Math.PI)
  const yAxis = top - 0.035
  const z = 0
  const fw = W - 0.03
  mesh(cylX(r, fw, 28), fabricMaterial(mats, materialId, false), 'fabric', root, [0, yAxis, z])
  // end brackets with a chain on the right
  const metal = hardware(mats, F.whiteGloss)
  for (const s of [-1, 1]) mesh(rbox(0.018, 0.07, 0.07, 0.005), metal, 'rail', root, [s * (fw / 2 + 0.009), yAxis, z])
  const armLen = Math.max(0.01, z - 0.035 - WALL_Z)
  for (const s of [-1, 1]) mesh(rbox(0.018, 0.04, armLen, 0.002), metal, 'rail', root, [s * (fw / 2 + 0.009), yAxis + 0.01, z - 0.035 - armLen / 2])
  const drop = c * L
  if (drop > 0.01) {
    const geo = sheetFromProfile(gkey('roller', yAxis, drop, r, z), fw - 0.004, [
      [yAxis, z + r],
      [yAxis - drop, z + r],
    ])
    mesh(geo, fabricMaterial(mats, materialId, false), 'fabric', root)
  }
  // bottom bar
  mesh(rbox(fw, 0.022, 0.012, 0.004), hardware(mats, F.aluminium), 'rail', root, [0, yAxis - drop - 0.011, z + r])
  // operating chain
  const chainLen = Math.max(0.2, Math.min(1.0, top - bottom) * 0.6)
  const chain = cached(gkey('chain', chainLen), () => {
    const a = new THREE.CylinderGeometry(0.0018, 0.0018, chainLen, 6)
    return merge([
      { g: a, m: mat4([-0.006, -chainLen / 2, 0]) },
      { g: a, m: mat4([0.006, -chainLen / 2, 0]) },
    ])
  })
  mesh(chain, metal, 'rail', root, [fw / 2 + 0.03, yAxis, z + 0.01], false)
}

function addBlinds(root: THREE.Group, mats: MaterialLibrary, W: number, top: number, bottom: number, materialId: Id, closed: number): void {
  const c = clamp(closed, 0, 1)
  const railH = 0.035
  const z = 0
  addHeadrail(root, mats, W, top - railH / 2, railH, 0.05, z, F.blinds)
  const y0 = top - railH - 0.008
  const L = Math.max(0.1, y0 - bottom - 0.012)
  const pitch = 0.022
  const total = Math.max(2, Math.floor(L / pitch))
  const hanging = Math.round(total * c)
  const stacked = total - hanging
  const sw = W - 0.012
  const tilt = c > 0.98 ? 0.2 : 0.55
  const slat = slatGeometry(sw, 0.025, 0.0015)
  const slats = cached(gkey('slats', sw, hanging, stacked, tilt), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    let y = 0
    for (let i = 0; i < stacked; i++) {
      parts.push({ g: slat, m: mat4([0, y, 0]) })
      y -= 0.0045
    }
    for (let i = 0; i < hanging; i++) {
      y -= i === 0 ? 0.006 : pitch
      parts.push({ g: slat, m: mat4([0, y, 0], [tilt, 0, 0]) })
    }
    return merge(parts)
  })
  const mat = mats.get(materialId, { doubleSided: true })
  mesh(slats, mat, 'slats', root, [0, y0, z])
  const stackH = stacked * 0.0045
  const hangH = hanging > 0 ? 0.006 + (hanging - 1) * pitch : 0
  const bottomY = y0 - stackH - hangH - 0.014
  mesh(rbox(sw, 0.012, 0.028, 0.003), mats.getForItem(materialId), 'rail', root, [0, bottomY, z])
  // ladder cords front & back of the slats
  const cords = sw < 1 ? [-sw * 0.32, sw * 0.32] : [-sw * 0.38, 0, sw * 0.38]
  const cordLen = Math.max(0.01, y0 - bottomY)
  const cordMat = hardware(mats, F.linen)
  for (const x of cords) {
    for (const s of [-1, 1]) {
      mesh(cyl(0.0007, 0.0007, cordLen, 4), cordMat, 'cords', root, [x, bottomY + cordLen / 2, z + s * 0.012], false)
    }
  }
}

// ───────────────────────────── entry point ─────────────────────────────

export function buildCurtain(spec: CurtainSpec, dims: CurtainDims, mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'curtain'
  root.userData.curtain = spec.kind
  if (spec.kind === 'none') return root
  const W = Math.max(0.2, dims.width)
  const top = Math.max(0.3, dims.top)
  const bottom = clamp(dims.bottom, 0, top - 0.15)
  const closed = clamp(Number.isFinite(spec.closed) ? spec.closed : 0.5, 0, 1)
  const curtainId = spec.materialId ?? DEFAULT_MATERIALS.curtain
  const sheerId = spec.sheerMaterialId ?? DEFAULT_MATERIALS.sheer
  switch (spec.kind) {
    case 'drapes':
      addDrapes(root, mats, W, top, bottom, { materialId: curtainId, sheer: false, closed, z: 0 }, true)
      break
    case 'sheer':
      addDrapes(root, mats, W, top, bottom, { materialId: spec.sheerMaterialId ?? spec.materialId ?? DEFAULT_MATERIALS.sheer, sheer: true, closed, z: 0 }, true)
      break
    case 'drapesAndSheer': {
      // sheer on the rear rod stays drawn; the drapes on the front rod follow `closed`
      addDrapes(root, mats, W, top, bottom, { materialId: sheerId, sheer: true, closed: 1, z: -0.045 }, true)
      addDrapes(root, mats, W, top, bottom, { materialId: curtainId, sheer: false, closed, z: 0.035 }, true)
      break
    }
    case 'roman':
      addRoman(root, mats, W, top, bottom, curtainId, closed)
      break
    case 'roller':
      addRoller(root, mats, W, top, bottom, curtainId, closed)
      break
    case 'blinds': {
      // the generic default curtain fabric makes no sense for slats: use white aluminium instead
      const id = spec.materialId && spec.materialId !== DEFAULT_MATERIALS.curtain ? spec.materialId : fallbackId(F.blinds)
      addBlinds(root, mats, W, top, bottom, id, closed)
      break
    }
  }
  return root
}
