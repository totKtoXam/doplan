/**
 * PlanSpec normalisation done by the CLI (before core sees the spec):
 *  1. px → mm with the spec scale (mmPerPx / calibration / labelled-area fit)
 *  2. orthogonal snap of near-axis polygon / wall-path edges
 *  3. merge near-coincident x and y coordinates across all rooms, walls and fixtures
 *  4. round to the grid (10 mm), snap wall thicknesses to the standard set
 */
import { DpError } from './output'
import { metricFactor, type Pt, pxToMm, resolveScale, type Scale, type SpecFixture, type SpecJson } from './spec'

export const STD_THICKNESS = [80, 100, 120, 150, 160, 180, 200, 250, 300, 380, 400, 510, 640]

export interface NormalizeOptions {
  /** override mm per px */
  mmPerPx?: number
  gridMm?: number
  orthoTolDeg?: number
  /** coordinates closer than this (mm) are merged */
  mergeMm?: number
  orthogonal?: boolean
}

export interface NormalizeReport {
  fromUnits: SpecJson['units']
  scale?: Scale
  gridMm: number
  mergeMm: number
  orthoSnapped: number
  merged: number
  maxShiftMm: number
  thicknessSnapped: number
  nonOrthoEdges: number
}

const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number'

class UnionFind {
  private p: number[] = []
  add(): number {
    this.p.push(this.p.length)
    return this.p.length - 1
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]]
      i = this.p[i]
    }
    return i
  }
  union(a: number, b: number): void {
    this.p[this.find(a)] = this.find(b)
  }
}

/** coordinate slot referenced by a getter/setter */
interface Slot {
  get(): number
  set(v: number): void
}

function snapPolylineOrtho(pts: Pt[], closed: boolean, tolDeg: number): { snapped: number; nonOrtho: number } {
  const n = pts.length
  if (n < 2) return { snapped: 0, nonOrtho: 0 }
  const ux = new UnionFind()
  const uy = new UnionFind()
  for (let i = 0; i < n; i++) {
    ux.add()
    uy.add()
  }
  let snapped = 0
  let nonOrtho = 0
  const edges = closed ? n : n - 1
  const tan = Math.tan((tolDeg * Math.PI) / 180)
  for (let i = 0; i < edges; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const dx = Math.abs(b[0] - a[0])
    const dy = Math.abs(b[1] - a[1])
    if (dx === 0 && dy === 0) continue
    if (dy <= dx * tan) {
      if (dy > 0) snapped++
      uy.union(i, (i + 1) % n)
    } else if (dx <= dy * tan) {
      if (dx > 0) snapped++
      ux.union(i, (i + 1) % n)
    } else nonOrtho++
  }
  const avg = (uf: UnionFind, k: 0 | 1) => {
    const sums = new Map<number, { s: number; c: number }>()
    for (let i = 0; i < n; i++) {
      const r = uf.find(i)
      const e = sums.get(r) ?? { s: 0, c: 0 }
      e.s += pts[i][k]
      e.c++
      sums.set(r, e)
    }
    for (let i = 0; i < n; i++) {
      const e = sums.get(uf.find(i)) as { s: number; c: number }
      pts[i][k] = e.s / e.c
    }
  }
  avg(ux, 0)
  avg(uy, 1)
  return { snapped, nonOrtho }
}

/** cluster values whose spread is ≤ tol (complete-linkage on sorted values) and move them to the mean */
function mergeCoords(slots: Slot[], tol: number): { merged: number; maxShift: number } {
  if (slots.length === 0 || tol <= 0) return { merged: 0, maxShift: 0 }
  const items = slots.map((s) => ({ s, v: s.get() })).sort((a, b) => a.v - b.v)
  let merged = 0
  let maxShift = 0
  let i = 0
  while (i < items.length) {
    let j = i + 1
    while (j < items.length && items[j].v - items[i].v <= tol) j++
    if (j - i > 1) {
      const group = items.slice(i, j)
      const distinct = new Set(group.map((g) => g.v)).size
      if (distinct > 1) {
        const mean = group.reduce((a, g) => a + g.v, 0) / group.length
        for (const g of group) {
          const shift = Math.abs(g.v - mean)
          if (shift > 1e-9) merged++
          maxShift = Math.max(maxShift, shift)
          g.s.set(mean)
        }
      }
    }
    i = j
  }
  return { merged, maxShift }
}

const roundTo = (v: number, g: number) => Math.round(v / g) * g

export function snapThickness(t: number): number {
  let best = t
  let bd = Number.POSITIVE_INFINITY
  for (const s of STD_THICKNESS) {
    const d = Math.abs(s - t)
    if (d <= 15 && d < bd) {
      bd = d
      best = s
    }
  }
  return best
}

export function normalizeSpec(input: SpecJson, o: NormalizeOptions = {}): { spec: SpecJson; report: NormalizeReport } {
  const spec = structuredClone(input) as SpecJson
  const gridMm = o.gridMm ?? spec.snap?.gridMm ?? 10
  const tolDeg = o.orthoTolDeg ?? spec.snap?.orthoToleranceDeg ?? 3
  const mergeMm = o.mergeMm ?? 30
  const ortho = o.orthogonal ?? spec.snap?.orthogonal ?? true
  const report: NormalizeReport = {
    fromUnits: spec.units,
    gridMm,
    mergeMm,
    orthoSnapped: 0,
    merged: 0,
    maxShiftMm: 0,
    thicknessSnapped: 0,
    nonOrthoEdges: 0,
  }

  // 1. px / cm / m → mm
  if (spec.units !== 'mm') {
    const f = metricFactor(spec.units)
    const scale: Scale | null = f !== null ? { sx: f, sy: f, ox: 0, oy: 0, from: 'override' } : resolveScale(spec, o.mmPerPx)
    {
      if (!scale) {
        throw new DpError(
          'spec is in px but has no scale',
          1,
          'add source.calibration [{p1,p2,mm}] or source.mmPerPx, give rooms labelledArea (area fit), or pass --mm-per-px N (see: pnpm dp spec scale)',
        )
      }
      if (f === null) report.scale = scale
      const P = (p: Pt): Pt => {
        const [x, y] = pxToMm(scale, p)
        return [x, y, ...p.slice(2)]
      }
      const sAvg = (scale.sx + scale.sy) / 2
      for (const r of spec.rooms) {
        if (Array.isArray(r.rect) && r.rect.length === 4) {
          const [x, y] = pxToMm(scale, [r.rect[0], r.rect[1]])
          r.rect = [x, y, r.rect[2] * scale.sx, r.rect[3] * scale.sy]
        }
        if (Array.isArray(r.polygon)) r.polygon = r.polygon.map((p) => (isPt(p) ? P(p) : p))
        if (isPt(r.at)) r.at = P(r.at)
      }
      for (const w of spec.walls ?? []) if (Array.isArray(w.path)) w.path = w.path.map((p) => (isPt(p) ? P(p) : p))
      for (const op of spec.openings) {
        if (isPt(op.at)) op.at = P(op.at)
        if (typeof op.width === 'number') op.width *= sAvg
        if (typeof op.offset === 'number') op.offset *= sAvg
      }
      for (const f of fixtureLists(spec)) {
        if (Array.isArray(f.rect) && f.rect.length === 4) {
          const [x, y] = pxToMm(scale, [f.rect[0], f.rect[1]])
          f.rect = [x, y, f.rect[2] * scale.sx, f.rect[3] * scale.sy]
        }
        if (isPt(f.at)) f.at = P(f.at)
      }
      const wasPx = spec.units === 'px'
      spec.units = 'mm'
      if (wasPx) spec.source = {
        ...(spec.source ?? {}),
        mmPerPx: Math.round(scale.sx * 1e5) / 1e5,
        ...(Math.abs(scale.sx - scale.sy) > 1e-9 ? { mmPerPxY: Math.round(scale.sy * 1e5) / 1e5 } : {}),
        originPx: [scale.ox, scale.oy],
      }
    }
  }

  // 2. orthogonal snap of polygons and wall paths
  if (ortho) {
    for (const r of spec.rooms) {
      if (Array.isArray(r.polygon) && r.polygon.every(isPt)) {
        const s = snapPolylineOrtho(r.polygon, true, tolDeg)
        report.orthoSnapped += s.snapped
        report.nonOrthoEdges += s.nonOrtho
      }
    }
    for (const w of spec.walls ?? []) {
      if (Array.isArray(w.path) && w.path.every(isPt)) {
        const s = snapPolylineOrtho(w.path, !!w.closed, tolDeg)
        report.orthoSnapped += s.snapped
        report.nonOrthoEdges += s.nonOrtho
      }
    }
  }

  // 3. merge near-coincident coordinates (rect edges, polygon vertices, wall vertices, fixture rects)
  const xs: Slot[] = []
  const ys: Slot[] = []
  const rectSlots = (rect: number[]) => {
    // edges as independent slots; w/h recomputed from them (tiny rects keep their size)
    if (Math.abs(rect[2]) <= 2 * mergeMm || Math.abs(rect[3]) <= 2 * mergeMm) return
    const e ={ x1: rect[0], y1: rect[1], x2: rect[0] + rect[2], y2: rect[1] + rect[3] }
    const sync = () => {
      rect[0] = e.x1
      rect[1] = e.y1
      rect[2] = e.x2 - e.x1
      rect[3] = e.y2 - e.y1
    }
    xs.push({ get: () => e.x1, set: (v) => ((e.x1 = v), sync()) }, { get: () => e.x2, set: (v) => ((e.x2 = v), sync()) })
    ys.push({ get: () => e.y1, set: (v) => ((e.y1 = v), sync()) }, { get: () => e.y2, set: (v) => ((e.y2 = v), sync()) })
  }
  const ptSlots = (p: Pt) => {
    xs.push({ get: () => p[0], set: (v) => (p[0] = v) })
    ys.push({ get: () => p[1], set: (v) => (p[1] = v) })
  }
  for (const r of spec.rooms) {
    if (Array.isArray(r.rect) && r.rect.length === 4) rectSlots(r.rect)
    if (Array.isArray(r.polygon)) for (const p of r.polygon) if (isPt(p)) ptSlots(p)
  }
  for (const w of spec.walls ?? []) if (Array.isArray(w.path)) for (const p of w.path) if (isPt(p)) ptSlots(p)
  for (const f of fixtureLists(spec)) if (Array.isArray(f.rect) && f.rect.length === 4) rectSlots(f.rect)
  const mx = mergeCoords(xs, mergeMm)
  const my = mergeCoords(ys, mergeMm)
  report.merged = mx.merged + my.merged
  report.maxShiftMm = Math.round(Math.max(mx.maxShift, my.maxShift))

  // 4. round to grid
  const g = gridMm > 0 ? gridMm : 1
  const rp = (p: Pt) => {
    p[0] = roundTo(p[0], g)
    p[1] = roundTo(p[1], g)
  }
  const rr = (rect: number[]) => {
    const x1 = roundTo(rect[0], g)
    const y1 = roundTo(rect[1], g)
    const x2 = roundTo(rect[0] + rect[2], g)
    const y2 = roundTo(rect[1] + rect[3], g)
    rect[0] = x1
    rect[1] = y1
    rect[2] = x2 - x1
    rect[3] = y2 - y1
  }
  for (const r of spec.rooms) {
    if (Array.isArray(r.rect) && r.rect.length === 4) rr(r.rect)
    if (Array.isArray(r.polygon)) for (const p of r.polygon) if (isPt(p)) rp(p)
    if (isPt(r.at)) rp(r.at)
    if (r.edgeWall && typeof r.edgeWall.thickness === 'number') {
      const t = snapThickness(r.edgeWall.thickness)
      if (t !== r.edgeWall.thickness) report.thicknessSnapped++
      r.edgeWall.thickness = t
    }
  }
  for (const w of spec.walls ?? []) {
    if (Array.isArray(w.path)) for (const p of w.path) if (isPt(p)) rp(p)
    if (typeof w.thickness === 'number') {
      const t = snapThickness(Math.round(w.thickness))
      if (t !== w.thickness) report.thicknessSnapped++
      w.thickness = t
    }
  }
  for (const op of spec.openings) {
    if (isPt(op.at)) rp(op.at)
    if (typeof op.width === 'number') op.width = roundTo(op.width, g)
    if (typeof op.offset === 'number') op.offset = roundTo(op.offset, g)
  }
  for (const f of fixtureLists(spec)) {
    if (Array.isArray(f.rect) && f.rect.length === 4) rr(f.rect)
    if (isPt(f.at)) rp(f.at)
  }
  // drop degenerate consecutive duplicate points created by snapping
  for (const r of spec.rooms) if (Array.isArray(r.polygon)) r.polygon = dedupePts(r.polygon, true)
  for (const w of spec.walls ?? []) if (Array.isArray(w.path)) w.path = dedupePts(w.path, !!w.closed)

  spec.snap = { ...(spec.snap ?? {}), gridMm }
  return { spec, report }
}

function dedupePts(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (q && isPt(p) && isPt(q) && q[0] === p[0] && q[1] === p[1]) continue
    out.push(p)
  }
  if (closed && out.length > 2) {
    const a = out[0]
    const b = out[out.length - 1]
    if (isPt(a) && isPt(b) && a[0] === b[0] && a[1] === b[1]) out.pop()
  }
  return out
}

/** `fixtures` plus its alias `furniture` */
function fixtureLists(spec: SpecJson): SpecFixture[] {
  const extra = Array.isArray(spec.furniture) ? (spec.furniture as SpecFixture[]) : []
  return [...(spec.fixtures ?? []), ...extra]
}
