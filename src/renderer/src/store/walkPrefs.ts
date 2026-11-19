/**
 * Preferences of the first-person (walk) 3D camera, remembered across sessions in localStorage
 * (per user, not in the document):
 *  - captureMouse: a click in walk mode captures the mouse (Pointer Lock: the mouse turns the view,
 *    a centre crosshair aims). Off: the cursor stays free, the view turns while a mouse button is
 *    held, a click reaches the UI and the objects under the cursor. Key M in walk mode toggles it.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

interface WalkPrefs {
  captureMouse: boolean
  setCaptureMouse(v: boolean): void
}

const KEY = 'doplan.walkPrefs'

function load(): Partial<Pick<WalkPrefs, 'captureMouse'>> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' && typeof v.captureMouse === 'boolean' ? { captureMouse: v.captureMouse } : {}
  } catch {
    return {}
  }
}

function save(s: WalkPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ captureMouse: s.captureMouse }))
  } catch {
    /* private mode / quota: keep in memory */
  }
}

export const walkPrefs = createStore<WalkPrefs>()((set, get) => ({
  captureMouse: true,
  ...load(),
  setCaptureMouse(v) {
    if (get().captureMouse === v) return
    set({ captureMouse: v })
    save(get())
    // turning it off gives the mouse back at once
    if (!v && typeof document !== 'undefined' && document.pointerLockElement) {
      try {
        document.exitPointerLock()
      } catch {
        /* already released */
      }
    }
  },
}))

export function useWalkPrefs<T>(selector: (s: WalkPrefs) => T): T {
  return useStore(walkPrefs, selector)
}
