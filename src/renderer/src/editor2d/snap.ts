/**
 * Snapping engine (docs/research/editor-2d.md §8.2). Priority: nodes → angle ray (15° magnetic,
 * Shift = hard 45° lock) combined with walls / alignment guides / length step → wall midpoints →
 * perpendicular foot → on-wall → alignment guides → grid. Alt disables everything.
 */
import type { Id, PlanNode, Vec2, WallGeom } from '@core/types'
import type { EditorCtx } from './context'
import { add, DEG, dist, dot, len, lineLine, mid, mul, projectOnLine, projectOnSegment, sub } from './geom'

export type SnapKind = 'none' | 'node' | 'mid' | 'perp' | 'wall' | 'align' | 'angle' | 'grid'

export interface SnapGuide {
  a: Vec2
  b: Vec2
}

export interface SnapResult {
  point: Vec2
  kind: SnapKind
  guides: SnapGuide[]
  nodeId?: Id
  wallId?: Id
  angleLocked?: boolean
}

export interface SnapOptions {
  /** previous point of the polyline being drawn (enables angle lock and perpendicular snap) */
  from?: Vec2
  shift?: boolean
  alt?: boolean
  excludeNodes?: ReadonlySet<Id>
  excludeWalls?: ReadonlySet<Id>
  /** additional magnetic points (e.g. the first point of the chain) */
  extraPoints?: Vec2[]
  noAngle?: boolean
  noObjects?: boolean
  noGrid?: boolean
}

/** adaptive grid: minor step ≥ 6 px on screen, major = 10× */
export function gridSteps(gridMm: number, scale: number): { minor: number; major: number } {
  const g = gridMm > 0 ? gridMm : 100
  const c = [g / 10, g / 2, g, g * 5, g * 10, g * 50, g * 100, g * 500, g * 1000]
  let i = 0
  while (i < c.length - 3 && c[i] * scale < 6) i++
  return { minor: c[i], major: c[i + 2] }
}

/** rounding step for lengths while drawing */
export function lengthStep(scale: number): number {
  for (const s of [10, 50, 100, 500, 1000]) if (s * scale >= 3) return s
  return 1000
}

const roundTo = (v: number, step: number): number => Math.round(v / step) * step

export function snapToGrid(ctx: EditorCtx, p: Vec2, alt = false): Vec2 {
  const st = ctx.doc().settings
  if (alt || !st.snapGrid) return p
  const { minor } = gridSteps(st.gridMm, ctx.camera.scale)
  return { x: roundTo(p.x, minor), y: roundTo(p.y, minor) }
}

interface Align {
  x?: { value: number; node: Vec2 }
  y?: { value: number; node: Vec2 }
}

function alignment(nodes: readonly PlanNode[], extra: readonly Vec2[], raw: Vec2, tol: number, exclude?: ReadonlySet<Id>): Align {
  let bx: Vec2 | null = null
  let bxd = tol
  let by: Vec2 | null = null
  let byd = tol
  const test = (n: Vec2): void => {
    const dx = Math.abs(n.x - raw.x)
    const dy = Math.abs(n.y - raw.y)
    if (dx < bxd - 1e-6 || (bx && Math.abs(dx - bxd) <= 1e-6 && dy < Math.abs(bx.y - raw.y))) {
      if (dx <= tol) {
        bx = n
        bxd = dx
      }
    }
    if (dy < byd - 1e-6 || (by && Math.abs(dy - byd) <= 1e-6 && dx < Math.abs(by.x - raw.x))) {
      if (dy <= tol) {
        by = n
        byd = dy
      }
    }
  }
  for (const n of nodes) {
    if (exclude?.has(n.id)) continue
    test(n)
  }
  for (const p of extra) test(p)
  const out: Align = {}
  const fx = bx as Vec2 | null
  const fy = by as Vec2 | null
  if (fx) out.x = { value: fx.x, node: { x: fx.x, y: fx.y } }
  if (fy) out.y = { value: fy.y, node: { x: fy.x, y: fy.y } }
  return out
}

export function snapPoint(ctx: EditorCtx, raw: Vec2, o: SnapOptions = {}): SnapResult {
  const none: SnapResult = { point: raw, kind: 'none', guides: [] }
  if (o.alt) return none
  const st = ctx.doc().settings
  const scale = ctx.camera.scale
  const tol = ctx.mm(10)
  const objects = st.snapObjects && !o.noObjects
  const grid = st.snapGrid && !o.noGrid
  const from = o.from
  const extra = o.extraPoints ?? []

  // 1. nodes / wall ends
  if (objects) {
    let best: { p: Vec2; d: number; id?: Id } | null = null
    for (const n of ctx.hit.nodesNear(raw, tol)) {
      if (o.excludeNodes?.has(n.id)) continue
      const d = dist(n, raw)
      if (!best || d < best.d) best = { p: { x: n.x, y: n.y }, d, id: n.id }
    }
    for (const p of extra) {
      const d = dist(p, raw)
      if (d <= tol && (!best || d < best.d)) best = { p, d }
    }
    if (best) return { point: best.p, kind: 'node', guides: [], nodeId: best.id }
  }

  const walls: WallGeom[] = objects
    ? ctx.hit.wallsNear(raw, tol + 50).filter((g) => !o.excludeWalls?.has(g.wallId) && g.length > 1)
    : []
  const nodes = objects ? ctx.hit.levelNodes() : []

  // 2. polar angle from the previous point
  if (from && !o.noAngle && (st.snapAngle || o.shift)) {
    const d = sub(raw, from)
    const L = len(d)
    if (L > tol * 0.4) {
      const step = (o.shift ? 45 : 15) * DEG
      const a = Math.round(Math.atan2(d.y, d.x) / step) * step
      const dir = { x: Math.cos(a), y: Math.sin(a) }
      const proj = dot(d, dir)
      const foot = add(from, mul(dir, proj))
      if (proj > 0 && (o.shift || dist(raw, foot) <= tol * 1.5)) {
        let point = foot
        let kind: SnapKind = 'angle'
        let wallId: Id | undefined
        let bestD = tol
        const guides: SnapGuide[] = [{ a: from, b: foot }]
        if (objects) {
          for (const g of walls) {
            const r = lineLine(from, dir, g.a, sub(g.b, g.a))
            if (!r || r.t <= 0 || r.u < 0 || r.u > 1) continue
            const dd = dist(r.point, foot)
            if (dd < bestD) {
              bestD = dd
              point = r.point
              kind = 'wall'
              wallId = g.wallId
            }
          }
          if (kind === 'angle') {
            const hold: { guide: SnapGuide | null } = { guide: null }
            const tryAlign = (n: Vec2): void => {
              if (Math.abs(dir.x) > 1e-6 && Math.abs(dir.y) > 1e-6) {
                // oblique ray: both axis alignments are meaningful
                const t1 = (n.x - from.x) / dir.x
                if (t1 > 0) {
                  const q = add(from, mul(dir, t1))
                  const dd = dist(q, foot)
                  if (dd < bestD) {
                    bestD = dd
                    point = q
                    hold.guide = { a: n, b: q }
                  }
                }
                const t2 = (n.y - from.y) / dir.y
                if (t2 > 0) {
                  const q = add(from, mul(dir, t2))
                  const dd = dist(q, foot)
                  if (dd < bestD) {
                    bestD = dd
                    point = q
                    hold.guide = { a: n, b: q }
                  }
                }
              } else if (Math.abs(dir.x) > 1e-6) {
                // horizontal ray: align x with the node
                const t1 = (n.x - from.x) / dir.x
                if (t1 > 0 && Math.abs(n.y - from.y) > 1) {
                  const q = add(from, mul(dir, t1))
                  const dd = dist(q, foot)
                  if (dd < bestD) {
                    bestD = dd
                    point = q
                    hold.guide = { a: n, b: q }
                  }
                }
              } else {
                const t2 = (n.y - from.y) / dir.y
                if (t2 > 0 && Math.abs(n.x - from.x) > 1) {
                  const q = add(from, mul(dir, t2))
                  const dd = dist(q, foot)
                  if (dd < bestD) {
                    bestD = dd
                    point = q
                    hold.guide = { a: n, b: q }
                  }
                }
              }
            }
            for (const n of nodes) {
              if (o.excludeNodes?.has(n.id)) continue
              tryAlign(n)
            }
            for (const p of extra) tryAlign(p)
            if (hold.guide) {
              kind = 'align'
              guides.push(hold.guide)
            }
          }
        }
        if (kind === 'angle' && grid) {
          const ls = lengthStep(scale)
          point = add(from, mul(dir, Math.max(ls, roundTo(proj, ls))))
        }
        guides[0] = { a: from, b: point }
        return { point, kind, guides, wallId, angleLocked: true }
      }
    }
  }

  // 3. free object snaps
  if (objects) {
    let bm: { p: Vec2; d: number; id: Id } | null = null
    for (const g of walls) {
      const m = mid(g.a, g.b)
      const d = dist(m, raw)
      if (d <= tol && (!bm || d < bm.d)) bm = { p: m, d, id: g.wallId }
    }
    if (bm) return { point: bm.p, kind: 'mid', guides: [], wallId: bm.id }

    if (from) {
      let bp: { p: Vec2; d: number; id: Id } | null = null
      for (const g of walls) {
        const pr = projectOnLine(from, g.a, g.b)
        if (pr.t < 0 || pr.t > 1 || pr.dist < 1) continue
        const d = dist(pr.point, raw)
        if (d <= tol && (!bp || d < bp.d)) bp = { p: pr.point, d, id: g.wallId }
      }
      if (bp) return { point: bp.p, kind: 'perp', guides: [{ a: from, b: bp.p }], wallId: bp.id }
    }

    const al = alignment(nodes, extra, raw, tol, o.excludeNodes)

    let bw: { g: WallGeom; t: number; p: Vec2; d: number } | null = null
    for (const g of walls) {
      const pr = projectOnSegment(raw, g.a, g.b)
      if (pr.dist <= tol && (!bw || pr.dist < bw.d)) bw = { g, t: pr.t, p: pr.point, d: pr.dist }
    }
    if (bw) {
      const g = bw.g
      const wd = sub(g.b, g.a)
      const guides: SnapGuide[] = []
      let point = bw.p
      let done = false
      if (al.x && Math.abs(wd.x) > 1e-6) {
        const t = (al.x.value - g.a.x) / wd.x
        const q = add(g.a, mul(wd, t))
        if (t >= 0 && t <= 1 && dist(q, raw) <= tol * 1.5) {
          point = q
          guides.push({ a: al.x.node, b: q })
          done = true
        }
      }
      if (!done && al.y && Math.abs(wd.y) > 1e-6) {
        const t = (al.y.value - g.a.y) / wd.y
        const q = add(g.a, mul(wd, t))
        if (t >= 0 && t <= 1 && dist(q, raw) <= tol * 1.5) {
          point = q
          guides.push({ a: al.y.node, b: q })
          done = true
        }
      }
      if (!done && grid) {
        const ls = lengthStep(scale)
        const s = Math.min(g.length, Math.max(0, roundTo(bw.t * g.length, ls)))
        point = add(g.a, mul(wd, s / g.length))
      }
      return { point, kind: 'wall', guides, wallId: g.wallId }
    }

    if (al.x || al.y) {
      const { minor } = gridSteps(st.gridMm, scale)
      const point = {
        x: al.x ? al.x.value : grid ? roundTo(raw.x, minor) : raw.x,
        y: al.y ? al.y.value : grid ? roundTo(raw.y, minor) : raw.y,
      }
      const guides: SnapGuide[] = []
      if (al.x) guides.push({ a: al.x.node, b: point })
      if (al.y) guides.push({ a: al.y.node, b: point })
      return { point, kind: 'align', guides }
    }
  }

  // 4. grid
  if (grid) {
    const { minor } = gridSteps(st.gridMm, scale)
    return { point: { x: roundTo(raw.x, minor), y: roundTo(raw.y, minor) }, kind: 'grid', guides: [] }
  }
  return none
}
