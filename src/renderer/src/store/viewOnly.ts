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

/** openings the published plan itself hides (own flag, layer or group): their walls stay solid */
let authorHiddenOpenings: ReadonlySet<string> = new Set()

export function setAuthorHiddenOpenings(ids: ReadonlySet<string>): void {
  authorHiddenOpenings = ids
}

/**
 * Whether a hidden opening still cuts its wall: in the viewer an opening the visitor hid keeps its
 * hole (a hidden door is still a doorway), one the author hid does not; in the app a hidden opening
 * leaves the wall solid.
 */
export function keepsHole(openingId: string): boolean {
  return viewOnly && !authorHiddenOpenings.has(openingId)
}

/**
 * The tool Esc switches the 2D editor to, or null to stay: the editor goes back to Select, a
 * view-only plan keeps its Pan tool (Select would show selection outlines and rename prompts).
 */
export function toolAfterEscape(toolId: string, viewOnly: boolean = isViewOnly()): 'select' | null {
  if (viewOnly) return null
  return toolId !== 'select' ? 'select' : null
}
