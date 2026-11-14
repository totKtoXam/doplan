/**
 * ProceduralFactory: parametric furniture, appliances, sanitary ware, decor and curtains.
 *
 * build(): metres, Y-up, origin at the footprint centre on the floor, +Z = front. The generated
 * object exactly fills item.size (w → X, h → Y, d → Z); parts flagged `userData.overflow`
 * (stair balustrades, bar-counter posts, a bidet tap) are allowed to leave that box.
 */
import * as THREE from 'three'
import type { Asset, Item, ProceduralKind } from '@core/types'
import type { MaterialLibrary, ProceduralFactory } from '@/contracts'
import { airConditioner, dishwasher, fridge, hood, oven, radiator, stove, tv, washingMachine } from './appliances'
import { bathtub, shower, sink, toilet, washbasin } from './bathroom'
import { Ctx, clearGeometryCache, fallbackMaterialIds, geometryCacheSize } from './common'
import { buildCurtain } from './curtains'
import { column, mirror, picture, plantPot, stairs } from './decor'
import { boxKind, kitchenBase, kitchenTall, kitchenWall, shelf, wardrobe, worktop } from './kitchen'
import { bed, rug, sofa } from './soft'
import { chair, table } from './tables'

type Generator = (c: Ctx) => void

/** one generator per ProceduralKind (the Record type makes a missing kind a compile error) */
const GENERATORS: Record<ProceduralKind, Generator> = {
  box: boxKind,
  kitchenBase,
  kitchenWall,
  kitchenTall,
  worktop,
  wardrobe,
  shelf,
  bed,
  sofa,
  table,
  chair,
  fridge,
  stove,
  oven,
  hood,
  dishwasher,
  washingMachine,
  tv,
  sink,
  toilet,
  bathtub,
  shower,
  washbasin,
  radiator,
  rug,
  mirror,
  picture,
  column,
  stairs,
  airConditioner,
  plantPot,
}

// ───────────────────────────── parameter adapters ─────────────────────────────
//
// core/defaults.ts BUILTIN_ASSETS describe items with compact, UI-friendly params (doors: 2,
// sliding: true, legs: 4, plant: 'palm' …). The generators use more specific names; these adapters
// translate without overriding a generator-specific param the user may have set explicitly.

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : v === 'true' ? true : v === 'false' ? false : undefined)

const ADAPTERS: Partial<Record<ProceduralKind, (c: Ctx) => void>> = {
  kitchenBase(c) {
    const doors = num(c.raw('doors'))
    const drawers = num(c.raw('drawers')) ?? 0
    if (bool(c.raw('glass'))) c.def('layout', 'glass')
    else if (doors === 0 && drawers > 0) c.def('layout', 'drawers')
    else if ((doors ?? 1) > 0 && drawers > 0) c.def('layout', 'mixed')
    if (doors === 0) c.set('doors', 1)
    if (drawers <= 0) c.set('drawers', 3)
    if (bool(c.raw('sink'))) c.def('cutout', 'sink')
    else if (bool(c.raw('hob'))) c.def('cutout', 'hob')
    if (bool(c.raw('handles')) === false) c.def('handle', 'none')
  },
  kitchenWall(c) {
    if (bool(c.raw('open'))) c.def('layout', 'open')
    else if (bool(c.raw('glass'))) c.def('layout', 'glass')
    else if (bool(c.raw('horizontal'))) c.def('layout', 'lift')
    if (num(c.raw('doors')) === 0) c.set('doors', 1)
    if (bool(c.raw('handles')) === false) c.def('handle', 'none')
  },
  kitchenTall(c) {
    if (bool(c.raw('oven')) || bool(c.raw('microwave'))) c.def('layout', 'oven')
    else if (bool(c.raw('fridge'))) c.def('layout', 'fridge')
    else if (bool(c.raw('pantry'))) c.def('layout', 'pantry')
    if (num(c.raw('doors')) === 0) c.set('doors', 1)
  },
  wardrobe(c) {
    const doors = c.raw('doors')
    if (typeof doors === 'string' && (doors === 'hinged' || doors === 'sliding')) c.def('doorType', doors)
    else {
      const n = num(doors)
      if (n !== undefined) c.def('count', Math.max(0, Math.round(n)))
    }
    const sliding = bool(c.raw('sliding'))
    if (sliding !== undefined) c.def('doorType', sliding ? 'sliding' : 'hinged')
  },
  shelf(c) {
    const back = bool(c.raw('back'))
    // a single board without back panel is a floating wall shelf
    if (back === false && (num(c.raw('shelves')) ?? 2) <= 1 && c.H < 0.4) c.def('style', 'floating')
  },
  bed(c) {
    const hb = c.raw('headboard')
    if (typeof hb === 'boolean' || typeof hb === 'number') c.set('headboard', bool(hb) ? (c.H > 0.62 ? 'panel' : 'none') : 'none')
  },
  table(c) {
    const legs = c.raw('legs')
    const n = num(legs)
    if (n === undefined) return
    const shape = c.str('shape', 'rect', ['rect', 'round', 'oval'] as const)
    let style: string
    if (n <= 0) style = 'frame'
    else if (n === 1) style = 'pedestal'
    else if (n === 2) style = 'panel'
    else if (n === 3) style = 'tripod'
    else style = shape !== 'rect' || c.H < 0.6 ? 'tapered' : 'square'
    c.set('legs', style)
  },
  chair(c) {
    const type = c.raw('type')
    if (typeof type === 'string' && ['dining', 'office', 'stool', 'armchair'].includes(type)) c.def('variant', type)
    else if (type === 'bar') c.def('variant', 'stool')
    const back = bool(c.raw('back'))
    const seat = num(c.raw('seatHeight')) ?? 460
    if (back === false) c.def('variant', 'stool')
    else if (seat >= 600) c.def('variant', 'stool')
    if (bool(c.raw('arms')) && c.raw('variant') === undefined && c.W > 0.62) c.def('variant', 'armchair')
  },
  fridge(c) {
    if (bool(c.raw('sideBySide'))) c.def('layout', 'sideBySide')
    else if (num(c.raw('doors')) === 1) c.def('layout', 'single')
    else if (bool(c.raw('topFreezer'))) c.def('layout', 'topFreezer')
  },
  hood(c) {
    const type = c.raw('type')
    if (typeof type === 'string') c.def('style', type)
  },
  toilet(c) {
    const type = c.raw('type')
    if (type === 'wallHung') c.def('wallHung', true)
    else if (type === 'bidet') {
      c.def('bidet', true)
      c.def('tank', false)
    } else if (type === 'floor') c.def('wallHung', false)
  },
  bathtub(c) {
    const fs = bool(c.raw('freestanding'))
    if (fs !== undefined) c.def('style', fs ? 'freestanding' : 'builtIn')
  },
  shower(c) {
    const doors = bool(c.raw('doors'))
    if (doors !== undefined) c.def('enclosure', doors ? (c.W > 1.05 && c.D < c.W ? 'niche' : 'corner') : 'walkIn')
  },
  washbasin(c) {
    const vanity = bool(c.raw('vanity'))
    if (vanity !== undefined) c.def('cabinet', vanity)
    if (bool(c.raw('pedestal'))) c.def('cabinet', false)
  },
  mirror(c) {
    const f = num(c.raw('frame'))
    if (f !== undefined) c.def('frameWidth', f)
  },
  picture(c) {
    const f = num(c.raw('frame'))
    if (f !== undefined) c.def('frameWidth', f)
    const pp = num(c.raw('passepartout'))
    if (pp !== undefined) {
      if (pp <= 0) c.def('mat', false)
      else c.def('matWidth', pp)
    }
  },
  stairs(c) {
    const r = c.raw('railing')
    if (typeof r === 'boolean' || typeof r === 'number') c.set('railing', bool(r) ? (c.str('type', 'straight') === 'straight' ? 'right' : 'inner') : 'none')
  },
  plantPot(c) {
    const p = c.raw('plant')
    if (typeof p !== 'string') return
    const map: Record<string, string> = { ficus: 'tall', tree: 'tall', olive: 'tall', palm: 'grass', dracaena: 'grass', snake: 'grass', grass: 'grass', bush: 'bush', monstera: 'bush' }
    c.def('style', map[p] ?? 'bush')
  },
}

// ───────────────────────────── size fit ─────────────────────────────

function isOverflow(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (p.userData.overflow) return true
  return false
}

/**
 * Generators build at the target size already; this removes the residual differences (rounded
 * parts, rotated members) so the visible bounds match item.size exactly.
 */
function fitToSize(root: THREE.Group, W: number, H: number, D: number): void {
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const bounds = new THREE.Box3()
  const tmp = new THREE.Box3()
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || isOverflow(o, root)) return
    const g = mesh.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    if (!g.boundingBox || g.boundingBox.isEmpty()) return
    m.multiplyMatrices(inv, mesh.matrixWorld)
    tmp.copy(g.boundingBox).applyMatrix4(m)
    bounds.union(tmp)
  })
  if (bounds.isEmpty()) return
  const size = bounds.getSize(new THREE.Vector3())
  const sx = size.x > 1e-5 ? W / size.x : 1
  const sy = size.y > 1e-5 ? H / size.y : 1
  const sz = size.z > 1e-5 ? D / size.z : 1
  const cx = (bounds.min.x + bounds.max.x) / 2
  const cz = (bounds.min.z + bounds.max.z) / 2
  const tol = 0.0005
  if (
    Math.abs(size.x - W) < tol &&
    Math.abs(size.y - H) < tol &&
    Math.abs(size.z - D) < tol &&
    Math.abs(cx) < tol &&
    Math.abs(cz) < tol &&
    Math.abs(bounds.min.y) < tol
  )
    return
  const fit = new THREE.Group()
  fit.name = 'fit'
  for (const child of [...root.children]) fit.add(child)
  fit.scale.set(sx, sy, sz)
  fit.position.set(-cx * sx, -bounds.min.y * sy, -cz * sz)
  root.add(fit)
}

// ───────────────────────────── factory ─────────────────────────────

function buildProcedural(asset: Asset, item: Item, mats: MaterialLibrary): THREE.Object3D {
  const kind: ProceduralKind = asset.procedural && asset.procedural in GENERATORS ? asset.procedural : 'box'
  const c = new Ctx(asset, item, mats)
  ADAPTERS[kind]?.(c)
  GENERATORS[kind](c)
  const root = c.root
  root.name = `procedural:${kind}`
  root.userData.procedural = kind
  fitToSize(root, c.W, c.H, c.D)
  return root
}

export function createProceduralFactory(): ProceduralFactory {
  return {
    build: buildProcedural,
    buildCurtain,
  }
}

/** every ProceduralKind with a generator (dev self-check / tests) */
export function listProceduralKinds(): ProceduralKind[] {
  return Object.keys(GENERATORS) as ProceduralKind[]
}

/** builtin material ids the generators fall back to when an asset defines no slot material */
export function listFallbackMaterialIds(): string[] {
  return fallbackMaterialIds()
}

export { buildCurtain, clearGeometryCache, geometryCacheSize }
