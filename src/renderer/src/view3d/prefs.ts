/**
 * Per-user preferences of the 3D view (area: 3d-rendering) that are not part of the document.
 * Kept in localStorage: they belong to this user on this machine, not to a project. The module
 * has no three.js dependency, so the shell imports it without loading the 3D chunk.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

/**
 * Path tracing in the viewport:
 *  - 'off': realtime only
 *  - 'manual': started and stopped with the button
 *  - 'auto': starts by itself once the camera and the document rest
 * In both tracing modes motion and edits show the realtime frame and tracing resumes on rest.
 */
export type TraceMode = 'off' | 'manual' | 'auto'

interface Prefs3D {
  traceMode: TraceMode
  setTraceMode(m: TraceMode): void
}

const TRACE_KEY = 'doplan.traceMode'

function readTraceMode(): TraceMode {
  try {
    const v = globalThis.localStorage?.getItem(TRACE_KEY)
    if (v === 'off' || v === 'manual' || v === 'auto') return v
  } catch {
    /* storage unavailable */
  }
  return 'manual'
}

export const prefs3dStore = createStore<Prefs3D>()((set) => ({
  traceMode: readTraceMode(),
  setTraceMode(m) {
    try {
      globalThis.localStorage?.setItem(TRACE_KEY, m)
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    set({ traceMode: m })
  },
}))

export function usePrefs3d<T>(sel: (s: Prefs3D) => T): T {
  return useStore(prefs3dStore, sel)
}
