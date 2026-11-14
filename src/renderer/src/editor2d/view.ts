import type { Vec2 } from '@core/types'
import type { BBox } from './geom'

export const MIN_SCALE = 0.002 // px per mm  (1 px = 500 mm)
export const MAX_SCALE = 20 //                (1 px = 0.05 mm)

/** Own camera: uniform scale + translation, y down, no flips. Screen units are CSS px inside the canvas. */
export class Camera {
  /** px per mm */
  scale = 0.08
  /** screen position (CSS px) of the plan origin */
  tx = 0
  ty = 0
  width = 1
  height = 1
  /** bumped on every change */
  version = 0

  setSize(w: number, h: number): void {
    w = Math.max(1, w)
    h = Math.max(1, h)
    if (w === this.width && h === this.height) return
    const first = this.width <= 1 || this.height <= 1
    // keep the plan point in the centre of the viewport fixed
    const cx = (this.width / 2 - this.tx) / this.scale
    const cy = (this.height / 2 - this.ty) / this.scale
    this.width = w
    this.height = h
    if (first) {
      this.tx = w / 2
      this.ty = h / 2
    } else {
      this.tx = w / 2 - cx * this.scale
      this.ty = h / 2 - cy * this.scale
    }
    this.version++
  }

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.tx, y: p.y * this.scale + this.ty }
  }

  toPlan(sx: number, sy: number): Vec2 {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale }
  }

  /** px → mm */
  mm(px: number): number {
    return px / this.scale
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor))
    if (next === this.scale) return
    const px = (sx - this.tx) / this.scale
    const py = (sy - this.ty) / this.scale
    this.scale = next
    this.tx = sx - px * next
    this.ty = sy - py * next
    this.version++
  }

  panBy(dx: number, dy: number): void {
    if (!dx && !dy) return
    this.tx += dx
    this.ty += dy
    this.version++
  }

  fit(b: BBox, paddingPx = 70): void {
    const w = Math.max(1, b.maxX - b.minX)
    const h = Math.max(1, b.maxY - b.minY)
    const availW = Math.max(50, this.width - paddingPx * 2)
    const availH = Math.max(50, this.height - paddingPx * 2)
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / w, availH / h, 0.5)))
    this.scale = s
    this.tx = this.width / 2 - ((b.minX + b.maxX) / 2) * s
    this.ty = this.height / 2 - ((b.minY + b.maxY) / 2) * s
    this.version++
  }

  reset(): void {
    this.scale = 0.08
    this.tx = this.width / 2
    this.ty = this.height / 2
    this.version++
  }

  visibleBounds(padPx = 0): BBox {
    const a = this.toPlan(-padPx, -padPx)
    const b = this.toPlan(this.width + padPx, this.height + padPx)
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y }
  }
}
