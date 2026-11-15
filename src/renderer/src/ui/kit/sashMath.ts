/**
 * Pure size rules of the resizable panels (VS Code-like sashes), kept apart from the DOM so they
 * can be tested.
 */

export interface PanelLimits {
  min: number
  max: number
  /** dragging below half of `min` collapses the panel (and dragging back past it reopens it) */
  collapsible?: boolean
}

export interface DragResult {
  size: number
  collapsed: boolean
}

/** the size a drag asks for → the size the panel takes, or collapsed */
export function resolveDrag(raw: number, { min, max, collapsible }: PanelLimits): DragResult {
  const hi = Math.max(min, max)
  if (collapsible && raw < min / 2) return { size: min, collapsed: true }
  return { size: Math.round(Math.min(hi, Math.max(min, raw))), collapsed: false }
}

/** the largest size that still leaves `minRest` px to the area that fills the rest of the row */
export function availableMax(max: number, current: number, fillWidth: number, minRest: number): number {
  return Math.max(0, Math.min(max, current + fillWidth - minRest))
}

/** keyboard steps of a focused sash: arrows move it, Home/End jump to the limits */
export function keyStep(key: string, shift: boolean, current: number, { min, max }: PanelLimits, step = 10): number | null {
  const big = shift ? step * 5 : step
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return Math.max(min, current - big)
    case 'ArrowRight':
    case 'ArrowDown':
      return Math.min(max, current + big)
    case 'Home':
      return min
    case 'End':
      return max
    default:
      return null
  }
}

/** a stored size read back from storage: a finite number inside the limits, else the default */
export function sanitizeSize(v: unknown, fallback: number, { min, max }: PanelLimits): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.round(Math.min(Math.max(min, max), Math.max(min, v)))
}

// ───────────── resizable boxes (floating panels, dialogs) ─────────────

/** a box edge or corner that can be dragged: n / s / e / w and the four corners */
export type BoxEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface Box {
  w: number
  h: number
}

/** which way an edge grows the box: +1 along +x / +y, -1 against, 0 when it does not move that axis */
export function edgeSigns(edge: BoxEdge): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  return {
    x: edge.includes('e') ? 1 : edge.includes('w') ? -1 : 0,
    y: edge.includes('s') ? 1 : edge.includes('n') ? -1 : 0,
  }
}

/**
 * The box size after dragging `edge` by (dx, dy). `factor` is 2 for a centred box (both sides
 * move, so the dragged edge follows the pointer). The size stays inside [min, max]; when the
 * space is smaller than the minimum, the minimum wins.
 */
export function resizeBox(start: Box, edge: BoxEdge, dx: number, dy: number, min: Box, max: Box, factor = 1): Box {
  const s = edgeSigns(edge)
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(lo, hi), Math.max(lo, v)))
  return {
    w: s.x ? clamp(start.w + s.x * dx * factor, min.w, max.w) : start.w,
    h: s.y ? clamp(start.h + s.y * dy * factor, min.h, max.h) : start.h,
  }
}
