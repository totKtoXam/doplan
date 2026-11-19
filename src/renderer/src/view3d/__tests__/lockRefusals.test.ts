import { describe, expect, it } from 'vitest'
import { createLockRefusals } from '../lockRefusals'

describe('createLockRefusals', () => {
  it('one refusal (the re-lock cooldown after Esc) is not persistent', () => {
    const r = createLockRefusals()
    r.refused()
    expect(r.persistent()).toBe(false)
  })

  it('refusals in a row are persistent until the mouse is captured', () => {
    const r = createLockRefusals()
    r.refused()
    r.refused()
    expect(r.persistent()).toBe(true)
    r.locked()
    expect(r.persistent()).toBe(false)
    r.refused()
    expect(r.persistent()).toBe(false)
  })
})
