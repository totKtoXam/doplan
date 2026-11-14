/** Calibrate (underlay scale), split and erase tools. */
import { removeEntities, splitWall } from '@core'
import type { EntityRef, Underlay, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import type { EditorCtx, PointerInfo } from '../context'
import { add, dist, mul, norm, pointInPolygon, sub } from '../geom'
import { formatLen, formatLenUnit, parseLengthInput, unitLabel } from '../format'
import type { WallHit } from '../hit'
import type { Painter } from '../painter'
import { entityShape, underlayCorners } from '../shapes'
import { lengthStep } from '../snap'
import { setHover } from './common'
import type { Tool } from './types'

// ───────────────────────────── calibrate ─────────────────────────────

export function createCalibrateTool(ctx: EditorCtx): Tool {
  let a: Vec2 | null = null
  let b: Vec2 | null = null
  let cur: Vec2 | null = null

  function underlayFor(p: Vec2, q: Vec2): Underlay | null {
    const doc = ctx.doc()
    const levelId = ctx.levelId()
    const list = Object.values(doc.underlays).filter((u) => u.levelId === levelId && u.visible)
    if (!list.length) return null
    const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
    const sel = ctx.ui().selection.find((r) => r.kind === 'underlay')
    return (
      list.find((u) => pointInPolygon(m, underlayCorners(u))) ??
      list.find((u) => u.id === sel?.id) ??
      (list.length === 1 ? list[0] : null)
    )
  }

  function hint(): void {
    const has = Object.values(ctx.doc().underlays).some((u) => u.levelId === ctx.levelId())
    ctx.setHint(
      !has
        ? t('Калибровка: сначала импортируйте подложку (план-картинку)')
        : !a
          ? t('Калибровка: щёлкните первую точку известного отрезка на подложке')
          : t('Щёлкните вторую точку отрезка и введите его реальную длину'),
    )
  }

  function reset(): void {
    a = null
    b = null
    ctx.html.closePrompt(false)
    hint()
    ctx.requestRender()
  }

  function ask(): void {
    if (!a || !b) return
    const pa = a
    const pb = b
    const measured = dist(pa, pb)
    const units = ctx.doc().settings.units
    const s = ctx.camera.toScreen({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 })
    ctx.html.prompt({
      x: s.x,
      y: s.y - 34,
      value: formatLen(measured, units),
      title: `${t('Реальная длина отрезка')}, ${unitLabel(units)}`,
      width: 150,
      onCommit: (text) => {
        const parsed = parseLengthInput(text, units)
        const u = underlayFor(pa, pb)
        if (!parsed || !u || measured < 1) {
          reset()
          return
        }
        const k = parsed.length / measured
        const id = u.id
        docStore.getState().transact(t('Калибровка подложки'), (d) => {
          const x = d.underlays[id]
          if (!x) return
          // scale about the first point so it stays under the cursor
          x.scale *= k
          x.x = pa.x - (pa.x - x.x) * k
          x.y = pa.y - (pa.y - x.y) * k
        })
        reset()
      },
      onCancel: () => {
        a = null
        b = null
        hint()
        ctx.requestRender()
      },
    })
  }

  return {
    cursor: 'crosshair',
    activate: reset,
    deactivate() {
      reset()
      ctx.setHint('')
    },
    pointerMove(e) {
      cur = e.plan
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      if (ctx.html.promptOpen) return
      if (!a || b) {
        a = e.plan
        b = null
      } else {
        if (dist(a, e.plan) < ctx.mm(4)) return
        if (!underlayFor(a, e.plan)) {
          ctx.setHint(t('Калибровка: под отрезком нет подложки'))
          a = null
          return
        }
        b = e.plan
        ask()
      }
      hint()
      ctx.requestRender()
    },
    cancel() {
      if (!a && !ctx.html.promptOpen) return false
      reset()
      return true
    },
    draw(p: Painter) {
      if (!a) return
      const pal = p.pal
      const end = b ?? cur
      p.cross(a, 5, pal.guide, 2)
      if (!end) return
      p.line(a, end, pal.guide, 1.5)
      p.cross(end, 5, pal.guide, 2)
      if (!b) {
        const s = p.S({ x: (a.x + end.x) / 2, y: (a.y + end.y) / 2 })
        p.sbadge('calib', formatLenUnit(dist(a, end), ctx.doc().settings.units), s.x, s.y - 18)
      }
    },
  }
}

// ───────────────────────────── split ─────────────────────────────

export function createSplitTool(ctx: EditorCtx): Tool {
  let target: { hit: WallHit; at: Vec2; s: number } | null = null

  function update(e: PointerInfo): void {
    const hit = ctx.hit.nearestWall(e.plan, ctx.mm(12), { includeVirtual: true })
    if (!hit || hit.geom.length < 20) {
      target = null
      return
    }
    const g = hit.geom
    let s = hit.t * g.length
    if (!e.alt) {
      if (Math.abs(s - g.length / 2) <= ctx.mm(9)) s = g.length / 2
      else if (ctx.doc().settings.snapGrid) {
        const ls = lengthStep(ctx.camera.scale)
        s = Math.round(s / ls) * ls
      }
    }
    s = Math.min(g.length - 10, Math.max(10, s))
    target = { hit, at: add(g.a, mul(norm(sub(g.b, g.a)), s)), s }
  }

  return {
    cursor: 'crosshair',
    activate() {
      target = null
      ctx.setHint(t('Разделить стену: щёлкните точку на стене · Alt — без привязки'))
    },
    deactivate() {
      target = null
      ctx.setHint('')
    },
    pointerMove(e) {
      update(e)
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      update(e)
      const tg = target
      if (!tg) return
      docStore.getState().transact(t('Разделение стены'), (d) => {
        if (d.walls[tg.hit.wallId]) splitWall(d, tg.hit.wallId, tg.at)
      })
      target = null
      ctx.requestRender()
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      const tg = target
      if (!tg || !ctx.pointer.inside) return
      const pal = p.pal
      const g = tg.hit.geom
      const w = ctx.doc().walls[tg.hit.wallId]
      const u = norm(sub(g.b, g.a))
      const half = Math.max(w ? w.thickness / 2 : 0, p.cam.mm(8))
      const n = { x: u.y, y: -u.x }
      p.line(add(tg.at, mul(n, half)), add(tg.at, mul(n, -half)), pal.danger, 2)
      p.disc(tg.at, 4, pal.danger, pal.bg)
      const units = ctx.doc().settings.units
      p.badge('split-a', formatLen(tg.s, units), add(g.a, mul(u, tg.s / 2)), { size: 11, dy: -18 })
      p.badge('split-b', formatLen(g.length - tg.s, units), add(g.a, mul(u, (g.length + tg.s) / 2)), { size: 11, dy: -18 })
    },
  }
}

// ───────────────────────────── erase ─────────────────────────────

export function createEraseTool(ctx: EditorCtx): Tool {
  let target: EntityRef | null = null
  let down = false
  let session = 0

  function find(p: Vec2): EntityRef | null {
    return ctx.hit.hit(p, ctx.mm(8), (r) => r.kind !== 'room' && r.kind !== 'node')
  }

  function erase(ref: EntityRef): void {
    docStore.getState().transact(t('Удаление'), (d) => removeEntities(d, [ref]), { merge: `editor2d:erase:${session}` })
    const ui = ctx.ui()
    if (ui.selection.some((r) => r.kind === ref.kind && r.id === ref.id)) {
      ui.select(ui.selection.filter((r) => !(r.kind === ref.kind && r.id === ref.id)))
    }
  }

  return {
    cursor: 'crosshair',
    activate() {
      target = null
      down = false
      ctx.setHint(t('Ластик: щёлкните объект или проведите по объектам с нажатой кнопкой'))
    },
    deactivate() {
      target = null
      down = false
      setHover(null)
      ctx.setHint('')
    },
    pointerMove(e) {
      target = find(e.plan)
      if (down && target) {
        erase(target)
        target = null
      }
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      down = true
      session++
      target = find(e.plan)
      if (target) {
        erase(target)
        target = null
      }
      ctx.requestRender()
    },
    pointerUp() {
      down = false
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      if (!target || !ctx.pointer.inside) return
      const shape = entityShape(ctx.doc(), ctx.derived(), target)
      if (!shape) return
      const c = p.pal.danger
      if (shape.type === 'poly') p.polygon(shape.pts, { fill: c, fillAlpha: 0.3, stroke: c, width: 2 })
      else if (shape.type === 'line') p.line(shape.a, shape.b, c, 3)
      else p.ring(shape.p, 12, c, 2)
    },
  }
}
