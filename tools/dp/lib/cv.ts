/**
 * Pure-TypeScript raster helpers for the photo-to-plan CLI (no Node / DOM APIs).
 *
 * Everything here produces HINTS for the vision model, never decisions:
 *  - Otsu threshold, binary ink mask
 *  - separable morphological opening / closing (removes text, thin lines, hatching strokes)
 *  - run-length based axis-aligned "wall band" extraction with thickness
 *  - merge across junctions, endpoint snapping (L / T joins), thickness clustering
 *  - projection-profile deskew estimate
 *  - mask IoU / diff regions
 */

export interface Gray {
  data: Uint8Array
  width: number
  height: number
}

export interface Mask {
  /** 1 = ink / wall */
  data: Uint8Array
  width: number
  height: number
}

// ───────────────────────── threshold ─────────────────────────

export function histogram(g: Gray): Uint32Array {
  const h = new Uint32Array(256)
  for (let i = 0; i < g.data.length; i++) h[g.data[i]]++
  return h
}

/** Otsu's threshold; pixels with value <= t are ink. */
export function otsu(g: Gray): number {
  const hist = histogram(g)
  const total = g.data.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let t = 127
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      t = i
    }
  }
  return t
}

export function binarize(g: Gray, t: number): Mask {
  const out = new Uint8Array(g.data.length)
  for (let i = 0; i < out.length; i++) out[i] = g.data[i] <= t ? 1 : 0
  return { data: out, width: g.width, height: g.height }
}

export function countOnes(m: Mask): number {
  let n = 0
  for (let i = 0; i < m.data.length; i++) n += m.data[i]
  return n
}

// ───────────────────────── morphology (separable, O(N)) ─────────────────────────

/**
 * 1-D erosion/dilation along rows (`horizontal`) or columns with a window of k pixels.
 * Erosion: pixel stays 1 iff all k pixels of the window are 1 (outside image counts as 0).
 * Dilation: pixel becomes 1 iff any pixel of the (reflected) window is 1.
 */
function morph1d(m: Mask, k: number, horizontal: boolean, erode: boolean): Mask {
  const { width: w, height: h, data } = m
  const out = new Uint8Array(data.length)
  if (k <= 1) {
    out.set(data)
    return { data: out, width: w, height: h }
  }
  const before = erode ? Math.floor((k - 1) / 2) : k - 1 - Math.floor((k - 1) / 2)
  const after = k - 1 - before
  const lines = horizontal ? h : w
  const len = horizontal ? w : h
  const pre = new Int32Array(len + 1)
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l
    const stride = horizontal ? 1 : w
    pre[0] = 0
    for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + data[base + i * stride]
    for (let i = 0; i < len; i++) {
      const a = i - before
      const b = i + after
      if (erode) {
        if (a < 0 || b >= len) {
          out[base + i * stride] = 0
          continue
        }
        out[base + i * stride] = pre[b + 1] - pre[a] === k ? 1 : 0
      } else {
        const a2 = Math.max(0, a)
        const b2 = Math.min(len - 1, b)
        out[base + i * stride] = pre[b2 + 1] - pre[a2] > 0 ? 1 : 0
      }
    }
  }
  return { data: out, width: w, height: h }
}

export function erode(m: Mask, k: number): Mask {
  return morph1d(morph1d(m, k, true, true), k, false, true)
}

export function dilate(m: Mask, k: number): Mask {
  return morph1d(morph1d(m, k, true, false), k, false, false)
}

/** opening with a k×k square: removes everything thinner than k in both directions */
export function open(m: Mask, k: number): Mask {
  return dilate(erode(m, k), k)
}

/** closing with a k×k square: fills gaps narrower than k (hollow double-line walls) */
export function close(m: Mask, k: number): Mask {
  return erode(dilate(m, k), k)
}

// ───────────────────────── wall extraction ─────────────────────────

export interface WallCandidate {
  id: string
  orient: 'h' | 'v'
  /** centre-line end points, px */
  x1: number
  y1: number
  x2: number
  y2: number
  /** band thickness, px */
  thickness: number
  length: number
  /** 0..1, heuristic confidence (long, constant thickness → high) */
  score: number
  /** index into clusters[] */
  cluster?: number
}

export interface ThicknessCluster {
  thickness: number
  count: number
  lengthPx: number
}

interface Seg {
  orient: 'h' | 'v'
  /** along-axis start/end (inclusive px) */
  s: number
  e: number
  /** across-axis centre */
  c: number
  t: number
  tStd: number
}

interface Chain {
  last: number
  lastC: number
  lastT: number
  start: number
  cs: number[]
  ts: number[]
}

function median(a: number[]): number {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function std(a: number[], mean: number): number {
  if (a.length < 2) return 0
  let v = 0
  for (const x of a) v += (x - mean) * (x - mean)
  return Math.sqrt(v / a.length)
}

/**
 * Scan the mask perpendicular to `orient` and link thin runs into bands.
 * orient 'h': for every column, vertical runs of thickness t in [minT,maxT] are slices of horizontal walls.
 */
function scanBands(m: Mask, orient: 'h' | 'v', minT: number, maxT: number, gap: number, minLen: number): Seg[] {
  const { width: w, height: h, data } = m
  const alongLen = orient === 'h' ? w : h
  const acrossLen = orient === 'h' ? h : w
  const at = orient === 'h' ? (i: number, j: number) => data[j * w + i] : (i: number, j: number) => data[i * w + j]
  let active: Chain[] = []
  const done: Chain[] = []
  for (let i = 0; i < alongLen; i++) {
    // collect slices in this line
    const slices: { c: number; t: number }[] = []
    let j = 0
    while (j < acrossLen) {
      if (at(i, j) === 0) {
        j++
        continue
      }
      const j0 = j
      while (j < acrossLen && at(i, j) === 1) j++
      const t = j - j0
      if (t >= minT && t <= maxT) slices.push({ c: (j0 + j - 1) / 2, t })
    }
    const used = new Set<Chain>()
    for (const sl of slices) {
      let best: Chain | null = null
      let bestD = Number.POSITIVE_INFINITY
      for (const ch of active) {
        if (used.has(ch)) continue
        const dc = Math.abs(ch.lastC - sl.c)
        const dt = Math.abs(ch.lastT - sl.t)
        if (dc <= Math.max(1.5, 0.15 * sl.t) && dt <= Math.max(2, 0.3 * sl.t)) {
          const d = dc + dt * 0.5
          if (d < bestD) {
            bestD = d
            best = ch
          }
        }
      }
      if (best) {
        best.last = i
        best.lastC = sl.c
        best.lastT = sl.t
        best.cs.push(sl.c)
        best.ts.push(sl.t)
        used.add(best)
      } else {
        const ch: Chain = { last: i, lastC: sl.c, lastT: sl.t, start: i, cs: [sl.c], ts: [sl.t] }
        active.push(ch)
        used.add(ch)
      }
    }
    // retire chains that did not continue within `gap`
    const keep: Chain[] = []
    for (const ch of active) {
      if (i - ch.last > gap) done.push(ch)
      else keep.push(ch)
    }
    active = keep
  }
  done.push(...active)
  const segs: Seg[] = []
  for (const ch of done) {
    const t = median(ch.ts)
    const len = ch.last - ch.start + 1
    if (len < Math.max(minLen, 1.5 * t)) continue
    const meanT = ch.ts.reduce((a, b) => a + b, 0) / ch.ts.length
    segs.push({ orient, s: ch.start, e: ch.last, c: median(ch.cs), t, tStd: std(ch.ts, meanT) })
  }
  return segs
}

/** fraction of mask pixels set inside an axis-aligned box */
function fill(m: Mask, x0: number, y0: number, x1: number, y1: number): number {
  const xa = Math.max(0, Math.floor(Math.min(x0, x1)))
  const xb = Math.min(m.width - 1, Math.ceil(Math.max(x0, x1)))
  const ya = Math.max(0, Math.floor(Math.min(y0, y1)))
  const yb = Math.min(m.height - 1, Math.ceil(Math.max(y0, y1)))
  if (xb < xa || yb < ya) return 0
  let n = 0
  let on = 0
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      n++
      on += m.data[y * m.width + x]
    }
  }
  return n ? on / n : 0
}

/** Merge collinear bands of the same orientation across gaps that are filled with wall ink (junctions). */
function mergeCollinear(segs: Seg[], m: Mask, maxGap: number): Seg[] {
  const out: Seg[] = []
  const byOrient = (o: 'h' | 'v') => segs.filter((s) => s.orient === o).sort((a, b) => a.c - b.c || a.s - b.s)
  for (const o of ['h', 'v'] as const) {
    const list = byOrient(o)
    const used = new Array<boolean>(list.length).fill(false)
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue
      const cur: Seg = { ...list[i] }
      used[i] = true
      let changed = true
      while (changed) {
        changed = false
        for (let j = 0; j < list.length; j++) {
          if (used[j]) continue
          const o2 = list[j]
          if (Math.abs(o2.c - cur.c) > Math.max(2, 0.25 * Math.max(cur.t, o2.t))) continue
          if (Math.abs(o2.t - cur.t) > Math.max(3, 0.35 * Math.max(cur.t, o2.t))) continue
          const overlap = Math.min(cur.e, o2.e) - Math.max(cur.s, o2.s)
          let ok = false
          if (overlap >= -1) ok = true
          else {
            const gs = Math.min(cur.e, o2.e)
            const ge = Math.max(cur.s, o2.s)
            const g = ge - gs - 1
            if (g <= maxGap) {
              const half = Math.min(cur.t, o2.t) / 2
              const f =
                o === 'h'
                  ? fill(m, gs + 1, cur.c - half + 1, ge - 1, cur.c + half - 1)
                  : fill(m, cur.c - half + 1, gs + 1, cur.c + half - 1, ge - 1)
              ok = f >= 0.8
            }
          }
          if (!ok) continue
          const la = cur.e - cur.s + 1
          const lb = o2.e - o2.s + 1
          cur.c = (cur.c * la + o2.c * lb) / (la + lb)
          cur.t = (cur.t * la + o2.t * lb) / (la + lb)
          cur.tStd = Math.max(cur.tStd, o2.tStd)
          cur.s = Math.min(cur.s, o2.s)
          cur.e = Math.max(cur.e, o2.e)
          used[j] = true
          changed = true
        }
      }
      out.push(cur)
    }
  }
  return out
}

/** drop bands contained in a thicker parallel band (double detections) */
function dedupe(segs: Seg[]): Seg[] {
  return segs.filter((a) => {
    for (const b of segs) {
      if (a === b || a.orient !== b.orient) continue
      if (b.t < a.t || (b.t === a.t && b.e - b.s <= a.e - a.s)) continue
      if (Math.abs(a.c - b.c) <= b.t / 2 && a.s >= b.s - 2 && a.e <= b.e + 2) return false
    }
    return true
  })
}

function toCandidate(s: Seg, idx: number): WallCandidate {
  const len = s.e - s.s + 1
  const score = Math.max(0, Math.min(1, len / (6 * s.t)) * (1 - Math.min(1, s.tStd / Math.max(1, s.t))))
  const c = Math.round(s.c * 2) / 2
  const t = Math.round(s.t * 10) / 10
  if (s.orient === 'h') {
    return { id: `c${idx}`, orient: 'h', x1: s.s, y1: c, x2: s.e + 1, y2: c, thickness: t, length: len, score: Math.round(score * 100) / 100 }
  }
  return { id: `c${idx}`, orient: 'v', x1: c, y1: s.s, x2: c, y2: s.e + 1, thickness: t, length: len, score: Math.round(score * 100) / 100 }
}

/**
 * Snap end points: a band that stops at the face of a perpendicular band is extended to that band's
 * centre-line (T and L joins); the perpendicular band is extended when the join lies just past its end.
 */
function snapEnds(c: WallCandidate[], tol: number): void {
  const hs = c.filter((w) => w.orient === 'h')
  const vs = c.filter((w) => w.orient === 'v')
  const pass = (a: WallCandidate[], b: WallCandidate[], horizontal: boolean) => {
    for (const w of a) {
      for (const end of [1, 2] as const) {
        // along coordinate of this end and the across line
        const along = horizontal ? (end === 1 ? w.x1 : w.x2) : end === 1 ? w.y1 : w.y2
        const line = horizontal ? w.y1 : w.x1
        let best: WallCandidate | null = null
        let bestD = Number.POSITIVE_INFINITY
        for (const p of b) {
          const pLine = horizontal ? p.x1 : p.y1 // perpendicular band's across coordinate
          const pS = horizontal ? Math.min(p.y1, p.y2) : Math.min(p.x1, p.x2)
          const pE = horizontal ? Math.max(p.y1, p.y2) : Math.max(p.x1, p.x2)
          const d = Math.abs(pLine - along)
          if (d > p.thickness / 2 + tol) continue
          if (line < pS - w.thickness / 2 - tol || line > pE + w.thickness / 2 + tol) continue
          if (d < bestD) {
            bestD = d
            best = p
          }
        }
        if (!best) continue
        const pLine = horizontal ? best.x1 : best.y1
        if (horizontal) {
          if (end === 1) w.x1 = pLine
          else w.x2 = pLine
        } else if (end === 1) w.y1 = pLine
        else w.y2 = pLine
        // extend the perpendicular band to reach this band's centre line
        if (horizontal) {
          if (line < Math.min(best.y1, best.y2)) {
            if (best.y1 <= best.y2) best.y1 = line
            else best.y2 = line
          } else if (line > Math.max(best.y1, best.y2)) {
            if (best.y2 >= best.y1) best.y2 = line
            else best.y1 = line
          }
        } else if (line < Math.min(best.x1, best.x2)) {
          if (best.x1 <= best.x2) best.x1 = line
          else best.x2 = line
        } else if (line > Math.max(best.x1, best.x2)) {
          if (best.x2 >= best.x1) best.x2 = line
          else best.x1 = line
        }
      }
    }
  }
  pass(hs, vs, true)
  pass(vs, hs, false)
  for (const w of c) w.length = Math.round(Math.hypot(w.x2 - w.x1, w.y2 - w.y1))
}

/** 1-D clustering of thicknesses weighted by length (gaps > 25 % split clusters). */
export function clusterThickness(c: WallCandidate[]): ThicknessCluster[] {
  const sorted = [...c].sort((a, b) => a.thickness - b.thickness)
  const groups: WallCandidate[][] = []
  for (const w of sorted) {
    const g = groups[groups.length - 1]
    if (g && w.thickness <= g[g.length - 1].thickness * 1.25 + 1) g.push(w)
    else groups.push([w])
  }
  const clusters: ThicknessCluster[] = groups.map((g) => {
    // length-weighted median
    const tot = g.reduce((a, w) => a + w.length, 0)
    let acc = 0
    let tm = g[0].thickness
    for (const w of g) {
      acc += w.length
      if (acc >= tot / 2) {
        tm = w.thickness
        break
      }
    }
    return { thickness: Math.round(tm * 10) / 10, count: g.length, lengthPx: Math.round(tot) }
  })
  for (const w of c) {
    let bi = 0
    let bd = Number.POSITIVE_INFINITY
    clusters.forEach((cl, i) => {
      const d = Math.abs(cl.thickness - w.thickness)
      if (d < bd) {
        bd = d
        bi = i
      }
    })
    w.cluster = bi
  }
  return clusters
}

export interface WallExtractOptions {
  minThick: number
  maxThick: number
  /** minimum band length px (default 2·minThick) */
  minLen?: number
  /** missing columns tolerated inside a band (default 2) */
  gap?: number
  /** closing size to fill hollow double-line walls before opening (0 = off) */
  closePx?: number
}

export interface WallExtractResult {
  threshold: number
  walls: WallCandidate[]
  clusters: ThicknessCluster[]
  wallMask: Mask
}

export function extractWalls(g: Gray, opts: WallExtractOptions, threshold?: number): WallExtractResult {
  const t = threshold ?? otsu(g)
  let ink = binarize(g, t)
  if (opts.closePx && opts.closePx > 1) ink = close(ink, Math.round(opts.closePx))
  const wallMask = open(ink, Math.max(1, Math.round(opts.minThick)))
  const minLen = opts.minLen ?? Math.max(4, 2 * opts.minThick)
  const gap = opts.gap ?? 2
  let segs = [
    ...scanBands(wallMask, 'h', opts.minThick, opts.maxThick, gap, minLen),
    ...scanBands(wallMask, 'v', opts.minThick, opts.maxThick, gap, minLen),
  ]
  segs = mergeCollinear(segs, wallMask, opts.maxThick + 4)
  segs = dedupe(segs)
  segs.sort((a, b) => b.e - b.s - (a.e - a.s))
  const walls = segs.map((s, i) => toCandidate(s, i + 1))
  snapEnds(walls, Math.max(3, opts.minThick))
  const clusters = clusterThickness(walls)
  return { threshold: t, walls, clusters, wallMask }
}

// ───────────────────────── deskew ─────────────────────────

/**
 * Projection-profile skew estimate. Returns the angle (degrees, clockwise-positive in y-down image
 * coordinates) at which the dominant horizontal/vertical lines of the drawing lie.
 * Rotate the image by −angle to straighten it.
 */
export function estimateSkew(g: Gray, maxDeg = 5, stepDeg = 0.1): { angle: number; confidence: number } {
  const t = otsu(g)
  const pts: number[] = []
  const { width: w, height: h, data } = g
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x] <= t) pts.push(x, y)
  const n = pts.length / 2
  if (n < 50) return { angle: 0, confidence: 0 }
  const stride = n > 150_000 ? Math.ceil(n / 150_000) : 1
  const diag = Math.ceil(Math.hypot(w, h)) + 2
  const binsY = new Float64Array(diag * 2)
  const binsX = new Float64Array(diag * 2)
  const scores: { a: number; s: number }[] = []
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += stepDeg) {
    const r = (a * Math.PI) / 180
    const cs = Math.cos(r)
    const sn = Math.sin(r)
    binsY.fill(0)
    binsX.fill(0)
    for (let i = 0; i < n; i += stride) {
      const x = pts[2 * i]
      const y = pts[2 * i + 1]
      binsY[Math.round(y * cs - x * sn) + diag]++
      binsX[Math.round(x * cs + y * sn) + diag]++
    }
    let s = 0
    for (let i = 0; i < binsY.length; i++) s += binsY[i] * binsY[i] + binsX[i] * binsX[i]
    scores.push({ a: Math.round(a * 100) / 100, s })
  }
  scores.sort((p, q) => q.s - p.s)
  const best = scores[0]
  const zero = scores.find((p) => Math.abs(p.a) < 1e-6)
  const confidence = zero && best.s > 0 ? Math.min(1, (best.s - zero.s) / best.s + 0.5) : 0.5
  return { angle: best.a, confidence: Math.round(confidence * 100) / 100 }
}

// ───────────────────────── mask compare ─────────────────────────

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface MaskDiff {
  iou: number
  /** fraction of source walls covered by the plan */
  recall: number
  /** fraction of plan walls that lie on source walls */
  precision: number
  /** regions with source walls the plan does not have (px boxes) */
  missing: Box[]
  /** regions where the plan has walls the source does not */
  extra: Box[]
}

function regions(diff: Uint8Array, w: number, h: number, cell: number, minFrac: number): Box[] {
  const cw = Math.ceil(w / cell)
  const chh = Math.ceil(h / cell)
  const flag = new Uint8Array(cw * chh)
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let n = 0
      let on = 0
      for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y++) {
        for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x++) {
          n++
          on += diff[y * w + x]
        }
      }
      if (n && on / n >= minFrac) flag[cy * cw + cx] = 1
    }
  }
  const seen = new Uint8Array(flag.length)
  const boxes: (Box & { cells: number })[] = []
  for (let i = 0; i < flag.length; i++) {
    if (!flag[i] || seen[i]) continue
    const stack = [i]
    seen[i] = 1
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = -1
    let maxY = -1
    let cells = 0
    while (stack.length) {
      const k = stack.pop() as number
      const kx = k % cw
      const ky = (k - kx) / cw
      cells++
      minX = Math.min(minX, kx)
      maxX = Math.max(maxX, kx)
      minY = Math.min(minY, ky)
      maxY = Math.max(maxY, ky)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = kx + dx
        const ny = ky + dy
        if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue
        const ni = ny * cw + nx
        if (flag[ni] && !seen[ni]) {
          seen[ni] = 1
          stack.push(ni)
        }
      }
    }
    if (cells < 2) continue
    boxes.push({
      x: minX * cell,
      y: minY * cell,
      w: Math.min(w, (maxX + 1) * cell) - minX * cell,
      h: Math.min(h, (maxY + 1) * cell) - minY * cell,
      cells,
    })
  }
  boxes.sort((a, b) => b.cells - a.cells)
  return boxes.slice(0, 12).map(({ x, y, w: bw, h: bh }) => ({ x, y, w: bw, h: bh }))
}

/** Compare source wall mask with rendered plan wall mask (same size). */
export function compareMasks(source: Mask, plan: Mask, cell = 16): MaskDiff {
  const n = source.data.length
  let inter = 0
  let uni = 0
  let s = 0
  let p = 0
  const missing = new Uint8Array(n)
  const extra = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const a = source.data[i]
    const b = plan.data[i]
    s += a
    p += b
    if (a && b) inter++
    if (a || b) uni++
    if (a && !b) missing[i] = 1
    if (b && !a) extra[i] = 1
  }
  const r = (v: number) => Math.round(v * 1000) / 1000
  return {
    iou: r(uni ? inter / uni : 0),
    recall: r(s ? inter / s : 0),
    precision: r(p ? inter / p : 0),
    missing: regions(missing, source.width, source.height, cell, 0.3),
    extra: regions(extra, source.width, source.height, cell, 0.3),
  }
}

/** default minimum wall thickness in px for an image of this size (text strokes are thinner) */
export function autoMinThick(w: number, h: number): number {
  return Math.max(3, Math.round(Math.max(w, h) * 0.003))
}

export function autoMaxThick(w: number, h: number): number {
  return Math.max(12, Math.round(Math.max(w, h) / 12))
}
