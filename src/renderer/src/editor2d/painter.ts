/**
 * Screen-space immediate-mode drawing: one Graphics that is cleared every frame plus a pool of
 * Pixi Text objects (canvas-rasterised at devicePixelRatio, so Cyrillic is always crisp).
 */
import { Container, type Graphics, Text } from 'pixi.js'
import type { Vec2 } from '@core/types'
import type { Camera } from './view'
import type { Palette } from './theme'

const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif'

export interface TextOpts {
  size?: number
  color?: number
  anchorX?: number
  anchorY?: number
  rotation?: number
  bold?: boolean
  italic?: boolean
  alpha?: number
  align?: 'left' | 'center' | 'right'
  /** a ring of this colour round the glyphs (the plan colour), so the text reads on any fill under it */
  halo?: number
}

function textStyle(raster: number, color: number, o: TextOpts) {
  return {
    fontFamily: FONT,
    fontSize: raster,
    fill: color,
    fontWeight: o.bold ? ('600' as const) : ('400' as const),
    fontStyle: o.italic ? ('italic' as const) : ('normal' as const),
    align: o.align ?? 'left',
    ...(o.halo !== undefined ? { stroke: { color: o.halo, width: Math.max(2, raster * 0.32), join: 'round' as const } } : {}),
  }
}

interface PoolEntry {
  text: Text
  used: boolean
  idle: number
  sig: string
  str: string
}

/** rasterisation size: exact for small text, power-of-two buckets for large (scaled down → crisp) */
function rasterSize(size: number): number {
  if (size <= 28) return Math.max(6, Math.round(size))
  let r = 28
  while (r < size && r < 224) r *= 2
  return r
}

export class TextPool {
  readonly container = new Container()
  private entries = new Map<string, PoolEntry>()
  resolution = 1

  begin(): void {
    for (const e of this.entries.values()) e.used = false
  }

  put(key: string, str: string, x: number, y: number, o: TextOpts = {}): Text {
    const size = o.size ?? 12
    const raster = rasterSize(size)
    const color = o.color ?? 0xffffff
    const align = o.align ?? 'left'
    const sig = `${raster}|${color}|${o.bold ? 1 : 0}|${o.italic ? 1 : 0}|${this.resolution}|${align}|${o.halo ?? ''}`
    let e = this.entries.get(key)
    if (!e) {
      const text = new Text({
        text: str,
        style: textStyle(raster, color, o),
        resolution: this.resolution,
      })
      text.eventMode = 'none'
      this.container.addChild(text)
      e = { text, used: true, idle: 0, sig, str }
      this.entries.set(key, e)
    } else {
      if (e.sig !== sig) {
        e.text.style = textStyle(raster, color, o)
        e.text.resolution = this.resolution
        e.sig = sig
      }
      if (e.str !== str) {
        e.text.text = str
        e.str = str
      }
    }
    e.used = true
    e.idle = 0
    const t = e.text
    t.visible = true
    t.anchor.set(o.anchorX ?? 0.5, o.anchorY ?? 0.5)
    const rotation = o.rotation ?? 0
    t.rotation = rotation
    if (rotation === 0) t.position.set(Math.round(x), Math.round(y))
    else t.position.set(x, y)
    t.scale.set(size / raster)
    t.alpha = o.alpha ?? 1
    return t
  }

  end(): void {
    for (const [key, e] of this.entries) {
      if (e.used) continue
      e.text.visible = false
      e.idle++
      if (e.idle > 90) {
        e.text.destroy()
        this.entries.delete(key)
      }
    }
  }

  destroy(): void {
    for (const e of this.entries.values()) e.text.destroy()
    this.entries.clear()
    this.container.destroy()
  }
}

export interface PolyStyle {
  fill?: number
  fillAlpha?: number
  stroke?: number
  strokeAlpha?: number
  width?: number
  dashed?: boolean
}

export class Painter {
  private auto = 0

  constructor(
    public g: Graphics,
    public texts: TextPool,
    public cam: Camera,
    public pal: Palette,
  ) {}

  begin(pal: Palette): void {
    this.pal = pal
    this.auto = 0
    this.g.clear()
    this.texts.begin()
  }

  end(): void {
    this.texts.end()
  }

  /** unique key for throw-away texts of the current frame */
  autoKey(prefix: string): string {
    return `${prefix}#${this.auto++}`
  }

  S(p: Vec2): Vec2 {
    return this.cam.toScreen(p)
  }

  // ── lines ──

  sline(ax: number, ay: number, bx: number, by: number, color: number, width = 1, alpha = 1): void {
    this.g.moveTo(ax, ay).lineTo(bx, by).stroke({ width, color, alpha })
  }

  line(a: Vec2, b: Vec2, color: number, width = 1, alpha = 1): void {
    const A = this.S(a)
    const B = this.S(b)
    this.sline(A.x, A.y, B.x, B.y, color, width, alpha)
  }

  private dashPath(ax: number, ay: number, bx: number, by: number, dash: number, gap: number): boolean {
    const dx = bx - ax
    const dy = by - ay
    const l = Math.hypot(dx, dy)
    if (l < 0.5) return false
    const ux = dx / l
    const uy = dy / l
    const period = dash + gap
    const n = Math.min(400, Math.ceil(l / period))
    const step = l / n > period ? l / n : period
    for (let i = 0; i < n; i++) {
      const s = i * step
      const e = Math.min(l, s + dash)
      if (s >= l) break
      this.g.moveTo(ax + ux * s, ay + uy * s).lineTo(ax + ux * e, ay + uy * e)
    }
    return true
  }

  sdashed(ax: number, ay: number, bx: number, by: number, color: number, width = 1, alpha = 1, dash = 6, gap = 4): void {
    if (this.dashPath(ax, ay, bx, by, dash, gap)) this.g.stroke({ width, color, alpha })
  }

  dashed(a: Vec2, b: Vec2, color: number, width = 1, alpha = 1, dash = 6, gap = 4): void {
    const A = this.S(a)
    const B = this.S(b)
    this.sdashed(A.x, A.y, B.x, B.y, color, width, alpha, dash, gap)
  }

  /** flat list of plan-space segments [x1,y1,x2,y2,…] */
  segments(flat: readonly number[], color: number, width = 1, alpha = 1): void {
    if (flat.length < 4) return
    const { scale, tx, ty } = this.cam
    for (let i = 0; i + 3 < flat.length; i += 4) {
      this.g.moveTo(flat[i] * scale + tx, flat[i + 1] * scale + ty).lineTo(flat[i + 2] * scale + tx, flat[i + 3] * scale + ty)
    }
    this.g.stroke({ width, color, alpha })
  }

  polyline(pts: readonly Vec2[], color: number, width = 1, alpha = 1, closed = false): void {
    if (pts.length < 2) return
    const flat: number[] = []
    for (const p of pts) {
      const s = this.S(p)
      flat.push(s.x, s.y)
    }
    this.g.poly(flat, closed).stroke({ width, color, alpha })
  }

  polygon(pts: readonly Vec2[], st: PolyStyle): void {
    if (pts.length < 2) return
    const flat: number[] = []
    for (const p of pts) {
      const s = this.S(p)
      flat.push(s.x, s.y)
    }
    if (st.fill !== undefined && pts.length >= 3) {
      this.g.poly(flat, true).fill({ color: st.fill, alpha: st.fillAlpha ?? 1 })
    }
    if (st.stroke !== undefined) {
      const width = st.width ?? 1
      const alpha = st.strokeAlpha ?? 1
      if (st.dashed) {
        let any = false
        for (let i = 0; i < flat.length; i += 2) {
          const j = (i + 2) % flat.length
          any = this.dashPath(flat[i], flat[i + 1], flat[j], flat[j + 1], 6, 4) || any
        }
        if (any) this.g.stroke({ width, color: st.stroke, alpha })
      } else {
        this.g.poly(flat, true).stroke({ width, color: st.stroke, alpha })
      }
    }
  }

  // ── glyphs (plan position, screen size) ──

  square(p: Vec2, sizePx: number, fill: number, stroke: number, width = 1.5): void {
    const s = this.S(p)
    const h = sizePx / 2
    this.g.rect(Math.round(s.x - h) + 0.5, Math.round(s.y - h) + 0.5, sizePx, sizePx).fill({ color: fill }).stroke({ width, color: stroke })
  }

  disc(p: Vec2, rPx: number, fill: number, stroke?: number, width = 1.5, alpha = 1): void {
    const s = this.S(p)
    this.g.circle(s.x, s.y, rPx).fill({ color: fill, alpha })
    if (stroke !== undefined) this.g.circle(s.x, s.y, rPx).stroke({ width, color: stroke })
  }

  ring(p: Vec2, rPx: number, color: number, width = 1.5, alpha = 1): void {
    const s = this.S(p)
    this.g.circle(s.x, s.y, rPx).stroke({ width, color, alpha })
  }

  cross(p: Vec2, sizePx: number, color: number, width = 1.5): void {
    const s = this.S(p)
    this.g
      .moveTo(s.x - sizePx, s.y - sizePx)
      .lineTo(s.x + sizePx, s.y + sizePx)
      .moveTo(s.x - sizePx, s.y + sizePx)
      .lineTo(s.x + sizePx, s.y - sizePx)
      .stroke({ width, color })
  }

  diamond(p: Vec2, sizePx: number, color: number, width = 1.5): void {
    const s = this.S(p)
    this.g
      .poly([s.x, s.y - sizePx, s.x + sizePx, s.y, s.x, s.y + sizePx, s.x - sizePx, s.y], true)
      .stroke({ width, color })
  }

  triangle(p: Vec2, sizePx: number, color: number, width = 1.5): void {
    const s = this.S(p)
    this.g
      .poly([s.x, s.y - sizePx, s.x + sizePx, s.y + sizePx * 0.8, s.x - sizePx, s.y + sizePx * 0.8], true)
      .stroke({ width, color })
  }

  // ── text ──

  stext(key: string, str: string, x: number, y: number, o?: TextOpts): Text {
    return this.texts.put(key, str, x, y, o)
  }

  text(key: string, str: string, p: Vec2, o?: TextOpts & { dx?: number; dy?: number }): Text {
    const s = this.S(p)
    return this.texts.put(key, str, s.x + (o?.dx ?? 0), s.y + (o?.dy ?? 0), o)
  }

  /** text on a rounded dark plate; (x, y) is the plate centre in screen px */
  sbadge(key: string, str: string, x: number, y: number, o?: { bg?: number; color?: number; size?: number; bgAlpha?: number }): void {
    const size = o?.size ?? 12
    const t = this.texts.put(key, str, x, y, { size, color: o?.color ?? this.pal.badgeText, bold: true })
    const w = t.width + 12
    const h = size + 9
    const cx = Math.round(x)
    const cy = Math.round(y)
    this.g.roundRect(cx - w / 2, cy - h / 2, w, h, 5).fill({ color: o?.bg ?? this.pal.badgeBg, alpha: o?.bgAlpha ?? 0.92 })
  }

  badge(
    key: string,
    str: string,
    p: Vec2,
    o?: { dx?: number; dy?: number; bg?: number; color?: number; size?: number; bgAlpha?: number },
  ): void {
    const s = this.S(p)
    this.sbadge(key, str, s.x + (o?.dx ?? 0), s.y + (o?.dy ?? 0), o)
  }

  /**
   * Dimension line between plan points a and b, shifted by `offsetMm` along unit normal `n`
   * plus `offsetPx` screen px. The text is rotated along the line and always stays readable: it has a
   * halo of the plan colour, as dimensions often sit inside rooms whose floor may be of any colour.
   */
  dimension(
    key: string,
    a: Vec2,
    b: Vec2,
    n: Vec2,
    offsetMm: number,
    offsetPx: number,
    label: string,
    o: {
      color: number
      alpha?: number
      /** of the line and ticks alone (the number keeps `alpha`) */
      lineAlpha?: number
      size?: number
      width?: number
      extension?: boolean
      bold?: boolean
      italic?: boolean
    },
  ): void {
    const sa = this.S(a)
    const sb = this.S(b)
    const off = offsetMm * this.cam.scale + offsetPx
    const A = { x: sa.x + n.x * off, y: sa.y + n.y * off }
    const B = { x: sb.x + n.x * off, y: sb.y + n.y * off }
    const dx = B.x - A.x
    const dy = B.y - A.y
    const l = Math.hypot(dx, dy)
    if (l < 2) return
    const ux = dx / l
    const uy = dy / l
    const alpha = o.alpha ?? 1
    const width = o.width ?? 1
    const g = this.g
    g.moveTo(A.x, A.y).lineTo(B.x, B.y)
    if (o.extension !== false && Math.abs(off) > 3) {
      const sgn = off >= 0 ? 1 : -1
      g.moveTo(sa.x + n.x * sgn * 2, sa.y + n.y * sgn * 2).lineTo(A.x + n.x * sgn * 4, A.y + n.y * sgn * 4)
      g.moveTo(sb.x + n.x * sgn * 2, sb.y + n.y * sgn * 2).lineTo(B.x + n.x * sgn * 4, B.y + n.y * sgn * 4)
    }
    // 45° ticks
    const tx = (ux + uy) * 4
    const ty = (uy - ux) * 4
    g.moveTo(A.x - tx, A.y - ty).lineTo(A.x + tx, A.y + ty)
    g.moveTo(B.x - tx, B.y - ty).lineTo(B.x + tx, B.y + ty)
    g.stroke({ width, color: o.color, alpha: o.lineAlpha ?? alpha })
    let ang = Math.atan2(dy, dx)
    if (ang > Math.PI / 2 + 1e-6 || ang <= -Math.PI / 2 + 1e-6) ang += Math.PI
    // "above" the line in the text's own frame
    const nx = Math.sin(ang)
    const ny = -Math.cos(ang)
    this.texts.put(key, label, (A.x + B.x) / 2 + nx * 3, (A.y + B.y) / 2 + ny * 3, {
      size: o.size ?? 11,
      color: o.color,
      alpha,
      rotation: ang,
      anchorX: 0.5,
      anchorY: 1,
      bold: o.bold,
      italic: o.italic,
      halo: this.pal.bg,
    })
  }
}
