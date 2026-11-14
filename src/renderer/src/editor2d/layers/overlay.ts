/** Selection / hover highlights, edit handles, snap feedback and the 3D camera gizmo (screen space). */
import type { EntityRef } from '@core/types'
import { type EditorCtx, sameRef } from '../context'
import { DEG } from '../geom'
import { cameraGizmo, type Handle, handleKey } from '../handles'
import type { Painter } from '../painter'
import { entityShape } from '../shapes'

function highlight(ctx: EditorCtx, p: Painter, ref: EntityRef, color: number, strong: boolean): void {
  const shape = entityShape(ctx.doc(), ctx.derived(), ref)
  if (!shape) return
  if (shape.type === 'poly') {
    const isRoom = ref.kind === 'room'
    p.polygon(shape.pts, {
      fill: color,
      fillAlpha: isRoom ? (strong ? 0.14 : 0.07) : strong ? 0.22 : 0.12,
      stroke: color,
      strokeAlpha: strong ? 1 : 0.85,
      width: strong ? 2 : 1.5,
      dashed: ref.kind === 'underlay',
    })
  } else if (shape.type === 'line') {
    p.line(shape.a, shape.b, color, strong ? 3 : 2, strong ? 1 : 0.8)
  } else if (ref.kind === 'light') {
    p.ring(shape.p, Math.min(20, Math.max(10, 110 * ctx.camera.scale + 4)), color, strong ? 2 : 1.5)
  } else {
    p.square(shape.p, strong ? 11 : 9, strong ? color : p.pal.handleFill, color)
  }
}

export function drawSelection(ctx: EditorCtx, p: Painter, handleList: readonly Handle[], activeHandle: Handle | null): void {
  const ui = ctx.ui()
  const pal = p.pal
  const hover = ui.hover
  const sel = ui.selection

  if (hover && !sel.some((r) => sameRef(r, hover))) highlight(ctx, p, hover, pal.hover, false)
  for (const ref of sel) highlight(ctx, p, ref, pal.accent, true)

  const activeKey = activeHandle ? handleKey(activeHandle) : null
  for (const h of handleList) {
    const active = activeKey !== null && handleKey(h) === activeKey
    const fill = active ? pal.accent : pal.handleFill
    switch (h.type) {
      case 'node':
        p.square(h.pos, 9, fill, pal.handleStroke)
        break
      case 'wallMid':
        p.disc(h.pos, 5, fill, pal.handleStroke)
        break
      case 'openingEnd':
        p.square(h.pos, 8, fill, pal.handleStroke)
        break
      case 'itemResize':
        p.square(h.pos, h.sx !== 0 && h.sy !== 0 ? 8 : 6, fill, pal.handleStroke)
        break
      case 'itemRotate':
        p.line(h.anchor, h.pos, pal.handleStroke, 1.2)
        p.disc(h.pos, 5.5, fill, pal.handleStroke)
        break
      case 'dimOffset':
        p.diamond(h.pos, 6, pal.handleStroke, 2)
        break
      default:
        break
    }
  }
}

export function drawCameraGizmo(ctx: EditorCtx, p: Painter): void {
  const cam = cameraGizmo(ctx)
  if (!cam) return
  const pal = p.pal
  const s = p.S(cam.pos)
  const g = p.g
  if (!cam.top) {
    const t = p.S(cam.target)
    const dx = t.x - s.x
    const dy = t.y - s.y
    const l = Math.hypot(dx, dy)
    if (l > 1) {
      const a = Math.atan2(dy, dx)
      // horizontal field of view is wider than the vertical one stored in the camera
      const half = Math.min(60, Math.max(15, (cam.fov || 50) * 0.75)) * DEG
      const r = Math.min(Math.max(l, 46), 90)
      const x1 = s.x + Math.cos(a - half) * r
      const y1 = s.y + Math.sin(a - half) * r
      const x2 = s.x + Math.cos(a + half) * r
      const y2 = s.y + Math.sin(a + half) * r
      g.poly([s.x, s.y, x1, y1, x2, y2], true).fill({ color: pal.camera, alpha: 0.16 })
      g.moveTo(x1, y1).lineTo(s.x, s.y).lineTo(x2, y2).stroke({ width: 1.2, color: pal.camera, alpha: 0.9 })
      p.sdashed(s.x, s.y, t.x, t.y, pal.camera, 1, 0.55, 4, 5)
      g.circle(t.x, t.y, 3.5).fill({ color: pal.bg }).stroke({ width: 1.5, color: pal.camera })
    }
  } else {
    g.circle(s.x, s.y, 14).stroke({ width: 1.2, color: pal.camera, alpha: 0.6 })
  }
  g.circle(s.x, s.y, 7).fill({ color: pal.camera }).stroke({ width: 1.5, color: pal.bg })
  g.circle(s.x, s.y, 2.5).fill({ color: pal.bg })
}

export function drawSnapFeedback(ctx: EditorCtx, p: Painter): void {
  const snap = ctx.snapFeedback
  if (!snap) return
  const pal = p.pal
  for (const gd of snap.guides) p.dashed(gd.a, gd.b, pal.guide, 1, 0.9, 5, 4)
  switch (snap.kind) {
    case 'node':
      p.square(snap.point, 11, pal.bg, pal.guide, 2)
      break
    case 'mid':
      p.triangle(snap.point, 6, pal.guide, 2)
      break
    case 'perp': {
      const s = p.S(snap.point)
      p.g
        .moveTo(s.x - 6, s.y - 6)
        .lineTo(s.x - 6, s.y + 6)
        .lineTo(s.x + 6, s.y + 6)
        .stroke({ width: 2, color: pal.guide })
      break
    }
    case 'wall':
      p.cross(snap.point, 5, pal.guide, 2)
      break
    case 'align':
      p.diamond(snap.point, 5, pal.guide, 2)
      break
    default:
      break
  }
}
