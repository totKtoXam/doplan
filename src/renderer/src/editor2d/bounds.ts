/** Plan-space extents used by zoom-to-fit. Pure (no Pixi), so it is unit-testable. */
import type { DerivedPlan, Doc, Id } from '@core/types'
import { type BBox, bboxOf, bboxUnion, bboxValid } from './geom'
import { dimensionLine, itemCorners, labelBox, underlayCorners } from './shapes'

/** the visible level directly below `levelId` (highest floor elevation under it), if any */
export function levelBelow(doc: Doc, levelId: Id): Id | null {
  const cur = doc.levels[levelId]
  if (!cur) return null
  let best: Id | null = null
  let bestElev = -Infinity
  for (const id of doc.levelOrder) {
    const lv = doc.levels[id]
    if (!lv || id === levelId || !lv.visible) continue
    if (lv.elevation < cur.elevation && lv.elevation > bestElev) {
      best = id
      bestElev = lv.elevation
    }
  }
  return best
}

function grower(): { grow: (b: BBox) => void; box: () => BBox | null } {
  let box: BBox | null = null
  return {
    grow(b) {
      if (!bboxValid(b)) return
      box = box ? bboxUnion(box, b) : b
    },
    box: () => box,
  }
}

/** bounding box of everything drawable on a level (incl. its visible underlays), or null when the level is empty */
export function contentBounds(doc: Doc, derived: DerivedPlan, levelId: Id): BBox | null {
  const { grow, box } = grower()
  for (const id in derived.wallGeoms) {
    const g = derived.wallGeoms[id]
    grow(bboxOf(g.polygon.length ? g.polygon : [g.a, g.b]))
  }
  for (const id in doc.items) {
    const it = doc.items[id]
    if (it.levelId === levelId) grow(bboxOf(itemCorners(it)))
  }
  for (const id in doc.underlays) {
    const u = doc.underlays[id]
    if (u.levelId === levelId && u.visible) grow(bboxOf(underlayCorners(u)))
  }
  for (const id in doc.lights) {
    const l = doc.lights[id]
    if (l.levelId === levelId) grow({ minX: l.x - 200, minY: l.y - 200, maxX: l.x + 200, maxY: l.y + 200 })
  }
  for (const id in doc.labels) {
    const l = doc.labels[id]
    if (l.levelId === levelId) grow(bboxOf(labelBox(l)))
  }
  for (const id in doc.dimensions) {
    const d = doc.dimensions[id]
    if (d.levelId !== levelId) continue
    const ln = dimensionLine(d)
    grow(bboxOf([d.a, d.b, ln.a, ln.b]))
  }
  return box()
}

/** extent of what the ghost layer draws for a level (wall footprints + room outlines) */
export function ghostBounds(plan: DerivedPlan): BBox | null {
  const { grow, box } = grower()
  for (const room of plan.rooms) if (room.polygon.length >= 3) grow(bboxOf(room.polygon))
  for (const id in plan.wallGeoms) {
    const poly = plan.wallGeoms[id].polygon
    if (poly.length >= 3) grow(bboxOf(poly))
  }
  return box()
}

/**
 * What zoom-to-fit frames: the active level's content; when the level is empty, the faint ghost of the
 * level below (so a fresh upper floor opens on the plan to trace over). null → nothing to frame.
 */
export function fitBounds(doc: Doc, derivedAll: Record<Id, DerivedPlan>, levelId: Id, derived: DerivedPlan): BBox | null {
  const own = contentBounds(doc, derived, levelId)
  if (own) return own
  const below = levelBelow(doc, levelId)
  const plan = below ? derivedAll[below] : undefined
  return plan ? ghostBounds(plan) : null
}
