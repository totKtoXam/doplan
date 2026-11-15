/**
 * Pencil marks drawn over a chat image (screenshot, photo, plan snapshot) before it is sent:
 * freehand lines, frames and arrows, each with a number badge ①② the user can refer to.
 * Coordinates are in the image's own pixels; drawing scales them onto any canvas.
 */

export type MarkupTool = 'pen' | 'rect' | 'arrow'

export interface MarkupPt {
  x: number
  y: number
}

export interface MarkupShape {
  kind: MarkupTool
  color: string
  /** pen: the stroke; rect / arrow: [start, end] */
  points: MarkupPt[]
  /** badge number; numbers run on from the plan marks and other pictures so they never repeat */
  n?: number
}

export const MARKUP_COLORS = ['#e5484d', '#f5a524', '#3b82f6', '#30a46c'] as const

const BADGES = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
export const markupBadge = (n: number): string => (n >= 1 && n <= 20 ? BADGES[n - 1] : `(${n})`)

/** stroke width and badge radius for an image of this size, image px */
export function markupMetrics(w: number, h: number): { line: number; badge: number } {
  const side = Math.max(w, h)
  return { line: Math.max(3, side * 0.004), badge: Math.max(11, side * 0.018) }
}

/** where the number badge of a shape goes: the start of a line / arrow tail, the frame's top-left corner */
export function badgeAnchor(s: MarkupShape): MarkupPt {
  if (s.kind === 'rect' && s.points.length >= 2) {
    const [a, b] = s.points
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
  }
  return s.points[0]
}

/** the two barbs of an arrow head at `to`, `size` long */
export function arrowHead(from: MarkupPt, to: MarkupPt, size: number): [MarkupPt, MarkupPt] {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: to.x - size * Math.cos(ang - spread), y: to.y - size * Math.sin(ang - spread) },
    { x: to.x - size * Math.cos(ang + spread), y: to.y - size * Math.sin(ang + spread) },
  ]
}

/** a drag long enough to keep (in image px) */
export function isMeaningful(s: MarkupShape, minPx: number): boolean {
  if (s.points.length < 2) return false
  if (s.kind === 'pen') {
    let len = 0
    for (let i = 1; i < s.points.length; i++) len += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y)
    return len >= minPx
  }
  const [a, b] = s.points
  return s.kind === 'rect' ? Math.abs(a.x - b.x) >= minPx && Math.abs(a.y - b.y) >= minPx : Math.hypot(a.x - b.x, a.y - b.y) >= minPx
}

/**
 * Draws the shapes onto `c`, where image px map to canvas px by `k`. `metrics` come from the
 * image size so the marks look the same on the preview and on the exported picture.
 */
export function drawMarkup(c: CanvasRenderingContext2D, shapes: MarkupShape[], k: number, metrics: { line: number; badge: number }): void {
  c.save()
  c.lineCap = 'round'
  c.lineJoin = 'round'
  const lw = metrics.line * k
  for (const s of shapes) {
    if (s.points.length < 2) continue
    c.strokeStyle = s.color
    c.lineWidth = lw
    c.beginPath()
    if (s.kind === 'rect') {
      const [a, b] = s.points
      c.rect(Math.min(a.x, b.x) * k, Math.min(a.y, b.y) * k, Math.abs(b.x - a.x) * k, Math.abs(b.y - a.y) * k)
    } else {
      const pts = s.kind === 'arrow' ? s.points.slice(0, 2) : s.points
      c.moveTo(pts[0].x * k, pts[0].y * k)
      for (const p of pts.slice(1)) c.lineTo(p.x * k, p.y * k)
      if (s.kind === 'arrow') {
        const [l, r] = arrowHead(pts[0], pts[1], metrics.badge * 1.4)
        c.moveTo(l.x * k, l.y * k)
        c.lineTo(pts[1].x * k, pts[1].y * k)
        c.lineTo(r.x * k, r.y * k)
      }
    }
    c.stroke()
  }
  // badges on top of all lines
  const r = metrics.badge * k
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.font = `600 ${Math.round(r * 1.15)}px system-ui, sans-serif`
  shapes.forEach((s, i) => {
    if (s.points.length < 2) return
    const p = badgeAnchor(s)
    c.beginPath()
    c.arc(p.x * k, p.y * k, r, 0, Math.PI * 2)
    c.fillStyle = s.color
    c.fill()
    c.lineWidth = Math.max(1.5, r * 0.15)
    c.strokeStyle = '#ffffff'
    c.stroke()
    c.fillStyle = '#ffffff'
    c.fillText(String(s.n ?? i + 1), p.x * k, p.y * k + r * 0.05)
  })
  c.restore()
}
