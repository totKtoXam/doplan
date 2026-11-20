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

/**
 * The published light of the walls, floors and ceilings (viewer):
 *  - 'none': the plan was published without it;
 *  - 'loading': its picture is on the way;
 *  - 'on': shown;
 *  - 'live': the visitor chose the live light;
 *  - 'mismatch': what is shown differs from what was baked (a hidden object, another level), so the
 *    light is live.
 */
export type BakedState = 'none' | 'loading' | 'on' | 'live' | 'mismatch'

interface Status3D {
  ptStage: PtStage
  /** item models still loading / started since the last time none was loading */
  modelsPending: number
  modelsTotal: number
  /**
   * Bumped each time frames stay slow (over ~30 fps) although the resolution is already at its
   * lowest: the quality preset is too heavy for this GPU. The viewer lowers it a step; the editor
   * leaves the choice to the user.
   */
  struggling: number
  /**
   * Bumped when the renderer was made again after the GPU device was lost: the backend may have
   * changed (a second loss falls back to WebGL 2), and what depends on it is decided again.
   */
  rendererSwaps: number
  baked: BakedState
}

export const status3dStore = createStore<Status3D>()(() => ({ ptStage: 'idle', modelsPending: 0, modelsTotal: 0, struggling: 0, rendererSwaps: 0, baked: 'none' }))

export function markStruggling(): void {
  status3dStore.setState({ struggling: status3dStore.getState().struggling + 1 })
}

export function markRendererSwapped(): void {
  status3dStore.setState({ rendererSwaps: status3dStore.getState().rendererSwaps + 1 })
}

export function setBakedState(baked: BakedState): void {
  if (status3dStore.getState().baked !== baked) status3dStore.setState({ baked })
}

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
