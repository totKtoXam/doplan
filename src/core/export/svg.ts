/**
 * Display list → standalone SVG string.
 * viewBox is in world millimetres; width/height attributes are paper millimetres at 1:scale.
 */
import type { Vec2 } from '../types'
import type { DisplayItem, DisplayList, DlFill, DlPen } from '../display'

export interface SvgOptions {
  /** 1:scale; default = dl.scale (100) */
  scale?: number
  /** paper margin around the drawing, mm; default 10 */
  marginMm?: number
  title?: string
  /** include the background rect; default true */
  background?: boolean
  fontFamily?: string
}

export interface SvgResult {
  svg: string
  widthMm: number
  heightMm: number
}

const r2 = (n: number): string => {
  const v = Math.round(n * 100) / 100
  return Object.is(v, -0) ? '0' : String(v)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function ptsAttr(pts: Vec2[]): string {
  return pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' ')
}

function ringPath(pts: Vec2[]): string {
  if (!pts.length) return ''
  return `M${r2(pts[0].x)} ${r2(pts[0].y)}` + pts.slice(1).map((p) => `L${r2(p.x)} ${r2(p.y)}`).join('') + 'Z'
}

export function toSvg(dl: DisplayList, opts: SvgOptions = {}): SvgResult {
  const S = opts.scale && opts.scale > 0 ? opts.scale : dl.scale || 100
  const marginWorld = (opts.marginMm ?? 10) * S
  const b = dl.bounds
  const x0 = b.minX - marginWorld
  const y0 = b.minY - marginWorld
  const w = Math.max(1, b.maxX - b.minX + 2 * marginWorld)
  const h = Math.max(1, b.maxY - b.minY + 2 * marginWorld)
  const widthMm = w / S
  const heightMm = h / S
  const font = opts.fontFamily ?? "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"

  const defs: string[] = []
  const hatchIds = new Map<string, string>()
  const hatchRef = (fill: DlFill): string => {
    const hz = fill.hatch!
    const key = `${fill.color}|${hz.color}|${hz.angle}|${hz.spacing}|${hz.width}`
    let id = hatchIds.get(key)
    if (!id) {
      id = `h${hatchIds.size}`
      hatchIds.set(key, id)
      const sp = hz.spacing * S
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${r2(sp)}" height="${r2(sp)}" patternTransform="rotate(${r2(hz.angle)})">` +
          `<rect width="${r2(sp)}" height="${r2(sp)}" fill="${esc(fill.color)}"${fill.opacity != null ? ` fill-opacity="${fill.opacity}"` : ''}/>` +
          `<line x1="0" y1="0" x2="0" y2="${r2(sp)}" stroke="${esc(hz.color)}" stroke-width="${r2(hz.width * S)}"/>` +
          `</pattern>`,
      )
    }
    return `url(#${id})`
  }

  const strokeAttrs = (p?: DlPen): string => {
    if (!p) return ' stroke="none"'
    let s = ` stroke="${esc(p.color)}" stroke-width="${r2(p.width * S)}"`
    if (p.dash && p.dash.length) s += ` stroke-dasharray="${p.dash.map((d) => r2(d * S)).join(' ')}"`
    return s
  }
  const fillAttrs = (f?: DlFill): string => {
    if (!f) return ' fill="none"'
    if (f.hatch) return ` fill="${hatchRef(f)}"`
    return ` fill="${esc(f.color)}"${f.opacity != null && f.opacity < 1 ? ` fill-opacity="${f.opacity}"` : ''}`
  }

  const layers = new Map<string, string[]>()
  const push = (layer: string, s: string) => {
    let l = layers.get(layer)
    if (!l) {
      l = []
      layers.set(layer, l)
    }
    l.push(s)
  }

  const emit = (it: DisplayItem): void => {
    switch (it.t) {
      case 'poly': {
        if (it.pts.length < 2) return
        if (it.holes && it.holes.length && it.closed) {
          const d = ringPath(it.pts) + it.holes.map(ringPath).join('')
          push(it.layer, `<path d="${d}" fill-rule="evenodd"${fillAttrs(it.fill)}${strokeAttrs(it.stroke)} stroke-linejoin="round"/>`)
        } else if (it.closed) {
          push(it.layer, `<polygon points="${ptsAttr(it.pts)}"${fillAttrs(it.fill)}${strokeAttrs(it.stroke)} stroke-linejoin="round"/>`)
        } else {
          push(it.layer, `<polyline points="${ptsAttr(it.pts)}" fill="none"${strokeAttrs(it.stroke)} stroke-linejoin="round"/>`)
        }
        return
      }
      case 'line':
        push(
          it.layer,
          `<line x1="${r2(it.a.x)}" y1="${r2(it.a.y)}" x2="${r2(it.b.x)}" y2="${r2(it.b.y)}"${strokeAttrs(it.stroke)} stroke-linecap="square"/>`,
        )
        return
      case 'arc': {
        const sweep = it.a1 - it.a0
        if (sweep >= 359.99) {
          push(it.layer, `<circle cx="${r2(it.c.x)}" cy="${r2(it.c.y)}" r="${r2(it.r)}" fill="none"${strokeAttrs(it.stroke)}/>`)
          return
        }
        const a0 = (it.a0 * Math.PI) / 180
        const a1 = (it.a1 * Math.PI) / 180
        const p0 = { x: it.c.x + Math.cos(a0) * it.r, y: it.c.y + Math.sin(a0) * it.r }
        const p1 = { x: it.c.x + Math.cos(a1) * it.r, y: it.c.y + Math.sin(a1) * it.r }
        const large = sweep > 180 ? 1 : 0
        push(
          it.layer,
          `<path d="M${r2(p0.x)} ${r2(p0.y)}A${r2(it.r)} ${r2(it.r)} 0 ${large} 1 ${r2(p1.x)} ${r2(p1.y)}" fill="none"${strokeAttrs(it.stroke)}/>`,
        )
        return
      }
      case 'circle':
        push(it.layer, `<circle cx="${r2(it.c.x)}" cy="${r2(it.c.y)}" r="${r2(it.r)}"${fillAttrs(it.fill)}${strokeAttrs(it.stroke)}/>`)
        return
      case 'text': {
        const anchor = it.anchor
        const dy = it.baseline === 'middle' ? ` dy="${r2(it.size * 0.35)}"` : ''
        const rot = it.rot ? ` transform="rotate(${r2(it.rot)} ${r2(it.p.x)} ${r2(it.p.y)})"` : ''
        push(
          it.layer,
          `<text x="${r2(it.p.x)}" y="${r2(it.p.y)}"${dy} font-size="${r2(it.size)}" text-anchor="${anchor}" fill="${esc(it.color)}"${
            it.bold ? ' font-weight="600"' : ''
          }${rot}>${esc(it.text)}</text>`,
        )
        return
      }
    }
  }
  for (const it of dl.items) emit(it)

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${r2(widthMm)}mm" height="${r2(heightMm)}mm" viewBox="${r2(x0)} ${r2(y0)} ${r2(w)} ${r2(h)}">`,
  )
  if (opts.title) out.push(`<title>${esc(opts.title)}</title>`)
  if (defs.length) out.push(`<defs>${defs.join('')}</defs>`)
  if (opts.background !== false) out.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(w)}" height="${r2(h)}" fill="${esc(dl.background)}"/>`)
  for (const [layer, body] of layers) {
    const extra = layer === 'text' || layer === 'dimensions' || layer === 'sheet' || layer === 'annotations' || layer === 'electrical' ? ` font-family="${esc(font)}"` : ''
    out.push(`<g id="${esc(layer)}"${extra}>${body.join('')}</g>`)
  }
  out.push('</svg>')
  return { svg: out.join('\n'), widthMm, heightMm }
}
