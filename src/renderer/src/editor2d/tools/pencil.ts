/**
 * «Карандаш» (P): freehand marks over the plan for the AI chat. A drag draws a line, a lasso or a
 * rectangle (the shape is chosen in the pencil panel); a click selects a mark, Delete removes it.
 * Marks are stored in doc.annotations (undoable) and drawn by drawMarks on every frame.
 */
import { markAt, markBadge } from '@core'
import type { Annotation, Vec2 } from '@core/types'
import { addMarkToChat } from '@/ai/store'
import { t } from '@/i18n'
import { addMark, clearMarks, deleteMark, marksStore } from '@/store/marks'
import type { ContextMenuItem, EditorCtx } from '../context'
import { dist } from '../geom'
import type { Painter } from '../painter'
import type { Tool } from './types'

const rectPts = (a: Vec2, b: Vec2): Vec2[] => [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]

function extent(pts: readonly Vec2[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

/** where the number badge sits: start of a line, top of a zone */
function badgeAnchor(m: Pick<Annotation, 'points' | 'shape'>): Vec2 {
  if (m.shape === 'stroke') return m.points[0]
  return m.points.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
}

/** all marks of the active level (called by the editor every frame, above the plan) */
export function drawMarks(ctx: EditorCtx, p: Painter): void {
  const all = ctx.doc().annotations
  if (!all) return
  const lv = ctx.levelId()
  const pal = p.pal
  const selected = marksStore.getState().selected
  const pencil = ctx.ui().tool === 'pencil'
  for (const id in all) {
    const m = all[id]
    if (m.levelId !== lv || m.points.length < 2) continue
    const sel = id === selected
    const color = sel ? pal.accent : m.done ? pal.ok : pal.danger
    const alpha = pencil || sel ? 1 : 0.85
    if (m.shape === 'zone') p.polygon(m.points, { fill: color, fillAlpha: sel ? 0.12 : 0.07, stroke: color, strokeAlpha: alpha, width: sel ? 3 : 2.2 })
    else p.polyline(m.points, color, sel ? 3 : 2.2, alpha)
    p.badge(`pm:${id}`, m.done ? `${markBadge(m.n)} ✓` : markBadge(m.n), badgeAnchor(m), { dy: -14, bg: color, color: 0xffffff, size: 12 })
  }
}

/** context-menu items for a mark under the pointer, or null */
export function markMenuItems(ctx: EditorCtx, plan: Vec2): ContextMenuItem[] | null {
  const m = markAt(ctx.doc(), ctx.levelId(), plan, ctx.mm(8))
  if (!m) return null
  marksStore.getState().select(m.id)
  const lv = ctx.levelId()
  return [
    { label: `${t('Добавить в чат')} ${markBadge(m.n)}`, run: () => void addMarkToChat(m.id) },
    { label: t('Удалить пометку'), danger: true, run: () => deleteMark(m.id) },
    { label: '', separator: true },
    { label: t('Очистить пометки'), danger: true, run: () => clearMarks(lv) },
  ]
}

export function createPencilTool(ctx: EditorCtx): Tool {
  let pts: Vec2[] | null = null
  let start: Vec2 | null = null

  function idleHint(): void {
    ctx.setHint(t('Карандаш: обведите место на плане · щелчок — выбрать пометку, Delete — удалить, Ctrl+L — в чат'))
  }

  return {
    cursor: 'crosshair',
    activate() {
      pts = null
      idleHint()
    },
    deactivate() {
      pts = null
      ctx.setHint('')
    },
    pointerDown(e) {
      if (e.button !== 0) return
      start = e.plan
      pts = [e.plan]
    },
    pointerMove(e) {
      if (!pts || !start) {
        const m = markAt(ctx.doc(), ctx.levelId(), e.plan, ctx.mm(6))
        ctx.setCursor(m ? 'pointer' : 'crosshair')
        return
      }
      if (marksStore.getState().shape === 'rect') pts = rectPts(start, e.plan)
      else if (dist(pts[pts.length - 1], e.plan) >= ctx.mm(3)) pts.push(e.plan)
      ctx.requestRender()
    },
    pointerUp(e) {
      const drawn = pts
      const from = start
      pts = null
      start = null
      if (!drawn || !from) return
      if (extent(drawn) < ctx.mm(6)) {
        // a click: select the mark under the pointer
        const m = markAt(ctx.doc(), ctx.levelId(), e.plan, ctx.mm(8))
        marksStore.getState().select(m?.id ?? null)
        ctx.requestRender()
        return
      }
      const shape = marksStore.getState().shape
      if (shape === 'free' && drawn[drawn.length - 1] !== e.plan && dist(drawn[drawn.length - 1], e.plan) > 1) drawn.push(e.plan)
      // a free line that comes back to its start becomes a zone
      const closed = shape !== 'free' || (drawn.length >= 8 && dist(drawn[0], drawn[drawn.length - 1]) <= ctx.mm(16))
      if (closed && drawn.length < 3) return
      addMark(ctx.levelId(), closed ? 'zone' : 'stroke', drawn)
      idleHint()
    },
    keyDown(e) {
      const sel = marksStore.getState().selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        deleteMark(sel)
        return true
      }
      return false
    },
    cancel() {
      if (pts) {
        pts = null
        ctx.requestRender()
        return true
      }
      if (marksStore.getState().selected) {
        marksStore.getState().select(null)
        return true
      }
      return false
    },
    draw(p) {
      if (!pts || pts.length < 2) return
      const zone = marksStore.getState().shape !== 'free'
      if (zone) p.polygon(pts, { fill: p.pal.danger, fillAlpha: 0.06, stroke: p.pal.danger, width: 2.2 })
      else p.polyline(pts, p.pal.danger, 2.2)
    },
  }
}
