/**
 * Planar homography (projective transform) and perspective rectification of raster images.
 * Used to straighten a photo of a paper plan taken at an angle: four clicked corners of a known
 * rectangle → H → inverse-mapped, bilinear-sampled output image.
 *
 * Pure TypeScript: no DOM / Node imports. Image coordinates: x right, y DOWN, pixel i covers [i, i+1).
 */
import type { Vec2 } from './types'

/** 3×3 matrix, row-major: [h11 h12 h13 h21 h22 h23 h31 h32 h33], normalised so h33 = 1 */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

/** four corners, by convention TL, TR, BR, BL (y down) */
export type Quad = [Vec2, Vec2, Vec2, Vec2]

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

// ───────────────────────────── validation ─────────────────────────────

function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function extent(pts: Vec2[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

/**
 * Throws a readable (Russian) Error when the four points cannot define a perspective transform:
 * wrong count, non-finite values, duplicate points, three points on one line, self-intersecting
 * or non-convex quadrilateral. Points must be given in boundary order (use `orderQuad` first).
 */
export function checkQuad(points: readonly Vec2[], what = 'Четырёхугольник'): void {
  if (points.length !== 4) throw new Error(`${what}: нужно ровно 4 точки, задано ${points.length}`)
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`${what}: координаты точек должны быть числами`)
  }
  const size = extent(points as Vec2[])
  if (!(size > 0)) throw new Error(`${what}: все точки совпадают`)
  const dupTol = size * 1e-6
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <= dupTol) {
        throw new Error(`${what}: точки ${i + 1} и ${j + 1} совпадают`)
      }
    }
  }
  const areaTol = size * size * 1e-5
  const triples = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ]
  for (const [a, b, c] of triples) {
    if (Math.abs(cross3(points[a], points[b], points[c])) <= areaTol) {
      throw new Error(`${what}: точки ${a + 1}, ${b + 1} и ${c + 1} лежат на одной прямой`)
    }
  }
  let pos = 0
  let neg = 0
  for (let i = 0; i < 4; i++) {
    const c = cross3(points[i], points[(i + 1) % 4], points[(i + 2) % 4])
    if (c > 0) pos++
    else neg++
  }
  if (pos === 2 && neg === 2) throw new Error(`${what}: стороны пересекаются — проверьте порядок углов`)
  if (pos !== 4 && neg !== 4) throw new Error(`${what}: фигура невыпуклая — выберите 4 угла прямоугольника`)
}

// ───────────────────────────── linear algebra ─────────────────────────────

/** Solves A·x = b (A is n×n, row arrays) by Gaussian elimination with partial pivoting; null if singular. */
export function solveLinear(A: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]])
  let maxAbs = 0
  for (const row of m) for (let j = 0; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(row[j]))
  const tol = Math.max(maxAbs, 1) * 1e-12
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) <= tol) return null
    if (piv !== col) [m[piv], m[col]] = [m[col], m[piv]]
    const pr = m[col]
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / pr[col]
      if (f === 0) continue
      const row = m[r]
      for (let c = col; c <= n; c++) row[c] -= f * pr[c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n]
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c]
    x[r] = s / m[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  }
  return r as Mat3
}

function normaliseMat3(m: number[]): Mat3 {
  const k = Math.abs(m[8]) > 1e-12 ? m[8] : m.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0) || 1
  return m.map((v) => v / k) as Mat3
}

/** Inverse of a homography (adjugate / determinant), normalised so h33 = 1. Throws for a singular matrix. */
export function invertHomography(h: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, k, l] = h
  const A = e * l - f * k
  const B = -(d * l - f * g)
  const C = d * k - e * g
  const det = a * A + b * B + c * C
  const scale = Math.max(...h.map(Math.abs), 1e-300)
  if (!Number.isFinite(det) || Math.abs(det) <= scale ** 3 * 1e-14) throw new Error('Матрица перспективы вырождена — обратного преобразования нет')
  const inv = [A, -(b * l - c * k), b * f - c * e, B, a * l - c * g, -(a * f - c * d), C, -(a * k - b * g), a * e - b * d]
  return normaliseMat3(inv.map((v) => v / det))
}

/** Maps a point by H (with the projective division). Points on the vanishing line give non-finite results. */
export function applyHomography(h: Mat3, p: Vec2): Vec2 {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

/** Hartley normalisation: centroid → origin, mean distance → √2 */
function normalisation(pts: readonly Vec2[]): { t: Mat3; inv: Mat3 } {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const md = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length
  const s = md > 0 ? Math.SQRT2 / md : 1
  return {
    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  }
}

/**
 * Homography H with H·src[i] ≅ dst[i] for the four point pairs (DLT, 8×8 linear solve on
 * Hartley-normalised coordinates). Both quads must be in boundary order (same winding sense as
 * each other is not required). Throws a readable Error for degenerate input.
 */
export function computeHomography(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 {
  checkQuad(src, 'Исходные точки')
  checkQuad(dst, 'Целевые точки')
  const ns = normalisation(src)
  const nd = normalisation(dst)
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(ns.t, src[i])
    const q = applyHomography(nd.t, dst[i])
    A.push([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y])
    b.push(q.x)
    A.push([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y])
    b.push(q.y)
  }
  const x = solveLinear(A, b)
  if (!x) throw new Error('Не удалось вычислить перспективу: точки в вырожденном положении')
  const hn: Mat3 = [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1]
  return normaliseMat3(multiplyMat3(multiplyMat3(nd.inv, hn), ns.t))
}

// ───────────────────────────── quads ─────────────────────────────

/**
 * Sorts four arbitrary points into TL, TR, BR, BL (y down): angular order around the centroid
 * (clockwise on screen), starting from the corner with the smallest x + y.
 */
export function orderQuad(points: readonly Vec2[]): Quad {
  if (points.length !== 4) throw new Error(`Нужно ровно 4 точки, задано ${points.length}`)
  const cx = points.reduce((s, p) => s + p.x, 0) / 4
  const cy = points.reduce((s, p) => s + p.y, 0) / 4
  const sorted = points
    .map((p) => ({ p: { x: p.x, y: p.y }, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((u, v) => u.a - v.a)
    .map((e) => e.p)
  let start = 0
  for (let i = 1; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y
    const best = sorted[start].x + sorted[start].y
    if (s < best - 1e-9 || (Math.abs(s - best) <= 1e-9 && sorted[i].y < sorted[start].y)) start = i
  }
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Quad
}

export interface RectifiedSizeOptions {
  /** real size of the rectangle, mm: then the output aspect is exact and `mmPerPx` is reported */
  rectMm?: { width: number; height: number }
  /** cap of the longest output side, px (default unlimited) */
  maxSide?: number
}

export interface RectifiedSize {
  width: number
  height: number
  /** mm per output pixel (only when `rectMm` was given) */
  mmPerPx?: number
}

/**
 * Output pixel size for rectifying `quad` (TL, TR, BR, BL in source px).
 * Unknown real size: average of opposite edge lengths. Known size: exact aspect of the real
 * rectangle, the longer side gets the longest source edge (keeps the source resolution).
 */
export function rectifiedSize(quad: readonly Vec2[], opts: RectifiedSizeOptions = {}): RectifiedSize {
  if (quad.length !== 4) throw new Error(`Нужно ровно 4 точки, задано ${quad.length}`)
  const d = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y)
  const top = d(quad[0], quad[1])
  const right = d(quad[1], quad[2])
  const bottom = d(quad[3], quad[2])
  const left = d(quad[0], quad[3])
  const cap = opts.maxSide && opts.maxSide > 0 ? opts.maxSide : Infinity
  const r = opts.rectMm
  if (r) {
    if (!(r.width > 0 && r.height > 0 && Number.isFinite(r.width) && Number.isFinite(r.height))) {
      throw new Error('Размеры прямоугольника должны быть больше нуля')
    }
    const longest = Math.max(1, Math.round(Math.min(cap, Math.max(top, right, bottom, left))))
    const mmPerPx = Math.max(r.width, r.height) / longest
    return {
      width: Math.max(1, Math.round(r.width / mmPerPx)),
      height: Math.max(1, Math.round(r.height / mmPerPx)),
      mmPerPx,
    }
  }
  let w = (top + bottom) / 2
  let h = (left + right) / 2
  const k = Math.min(1, cap / Math.max(w, h, 1e-9))
  w *= k
  h *= k
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }
}

export interface RectificationOptions extends RectifiedSizeOptions {
  /**
   * extra margin kept around the rectangle, as a fraction of its width/height on each side
   * (dimension chains and balconies outside the outer walls); clipped to the source image. Default 0.
   */
  pad?: number
}

export interface Rectification {
  /** source px of the four OUTPUT corners (TL, TR, BR, BL): pass to `warpPerspective` */
  quad: Quad
  width: number
  height: number
  /** where the chosen rectangle lies in the output, px */
  rect: { x: number; y: number; width: number; height: number }
  /** mm per output pixel (only when `rectMm` was given) */
  mmPerPx?: number
}

/**
 * Plans a perspective rectification of a `srcW × srcH` image so that `quad` (TL, TR, BR, BL, source px)
 * becomes an axis-aligned rectangle; with `pad` the output also keeps the surroundings of the rectangle
 * (as far as the source image reaches). The longest output side is capped by `maxSide`.
 */
export function planRectification(quad: readonly Vec2[], srcW: number, srcH: number, opts: RectificationOptions = {}): Rectification {
  checkQuad(quad, 'Углы прямоугольника')
  const base = rectifiedSize(quad, { rectMm: opts.rectMm })
  const rw = base.width
  const rh = base.height
  const rectQuad = [P0(0, 0), P0(rw, 0), P0(rw, rh), P0(0, rh)]
  const toSrc = computeHomography(rectQuad, quad)
  const toRect = invertHomography(toSrc)
  const wOf = (h: Mat3, p: Vec2) => h[6] * p.x + h[7] * p.y + h[8]
  const sideSign = Math.sign(wOf(toRect, quad[0]))

  let region = { x0: 0, y0: 0, x1: rw, y1: rh }
  const pad = Math.max(0, opts.pad ?? 0)
  if (pad > 0) {
    const lim = { x0: -pad * rw, y0: -pad * rh, x1: rw + pad * rw, y1: rh + pad * rh }
    // the part of the source image that lies on the same side of the horizon as the rectangle
    const corners = [P0(0, 0), P0(srcW, 0), P0(srcW, srcH), P0(0, srcH)]
    let bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    let allFinite = true
    for (const c of corners) {
      if (Math.sign(wOf(toRect, c)) !== sideSign) {
        allFinite = false
        continue
      }
      const m = applyHomography(toRect, c)
      bb = { x0: Math.min(bb.x0, m.x), y0: Math.min(bb.y0, m.y), x1: Math.max(bb.x1, m.x), y1: Math.max(bb.y1, m.y) }
    }
    // a source corner behind the horizon: the image extends to infinity there, use the full pad
    if (!allFinite) bb = lim
    const cand = {
      x0: Math.min(0, Math.max(lim.x0, bb.x0)),
      y0: Math.min(0, Math.max(lim.y0, bb.y0)),
      x1: Math.max(rw, Math.min(lim.x1, bb.x1)),
      y1: Math.max(rh, Math.min(lim.y1, bb.y1)),
    }
    const cc = [P0(cand.x0, cand.y0), P0(cand.x1, cand.y0), P0(cand.x1, cand.y1), P0(cand.x0, cand.y1)]
    // keep the margin only when the whole output stays in front of the horizon
    if (cc.every((p) => Math.sign(wOf(toSrc, p)) === Math.sign(wOf(toSrc, P0(rw / 2, rh / 2))))) region = cand
  }

  const regW = region.x1 - region.x0
  const regH = region.y1 - region.y0
  const cap = opts.maxSide && opts.maxSide > 0 ? opts.maxSide : Infinity
  const s = Math.min(1, cap / Math.max(regW, regH))
  const width = Math.max(1, Math.round(regW * s))
  const height = Math.max(1, Math.round(regH * s))
  // exact scale per axis after rounding, so that the output quad and the reported rect agree
  const sx = width / regW
  const sy = height / regH
  const out = [P0(region.x0, region.y0), P0(region.x1, region.y0), P0(region.x1, region.y1), P0(region.x0, region.y1)].map((p) =>
    applyHomography(toSrc, p),
  ) as Quad
  return {
    quad: out,
    width,
    height,
    rect: { x: Math.abs(region.x0) * sx, y: Math.abs(region.y0) * sy, width: rw * sx, height: rh * sy },
    ...(base.mmPerPx !== undefined ? { mmPerPx: base.mmPerPx / ((sx + sy) / 2) } : {}),
  }
}

function P0(x: number, y: number): Vec2 {
  return { x, y }
}

// ───────────────────────────── raster warp ─────────────────────────────

export interface RasterImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
  channels: 1 | 3 | 4
}

export interface WarpOptions {
  /** fill for output pixels that map outside the source; default white, opaque */
  background?: number[]
}

/**
 * Perspective rectification: the source quad (TL, TR, BR, BL in source px) becomes the full
 * outW × outH output. Inverse mapping of every output pixel centre + bilinear sampling.
 * The output has the same channel count as the source.
 */
export function warpPerspective(
  src: RasterImage,
  quad: readonly Vec2[],
  outW: number,
  outH: number,
  opts: WarpOptions = {},
): { width: number; height: number; data: Uint8ClampedArray; channels: 1 | 3 | 4 } {
  const W = Math.round(outW)
  const Hh = Math.round(outH)
  if (!(W >= 1 && Hh >= 1)) throw new Error('Размер результата должен быть не меньше 1×1 пикселя')
  const ch = src.channels
  if (src.data.length < src.width * src.height * ch) throw new Error('Размер буфера изображения не совпадает с его размерами')
  const outRect: Vec2[] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: Hh },
    { x: 0, y: Hh },
  ]
  // maps output px → source px
  const h = computeHomography(outRect, quad)
  const bg = new Array<number>(ch)
  for (let c = 0; c < ch; c++) bg[c] = opts.background?.[c] ?? 255
  if (ch === 4 && opts.background && opts.background.length < 4) bg[3] = 255

  const out = new Uint8ClampedArray(W * Hh * ch)
  const sw = src.width
  const sh = src.height
  const sd = src.data
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = h
  for (let y = 0; y < Hh; y++) {
    const oy = y + 0.5
    // numerators/denominator are linear in x: step them
    let nx = h0 * 0.5 + h1 * oy + h2
    let ny = h3 * 0.5 + h4 * oy + h5
    let dw = h6 * 0.5 + h7 * oy + h8
    let o = y * W * ch
    for (let x = 0; x < W; x++, o += ch, nx += h0, ny += h3, dw += h6) {
      const px = nx / dw
      const py = ny / dw
      if (!(px >= 0 && py >= 0 && px <= sw && py <= sh)) {
        for (let c = 0; c < ch; c++) out[o + c] = bg[c]
        continue
      }
      // pixel-centre convention: sample position in index space
      const fx = px - 0.5
      const fy = py - 0.5
      let x0 = Math.floor(fx)
      let y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      let x1 = x0 + 1
      let y1 = y0 + 1
      if (x0 < 0) x0 = 0
      if (y0 < 0) y0 = 0
      if (x1 > sw - 1) x1 = sw - 1
      if (y1 > sh - 1) y1 = sh - 1
      if (x0 > sw - 1) x0 = sw - 1
      if (y0 > sh - 1) y0 = sh - 1
      const i00 = (y0 * sw + x0) * ch
      const i10 = (y0 * sw + x1) * ch
      const i01 = (y1 * sw + x0) * ch
      const i11 = (y1 * sw + x1) * ch
      const w00 = (1 - tx) * (1 - ty)
      const w10 = tx * (1 - ty)
      const w01 = (1 - tx) * ty
      const w11 = tx * ty
      for (let c = 0; c < ch; c++) {
        out[o + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11
      }
    }
  }
  return { width: W, height: Hh, data: out, channels: ch }
}
