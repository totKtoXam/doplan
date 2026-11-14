/** Light, dimension, label and measure tools. */
import { addLight, newId } from '@core'
import type { LightKind, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { dist, dot, leftOf, norm, normDeg, sub } from '../geom'
import { formatAngle, formatLen, formatLenUnit } from '../format'
import type { Painter } from '../painter'
import { lengthStep, snapPoint, snapToGrid, type SnapResult } from '../snap'
import type { Tool } from './types'

const LIGHT_KINDS: readonly LightKind[] = ['ceiling', 'spot', 'pendant', 'point', 'strip', 'area']

/** wall-face corners near the cursor: extra magnetic points for measuring inner sizes */
function faceCorners(ctx: EditorCtx, p: Vec2): Vec2[] {
  const out: Vec2[] = []
  for (const g of ctx.hit.wallsNear(p, ctx.mm(14) + 400)) {
    out.push(g.left[0], g.left[1], g.right[0], g.right[1])
  }
  return out
}

function snapMeasure(ctx: EditorCtx, e: PointerInfo, from?: Vec2): SnapResult {
  const s = snapPoint(ctx, e.plan, {
    from,
    shift: e.shift,
    alt: e.alt,
    noAngle: !e.shift,
    extraPoints: e.alt ? undefined : faceCorners(ctx, e.plan),
  })
  ctx.snapFeedback = s
  return s
}

// ───────────────────────────── light ─────────────────────────────

export function createLightTool(ctx: EditorCtx): Tool {
  let at: Vec2 | null = null

  function kind(): LightKind {
    // not part of the UiState contract: an optional `lightKind` field is honoured when the shell provides it
    const k = (uiStore.getState() as unknown as { lightKind?: LightKind }).lightKind
    return k && LIGHT_KINDS.includes(k) ? k : 'ceiling'
  }

  function target(e: PointerInfo): Vec2 {
    if (!e.alt) {
      // the middle of a room is the most common place for a ceiling light
      const room = ctx.hit.roomAt(e.plan)
      if (room && dist(room.labelPoint, e.plan) <= ctx.mm(12)) return room.labelPoint
    }
    return snapToGrid(ctx, e.plan, e.alt)
  }

  return {
    cursor: 'crosshair',
    activate() {
      at = null
      ctx.setHint(t('Светильник: щёлкните, чтобы поставить · Esc — закончить'))
    },
    deactivate() {
      at = null
      ctx.setHint('')
    },
    pointerMove(e) {
      at = target(e)
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      const p = target(e)
      const levelId = ctx.levelId()
      const k = kind()
      let created: string | null = null
      docStore.getState().transact(t('Светильник'), (d) => {
        created = addLight(d, levelId, k, p.x, p.y)
      })
      const id = created as string | null
      if (id && docStore.getState().doc.lights[id]) uiStore.getState().select([{ kind: 'light', id }])
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      if (!at || !ctx.pointer.inside) return
      const r = Math.min(15, Math.max(6, 110 * p.cam.scale))
      p.disc(at, r, p.pal.lightOn, p.pal.lightOn, 1.5, 0.3)
      p.cross(at, r * 0.7, p.pal.lightOn, 1.2)
    },
  }
}

// ───────────────────────────── dimension ─────────────────────────────

export function createDimensionTool(ctx: EditorCtx): Tool {
  let a: Vec2 | null = null
  let b: Vec2 | null = null
  let cur: Vec2 | null = null

  function hint(): void {
    ctx.setHint(
      !a
        ? t('Размер: щёлкните первую точку')
        : !b
          ? t('Щёлкните вторую точку')
          : t('Отведите размерную линию и щёлкните · Esc — отмена'),
    )
  }

  function reset(): void {
    a = null
    b = null
    cur = null
    ctx.snapFeedback = null
    hint()
    ctx.requestRender()
  }

  function offsetAt(p: Vec2, alt: boolean): number {
    if (!a || !b) return 0
    let off = dot(sub(p, a), leftOf(norm(sub(b, a))))
    if (!alt && ctx.doc().settings.snapGrid) {
      const ls = lengthStep(ctx.camera.scale)
      off = Math.round(off / ls) * ls
    }
    return off
  }

  return {
    cursor: 'crosshair',
    activate: reset,
    deactivate() {
      reset()
      ctx.setHint('')
    },
    pointerMove(e) {
      if (a && b) {
        ctx.snapFeedback = null
        cur = e.plan
      } else {
        cur = snapMeasure(ctx, e, a ?? undefined).point
      }
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      if (!a) {
        a = snapMeasure(ctx, e).point
      } else if (!b) {
        const p = snapMeasure(ctx, e, a).point
        if (dist(p, a) < 5) return
        b = p
        ctx.snapFeedback = null
      } else {
        const pa = a
        const pb = b
        const offset = offsetAt(e.plan, e.alt)
        const levelId = ctx.levelId()
        const id = newId('d')
        docStore.getState().transact(t('Размер'), (d) => {
          d.dimensions[id] = { id, levelId, a: { ...pa }, b: { ...pb }, offset }
        })
        reset()
        return
      }
      hint()
      ctx.requestRender()
    },
    cancel() {
      if (!a) return false
      reset()
      return true
    },
    draw(p: Painter) {
      if (!a) {
        if (cur && ctx.pointer.inside) p.disc(cur, 3, p.pal.accent)
        return
      }
      const units = ctx.doc().settings.units
      const end = b ?? cur
      if (!end || dist(a, end) < 1) return
      const n = leftOf(norm(sub(end, a)))
      const off = b && cur ? offsetAt(cur, ctx.keys.alt) : 0
      p.dimension('dim-preview', a, end, n, off, 0, formatLen(dist(a, end), units), {
        color: p.pal.accent,
        size: 12,
        width: 1.5,
        bold: true,
      })
      p.disc(a, 3, p.pal.accent)
      p.disc(end, 3, p.pal.accent)
    },
  }
}

// ───────────────────────────── label ─────────────────────────────

export function createLabelTool(ctx: EditorCtx): Tool {
  return {
    cursor: 'text',
    activate() {
      ctx.setHint(t('Надпись: щёлкните место на плане и введите текст'))
    },
    deactivate() {
      ctx.html.closePrompt(false)
      ctx.setHint('')
    },
    pointerDown(e) {
      if (e.button !== 0) return
      if (ctx.html.promptOpen) {
        ctx.html.closePrompt(true)
        return
      }
      const at = snapToGrid(ctx, e.plan, e.alt)
      const levelId = ctx.levelId()
      const s = ctx.camera.toScreen(at)
      ctx.html.prompt({
        x: s.x,
        y: s.y,
        placeholder: t('Текст'),
        width: 220,
        onCommit: (text) => {
          const id = newId('t')
          docStore.getState().transact(t('Надпись'), (d) => {
            d.labels[id] = { id, levelId, x: at.x, y: at.y, text, size: 250 }
          })
          uiStore.getState().select([{ kind: 'label', id }])
        },
      })
    },
    cancel() {
      if (ctx.html.promptOpen) {
        ctx.html.closePrompt(false)
        return true
      }
      return false
    },
  }
}

// ───────────────────────────── measure ─────────────────────────────

export function createMeasureTool(ctx: EditorCtx): Tool {
  let a: Vec2 | null = null
  let b: Vec2 | null = null
  let fixed = false
  let cur: Vec2 | null = null

  function reset(): void {
    a = null
    b = null
    fixed = false
    ctx.snapFeedback = null
    ctx.setHint(t('Рулетка: щёлкните две точки · Shift — шаг 45° · Alt — без привязки'))
    ctx.requestRender()
  }

  return {
    cursor: 'crosshair',
    activate: reset,
    deactivate() {
      reset()
      ctx.setHint('')
    },
    pointerMove(e) {
      const s = snapMeasure(ctx, e, a && !fixed ? a : undefined)
      cur = s.point
      if (a && !fixed) {
        b = s.point
        const units = ctx.doc().settings.units
        ctx.setHint(
          `${t('Расстояние')}: ${formatLenUnit(dist(a, b), units)} · ΔX ${formatLen(Math.abs(b.x - a.x), units)} · ΔY ${formatLen(Math.abs(b.y - a.y), units)}`,
        )
      }
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      if (!a || fixed) {
        a = snapMeasure(ctx, e).point
        b = null
        fixed = false
      } else {
        const p = snapMeasure(ctx, e, a).point
        if (dist(p, a) < 1) return
        b = p
        fixed = true
        ctx.snapFeedback = null
      }
      ctx.requestRender()
    },
    cancel() {
      if (!a) return false
      reset()
      return true
    },
    draw(p: Painter) {
      const pal = p.pal
      if (!a) {
        if (cur && ctx.pointer.inside) p.disc(cur, 3, pal.guide)
        return
      }
      p.disc(a, 3.5, pal.guide)
      if (!b || dist(a, b) < 1) return
      const units = ctx.doc().settings.units
      p.line(a, b, pal.guide, 1.5)
      p.disc(b, 3.5, pal.guide)
      const dx = Math.abs(b.x - a.x)
      const dy = Math.abs(b.y - a.y)
      if (dx > 1 && dy > 1) {
        const corner = { x: b.x, y: a.y }
        p.dashed(a, corner, pal.guide, 1, 0.6)
        p.dashed(corner, b, pal.guide, 1, 0.6)
      }
      const ang = normDeg((-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI)
      const sa = p.S(a)
      const sb = p.S(b)
      p.sbadge(
        'measure',
        `${formatLenUnit(dist(a, b), units)}  ·  ${formatAngle(ang)}`,
        (sa.x + sb.x) / 2,
        (sa.y + sb.y) / 2 - 20,
        { bg: fixed ? pal.guide : undefined },
      )
      if (dx > 1 && dy > 1) {
        p.sbadge('measure-dx', formatLen(dx, units), (sa.x + sb.x) / 2, sa.y + (sb.y > sa.y ? -14 : 14), { size: 10.5, bgAlpha: 0.7 })
        p.sbadge('measure-dy', formatLen(dy, units), sb.x + (sb.x > sa.x ? 30 : -30), (sa.y + sb.y) / 2, { size: 10.5, bgAlpha: 0.7 })
      }
    },
  }
}
