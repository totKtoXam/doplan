import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../defaults'
import { derivePlan } from '../derive'
import { pointInPolygon } from '../geom'
import { computeWallGeoms } from '../joins'
import { addWall, normalize, syncRooms } from '../ops'
import type { Doc, Id } from '../types'

/** deterministic pseudo-random generator (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function star(angles: number[], thickness: number[], length = 3000): { doc: Doc; lv: Id } {
  const doc = createEmptyDoc()
  const lv = doc.levelOrder[0]
  angles.forEach((deg, i) => {
    const r = (deg * Math.PI) / 180
    addWall(doc, lv, { x: 0, y: 0 }, { x: Math.cos(r) * length, y: Math.sin(r) * length }, { thickness: thickness[i % thickness.length] })
  })
  return { doc, lv }
}

/** how many wall outlines contain each sampled point around the junction */
function coverage(doc: Doc, lv: Id, radius: number, samples: number, seed: number): { max: number; uncoveredNearNode: number; overlaps: number } {
  const geoms = Object.values(computeWallGeoms(doc, lv))
  const rnd = rng(seed)
  let max = 0
  let uncoveredNearNode = 0
  let overlaps = 0
  let minHalf = Infinity
  for (const id in doc.walls) minHalf = Math.min(minHalf, doc.walls[id].thickness / 2)
  for (let i = 0; i < samples; i++) {
    const p = { x: (rnd() * 2 - 1) * radius, y: (rnd() * 2 - 1) * radius }
    let n = 0
    for (const g of geoms) if (pointInPolygon(p, g.polygon)) n++
    if (n > max) max = n
    if (n > 1) overlaps++
    if (n === 0 && Math.hypot(p.x, p.y) < minHalf * 0.95) uncoveredNearNode++
  }
  return { max, uncoveredNearNode, overlaps }
}

describe('wall outlines tile junctions', () => {
  const cases: [string, number[], number[]][] = [
    ['L 90°', [0, 90], [200]],
    ['L 90° mixed', [0, 90], [300, 100]],
    ['L obtuse', [0, 135], [200, 120]],
    ['L acute 40°', [0, 40], [200]],
    ['L very acute 12° (bevel)', [0, 12], [200]],
    ['collinear step', [0, 180], [300, 100]],
    ['T', [0, 90, 180], [200, 100, 200]],
    ['T mixed', [0, 90, 180], [300, 150, 100]],
    ['Y 120°', [0, 120, 240], [200]],
    ['Y skewed', [10, 100, 215], [250, 100, 180]],
    ['X', [0, 90, 180, 270], [200]],
    ['X mixed', [0, 90, 180, 270], [300, 100, 200, 150]],
    ['5-way', [0, 70, 150, 220, 300], [200, 120, 160]],
    ['K with acute pair', [0, 25, 180], [200, 100, 200]],
  ]
  for (const [name, angles, thickness] of cases) {
    it(name, () => {
      const { doc, lv } = star(angles, thickness)
      expect(Object.keys(doc.walls)).toHaveLength(angles.length)
      const c = coverage(doc, lv, 700, 20000, 42)
      // every point belongs to at most one wall (acute inner corners legitimately overlap far from the node)
      const acute = angles.some((a, i) => angles.some((b, j) => i !== j && Math.abs(((a - b + 540) % 360) - 180) > 120))
      if (!acute) expect(c.overlaps).toBe(0)
      // a bevelled (mitre-limited) corner is cut right behind the node, so only mitred junctions are solid around it
      if (!name.includes('bevel')) expect(c.uncoveredNearNode).toBe(0)
      expect(c.max).toBeLessThanOrEqual(acute ? 2 : 1)
    })
  }

  it('random planar graphs: every room polygon is free of wall material', () => {
    const rnd = rng(7)
    for (let round = 0; round < 15; round++) {
      const doc = createEmptyDoc()
      const lv = doc.levelOrder[0]
      for (let i = 0; i < 9; i++) {
        const horizontal = rnd() < 0.5
        const c = Math.round(rnd() * 8) * 1000
        const s = Math.round(rnd() * 5) * 1000
        const e = s + (1 + Math.round(rnd() * 5)) * 1000
        const t = [100, 150, 200, 300][Math.floor(rnd() * 4)]
        if (horizontal) addWall(doc, lv, { x: s, y: c }, { x: e, y: c }, { thickness: t })
        else addWall(doc, lv, { x: c, y: s }, { x: c, y: e }, { thickness: t })
      }
      normalize(doc)
      syncRooms(doc)
      const plan = derivePlan(doc, lv)
      const geoms = Object.values(plan.wallGeoms)
      // Euler: faces (rooms) = E − V + C for a planar graph
      let roomArea = 0
      for (const r of plan.rooms) {
        expect(r.area).toBeGreaterThan(0)
        expect(pointInPolygon(r.labelPoint, r.polygon, r.holes)).toBe(true)
        // the label point is never inside a wall
        for (const g of geoms) expect(pointInPolygon(r.labelPoint, g.polygon)).toBe(false)
        roomArea += r.area
        expect(doc.rooms[r.roomId] !== undefined || r.area < 0.1).toBe(true)
      }
      // random probes: a point is in at most one room, and never both in a room and in a wall
      for (let i = 0; i < 400; i++) {
        const p = { x: rnd() * 11000 - 500, y: rnd() * 11000 - 500 }
        let inRooms = 0
        for (const r of plan.rooms) if (pointInPolygon(p, r.polygon, r.holes)) inRooms++
        expect(inRooms).toBeLessThanOrEqual(1)
        if (inRooms === 1) for (const g of geoms) expect(pointInPolygon(p, g.polygon)).toBe(false)
      }
      expect(Number.isFinite(roomArea)).toBe(true)
    }
  })
})
