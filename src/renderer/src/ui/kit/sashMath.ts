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
