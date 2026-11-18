/** Grid step of the plan: the presets of the status bar and a step typed in by hand. */

export const GRID_SIZES = [10, 50, 100, 250, 500, 1000]
export const GRID_MIN = 1
export const GRID_MAX = 5000

/** the presets, plus the current step when it is none of them (typed in, or from a file) */
export function gridOptions(current: number): number[] {
  return GRID_SIZES.includes(current) ? GRID_SIZES : [...GRID_SIZES, current].sort((a, b) => a - b)
}

/**
 * A typed grid step → millimetres, or null when it is not a number. Takes «200», «200 мм», «20 см»,
 * «0,5 м» (and mm/cm/m); without a unit the number is millimetres. Kept within 1–5000 mm.
 */
export function parseGridStep(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*(мм|mm|см|cm|м|m)?\s*$/i.exec(text)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  const unit = (m[2] ?? 'мм').toLowerCase()
  const mm = n * (unit === 'м' || unit === 'm' ? 1000 : unit === 'см' || unit === 'cm' ? 10 : 1)
  if (!Number.isFinite(mm) || mm <= 0) return null
  return Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(mm)))
}
