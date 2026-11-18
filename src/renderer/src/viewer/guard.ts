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
}

/**
 * The viewer's 2D plan stays on the Pan tool, whatever switches it (Esc, a tool's own fallback): no
 * handles, drags or rename prompts in a read-only page. The selection is the viewer's own (the
 * element card): it is outlined, never edited.
 */
export function lockViewerTool<S extends ToolState>(store: { getState(): S; setState(p: Partial<S>): void; subscribe(fn: (s: S) => void): () => void }): () => void {
  const fix = (s: S) => {
    if (s.tool !== 'pan') store.setState({ tool: 'pan' } as unknown as Partial<S>)
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
