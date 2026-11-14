/**
 * Imperative handles of the mounted viewports. Viewport2D / Viewport3D fill these in;
 * actions and panels read them (always check for null).
 */
import type { Editor2DHandle, Engine3DHandle } from '@/contracts'

export interface Handles {
  editor2d: Editor2DHandle | null
  engine3d: Engine3DHandle | null
}

export const handles: Handles = { editor2d: null, engine3d: null }

type Listener = () => void
const listeners = new Set<Listener>()

/** Set a handle and notify listeners (use this instead of assigning directly). */
export function setHandle<K extends keyof Handles>(key: K, value: Handles[K]): void {
  handles[key] = value
  for (const l of listeners) l()
}

export function onHandlesChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Resolves when the 3D engine is mounted (or null after `timeoutMs`). */
export function waitForEngine3D(timeoutMs = 30000): Promise<Engine3DHandle | null> {
  if (handles.engine3d) return Promise.resolve(handles.engine3d)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(handles.engine3d)
    }, timeoutMs)
    const off = onHandlesChange(() => {
      if (handles.engine3d) {
        clearTimeout(timer)
        off()
        resolve(handles.engine3d)
      }
    })
  })
}
