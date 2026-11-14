import { describe, expect, it } from 'vitest'
import {
  applyHomography,
  computeHomography,
  invertHomography,
  type Mat3,
  orderQuad,
  planRectification,
  rectifiedSize,
  warpPerspective,
} from '../homography'
import type { Vec2 } from '../types'

const P = (x: number, y: number): Vec2 => ({ x, y })
const square = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)]

function expectPoint(a: Vec2, b: Vec2, digits = 6): void {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
}

describe('computeHomography', () => {
  it('identity for equal quads', () => {
    const h = computeHomography(square, square)
    const id: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    for (const [i, v] of h.entries()) expect(v).toBeCloseTo(id[i], 9)
  })

  it('pure scale + translation', () => {
    const dst = square.map((p) => P(p.x * 300 + 50, p.y * 200 - 20))
    const h = computeHomography(square, dst)
    expect(h[0]).toBeCloseTo(300, 6)
    expect(h[4]).toBeCloseTo(200, 6)
    expect(h[2]).toBeCloseTo(50, 6)
    expect(h[5]).toBeCloseTo(-20, 6)
    expect(h[6]).toBeCloseTo(0, 9)
    expect(h[7]).toBeCloseTo(0, 9)
    expectPoint(applyHomography(h, P(0.5, 0.25)), P(200, 30))
  })

  it('maps a projective quad exactly and round-trips through the inverse', () => {
    const src = [P(0, 0), P(1000, 0), P(1000, 700), P(0, 700)]
    const dst = [P(120, 80), P(910, 140), P(980, 760), P(60, 690)]
    const h = computeHomography(src, dst)
    for (const [i, p] of src.entries()) expectPoint(applyHomography(h, p), dst[i], 5)
    const inv = invertHomography(h)
    expect(inv[8]).toBe(1)
    for (const p of [P(10, 20), P(500, 350), P(999, 1), P(333, 666)]) {
      expectPoint(applyHomography(inv, applyHomography(h, p)), p, 6)
    }
    for (const [i, q] of dst.entries()) expectPoint(applyHomography(inv, q), src[i], 5)
    // straight lines stay straight: the midpoint of the src diagonal maps onto the dst diagonal intersection
    const m = applyHomography(h, P(500, 350))
    const d1 = (m.x - dst[0].x) * (dst[2].y - dst[0].y) - (m.y - dst[0].y) * (dst[2].x - dst[0].x)
    expect(Math.abs(d1)).toBeLessThan(1e-6 * 1000 * 1000)
  })

  it('throws readable errors for degenerate input', () => {
    expect(() => computeHomography(square, [P(0, 0), P(1, 0), P(2, 0), P(0, 1)])).toThrow(/одной прямой/)
    expect(() => computeHomography(square, [P(0, 0), P(0, 0), P(1, 1), P(0, 1)])).toThrow(/совпадают/)
    expect(() => computeHomography(square, [P(0, 0), P(1, 1), P(1, 0), P(0, 1)])).toThrow(/пересекаются/)
    expect(() => computeHomography(square, [P(0, 0), P(4, 0), P(1, 1), P(0, 4)])).toThrow(/невыпуклая/)
    expect(() => computeHomography(square, [P(0, 0), P(1, 0), P(1, 1)])).toThrow(/4 точки/)
  })
})

describe('orderQuad', () => {
  it('sorts shuffled points into TL, TR, BR, BL (y down)', () => {
    const tl = P(105, 52)
    const tr = P(880, 90)
    const br = P(940, 610)
    const bl = P(60, 580)
    const expected = [tl, tr, br, bl]
    const perms = [
      [br, tl, bl, tr],
      [bl, br, tr, tl],
      [tr, bl, tl, br],
      [tl, tr, br, bl],
    ]
    for (const p of perms) {
      const q = orderQuad(p)
      for (const [i, v] of q.entries()) expectPoint(v, expected[i], 9)
    }
  })

  it('handles a strongly rotated quad', () => {
    // square rotated by ~30°
    const q = orderQuad([P(50, 0), P(137, 50), P(87, 137), P(0, 87)].reverse())
    expect(q[0]).toEqual(P(50, 0))
    expect(q[1]).toEqual(P(137, 50))
    expect(q[2]).toEqual(P(87, 137))
    expect(q[3]).toEqual(P(0, 87))
  })
})

describe('rectifiedSize', () => {
  const quad = [P(0, 0), P(400, 20), P(420, 220), P(10, 200)]
  it('estimates from average opposite edges when the real size is unknown', () => {
    const s = rectifiedSize(quad)
    expect(s.width).toBe(Math.round((Math.hypot(400, 20) + 410) / 2))
    expect(s.height).toBe(Math.round((Math.hypot(10, 200) + Math.hypot(20, 200)) / 2))
    expect(s.mmPerPx).toBeUndefined()
  })
  it('keeps the real aspect ratio and the source resolution when mm are known', () => {
    const s = rectifiedSize(quad, { rectMm: { width: 6000, height: 3000 } })
    expect(s.width).toBe(Math.round(Math.max(Math.hypot(400, 20), 410, Math.hypot(20, 200))))
    expect(s.width / s.height).toBeCloseTo(2, 2)
    expect(s.mmPerPx).toBeCloseTo(6000 / s.width, 9)
  })
  it('respects maxSide', () => {
    const s = rectifiedSize(quad, { rectMm: { width: 6000, height: 3000 }, maxSide: 100 })
    expect(s.width).toBe(100)
    expect(s.height).toBe(50)
    expect(s.mmPerPx).toBeCloseTo(60, 9)
  })
})

describe('planRectification', () => {
  const Q = [P(260, 180), P(1380, 260), P(1500, 1050), P(120, 980)]
  const outRect = (w: number, h: number) => [P(0, 0), P(w, 0), P(w, h), P(0, h)]

  it('without pad the output is exactly the rectangle', () => {
    const r = planRectification(Q, 1600, 1200, { rectMm: { width: 6000, height: 4000 } })
    for (const [i, p] of r.quad.entries()) expectPoint(p, Q[i], 6)
    expect(r.rect).toEqual({ x: 0, y: 0, width: r.width, height: r.height })
    expect(r.width / r.height).toBeCloseTo(1.5, 2)
    expect(r.mmPerPx).toBeCloseTo(6000 / r.width, 6)
  })

  it('with pad keeps the surroundings, clipped to the source, and the rect maps onto the quad', () => {
    const r = planRectification(Q, 1600, 1200, { rectMm: { width: 6000, height: 4000 }, pad: 0.1, maxSide: 1000 })
    expect(Math.max(r.width, r.height)).toBe(1000)
    expect(r.rect.x).toBeGreaterThan(0)
    expect(r.rect.y).toBeGreaterThan(0)
    expect(r.rect.x + r.rect.width).toBeLessThan(r.width)
    // margins never exceed the pad (10 % of the rectangle per side)
    expect(r.rect.x).toBeLessThanOrEqual(r.rect.width * 0.1 + 1e-6)
    expect(r.width - r.rect.x - r.rect.width).toBeLessThanOrEqual(r.rect.width * 0.1 + 1e-6)
    const h = computeHomography(outRect(r.width, r.height), r.quad)
    expectPoint(applyHomography(h, P(r.rect.x, r.rect.y)), Q[0], 4)
    expectPoint(applyHomography(h, P(r.rect.x + r.rect.width, r.rect.y + r.rect.height)), Q[2], 4)
    expect(r.mmPerPx).toBeCloseTo(6000 / r.rect.width, 2)
  })

  it('pad is clipped where the source image ends', () => {
    // rectangle = the whole image: nothing to add around it
    const r = planRectification(outRect(400, 300), 400, 300, { pad: 0.2 })
    expect(r.rect.x).toBeCloseTo(0, 6)
    expect(r.rect.y).toBeCloseTo(0, 6)
    expect(r.width).toBe(400)
    expect(r.height).toBe(300)
  })
})

describe('warpPerspective', () => {
  const N = 40
  const colours = [
    [255, 0, 0, 255], // TL quadrant
    [0, 200, 0, 255], // TR
    [0, 0, 255, 255], // BL
    [250, 220, 0, 255], // BR
  ]
  const quadrant = (x: number, y: number) => (y < N / 2 ? 0 : 2) + (x < N / 2 ? 0 : 1)

  it('restores a 4-colour checker distorted by a known homography', () => {
    // distorted image: the N×N checker seen through H (rect → dstQuad) on an 80×80 white canvas
    const dstQuad = [P(10, 5), P(72, 14), P(66, 74), P(6, 60)]
    const H = computeHomography([P(0, 0), P(N, 0), P(N, N), P(0, N)], dstQuad)
    const Hi = invertHomography(H)
    const DW = 80
    const DH = 80
    const data = new Uint8ClampedArray(DW * DH * 4).fill(255)
    for (let y = 0; y < DH; y++) {
      for (let x = 0; x < DW; x++) {
        const q = applyHomography(Hi, P(x + 0.5, y + 0.5))
        if (q.x < 0 || q.y < 0 || q.x >= N || q.y >= N) continue
        const c = colours[quadrant(q.x, q.y)]
        data.set(c, (y * DW + x) * 4)
      }
    }
    const out = warpPerspective({ width: DW, height: DH, data, channels: 4 }, dstQuad, N, N)
    expect(out.width).toBe(N)
    expect(out.height).toBe(N)
    expect(out.channels).toBe(4)
    const px = (x: number, y: number) => Array.from(out.data.slice((y * N + x) * 4, (y * N + x) * 4 + 4))
    // quadrant interiors (away from the colour edges) come back exactly
    for (const [x, y] of [
      [5, 5],
      [10, 10],
      [14, 3],
      [30, 8],
      [35, 15],
      [8, 30],
      [12, 36],
      [30, 30],
      [36, 25],
    ]) {
      const want = colours[quadrant(x + 0.5, y + 0.5)]
      const got = px(x, y)
      for (let c = 0; c < 4; c++) expect(Math.abs(got[c] - want[c])).toBeLessThanOrEqual(2)
    }
    // the colour edge stays at the middle: columns 18 / 21 on the top row belong to different quadrants
    expect(px(17, 5)).toEqual(colours[0])
    expect(px(22, 5)).toEqual(colours[1])
  })

  it('fills pixels outside the source with the background (default white)', () => {
    const src = { width: 10, height: 10, data: new Uint8ClampedArray(100).fill(0), channels: 1 as const }
    // quad sticking out of the source to the left/top: output corner (0,0) maps to (-10,-10)
    const out = warpPerspective(src, [P(-10, -10), P(10, -10), P(10, 10), P(-10, 10)], 20, 20)
    expect(out.data[0]).toBe(255)
    expect(out.data[19 * 20 + 19]).toBe(0)
    const grey = warpPerspective(src, [P(-10, -10), P(10, -10), P(10, 10), P(-10, 10)], 20, 20, { background: [128] })
    expect(grey.data[0]).toBe(128)
  })

  it('keeps 3-channel images and uses identity for the full-frame quad', () => {
    const w = 6
    const h = 4
    const data = new Uint8Array(w * h * 3)
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256
    const out = warpPerspective({ width: w, height: h, data, channels: 3 }, [P(0, 0), P(w, 0), P(w, h), P(0, h)], w, h)
    expect(out.channels).toBe(3)
    expect(Array.from(out.data)).toEqual(Array.from(data))
  })
})
