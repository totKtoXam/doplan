/**
 * Display list — the single source of every non-interactive drawing of the plan
 * (SVG / PDF / PNG export, DXF, Canvas2D renders in the CLI).
 *
 * Coordinates are WORLD millimetres (plan space, x → right, y → down).
 * Pen widths, dash lengths and hatch spacings are PAPER millimetres (backends multiply them by
 * `DisplayList.scale`), text sizes are WORLD millimetres (already laid out for `scale`).
 * Arc angles are degrees in plan space (atan2 with y down, i.e. clockwise on screen) and an
 * arc sweeps from `a0` to `a1` in increasing-angle direction (a1 > a0).
 *
 * Pure TS: no DOM / Node imports.
 */
import type { Asset, Catalog, DerivedPlan, Doc, EntityRef, Id, Item, Light, Opening, Vec2, Wall, WallGeom } from './types'
import { BUILTIN_ASSETS, ROOM_TYPE_NAMES } from './defaults'
import { derivePlan } from './derive'
import { visibleDoc, visiblePlan } from './layers'

// ───────────────────────────── types ─────────────────────────────

export type DisplayLayer =
  | 'grid'
  | 'rooms'
  | 'furniture'
  | 'walls'
  | 'openings'
  | 'lights'
  | 'text'
  | 'dimensions'
  | 'annotations'
  | 'sheet'

export interface DlPen {
  color: string
  /** paper mm */
  width: number
  /** paper mm, alternating dash/gap */
  dash?: number[]
}

export interface DlHatch {
  color: string
  /** degrees */
  angle: number
  /** paper mm between hatch lines */
  spacing: number
  /** paper mm line width */
  width: number
}

export interface DlFill {
  color: string
  opacity?: number
  hatch?: DlHatch
}

interface DlBase {
  layer: DisplayLayer
  /** finer classification, e.g. 'wall-fill', 'wall-outline', 'room-name', 'room-area', 'dim-text' */
  role?: string
  ref?: EntityRef
}

export type DisplayItem =
  | (DlBase & { t: 'poly'; pts: Vec2[]; holes?: Vec2[][]; closed: boolean; stroke?: DlPen; fill?: DlFill })
  | (DlBase & { t: 'line'; a: Vec2; b: Vec2; stroke: DlPen })
  | (DlBase & { t: 'arc'; c: Vec2; r: number; a0: number; a1: number; stroke: DlPen })
  | (DlBase & { t: 'circle'; c: Vec2; r: number; stroke?: DlPen; fill?: DlFill })
  | (DlBase & {
      t: 'text'
      p: Vec2
      text: string
      /** world mm (cap-to-baseline font size) */
      size: number
      /** degrees clockwise */
      rot: number
      anchor: 'start' | 'middle' | 'end'
      baseline: 'middle' | 'alphabetic'
      color: string
      bold?: boolean
    })

export interface DisplayBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface DisplayList {
  bounds: DisplayBounds
  items: DisplayItem[]
  /** drawing scale 1:scale the annotations were laid out for */
  scale: number
  theme: DisplayThemeName
  background: string
}

export type DisplayThemeName = 'light' | 'blueprint'

export interface TitleBlockInfo {
  title?: string
  subtitle?: string
  author?: string
  date?: string
  sheet?: string
}

export interface DisplayOptions {
  /** auto dimension chains (outer + inner); default doc.settings.showDimensions */
  dimensions?: boolean
  /** room area labels; default doc.settings.showAreas */
  areas?: boolean
  /** furniture footprints; default doc.settings.showFurniture2d */
  furniture?: boolean
  /** room names + free labels; default true */
  labels?: boolean
  /** 1 m grid; default false */
  grid?: boolean
  /** title block below the drawing; default false */
  titleBlock?: boolean | TitleBlockInfo
  theme?: DisplayThemeName
  // ── extensions ──
  /** drawing scale 1:scale used for annotation sizes; default 100 */
  scale?: number
  lang?: 'ru' | 'en'
  /** light fixtures; default true */
  lights?: boolean
  /** default true */
  northArrow?: boolean
  /** default true */
  scaleBar?: boolean
  /** default = dimensions */
  innerDimensions?: boolean
  /** default = dimensions */
  outerDimensions?: boolean
  /** manual dimensions from doc.dimensions; default true */
  manualDimensions?: boolean
  /** catalog for asset lookups (furniture symbols) */
  catalog?: Catalog
  /** precomputed derived plan of this level (skips derivePlan) */
  derived?: DerivedPlan
  /** draw objects hidden in the layers panel too; default false (hidden objects are not exported) */
  includeHidden?: boolean
}

interface DisplayTheme {
  bg: string
  roomFill: string
  outdoorFill: string
  wallFill: string
  partitionFill: string
  partitionHatch: string
  parapetFill: string
  stroke: string
  opening: string
  glass: string
  furniture: string
  furnitureFill: string | null
  light: string
  dim: string
  text: string
  muted: string
  grid: string
}

export const DISPLAY_THEMES: Record<DisplayThemeName, DisplayTheme> = {
  light: {
    bg: '#ffffff',
    roomFill: '#fbfaf7',
    outdoorFill: '#eef3f7',
    wallFill: '#2b2b2b',
    partitionFill: '#e2e2e2',
    partitionHatch: '#5f5f5f',
    parapetFill: '#ffffff',
    stroke: '#111111',
    opening: '#1a1a1a',
    glass: '#2f7fc1',
    furniture: '#6a6a6a',
    furnitureFill: '#ffffff',
    light: '#b7791f',
    dim: '#333333',
    text: '#111111',
    muted: '#555555',
    grid: '#ececec',
  },
  blueprint: {
    bg: '#0e3a66',
    roomFill: '#0f406f',
    outdoorFill: '#134a7c',
    wallFill: '#e8f1ff',
    partitionFill: '#0e3a66',
    partitionHatch: '#e8f1ff',
    parapetFill: '#0e3a66',
    stroke: '#ffffff',
    opening: '#ffffff',
    glass: '#9fd3ff',
    furniture: '#a8c5ee',
    furnitureFill: null,
    light: '#ffd166',
    dim: '#cfe2ff',
    text: '#ffffff',
    muted: '#cfe2ff',
    grid: '#1a4c80',
  },
}

// ───────────────────────────── small math ─────────────────────────────

const V = (x: number, y: number): Vec2 => ({ x, y })
const vAdd = (a: Vec2, b: Vec2): Vec2 => V(a.x + b.x, a.y + b.y)
const vSub = (a: Vec2, b: Vec2): Vec2 => V(a.x - b.x, a.y - b.y)
const vMul = (a: Vec2, s: number): Vec2 => V(a.x * s, a.y * s)
const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const vLen = (a: Vec2): number => Math.hypot(a.x, a.y)
const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
const vNorm = (a: Vec2): Vec2 => {
  const l = vLen(a)
  return l > 1e-12 ? V(a.x / l, a.y / l) : V(1, 0)
}
const deg = (v: Vec2): number => (Math.atan2(v.y, v.x) * 180) / Math.PI

function signedArea(poly: Vec2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function clipHalf(poly: Vec2[], f: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const fp = f(p)
    const fq = f(q)
    if (fp >= 0) out.push(p)
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq)
      out.push(V(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t))
    }
  }
  return out.filter((p, i) => vDist(p, out[(i + 1) % out.length]) > 0.01)
}

/** drop vertices on straight runs */
function simplifyCollinear(poly: Vec2[]): Vec2[] {
  if (poly.length <= 3) return poly
  const out: Vec2[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]
    const cur = poly[i]
    const next = poly[(i + 1) % n]
    if (vDist(prev, cur) < 0.5) continue
    const a = vNorm(vSub(cur, prev))
    const b = vNorm(vSub(next, cur))
    if (Math.abs(a.x * b.y - a.y * b.x) < 1e-4 && vDot(a, b) > 0) continue
    out.push(cur)
  }
  return out.length >= 3 ? out : poly
}

/** rotate local (x, y) by `rotDeg` (clockwise on screen) and translate */
function xf(c: Vec2, rotDeg: number, mirror: boolean): (p: Vec2) => Vec2 {
  const r = (rotDeg * Math.PI) / 180
  const cs = Math.cos(r)
  const sn = Math.sin(r)
  return (p) => {
    const x = mirror ? -p.x : p.x
    return V(c.x + x * cs - p.y * sn, c.y + x * sn + p.y * cs)
  }
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 28): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push(V(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry))
  }
  return out
}

function rectPts(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [V(x0, y0), V(x1, y0), V(x1, y1), V(x0, y1)]
}

function roundedRectPts(x0: number, y0: number, x1: number, y1: number, r: number): Vec2[] {
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2))
  if (rr < 1) return rectPts(x0, y0, x1, y1)
  const out: Vec2[] = []
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = ((a0 + (i / 6) * 90) * Math.PI) / 180
      out.push(V(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr))
    }
  }
  corner(x1 - rr, y0 + rr, 270)
  corner(x1 - rr, y1 - rr, 0)
  corner(x0 + rr, y1 - rr, 90)
  corner(x0 + rr, y0 + rr, 180)
  return out
}

export function estimateTextWidth(text: string, size: number): number {
  return text.length * size * 0.56
}

// ───────────────────────────── formatting ─────────────────────────────

function fmtLength(mm: number, units: 'mm' | 'cm' | 'm', lang: 'ru' | 'en'): string {
  let s: string
  if (units === 'm') s = (mm / 1000).toFixed(2)
  else if (units === 'cm') {
    const v = Math.round(mm) / 10
    s = Number.isInteger(v) ? String(v) : v.toFixed(1)
  } else s = String(Math.round(mm))
  return lang === 'ru' ? s.replace('.', ',') : s
}

function fmtArea(m2: number, lang: 'ru' | 'en'): string {
  const s = m2.toFixed(2)
  return lang === 'ru' ? `${s.replace('.', ',')} м²` : `${s} m²`
}

// ───────────────────────────── builder ─────────────────────────────

type Ctx = {
  doc: Doc
  plan: DerivedPlan
  S: number
  th: DisplayTheme
  lang: 'ru' | 'en'
  units: 'mm' | 'cm' | 'm'
  items: DisplayItem[]
  /** every room of the level, hidden ones included (the total area does not change when a room is hidden) */
  allRooms?: DerivedPlan['rooms']
}

/** draws one object and tags the pieces it pushed without a ref with the object's ref (DXF user layers) */
function owned(ctx: Ctx, ref: EntityRef, draw: () => void): void {
  const start = ctx.items.length
  draw()
  for (let i = start; i < ctx.items.length; i++) if (!ctx.items[i].ref) ctx.items[i].ref = ref
}

/** dimension between a and b, dimension line offset by `off` along the left normal (dy, -dx) of a→b */
function pushDim(ctx: Ctx, a: Vec2, b: Vec2, off: number, role: string, opts: { extFrom?: number; ref?: EntityRef } = {}): void {
  const { S, th, items } = ctx
  const L = vDist(a, b)
  if (L < 1) return
  const d = vNorm(vSub(b, a))
  const n = V(d.y, -d.x)
  const sg = off >= 0 ? 1 : -1
  const a2 = vAdd(a, vMul(n, off))
  const b2 = vAdd(b, vMul(n, off))
  const pen: DlPen = { color: th.dim, width: 0.13 }
  const over = 1 * S
  items.push({ t: 'line', layer: 'dimensions', role, a: vSub(a2, vMul(d, over)), b: vAdd(b2, vMul(d, over)), stroke: pen, ref: opts.ref })
  const gap = opts.extFrom ?? Math.min(1 * S, Math.abs(off) * 0.3)
  if (Math.abs(off) > gap + 1) {
    for (const p of [a, b]) {
      items.push({
        t: 'line',
        layer: 'dimensions',
        role,
        a: vAdd(p, vMul(n, sg * gap)),
        b: vAdd(p, vMul(n, off + sg * 1 * S)),
        stroke: pen,
      })
    }
  }
  const tick = vMul(vNorm(vAdd(d, n)), 1.2 * S)
  for (const p of [a2, b2]) items.push({ t: 'line', layer: 'dimensions', role, a: vSub(p, tick), b: vAdd(p, tick), stroke: { ...pen, width: 0.3 } })
  const size = 2.2 * S
  let rot = deg(d)
  if (rot > 90.01) rot -= 180
  if (rot <= -90.01) rot += 180
  const mid = vMul(vAdd(a2, b2), 0.5)
  items.push({
    t: 'text',
    layer: 'dimensions',
    role: 'dim-text',
    p: vAdd(mid, vMul(n, sg * size * 0.75)),
    text: fmtLength(L, ctx.units, ctx.lang),
    size,
    rot,
    anchor: 'middle',
    baseline: 'middle',
    color: th.dim,
  })
}

interface WallStyle {
  fill: DlFill | null
  pen: DlPen
}

function wallStyle(w: Wall, th: DisplayTheme): WallStyle {
  switch (w.kind) {
    case 'partition':
      return {
        fill: { color: th.partitionFill, hatch: { color: th.partitionHatch, angle: 45, spacing: 1.2, width: 0.13 } },
        pen: { color: th.stroke, width: 0.35 },
      }
    case 'parapet':
      return { fill: { color: th.parapetFill }, pen: { color: th.stroke, width: 0.25 } }
    case 'glazing':
      return { fill: null, pen: { color: th.glass, width: 0.25 } }
    case 'virtual':
      return { fill: null, pen: { color: th.muted, width: 0.13, dash: [1.5, 1] } }
    default:
      return { fill: { color: th.wallFill }, pen: { color: th.stroke, width: 0.5 } }
  }
}

interface Piece {
  pts: Vec2[]
  pen: DlPen
  id: number
}

function outlineOf(pieces: Piece[]): { a: Vec2; b: Vec2; pen: DlPen }[] {
  type E = { a: Vec2; b: Vec2; pen: DlPen; piece: number; x0: number; y0: number; x1: number; y1: number }
  const edges: E[] = []
  for (const pc of pieces) {
    const n = pc.pts.length
    for (let i = 0; i < n; i++) {
      const a = pc.pts[i]
      const b = pc.pts[(i + 1) % n]
      if (vDist(a, b) < 0.5) continue
      edges.push({
        a,
        b,
        pen: pc.pen,
        piece: pc.id,
        x0: Math.min(a.x, b.x) - 1,
        y0: Math.min(a.y, b.y) - 1,
        x1: Math.max(a.x, b.x) + 1,
        y1: Math.max(a.y, b.y) + 1,
      })
    }
  }
  const out: { a: Vec2; b: Vec2; pen: DlPen }[] = []
  for (const e of edges) {
    const L = vDist(e.a, e.b)
    const d = vMul(vSub(e.b, e.a), 1 / L)
    const n = V(-d.y, d.x)
    let parts: [number, number][] = [[0, L]]
    for (const f of edges) {
      if (f.piece === e.piece) continue
      if (f.x1 < e.x0 || f.x0 > e.x1 || f.y1 < e.y0 || f.y0 > e.y1) continue
      if (Math.abs(vDot(vSub(f.a, e.a), n)) > 0.5 || Math.abs(vDot(vSub(f.b, e.a), n)) > 0.5) continue
      const t0 = vDot(vSub(f.a, e.a), d)
      const t1 = vDot(vSub(f.b, e.a), d)
      const c0 = Math.min(t0, t1)
      const c1 = Math.max(t0, t1)
      const next: [number, number][] = []
      for (const [p0, p1] of parts) {
        if (c1 <= p0 || c0 >= p1) next.push([p0, p1])
        else {
          if (c0 > p0) next.push([p0, c0])
          if (c1 < p1) next.push([c1, p1])
        }
      }
      parts = next
      if (!parts.length) break
    }
    for (const [p0, p1] of parts) {
      if (p1 - p0 < 0.5) continue
      out.push({ a: vAdd(e.a, vMul(d, p0)), b: vAdd(e.a, vMul(d, p1)), pen: e.pen })
    }
  }
  return out
}

function wallFrame(g: WallGeom) {
  const d = vNorm(vSub(g.b, g.a))
  const n = V(d.y, -d.x)
  return { A: g.a, d, n, at: (u: number, v: number): Vec2 => vAdd(vAdd(g.a, vMul(d, u)), vMul(n, v)) }
}

function drawWalls(ctx: Ctx, levelWalls: Wall[], openingsByWall: Map<Id, Opening[]>): void {
  const { plan, th, items } = ctx
  const pieces: Piece[] = []
  let pid = 0
  for (const w of levelWalls) {
    const g = plan.wallGeoms[w.id]
    if (!g || g.length < 0.5) continue
    const st = wallStyle(w, th)
    const ref: EntityRef = { kind: 'wall', id: w.id }
    if (w.kind === 'virtual' || g.polygon.length < 3 || Math.abs(signedArea(g.polygon)) < 1) {
      items.push({ t: 'line', layer: 'walls', role: 'wall-virtual', a: g.a, b: g.b, stroke: st.pen, ref })
      continue
    }
    const F = wallFrame(g)
    const u = (p: Vec2) => vDot(vSub(p, F.A), F.d)
    const cuts = (openingsByWall.get(w.id) ?? [])
      .map((o) => [o.offset - o.width / 2, o.offset + o.width / 2] as [number, number])
      .sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const c of cuts) {
      const last = merged[merged.length - 1]
      if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1])
      else merged.push([c[0], c[1]])
    }
    const bounds: [number, number][] = []
    let lo = -Infinity
    for (const [c0, c1] of merged) {
      bounds.push([lo, c0])
      lo = c1
    }
    bounds.push([lo, Infinity])
    for (const [b0, b1] of bounds) {
      let poly = g.polygon
      if (Number.isFinite(b0)) poly = clipHalf(poly, (p) => u(p) - b0)
      if (Number.isFinite(b1) && poly.length) poly = clipHalf(poly, (p) => b1 - u(p))
      if (poly.length < 3 || Math.abs(signedArea(poly)) < 1) continue
      if (w.kind === 'glazing') {
        items.push({ t: 'poly', layer: 'walls', role: 'wall-glazing', pts: poly, closed: true, stroke: st.pen, fill: { color: th.bg, opacity: 0.6 }, ref })
        continue
      }
      if (st.fill) items.push({ t: 'poly', layer: 'walls', role: 'wall-fill', pts: poly, closed: true, fill: st.fill, ref })
      pieces.push({ pts: poly, pen: st.pen, id: pid++ })
    }
    if (w.kind === 'glazing') {
      const len = g.length
      const segs: [number, number][] = []
      let s = 0
      for (const [c0, c1] of merged) {
        if (c0 > s) segs.push([s, c0])
        s = Math.max(s, c1)
      }
      if (s < len) segs.push([s, len])
      for (const [s0, s1] of segs)
        items.push({ t: 'line', layer: 'walls', role: 'wall-glazing', a: F.at(s0, 0), b: F.at(s1, 0), stroke: { color: th.glass, width: 0.18 }, ref })
    }
  }
  for (const e of outlineOf(pieces)) items.push({ t: 'line', layer: 'walls', role: 'wall-outline', a: e.a, b: e.b, stroke: e.pen })
}

function interiorSign(ctx: Ctx, F: ReturnType<typeof wallFrame>, u: number, h: number): 1 | -1 | 0 {
  const probe = (s: number) => {
    const p = F.at(u, s * (h + 150))
    return ctx.plan.rooms.some((r) => pointInPoly(p, r.polygon))
  }
  const l = probe(1)
  const r = probe(-1)
  if (l && !r) return 1
  if (r && !l) return -1
  return 0
}

function drawOpenings(ctx: Ctx, levelWalls: Wall[], openingsByWall: Map<Id, Opening[]>): void {
  const { plan, th, items, S } = ctx
  const pen: DlPen = { color: th.opening, width: 0.25 }
  const thin: DlPen = { color: th.opening, width: 0.15 }
  const glass: DlPen = { color: th.glass, width: 0.18 }
  for (const w of levelWalls) {
    const g = plan.wallGeoms[w.id]
    if (!g) continue
    const F = wallFrame(g)
    const h = Math.max(w.thickness / 2, 1)
    for (const o of openingsByWall.get(w.id) ?? []) {
      const ref: EntityRef = { kind: 'opening', id: o.id }
      const u0 = o.offset - o.width / 2
      const u1 = o.offset + o.width / 2
      const s = o.swing === 'left' ? 1 : -1
      const line = (ua: number, va: number, ub: number, vb: number, p: DlPen, role = 'opening') =>
        items.push({ t: 'line', layer: 'openings', role, a: F.at(ua, va), b: F.at(ub, vb), stroke: p, ref })

      const windowLines = (a: number, b: number) => {
        line(a, -h, b, -h, pen)
        line(a, h, b, h, pen)
        line(a, 0, b, 0, glass, 'opening-glass')
        line(a, -h, a, h, thin)
        line(b, -h, b, h, thin)
      }
      const leaf = (hingeU: number, toward: 1 | -1, width: number, leafT: number, p: DlPen) => {
        const H = F.at(hingeU, s * h)
        const c = vMul(F.d, toward)
        const op = vMul(F.n, s)
        items.push({
          t: 'poly',
          layer: 'openings',
          role: 'door-leaf',
          pts: [H, vAdd(H, vMul(op, width)), vAdd(vAdd(H, vMul(op, width)), vMul(c, leafT)), vAdd(H, vMul(c, leafT))],
          closed: true,
          stroke: p,
          fill: { color: th.bg },
          ref,
        })
        const ac = deg(c)
        const ao = deg(op)
        let diff = ao - ac
        while (diff > 180) diff -= 360
        while (diff <= -180) diff += 360
        const [a0, a1] = diff > 0 ? [ac, ac + diff] : [ao, ao - diff]
        items.push({ t: 'arc', layer: 'openings', role: 'door-swing', c: H, r: width, a0, a1, stroke: thin, ref })
      }
      const hingeA = o.hinge === 'a'
      switch (o.kind) {
        case 'window':
        case 'frenchWindow': {
          windowLines(u0, u1)
          if (o.kind === 'frenchWindow') line(u0, -h * 0.4, u1, -h * 0.4, glass, 'opening-glass')
          const sb = o.sillBoard ?? 0
          if (sb > 0) {
            const side = interiorSign(ctx, F, o.offset, h)
            if (side !== 0) {
              const ext = 50
              items.push({
                t: 'poly',
                layer: 'openings',
                role: 'window-sill',
                pts: [F.at(u0 - ext, side * h), F.at(u1 + ext, side * h), F.at(u1 + ext, side * (h + sb)), F.at(u0 - ext, side * (h + sb))],
                closed: true,
                stroke: thin,
                ref,
              })
            }
          }
          break
        }
        case 'door':
        case 'entranceDoor':
        case 'balconyDoor': {
          const lt = o.kind === 'entranceDoor' ? Math.max(50, 0.6 * S) : Math.max(35, 0.4 * S)
          leaf(hingeA ? u0 : u1, hingeA ? 1 : -1, o.width, lt, o.kind === 'entranceDoor' ? { ...pen, width: 0.35 } : pen)
          if (o.kind === 'balconyDoor') line(u0, 0, u1, 0, glass, 'opening-glass')
          line(u0, -h, u0, h, thin)
          line(u1, -h, u1, h, thin)
          break
        }
        case 'doubleDoor': {
          const lt = Math.max(35, 0.4 * S)
          leaf(u0, 1, o.width / 2, lt, pen)
          leaf(u1, -1, o.width / 2, lt, pen)
          line(u0, -h, u0, h, thin)
          line(u1, -h, u1, h, thin)
          break
        }
        case 'slidingDoor': {
          const slide = o.slide ?? 'surface'
          const dirA = hingeA ? -1 : 1
          if (slide === 'pocket') {
            const sh = dirA * o.width * 0.3
            const t = Math.min(20, h * 0.4)
            const a = Math.max(u0, u0 + sh)
            const b = Math.min(u1, u1 + sh)
            line(a, -t, b, -t, pen)
            line(a, t, b, t, pen)
            const p0 = hingeA ? u0 : u1
            const p1 = p0 + dirA * o.width
            line(p0, -t - 6, p1, -t - 6, { ...thin, dash: [2, 1] })
            line(p0, t + 6, p1, t + 6, { ...thin, dash: [2, 1] })
            line(u0, -h, u0, h, thin)
            line(u1, -h, u1, h, thin)
            break
          }
          if (slide === 'barn') {
            const sh = dirA * o.width * 0.3
            const k0 = s * (h + 20)
            const k1 = s * (h + 55)
            const a = u0 - 50 + sh
            const b = u1 + 50 + sh
            items.push({ t: 'poly', layer: 'openings', role: 'door-leaf', pts: [F.at(a, k0), F.at(b, k0), F.at(b, k1), F.at(a, k1)], closed: true, stroke: pen, fill: { color: th.bg }, ref })
            const r0 = hingeA ? u0 - o.width - 100 : u0 - 100
            const r1 = hingeA ? u1 + 100 : u1 + o.width + 100
            line(r0, s * (h + 10), r1, s * (h + 10), { ...thin, dash: [2, 1] })
            line(u0, -h, u0, h, thin)
            line(u1, -h, u1, h, thin)
            break
          }
          if (slide === 'folding') {
            const n = o.width <= 700 ? 4 : o.width <= 1000 ? 6 : 8
            const pw = o.width / n
            const ang = 0.5
            let su = hingeA ? u0 : u1
            let k = -(pw * Math.sin(ang)) / 2
            for (let i = 0; i < n; i++) {
              const up = i % 2 === 0 ? 1 : -1
              const s2 = su - dirA * pw * Math.cos(ang)
              const k2 = k + up * pw * Math.sin(ang)
              line(su, k, s2, k2, pen)
              su = s2
              k = k2
            }
            line(u0, -h, u0, h, thin)
            line(u1, -h, u1, h, thin)
            break
          }
          const lw = o.width * 0.55
          const lt = Math.max(25, Math.min(h * 0.5, 0.35 * S))
          const v1 = h * 0.35
          items.push({
            t: 'poly',
            layer: 'openings',
            role: 'door-leaf',
            pts: [F.at(u0, v1 - lt / 2), F.at(u0 + lw, v1 - lt / 2), F.at(u0 + lw, v1 + lt / 2), F.at(u0, v1 + lt / 2)],
            closed: true,
            stroke: pen,
            fill: { color: th.bg },
            ref,
          })
          items.push({
            t: 'poly',
            layer: 'openings',
            role: 'door-leaf',
            pts: [F.at(u1 - lw, -v1 - lt / 2), F.at(u1, -v1 - lt / 2), F.at(u1, -v1 + lt / 2), F.at(u1 - lw, -v1 + lt / 2)],
            closed: true,
            stroke: pen,
            fill: { color: th.bg },
            ref,
          })
          // direction arrows
          const ah = Math.min(o.width * 0.12, 1.5 * S)
          line(o.offset - ah, v1 + lt + ah * 0.3, o.offset + ah, v1 + lt + ah * 0.3, thin)
          line(o.offset + ah, v1 + lt + ah * 0.3, o.offset + ah * 0.5, v1 + lt + ah * 0.6, thin)
          line(o.offset + ah, -v1 - lt - ah * 0.3, o.offset - ah, -v1 - lt - ah * 0.3, thin)
          line(o.offset - ah, -v1 - lt - ah * 0.3, o.offset - ah * 0.5, -v1 - lt - ah * 0.6, thin)
          line(u0, -h, u0, h, thin)
          line(u1, -h, u1, h, thin)
          break
        }
        case 'balconyBlock': {
          const dw = Math.min(800, o.width * 0.45)
          const lt = Math.max(35, 0.4 * S)
          if (hingeA) {
            leaf(u0, 1, dw, lt, pen)
            windowLines(u0 + dw, u1)
            line(u0, -h, u0, h, thin)
          } else {
            leaf(u1, -1, dw, lt, pen)
            windowLines(u0, u1 - dw)
            line(u1, -h, u1, h, thin)
          }
          break
        }
        case 'arch':
          line(u0, -h, u1, -h, { ...thin, dash: [2, 1] })
          line(u0, h, u1, h, { ...thin, dash: [2, 1] })
          break
        case 'opening':
          line(u0, -h, u1, -h, { ...thin, dash: [1, 1] })
          line(u0, h, u1, h, { ...thin, dash: [1, 1] })
          break
      }
    }
  }
}

function drawRoomLabels(ctx: Ctx, showNames: boolean, showAreas: boolean): void {
  const { doc, plan, S, th, items, lang } = ctx
  for (const r of plan.rooms) {
    const rec = doc.rooms[r.roomId]
    const name = rec ? rec.name || ROOM_TYPE_NAMES[rec.type][lang] : ''
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of r.polygon) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const roomW = maxX - minX
    const roomH = maxY - minY
    const fit = (text: string, size: number) => {
      const w = estimateTextWidth(text, size)
      return w > roomW * 0.9 ? Math.max(1.6 * S, (size * roomW * 0.9) / w) : size
    }
    const lines: { text: string; size: number; bold: boolean; role: string }[] = []
    if (showNames && name) lines.push({ text: name, size: fit(name, 3 * S), bold: true, role: 'room-name' })
    if (showAreas) {
      const a = fmtArea(r.area, lang)
      lines.push({ text: a, size: fit(a, 2.5 * S), bold: false, role: 'room-area' })
    }
    if (!lines.length) continue
    const total = lines.reduce((s, l) => s + l.size * 1.35, 0)
    if (total > roomH * 0.95 && lines.length > 1) lines.splice(0, 1)
    let y = r.labelPoint.y - (lines.reduce((s, l) => s + l.size * 1.35, 0) - lines[0].size * 1.35) / 2
    for (const l of lines) {
      items.push({
        t: 'text',
        layer: 'text',
        role: l.role,
        p: V(r.labelPoint.x, y),
        text: l.text,
        size: l.size,
        rot: 0,
        anchor: 'middle',
        baseline: 'middle',
        color: l.role === 'room-area' ? th.muted : th.text,
        bold: l.bold,
        ref: rec ? { kind: 'room', id: rec.id } : undefined,
      })
      y += l.size * 1.35
    }
  }
}

function drawInnerDims(ctx: Ctx): void {
  const { plan, S } = ctx
  for (const r of plan.rooms) {
    const poly = simplifyCollinear(r.polygon)
    if (poly.length < 3) continue
    let bx0 = Infinity
    let by0 = Infinity
    let bx1 = -Infinity
    let by1 = -Infinity
    for (const p of poly) {
      bx0 = Math.min(bx0, p.x)
      by0 = Math.min(by0, p.y)
      bx1 = Math.max(bx1, p.x)
      by1 = Math.max(by1, p.y)
    }
    // small rooms (wardrobes, balconies) would be cluttered: their sizes are on the outer chains / neighbours
    if (Math.min(bx1 - bx0, by1 - by0) < 1500) continue
    const A = signedArea(poly)
    const off = 2 * S
    const textSize = 2.2 * S
    // keep-out box around the room name + area label (same metrics as drawRoomLabels)
    const rec = ctx.doc.rooms[r.roomId]
    const name = rec ? rec.name || ROOM_TYPE_NAMES[rec.type][ctx.lang] : ''
    const labelHalfW = Math.min((bx1 - bx0) * 0.45, Math.max(estimateTextWidth(name, 3 * S), estimateTextWidth('00,00 м²', 2.5 * S)) / 2) + 0.8 * S
    const labelHalfH = ((3 * S + 2.5 * S) * 1.35) / 2 + 0.6 * S
    const lp = r.labelPoint
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const L = vDist(a, b)
      if (L < 400) continue
      const d = vNorm(vSub(b, a))
      // inward normal; pushDim offsets along (dy, -dx)
      const inward = A > 0 ? V(-d.y, d.x) : V(d.y, -d.x)
      const sign = vDot(inward, V(d.y, -d.x)) > 0 ? 1 : -1
      const probe = vAdd(vMul(vAdd(a, b), 0.5), vMul(inward, off + 2.2 * S))
      if (!pointInPoly(probe, r.polygon)) continue
      // the value must fit between the extension lines
      const tw = estimateTextWidth(fmtLength(L, ctx.units, ctx.lang), textSize)
      if (tw > L * 0.9) continue
      // skip dimensions whose text would collide with the room label
      const tc = vAdd(vMul(vAdd(a, b), 0.5), vMul(inward, off + textSize * 0.75))
      const hx = Math.abs(d.x) * (tw / 2) + Math.abs(d.y) * textSize * 0.6
      const hy = Math.abs(d.y) * (tw / 2) + Math.abs(d.x) * textSize * 0.6
      if (Math.abs(tc.x - lp.x) < hx + labelHalfW && Math.abs(tc.y - lp.y) < hy + labelHalfH) continue
      pushDim(ctx, a, b, sign * off, 'dim-inner', { extFrom: 0 })
    }
  }
}

function drawOuterDims(ctx: Ctx, levelWalls: Wall[], openingsByWall: Map<Id, Opening[]>): void {
  const { plan, S, th, items } = ctx
  const sidesWithRoom = new Map<Id, Set<'left' | 'right'>>()
  for (const r of plan.rooms) {
    for (const e of r.edges) {
      const s = sidesWithRoom.get(e.wallId) ?? new Set<'left' | 'right'>()
      s.add(e.side)
      sidesWithRoom.set(e.wallId, s)
    }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  type Face = { a: Vec2; b: Vec2; normal: Vec2; wall: Wall; side: 'left' | 'right' }
  const faces: Face[] = []
  for (const w of levelWalls) {
    const g = plan.wallGeoms[w.id]
    if (!g || w.kind === 'virtual') continue
    for (const p of g.polygon) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const F = wallFrame(g)
    const has = sidesWithRoom.get(w.id)
    if (!has?.has('left')) faces.push({ a: g.left[0], b: g.left[1], normal: F.n, wall: w, side: 'left' })
    if (!has?.has('right')) faces.push({ a: g.right[0], b: g.right[1], normal: vMul(F.n, -1), wall: w, side: 'right' })
  }
  // a face is exterior only if the space just outside it is neither a room nor another wall
  const solids = levelWalls
    .filter((w) => w.kind !== 'virtual' && plan.wallGeoms[w.id])
    .map((w) => ({ id: w.id, poly: plan.wallGeoms[w.id].polygon }))
  const isExposed = (f: Face): boolean => {
    if (vDist(f.a, f.b) < 20) return false
    const mid = vMul(vAdd(f.a, f.b), 0.5)
    const probe = vAdd(mid, vMul(f.normal, 25))
    if (plan.rooms.some((r) => pointInPoly(probe, r.polygon))) return false
    return !solids.some((s) => s.id !== f.wall.id && pointInPoly(probe, s.poly))
  }
  for (let i = faces.length - 1; i >= 0; i--) if (!isExposed(faces[i])) faces.splice(i, 1)
  if (!faces.length || !Number.isFinite(minX)) return
  const dirs: { D: Vec2; horizontal: boolean; edge: number; sign: 1 | -1 }[] = [
    { D: V(0, -1), horizontal: true, edge: minY, sign: -1 },
    { D: V(0, 1), horizontal: true, edge: maxY, sign: 1 },
    { D: V(-1, 0), horizontal: false, edge: minX, sign: -1 },
    { D: V(1, 0), horizontal: false, edge: maxX, sign: 1 },
  ]
  const pen: DlPen = { color: th.dim, width: 0.13 }
  const size = 2.2 * S
  for (const { D, horizontal, edge, sign } of dirs) {
    const fs = faces.filter((f) => vDot(f.normal, D) > 0.99)
    if (!fs.length) continue
    const coord = (p: Vec2) => (horizontal ? p.x : p.y)
    const row2: number[] = []
    const row1: number[] = []
    for (const f of fs) {
      row2.push(coord(f.a), coord(f.b))
      row1.push(coord(f.a), coord(f.b))
      const g = plan.wallGeoms[f.wall.id]
      const F = wallFrame(g)
      for (const o of openingsByWall.get(f.wall.id) ?? []) {
        const v = (f.side === 'left' ? 1 : -1) * (f.wall.thickness / 2)
        row1.push(coord(F.at(o.offset - o.width / 2, v)), coord(F.at(o.offset + o.width / 2, v)))
      }
    }
    const uniq = (arr: number[]) => {
      const s = arr.slice().sort((a, b) => a - b)
      const out: number[] = []
      for (const x of s) if (!out.length || x - out[out.length - 1] > 1) out.push(x)
      return out
    }
    const full = horizontal ? [minX, maxX] : [minY, maxY]
    const rows = [uniq(row1), uniq(row2), full]
    const distinct: number[][] = []
    for (const r of rows) {
      if (r.length < 2) continue
      const prev = distinct[distinct.length - 1]
      if (prev && prev.length === r.length && prev.every((x, i) => Math.abs(x - r[i]) < 1)) continue
      distinct.push(r)
    }
    distinct.forEach((pts, k) => {
      const lineC = edge + sign * (8 + k * 7) * S
      const P = (t: number, c: number): Vec2 => (horizontal ? V(t, c) : V(c, t))
      items.push({ t: 'line', layer: 'dimensions', role: 'dim-outer', a: P(pts[0] - S, lineC), b: P(pts[pts.length - 1] + S, lineC), stroke: pen })
      const extStart = edge + sign * 2 * S
      const extEnd = lineC + sign * S
      const tick = vMul(vNorm(horizontal ? V(1, -1) : V(1, -1)), 1.2 * S)
      for (const t of pts) {
        items.push({ t: 'line', layer: 'dimensions', role: 'dim-outer', a: P(t, extStart), b: P(t, extEnd), stroke: pen })
        const c = P(t, lineC)
        items.push({ t: 'line', layer: 'dimensions', role: 'dim-outer', a: vSub(c, tick), b: vAdd(c, tick), stroke: { ...pen, width: 0.3 } })
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const L = pts[i + 1] - pts[i]
        if (L < 1) continue
        const text = fmtLength(L, ctx.units, ctx.lang)
        const tw = estimateTextWidth(text, size)
        const crowded = tw > L * 0.95
        const last = pts.length - 2
        // short end segments: put the value outside the chain; short inner ones: stagger away from the line
        let along = (pts[i] + pts[i + 1]) / 2
        let off = sign * size * 0.75
        if (crowded && i === last && last > 0) along = pts[i + 1] + S + (tw * 0.85) / 2 + 0.5 * S
        else if (crowded && i === 0 && last > 0) along = pts[0] - S - (tw * 0.85) / 2 - 0.5 * S
        else if (crowded && i % 2 === 1) off = sign * size * 1.9
        items.push({
          t: 'text',
          layer: 'dimensions',
          role: 'dim-text',
          p: P(along, lineC + off),
          text,
          size: crowded ? size * 0.85 : size,
          rot: horizontal ? 0 : -90,
          anchor: 'middle',
          baseline: 'middle',
          color: th.dim,
        })
      }
    })
  }
}

function findAsset(doc: Doc, catalog: Catalog | undefined, id: Id): Asset | undefined {
  return doc.assets[id] ?? catalog?.assets.find((a) => a.id === id) ?? BUILTIN_ASSETS.find((a) => a.id === id)
}

function drawItem(ctx: Ctx, it: Item, asset: Asset | undefined): void {
  const { th, items, S } = ctx
  const w = it.size.w
  const d = it.size.d
  const T = xf(V(it.x, it.y), it.rotation, it.mirrored === true)
  const ref: EntityRef = { kind: 'item', id: it.id }
  const high = ((it.mount === 'wall' || it.mount === 'free') && it.elevation >= 1200) || it.mount === 'ceiling'
  const outlinePen: DlPen = { color: th.furniture, width: 0.18, dash: high ? [1.5, 1] : undefined }
  const detail: DlPen = { color: th.furniture, width: 0.13, dash: high ? [1.5, 1] : undefined }
  const fill: DlFill | undefined = th.furnitureFill && !high ? { color: th.furnitureFill } : undefined
  const poly = (pts: Vec2[], p: DlPen = detail, f?: DlFill, role = 'item-detail') =>
    items.push({ t: 'poly', layer: 'furniture', role, pts: pts.map(T), closed: true, stroke: p, fill: f, ref })
  const line = (x0: number, y0: number, x1: number, y1: number, p: DlPen = detail) =>
    items.push({ t: 'line', layer: 'furniture', role: 'item-detail', a: T(V(x0, y0)), b: T(V(x1, y1)), stroke: p, ref })
  const circle = (cx: number, cy: number, r: number, p: DlPen = detail, f?: DlFill) =>
    items.push({ t: 'circle', layer: 'furniture', role: 'item-detail', c: T(V(cx, cy)), r, stroke: p, fill: f, ref })
  const x0 = -w / 2
  const x1 = w / 2
  const y0 = -d / 2
  const y1 = d / 2
  const outline = () => poly(rectPts(x0, y0, x1, y1), outlinePen, fill, 'item-outline')
  const kind = asset?.procedural ?? asset?.category ?? 'box'
  const m = Math.min(w, d)
  switch (kind) {
    case 'bed': {
      outline()
      const pd = Math.min(400, d * 0.2)
      const n = w >= 1200 ? 2 : 1
      const gap = 60
      const pw = (w - gap * (n + 1)) / n
      for (let i = 0; i < n; i++) {
        const px = x0 + gap + i * (pw + gap)
        poly(roundedRectPts(px, y0 + gap, px + pw, y0 + gap + pd, 40))
      }
      const by = y0 + d * 0.35
      line(x0, by, x1, by)
      const f = m * 0.22
      line(x1 - f, by, x1, by + f)
      break
    }
    case 'sofa':
    case 'armchair': {
      outline()
      const back = d * 0.22
      const arm = Math.min(w * 0.12, 200)
      poly(rectPts(x0, y0, x1, y0 + back))
      poly(rectPts(x0, y0 + back, x0 + arm, y1))
      poly(rectPts(x1 - arm, y0 + back, x1, y1))
      const n = kind === 'armchair' ? 1 : w > 1700 ? 3 : 2
      const sw = (w - 2 * arm) / n
      for (let i = 1; i < n; i++) line(x0 + arm + i * sw, y0 + back, x0 + arm + i * sw, y1)
      break
    }
    case 'chair': {
      poly(roundedRectPts(x0, y0 + d * 0.12, x1, y1, m * 0.1), outlinePen, fill, 'item-outline')
      poly(rectPts(x0, y0, x1, y0 + d * 0.12))
      break
    }
    case 'table': {
      const round = it.params?.shape === 'round' || /кругл|round/i.test(`${it.name ?? ''} ${asset?.name ?? ''} ${asset?.nameRu ?? ''}`)
      if (round) poly(ellipsePts(0, 0, w / 2, d / 2, 36), outlinePen, fill, 'item-outline')
      else outline()
      break
    }
    case 'wardrobe': {
      outline()
      line(x0 + 40, 0, x1 - 40, 0, { ...detail, dash: [1.5, 1] })
      const n = Math.max(2, Math.round(w / 450))
      for (let i = 1; i < n; i++) line(x0 + (i * w) / n, y1 - 30, x0 + (i * w) / n, y1, detail)
      break
    }
    case 'shelf':
    case 'storage': {
      outline()
      line(x0, y1, x1, y0)
      break
    }
    case 'kitchenBase':
    case 'worktop':
    case 'kitchen': {
      outline()
      line(x0, y1 - 40, x1, y1 - 40)
      break
    }
    case 'kitchenWall':
    case 'hood':
    case 'airConditioner': {
      poly(rectPts(x0, y0, x1, y1), { ...outlinePen, dash: [1.5, 1] }, undefined, 'item-outline')
      line(x0, y0, x1, y1, { ...detail, dash: [1.5, 1] })
      line(x0, y1, x1, y0, { ...detail, dash: [1.5, 1] })
      break
    }
    case 'kitchenTall':
    case 'fridge': {
      outline()
      poly(rectPts(x0 + 40, y0 + 40, x1 - 40, y1 - 60))
      line(x0, y1 - 60, x1, y1 - 60)
      break
    }
    case 'stove': {
      outline()
      const r = m * 0.14
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) circle((sx * w) / 4, (sy * d) / 4, r)
      break
    }
    case 'oven':
    case 'dishwasher': {
      outline()
      line(x0, y1 - 60, x1, y1 - 60)
      line(x0 + w * 0.25, y1 - 30, x1 - w * 0.25, y1 - 30)
      break
    }
    case 'washingMachine':
    case 'appliance': {
      outline()
      circle(0, 0, m * 0.33)
      break
    }
    case 'sink': {
      outline()
      poly(roundedRectPts(x0 + w * 0.15, y0 + d * 0.15, x1 - w * 0.15, y1 - d * 0.15, m * 0.12))
      circle(0, 0, Math.min(25, m * 0.05))
      break
    }
    case 'washbasin': {
      outline()
      poly(ellipsePts(0, d * 0.05, w * 0.36, d * 0.32))
      circle(0, d * 0.05, Math.min(20, m * 0.05))
      break
    }
    case 'toilet': {
      const tank = d * 0.25
      poly(roundedRectPts(x0, y0, x1, y0 + tank, 30), outlinePen, fill, 'item-outline')
      const by = y0 + tank + (d - tank) / 2
      poly(ellipsePts(0, by, w * 0.45, ((d - tank) / 2) * 0.98), outlinePen, fill, 'item-outline')
      poly(ellipsePts(0, by + (d - tank) * 0.05, w * 0.3, ((d - tank) / 2) * 0.62))
      break
    }
    case 'bathtub': {
      outline()
      poly(roundedRectPts(x0 + 60, y0 + 60, x1 - 60, y1 - 60, m * 0.3))
      circle(x0 + Math.min(200, w * 0.15), 0, Math.min(25, m * 0.05))
      break
    }
    case 'shower': {
      outline()
      line(x0, y0, x1, y1)
      line(x0, y1, x1, y0)
      circle(0, 0, Math.min(40, m * 0.06))
      break
    }
    case 'bathroom': {
      outline()
      poly(roundedRectPts(x0 + w * 0.1, y0 + d * 0.1, x1 - w * 0.1, y1 - d * 0.1, m * 0.15))
      break
    }
    case 'radiator': {
      outline()
      const n = Math.max(2, Math.floor(w / 80))
      for (let i = 1; i < n; i++) line(x0 + (i * w) / n, y0, x0 + (i * w) / n, y1)
      break
    }
    case 'tv':
    case 'electronics': {
      outline()
      line(x0 + w * 0.05, y1 - Math.min(15, d * 0.3), x1 - w * 0.05, y1 - Math.min(15, d * 0.3))
      break
    }
    case 'rug':
    case 'textile': {
      poly(rectPts(x0, y0, x1, y1), { ...outlinePen, dash: [2, 1] }, undefined, 'item-outline')
      const inset = Math.min(80, m * 0.08)
      poly(rectPts(x0 + inset, y0 + inset, x1 - inset, y1 - inset), { ...detail, dash: [0.6, 0.8] })
      break
    }
    case 'mirror':
    case 'picture': {
      poly(rectPts(x0, y0, x1, y1), outlinePen, undefined, 'item-outline')
      break
    }
    case 'column':
    case 'structure': {
      poly(rectPts(x0, y0, x1, y1), { color: th.stroke, width: 0.35 }, { color: th.wallFill }, 'item-outline')
      line(x0, y0, x1, y1, { color: th.bg, width: 0.13 })
      line(x0, y1, x1, y0, { color: th.bg, width: 0.13 })
      break
    }
    case 'stairs': {
      outline()
      const tread = 280
      const n = Math.max(1, Math.floor(d / tread))
      for (let i = 1; i < n; i++) line(x0, y0 + i * tread, x1, y0 + i * tread)
      line(0, y1 - tread / 2, 0, y0 + tread / 2)
      line(0, y0 + tread / 2, -Math.min(w * 0.15, 120), y0 + tread / 2 + 150)
      line(0, y0 + tread / 2, Math.min(w * 0.15, 120), y0 + tread / 2 + 150)
      break
    }
    case 'plantPot':
    case 'plant': {
      poly(ellipsePts(0, 0, w / 2, d / 2), outlinePen, fill, 'item-outline')
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        line(0, 0, Math.cos(a) * w * 0.4, Math.sin(a) * d * 0.4)
      }
      break
    }
    case 'lighting': {
      poly(ellipsePts(0, 0, w / 2, d / 2), outlinePen, fill, 'item-outline')
      line(-w * 0.35, -d * 0.35, w * 0.35, d * 0.35)
      line(-w * 0.35, d * 0.35, w * 0.35, -d * 0.35)
      break
    }
    case 'decor':
    case 'office':
    case 'kids':
    case 'outdoor':
    case 'other': {
      outline()
      break
    }
    default: {
      outline()
      line(x0, y0, x1, y1, { ...detail, width: 0.1 })
      line(x0, y1, x1, y0, { ...detail, width: 0.1 })
    }
  }
  void S
}

function drawLight(ctx: Ctx, l: Light): void {
  const { th, items, S } = ctx
  const ref: EntityRef = { kind: 'light', id: l.id }
  const pen: DlPen = { color: th.light, width: 0.18, dash: l.on ? undefined : [1, 1] }
  const c = V(l.x, l.y)
  const ln = (a: Vec2, b: Vec2) => items.push({ t: 'line', layer: 'lights', role: 'light', a, b, stroke: pen, ref })
  const circ = (r: number, fill?: DlFill) => items.push({ t: 'circle', layer: 'lights', role: 'light', c, r, stroke: pen, fill, ref })
  const cross = (r: number, diag: boolean) => {
    const k = diag ? Math.SQRT1_2 : 1
    if (diag) {
      ln(V(c.x - r * k, c.y - r * k), V(c.x + r * k, c.y + r * k))
      ln(V(c.x - r * k, c.y + r * k), V(c.x + r * k, c.y - r * k))
    } else {
      ln(V(c.x - r, c.y), V(c.x + r, c.y))
      ln(V(c.x, c.y - r), V(c.x, c.y + r))
    }
  }
  const sizeK = Math.max(1, S / 100)
  switch (l.kind) {
    case 'ceiling':
      circ(150 * sizeK)
      cross(150 * sizeK, true)
      break
    case 'pendant':
      circ(180 * sizeK)
      circ(60 * sizeK, { color: th.light })
      break
    case 'spot':
      circ(60 * sizeK)
      circ(15 * sizeK, { color: th.light })
      break
    case 'point':
      circ(100 * sizeK)
      cross(140 * sizeK, false)
      break
    case 'strip':
    case 'area': {
      const w = l.size?.w ?? (l.kind === 'strip' ? 1000 : 600)
      const dd = l.size?.d ?? (l.kind === 'strip' ? 20 : 600)
      const T = xf(c, l.rotation ?? 0, false)
      const pts = rectPts(-w / 2, -dd / 2, w / 2, dd / 2).map(T)
      items.push({
        t: 'poly',
        layer: 'lights',
        role: 'light',
        pts,
        closed: true,
        stroke: l.kind === 'strip' ? { ...pen, dash: [1.5, 0.8] } : pen,
        ref,
      })
      if (l.kind === 'area') {
        ln(pts[0], pts[2])
        ln(pts[1], pts[3])
      }
      break
    }
  }
}

function boundsOf(items: DisplayItem[]): DisplayBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const it of items) {
    switch (it.t) {
      case 'poly':
        for (const p of it.pts) add(p.x, p.y)
        break
      case 'line':
        add(it.a.x, it.a.y)
        add(it.b.x, it.b.y)
        break
      case 'arc':
      case 'circle':
        add(it.c.x - it.r, it.c.y - it.r)
        add(it.c.x + it.r, it.c.y + it.r)
        break
      case 'text': {
        const w = estimateTextWidth(it.text, it.size)
        const r = (it.rot * Math.PI) / 180
        const ux = Math.cos(r)
        const uy = Math.sin(r)
        const startOff = it.anchor === 'start' ? 0 : it.anchor === 'middle' ? -w / 2 : -w
        for (const along of [startOff, startOff + w]) {
          for (const across of [-it.size * 0.6, it.size * 0.6]) add(it.p.x + ux * along - uy * across, it.p.y + uy * along + ux * across)
        }
        break
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
  return { minX, minY, maxX, maxY }
}

function niceBarLength(S: number): number {
  const target = 50 * S
  const cands = [200, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000]
  let best = cands[0]
  for (const c of cands) if (c <= target) best = c
  return best
}

function drawSheet(ctx: Ctx, opts: DisplayOptions, content: DisplayBounds): void {
  const { doc, S, th, items, lang } = ctx
  // north arrow (top-right, outside content)
  if (opts.northArrow !== false) {
    const R = 6 * S
    const c = V(content.maxX + R + 4 * S, content.minY + R)
    const ang = ((doc.render?.north ?? 0) * Math.PI) / 180
    const dir = V(Math.sin(ang), -Math.cos(ang))
    const perp = V(-dir.y, dir.x)
    const pen: DlPen = { color: th.text, width: 0.25 }
    items.push({ t: 'circle', layer: 'sheet', role: 'north', c, r: R, stroke: pen })
    const tip = vAdd(c, vMul(dir, R * 0.9))
    const tail = vSub(c, vMul(dir, R * 0.6))
    const left = vAdd(tail, vMul(perp, R * 0.38))
    const right = vSub(tail, vMul(perp, R * 0.38))
    const notch = vSub(c, vMul(dir, R * 0.25))
    items.push({ t: 'poly', layer: 'sheet', role: 'north', pts: [tip, left, notch], closed: true, stroke: pen, fill: { color: th.text } })
    items.push({ t: 'poly', layer: 'sheet', role: 'north', pts: [tip, notch, right], closed: true, stroke: pen, fill: { color: th.bg } })
    items.push({
      t: 'text',
      layer: 'sheet',
      role: 'north',
      p: vAdd(c, vMul(dir, R + 2.4 * S)),
      text: lang === 'ru' ? 'С' : 'N',
      size: 3 * S,
      rot: 0,
      anchor: 'middle',
      baseline: 'middle',
      color: th.text,
      bold: true,
    })
  }
  // scale bar (below content, left)
  let below = content.maxY + 6 * S
  if (opts.scaleBar !== false) {
    const total = niceBarLength(S)
    const n = 5
    const seg = total / n
    const h = 1.5 * S
    const x0 = content.minX
    const y0 = below
    const pen: DlPen = { color: th.text, width: 0.18 }
    for (let i = 0; i < n; i++) {
      items.push({
        t: 'poly',
        layer: 'sheet',
        role: 'scalebar',
        pts: rectPts(x0 + i * seg, y0, x0 + (i + 1) * seg, y0 + h),
        closed: true,
        stroke: pen,
        fill: { color: i % 2 === 0 ? th.text : th.bg },
      })
    }
    const lbl = (x: number, mm: number) =>
      items.push({
        t: 'text',
        layer: 'sheet',
        role: 'scalebar',
        p: V(x, y0 + h + 2.2 * S),
        text: mm === 0 ? '0' : `${fmtLength(mm, 'm', lang).replace(/[,.]00$/, '')}${lang === 'ru' ? ' м' : ' m'}`,
        size: 2 * S,
        rot: 0,
        anchor: 'middle',
        baseline: 'middle',
        color: th.text,
      })
    lbl(x0, 0)
    lbl(x0 + total, total)
    items.push({
      t: 'text',
      layer: 'sheet',
      role: 'scalebar',
      p: V(x0 + total + 4 * S, y0 + h / 2),
      text: lang === 'ru' ? `М 1:${S}` : `Scale 1:${S}`,
      size: 2.5 * S,
      rot: 0,
      anchor: 'start',
      baseline: 'middle',
      color: th.text,
    })
    below = y0 + h + 5 * S
  }
  // title block
  if (opts.titleBlock) {
    const info: TitleBlockInfo = typeof opts.titleBlock === 'object' ? opts.titleBlock : {}
    const W = 120 * S
    const H = 30 * S
    const x1 = Math.max(content.maxX, content.minX + W)
    const x0 = x1 - W
    const y0 = below + 4 * S
    const pen: DlPen = { color: th.text, width: 0.5 }
    const thinPen: DlPen = { color: th.text, width: 0.18 }
    items.push({ t: 'poly', layer: 'sheet', role: 'titleblock', pts: rectPts(x0, y0, x1, y0 + H), closed: true, stroke: pen })
    const rowH = H / 3
    items.push({ t: 'line', layer: 'sheet', role: 'titleblock', a: V(x0, y0 + rowH * 1.4), b: V(x1, y0 + rowH * 1.4), stroke: thinPen })
    items.push({ t: 'line', layer: 'sheet', role: 'titleblock', a: V(x0, y0 + rowH * 2.2), b: V(x1, y0 + rowH * 2.2), stroke: thinPen })
    const colX = x0 + W * 0.55
    items.push({ t: 'line', layer: 'sheet', role: 'titleblock', a: V(colX, y0 + rowH * 1.4), b: V(colX, y0 + H), stroke: thinPen })
    const total = (ctx.allRooms ?? ctx.plan.rooms).reduce((s, r) => {
      const rec = doc.rooms[r.roomId]
      const k = rec?.type === 'balcony' ? 0.3 : rec?.type === 'loggia' ? 0.5 : 1
      return s + r.area * k
    }, 0)
    const txt = (x: number, y: number, text: string, size: number, bold = false) =>
      items.push({ t: 'text', layer: 'sheet', role: 'titleblock', p: V(x, y), text, size, rot: 0, anchor: 'start', baseline: 'middle', color: th.text, bold })
    const pad = 2.5 * S
    txt(x0 + pad, y0 + rowH * 0.7, info.title ?? doc.meta.name, 4 * S, true)
    txt(x0 + pad, y0 + rowH * 1.8, info.subtitle ?? (lang === 'ru' ? 'План' : 'Floor plan'), 2.5 * S)
    txt(colX + pad, y0 + rowH * 1.8, lang === 'ru' ? `Масштаб 1:${S}` : `Scale 1:${S}`, 2.5 * S)
    txt(x0 + pad, y0 + rowH * 2.6, `${lang === 'ru' ? 'Площадь' : 'Area'}: ${fmtArea(total, lang)}`, 2.5 * S)
    const date = info.date ?? (doc.meta.modifiedAt || doc.meta.createdAt || '').slice(0, 10)
    txt(colX + pad, y0 + rowH * 2.6, [info.author, date, info.sheet].filter(Boolean).join(' · '), 2.2 * S)
  }
}

/** Build the display list of one level. */
export function buildDisplayList(fullDoc: Doc, levelId: Id, opts: DisplayOptions = {}): DisplayList {
  const S = opts.scale && opts.scale > 0 ? opts.scale : 100
  const themeName: DisplayThemeName = opts.theme ?? 'light'
  const th = DISPLAY_THEMES[themeName]
  const lang = opts.lang ?? 'ru'
  // rooms are detected on the full document; objects hidden in the layers panel are not drawn
  const fullPlan = opts.derived ?? derivePlan(fullDoc, levelId)
  const doc = opts.includeHidden ? fullDoc : visibleDoc(fullDoc)
  const plan = opts.includeHidden ? fullPlan : visiblePlan(fullDoc, fullPlan)
  const ctx: Ctx = { doc, plan, S, th, lang, units: doc.settings?.units ?? 'mm', items: [], allRooms: fullPlan.rooms }
  const showDims = opts.dimensions ?? doc.settings?.showDimensions ?? true
  const showAreas = opts.areas ?? doc.settings?.showAreas ?? true
  const showFurniture = opts.furniture ?? doc.settings?.showFurniture2d ?? true
  const showLabels = opts.labels ?? true

  const levelWalls = Object.values(doc.walls).filter((w) => w.levelId === levelId)
  const openingsByWall = new Map<Id, Opening[]>()
  for (const o of Object.values(doc.openings)) {
    if (!plan.wallGeoms[o.wallId]) continue
    const list = openingsByWall.get(o.wallId) ?? []
    list.push(o)
    openingsByWall.set(o.wallId, list)
  }

  // rooms
  for (const r of plan.rooms) {
    const rec = doc.rooms[r.roomId]
    const outdoor = rec?.type === 'balcony' || rec?.type === 'loggia'
    ctx.items.push({
      t: 'poly',
      layer: 'rooms',
      role: 'room-fill',
      pts: r.polygon,
      holes: r.holes.length ? r.holes : undefined,
      closed: true,
      fill: { color: outdoor ? th.outdoorFill : th.roomFill },
      ref: rec ? { kind: 'room', id: rec.id } : undefined,
    })
  }
  // grid
  if (opts.grid) {
    const step = 1000
    const b = plan.bounds
    const gx0 = Math.floor((b.minX - 1000) / step) * step
    const gx1 = Math.ceil((b.maxX + 1000) / step) * step
    const gy0 = Math.floor((b.minY - 1000) / step) * step
    const gy1 = Math.ceil((b.maxY + 1000) / step) * step
    const pen: DlPen = { color: th.grid, width: 0.1 }
    if (Number.isFinite(gx0) && (gx1 - gx0) / step < 400 && (gy1 - gy0) / step < 400) {
      for (let x = gx0; x <= gx1; x += step) ctx.items.push({ t: 'line', layer: 'grid', role: 'grid', a: V(x, gy0), b: V(x, gy1), stroke: pen })
      for (let y = gy0; y <= gy1; y += step) ctx.items.push({ t: 'line', layer: 'grid', role: 'grid', a: V(gx0, y), b: V(gx1, y), stroke: pen })
    }
  }
  // furniture
  if (showFurniture) {
    const list = Object.values(doc.items)
      .filter((it) => it.levelId === levelId && !it.hidden)
      .sort((a, b) => (a.mount === 'floor' ? 0 : 1) - (b.mount === 'floor' ? 0 : 1) || a.elevation - b.elevation)
    for (const it of list) owned(ctx, { kind: 'item', id: it.id }, () => drawItem(ctx, it, findAsset(doc, opts.catalog, it.assetId)))
  }
  drawWalls(ctx, levelWalls, openingsByWall)
  drawOpenings(ctx, levelWalls, openingsByWall)
  if (opts.lights !== false) {
    for (const l of Object.values(doc.lights)) if (l.levelId === levelId) owned(ctx, { kind: 'light', id: l.id }, () => drawLight(ctx, l))
  }
  drawRoomLabels(ctx, showLabels, showAreas)
  if (showLabels) {
    for (const lb of Object.values(doc.labels)) {
      if (lb.levelId !== levelId || !lb.text) continue
      ctx.items.push({
        t: 'text',
        layer: 'annotations',
        role: 'label',
        p: V(lb.x, lb.y),
        text: lb.text,
        size: Math.max(lb.size, 1.8 * S),
        rot: 0,
        anchor: 'middle',
        baseline: 'middle',
        color: th.text,
        ref: { kind: 'label', id: lb.id },
      })
    }
  }
  if (opts.innerDimensions ?? showDims) drawInnerDims(ctx)
  if (opts.outerDimensions ?? showDims) drawOuterDims(ctx, levelWalls, openingsByWall)
  if (opts.manualDimensions !== false) {
    for (const dm of Object.values(doc.dimensions)) {
      if (dm.levelId !== levelId) continue
      const ref: EntityRef = { kind: 'dimension', id: dm.id }
      owned(ctx, ref, () => pushDim(ctx, dm.a, dm.b, dm.offset, 'dim-manual', { ref }))
    }
  }
  const content = boundsOf(ctx.items)
  drawSheet(ctx, opts, content)
  // pad by a stroke width so outer strokes (north arrow circle, thick walls) are never clipped
  const b = boundsOf(ctx.items)
  const pad = 0.5 * S
  const bounds = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
  return { bounds, items: ctx.items, scale: S, theme: themeName, background: th.bg }
}

/** Tight bounds of a display list's items (without stroke padding). */
export function displayListBounds(dl: DisplayList): DisplayBounds {
  return boundsOf(dl.items)
}
