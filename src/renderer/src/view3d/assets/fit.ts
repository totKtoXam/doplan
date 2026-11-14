/**
 * Pure helpers for fitting catalog models (no three.js import: shared with tools/assets/fetch.ts).
 *
 *  - `pickVariant`: Poly Haven "collection" models (pachira_aquatica_01_a … _d) place several
 *    variants side by side in one scene; a catalog item shows only the first one.
 *  - `fitScale`: per-axis scale that maps a model's bounding box onto an item size. When the catalog
 *    size of the asset contradicts the model's real proportions it falls back to a uniform scale, so a
 *    wrong catalog entry never distorts the model.
 */

export type Vec3 = [number, number, number]
export interface SizeMm {
  w: number
  d: number
  h: number
}
export interface NamedBox {
  name: string
  min: Vec3
  max: Vec3
}

const VARIANT_RE = /_([a-z])$/i

/**
 * Indices of the root nodes that form the first variant of a variant collection, or null when the
 * scene is one model. Two kinds of collections are recognised, and the kept variant must not overlap
 * the others in plan (x/z):
 *  - every root name ends with `_<letter>` and the letters are a, b, c… (at least three, so
 *    `door_l` / `door_r` never match): variant `a` is kept;
 *  - exactly two roots `<name>` and `<name>_<word>` of the same extents (exterior_aircon_unit +
 *    exterior_aircon_unit_rusted): `<name>` is kept. A lid, drawer or cloth overlaps its body.
 */
export function pickVariant(roots: NamedBox[]): number[] | null {
  if (roots.length === 2) {
    const [a, b] = roots
    const base = b.name.startsWith(`${a.name}_`) ? 0 : a.name.startsWith(`${b.name}_`) ? 1 : -1
    if (base < 0 || !a.name || !b.name) return null
    const ea = extent(a)
    const eb = extent(b)
    if (ea.some((v, k) => Math.abs(v - eb[k]) > 0.15 * Math.max(v, eb[k]))) return null
    return overlapsInPlan(a, b) ? null : [base]
  }
  if (roots.length < 3) return null
  const letters: string[] = []
  for (const r of roots) {
    const m = VARIANT_RE.exec(r.name)
    if (!m) return null
    letters.push(m[1].toLowerCase())
  }
  const distinct = [...new Set(letters)].sort()
  if (distinct.length < 3 || distinct.some((l, i) => l !== String.fromCharCode(97 + i))) return null
  const pick = letters.flatMap((l, i) => (l === 'a' ? [i] : []))
  const box = unionBox(pick.map((i) => roots[i]))
  for (let i = 0; i < roots.length; i++) if (letters[i] !== 'a' && overlapsInPlan(box, roots[i])) return null
  return pick
}

function extent(b: { min: Vec3; max: Vec3 }): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
}

function overlapsInPlan(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[2] < b.max[2] && b.min[2] < a.max[2]
}

export function unionBox(boxes: { min: Vec3; max: Vec3 }[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      if (b.min[k] < min[k]) min[k] = b.min[k]
      if (b.max[k] > max[k]) max[k] = b.max[k]
    }
  }
  return { min, max }
}

/** axes thinner than this (mm) carry no reliable proportion information (rugs, frames) */
const THIN_MM = 50
/** catalog proportions may differ from the model by this factor before they are distrusted */
export const ASPECT_TOLERANCE = 1.25

/**
 * How strongly the proportions of `size` (mm) disagree with a model box (`model`, metres, x/y/z =
 * w/h/d): max/min of the per-axis ratios over the axes that are not thin. 1 = same proportions.
 */
export function aspectMismatch(model: Vec3, size: SizeMm): number {
  const r = axisRatios(model, size).filter((v): v is number => v !== null)
  if (r.length < 2) return 1
  return Math.max(...r) / Math.min(...r)
}

function axisRatios(model: Vec3, size: SizeMm): (number | null)[] {
  const target = [size.w, size.h, size.d]
  return target.map((t, k) => {
    const m = model[k] * 1000
    return t >= THIN_MM && m >= THIN_MM ? t / m : null
  })
}

/**
 * Scale (x/y/z) applied to a model whose bounding box is `model` (metres) for an item of `item` size
 * (mm). Normally each axis is stretched to the item size. If the asset's catalog size (`catalog`)
 * disagrees with the model's proportions by more than ASPECT_TOLERANCE, the model is first scaled
 * uniformly to fit inside the catalog box and the item's own deviation from the catalog size (a user
 * resize) is applied on top of that.
 */
export function fitScale(model: Vec3, item: SizeMm, catalog?: SizeMm): { scale: Vec3; uniform: boolean; mismatch: number } {
  const perAxis = (s: SizeMm): Vec3 => [axis(s.w, model[0]), axis(s.h, model[1]), axis(s.d, model[2])]
  const mismatch = catalog ? aspectMismatch(model, catalog) : 1
  if (!catalog || mismatch <= ASPECT_TOLERANCE) return { scale: perAxis(item), uniform: false, mismatch }
  const ratios = axisRatios(model, catalog).filter((v): v is number => v !== null)
  const u = Math.min(...ratios)
  const rel = (i: number, c: number) => (c > 0 ? i / c : 1)
  return {
    scale: [u * rel(item.w, catalog.w), u * rel(item.h, catalog.h), u * rel(item.d, catalog.d)],
    uniform: true,
    mismatch,
  }
}

function axis(mm: number, m: number): number {
  return m > 1e-5 ? mm / 1000 / m : 1
}
