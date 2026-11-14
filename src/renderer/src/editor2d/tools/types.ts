import type { EditorCtx, PointerInfo } from '../context'
import type { Painter } from '../painter'
import type { Handle } from '../handles'

/** One interactive tool of the 2D editor. All coordinates in PointerInfo are unsnapped. */
export interface Tool {
  /** CSS cursor while the tool is idle */
  cursor: string
  activate?(): void
  deactivate?(): void
  pointerDown?(e: PointerInfo): void
  pointerMove?(e: PointerInfo): void
  pointerUp?(e: PointerInfo): void
  doubleClick?(e: PointerInfo): void
  /** return true when the key was consumed */
  keyDown?(e: KeyboardEvent): boolean
  /** Esc: abort the current operation; return false when there was nothing to cancel */
  cancel?(): boolean
  /** screen-space preview drawn above everything else */
  draw?(p: Painter): void
  /** handle currently being dragged (highlighted by the overlay) */
  activeHandle?(): Handle | null
}

export type ToolFactory = (ctx: EditorCtx) => Tool
