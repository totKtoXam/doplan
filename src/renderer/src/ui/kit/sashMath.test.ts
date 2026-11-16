import { describe, expect, it } from 'vitest'
import { availableMax, keyStep, resizeBox, resolveDrag, sanitizeSize, splitLimits } from './sashMath'

const lim = { min: 200, max: 600, collapsible: true }

describe('resolveDrag', () => {
  it('clamps to the limits', () => {
    expect(resolveDrag(350.4, lim)).toEqual({ size: 350, collapsed: false })
    expect(resolveDrag(900, lim)).toEqual({ size: 600, collapsed: false })
    expect(resolveDrag(150, lim)).toEqual({ size: 200, collapsed: false })
  })
  it('collapses below half the minimum, VS Code-like', () => {
    expect(resolveDrag(99, lim).collapsed).toBe(true)
    expect(resolveDrag(-40, lim).collapsed).toBe(true)
    // dragging back past half the minimum reopens at the minimum
    expect(resolveDrag(101, lim)).toEqual({ size: 200, collapsed: false })
  })
  it('never collapses a non-collapsible panel', () => {
    expect(resolveDrag(0, { ...lim, collapsible: false })).toEqual({ size: 200, collapsed: false })
  })
  it('keeps the minimum when the space is smaller than it', () => {
    expect(resolveDrag(500, { min: 200, max: 120 })).toEqual({ size: 200, collapsed: false })
  })
})

describe('availableMax', () => {
  it('leaves the fill area its minimum', () => {
    expect(availableMax(900, 320, 800, 320)).toBe(800)
    expect(availableMax(600, 320, 800, 320)).toBe(600)
    expect(availableMax(900, 320, 200, 320)).toBe(200)
    expect(availableMax(900, 0, 100, 320)).toBe(0)
  })
})

describe('keyStep', () => {
  it('moves by 10 px, 50 with Shift, jumps with Home/End', () => {
    expect(keyStep('ArrowRight', false, 300, lim)).toBe(310)
    expect(keyStep('ArrowLeft', true, 300, lim)).toBe(250)
    expect(keyStep('ArrowLeft', false, 205, lim)).toBe(200)
    expect(keyStep('ArrowRight', true, 590, lim)).toBe(600)
    expect(keyStep('Home', false, 300, lim)).toBe(200)
    expect(keyStep('End', false, 300, lim)).toBe(600)
    expect(keyStep('a', false, 300, lim)).toBeNull()
  })
})

describe('sanitizeSize', () => {
  it('accepts stored numbers inside the limits only', () => {
    expect(sanitizeSize(420.6, 300, lim)).toBe(421)
    expect(sanitizeSize(5000, 300, lim)).toBe(600)
    expect(sanitizeSize('420', 300, lim)).toBe(300)
    expect(sanitizeSize(Number.NaN, 300, lim)).toBe(300)
    expect(sanitizeSize(undefined, 300, lim)).toBe(300)
  })
})

describe('splitLimits', () => {
  it('leaves each view its minimum width', () => {
    expect(splitLimits(1000, 200)).toEqual({ min: 0.2, max: 0.8 })
    expect(splitLimits(400, 200)).toEqual({ min: 0.5, max: 0.5 })
  })
  it('never goes past the range a stored ratio is clamped to, on a wide screen too', () => {
    expect(splitLimits(2500, 200)).toEqual({ min: 0.1, max: 0.9 })
    expect(splitLimits(0, 200)).toEqual({ min: 0.1, max: 0.9 })
  })
})

describe('resizeBox', () => {
  const start = { w: 300, h: 200 }
  const min = { w: 200, h: 120 }
  const max = { w: 800, h: 600 }
  it('moves only the axes of the dragged edge', () => {
    expect(resizeBox(start, 'e', 50, 40, min, max)).toEqual({ w: 350, h: 200 })
    expect(resizeBox(start, 's', 50, 40, min, max)).toEqual({ w: 300, h: 240 })
    expect(resizeBox(start, 'se', 50, 40, min, max)).toEqual({ w: 350, h: 240 })
  })
  it('grows against the pointer on the west and north edges', () => {
    expect(resizeBox(start, 'w', -50, 0, min, max)).toEqual({ w: 350, h: 200 })
    expect(resizeBox(start, 'nw', 20, 30, min, max)).toEqual({ w: 280, h: 170 })
  })
  it('doubles the change of a centred box, so the edge follows the pointer', () => {
    expect(resizeBox(start, 'e', 50, 0, min, max, 2)).toEqual({ w: 400, h: 200 })
  })
  it('stays inside the limits, the minimum winning over a smaller space', () => {
    expect(resizeBox(start, 'se', -500, 900, min, max)).toEqual({ w: 200, h: 600 })
    expect(resizeBox(start, 'e', 900, 0, min, { w: 150, h: 600 })).toEqual({ w: 200, h: 200 })
  })
})
