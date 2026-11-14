/** Angle arcs and degree badges at wall junctions (screen space, drawn by the overlay and the wall tool). */
import type { Id, Vec2 } from '@core/types'
import { nodeRays, nodeRoomProbe, type Sector, sectorsOf, visibleSectors } from '../angles'
import type { EditorCtx } from '../context'
import { formatAngle } from '../format'
import type { Painter } from '../painter'

/** true when the sector is a right angle (drawn with the square corner mark) */
export const isRight = (s: Pick<Sector, 'deg'>): boolean => Math.abs(s.deg - 90) < 0.05

/**
 * Arc (or right-angle square) of one sector at `center` with a degree badge on its bisector.
 * `rPx` is the arc radius in screen px.
 */
export function drawSector(
  p: Painter,
  key: string,
  center: Vec2,
  s: Pick<Sector, 'start' | 'sweep' | 'deg' | 'mid'>,
  rPx: number,
  color: number,
  o: { label?: boolean; alpha?: number; avoid?: readonly BadgeBox[] } = {},
): BadgeBox | null {
  const g = p.g
  const c = p.S(center)
  const r = Math.max(6, rPx)
  const alpha = o.alpha ?? 1
  const a0 = s.start
  const a1 = s.start + s.sweep
  if (isRight(s)) {
    const k = r * 0.6
    const u1 = { x: Math.cos(a0) * k, y: Math.sin(a0) * k }
    const u2 = { x: Math.cos(a1) * k, y: Math.sin(a1) * k }
    g.poly([c.x, c.y, c.x + u1.x, c.y + u1.y, c.x + u1.x + u2.x, c.y + u1.y + u2.y, c.x + u2.x, c.y + u2.y], true).fill({
      color,
      alpha: 0.14 * alpha,
    })
    g.moveTo(c.x + u1.x, c.y + u1.y)
      .lineTo(c.x + u1.x + u2.x, c.y + u1.y + u2.y)
      .lineTo(c.x + u2.x, c.y + u2.y)
      .stroke({ width: 1.5, color, alpha })
  } else {
    const sx = c.x + Math.cos(a0) * r
    const sy = c.y + Math.sin(a0) * r
    g.moveTo(c.x, c.y).lineTo(sx, sy).arc(c.x, c.y, r, a0, a1).closePath().fill({ color, alpha: 0.12 * alpha })
    g.moveTo(sx, sy).arc(c.x, c.y, r, a0, a1).stroke({ width: 1.5, color, alpha })
  }
  if (o.label === false) return null
  const text = formatAngle(s.deg)
  const w = badgeWidth(text, 11)
  // keep the badge clear of the arc (wide texts need a little more room) and of other badges
  let lr = r + 12 + text.length * 2.2
  let x = c.x + Math.cos(s.mid) * lr
  let y = c.y + Math.sin(s.mid) * lr
  for (let i = 0; i < 16 && o.avoid?.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 + 2 && Math.abs(b.y - y) < (b.h + 20) / 2 + 2); i++) {
    lr += 6
    x = c.x + Math.cos(s.mid) * lr
    y = c.y + Math.sin(s.mid) * lr
  }
  p.sbadge(key, text, x, y, { size: 11, bgAlpha: 0.88 * alpha })
  return { x, y, w, h: 20 }
}

/** rough screen size of a badge plate (Painter.sbadge: text width + 12, size + 9) */
export function badgeWidth(text: string, size = 12): number {
  return text.length * size * 0.62 + 12
}

/** screen-space box of a badge centred at (x, y), for `drawSector`'s `avoid` */
export interface BadgeBox {
  x: number
  y: number
  w: number
  h: number
}

/** arc radius for a junction: clear of the wall bodies, but well inside the shortest wall */
export function junctionRadius(ctx: EditorCtx, nodeId: Id): number {
  const doc = ctx.doc()
  const n = doc.nodes[nodeId]
  if (!n) return 0
  const scale = ctx.camera.scale
  let half = 0
  let shortest = Infinity
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a !== nodeId && w.b !== nodeId) continue
    if (w.kind !== 'virtual') half = Math.max(half, w.thickness / 2)
    const f = doc.nodes[w.a === nodeId ? w.b : w.a]
    if (f) shortest = Math.min(shortest, Math.hypot(f.x - n.x, f.y - n.y))
  }
  const want = Math.max(24, half * scale + 14)
  return Math.min(want, Math.max(10, shortest * scale * 0.45))
}

/** visible sectors of a junction, inside/outside decided by the derived rooms of the level */
export function junctionSectors(ctx: EditorCtx, nodeId: Id): Sector[] {
  const doc = ctx.doc()
  const rays = nodeRays(doc, nodeId)
  if (rays.length < 2) return []
  return visibleSectors(sectorsOf(rays), nodeRoomProbe(doc, ctx.derived().rooms, nodeId))
}

/** angles of every junction in `nodeIds` (selected / hovered / dragged nodes) */
export function drawNodeAngles(ctx: EditorCtx, p: Painter, nodeIds: readonly Id[], color: number, alpha = 1): void {
  const doc = ctx.doc()
  const lv = ctx.levelId()
  for (const id of nodeIds) {
    const n = doc.nodes[id]
    if (!n || n.levelId !== lv) continue
    const sectors = junctionSectors(ctx, id)
    if (!sectors.length) continue
    const r = junctionRadius(ctx, id)
    const placed: BadgeBox[] = []
    sectors.forEach((s, i) => {
      const b = drawSector(p, `ang:${id}:${i}`, n, s, r, color, { alpha, avoid: placed })
      if (b) placed.push(b)
    })
  }
}
