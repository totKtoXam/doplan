/**
 * «Обмер» (survey): pick a clear room dimension and replace it with a tape measurement.
 *
 * Hover highlights the clear face run under the pointer (core/provenance runs, the same ones the auto
 * dimensions label); a click makes it the target and the React panel (ui/panels/SurveyPanel) asks for
 * the measured length. Clicking away from any face starts a two-point pick like the tape: the two
 * points span a clear distance (e.g. wall to opposite wall) and the matching room run becomes the
 * target. The geometry change itself is core/measure.applyMeasuredLength, run by the panel.
 */
import { type EdgeRun, findRun, roomEdgeRuns } from '@core'
import type { DerivedPlan, DerivedRoom, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { accuracyStore } from '@/store/accuracy'
import type { EditorCtx } from '../context'
import { formatLenUnit } from '../format'
import { dist, pointInPolygon, projectOnSegment } from '../geom'
import type { Painter } from '../painter'
import type { Tool } from './types'

export interface RunHit {
  run: EdgeRun
  room: DerivedRoom
  dist: number
}

/** the clear face run nearest to `p` within `tol` mm, preferring the room the point is in */
export function pickRunAt(plan: Pick<DerivedPlan, 'rooms'>, p: Vec2, tol: number): RunHit | null {
  let best: RunHit | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const room of plan.rooms) {
    for (const run of roomEdgeRuns(room)) {
      const pr = projectOnSegment(p, run.a, run.b)
      if (pr.dist > tol) continue
      // pointer on the room side of the face scores better than on the wall body
      const side = (p.x - run.a.x) * run.n.x + (p.y - run.a.y) * run.n.y
      const score = pr.dist + (side < 0 ? tol : 0)
      if (score < bestScore) {
        bestScore = score
        best = { run, room, dist: pr.dist }
      }
    }
  }
  return best
}

function inRoom(room: DerivedRoom, p: Vec2): boolean {
  return pointInPolygon(p, room.polygon) && !room.holes.some((h) => pointInPolygon(p, h))
}

/**
 * The room run that a two-point tape span measures: the room containing the span's middle, a run
 * parallel to the span whose length is closest to it (within 25 % or 300 mm).
 */
export function runForSpan(plan: Pick<DerivedPlan, 'rooms'>, a: Vec2, b: Vec2): RunHit | null {
  const L = dist(a, b)
  if (L < 50) return null
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const room = plan.rooms.find((r) => inRoom(r, m))
  if (!room) return null
  let best: RunHit | null = null
  for (const run of roomEdgeRuns(room)) {
    if (Math.abs(run.u.x * u.x + run.u.y * u.y) < 0.985) continue
    const d = Math.abs(run.length - L)
    if (d > Math.max(300, L * 0.25)) continue
    if (!best || d < best.dist) best = { run, room, dist: d }
  }
  return best
}

export function createSurveyTool(ctx: EditorCtx): Tool {
  let spanA: Vec2 | null = null
  let cur: Vec2 | null = null

  function idleHint(): void {
    ctx.setHint(
      t('Обмер: щёлкните размер (внутреннюю сторону стены) и введите длину по рулетке · или щёлкните две точки на противоположных стенах'),
    )
  }

  function hover(p: Vec2): RunHit | null {
    const hit = pickRunAt(ctx.derived(), p, ctx.mm(14))
    accuracyStore.getState().setHover(hit ? hit.run.key : null)
    return hit
  }

  return {
    cursor: 'crosshair',
    activate() {
      spanA = null
      idleHint()
    },
    deactivate() {
      spanA = null
      accuracyStore.getState().setHover(null)
      accuracyStore.getState().setTarget(null)
      ctx.setHint('')
    },
    pointerMove(e) {
      cur = e.plan
      if (spanA) {
        accuracyStore.getState().setHover(runForSpan(ctx.derived(), spanA, e.plan)?.run.key ?? null)
        ctx.setHint(`${t('Обмер: второй точкой укажите противоположную стену')} · ${formatLenUnit(dist(spanA, e.plan), ctx.doc().settings.units)}`)
      } else {
        const hit = hover(e.plan)
        ctx.setCursor(hit ? 'pointer' : 'crosshair')
      }
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      const acc = accuracyStore.getState()
      if (spanA) {
        const hit = runForSpan(ctx.derived(), spanA, e.plan)
        spanA = null
        if (hit) acc.setTarget({ key: hit.run.key, roomId: hit.room.roomId })
        else ctx.setHint(t('Не нашёл подходящий размер между этими точками: щёлкните точнее по двум противоположным стенам'))
        ctx.requestRender()
        return
      }
      const hit = pickRunAt(ctx.derived(), e.plan, ctx.mm(14))
      if (hit) {
        acc.setTarget({ key: hit.run.key, roomId: hit.room.roomId })
        idleHint()
      } else {
        acc.setTarget(null)
        spanA = e.plan
      }
      ctx.requestRender()
    },
    keyDown(e) {
      const acc = accuracyStore.getState()
      if ((e.key === 'Tab' || e.key === ' ') && acc.target) {
        acc.setMoveEnd(acc.moveEnd === 'a' ? 'b' : 'a')
        return true
      }
      return false
    },
    cancel() {
      const acc = accuracyStore.getState()
      if (spanA) {
        spanA = null
        idleHint()
        ctx.requestRender()
        return true
      }
      if (acc.target) {
        acc.setTarget(null)
        return true
      }
      return false
    },
    draw(p: Painter) {
      const pal = p.pal
      if (spanA) {
        p.disc(spanA, 3.5, pal.guide)
        if (cur) {
          p.dashed(spanA, cur, pal.guide, 1.5)
          p.disc(cur, 3, pal.guide)
        }
      }
      const acc = accuracyStore.getState()
      if (!acc.target) return
      const run = findRun(ctx.derived(), acc.target.key)
      if (!run) return
      // fixed end: a pin; moving end: an arrow along the run
      const fixed = acc.moveEnd === 'a' ? run.b : run.a
      const moving = acc.moveEnd === 'a' ? run.a : run.b
      const dir = acc.moveEnd === 'a' ? { x: -run.u.x, y: -run.u.y } : run.u
      const sf = p.S(fixed)
      const sm = p.S(moving)
      const g = p.g
      g.circle(sf.x, sf.y, 5).fill({ color: pal.textMuted }).stroke({ width: 1.5, color: pal.badgeBg })
      g.moveTo(sf.x - 3, sf.y - 3).lineTo(sf.x + 3, sf.y + 3).moveTo(sf.x - 3, sf.y + 3).lineTo(sf.x + 3, sf.y - 3).stroke({ width: 1.3, color: pal.badgeBg })
      // double arrow along the run at the moving end: it slides either way
      const L = 20
      const nx = -dir.y
      const ny = dir.x
      const head = (hx: number, hy: number, dx: number, dy: number): void => {
        g.poly([hx + dx * 4, hy + dy * 4, hx - dx * 5 + nx * 4.5, hy - dy * 5 + ny * 4.5, hx - dx * 5 - nx * 4.5, hy - dy * 5 - ny * 4.5], true).fill({ color: pal.accent })
      }
      g.moveTo(sm.x - dir.x * L, sm.y - dir.y * L).lineTo(sm.x + dir.x * L, sm.y + dir.y * L).stroke({ width: 2.2, color: pal.accent })
      head(sm.x + dir.x * L, sm.y + dir.y * L, dir.x, dir.y)
      head(sm.x - dir.x * L, sm.y - dir.y * L, -dir.x, -dir.y)
      g.circle(sm.x, sm.y, 4.5).fill({ color: pal.accent })
    },
  }
}
