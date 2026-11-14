import { describe, expect, it } from 'vitest'
import { arrowHead, badgeAnchor, isMeaningful, type MarkupShape, markupBadge, markupMetrics } from './markup'

const red = '#e5484d'

describe('image markup helpers', () => {
  it('badge sits at the line start, the arrow tail and the frame top-left corner', () => {
    const pen: MarkupShape = { kind: 'pen', color: red, points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 80, y: 40 }] }
    const rect: MarkupShape = { kind: 'rect', color: red, points: [{ x: 300, y: 200 }, { x: 100, y: 50 }] }
    const arrow: MarkupShape = { kind: 'arrow', color: red, points: [{ x: 5, y: 5 }, { x: 90, y: 90 }] }
    expect(badgeAnchor(pen)).toEqual({ x: 10, y: 20 })
    expect(badgeAnchor(rect)).toEqual({ x: 100, y: 50 })
    expect(badgeAnchor(arrow)).toEqual({ x: 5, y: 5 })
  })

  it('drops clicks and tiny drags, keeps real marks', () => {
    expect(isMeaningful({ kind: 'pen', color: red, points: [{ x: 0, y: 0 }] }, 6)).toBe(false)
    expect(isMeaningful({ kind: 'pen', color: red, points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }] }, 6)).toBe(true)
    // a frame needs both sides
    expect(isMeaningful({ kind: 'rect', color: red, points: [{ x: 0, y: 0 }, { x: 200, y: 2 }] }, 6)).toBe(false)
    expect(isMeaningful({ kind: 'rect', color: red, points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] }, 6)).toBe(true)
    expect(isMeaningful({ kind: 'arrow', color: red, points: [{ x: 0, y: 0 }, { x: 4, y: 4 }] }, 6)).toBe(false)
  })

  it('arrow head barbs point back from the tip, symmetric around the shaft', () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)
    expect(l.x).toBeLessThan(100)
    expect(r.x).toBeLessThan(100)
    expect(l.x).toBeCloseTo(r.x)
    expect(l.y).toBeCloseTo(-r.y)
    expect(Math.hypot(100 - l.x, l.y)).toBeCloseTo(10)
  })

  it('numbers and sizes scale with the picture', () => {
    expect(markupBadge(1)).toBe('①')
    expect(markupBadge(25)).toBe('(25)')
    expect(markupMetrics(200, 100)).toEqual({ line: 3, badge: 11 })
    const big = markupMetrics(4000, 3000)
    expect(big.line).toBeCloseTo(16)
    expect(big.badge).toBeCloseTo(72)
  })
})
