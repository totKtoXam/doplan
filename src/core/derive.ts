import { computeWallGeoms } from './joins'
import { detectRooms } from './rooms'
import type { DerivedPlan, Doc, Id } from './types'

/**
 * All derived geometry of one level: mitred wall outlines, rooms and the plan bounding box
 * (walls, items, lights, labels and dimensions of the level).
 */
export function derivePlan(doc: Doc, levelId: Id): DerivedPlan {
  const wallGeoms = computeWallGeoms(doc, levelId)
  const rooms = detectRooms(doc, levelId, wallGeoms)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const id in wallGeoms) {
    const g = wallGeoms[id]
    for (const p of g.polygon) grow(p.x, p.y)
  }
  for (const id in doc.items) {
    const it = doc.items[id]
    if (it.levelId !== levelId) continue
    const r = ((it.rotation || 0) * Math.PI) / 180
    const c = Math.abs(Math.cos(r))
    const s = Math.abs(Math.sin(r))
    const hw = (it.size.w * c + it.size.d * s) / 2
    const hd = (it.size.w * s + it.size.d * c) / 2
    grow(it.x - hw, it.y - hd)
    grow(it.x + hw, it.y + hd)
  }
  for (const id in doc.lights) {
    const l = doc.lights[id]
    if (l.levelId === levelId) grow(l.x, l.y)
  }
  for (const id in doc.labels) {
    const l = doc.labels[id]
    if (l.levelId === levelId) grow(l.x, l.y)
  }
  for (const id in doc.dimensions) {
    const d = doc.dimensions[id]
    if (d.levelId !== levelId) continue
    grow(d.a.x, d.a.y)
    grow(d.b.x, d.b.y)
  }
  const bounds = minX === Infinity ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY }
  return { wallGeoms, rooms, bounds }
}
