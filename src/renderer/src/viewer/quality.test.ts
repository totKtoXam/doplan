import { describe, expect, it } from 'vitest'
import { frameDpr } from '@/view3d/quality'
import { viewerQuality } from './quality'

const desktop = { coarse: false, screenMin: 1080 }
const phone = { coarse: true, screenMin: 390 }
const tablet = { coarse: true, screenMin: 820 }

describe('viewer quality', () => {
  it("desktop: the author's preset, never below high, also in a small window", () => {
    expect(viewerQuality('ultra', desktop, null)).toBe('ultra')
    expect(viewerQuality('high', desktop, null)).toBe('high')
    expect(viewerQuality('medium', desktop, null)).toBe('high')
    expect(viewerQuality('low', desktop, null)).toBe('high')
    expect(viewerQuality(undefined, desktop, null)).toBe('high')
  })

  it('phones low, tablets medium at most', () => {
    expect(viewerQuality('ultra', phone, null)).toBe('low')
    expect(viewerQuality('ultra', tablet, null)).toBe('medium')
    expect(viewerQuality('low', tablet, null)).toBe('low')
  })

  it("the viewer's own choice wins; junk in storage is ignored", () => {
    expect(viewerQuality('ultra', desktop, 'medium')).toBe('medium')
    expect(viewerQuality('low', phone, 'high')).toBe('high')
    expect(viewerQuality('ultra', desktop, 'max')).toBe('ultra')
  })
})

describe('frame pixel ratio', () => {
  const sharp = { restMax: 2, movingMin: 1 }

  it("the app keeps the presets' caps", () => {
    expect(frameDpr('high', 2, false, 1, null)).toBe(1.5)
    expect(frameDpr('high', 2, true, 0.6, null)).toBeCloseTo(0.6)
    expect(frameDpr('medium', 2, true, 1, null)).toBe(0.85)
  })

  it('the viewer: full device ratio (up to 2) at rest, not below 1 while moving on high', () => {
    expect(frameDpr('high', 2, false, 1, sharp)).toBe(2)
    expect(frameDpr('high', 3, false, 1, sharp)).toBe(2)
    expect(frameDpr('high', 1.25, false, 1, sharp)).toBe(1.25)
    expect(frameDpr('high', 2, true, 1, sharp)).toBe(1)
    expect(frameDpr('ultra', 2, true, 1, sharp)).toBe(1.25)
    // one adaptive step down (0.88) keeps the floor; a frame rate that stays low gets past it
    expect(frameDpr('high', 2, true, 0.88, sharp)).toBe(1)
    expect(frameDpr('high', 2, true, 0.6, sharp)).toBeCloseTo(0.6)
    // a device below the floor is never upscaled
    expect(frameDpr('high', 0.9, true, 1, sharp)).toBe(0.9)
  })

  it('the viewer leaves low and medium as they are (phones, tablets)', () => {
    expect(frameDpr('low', 3, false, 1, sharp)).toBe(1)
    expect(frameDpr('medium', 3, true, 1, sharp)).toBe(0.85)
  })
})
