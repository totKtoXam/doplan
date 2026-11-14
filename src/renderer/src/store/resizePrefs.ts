/**
 * Preferences of direct resizing shared by the inspector («Сохранять пропорции»), the 2D handles and
 * the 3D handles; remembered across sessions in localStorage (per user, not in the document).
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

interface ResizePrefs {
  /** uniform scaling when a size is changed */
  lockRatio: boolean
  /** the «модель растягивается» hint for GLB models was shown once */
  stretchHintShown: boolean
  setLockRatio(v: boolean): void
  markStretchHint(): void
}

const KEY = 'doplan.resizePrefs'

function load(): Partial<Pick<ResizePrefs, 'lockRatio' | 'stretchHintShown'>> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' ? { lockRatio: v.lockRatio === true, stretchHintShown: v.stretchHintShown === true } : {}
  } catch {
    return {}
  }
}

function save(s: ResizePrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ lockRatio: s.lockRatio, stretchHintShown: s.stretchHintShown }))
  } catch {
    /* private mode / quota: keep in memory */
  }
}

export const resizePrefs = createStore<ResizePrefs>()((set, get) => ({
  lockRatio: false,
  stretchHintShown: false,
  ...load(),
  setLockRatio(v) {
    set({ lockRatio: v })
    save(get())
  },
  markStretchHint() {
    set({ stretchHintShown: true })
    save(get())
  },
}))

export function useResizePrefs<T>(selector: (s: ResizePrefs) => T): T {
  return useStore(resizePrefs, selector)
}
