/**
 * Slow background work of the 3D view (area: 3d-rendering), shown in the viewport overlay so a
 * pause never looks like a freeze. No three.js dependency: the shell imports it directly.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

/**
 * Path tracer stage:
 *  - 'idle': nothing slow running (realtime frame, or the traced image is shown)
 *  - 'preparing': shaders / BVH / scene upload before the first sample
 *  - 'tracing': first samples accumulate behind the realtime frame
 */
export type PtStage = 'idle' | 'preparing' | 'tracing'

interface Status3D {
  ptStage: PtStage
  /** item models still loading / started since the last time none was loading */
  modelsPending: number
  modelsTotal: number
}

export const status3dStore = createStore<Status3D>()(() => ({ ptStage: 'idle', modelsPending: 0, modelsTotal: 0 }))

export function setPtStage(stage: PtStage): void {
  if (status3dStore.getState().ptStage !== stage) status3dStore.setState({ ptStage: stage })
}

export function modelLoadStarted(): void {
  const s = status3dStore.getState()
  status3dStore.setState({ modelsPending: s.modelsPending + 1, modelsTotal: s.modelsTotal + 1 })
}

export function modelLoadEnded(): void {
  const pending = Math.max(0, status3dStore.getState().modelsPending - 1)
  status3dStore.setState(pending === 0 ? { modelsPending: 0, modelsTotal: 0 } : { modelsPending: pending })
}

export function useStatus3d<T>(sel: (s: Status3D) => T): T {
  return useStore(status3dStore, sel)
}
