/**
 * The editor behind the start screen must not be reachable: no Tab into its toolbar, no Enter on a
 * hidden button, no File menu over the screen. The shell parts come before the screen in the app root
 * (top bar, panels, status bar); dialogs and overlays come after it and stay usable (settings, the
 * crash-recovery question, a dropped-file question).
 */
export interface InertTarget {
  inert: boolean
  previousElementSibling: InertTarget | null
}

/** makes everything before `el` in its parent inert; returns the undo */
export function makeEditorInert(el: InertTarget): () => void {
  const changed: InertTarget[] = []
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.inert) continue
    s.inert = true
    changed.push(s)
  }
  return () => {
    for (const s of changed) s.inert = false
  }
}
