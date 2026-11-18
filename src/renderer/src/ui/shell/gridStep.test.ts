import { describe, expect, it } from 'vitest'
import { GRID_SIZES, gridOptions, parseGridStep } from './gridStep'

describe('grid step typed by hand', () => {
  it('reads millimetres, centimetres and metres', () => {
    expect(parseGridStep('200')).toBe(200)
    expect(parseGridStep(' 25 мм ')).toBe(25)
    expect(parseGridStep('30 см')).toBe(300)
    expect(parseGridStep('0,5 м')).toBe(500)
    expect(parseGridStep('1.2m')).toBe(1200)
  })

  it('keeps the step within 1–5000 mm and refuses what is not a number', () => {
    expect(parseGridStep('0.2')).toBe(1)
    expect(parseGridStep('9 м')).toBe(5000)
    expect(parseGridStep('0')).toBeNull()
    expect(parseGridStep('')).toBeNull()
    expect(parseGridStep('abc')).toBeNull()
    expect(parseGridStep('-100')).toBeNull()
  })

  it('a typed step shows among the presets in order', () => {
    expect(gridOptions(100)).toEqual(GRID_SIZES)
    expect(gridOptions(200)).toEqual([10, 50, 100, 200, 250, 500, 1000])
  })
})
