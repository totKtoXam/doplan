/**
 * Paint tool: click a room → floor finish; click a wall side → that side's material (Shift = all
 * walls of the room on that side). Eyedropper picks the finish under the cursor and switches to paint.
 */
import { applyFinishToWallSide } from '@core'
import type { Id, SurfaceFinish, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { projectOnSegment } from '../geom'
import type { Painter } from '../painter'
import type { Tool } from './types'

type Target =
  | { type: 'wall'; wallId: Id; side: 'left' | 'right'; seg: [Vec2, Vec2]; roomId: Id | null }
  | { type: 'room'; roomId: Id }

function findTarget(ctx: EditorCtx, p: Vec2): Target | null {
  const derived = ctx.derived()
  const doc = ctx.doc()
  const room = ctx.hit.roomAt(p)
  // inside a room: the nearest boundary face within a few px is a wall side of that room
  if (room) {
    const tol = Math.max(ctx.mm(7), 30)
    let best: { d: number; wallId: Id; side: 'left' | 'right'; seg: [Vec2, Vec2] } | null = null
    for (const e of room.edges) {
      const w = doc.walls[e.wallId]
      if (!w || w.kind === 'virtual') continue
      const pr = projectOnSegment(p, e.from, e.to)
      if (pr.dist <= tol && (!best || pr.dist < best.d)) best = { d: pr.dist, wallId: e.wallId, side: e.side, seg: [e.from, e.to] }
    }
    if (best) return { type: 'wall', wallId: best.wallId, side: best.side, seg: best.seg, roomId: room.roomId }
    return { type: 'room', roomId: room.roomId }
  }
  // on a wall body: the half under the cursor
  const hit = ctx.hit.nearestWall(p, ctx.mm(5))
  if (hit) {
    const g = hit.geom
    const seg = hit.side === 'left' ? g.left : g.right
    let roomId: Id | null = null
    for (const r of derived.rooms) {
      if (r.edges.some((e) => e.wallId === hit.wallId && e.side === hit.side)) {
        roomId = r.roomId
        break
      }
    }
    return { type: 'wall', wallId: hit.wallId, side: hit.side, seg: [seg[0], seg[1]], roomId }
  }
  return null
}

function drawTarget(ctx: EditorCtx, p: Painter, target: Target | null, color: number): void {
  if (!target || !ctx.pointer.inside) return
  if (target.type === 'wall') {
    p.line(target.seg[0], target.seg[1], color, 4, 0.95)
  } else {
    const room = ctx.derived().rooms.find((r) => r.roomId === target.roomId)
    if (room) p.polygon(room.polygon, { fill: color, fillAlpha: 0.2, stroke: color, width: 1.5 })
  }
}

export function createPaintTool(ctx: EditorCtx): Tool {
  let target: Target | null = null

  function hint(): void {
    ctx.setHint(
      uiStore.getState().paintFinish
        ? t('Заливка: щёлкните пол комнаты или сторону стены · Shift — все стены комнаты')
        : t('Выберите материал в каталоге, затем щёлкните пол или стену'),
    )
  }

  function apply(tg: Target, e: PointerInfo): void {
    const finish = uiStore.getState().paintFinish
    if (!finish) {
      hint()
      return
    }
    const store = docStore.getState()
    if (tg.type === 'room') {
      if (!ctx.doc().rooms[tg.roomId]) return
      const copy: SurfaceFinish = { materialId: finish.materialId }
      if (finish.pattern) copy.pattern = { ...finish.pattern }
      if (finish.tint) copy.tint = finish.tint
      store.transact(t('Отделка пола'), (d) => {
        const r = d.rooms[tg.roomId]
        if (r) r.floor = copy
      })
      return
    }
    if (e.shift && tg.roomId) {
      const room = ctx.derived().rooms.find((r) => r.roomId === tg.roomId)
      if (room) {
        const edges = room.edges.map((x) => ({ wallId: x.wallId, side: x.side }))
        store.transact(t('Отделка стен комнаты'), (d) => {
          for (const x of edges) {
            const w = d.walls[x.wallId]
            if (w && w.kind !== 'virtual') applyFinishToWallSide(d, x.wallId, x.side, finish.materialId)
          }
        })
        return
      }
    }
    store.transact(t('Отделка стены'), (d) => applyFinishToWallSide(d, tg.wallId, tg.side, finish.materialId))
  }

  return {
    cursor: 'crosshair',
    activate() {
      target = null
      hint()
    },
    deactivate() {
      target = null
      ctx.setHint('')
    },
    pointerMove(e) {
      target = findTarget(ctx, e.plan)
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      target = findTarget(ctx, e.plan)
      if (target) apply(target, e)
      ctx.requestRender()
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      drawTarget(ctx, p, target, uiStore.getState().paintFinish ? p.pal.accent : p.pal.textMuted)
    },
  }
}

export function createEyedropperTool(ctx: EditorCtx): Tool {
  let target: Target | null = null

  return {
    cursor: 'copy',
    activate() {
      target = null
      ctx.setHint(t('Пипетка: щёлкните пол или сторону стены, чтобы взять отделку'))
    },
    deactivate() {
      target = null
      ctx.setHint('')
    },
    pointerMove(e) {
      target = findTarget(ctx, e.plan)
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      const tg = findTarget(ctx, e.plan)
      if (!tg) return
      const doc = ctx.doc()
      let finish: SurfaceFinish | null = null
      if (tg.type === 'room') {
        const r = doc.rooms[tg.roomId]
        if (r) finish = { ...r.floor, pattern: r.floor.pattern ? { ...r.floor.pattern } : undefined }
      } else {
        const w = doc.walls[tg.wallId]
        if (w) finish = { materialId: w[tg.side].materialId }
      }
      if (!finish) return
      if (!finish.pattern) delete finish.pattern
      const ui = uiStore.getState()
      ui.set({ paintFinish: finish })
      ui.setTool('paint')
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      drawTarget(ctx, p, target, p.pal.ok)
    },
  }
}
