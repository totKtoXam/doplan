import { describe, expect, it, vi } from 'vitest'

// no canvas here: Text keeps the style it is given, which is what is checked
vi.mock('pixi.js', () => {
  class Text {
    style: unknown
    text = ''
    anchor = { set: () => {} }
    position = { set: () => {} }
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
  return { Text, Container }
})

const { Painter, TextPool } = await import('../painter')
const { DARK } = await import('../theme')

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
    const t = put.mock.results[0].value as unknown as { style: { stroke?: { color: number; width: number }; fill: number } }
    expect(t.style.fill).toBe(0xff8800)
    expect(t.style.stroke?.color).toBe(0x123456)
    expect(t.style.stroke?.width).toBeGreaterThanOrEqual(2)
    // plain text has none
    const plain = pool.put('plain', 'x', 0, 0, { color: 0xffffff }) as unknown as { style: { stroke?: unknown } }
    expect(plain.style.stroke).toBeUndefined()
  })
})
