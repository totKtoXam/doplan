/**
 * View-only mode of the published plan viewer (pages viewer): the 2D plan and the 3D scene are shown
 * but never edited. The viewer switches it on once at boot; the editors read it to skip what only
 * makes sense while editing (2D context menu, 3D selection / drag / gizmos).
 */
let viewOnly = false

export function isViewOnly(): boolean {
  return viewOnly
}

export function setViewOnly(value: boolean): void {
  viewOnly = value
}
