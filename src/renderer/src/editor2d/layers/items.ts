import { Graphics } from 'pixi.js'
import type { Item } from '@core/types'
import { type EditorCtx, sameInputs } from '../context'
import { DEG } from '../geom'
import { itemCorners } from '../shapes'
import { drawItemSketch, footprintPolygon, SegmentSketch, sketchKind } from '../symbols'
import { mixColor, parseHex } from '../theme'

function strokeSegments(g: Graphics, segs: readonly number[], color: number, alpha = 1): void {
  if (segs.length < 4) return
  for (let i = 0; i + 3 < segs.length; i += 4) g.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3])
  g.stroke({ width: 1, color, alpha, pixelLine: true })
}

function dashedEdge(out: number[], ax: number, ay: number, bx: number, by: number, dash = 90, gap = 70): void {
  const l = Math.hypot(bx - ax, by - ay)
  if (l < 1) return
  const ux = (bx - ax) / l
  const uy = (by - ay) / l
  for (let s = 0; s < l; s += dash + gap) {
    const e = Math.min(l, s + dash)
    out.push(ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e)
  }
}

/** Furniture / equipment footprints with a top-view sketch (world space, hairlines). */
export class ItemsLayer {
  readonly g = new Graphics()
  private key: unknown[] = []

  constructor() {
    this.g.eventMode = 'none'
  }

  update(ctx: EditorCtx): void {
    const doc = ctx.doc()
    const ui = ctx.ui()
    const pal = ctx.palette()
    const levelId = ctx.levelId()
    const show = doc.settings.showFurniture2d
    const key = [doc.items, doc.assets, ui.catalog, pal, levelId, show]
    if (sameInputs(key, this.key)) return
    this.key = key
    const g = this.g
    g.clear()
    if (!show) return

    const items: Item[] = []
    for (const id in doc.items) {
      const it = doc.items[id]
      if (it.levelId === levelId) items.push(it)
    }
    // low things first (rugs under tables), ceiling-mounted last
    items.sort((a, b) => a.elevation + a.size.h - (b.elevation + b.size.h))

    const outline: number[] = []
    const dashed: number[] = []
    const hidden: number[] = []
    const sketch: number[] = []
    const sk = new SegmentSketch(sketch)

    for (const it of items) {
      const asset = ui.getAsset(it.assetId)
      sk.setTransform(it.x, it.y, it.rotation * DEG, !!it.mirrored)
      const poly = footprintPolygon(asset, it.params, it.size.w, it.size.d)
      const c = poly ? poly.map(([x, y]) => sk.point(x, y)) : itemCorners(it)
      const flat = c.flatMap((p) => [p.x, p.y])
      const nc = c.length
      const overhead = it.mount === 'ceiling' || (it.mount === 'wall' && it.elevation > 1400)
      if (it.hidden) {
        for (let i = 0; i < nc; i++) {
          const j = (i + 1) % nc
          dashedEdge(hidden, c[i].x, c[i].y, c[j].x, c[j].y)
        }
        continue
      }
      if (!overhead) {
        const fill = it.tint ? mixColor(pal.itemFill, parseHex(it.tint, pal.itemFill), 0.6) : pal.itemFill
        g.poly(flat, true).fill({ color: fill, alpha: pal.itemFillAlpha })
      }
      const target = overhead ? dashed : outline
      for (let i = 0; i < nc; i++) {
        const j = (i + 1) % nc
        if (overhead) dashedEdge(target, c[i].x, c[i].y, c[j].x, c[j].y)
        else target.push(c[i].x, c[i].y, c[j].x, c[j].y)
      }
      if (!poly) drawItemSketch(sketchKind(asset), it.size.w, it.size.d, sk)
    }

    strokeSegments(g, sketch, pal.itemSketch, 0.9)
    strokeSegments(g, outline, pal.itemStroke, 1)
    strokeSegments(g, dashed, pal.itemStroke, 0.8)
    strokeSegments(g, hidden, pal.itemStroke, 0.3)
  }

  destroy(): void {
    this.g.destroy()
  }
}
