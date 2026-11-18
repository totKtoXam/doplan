/**
 * Extra walk-mode input besides the keyboard: an on-screen stick (touch screens of the published
 * viewer) sets the axes here, the walk controls read them every frame. Values are in [-1, 1].
 */
export const walkStick = { forward: 0, strafe: 0 }

/** requests a frame of the 3D view that owns the walk controls (set by view3d/controls) */
let kick: (() => void) | null = null

export function setWalkKick(fn: (() => void) | null): void {
  kick = fn
}

export function setWalkStick(forward: number, strafe: number): void {
  walkStick.forward = Math.max(-1, Math.min(1, forward))
  walkStick.strafe = Math.max(-1, Math.min(1, strafe))
  kick?.()
}

/** the element that currently holds the pointer lock is a 3D canvas in walk mode */
export function walkPointerLocked(canvas: Element | null): boolean {
  return typeof document !== 'undefined' && !!canvas && document.pointerLockElement === canvas
}
