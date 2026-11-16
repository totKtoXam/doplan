import { Graphics } from 'pixi.js'
import type { Id, Vec2, WallGeom } from '@core/types'
import { type EditorCtx, sameInputs } from '../context'
import { dot, norm, sub } from '../geom'
import { frameOfOpening, openingRect } from '../shapes'

function addPoly(g: Graphics, pts: readonly Vec2[]): void {
  const flat: number[] = new Array(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i].x
    flat[i * 2 + 1] = pts[i].y
  }
  g.poly(flat, true)
}

/** pushes the parts of the face p0→p1 that are not covered by opening intervals (s along the wall axis) */
function faceSegments(out: number[], geom: WallGeom, u: Vec2, p0: Vec2, p1: Vec2, cuts: readonly [number, number][]): void {
  if (!cuts.length) {
    out.push(p0.x, p0.y, p1.x, p1.y)
    return
  }
  const s0 = dot(sub(p0, geom.a), u)
  const s1 = dot(sub(p1, geom.a), u)
  if (s1 <= s0) {
    out.push(p0.x, p0.y, p1.x, p1.y)
    return
  }
  const kx = p0.x - (geom.a.x + u.x * s0)
  const ky = p0.y - (geom.a.y + u.y * s0)
  const at = (s: number): Vec2 =>
    s <= s0 ? p0 : s >= s1 ? p1 : { x: geom.a.x + u.x * s + kx, y: geom.a.y + u.y * s + ky }
  let cursor = s0
  for (const [c0, c1] of cuts) {
    if (c1 <= cursor) continue
    if (c0 >= s1) break
    if (c0 > cursor) {
      const a = at(cursor)
      const b = at(c0)
      out.push(a.x, a.y, b.x, b.y)
    }
    cursor = Math.max(cursor, c1)
  }
  if (cursor < s1) {
    const a = at(cursor)
    out.push(a.x, a.y, p1.x, p1.y)
  }
}

function strokeSegments(g: Graphics, segs: readonly number[], color: number, alpha = 1): void {
  if (segs.length < 4) return
  for (let i = 0; i + 3 < segs.length; i += 4) g.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3])
  g.stroke({ width: 1, color, alpha, pixelLine: true })
}

/**
 * Wall footprints (mitred polygons from the derived plan) in world space.
 * bearing = solid, partition = lighter, parapet = thin pale, glazing = blue double line, virtual = dashed axis.
 */
export class WallsLayer {
  readonly g = new Graphics()
  private key: unknown[] = []

  constructor() {
    this.g.eventMode = 'none'
  }

  update(ctx: EditorCtx): void {
    const { doc, derived } = ctx.view()
    const pal = ctx.palette()
    const key = [derived.wallGeoms, doc.walls, doc.openings, pal]
    if (sameInputs(key, this.key)) return
    this.key = key
    const g = this.g
    g.clear()

    const geoms = derived.wallGeoms
    const degree = new Map<Id, number>()
    for (const id in geoms) {
      const w = doc.walls[id]
      if (!w) continue
      degree.set(w.a, (degree.get(w.a) ?? 0) + 1)
      degree.set(w.b, (degree.get(w.b) ?? 0) + 1)
    }

    const cuts = new Map<Id, [number, number][]>()
    const gaps: Vec2[][] = []
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (!geoms[o.wallId]) continue
      const f = frameOfOpening(doc, derived, o)
      if (!f) continue
      gaps.push(openingRect(f, 0.5))
      const list = cuts.get(o.wallId)
      const iv: [number, number] = [o.offset - o.width / 2, o.offset + o.width / 2]
      if (list) list.push(iv)
      else cuts.set(o.wallId, [iv])
    }
    for (const list of cuts.values()) list.sort((a, b) => a[0] - b[0])

    const byKind: Record<string, Vec2[][]> = { wall: [], partition: [], parapet: [], glazing: [] }
    const outline: number[] = []
    const glazing: number[] = []
    const virtual: number[] = []
    const none: [number, number][] = []

    for (const id in geoms) {
      const geom = geoms[id]
      const w = doc.walls[id]
      if (!w) continue
      if (w.kind === 'virtual' || geom.polygon.length < 3) {
        // dashed axis, 150 mm dash / 100 mm gap
        const l = geom.length
        if (l < 1) continue
        const u = norm(sub(geom.b, geom.a))
        const period = Math.max(250, l / 200)
        const dash = period * 0.6
        for (let s = 0; s < l; s += period) {
          const e = Math.min(l, s + dash)
          virtual.push(geom.a.x + u.x * s, geom.a.y + u.y * s, geom.a.x + u.x * e, geom.a.y + u.y * e)
        }
        continue
      }
      ;(byKind[w.kind] ?? byKind.wall).push(geom.polygon)
      const u = norm(sub(geom.b, geom.a))
      const wc = cuts.get(id) ?? none
      const target = w.kind === 'glazing' ? glazing : outline
      faceSegments(target, geom, u, geom.left[0], geom.left[1], wc)
      faceSegments(target, geom, u, geom.right[0], geom.right[1], wc)
      if ((degree.get(w.a) ?? 0) <= 1) target.push(geom.left[0].x, geom.left[0].y, geom.right[0].x, geom.right[0].y)
      if ((degree.get(w.b) ?? 0) <= 1) target.push(geom.left[1].x, geom.left[1].y, geom.right[1].x, geom.right[1].y)
      if (w.kind === 'glazing') faceSegments(glazing, geom, u, geom.a, geom.b, wc)
    }

    const fillAll = (polys: Vec2[][], color: number, alpha: number): void => {
      if (!polys.length) return
      for (const p of polys) addPoly(g, p)
      g.fill({ color, alpha })
    }
    fillAll(byKind.parapet, pal.parapet, 1)
    fillAll(byKind.partition, pal.partition, 1)
    fillAll(byKind.wall, pal.wall, 1)
    fillAll(byKind.glazing, pal.glazing, 0.18)
    fillAll(gaps, pal.gap, 1)

    strokeSegments(g, outline, pal.wallStroke)
    strokeSegments(g, glazing, pal.glazing)
    strokeSegments(g, virtual, pal.virtual, 0.9)
  }

  destroy(): void {
    this.g.destroy()
  }
}
