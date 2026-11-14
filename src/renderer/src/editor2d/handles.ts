/** Edit handles of the current selection (positions in plan mm, sizes in screen px). */
import type { Id, Vec2 } from '@core/types'
import { handles as appHandles } from '@/store/handles'
import type { EditorCtx } from './context'
import { nodeRays, sectorsOf } from './angles'
import { add, mid, mul } from './geom'
import { dimensionLine, frameOfOpening, framePoint, itemFront, itemToPlan } from './shapes'

export type Handle =
  | { type: 'node'; pos: Vec2; nodeId: Id }
  /** "+" next to a single selected node: drag (or click) it to draw a new wall from that node */
  | { type: 'nodeAdd'; pos: Vec2; nodeId: Id; node: Vec2 }
  | { type: 'wallMid'; pos: Vec2; wallId: Id }
  | { type: 'openingEnd'; pos: Vec2; openingId: Id; end: 'a' | 'b' }
  | { type: 'itemResize'; pos: Vec2; itemId: Id; sx: number; sy: number }
  | { type: 'itemRotate'; pos: Vec2; itemId: Id; anchor: Vec2 }
  | { type: 'dimOffset'; pos: Vec2; dimId: Id }
  | { type: 'camera'; pos: Vec2 }
  | { type: 'cameraTarget'; pos: Vec2; from: Vec2 }

export interface CameraGizmo {
  pos: Vec2
  target: Vec2
  fov: number
  /** true when the camera looks (almost) straight down */
  top: boolean
}

/** 3D camera projected on the plan, if a 3D engine is alive and visible */
export function cameraGizmo(ctx: EditorCtx): CameraGizmo | null {
  const engine = appHandles.engine3d
  if (!engine || ctx.ui().mode === '2d') return null
  try {
    const c = engine.getCamera()
    const pos = { x: c.position[0] * 1000, y: c.position[2] * 1000 }
    const target = { x: c.target[0] * 1000, y: c.target[2] * 1000 }
    if (![pos.x, pos.y, target.x, target.y].every(Number.isFinite)) return null
    const horiz = Math.hypot(target.x - pos.x, target.y - pos.y)
    const vert = Math.abs(c.position[1] - c.target[1]) * 1000
    return { pos, target, fov: c.fov, top: horiz < 50 || horiz < vert * 0.05 }
  } catch {
    return null
  }
}

export function computeHandles(ctx: EditorCtx): Handle[] {
  const out: Handle[] = []
  const ui = ctx.ui()
  if (ui.tool !== 'select') return out
  const doc = ctx.doc()
  const derived = ctx.derived()
  const sel = ui.selection

  const walls = sel.filter((r) => r.kind === 'wall')
  const seenNodes = new Set<Id>()
  const pushNode = (id: Id): void => {
    if (seenNodes.has(id)) return
    const n = doc.nodes[id]
    if (!n) return
    seenNodes.add(id)
    out.push({ type: 'node', pos: { x: n.x, y: n.y }, nodeId: id })
  }
  if (walls.length <= 24) {
    for (const r of walls) {
      const w = doc.walls[r.id]
      if (!w) continue
      pushNode(w.a)
      pushNode(w.b)
    }
  }
  for (const r of sel) if (r.kind === 'node') pushNode(r.id)

  if (sel.length === 1) {
    const r = sel[0]
    if (r.kind === 'node') {
      const n = doc.nodes[r.id]
      if (n && n.levelId === ctx.levelId()) {
        out.push({ type: 'nodeAdd', pos: nodeAddPos(ctx, r.id, n), nodeId: r.id, node: { x: n.x, y: n.y } })
      }
    } else if (r.kind === 'wall') {
      const g = derived.wallGeoms[r.id]
      if (g) out.push({ type: 'wallMid', pos: mid(g.a, g.b), wallId: r.id })
    } else if (r.kind === 'opening') {
      const o = doc.openings[r.id]
      const f = o ? frameOfOpening(doc, derived, o) : null
      if (o && f) {
        out.push({ type: 'openingEnd', pos: framePoint(f, -f.w2, 0), openingId: r.id, end: 'a' })
        out.push({ type: 'openingEnd', pos: framePoint(f, f.w2, 0), openingId: r.id, end: 'b' })
      }
    } else if (r.kind === 'item') {
      const it = doc.items[r.id]
      if (it && !it.locked && !it.hidden) {
        const hw = it.size.w / 2
        const hd = it.size.d / 2
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ]) {
          out.push({ type: 'itemResize', pos: itemToPlan(it, { x: sx * hw, y: sy * hd }), itemId: r.id, sx, sy })
        }
        const front = itemFront(it.rotation)
        const anchor = add({ x: it.x, y: it.y }, mul(front, hd))
        out.push({ type: 'itemRotate', pos: add(anchor, mul(front, ctx.mm(26))), itemId: r.id, anchor })
      }
    } else if (r.kind === 'dimension') {
      const d = doc.dimensions[r.id]
      if (d) {
        const ln = dimensionLine(d)
        out.push({ type: 'dimOffset', pos: mid(ln.a, ln.b), dimId: r.id })
      }
    }
  }

  const cam = cameraGizmo(ctx)
  if (cam) {
    out.push({ type: 'camera', pos: cam.pos })
    if (!cam.top) out.push({ type: 'cameraTarget', pos: cam.target, from: cam.pos })
  }
  return out
}

/** "+" handle position: on the bisector of the widest free angle around the node, a fixed px distance away */
function nodeAddPos(ctx: EditorCtx, nodeId: Id, n: Vec2): Vec2 {
  const sectors = sectorsOf(nodeRays(ctx.doc(), nodeId))
  // a lone node: up-right
  const dir = sectors.length ? sectors.reduce((a, b) => (b.sweep > a.sweep ? b : a)).mid : -Math.PI / 4
  const d = ctx.mm(26)
  return { x: n.x + Math.cos(dir) * d, y: n.y + Math.sin(dir) * d }
}

export function handleAt(ctx: EditorCtx, list: readonly Handle[], screen: Vec2, tolPx = 9): Handle | null {
  // edit handles win over the 3D camera gizmo
  for (const cameraPass of [false, true]) {
    let best: Handle | null = null
    let bestD = cameraPass ? tolPx + 3 : tolPx
    for (const h of list) {
      const isCamera = h.type === 'camera' || h.type === 'cameraTarget'
      if (isCamera !== cameraPass) continue
      const s = ctx.camera.toScreen(h.pos)
      const d = Math.hypot(s.x - screen.x, s.y - screen.y)
      if (d <= bestD) {
        best = h
        bestD = d
      }
    }
    if (best) return best
  }
  return null
}

/** identity of a handle that survives recomputation while it is being dragged */
export function handleKey(h: Handle): string {
  switch (h.type) {
    case 'node':
      return `node:${h.nodeId}`
    case 'nodeAdd':
      return `nodeAdd:${h.nodeId}`
    case 'wallMid':
      return `wallMid:${h.wallId}`
    case 'openingEnd':
      return `openingEnd:${h.openingId}:${h.end}`
    case 'itemResize':
      return `itemResize:${h.itemId}:${h.sx}:${h.sy}`
    case 'itemRotate':
      return `itemRotate:${h.itemId}`
    case 'dimOffset':
      return `dimOffset:${h.dimId}`
    default:
      return h.type
  }
}

export function handleCursor(h: Handle): string {
  switch (h.type) {
    case 'itemRotate':
      return 'grab'
    case 'itemResize':
      return 'nwse-resize'
    case 'openingEnd':
      return 'ew-resize'
    case 'wallMid':
    case 'dimOffset':
      return 'move'
    case 'camera':
    case 'cameraTarget':
      return 'grab'
    case 'nodeAdd':
      return 'copy'
    default:
      return 'move'
  }
}
