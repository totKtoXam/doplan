/**
 * Hit-testing in plan coordinates with a uniform spatial hash (rebuilt lazily when the
 * document changes). Tolerances are passed in mm (callers convert from screen px).
 */
import type { DerivedPlan, DerivedRoom, Doc, EntityKind, EntityRef, Id, PlanNode, Vec2, WallGeom } from '@core/types'
import { layerIndex } from '@core/layers'
import {
  type BBox,
  bboxContainsPoint,
  bboxInside,
  bboxOf,
  bboxOverlap,
  dist,
  dot,
  leftOf,
  norm,
  pointInPolygon,
  polygonIntersectsBBox,
  projectOnSegment,
  segIntersectsBBox,
  sub,
} from './geom'
import { sameInputs } from './context'
import { dimensionLine, entityShape, frameOfOpening, itemCorners, labelBox, openingRect, underlayCorners } from './shapes'

const CELL = 2000
const MAX_CELLS_PER_ENTRY = 256

interface Entry {
  kind: EntityKind
  id: Id
  box: BBox
  stamp: number
}

export interface WallHit {
  wallId: Id
  geom: WallGeom
  /** 0..1 along a→b */
  t: number
  /** foot on the centreline */
  point: Vec2
  /** distance from the cursor to the centreline */
  dist: number
  /** distance from the cursor to the wall body (0 when inside) */
  bodyDist: number
  side: 'left' | 'right'
}

export interface HitEnv {
  doc(): Doc
  derived(): DerivedPlan
  levelId(): Id
}

interface Scored {
  ref: EntityRef
  prio: number
  metric: number
}

function cellKey(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768)
}

function polyArea(pts: readonly Vec2[]): number {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y
  return Math.abs(a) / 2
}

export class HitIndex {
  private key: unknown[] = []
  private cells = new Map<number, Entry[]>()
  private large: Entry[] = []
  private nodes: PlanNode[] = []
  private stamp = 0

  constructor(private env: HitEnv) {}

  private ensure(): void {
    const doc = this.env.doc()
    const derived = this.env.derived()
    const levelId = this.env.levelId()
    const key = [
      doc.nodes,
      doc.walls,
      doc.openings,
      doc.items,
      doc.lights,
      doc.electrical,
      doc.labels,
      doc.dimensions,
      doc.underlays,
      derived,
      levelId,
      doc.settings.showFurniture2d,
    ]
    if (sameInputs(key, this.key)) return
    this.key = key
    this.cells.clear()
    this.large = []
    this.nodes = []

    for (const id in doc.nodes) {
      const n = doc.nodes[id]
      if (n.levelId !== levelId) continue
      this.nodes.push(n)
      this.insert('node', id, { minX: n.x, minY: n.y, maxX: n.x, maxY: n.y })
    }
    for (const id in derived.wallGeoms) {
      const g = derived.wallGeoms[id]
      const pts = g.polygon.length ? [...g.polygon, g.a, g.b] : [g.a, g.b]
      this.insert('wall', id, bboxOf(pts))
    }
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (!derived.wallGeoms[o.wallId]) continue
      const f = frameOfOpening(doc, derived, o)
      if (f) this.insert('opening', id, bboxOf(openingRect(f)))
    }
    if (doc.settings.showFurniture2d) {
      for (const id in doc.items) {
        const it = doc.items[id]
        if (it.levelId !== levelId) continue
        this.insert('item', id, bboxOf(itemCorners(it)))
      }
    }
    for (const id in doc.lights) {
      const l = doc.lights[id]
      if (l.levelId !== levelId) continue
      this.insert('light', id, { minX: l.x - 250, minY: l.y - 250, maxX: l.x + 250, maxY: l.y + 250 })
    }
    for (const id in doc.electrical) {
      const e = doc.electrical[id]
      if (e.levelId !== levelId) continue
      this.insert('electric', id, { minX: e.x - 150, minY: e.y - 150, maxX: e.x + 150, maxY: e.y + 150 })
    }
    for (const id in doc.labels) {
      const l = doc.labels[id]
      if (l.levelId !== levelId) continue
      this.insert('label', id, bboxOf(labelBox(l)))
    }
    for (const id in doc.dimensions) {
      const d = doc.dimensions[id]
      if (d.levelId !== levelId) continue
      const ln = dimensionLine(d)
      this.insert('dimension', id, bboxOf([d.a, d.b, ln.a, ln.b]))
    }
    for (const id in doc.underlays) {
      const u = doc.underlays[id]
      if (u.levelId !== levelId) continue
      this.large.push({ kind: 'underlay', id, box: bboxOf(underlayCorners(u)), stamp: 0 })
    }
  }

  private insert(kind: EntityKind, id: Id, box: BBox): void {
    if (!isFinite(box.minX) || !isFinite(box.maxX) || !isFinite(box.minY) || !isFinite(box.maxY)) return
    const e: Entry = { kind, id, box, stamp: 0 }
    const x0 = Math.floor(box.minX / CELL)
    const x1 = Math.floor(box.maxX / CELL)
    const y0 = Math.floor(box.minY / CELL)
    const y1 = Math.floor(box.maxY / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ENTRY) {
      this.large.push(e)
      return
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cellKey(cx, cy)
        const list = this.cells.get(k)
        if (list) list.push(e)
        else this.cells.set(k, [e])
      }
    }
  }

  private query(box: BBox): Entry[] {
    this.ensure()
    const stamp = ++this.stamp
    const out: Entry[] = []
    const x0 = Math.floor(box.minX / CELL)
    const x1 = Math.floor(box.maxX / CELL)
    const y0 = Math.floor(box.minY / CELL)
    const y1 = Math.floor(box.maxY / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size + 16) {
      // huge query: scan all cells once
      for (const list of this.cells.values()) {
        for (const e of list) {
          if (e.stamp !== stamp && bboxOverlap(e.box, box)) {
            e.stamp = stamp
            out.push(e)
          }
        }
      }
    } else {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const list = this.cells.get(cellKey(cx, cy))
          if (!list) continue
          for (const e of list) {
            if (e.stamp !== stamp && bboxOverlap(e.box, box)) {
              e.stamp = stamp
              out.push(e)
            }
          }
        }
      }
    }
    for (const e of this.large) {
      if (e.stamp !== stamp && bboxOverlap(e.box, box)) {
        e.stamp = stamp
        out.push(e)
      }
    }
    return out
  }

  levelNodes(): PlanNode[] {
    this.ensure()
    return this.nodes
  }

  nodesNear(p: Vec2, r: number): PlanNode[] {
    const doc = this.env.doc()
    const out: PlanNode[] = []
    for (const e of this.query({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      if (e.kind !== 'node') continue
      const n = doc.nodes[e.id]
      if (n && dist(n, p) <= r) out.push(n)
    }
    return out
  }

  wallsNear(p: Vec2, r: number): WallGeom[] {
    const derived = this.env.derived()
    const out: WallGeom[] = []
    for (const e of this.query({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      if (e.kind !== 'wall') continue
      const g = derived.wallGeoms[e.id]
      if (g) out.push(g)
    }
    return out
  }

  /** nearest wall whose body is within `maxDist` mm of p */
  nearestWall(p: Vec2, maxDist: number, opts?: { exclude?: ReadonlySet<Id>; includeVirtual?: boolean }): WallHit | null {
    const doc = this.env.doc()
    const derived = this.env.derived()
    let best: WallHit | null = null
    const r = maxDist + 600
    for (const e of this.query({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      if (e.kind !== 'wall') continue
      if (opts?.exclude?.has(e.id)) continue
      // nothing is placed on a wall hidden in the layers panel
      if (layerIndex(doc).hidden('wall', e.id)) continue
      const g = derived.wallGeoms[e.id]
      const w = doc.walls[e.id]
      if (!g || !w) continue
      if (w.kind === 'virtual' && !opts?.includeVirtual) continue
      const pr = projectOnSegment(p, g.a, g.b)
      const half = w.kind === 'virtual' ? 0 : w.thickness / 2
      const bodyDist = Math.max(0, pr.dist - half)
      if (bodyDist > maxDist) continue
      if (!best || bodyDist < best.bodyDist - 1e-6 || (Math.abs(bodyDist - best.bodyDist) <= 1e-6 && pr.dist < best.dist)) {
        const n = leftOf(norm(sub(g.b, g.a)))
        best = {
          wallId: e.id,
          geom: g,
          t: pr.t,
          point: pr.point,
          dist: pr.dist,
          bodyDist,
          side: dot(sub(p, g.a), n) >= 0 ? 'left' : 'right',
        }
      }
    }
    return best
  }

  roomAt(p: Vec2): DerivedRoom | null {
    const rooms = this.env.derived().rooms
    let best: DerivedRoom | null = null
    for (const r of rooms) {
      if (!pointInPolygon(p, r.polygon)) continue
      if (r.holes.some((h) => pointInPolygon(p, h))) continue
      if (!best || r.area < best.area) best = r
    }
    return best
  }

  /** all entities under p, best first (objects hidden or locked in the layers panel are never hit) */
  hitAll(p: Vec2, tol: number, filter?: (ref: EntityRef) => boolean): EntityRef[] {
    const doc = this.env.doc()
    const derived = this.env.derived()
    const vis = layerIndex(doc)
    const r = Math.max(tol, 260)
    const scored: Scored[] = []
    const push = (kind: EntityKind, id: Id, prio: number, metric: number): void => {
      if (!vis.pickable(kind, id)) return
      const ref = { kind, id }
      if (filter && !filter(ref)) return
      scored.push({ ref, prio, metric })
    }
    for (const e of this.query({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      switch (e.kind) {
        case 'node': {
          const n = doc.nodes[e.id]
          if (!n) break
          const d = dist(n, p)
          if (d <= tol * 0.8) push('node', e.id, 0, d)
          break
        }
        case 'opening': {
          const o = doc.openings[e.id]
          if (!o) break
          const f = frameOfOpening(doc, derived, o)
          if (f && pointInPolygon(p, openingRect(f, tol * 0.5))) push('opening', e.id, 1, dist(f.c, p))
          break
        }
        case 'electric': {
          // the symbol sits on the wall face: it wins over the wall and the openings, not over nodes
          const q = doc.electrical?.[e.id]
          if (!q) break
          const d = dist(q, p)
          if (d <= Math.max(tol * 1.1, 60)) push('electric', e.id, 0.5, d)
          break
        }
        case 'light': {
          const l = doc.lights[e.id]
          if (!l) break
          const d = dist(l, p)
          if (d <= Math.max(tol * 1.2, 120)) push('light', e.id, 2, d)
          break
        }
        case 'item': {
          const it = doc.items[e.id]
          if (!it) break
          const c = itemCorners(it)
          if (pointInPolygon(p, c)) push('item', e.id, 3, polyArea(c) - (it.elevation + it.size.h) * 0.001)
          break
        }
        case 'label': {
          const l = doc.labels[e.id]
          if (l && bboxContainsPoint(bboxOf(labelBox(l)), p, tol * 0.3)) push('label', e.id, 4, dist(l, p))
          break
        }
        case 'dimension': {
          const d = doc.dimensions[e.id]
          if (!d) break
          const ln = dimensionLine(d)
          const pr = projectOnSegment(p, ln.a, ln.b)
          if (pr.dist <= tol * 0.7) push('dimension', e.id, 5, pr.dist)
          break
        }
        case 'wall': {
          const g = derived.wallGeoms[e.id]
          const w = doc.walls[e.id]
          if (!g || !w) break
          const pr = projectOnSegment(p, g.a, g.b)
          const thin = w.kind === 'virtual' || g.polygon.length < 3
          const inside = thin ? pr.dist <= tol * 0.7 : pointInPolygon(p, g.polygon) || pr.dist <= Math.min(tol * 0.6, w.thickness)
          if (inside) push('wall', e.id, 6, pr.dist)
          break
        }
        case 'underlay': {
          const u = doc.underlays[e.id]
          if (u && u.visible && !u.locked && pointInPolygon(p, underlayCorners(u))) push('underlay', e.id, 8, 0)
          break
        }
        default:
          break
      }
    }
    for (const room of derived.rooms) {
      if (!pointInPolygon(p, room.polygon)) continue
      if (room.holes.some((h) => pointInPolygon(p, h))) continue
      push('room', room.roomId, 7, room.area)
    }
    scored.sort((a, b) => a.prio - b.prio || a.metric - b.metric)
    return scored.map((s) => s.ref)
  }

  hit(p: Vec2, tol: number, filter?: (ref: EntityRef) => boolean): EntityRef | null {
    return this.hitAll(p, tol, filter)[0] ?? null
  }

  /** marquee selection: `crossing` = touches the box, otherwise must be fully inside */
  inRect(box: BBox, crossing: boolean): EntityRef[] {
    const doc = this.env.doc()
    const derived = this.env.derived()
    const vis = layerIndex(doc)
    const out: EntityRef[] = []
    for (const e of this.query(box)) {
      if (e.kind === 'node' || e.kind === 'underlay') continue
      if (!vis.pickable(e.kind, e.id)) continue
      const ref: EntityRef = { kind: e.kind, id: e.id }
      if (bboxInside(e.box, box) && e.kind !== 'light' && e.kind !== 'electric') {
        out.push(ref)
        continue
      }
      const shape = entityShape(doc, derived, ref)
      if (!shape) continue
      if (shape.type === 'point') {
        if (bboxContainsPoint(box, shape.p)) out.push(ref)
      } else if (crossing) {
        if (shape.type === 'line') {
          if (segIntersectsBBox(shape.a, shape.b, box)) out.push(ref)
        } else if (polygonIntersectsBBox(shape.pts, box)) out.push(ref)
      }
    }
    return out
  }
}
