import type { DocSettings } from '@core/types'
import { t } from '@/i18n'

type Units = DocSettings['units']

/** plain number in document units (the way dimensions are written on a plan) */
export function formatLen(mm: number, units: Units): string {
  if (units === 'm') return (mm / 1000).toFixed(2)
  if (units === 'cm') {
    const v = mm / 10
    return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1)
  }
  return String(Math.round(mm))
}

const UNIT_LABEL: Record<Units, string> = { mm: 'мм', cm: 'см', m: 'м' }

export function unitLabel(units: Units): string {
  return t(UNIT_LABEL[units])
}

export function formatLenUnit(mm: number, units: Units): string {
  return `${formatLen(mm, units)} ${unitLabel(units)}`
}

export function formatArea(m2: number): string {
  return `${m2.toFixed(2)} ${t('м²')}`
}

export function formatAngle(deg: number): string {
  const r = Math.round(deg * 10) / 10
  return `${Number.isInteger(r) ? r : r.toFixed(1)}°`
}

const UNIT_MM: Record<string, number> = {
  mm: 1,
  мм: 1,
  cm: 10,
  см: 10,
  m: 1000,
  м: 1000,
}

function parseNumberWithUnit(s: string, units: Units): number | null {
  const m = /^([0-9]*[.,]?[0-9]+|[0-9]+[.,]?)\s*(mm|cm|m|мм|см|м)?$/i.exec(s.trim())
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(n)) return null
  const k = m[2] ? UNIT_MM[m[2].toLowerCase()] : UNIT_MM[units]
  return n * (k ?? 1)
}

/**
 * Typed input while drawing: `length` or `length<angle`. Length is in document units unless a
 * suffix (mm/cm/m, мм/см/м) is given; ',' and '.' are both decimal separators. Angle in degrees,
 * counted counter-clockwise from +x as on a drawing (so 90 points up).
 */
export function parseLengthInput(text: string, units: Units): { length: number; angleDeg?: number } | null {
  const parts = text.split('<')
  if (parts.length > 2) return null
  const length = parseNumberWithUnit(parts[0], units)
  if (length === null || length <= 0) return null
  if (parts.length === 2) {
    const a = Number.parseFloat(parts[1].replace(',', '.').replace('°', ''))
    if (!Number.isFinite(a)) return null
    return { length, angleDeg: a }
  }
  return { length }
}

/** characters accepted by the typed-length buffer */
export function isLengthChar(ch: string): boolean {
  return /^[0-9.,<mcмс ]$/i.test(ch)
}
