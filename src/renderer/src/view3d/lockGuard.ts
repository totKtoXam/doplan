/**
 * The walk-mode pointer lock must never outlive the 3D view the user is looking at: Chromium keeps it
 * on a canvas hidden with display:none (switching to the 2D plan) and under any DOM dialog, and then
 * the cursor is gone and every click still goes to the invisible canvas. While the lock is held this
 * guard releases it when the window loses focus, the page is hidden, the canvas collapses to nothing,
 * or a modal dialog appears. The browser hooks come in as an environment so tests can drive them.
 */

/** what counts as a modal dialog on the page (kit Overlay, native <dialog>, alert dialogs) */
export const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'

type Unsub = () => void

export interface LockGuardEnv {
  onWindowBlur(cb: () => void): Unsub
  onPageHidden(cb: () => void): Unsub
  /** `el` is laid out at zero size (display:none, a collapsed panel) */
  onCollapsed(el: Element, cb: () => void): Unsub
  /** a modal dialog is (or becomes) part of the page */
  onModal(cb: () => void): Unsub
}

interface DocLike extends EventTarget {
  hidden?: boolean
  body?: Node | null
  querySelector(sel: string): Element | null
}

type ResizeObserverCtor = new (cb: (entries: { contentRect: { width: number; height: number } }[]) => void) => { observe(el: Element): void; disconnect(): void }
type MutationObserverCtor = new (cb: () => void) => { observe(node: Node, opts: { childList: boolean; subtree: boolean; attributes: boolean; attributeFilter: string[] }): void; disconnect(): void }

/** the hooks over a real window / document (constructors injectable for tests) */
export function browserLockEnv(
  win: EventTarget = window,
  doc: DocLike = document,
  RO: ResizeObserverCtor | undefined = typeof ResizeObserver === 'function' ? (ResizeObserver as unknown as ResizeObserverCtor) : undefined,
  MO: MutationObserverCtor | undefined = typeof MutationObserver === 'function' ? (MutationObserver as unknown as MutationObserverCtor) : undefined,
): LockGuardEnv {
  return {
    onWindowBlur(cb) {
      win.addEventListener('blur', cb)
      return () => win.removeEventListener('blur', cb)
    },
    onPageHidden(cb) {
      const fn = () => {
        if (doc.hidden) cb()
      }
      doc.addEventListener('visibilitychange', fn)
      return () => doc.removeEventListener('visibilitychange', fn)
    },
    onCollapsed(el, cb) {
      if (!RO) return () => undefined
      const ro = new RO((entries) => {
        if (entries.some((e) => e.contentRect.width <= 0 || e.contentRect.height <= 0)) cb()
      })
      ro.observe(el)
      return () => ro.disconnect()
    },
    onModal(cb) {
      const check = () => {
        if (doc.querySelector(MODAL_SELECTOR)) cb()
      }
      check()
      if (!MO || !doc.body) return () => undefined
      const mo = new MO(check)
      mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] })
      return () => mo.disconnect()
    },
  }
}

/** watches while the lock is held; returns the stop function (call it when the lock is gone) */
export function installLockGuard(el: Element, release: () => void, env: LockGuardEnv = browserLockEnv()): Unsub {
  let stopped = false
  const fire = () => {
    if (!stopped) release()
  }
  const subs = [env.onWindowBlur(fire), env.onPageHidden(fire), env.onCollapsed(el, fire), env.onModal(fire)]
  return () => {
    if (stopped) return
    stopped = true
    for (const s of subs) s()
  }
}
