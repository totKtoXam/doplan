import { useMemo } from 'react'
import { electricFrame, electricPointSymbol } from '@core'
import type { ElectricKind, ElectricMount } from '@core/types'

/**
 * The ГОСТ plan symbol of an electrical point as an inline SVG (the same primitives as the
 * drawings and the 2D editor), drawn with the wall below the symbol.
 */
export function ElectricIcon({
  kind,
  gangs,
  vertical,
  mount,
  className,
}: {
  kind: ElectricKind
  gangs?: number
  vertical?: boolean
  mount?: ElectricMount
  className?: string
}) {
  const body = useMemo(() => {
    // facing up: the wall is under the symbol
    const rot = 270
    const { ux, uy, theta } = electricFrame(rot)
    const shape = electricPointSymbol({ kind, gangs, vertical, mount: mount ?? 'wall' })
    const P = (q: { x: number; y: number }) => ({ x: ux.x * q.x + uy.x * q.y, y: ux.y * q.x + uy.y * q.y })
    const f = (n: number) => Math.round(n * 1000) / 1000
    const els: string[] = []
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const grow = (x: number, y: number, r = 0) => {
      minX = Math.min(minX, x - r)
      minY = Math.min(minY, y - r)
      maxX = Math.max(maxX, x + r)
      maxY = Math.max(maxY, y + r)
    }
    for (const q of shape.prims) {
      if (q.t === 'line') {
        const a = P(q.a)
        const b = P(q.b)
        grow(a.x, a.y)
        grow(b.x, b.y)
        els.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"/>`)
      } else if (q.t === 'circle') {
        const c = P(q.c)
        grow(c.x, c.y, q.r)
        els.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(q.r)}"${q.fill ? ' fill="currentColor"' : ''}/>`)
      } else if (q.t === 'poly') {
        const pts = q.pts.map(P)
        for (const p of pts) grow(p.x, p.y)
        const d = pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')
        els.push(q.closed ? `<polygon points="${d}"${q.fill ? ' fill="currentColor"' : ''}/>` : `<polyline points="${d}"/>`)
      } else {
        const c = P(q.c)
        const a0 = ((q.a0 + theta) * Math.PI) / 180
        const a1 = ((q.a1 + theta) * Math.PI) / 180
        const s = { x: c.x + Math.cos(a0) * q.r, y: c.y + Math.sin(a0) * q.r }
        const e = { x: c.x + Math.cos(a1) * q.r, y: c.y + Math.sin(a1) * q.r }
        grow(c.x, c.y, q.r)
        const large = q.a1 - q.a0 > 180 ? 1 : 0
        els.push(`<path d="M${f(s.x)} ${f(s.y)}A${f(q.r)} ${f(q.r)} 0 ${large} 1 ${f(e.x)} ${f(e.y)}"/>`)
      }
    }
    const pad = 0.25
    const w = Math.max(maxX - minX, maxY - minY) + pad * 2
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    return { html: els.join(''), viewBox: `${f(cx - w / 2)} ${f(cy - w / 2)} ${f(w)} ${f(w)}`, sw: f(w / 22) }
  }, [kind, gangs, vertical, mount])
  return (
    <svg
      className={className}
      viewBox={body.viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={body.sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      // the markup is generated from our own numeric primitives
      dangerouslySetInnerHTML={{ __html: body.html }}
    />
  )
}
