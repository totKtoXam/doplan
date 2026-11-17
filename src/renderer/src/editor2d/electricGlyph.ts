/**
 * Electrical point symbols in the 2D editor: the same ГОСТ primitives the drawings use
 * (core/electrical), drawn in screen space at a size that stays readable at any zoom.
 */
import { electricFrame, electricPointSymbol } from '@core'
import type { ElectricPoint } from '@core/types'
import type { Camera } from './view'
import type { Painter } from './painter'

/** px per symbol unit (the radius of a socket semicircle) */
export function electricUnitPx(cam: Pick<Camera, 'scale'>): number {
  return Math.min(10, Math.max(4.5, 40 * cam.scale))
}

/** radius in px of a ring around the symbol (selection / hover) */
export function electricRingPx(cam: Pick<Camera, 'scale'>, p: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical' | 'mount'>): number {
  const box = electricPointSymbol(p).box
  const ext = Math.max(Math.abs(box.minX), Math.abs(box.maxX), Math.abs(box.minY), Math.abs(box.maxY))
  return ext * electricUnitPx(cam) + 4
}

export interface GlyphStyle {
  color: number
  alpha?: number
  width?: number
}

/** draws the plan symbol of a point (or a preview of one) */
export function drawElectricGlyph(p: Painter, e: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical' | 'mount' | 'x' | 'y' | 'rotation'>, st: GlyphStyle): void {
  const g = p.g
  const u = electricUnitPx(p.cam)
  const o = p.S(e)
  const { ux, uy, theta } = electricFrame(e.rotation)
  const S = (q: { x: number; y: number }) => ({ x: o.x + (ux.x * q.x + uy.x * q.y) * u, y: o.y + (ux.y * q.x + uy.y * q.y) * u })
  const alpha = st.alpha ?? 1
  const width = st.width ?? 1.4
  const stroke = { width, color: st.color, alpha }
  const fill = { color: st.color, alpha }
  for (const q of electricPointSymbol(e).prims) {
    switch (q.t) {
      case 'line': {
        const a = S(q.a)
        const b = S(q.b)
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke(stroke)
        break
      }
      case 'circle': {
        const c = S(q.c)
        g.circle(c.x, c.y, q.r * u)
        if (q.fill) g.fill(fill)
        g.circle(c.x, c.y, q.r * u).stroke(stroke)
        break
      }
      case 'poly': {
        const flat: number[] = []
        for (const v of q.pts) {
          const s = S(v)
          flat.push(s.x, s.y)
        }
        if (q.fill && q.pts.length >= 3) g.poly(flat, true).fill(fill)
        g.poly(flat, q.closed).stroke(stroke)
        break
      }
      case 'arc': {
        const c = S(q.c)
        const a0 = ((q.a0 + theta) * Math.PI) / 180
        const a1 = ((q.a1 + theta) * Math.PI) / 180
        const r = q.r * u
        g.moveTo(c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r)
          .arc(c.x, c.y, r, a0, a1)
          .stroke(stroke)
        break
      }
    }
  }
}
