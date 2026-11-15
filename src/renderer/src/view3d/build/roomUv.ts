/**
 * The UV frame of a room's floor and ceiling: a laying pattern (and its «Начало раскладки» shift)
 * starts at a real corner of the room, with the tile axes along its walls.
 * Pure (no three.js) so it can be tested on its own.
 */
import type { Vec2 } from '@core/types'

export interface RoomUvFrame {
  /** the room corner the pattern starts at, mm */
  origin: Vec2
  /** direction of the u axis, radians (0 for rooms with axis-aligned walls) */
  angle: number
}

const QUARTER = Math.PI / 2

/** world point (mm) → floor UV (metres) in the frame */
export function roomUv(f: RoomUvFrame, p: Vec2): [number, number] {
  const dx = p.x - f.origin.x
  const dy = p.y - f.origin.y
  const c = Math.cos(f.angle)
  const s = Math.sin(f.angle)
  return [(c * dx + s * dy) / 1000, (c * dy - s * dx) / 1000]
}

/**
 * Axes along the longest wall (folded into ±45°, so a room with axis-aligned walls keeps the world
 * axes); the origin is the convex corner of the outline closest to the outline's lower-left corner in
 * those axes. In an L-shaped room whose notch takes that bounding-box corner, the corner next to the
 * notch is used, so a whole tile lies in a real corner.
 */
export function roomUvFrame(poly: Vec2[]): RoomUvFrame {
  const n = poly.length
  if (n < 3) return { origin: poly[0] ?? { x: 0, y: 0 }, angle: 0 }
  let best = -1
  let angle = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > best + 1e-6) {
      best = len
      angle = Math.atan2(b.y - a.y, b.x - a.x)
    }
  }
  angle -= Math.round(angle / QUARTER) * QUARTER
  if (Math.abs(angle) < 1e-6) angle = 0

  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const local = poly.map((p) => ({ x: c * p.x + s * p.y, y: c * p.y - s * p.x }))
  let area = 0
  let minX = Infinity
  let minY = Infinity
  for (let i = 0; i < n; i++) {
    const a = local[i]
    const b = local[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
    minX = Math.min(minX, a.x)
    minY = Math.min(minY, a.y)
  }
  const sign = Math.sign(area) || 1
  let pick = 0
  let pickD = Infinity
  for (let i = 0; i < n; i++) {
    const a = local[(i + n - 1) % n]
    const b = local[i]
    const d = local[(i + 1) % n]
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)
    const lens = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(d.x - b.x, d.y - b.y)
    // convex corners only, not straight-through vertices or the inner corner of a notch
    if (lens <= 0 || (cross * sign) / lens < 1e-3) continue
    const dist = Math.hypot(b.x - minX, b.y - minY)
    if (dist < pickD - 1e-6) {
      pickD = dist
      pick = i
    }
  }
  return { origin: { x: poly[pick].x, y: poly[pick].y }, angle }
}
