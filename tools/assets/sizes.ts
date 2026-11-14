/**
 * Default catalog sizes of model assets, derived from the glTF the app will actually load.
 *
 * Poly Haven's API `dimensions` (manifest `dimensionsM`, [x, y, z] Blender axes = w, d, h) describe the
 * whole source scene: for variant collections (pachira_aquatica_01: four plants in a row) that is the
 * row, not one plant, and for some models the horizontal axes are swapped relative to the glTF.
 * So the size comes from the glTF node bounds (first variant only, matching the 3D loader), and
 * `dimensionsM` is only used to repair the unit scale of models exported at a wrong scale.
 */
import { pickVariant, unionBox, type NamedBox, type Vec3 } from '../../src/renderer/src/view3d/assets/fit'

export type SizeMm = { w: number; d: number; h: number }

type Mat4 = number[]
const I4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]
}

export interface GltfJson {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { name?: string; children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  meshes?: { primitives: { attributes: Record<string, number> }[] }[]
  accessors?: { min?: number[]; max?: number[] }[]
}

/** world-space bounds of every scene root node (roots without geometry are left out) */
export function gltfRootBoxes(g: GltfJson): NamedBox[] {
  const out: NamedBox[] = []
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i)
  for (const r of roots) {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    const visit = (ni: number, parent: Mat4, depth: number) => {
      if (depth > 64) return
      const n = g.nodes?.[ni]
      if (!n) return
      const m = mul(parent, n.matrix && n.matrix.length === 16 ? n.matrix : trs(n.translation, n.rotation, n.scale))
      if (n.mesh !== undefined) {
        for (const p of g.meshes?.[n.mesh]?.primitives ?? []) {
          const acc = g.accessors?.[p.attributes.POSITION]
          if (!acc?.min || !acc.max) continue
          for (let c = 0; c < 8; c++) {
            const v = [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]]
            for (let k = 0; k < 3; k++) {
              const w = m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]
              if (w < lo[k]) lo[k] = w
              if (w > hi[k]) hi[k] = w
            }
          }
        }
      }
      for (const c of n.children ?? []) visit(c, m, depth + 1)
    }
    visit(r, I4, 0)
    if (lo.every(Number.isFinite) && hi.every(Number.isFinite)) out.push({ name: g.nodes?.[r]?.name ?? '', min: lo, max: hi })
  }
  return out
}

/** glTF extents (metres, x/y/z) of the whole scene and of the part the app shows (first variant) */
export function gltfExtents(g: GltfJson): { full: Vec3; shown: Vec3; variant: boolean } | null {
  const boxes = gltfRootBoxes(g)
  if (!boxes.length) return null
  const ext = (b: { min: Vec3; max: Vec3 }): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
  const full = ext(unionBox(boxes))
  const pick = pickVariant(boxes)
  return { full, shown: pick ? ext(unionBox(pick.map((i) => boxes[i]))) : full, variant: !!pick }
}

/**
 * Catalog size (mm) from glTF extents. `dimensionsM` (Poly Haven, whole scene, w/d/h) repairs models
 * exported at a wrong unit scale (steel_frame_shelves_01 is 10× too large); `unitScale` converts
 * stylised game units (KayKit).
 */
export function sizeFromGltf(ext: { full: Vec3; shown: Vec3 }, dimensionsM?: [number, number, number], unitScale = 1): SizeMm | null {
  if (!ext.full.every((v) => v > 1e-6 && v < 1000)) return null
  let k = unitScale
  if (dimensionsM) {
    const ratio = Math.max(...dimensionsM) / Math.max(...ext.full)
    if (ratio < 0.5 || ratio > 2) k = ratio
  }
  return { w: Math.round(ext.shown[0] * k * 1000), d: Math.round(ext.shown[2] * k * 1000), h: Math.round(ext.shown[1] * k * 1000) }
}

/** upper bounds (mm) of a believable default size per manifest category: [max footprint side, max height] */
const PLAUSIBLE: Record<string, [number, number]> = {
  chair: [900, 1400], stool: [700, 1000], armchair: [1300, 1400], ottoman: [1300, 700], bench: [2200, 1200],
  sofa: [3500, 1300], plant: [1500, 2500], 'lamp-table': [700, 1000], 'lamp-floor': [1500, 2200],
  'lamp-wall': [700, 1000], 'lamp-ceiling': [1600, 1600], 'side-table': [800, 900], 'coffee-table': [1800, 700],
  table: [3200, 1100], desk: [2400, 1000], bed: [2400, 1800], nightstand: [800, 900], sideboard: [2600, 1400],
  wardrobe: [3000, 3000], shelf: [2500, 2600], decor: [1200, 1200], 'decor-wall': [2000, 2000], kitchenware: [1000, 600],
  tv: [2000, 1300], textile: [1200, 800], rug: [4000, 100],
}

/** human-readable problem with a default size, or null when it looks plausible */
export function implausibleSize(category: string, s: SizeMm): string | null {
  const [side, height] = PLAUSIBLE[category] ?? [4000, 3000]
  if (Math.max(s.w, s.d) > side) return `footprint ${s.w}×${s.d} mm > ${side} mm for ${category}`
  if (s.h > height) return `height ${s.h} mm > ${height} mm for ${category}`
  return null
}
