/**
 * Cropped PNG of the plan around a pencil mark, with the mark and its number drawn on top: the
 * picture that goes to the agent with «Пометка ①».
 */
import { buildDisplayList, drawToCanvas, markBounds } from '@core'
import type { Annotation, Catalog, DerivedPlan, Doc } from '@core/types'

const MAX_PX = 1000

export function markSnapshot(doc: Doc, plan: DerivedPlan, m: Annotation, catalog?: Catalog): { mime: 'image/png'; data: string; url: string; name: string } | null {
  const b = markBounds(m)
  if (!Number.isFinite(b.minX)) return null
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  const pad = Math.max(600, size * 0.35)
  const minX = b.minX - pad
  const minY = b.minY - pad
  const bw = b.maxX - b.minX + pad * 2
  const bh = b.maxY - b.minY + pad * 2
  const k = Math.min(MAX_PX / bw, MAX_PX / bh, 0.6)
  const w = Math.max(1, Math.ceil(bw * k))
  const h = Math.max(1, Math.ceil(bh * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')
  if (!c) return null
  const dl = buildDisplayList(doc, m.levelId, { theme: 'light', derived: plan, catalog })
  drawToCanvas(c, dl, { pxPerMm: k, width: w, height: h, offsetX: -minX * k, offsetY: -minY * k, background: dl.background || '#ffffff' })

  const X = (x: number) => (x - minX) * k
  const Y = (y: number) => (y - minY) * k
  c.save()
  c.lineJoin = 'round'
  c.lineCap = 'round'
  c.lineWidth = 3
  c.strokeStyle = '#e5484d'
  c.beginPath()
  m.points.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y))))
  if (m.shape === 'zone') {
    c.closePath()
    c.fillStyle = 'rgba(229, 72, 77, 0.10)'
    c.fill()
  }
  c.stroke()
  // number badge
  const anchor = m.shape === 'stroke' ? m.points[0] : m.points.reduce((a, q) => (q.y < a.y ? q : a))
  const bx = X(anchor.x)
  const by = Math.max(16, Y(anchor.y) - 18)
  c.fillStyle = '#e5484d'
  c.beginPath()
  c.arc(bx, by, 13, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = '#ffffff'
  c.font = 'bold 15px Inter, "Segoe UI", Arial, sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText(String(m.n), bx, by + 1)
  // scale note
  c.font = '11px Inter, "Segoe UI", Arial, sans-serif'
  c.textAlign = 'left'
  c.textBaseline = 'bottom'
  c.fillStyle = 'rgba(0,0,0,0.55)'
  c.fillText(`1 px ≈ ${Math.round((1 / k) * 10) / 10} мм · левый верхний угол (${Math.round(minX)}, ${Math.round(minY)})`, 6, h - 4)
  c.restore()

  const url = canvas.toDataURL('image/png')
  return { mime: 'image/png', data: url.slice(url.indexOf(',') + 1), url, name: `пометка-${m.n}` }
}
