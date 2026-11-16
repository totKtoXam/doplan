import { Graphics } from 'pixi.js'
import type { CurtainSpec, DoorSlide, Opening, OpeningKind } from '@core/types'
import { type EditorCtx, sameInputs } from '../context'
import { frameOfOpening, framePoint } from '../shapes'

/** line work of an opening symbol, as flat segment lists [x1,y1,x2,y2,…] in the target space */
export interface SymbolOut {
  /** frame, jambs, leaves */
  main: number[]
  /** swing arcs and other light lines */
  thin: number[]
  glass: number[]
  curtain: number[]
}

export function emptySymbol(): SymbolOut {
  return { main: [], thin: [], glass: [], curtain: [] }
}

export interface SymbolSpec {
  kind: OpeningKind
  width: number
  hinge: 'a' | 'b'
  swing: 'left' | 'right'
  sashes?: number
  curtain?: CurtainSpec
  slide?: DoorSlide
}

type Tf = (s: number, k: number) => { x: number; y: number }

const WINDOW_KINDS: ReadonlySet<OpeningKind> = new Set<OpeningKind>(['window', 'frenchWindow', 'balconyBlock'])

export function isWindowKind(kind: OpeningKind): boolean {
  return WINDOW_KINDS.has(kind)
}

/**
 * Builds the plan symbol of an opening in its local frame (s along the wall a→b, k along the
 * left normal; h = half wall thickness) and pushes transformed segments into `out`.
 */
export function buildOpeningSymbol(spec: SymbolSpec, h: number, tf: Tf, out: SymbolOut): void {
  const w = spec.width
  const w2 = w / 2
  const sg = spec.swing === 'left' ? 1 : -1
  const hs = spec.hinge === 'a' ? -1 : 1

  const seg = (arr: number[], s1: number, k1: number, s2: number, k2: number): void => {
    const a = tf(s1, k1)
    const b = tf(s2, k2)
    arr.push(a.x, a.y, b.x, b.y)
  }
  const dashed = (arr: number[], s1: number, k1: number, s2: number, k2: number, dash = 90, gap = 70): void => {
    const l = Math.hypot(s2 - s1, k2 - k1)
    if (l < 1) return
    const us = (s2 - s1) / l
    const uk = (k2 - k1) / l
    for (let d = 0; d < l; d += dash + gap) {
      const e = Math.min(l, d + dash)
      seg(arr, s1 + us * d, k1 + uk * d, s1 + us * e, k1 + uk * e)
    }
  }
  /** leaf hinged at s = hingeS, closing towards dirS, drawn open at 90° into the swing side */
  const leaf = (hingeS: number, dirS: number, length: number, thick: boolean): void => {
    seg(out.main, hingeS, sg * h, hingeS, sg * (h + length))
    if (thick) {
      const t = Math.min(45, length * 0.06)
      seg(out.main, hingeS + dirS * t, sg * h, hingeS + dirS * t, sg * (h + length))
      seg(out.main, hingeS, sg * (h + length), hingeS + dirS * t, sg * (h + length))
    }
    const steps = 14
    let ps = hingeS
    let pk = sg * (h + length)
    for (let i = 1; i <= steps; i++) {
      const th = (i / steps) * (Math.PI / 2)
      const s = hingeS + dirS * length * Math.sin(th)
      const k = sg * (h + length * Math.cos(th))
      seg(out.thin, ps, pk, s, k)
      ps = s
      pk = k
    }
  }
  const jambs = (s1: number, s2: number): void => {
    seg(out.main, s1, -h, s1, h)
    seg(out.main, s2, -h, s2, h)
  }
  const windowPart = (s1: number, s2: number, sashes: number): void => {
    seg(out.main, s1, -h, s2, -h)
    seg(out.main, s1, h, s2, h)
    const gk = h / 3
    seg(out.glass, s1, -gk, s2, -gk)
    seg(out.glass, s1, gk, s2, gk)
    const n = Math.max(1, Math.min(8, Math.round(sashes)))
    for (let i = 1; i < n; i++) {
      const s = s1 + ((s2 - s1) * i) / n
      seg(out.main, s, -gk, s, gk)
    }
  }

  jambs(-w2, w2)
  switch (spec.kind) {
    case 'door':
      leaf(hs * w2, -hs, w, false)
      break
    case 'entranceDoor':
      leaf(hs * w2, -hs, w, true)
      break
    case 'balconyDoor':
      leaf(hs * w2, -hs, w, false)
      seg(out.glass, -w2, 0, w2, 0)
      break
    case 'doubleDoor':
      leaf(-w2, 1, w2, false)
      leaf(w2, -1, w2, false)
      break
    case 'slidingDoor': {
      const slide = spec.slide ?? 'surface'
      if (slide === 'pocket') {
        // leaf in the wall axis, slid 30 % into the pocket (dashed cavity inside the wall)
        const sh = hs * w * 0.3
        const t = Math.min(20, h * 0.4)
        const a = Math.max(-w2, -w2 + sh)
        const b = Math.min(w2, w2 + sh)
        seg(out.main, a, -t, b, -t)
        seg(out.main, a, t, b, t)
        seg(out.main, hs > 0 ? a : b, -t, hs > 0 ? a : b, t)
        const p0 = hs * w2
        const p1 = hs * (w2 + w)
        dashed(out.thin, p0, -t - 6, p1, -t - 6, 60, 50)
        dashed(out.thin, p0, t + 6, p1, t + 6, 60, 50)
        seg(out.thin, p1, -t - 6, p1, t + 6)
        break
      }
      if (slide === 'barn') {
        // wide leaf on the wall face + the rail it hangs on
        const sh = hs * w * 0.3
        const k0 = sg * (h + 20)
        const k1 = sg * (h + 55)
        const a = -w2 - 50 + sh
        const b = w2 + 50 + sh
        seg(out.main, a, k0, b, k0)
        seg(out.main, a, k1, b, k1)
        seg(out.main, a, k0, a, k1)
        seg(out.main, b, k0, b, k1)
        const r0 = hs < 0 ? -w2 - w - 100 : -w2 - 100
        const r1 = hs < 0 ? w2 + 100 : w2 + w + 100
        dashed(out.thin, r0, sg * (h + 10), r1, sg * (h + 10), 80, 50)
        break
      }
      if (slide === 'folding') {
        // accordion panels, half folded towards the hinge side
        const n = w <= 700 ? 4 : w <= 1000 ? 6 : 8
        const pw = w / n
        const ang = 0.5
        let s = hs * w2
        let k = -(pw * Math.sin(ang)) / 2
        for (let i = 0; i < n; i++) {
          const up = i % 2 === 0 ? 1 : -1
          const s2 = s - hs * pw * Math.cos(ang)
          const k2 = k + up * pw * Math.sin(ang)
          seg(out.main, s, k, s2, k2)
          s = s2
          k = k2
        }
        break
      }
      const k = h * 0.35
      seg(out.main, -w2, k, w2 * 0.12, k)
      seg(out.main, -w2 * 0.12, -k, w2, -k)
      // arrow showing the sliding direction
      const ak = sg * (h + 90)
      seg(out.thin, -w2 * 0.5, ak, w2 * 0.5, ak)
      seg(out.thin, w2 * 0.5, ak, w2 * 0.5 - 70, ak + 45)
      seg(out.thin, w2 * 0.5, ak, w2 * 0.5 - 70, ak - 45)
      break
    }
    case 'arch':
      dashed(out.main, -w2, -h, w2, -h)
      dashed(out.main, -w2, h, w2, h)
      break
    case 'opening':
      dashed(out.thin, -w2, -h, w2, -h, 60, 90)
      dashed(out.thin, -w2, h, w2, h, 60, 90)
      break
    case 'window':
      windowPart(-w2, w2, spec.sashes ?? Math.max(1, Math.round(w / 700)))
      break
    case 'frenchWindow':
      windowPart(-w2, w2, spec.sashes ?? 2)
      // floor-to-ceiling glazing that opens: light swing arcs of both leaves
      {
        const saved = out.main
        out.main = out.thin
        leaf(-w2, 1, w2, false)
        leaf(w2, -1, w2, false)
        out.main = saved
      }
      break
    case 'balconyBlock': {
      const dw = Math.min(800, Math.max(600, w * 0.4))
      const doorFrom = hs * w2
      const doorTo = doorFrom - hs * dw
      seg(out.main, doorTo, -h, doorTo, h)
      seg(out.glass, Math.min(doorFrom, doorTo), 0, Math.max(doorFrom, doorTo), 0)
      leaf(doorFrom, -hs, dw, false)
      if (hs < 0) windowPart(doorTo, w2, spec.sashes ?? 2)
      else windowPart(-w2, doorTo, spec.sashes ?? 2)
      break
    }
    default:
      break
  }

  const c = spec.curtain
  if (c && c.kind !== 'none') {
    const side = c.side === 'left' ? 1 : -1
    const k0 = side * (h + 70)
    const from = -w2 - Math.max(0, c.overhang)
    const to = w2 + Math.max(0, c.overhang)
    if (c.kind === 'roman' || c.kind === 'roller' || c.kind === 'blinds') {
      seg(out.curtain, from, k0, to, k0)
      seg(out.curtain, from, k0 + side * 30, to, k0 + side * 30)
    } else {
      // wavy drape line; the open share is drawn as two bunches at the sides
      const amp = 35
      const wave = 150
      const total = to - from
      const closed = Math.min(1, Math.max(0.15, c.closed))
      const half = (total * closed) / 2
      const ranges: [number, number][] = closed >= 0.98 ? [[from, to]] : [
        [from, from + half],
        [to - half, to],
      ]
      for (const [r0, r1] of ranges) {
        const n = Math.max(2, Math.ceil((r1 - r0) / (wave / 4)))
        let ps = r0
        let pk = k0
        for (let i = 1; i <= n; i++) {
          const s = r0 + ((r1 - r0) * i) / n
          const k = k0 + side * amp * Math.abs(Math.sin(((s - r0) / wave) * Math.PI * 2))
          seg(out.curtain, ps, pk, s, k)
          ps = s
          pk = k
        }
      }
      if (c.kind === 'drapesAndSheer' || c.kind === 'sheer') seg(out.curtain, from, k0 - side * 25, to, k0 - side * 25)
    }
  }
}

function strokeSegments(g: Graphics, segs: readonly number[], color: number, alpha = 1): void {
  if (segs.length < 4) return
  for (let i = 0; i + 3 < segs.length; i += 4) g.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3])
  g.stroke({ width: 1, color, alpha, pixelLine: true })
}

export function symbolSpecOf(o: Opening): SymbolSpec {
  return { kind: o.kind, width: o.width, hinge: o.hinge, swing: o.swing, sashes: o.sashes, curtain: o.curtain, slide: o.slide }
}

/** Door / window symbols of the active level (world space, hairlines). */
export class OpeningsLayer {
  readonly g = new Graphics()
  private key: unknown[] = []

  constructor() {
    this.g.eventMode = 'none'
  }

  update(ctx: EditorCtx): void {
    const { doc, derived } = ctx.view()
    const pal = ctx.palette()
    const key = [derived.wallGeoms, doc.walls, doc.openings, pal]
    if (sameInputs(key, this.key)) return
    this.key = key
    const g = this.g
    g.clear()
    const out = emptySymbol()
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (!derived.wallGeoms[o.wallId]) continue
      const f = frameOfOpening(doc, derived, o)
      if (!f) continue
      buildOpeningSymbol(symbolSpecOf(o), f.h, (s, k) => framePoint(f, s, k), out)
    }
    strokeSegments(g, out.thin, pal.opening, 0.55)
    strokeSegments(g, out.glass, pal.glass, 1)
    strokeSegments(g, out.curtain, pal.curtain, 0.95)
    strokeSegments(g, out.main, pal.opening, 1)
  }

  destroy(): void {
    this.g.destroy()
  }
}
