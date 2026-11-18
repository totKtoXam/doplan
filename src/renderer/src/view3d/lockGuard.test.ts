import { describe, expect, it, vi } from 'vitest'
import { browserLockEnv, installLockGuard, MODAL_SELECTOR } from './lockGuard'

/** a document with an EventTarget, a body and a settable "is a dialog open" answer */
function fakeDoc() {
  const t = new EventTarget() as EventTarget & { hidden: boolean; body: object; modal: boolean; querySelector(sel: string): object | null }
  t.hidden = false
  t.body = {}
  t.modal = false
  t.querySelector = (sel: string) => (sel === MODAL_SELECTOR && t.modal ? {} : null)
  return t
}

/** observer fakes that hand their callbacks to the test */
function fakeObservers() {
  const ro: { cb?: (e: { contentRect: { width: number; height: number } }[]) => void; off: boolean } = { off: false }
  const mo: { cb?: () => void; off: boolean } = { off: false }
  class RO {
    constructor(cb: NonNullable<typeof ro.cb>) {
      ro.cb = cb
    }
    observe() {}
    disconnect() {
      ro.off = true
    }
  }
  class MO {
    constructor(cb: () => void) {
      mo.cb = cb
    }
    observe() {}
    disconnect() {
      mo.off = true
    }
  }
  return { ro, mo, RO, MO }
}

function setup() {
  const win = new EventTarget()
  const doc = fakeDoc()
  const o = fakeObservers()
  const release = vi.fn()
  const stop = installLockGuard({} as Element, release, browserLockEnv(win, doc as never, o.RO as never, o.MO as never))
  return { win, doc, o, release, stop }
}

describe('walk pointer lock guard', () => {
  it('releases the lock when the 3D canvas is hidden (switching to the 2D plan: display:none)', () => {
    const { o, release } = setup()
    o.ro.cb?.([{ contentRect: { width: 800, height: 600 } }])
    expect(release).not.toHaveBeenCalled()
    o.ro.cb?.([{ contentRect: { width: 0, height: 0 } }])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the window loses focus or the page is hidden', () => {
    const { win, doc, release } = setup()
    win.dispatchEvent(new Event('blur'))
    expect(release).toHaveBeenCalledTimes(1)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(release).toHaveBeenCalledTimes(1)
    doc.hidden = true
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('releases the lock when a modal dialog opens (settings, render, history… opened by keyboard)', () => {
    const { doc, o, release } = setup()
    o.mo.cb?.()
    expect(release).not.toHaveBeenCalled()
    doc.modal = true
    o.mo.cb?.()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases at once when a dialog is already open, and stops watching once the lock is gone', () => {
    const win = new EventTarget()
    const doc = fakeDoc()
    doc.modal = true
    const o = fakeObservers()
    const release = vi.fn()
    const stop = installLockGuard({} as Element, release, browserLockEnv(win, doc as never, o.RO as never, o.MO as never))
    expect(release).toHaveBeenCalledTimes(1)
    stop()
    expect(o.ro.off && o.mo.off).toBe(true)
    win.dispatchEvent(new Event('blur'))
    o.mo.cb?.()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('matches the kit dialog and native dialogs', () => {
    expect(MODAL_SELECTOR).toContain('[role="dialog"]')
    expect(MODAL_SELECTOR).toContain('[aria-modal="true"]')
    expect(MODAL_SELECTOR).toContain('dialog[open]')
  })
})
