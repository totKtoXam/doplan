import { describe, expect, it } from 'vitest'
import { createLockRefusals } from '../lockRefusals'

describe('createLockRefusals', () => {
  it('one refusal (the window not focused yet) is not persistent', () => {
    const r = createLockRefusals()
    r.refused(10_000)
    expect(r.persistent()).toBe(false)
  })

  it('refusals on separate clicks with no capture between are persistent until the mouse is captured', () => {
    const r = createLockRefusals()
    r.refused(10_000)
    r.refused(11_000)
    expect(r.persistent()).toBe(true)
    r.locked()
    expect(r.persistent()).toBe(false)
    r.refused(20_000)
    expect(r.persistent()).toBe(false)
  })

  it('an impatient double click (or several clicks, M) within the cooldown after Esc is not persistent', () => {
    const r = createLockRefusals()
    r.locked()
    r.unlocked(5_000) // Esc
    r.refused(5_300) // double click
    r.refused(5_450)
    r.refused(5_900) // a third click
    r.refused(6_200) // M
    expect(r.persistent()).toBe(false)
  })

  it('a double click is one click: its two refusals count once', () => {
    const r = createLockRefusals()
    r.refused(10_000)
    r.refused(10_200)
    expect(r.persistent()).toBe(false)
    r.refused(12_000)
    expect(r.persistent()).toBe(true)
  })

  it('an old refusal plus one in a fresh cooldown is not persistent', () => {
    const r = createLockRefusals()
    r.refused(10_000) // minutes ago
    r.unlocked(200_000)
    r.refused(200_400)
    expect(r.persistent()).toBe(false)
  })

  it('reset (walk mode left, capture setting changed) forgets the refusals', () => {
    const r = createLockRefusals()
    r.refused(10_000)
    r.refused(12_000)
    r.reset()
    expect(r.persistent()).toBe(false)
  })
})
