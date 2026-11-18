/**
 * The viewer never changes the plan: every document transaction is dropped unless it runs inside
 * `viewerEdit` (the viewer's own display toggles: render quality, wall cut-away, ceiling).
 */
import { docStore } from '@/store/document'

let allowed = 0
let installed = false

export function installEditGuard(): void {
  if (installed) return
  installed = true
  const transact = docStore.getState().transact
  docStore.setState({
    transact(label, fn, opts) {
      if (allowed > 0) transact(label, fn, opts)
    },
  })
}

interface ToolState {
  tool: string
  selection: readonly unknown[]
}

/**
 * The viewer's 2D plan stays on the Pan tool with nothing selected, whatever switches it (Esc, a
 * tool's own fallback): no selection outlines, handles or rename prompts in a read-only page.
 */
export function lockViewerTool<S extends ToolState>(store: { getState(): S; setState(p: Partial<S>): void; subscribe(fn: (s: S) => void): () => void }): () => void {
  const fix = (s: S) => {
    if (s.tool !== 'pan' || s.selection.length) store.setState({ tool: 'pan', selection: [] } as unknown as Partial<S>)
  }
  fix(store.getState())
  return store.subscribe(fix)
}

export function viewerEdit(fn: () => void): void {
  allowed++
  try {
    fn()
  } finally {
    allowed--
  }
}
