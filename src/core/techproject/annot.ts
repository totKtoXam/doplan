/**
 * Drawing helpers of the album in WORLD millimetres laid out for 1:S (sizes given in paper mm × S):
 * dimension lines, markers, leaders, tile layouts clipped to a room outline.
 */
import type { DisplayItem, DisplayLayer, DlPen } from '../display'
import type { Vec2 } from '../types'

const V = (x: number, y: number): Vec2 => ({ x, y })
const sub = (a: Vec2, b: Vec2) => V(a.x - b.x, a.y - b.y)
const add = (a: Vec2, b: Vec2) => V(a.x + b.x, a.y + b.y)
const mul = (a: Vec2, s: number) => V(a.x * s, a.y * s)
const len = (a: Vec2) => Math.hypot(a.x, a.y)
const norm = (a: Vec2) => {
  const l = len(a)
  return l > 1e-9 ? V(a.x / l, a.y / l) : V(1, 0)
}

export const DIM_COLOR = '#333333'

export function fmtMm(mm: number): string {
  return String(Math.round(mm))
}

export function fmtM2(m2: number): string {
  return `${m2.toFixed(2).replace('.', ',')} м²`
}

export function fmtNum(v: number, d = 2): string {
  const k = 10 ** d
  return String(Math.round(v * k) / k).replace('.', ',')
}

/** «+2,700» — a level mark in metres */
export function fmtLevel(mm: number): string {
  const s = (mm / 1000).toFixed(3).replace('.', ',')
  return mm > 0 ? `+${s}` : mm < 0 ? s : `±${s.replace('-', '')}`
}

/** Dimension between a and b, the dimension line offset by `off` along the left normal (dy, -dx). */
export function dim(a: Vec2, b: Vec2, off: number, S: number, opts: { layer?: DisplayLayer; color?: string; text?: string; role?: string } = {}): DisplayItem[] {
  const out: DisplayItem[] = []
  const L = len(sub(b, a))
  if (L < 1) return out
  const layer = opts.layer ?? 'dimensions'
  const role = opts.role ?? 'tp-dim'
  const d = norm(sub(b, a))
  const n = V(d.y, -d.x)
  const sg = off >= 0 ? 1 : -1
  const a2 = add(a, mul(n, off))
  const b2 = add(b, mul(n, off))
  const pen: DlPen = { color: opts.color ?? DIM_COLOR, width: 0.13 }
  const over = 1 * S
  out.push({ t: 'line', layer, role, a: sub(a2, mul(d, over)), b: add(b2, mul(d, over)), stroke: pen })
  const gap = Math.min(1 * S, Math.abs(off) * 0.3)
  if (Math.abs(off) > gap + 1) {
    for (const p of [a, b]) out.push({ t: 'line', layer, role, a: add(p, mul(n, sg * gap)), b: add(p, mul(n, off + sg * S)), stroke: pen })
  }
  const tick = mul(norm(add(d, n)), 1.1 * S)
  for (const p of [a2, b2]) out.push({ t: 'line', layer, role, a: sub(p, tick), b: add(p, tick), stroke: { ...pen, width: 0.3 } })
  const size = 2 * S
  let rot = (Math.atan2(d.y, d.x) * 180) / Math.PI
  if (rot > 90.01) rot -= 180
  if (rot <= -90.01) rot += 180
  const mid = mul(add(a2, b2), 0.5)
  out.push({
    t: 'text',
    layer,
    role: `${role}-text`,
    p: add(mid, mul(n, sg * size * 0.75)),
    text: opts.text ?? fmtMm(L),
    size,
    rot,
    anchor: 'middle',
    baseline: 'middle',
    color: opts.color ?? DIM_COLOR,
  })
  return out
}

/** Dimension chain through sorted positions along one axis. */
export function dimChain(points: Vec2[], off: number, S: number, opts: { layer?: DisplayLayer; color?: string } = {}): DisplayItem[] {
  const out: DisplayItem[] = []
  for (let i = 0; i + 1 < points.length; i++) out.push(...dim(points[i], points[i + 1], off, S, opts))
  return out
}

/** A numbered position marker (circle with a number), paper radius 2.2 mm. */
export function marker(c: Vec2, label: string, S: number, opts: { layer?: DisplayLayer; color?: string; fill?: string } = {}): DisplayItem[] {
  const layer = opts.layer ?? 'annotations'
  const color = opts.color ?? '#111111'
  const r = (label.length > 2 ? 2.8 : 2.2) * S
  return [
    { t: 'circle', layer, role: 'tp-marker', c, r, stroke: { color, width: 0.2 }, fill: { color: opts.fill ?? '#ffffff' } },
    { t: 'text', layer, role: 'tp-marker', p: c, text: label, size: (label.length > 2 ? 2 : 2.4) * S, rot: 0, anchor: 'middle', baseline: 'middle', color },
  ]
}

export function label(p: Vec2, s: string, sizePaper: number, S: number, opts: { layer?: DisplayLayer; color?: string; bold?: boolean; anchor?: 'start' | 'middle' | 'end'; rot?: number; role?: string } = {}): DisplayItem {
  return {
    t: 'text',
    layer: opts.layer ?? 'annotations',
    role: opts.role ?? 'tp-label',
    p,
    text: s,
    size: sizePaper * S,
    rot: opts.rot ?? 0,
    anchor: opts.anchor ?? 'middle',
    baseline: 'middle',
    color: opts.color ?? '#111111',
    bold: opts.bold,
  }
}

/** An arrow from a to b (paper head size 2.5 mm). */
export function arrow(a: Vec2, b: Vec2, S: number, pen: DlPen, layer: DisplayLayer = 'annotations'): DisplayItem[] {
  const d = norm(sub(b, a))
  const n = V(-d.y, d.x)
  const h = 2.5 * S
  const base = sub(b, mul(d, h))
  return [
    { t: 'line', layer, role: 'tp-arrow', a, b: base, stroke: pen },
    { t: 'poly', layer, role: 'tp-arrow', pts: [b, add(base, mul(n, h * 0.35)), sub(base, mul(n, h * 0.35))], closed: true, stroke: pen, fill: { color: pen.color } },
  ]
}

// ───────────────────────────── polygons ─────────────────────────────

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function polyBounds(poly: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/** Inside parts of segment a–b against an outline with holes (even-odd), as [t0, t1] parameter spans. */
export function clipSegment(a: Vec2, b: Vec2, rings: Vec2[][]): [number, number][] {
  const ts: number[] = [0, 1]
  const d = sub(b, a)
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j]
      const q = ring[i]
      const e = sub(q, p)
      const den = d.x * e.y - d.y * e.x
      if (Math.abs(den) < 1e-12) continue
      const w = sub(p, a)
      const t = (w.x * e.y - w.y * e.x) / den
      const u = (w.x * d.y - w.y * d.x) / den
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
    }
  }
  ts.sort((x, y) => x - y)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]
    const t1 = ts[i + 1]
    if (t1 - t0 < 1e-6) continue
    const m = add(a, mul(d, (t0 + t1) / 2))
    let inside = false
    for (const ring of rings) if (pointInPoly(m, ring)) inside = !inside
    if (inside) {
      const last = out[out.length - 1]
      if (last && Math.abs(last[1] - t0) < 1e-9) last[1] = t1
      else out.push([t0, t1])
    }
  }
  return out
}

export function clippedLine(a: Vec2, b: Vec2, rings: Vec2[][], pen: DlPen, layer: DisplayLayer, role: string): DisplayItem[] {
  const d = sub(b, a)
  return clipSegment(a, b, rings).map(([t0, t1]) => ({ t: 'line', layer, role, a: add(a, mul(d, t0)), b: add(a, mul(d, t1)), stroke: pen }) as DisplayItem)
}

export type LayoutKind = 'grid' | 'brick' | 'brickThird' | 'planks' | 'diagonal'

/**
 * Joint lines of a straight tile / plank layout over an outline (outer ring + holes):
 * tiles `tw` × `th` mm (tw along the layout's x), rotated by `rotDeg`, the first full tile at `origin`.
 * Rows of `brick` / `brickThird` / `planks` are offset by ½ / ⅓ / ⅓ of a tile.
 */
export function tileJoints(
  rings: Vec2[][],
  origin: Vec2,
  tw: number,
  th: number,
  rotDeg: number,
  kind: LayoutKind,
  pen: DlPen,
  layer: DisplayLayer = 'rooms',
  maxLines = 4000,
): DisplayItem[] {
  const out: DisplayItem[] = []
  if (!(tw > 1 && th > 1) || !rings.length) return out
  const rot = ((rotDeg + (kind === 'diagonal' ? 45 : 0)) * Math.PI) / 180
  const ux = V(Math.cos(rot), Math.sin(rot))
  const uy = V(-Math.sin(rot), Math.cos(rot))
  // outline extent in layout coordinates
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of rings[0]) {
    const r = sub(p, origin)
    const u = r.x * ux.x + r.y * ux.y
    const v = r.x * uy.x + r.y * uy.y
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  const W = (u: number, v: number) => add(origin, add(mul(ux, u), mul(uy, v)))
  const j0 = Math.floor(v0 / th)
  const j1 = Math.ceil(v1 / th)
  const i0 = Math.floor(u0 / tw)
  const i1 = Math.ceil(u1 / tw)
  if ((j1 - j0) * (i1 - i0 + 2) > maxLines) return out
  // row joints (along u)
  for (let j = j0; j <= j1; j++) out.push(...clippedLine(W(u0 - tw, j * th), W(u1 + tw, j * th), rings, pen, layer, 'tp-tile'))
  if (kind === 'grid' || kind === 'diagonal') {
    for (let i = i0; i <= i1; i++) out.push(...clippedLine(W(i * tw, v0 - th), W(i * tw, v1 + th), rings, pen, layer, 'tp-tile'))
    return out
  }
  // staggered: the head joints of each row, shifted
  const k = kind === 'brick' ? 2 : 3
  for (let j = j0; j < j1; j++) {
    const shift = ((((j % k) + k) % k) * tw) / k
    for (let i = i0 - 1; i <= i1; i++) {
      const u = i * tw + shift
      if (u < u0 - 1 || u > u1 + 1) continue
      out.push(...clippedLine(W(u, j * th), W(u, (j + 1) * th), rings, pen, layer, 'tp-tile'))
    }
  }
  return out
}
