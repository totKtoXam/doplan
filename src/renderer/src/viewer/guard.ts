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

export function viewerEdit(fn: () => void): void {
  allowed++
  try {
    fn()
  } finally {
    allowed--
  }
}
