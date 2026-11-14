/**
 * Wall tool: click-click polyline chain with a rubber band, full snapping, live length/angle
 * badge and typed numeric length (digits + Enter, optional `<angle`). Every segment is its own
 * history entry; Backspace steps back, Enter / Esc / double-click finish, closing onto the first
 * point ends the chain.
 */
import { addWall } from '@core'
import type { Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { add, DEG, dist, leftOf, mid, mul, norm, normDeg, sub } from '../geom'
import { formatAngle, formatLenUnit, isLengthChar, parseLengthInput } from '../format'
import type { Painter } from '../painter'
import { type SnapResult, snapPoint } from '../snap'
import type { Tool } from './types'

export function createWallTool(ctx: EditorCtx): Tool {
  /** points placed so far (the last one is the start of the rubber band) */
  let chain: Vec2[] = []
  /** whether placing chain[i] (i ≥ 1) produced a history entry */
  let committed: boolean[] = []
  let snap: SnapResult | null = null
  let typed = ''

  const wallOpts = () => {
    const u = uiStore.getState()
    return { thickness: u.wallThickness, height: u.wallHeight, kind: u.wallKind }
  }

  function updateHint(): void {
    if (!chain.length) ctx.setHint(t('Стена: щёлкните первую точку'))
    else {
      ctx.setHint(
        t('Следующая точка · цифры и Enter — точная длина · Shift — шаг 45° · Alt — без привязки · Esc или двойной щелчок — закончить'),
      )
    }
  }

  function reset(): void {
    chain = []
    committed = []
    typed = ''
    snap = null
    ctx.snapFeedback = null
    updateHint()
    ctx.requestRender()
  }

  function resnap(e: { plan: Vec2; shift: boolean; alt: boolean }): SnapResult {
    const from = chain.length ? chain[chain.length - 1] : undefined
    const s = snapPoint(ctx, e.plan, {
      from,
      shift: e.shift,
      alt: e.alt,
      extraPoints: chain.length >= 2 ? [chain[0]] : undefined,
    })
    snap = s
    ctx.snapFeedback = s
    return s
  }

  function place(pt: Vec2): void {
    if (!chain.length) {
      chain = [pt]
      committed = [false]
      updateHint()
      return
    }
    const from = chain[chain.length - 1]
    if (dist(from, pt) < 5) return
    const before = docStore.getState().revision
    const levelId = ctx.levelId()
    docStore.getState().transact(t('Стена'), (d) => {
      addWall(d, levelId, from, pt, wallOpts())
    })
    const didCommit = docStore.getState().revision !== before
    if (chain.length >= 2 && dist(pt, chain[0]) < 1) {
      reset()
      return
    }
    chain.push(pt)
    committed.push(didCommit)
    typed = ''
  }

  function typedTarget(): Vec2 | null {
    if (!chain.length) return null
    const parsed = parseLengthInput(typed, ctx.doc().settings.units)
    if (!parsed) return null
    const from = chain[chain.length - 1]
    let dir: Vec2
    if (parsed.angleDeg !== undefined) {
      const a = parsed.angleDeg * DEG
      dir = { x: Math.cos(a), y: -Math.sin(a) }
    } else if (snap && dist(snap.point, from) > 1) {
      dir = norm(sub(snap.point, from))
    } else {
      dir = { x: 1, y: 0 }
    }
    return add(from, mul(dir, parsed.length))
  }

  return {
    cursor: 'crosshair',

    activate() {
      reset()
    },

    deactivate() {
      reset()
      ctx.setHint('')
    },

    pointerDown(e: PointerInfo) {
      if (e.button !== 0) return
      const s = resnap(e)
      place(s.point)
      // the rubber band now starts at the new point
      if (chain.length) resnap(e)
      ctx.requestRender()
    },

    pointerMove(e: PointerInfo) {
      resnap(e)
      ctx.requestRender()
    },

    doubleClick() {
      if (chain.length) reset()
    },

    keyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return false
      if (e.key === 'Enter') {
        if (typed) {
          const target = typedTarget()
          if (target) {
            place(target)
            const p = ctx.pointer.plan
            if (p && chain.length) resnap({ plan: p, shift: ctx.keys.shift, alt: ctx.keys.alt })
          }
          typed = ''
          ctx.requestRender()
          return true
        }
        if (chain.length) {
          reset()
          return true
        }
        return false
      }
      if (e.key === 'Backspace') {
        if (typed) {
          typed = typed.slice(0, -1)
          ctx.requestRender()
          return true
        }
        if (chain.length > 1) {
          chain.pop()
          if (committed.pop()) docStore.getState().undo()
          const p = ctx.pointer.plan
          if (p) resnap({ plan: p, shift: ctx.keys.shift, alt: ctx.keys.alt })
          ctx.requestRender()
          return true
        }
        if (chain.length === 1) {
          reset()
          return true
        }
        return false
      }
      if (chain.length && e.key.length === 1 && isLengthChar(e.key)) {
        if (!typed && !/[0-9.,]/.test(e.key)) return false
        if (typed.length < 16) typed += e.key
        ctx.requestRender()
        return true
      }
      return false
    },

    cancel() {
      if (!chain.length && !typed) return false
      reset()
      return true
    },

    draw(p: Painter) {
      const pal = p.pal
      const u = uiStore.getState()
      const st = ctx.doc().settings
      if (!chain.length) {
        if (snap && ctx.pointer.inside) p.disc(snap.point, 3, pal.accent)
        return
      }
      const from = chain[chain.length - 1]
      let to = snap ? snap.point : from
      const tt = typed ? typedTarget() : null
      if (tt) to = tt
      const length = dist(from, to)
      if (chain.length >= 2) p.ring(chain[0], 7, pal.ok, 1.5)
      p.disc(from, 3.5, pal.accent)
      if (length > 1) {
        const dir = norm(sub(to, from))
        if (u.wallKind !== 'virtual' && u.wallThickness > 0) {
          const n = mul(leftOf(dir), u.wallThickness / 2)
          p.polygon([add(from, n), add(to, n), sub(to, n), sub(from, n)], {
            fill: pal.accent,
            fillAlpha: 0.25,
            stroke: pal.accent,
            strokeAlpha: 0.9,
            width: 1,
          })
          p.dashed(from, to, pal.accent, 1, 0.8, 6, 4)
        } else {
          p.dashed(from, to, pal.accent, 1.5, 1, 8, 5)
        }
        const ang = normDeg((-Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI)
        const m = p.S(mid(from, to))
        // put the badge beside the segment, on the upper side
        let nx = -dir.y
        let ny = dir.x
        if (ny > 0 || (ny === 0 && nx > 0)) {
          nx = -nx
          ny = -ny
        }
        const off = Math.max(22, (u.wallThickness / 2) * p.cam.scale + 16)
        const text = typed
          ? `${typed}▏`
          : `${formatLenUnit(length, st.units)}  ·  ${formatAngle(Math.abs(ang - 360) < 0.05 ? 0 : ang)}`
        p.sbadge('wall-len', text, m.x + nx * off, m.y + ny * off, { bg: typed ? pal.accent : undefined })
      } else if (typed) {
        const s = p.S(from)
        p.sbadge('wall-len', `${typed}▏`, s.x + 30, s.y - 24, { bg: pal.accent })
      }
    },
  }
}
