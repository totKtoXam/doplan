/** Plan-space extents used by zoom-to-fit. Pure (no Pixi), so it is unit-testable. */
import type { DerivedPlan, Doc, EntityRef, Id } from '@core/types'
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

/**
 * plan-space box around the selected objects (to place UI next to the selection), or null when none
 * of them is drawn on the plan
 */
export function selectionBounds(doc: Doc, derived: DerivedPlan | undefined, refs: readonly EntityRef[]): BBox | null {
  const { grow, box } = grower()
  const point = (x: number, y: number, r: number) => grow({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r })
  for (const r of refs) {
    switch (r.kind) {
      case 'wall': {
        const g = derived?.wallGeoms[r.id]
        if (g) grow(bboxOf(g.polygon.length ? g.polygon : [g.a, g.b]))
        break
      }
      case 'opening': {
        const o = doc.openings[r.id]
        const w = o && doc.walls[o.wallId]
        const a = w && doc.nodes[w.a]
        const b = w && doc.nodes[w.b]
        if (!o || !a || !b) break
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const ux = (b.x - a.x) / len
        const uy = (b.y - a.y) / len
        const h = o.width / 2
        const cx = a.x + ux * o.offset
        const cy = a.y + uy * o.offset
        // the leaf swing reaches about a width away from the wall
        grow(bboxOf([{ x: cx - ux * h - uy * o.width, y: cy - uy * h + ux * o.width }, { x: cx + ux * h + uy * o.width, y: cy + uy * h - ux * o.width }]))
        break
      }
      case 'room': {
        const d = derived?.rooms.find((x) => x.roomId === r.id)
        if (d?.polygon.length) grow(bboxOf(d.polygon))
        else {
          const room = doc.rooms[r.id]
          if (room) point(room.anchor.x, room.anchor.y, 300)
        }
        break
      }
      case 'item': {
        const it = doc.items[r.id]
        if (it) grow(bboxOf(itemCorners(it)))
        break
      }
      case 'light': {
        const l = doc.lights[r.id]
        if (l) point(l.x, l.y, 200)
        break
      }
      case 'electric': {
        const e = doc.electrical?.[r.id]
        if (e) point(e.x, e.y, 150)
        break
      }
      case 'node': {
        const n = doc.nodes[r.id]
        if (n) point(n.x, n.y, 100)
        break
      }
      case 'label': {
        const l = doc.labels[r.id]
        if (l) grow(bboxOf(labelBox(l)))
        break
      }
      case 'dimension': {
        const d = doc.dimensions[r.id]
        if (!d) break
        const ln = dimensionLine(d)
        grow(bboxOf([d.a, d.b, ln.a, ln.b]))
        break
      }
      case 'underlay': {
        const u = doc.underlays[r.id]
        if (u) grow(bboxOf(underlayCorners(u)))
        break
      }
    }
  }
  return box()
}
