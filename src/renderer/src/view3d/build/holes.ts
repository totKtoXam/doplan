/**
 * Decomposition of an Opening into the rectangular (or arched) holes it cuts into its wall.
 * Both the wall builder and the opening builder use these numbers, so the hole and the
 * door / window that fills it can never disagree.
 * Units: millimetres. `s` runs along the wall axis from node `a`, `v` is the height above the floor.
 */
import type { Opening } from '@core/types'
import { balconyParts } from '@core/openingParts'

export interface Hole {
  openingId: string
  s0: number
  s1: number
  v0: number
  v1: number
  /** arched head: rise of the arc above the spring line (the arc ends at v1) */
  arch?: { rise: number }
  /** vertical ranges of the reveal jambs at s0 / s1, null = no jamb (shared edge) */
  jamb0: [number, number] | null
  jamb1: [number, number] | null
  /** head reveal at v1 */
  head: boolean
  /** sill reveal at v0 (false when the hole reaches the floor) */
  sill: boolean
}

// the balcony block split lives in core (electric points check against the same holes)
export { balconyDoorWidth, balconyParts, type BalconyParts } from '@core/openingParts'

/**
 * Holes of one opening, clipped to the wall (`wallLen`, `wallHeight`).
 * `wallHeight` may be the lowered cut-away height.
 */
export function openingHoles(o: Opening, wallLen: number, wallHeight: number): Hole[] {
  const out: Hole[] = []
  const push = (
    s0: number,
    s1: number,
    v0: number,
    v1: number,
    arch: boolean,
    edge0: boolean,
    edge1: boolean,
    sharedFrom?: number,
  ): void => {
    s0 = Math.max(0, Math.min(wallLen, s0))
    s1 = Math.max(0, Math.min(wallLen, s1))
    v0 = Math.max(0, v0)
    const rawTop = v1
    v1 = Math.min(wallHeight, v1)
    if (s1 - s0 < 1 || v1 - v0 < 1) return
    const clipped = rawTop > wallHeight + 0.5
    const reachesTop = v1 >= wallHeight - 1
    let archSpec: { rise: number } | undefined
    if (arch && !clipped) {
      if (reachesTop) v1 = wallHeight - 20
      const rise = Math.min((s1 - s0) / 2, (v1 - v0) * 0.4)
      if (rise > 10 && v1 - v0 > rise + 10) archSpec = { rise }
    }
    const jambTop = archSpec ? v1 - archSpec.rise : v1
    const full: [number, number] = [v0, jambTop]
    out.push({
      openingId: o.id,
      s0,
      s1,
      v0,
      v1,
      arch: archSpec,
      jamb0: edge0 ? full : sharedFrom !== undefined && sharedFrom > v0 + 1 ? [v0, Math.min(sharedFrom, jambTop)] : null,
      jamb1: edge1 ? full : sharedFrom !== undefined && sharedFrom > v0 + 1 ? [v0, Math.min(sharedFrom, jambTop)] : null,
      head: !archSpec && !reachesTop && !clipped,
      sill: v0 > 1,
    })
  }

  if (o.kind === 'balconyBlock') {
    const parts = balconyParts(o)
    const doorFirst = o.hinge === 'a'
    // the door's inner jamb only exists along the apron (below the window part)
    push(
      o.offset + parts.door.x0,
      o.offset + parts.door.x1,
      parts.door.v0,
      parts.door.v1,
      false,
      doorFirst,
      !doorFirst,
      parts.window.v0,
    )
    push(o.offset + parts.window.x0, o.offset + parts.window.x1, parts.window.v0, parts.window.v1, false, !doorFirst, doorFirst)
    return out
  }
  push(o.offset - o.width / 2, o.offset + o.width / 2, o.sill, o.sill + o.height, o.kind === 'arch', true, true)
  return out
}

/** sample points of an arched head from (s0, spring) over the crown to (s1, spring), exclusive of both ends */
export function archPoints(s0: number, s1: number, top: number, rise: number, segments = 16): [number, number][] {
  const w = s1 - s0
  const r = (w * w) / 4 / (2 * rise) + rise / 2
  const cx = (s0 + s1) / 2
  const cy = top - r
  const pts: [number, number][] = []
  for (let k = 1; k < segments; k++) {
    const x = s0 + (w * k) / segments
    const dx = x - cx
    pts.push([x, cy + Math.sqrt(Math.max(0, r * r - dx * dx))])
  }
  return pts
}

/** true for openings whose hole reaches the floor (skirting must break there) */
export function reachesFloor(o: Opening): boolean {
  return o.kind === 'balconyBlock' || o.sill < 10
}
