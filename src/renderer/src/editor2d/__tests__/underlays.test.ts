import { describe, expect, it } from 'vitest'
import { UNDERLAY_MAX_PIXELS, underlayDecodeSize } from '../layers/underlays'

describe('underlay decode size', () => {
  it('keeps a phone photo as is', () => {
    expect(underlayDecodeSize(4032, 3024)).toBeNull()
  })

  it('scales a big scan down to the limit, keeping its proportions', () => {
    const s = underlayDecodeSize(12000, 9000)!
    expect(s.w * s.h).toBeLessThanOrEqual(UNDERLAY_MAX_PIXELS)
    expect(s.w * s.h).toBeGreaterThan(UNDERLAY_MAX_PIXELS * 0.99)
    expect(s.w / s.h).toBeCloseTo(12000 / 9000, 2)
  })

  it('leaves an unknown size alone', () => {
    expect(underlayDecodeSize(0, 0)).toBeNull()
  })
})
