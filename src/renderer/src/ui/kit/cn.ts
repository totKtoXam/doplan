import clsx, { type ClassValue } from 'clsx'

/** className combiner used by every kit component */
export function cn(...v: ClassValue[]): string {
  return clsx(v)
}

let gestureSeq = 0
/** unique id of one user gesture (drag, focus session, picker session) — used as history merge key suffix */
export function newGesture(prefix = 'g'): string {
  gestureSeq += 1
  return `${prefix}${Date.now().toString(36)}_${gestureSeq}`
}

export function clamp(v: number, min = -Infinity, max = Infinity): number {
  return Math.min(max, Math.max(min, v))
}

/** shared input chrome */
export const inputBase =
  'h-7 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] ' +
  'outline-none transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]'
