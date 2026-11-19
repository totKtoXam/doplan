import { describe, expect, it, vi } from 'vitest'

// no canvas here: Text keeps the style it is given, and measuring follows Pixi's rule for a stroke (the
// box grows by its width, the glyphs start half of it in)
vi.mock('pixi.js', () => {
  class Text {
    style: unknown
    text = ''
    at = { x: 0, y: 0 }
    anchor = { set: () => {} }
    position = { set: (x: number, y: number) => void (this.at = { x, y }) }
    scale = { set: () => {} }
    rotation = 0
    alpha = 1
    visible = true
    eventMode = ''
    resolution = 1
    width = 10
    constructor(o: { text: string; style: unknown }) {
      this.text = o.text
      this.style = o.style
    }
    destroy(): void {}
  }
  class Container {
    addChild(): void {}
    destroy(): void {}
  }
  class TextStyle {
    constructor(public o: { fontSize: number; stroke?: { width: number } }) {}
  }
  const CanvasTextMetrics = {
    measureText: (_: string, s: TextStyle) => ({ width: 8 + (s.o.stroke?.width ?? 0), height: s.o.fontSize * 1.2 + (s.o.stroke?.width ?? 0) }),
  }
  return { Text, Container, TextStyle, CanvasTextMetrics }
})

const { Painter, TextPool } = await import('../painter')
const { DARK } = await import('../theme')

type Style = { stroke?: { color: number; width: number }; fill: number }
type Placed = { style: Style; at: { x: number; y: number } }

describe('dimension numbers', () => {
  it('have a halo of the plan colour, so they read on a room of any floor colour', () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['moveTo', 'lineTo', 'stroke', 'clear', 'fill', 'roundRect']) chain[m] = () => chain
    const pool = new TextPool()
    const pal = { ...DARK, bg: 0x123456 }
    const cam = { scale: 0.1, toScreen: (v: { x: number; y: number }) => v }
    const p = new Painter(chain as never, pool, cam as never, pal)
    const put = vi.spyOn(pool, 'put')
    p.dimension('d', { x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 0, y: -1 }, 0, 10, '3000', { color: 0xff8800 })
    expect(put).toHaveBeenCalledTimes(1)
    const t = put.mock.results[0].value as unknown as Placed
    expect(t.style.fill).toBe(0xff8800)
    expect(t.style.stroke?.color).toBe(0x123456)
    expect(t.style.stroke?.width).toBeGreaterThanOrEqual(2)
    // plain text has none
    const plain = pool.put('plain', 'x', 0, 0, { color: 0xffffff }) as unknown as Placed
    expect(plain.style.stroke).toBeUndefined()
  })

  it('a halo does not move the text: the padding Pixi adds for it is taken back', () => {
    const pool = new TextPool()
    const at = (o: object) => (pool.put(JSON.stringify(o), '3000', 100, 100, { size: 12, ...o }) as unknown as Placed).at
    // a number above its line (anchored at its bottom): the glyphs, lifted by half the halo, come back down
    const sw = Math.max(2, 12 * 0.32)
    // unturned text is placed on whole pixels
    expect(at({ anchorY: 1, halo: 0 }).y).toBeCloseTo(at({ anchorY: 1 }).y + sw / 2, 0)
    expect(at({ anchorY: 0, halo: 0 }).y).toBeCloseTo(at({ anchorY: 0 }).y - sw / 2, 0)
    // centred, nothing to take back
    expect(at({ halo: 0 }).x).toBeCloseTo(100)
    expect(at({ halo: 0 }).y).toBeCloseTo(100)
    // turned with the text: on a vertical line the same shift goes sideways
    const turned = at({ anchorY: 1, halo: 0, rotation: Math.PI / 2 })
    expect(turned.x).toBeCloseTo(100 - sw / 2)
    expect(turned.y).toBeCloseTo(100)
  })
})
