import { Graphics } from 'pixi.js'
import type { DerivedPlan, Id } from '@core/types'
import { levelBelow } from '../bounds'
import { type EditorCtx, sameInputs } from '../context'

export { levelBelow }

/**
 * Faint footprint of the level below the active one (walls + room outlines), drawn under the active
 * level so upper floors can be traced over the floor beneath. Purely visual: not hit-tested.
 */
export class GhostLevelLayer {
  readonly g = new Graphics()
  private key: unknown[] = []

  constructor() {
    this.g.eventMode = 'none'
  }

  update(ctx: EditorCtx, derivedAll: Record<Id, DerivedPlan>): void {
    const doc = ctx.doc()
    const below = levelBelow(doc, ctx.levelId())
    const plan = below ? derivedAll[below] : undefined
    const pal = ctx.palette()
    const key = [below, plan, pal]
    if (sameInputs(key, this.key)) return
    this.key = key
    const g = this.g
    g.clear()
    if (!plan) return

    for (const room of plan.rooms) {
      if (room.polygon.length < 3) continue
      g.poly(room.polygon.flatMap((p) => [p.x, p.y]), true)
      g.fill({ color: pal.wall, alpha: 0.05 })
    }
    for (const id in plan.wallGeoms) {
      const poly = plan.wallGeoms[id].polygon
      if (poly.length < 3) continue
      g.poly(poly.flatMap((p) => [p.x, p.y]), true)
    }
    g.fill({ color: pal.wall, alpha: 0.18 })
    for (const id in plan.wallGeoms) {
      const poly = plan.wallGeoms[id].polygon
      if (poly.length < 3) continue
      g.poly(poly.flatMap((p) => [p.x, p.y]), true)
    }
    g.stroke({ width: 1, color: pal.wallStroke, alpha: 0.35, pixelLine: true })
  }
}
