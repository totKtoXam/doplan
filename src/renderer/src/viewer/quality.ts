/**
 * The render quality a published plan opens with. Desktop with WebGPU: the author's preset, never
 * below `high` (a site is looked at, not edited: the medium preset of the app's iGPU budget made it
 * soft). Without WebGPU (WebGL 2: no TRAA) `medium` to `high`. Phones: `low`, tablets: `medium` at
 * most. A preset the visitor picked is remembered in this browser, but never above the device's cap:
 * one that crashed the tab would otherwise open again on every visit.
 */
import type { QualityPreset } from '@core/types'

const ORDER: QualityPreset[] = ['low', 'medium', 'high', 'ultra']
const KEY = 'doplan.viewer.quality'

export interface ViewerDevice {
  /** touch is the main input */
  coarse: boolean
  /** the shorter edge of the screen (not the window: a small window on a desktop is still one), CSS px */
  screenMin: number
  /** the browser offers WebGPU (else the 3D view runs on WebGL 2) */
  webgpu?: boolean
}

const isPreset = (v: unknown): v is QualityPreset => typeof v === 'string' && (ORDER as string[]).includes(v)
const rank = (q: QualityPreset) => ORDER.indexOf(q)

/** the highest preset this device opens with */
function deviceCap(device: ViewerDevice): QualityPreset {
  if (device.coarse) return device.screenMin < 600 ? 'low' : 'medium'
  return device.webgpu === false ? 'high' : 'ultra'
}

const clamp = (q: QualityPreset, lo: QualityPreset, hi: QualityPreset): QualityPreset => (rank(q) < rank(lo) ? lo : rank(q) > rank(hi) ? hi : q)

export function viewerQuality(author: QualityPreset | undefined, device: ViewerDevice, stored: unknown): QualityPreset {
  const cap = deviceCap(device)
  if (isPreset(stored)) return rank(stored) <= rank(cap) ? stored : cap
  if (device.coarse) return author === 'low' ? 'low' : cap
  const own = isPreset(author) ? author : 'high'
  return clamp(own, device.webgpu === false ? 'medium' : 'high', cap)
}

export function currentDevice(): ViewerDevice {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const s = typeof screen !== 'undefined' ? Math.min(screen.width || 0, screen.height || 0) : 0
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu
  return { coarse, screenMin: s || Math.min(window.innerWidth, window.innerHeight), webgpu }
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
