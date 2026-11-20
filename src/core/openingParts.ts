/**
 * The wall area an opening cuts out, as rectangles in the wall's own coordinates: `x` along the
 * wall relative to the opening centre (`offset`), `v` the height above the floor, millimetres.
 * A plain door or window is one rectangle; a balcony block is a door from its threshold plus a
 * window above its apron (the wall stays under the window). The 3D build (view3d/build/holes)
 * cuts exactly these, and placing electric points checks against them.
 */
import type { Opening } from './types'

/** default apron height under the window part of a balcony block */
export const BALCONY_APRON = 850

/** door leaf width inside a balcony block */
export function balconyDoorWidth(o: Opening): number {
  return Math.max(550, Math.min(800, o.width * 0.4))
}

export interface BalconyParts {
  /** local x ranges relative to the opening centre, mm */
  door: { x0: number; x1: number; v0: number; v1: number }
  window: { x0: number; x1: number; v0: number; v1: number }
}

export function balconyParts(o: Opening): BalconyParts {
  const top = o.sill + o.height
  const dw = Math.min(balconyDoorWidth(o), o.width - 300)
  // a small `sill` is the door threshold; a large one is the window sill height of the block
  const threshold = o.sill <= 400 ? Math.max(0, o.sill) : 0
  const apron = Math.max(threshold, Math.min(o.sill > 400 ? o.sill : BALCONY_APRON, Math.max(0, top - 400)))
  const half = o.width / 2
  if (o.hinge === 'a') {
    return {
      door: { x0: -half, x1: -half + dw, v0: threshold, v1: top },
      window: { x0: -half + dw, x1: half, v0: apron, v1: top },
    }
  }
  return {
    door: { x0: half - dw, x1: half, v0: threshold, v1: top },
    window: { x0: -half, x1: half - dw, v0: apron, v1: top },
  }
}

/** one cut-out rectangle of an opening: x relative to the opening centre, v above the floor, mm */
export interface OpeningRect {
  x0: number
  x1: number
  v0: number
  v1: number
}

/** the rectangles an opening cuts through its wall (an arched head counts as its bounding box) */
export function openingRects(o: Opening): OpeningRect[] {
  if (o.kind === 'balconyBlock') {
    const p = balconyParts(o)
    return [p.door, p.window]
  }
  return [{ x0: -o.width / 2, x1: o.width / 2, v0: o.sill, v1: o.sill + o.height }]
}
