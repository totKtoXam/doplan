/** Plan-space shapes of entities, shared by hit-testing, highlights and tools. */
import type { Dimension, Doc, EntityRef, Item, Label, Opening, Underlay, Vec2, WallGeom, DerivedPlan } from '@core/types'
import { add, DEG, leftOf, mul, norm, rectCorners, rot, sub } from './geom'

export type Shape =
  | { type: 'poly'; pts: Vec2[] }
  | { type: 'line'; a: Vec2; b: Vec2 }
  | { type: 'point'; p: Vec2 }

/** Local frame of an opening: c = centre on the wall axis, u = a→b, n = left normal. */
export interface OpeningFrame {
  c: Vec2
  u: Vec2
  n: Vec2
  /** half thickness of the host wall */
  h: number
  /** half width of the opening */
  w2: number
  length: number
}

export function wallDir(g: WallGeom): Vec2 {
  return norm(sub(g.b, g.a))
}

export function openingFrame(g: WallGeom, thickness: number, offset: number, width: number): OpeningFrame {
  const u = wallDir(g)
  return {
    c: add(g.a, mul(u, offset)),
    u,
    n: leftOf(u),
    h: Math.max(thickness, 20) / 2,
    w2: width / 2,
    length: g.length,
  }
}

export function frameOfOpening(doc: Doc, derived: DerivedPlan, o: Opening): OpeningFrame | null {
  const g = derived.wallGeoms[o.wallId]
  const w = doc.walls[o.wallId]
  if (!g || !w) return null
  return openingFrame(g, w.thickness, o.offset, o.width)
}

export function framePoint(f: OpeningFrame, s: number, k: number): Vec2 {
  return { x: f.c.x + f.u.x * s + f.n.x * k, y: f.c.y + f.u.y * s + f.n.y * k }
}

export function openingRect(f: OpeningFrame, pad = 0): Vec2[] {
  return [
    framePoint(f, -f.w2, -f.h - pad),
    framePoint(f, f.w2, -f.h - pad),
    framePoint(f, f.w2, f.h + pad),
    framePoint(f, -f.w2, f.h + pad),
  ]
}

export function itemCorners(it: Pick<Item, 'x' | 'y' | 'size' | 'rotation'>): Vec2[] {
  return rectCorners({ x: it.x, y: it.y }, it.size.w, it.size.d, it.rotation)
}

/** unit vector pointing to the front of an item (rotation 0 → +y) */
export function itemFront(rotationDeg: number): Vec2 {
  return rot({ x: 0, y: 1 }, rotationDeg * DEG)
}

export function itemToLocal(it: Pick<Item, 'x' | 'y' | 'rotation'>, p: Vec2): Vec2 {
  return rot({ x: p.x - it.x, y: p.y - it.y }, -it.rotation * DEG)
}

export function itemToPlan(it: Pick<Item, 'x' | 'y' | 'rotation'>, local: Vec2): Vec2 {
  const r = rot(local, it.rotation * DEG)
  return { x: it.x + r.x, y: it.y + r.y }
}

/** normal used for the signed dimension offset: left of a→b */
export function dimensionNormal(d: Pick<Dimension, 'a' | 'b'>): Vec2 {
  return leftOf(norm(sub(d.b, d.a)))
}

export function dimensionLine(d: Dimension): { a: Vec2; b: Vec2 } {
  const n = dimensionNormal(d)
  return { a: add(d.a, mul(n, d.offset)), b: add(d.b, mul(n, d.offset)) }
}

export function underlayCorners(u: Underlay): Vec2[] {
  const w = u.widthPx * u.scale
  const h = u.heightPx * u.scale
  const r = u.rotation * DEG
  const o = { x: u.x, y: u.y }
  return [o, add(o, rot({ x: w, y: 0 }, r)), add(o, rot({ x: w, y: h }, r)), add(o, rot({ x: 0, y: h }, r))]
}

/** approximate box of a text label centred on (x, y) */
export function labelBox(l: Label): Vec2[] {
  const lines = l.text.split('\n')
  const longest = lines.reduce((m, s) => Math.max(m, s.length), 1)
  const w = Math.max(l.size, longest * l.size * 0.58)
  const h = lines.length * l.size * 1.25
  return [
    { x: l.x - w / 2, y: l.y - h / 2 },
    { x: l.x + w / 2, y: l.y - h / 2 },
    { x: l.x + w / 2, y: l.y + h / 2 },
    { x: l.x - w / 2, y: l.y + h / 2 },
  ]
}

export function entityShape(doc: Doc, derived: DerivedPlan, ref: EntityRef): Shape | null {
  switch (ref.kind) {
    case 'node': {
      const n = doc.nodes[ref.id]
      return n ? { type: 'point', p: { x: n.x, y: n.y } } : null
    }
    case 'wall': {
      const g = derived.wallGeoms[ref.id]
      const w = doc.walls[ref.id]
      if (!g) return null
      if (!w || w.kind === 'virtual' || g.polygon.length < 3) return { type: 'line', a: g.a, b: g.b }
      return { type: 'poly', pts: g.polygon }
    }
    case 'opening': {
      const o = doc.openings[ref.id]
      if (!o) return null
      const f = frameOfOpening(doc, derived, o)
      return f ? { type: 'poly', pts: openingRect(f) } : null
    }
    case 'room': {
      const r = derived.rooms.find((x) => x.roomId === ref.id)
      return r ? { type: 'poly', pts: r.polygon } : null
    }
    case 'item': {
      const it = doc.items[ref.id]
      return it ? { type: 'poly', pts: itemCorners(it) } : null
    }
    case 'light': {
      const l = doc.lights[ref.id]
      return l ? { type: 'point', p: { x: l.x, y: l.y } } : null
    }
    case 'dimension': {
      const d = doc.dimensions[ref.id]
      if (!d) return null
      const ln = dimensionLine(d)
      return { type: 'line', a: ln.a, b: ln.b }
    }
    case 'label': {
      const l = doc.labels[ref.id]
      return l ? { type: 'poly', pts: labelBox(l) } : null
    }
    case 'underlay': {
      const u = doc.underlays[ref.id]
      return u ? { type: 'poly', pts: underlayCorners(u) } : null
    }
    default:
      return null
  }
}
