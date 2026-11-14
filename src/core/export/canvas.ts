/**
 * Display list → any CanvasRenderingContext2D-like target (browser canvas, OffscreenCanvas,
 * @napi-rs/canvas / skia-canvas in the CLI). Pure TS: the context is typed structurally.
 *
 * Mapping: screen = world * pxPerMm + offset. Default offset puts the bounds' top-left at (0, 0).
 */
import type { DisplayItem, DisplayList, DlFill, DlPen } from '../display'

/** The subset of CanvasRenderingContext2D used here. */
export interface Canvas2DLike {
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  rect(x: number, y: number, w: number, h: number): void
  fill(rule?: 'nonzero' | 'evenodd'): void
  stroke(): void
  clip(rule?: 'nonzero' | 'evenodd'): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  translate(x: number, y: number): void
  rotate(rad: number): void
  setLineDash(segments: number[]): void
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
}

export interface CanvasDrawOptions {
  /** device pixels per WORLD millimetre */
  pxPerMm: number
  offsetX?: number
  offsetY?: number
  /** fill the drawn area first ('none' = transparent); default dl.background */
  background?: string
  /** 1:scale for pen widths (paper mm → world mm); default dl.scale */
  scale?: number
  /** fill area for the background, px; default = bounds size */
  width?: number
  height?: number
  fontFamily?: string
  /** minimum stroke width, px; default 0.75 */
  minLineWidthPx?: number
}

export function drawToCanvas(ctx: Canvas2DLike, dl: DisplayList, opts: CanvasDrawOptions): void {
  const k = opts.pxPerMm
  const S = opts.scale && opts.scale > 0 ? opts.scale : dl.scale || 100
  const ox = opts.offsetX ?? -dl.bounds.minX * k
  const oy = opts.offsetY ?? -dl.bounds.minY * k
  const X = (x: number) => x * k + ox
  const Y = (y: number) => y * k + oy
  const minW = opts.minLineWidthPx ?? 0.75
  const font = opts.fontFamily ?? "Inter, 'Segoe UI', Arial, sans-serif"

  ctx.save()
  const bg = opts.background ?? dl.background
  if (bg && bg !== 'none' && bg !== 'transparent') {
    ctx.fillStyle = bg
    const w = opts.width ?? (dl.bounds.maxX - dl.bounds.minX) * k
    const h = opts.height ?? (dl.bounds.maxY - dl.bounds.minY) * k
    const bx = opts.width != null ? 0 : X(dl.bounds.minX)
    const by = opts.height != null ? 0 : Y(dl.bounds.minY)
    ctx.fillRect(bx, by, w, h)
  }
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'

  const setPen = (p: DlPen): void => {
    ctx.strokeStyle = p.color
    ctx.lineWidth = Math.max(minW, p.width * S * k)
    ctx.setLineDash(p.dash && p.dash.length ? p.dash.map((d) => Math.max(0.5, d * S * k)) : [])
  }
  const ring = (pts: { x: number; y: number }[]) => {
    if (!pts.length) return
    ctx.moveTo(X(pts[0].x), Y(pts[0].y))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y))
    ctx.closePath()
  }
  const hatch = (f: DlFill, minX: number, minY: number, maxX: number, maxY: number): void => {
    const hz = f.hatch!
    const sp = Math.max(1.5, hz.spacing * S * k)
    const a = (hz.angle * Math.PI) / 180
    // lines parallel to direction `u` are spaced along `n`
    const u = { x: Math.sin(a) * -1, y: Math.cos(a) }
    const n = { x: Math.cos(a), y: Math.sin(a) }
    const cx = (X(minX) + X(maxX)) / 2
    const cy = (Y(minY) + Y(maxY)) / 2
    const half = Math.hypot(X(maxX) - X(minX), Y(maxY) - Y(minY)) / 2 + sp
    ctx.strokeStyle = hz.color
    ctx.lineWidth = Math.max(minW * 0.6, hz.width * S * k)
    ctx.setLineDash([])
    ctx.beginPath()
    for (let t = -half; t <= half; t += sp) {
      const px = cx + n.x * t
      const py = cy + n.y * t
      ctx.moveTo(px - u.x * half, py - u.y * half)
      ctx.lineTo(px + u.x * half, py + u.y * half)
    }
    ctx.stroke()
  }
  const applyFill = (f: DlFill, rule: 'nonzero' | 'evenodd', bb: [number, number, number, number], path: () => void): void => {
    ctx.save()
    ctx.globalAlpha = f.opacity ?? 1
    ctx.fillStyle = f.color
    ctx.beginPath()
    path()
    ctx.fill(rule)
    if (f.hatch) {
      ctx.beginPath()
      path()
      ctx.clip(rule)
      hatch(f, ...bb)
    }
    ctx.restore()
  }

  const draw = (it: DisplayItem): void => {
    switch (it.t) {
      case 'poly': {
        if (it.pts.length < 2) return
        const path = () => {
          if (it.closed) {
            ring(it.pts)
            for (const hole of it.holes ?? []) ring(hole)
          } else {
            ctx.moveTo(X(it.pts[0].x), Y(it.pts[0].y))
            for (let i = 1; i < it.pts.length; i++) ctx.lineTo(X(it.pts[i].x), Y(it.pts[i].y))
          }
        }
        if (it.fill && it.closed) {
          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          for (const p of it.pts) {
            minX = Math.min(minX, p.x)
            minY = Math.min(minY, p.y)
            maxX = Math.max(maxX, p.x)
            maxY = Math.max(maxY, p.y)
          }
          applyFill(it.fill, 'evenodd', [minX, minY, maxX, maxY], path)
        }
        if (it.stroke) {
          setPen(it.stroke)
          ctx.beginPath()
          path()
          ctx.stroke()
        }
        return
      }
      case 'line':
        setPen(it.stroke)
        ctx.beginPath()
        ctx.moveTo(X(it.a.x), Y(it.a.y))
        ctx.lineTo(X(it.b.x), Y(it.b.y))
        ctx.stroke()
        return
      case 'arc':
        setPen(it.stroke)
        ctx.beginPath()
        // y-down world maps to y-down screen, so angles carry over unchanged (clockwise on screen)
        ctx.arc(X(it.c.x), Y(it.c.y), it.r * k, (it.a0 * Math.PI) / 180, (it.a1 * Math.PI) / 180, false)
        ctx.stroke()
        return
      case 'circle': {
        const path = () => ctx.arc(X(it.c.x), Y(it.c.y), it.r * k, 0, Math.PI * 2, false)
        if (it.fill) applyFill(it.fill, 'nonzero', [it.c.x - it.r, it.c.y - it.r, it.c.x + it.r, it.c.y + it.r], path)
        if (it.stroke) {
          setPen(it.stroke)
          ctx.beginPath()
          path()
          ctx.stroke()
        }
        return
      }
      case 'text': {
        const px = it.size * k
        if (px < 2) return
        ctx.save()
        ctx.translate(X(it.p.x), Y(it.p.y))
        if (it.rot) ctx.rotate((it.rot * Math.PI) / 180)
        ctx.fillStyle = it.color
        ctx.globalAlpha = 1
        ctx.font = `${it.bold ? '600 ' : ''}${px.toFixed(2)}px ${font}`
        ctx.textAlign = it.anchor === 'start' ? 'left' : it.anchor === 'end' ? 'right' : 'center'
        ctx.textBaseline = it.baseline === 'middle' ? 'middle' : 'alphabetic'
        ctx.fillText(it.text, 0, 0)
        ctx.restore()
        return
      }
    }
  }
  for (const it of dl.items) draw(it)
  ctx.restore()
}
