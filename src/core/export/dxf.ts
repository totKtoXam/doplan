/**
 * Plan level → DXF (AutoCAD 2007, AC1021, UTF-8) via @tarikjabiri/dxf.
 * Built from the display list (without sheet chrome), y flipped (DXF is y-up), units = mm.
 * Layers: WALLS, OPENINGS, ROOMS, DIMENSIONS, FURNITURE, TEXT; an object on a user layer (layers panel)
 * goes to a DXF layer named after that layer. Objects hidden in the layers panel are not exported.
 * Dimensions are written as plain lines + text so every viewer shows them identically.
 */
import {
  DxfWriter,
  LWPolylineFlags,
  point3d,
  TextHorizontalAlignment,
  TextVerticalAlignment,
  Units,
} from '@tarikjabiri/dxf'
import type { Doc, Id, Vec2 } from '../types'
import { buildDisplayList, type DisplayItem, type DisplayOptions, type DlPen } from '../display'
import { entityOf } from '../layers'

/** a user layer name as a DXF layer name (no < > / \ " : ; ? * | = `) */
export function dxfLayerName(name: string): string {
  const s = name
    .replace(/[<>/\\":;?*|=`]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return s || 'LAYER'
}

export interface DxfOptions {
  /** display options override (sheet chrome is always off) */
  display?: Omit<DisplayOptions, 'titleBlock' | 'northArrow' | 'scaleBar' | 'grid'>
}

const LAYERS: { name: string; color: number }[] = [
  { name: 'WALLS', color: 7 },
  { name: 'OPENINGS', color: 4 },
  { name: 'ROOMS', color: 8 },
  { name: 'DIMENSIONS', color: 3 },
  { name: 'FURNITURE', color: 9 },
  { name: 'TEXT', color: 7 },
]

const DASHED = 'DP_DASHED'

function layerOf(it: DisplayItem): string | null {
  switch (it.layer) {
    case 'walls':
      return 'WALLS'
    case 'openings':
      return 'OPENINGS'
    case 'rooms':
      return 'ROOMS'
    case 'dimensions':
      return 'DIMENSIONS'
    case 'furniture':
    case 'lights':
      return 'FURNITURE'
    case 'text':
    case 'annotations':
      return 'TEXT'
    default:
      return null
  }
}

function normDeg(a: number): number {
  let r = a % 360
  if (r < 0) r += 360
  return r
}

export function toDxf(doc: Doc, levelId: Id, opts: DxfOptions = {}): string {
  const dl = buildDisplayList(doc, levelId, {
    ...opts.display,
    titleBlock: false,
    northArrow: false,
    scaleBar: false,
    grid: false,
  })
  const S = dl.scale
  const dxf = new DxfWriter()
  dxf.setUnits(Units.Millimeters)
  dxf.addLType(DASHED, '__ __ __', [3 * S, -1.5 * S])
  for (const l of LAYERS) dxf.addLayer(l.name, l.color, 'Continuous')
  // user layers of the objects in the drawing
  const userLayerOf = new Map<string, string | null>()
  const added = new Set(LAYERS.map((l) => l.name))
  const userLayer = (it: DisplayItem): string | null => {
    const ref = it.ref
    if (!ref || !doc.layers) return null
    const key = `${ref.kind}:${ref.id}`
    let name = userLayerOf.get(key)
    if (name === undefined) {
      const layerId = entityOf(doc, ref)?.layerId
      const layer = typeof layerId === 'string' ? doc.layers[layerId] : undefined
      name = layer ? dxfLayerName(layer.name) : null
      if (name && !added.has(name)) {
        dxf.addLayer(name, 7, 'Continuous')
        added.add(name)
      }
      userLayerOf.set(key, name)
    }
    return name
  }

  const P = (p: Vec2) => point3d(p.x, -p.y, 0)
  const lt = (pen?: DlPen) => (pen?.dash && pen.dash.length ? DASHED : undefined)
  const poly = (pts: Vec2[], closed: boolean, layerName: string, pen?: DlPen) => {
    if (pts.length < 2) return
    dxf.addLWPolyline(
      pts.map((p) => ({ point: { x: p.x, y: -p.y } })),
      { flags: closed ? LWPolylineFlags.Closed : LWPolylineFlags.None, layerName, lineType: lt(pen) },
    )
  }

  for (const it of dl.items) {
    const category = layerOf(it)
    if (!category) continue
    const layerName = userLayer(it) ?? category
    switch (it.t) {
      case 'poly': {
        // merged wall outlines are drawn separately in the display list; DXF keeps one closed outline per wall piece
        if (!it.stroke && !it.fill) continue
        poly(it.pts, it.closed, layerName, it.stroke)
        if (it.closed) for (const h of it.holes ?? []) poly(h, true, layerName, it.stroke)
        break
      }
      case 'line':
        if (it.role === 'wall-outline') continue
        dxf.addLine(P(it.a), P(it.b), { layerName, lineType: lt(it.stroke) })
        break
      case 'arc': {
        const sweep = it.a1 - it.a0
        if (sweep >= 359.99) {
          dxf.addCircle(P(it.c), it.r, { layerName, lineType: lt(it.stroke) })
          break
        }
        dxf.addArc(P(it.c), it.r, normDeg(-it.a1), normDeg(-it.a0), { layerName, lineType: lt(it.stroke) })
        break
      }
      case 'circle':
        dxf.addCircle(P(it.c), it.r, { layerName, lineType: lt(it.stroke) })
        break
      case 'text': {
        const h = TextHorizontalAlignment
        const v = TextVerticalAlignment
        const horizontalAlignment = it.anchor === 'start' ? h.Left : it.anchor === 'end' ? h.Right : h.Center
        const verticalAlignment = it.baseline === 'middle' ? v.Middle : v.BaseLine
        const p = P(it.p)
        dxf.addText(p, it.size * 0.72, it.text, {
          layerName,
          rotation: normDeg(-it.rot),
          horizontalAlignment,
          verticalAlignment,
          secondAlignmentPoint: horizontalAlignment === h.Left && verticalAlignment === v.BaseLine ? undefined : p,
        })
        break
      }
    }
  }
  return dxf.stringify()
}
