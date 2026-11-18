/**
 * The render quality a published plan opens with. Desktop: the author's preset, never below
 * `high` (a site is looked at, not edited: the medium preset of the app's iGPU budget made it soft).
 * Phones: `low`, tablets: `medium` at most. A preset the viewer picked is remembered in this browser.
 */
import type { QualityPreset } from '@core/types'

const ORDER: QualityPreset[] = ['low', 'medium', 'high', 'ultra']
const KEY = 'doplan.viewer.quality'

export interface ViewerDevice {
  /** touch is the main input */
  coarse: boolean
  /** the shorter edge of the screen (not the window: a small window on a desktop is still one), CSS px */
  screenMin: number
}

const isPreset = (v: unknown): v is QualityPreset => typeof v === 'string' && (ORDER as string[]).includes(v)
const rank = (q: QualityPreset) => ORDER.indexOf(q)

export function viewerQuality(author: QualityPreset | undefined, device: ViewerDevice, stored: unknown): QualityPreset {
  if (isPreset(stored)) return stored
  if (device.coarse) return device.screenMin < 600 || author === 'low' ? 'low' : 'medium'
  const own = isPreset(author) ? author : 'high'
  return rank(own) >= rank('high') ? own : 'high'
}

export function currentDevice(): ViewerDevice {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const s = typeof screen !== 'undefined' ? Math.min(screen.width || 0, screen.height || 0) : 0
  return { coarse, screenMin: s || Math.min(window.innerWidth, window.innerHeight) }
}

export function storedQuality(): unknown {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function rememberQuality(q: QualityPreset): void {
  try {
    localStorage.setItem(KEY, q)
  } catch {
    /* private mode, blocked storage: the choice lasts for this visit */
  }
}
