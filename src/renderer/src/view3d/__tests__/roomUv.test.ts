import { describe, expect, it } from 'vitest'
import { roomUv, roomUvFrame } from '../build/roomUv'

const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 6)
  expect(a[1]).toBeCloseTo(b[1], 6)
}

describe('room UV frame', () => {
  it('axis-aligned rectangle: world axes from its lower-left corner', () => {
    const f = roomUvFrame([
      { x: 1000, y: 500 },
      { x: 4000, y: 500 },
      { x: 4000, y: 3500 },
      { x: 1000, y: 3500 },
    ])
    expect(f.angle).toBe(0)
    expect(f.origin).toEqual({ x: 1000, y: 500 })
    close(roomUv(f, { x: 2000, y: 1500 }), [1, 1])
  })

  it('L-shaped room with the notch at the bounding-box corner starts at a real corner', () => {
    // notch 1000×1000 cut out of the (0,0) corner
    const poly = [
      { x: 1000, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
      { x: 0, y: 1000 },
      { x: 1000, y: 1000 },
    ]
    for (const p of [poly, [...poly].reverse()]) {
      const f = roomUvFrame(p)
      expect(f.angle).toBe(0)
      expect([JSON.stringify({ x: 1000, y: 0 }), JSON.stringify({ x: 0, y: 1000 })]).toContain(JSON.stringify(f.origin))
    }
  })

  it('rotated room: tile axes run along its walls from a corner', () => {
    const a = Math.PI / 6
    const rot = (x: number, y: number) => ({ x: 500 + x * Math.cos(a) - y * Math.sin(a), y: 200 + x * Math.sin(a) + y * Math.cos(a) })
    const poly = [rot(0, 0), rot(4000, 0), rot(4000, 3000), rot(0, 3000)]
    const f = roomUvFrame(poly)
    expect(f.angle).toBeCloseTo(a, 9)
    expect(f.origin).toEqual(poly[0])
    close(roomUv(f, poly[1]), [4, 0])
    close(roomUv(f, poly[3]), [0, 3])
  })
})
