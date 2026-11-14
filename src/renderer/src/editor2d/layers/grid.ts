import { Graphics } from 'pixi.js'
import type { EditorCtx } from '../context'
import { gridSteps } from '../snap'

/** Adaptive grid drawn in screen space (only visible lines), rebuilt when the camera changes. */
export class GridLayer {
  readonly g = new Graphics()
  private key = ''

  constructor() {
    this.g.eventMode = 'none'
  }

  update(ctx: EditorCtx): void {
    const cam = ctx.camera
    const pal = ctx.palette()
    const gridMm = ctx.doc().settings.gridMm
    const key = `${cam.version}|${cam.width}|${cam.height}|${gridMm}|${pal.bg}`
    if (key === this.key) return
    this.key = key
    const g = this.g
    g.clear()
    const { minor, major } = gridSteps(gridMm, cam.scale)
    const vb = cam.visibleBounds()
    const w = cam.width
    const h = cam.height

    const lines = (step: number, skipEvery: number, color: number, alpha: number): void => {
      if (step * cam.scale < 4) return
      const nx = (vb.maxX - vb.minX) / step
      const ny = (vb.maxY - vb.minY) / step
      if (nx + ny > 600) return
      let any = false
      for (let i = Math.ceil(vb.minX / step); i * step <= vb.maxX; i++) {
        if (skipEvery && i % skipEvery === 0) continue
        const x = Math.round(i * step * cam.scale + cam.tx) + 0.5
        g.moveTo(x, 0).lineTo(x, h)
        any = true
      }
      for (let i = Math.ceil(vb.minY / step); i * step <= vb.maxY; i++) {
        if (skipEvery && i % skipEvery === 0) continue
        const y = Math.round(i * step * cam.scale + cam.ty) + 0.5
        g.moveTo(0, y).lineTo(w, y)
        any = true
      }
      if (any) g.stroke({ width: 1, color, alpha })
    }

    const ratio = Math.max(1, Math.round(major / minor))
    lines(minor, ratio, pal.gridMinor, pal.gridMinorAlpha)
    lines(major, 0, pal.gridMajor, pal.gridMajorAlpha)

    // origin axes
    const ox = Math.round(cam.tx) + 0.5
    const oy = Math.round(cam.ty) + 0.5
    if (oy >= 0 && oy <= h) g.moveTo(0, oy).lineTo(w, oy).stroke({ width: 1, color: pal.axisX, alpha: 0.45 })
    if (ox >= 0 && ox <= w) g.moveTo(ox, 0).lineTo(ox, h).stroke({ width: 1, color: pal.axisY, alpha: 0.45 })
  }
}
