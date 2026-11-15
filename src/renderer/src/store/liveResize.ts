/**
 * "A panel border is being dragged" — set by the sashes (ui/kit/Sash.tsx). Heavy views (the 3D
 * engine) read it to resize cheaply while it lasts and once more at full quality when it ends.
 */
let active = 0
const ends = new Set<() => void>()

export function isLiveResizing(): boolean {
  return active > 0
}

export function beginLiveResize(): void {
  active++
}

export function endLiveResize(): void {
  if (active === 0) return
  active--
  if (active === 0) for (const cb of Array.from(ends)) cb()
}

/** called when the last live resize ends; returns the unsubscribe */
export function onLiveResizeEnd(cb: () => void): () => void {
  ends.add(cb)
  return () => {
    ends.delete(cb)
  }
}
