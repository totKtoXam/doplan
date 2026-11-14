import type { RenderSettings } from '@core/types'
import { tx } from './catalog'

/** edits doc.render through a transaction (merge key groups slider drags) */
export function setRender(label: string, patch: Partial<RenderSettings>, merge?: string): void {
  tx(label, (d) => Object.assign(d.render, patch), merge)
}

/** 13.5 → "13:30" */
export function formatTime(h: number): string {
  const total = Math.round(h * 60)
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
