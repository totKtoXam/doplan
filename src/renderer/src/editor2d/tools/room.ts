/**
 * Rectangle room tool: drag (or click–click) a rectangle of wall centrelines → addRectRoom.
 * After the first corner the size can be typed: `4200x3600` (or `4200 3600`, `4,2м*3,6м`) + Enter;
 * the rectangle grows towards the cursor.
 */
import { addRectRoom } from '@core'
import type { Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { formatArea, formatLen, parseLengthInput, unitLabel } from '../format'
import type { Painter } from '../painter'
import { snapPoint } from '../snap'
import type { Tool } from './types'

const MIN_SIDE = 300

/** separators between width and height in the typed size */
const SIZE_SEP = /\s*[x×хХ*;]\s*|\s+/

/** `W` or `W×H` in document units (unit suffixes allowed) → mm, null while incomplete/invalid */
function parseSize(text: string, units: Parameters<typeof parseLengthInput>[1]): { w: number; h?: number } | null {
  const parts = text.trim().split(SIZE_SEP).filter(Boolean)
  if (!parts.length || parts.length > 2) return null
  const w = parseLengthInput(parts[0], units)
  if (!w || w.angleDeg !== undefined) return null
  if (parts.length === 1) return { w: w.length }
  const h = parseLengthInput(parts[1], units)
  if (!h || h.angleDeg !== undefined) return null
  return { w: w.length, h: h.length }
}

export function createRoomTool(ctx: EditorCtx): Tool {
  let a: Vec2 | null = null
  let b: Vec2 | null = null
  let downScreen: Vec2 | null = null
  let dragging = false
  let typed = ''

  function hint(): void {
    ctx.setHint(
      a
        ? t('Укажите противоположный угол комнаты · введите размер, например 4200x3600, и Enter · Esc — отмена')
        : t('Комната: протяните прямоугольник или щёлкните два угла'),
    )
  }

  function reset(): void {
    a = null
    b = null
    downScreen = null
    dragging = false
    typed = ''
    ctx.snapFeedback = null
    hint()
    ctx.requestRender()
  }

  function snapAt(e: PointerInfo): Vec2 {
    const s = snapPoint(ctx, e.plan, { alt: e.alt, noAngle: true })
    ctx.snapFeedback = s
    return s.point
  }

  /** opposite corner from the typed size; the rectangle extends towards the cursor */
  function typedCorner(): Vec2 | null {
    if (!a || !typed) return null
    const size = parseSize(typed, ctx.doc().settings.units)
    if (!size) return null
    const toward = b ?? ctx.pointer.plan ?? { x: a.x + 1, y: a.y + 1 }
    const sx = toward.x < a.x ? -1 : 1
    const sy = toward.y < a.y ? -1 : 1
    const h = size.h ?? (b && Math.abs(b.y - a.y) >= MIN_SIDE ? Math.abs(b.y - a.y) : size.w)
    return { x: a.x + sx * size.w, y: a.y + sy * h }
  }

  function commit(): void {
    if (!a || !b) return
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    if (w >= MIN_SIDE && h >= MIN_SIDE) {
      const u = uiStore.getState()
      const levelId = ctx.levelId()
      docStore.getState().transact(t('Комната'), (d) => {
        addRectRoom(d, levelId, x, y, w, h, { thickness: u.wallThickness, height: u.wallHeight, kind: u.wallKind })
      })
    }
    reset()
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

    pointerDown(e) {
      if (e.button !== 0) return
      const p = snapAt(e)
      if (!a) {
        a = p
        b = p
        typed = ''
        downScreen = e.screen
        dragging = true
        hint()
      } else {
        b = typedCorner() ?? p
        commit()
      }
      ctx.requestRender()
    },

    pointerMove(e) {
      const p = snapAt(e)
      if (a) b = p
      ctx.requestRender()
    },

    pointerUp(e) {
      if (!a || !dragging) return
      dragging = false
      const moved = downScreen ? Math.hypot(e.screen.x - downScreen.x, e.screen.y - downScreen.y) : 0
      if (moved > 6 && !typed) {
        b = snapAt(e)
        commit()
      }
    },

    keyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false
      if (e.key === 'Enter') {
        if (!a) return false
        if (typed) {
          const c = typedCorner()
          if (!c) return true
          b = c
        }
        if (b) commit()
        return true
      }
      if (e.key === 'Backspace' && typed) {
        typed = typed.slice(0, -1)
        ctx.requestRender()
        return true
      }
      if (a && e.key.length === 1 && /^[0-9.,xх×*; mcмс]$/i.test(e.key)) {
        if (!typed && !/[0-9.,]/.test(e.key)) return false
        if (typed.length < 24) typed += e.key
        ctx.requestRender()
        return true
      }
      return false
    },

    cancel() {
      if (!a) return false
      if (typed) {
        typed = ''
        ctx.requestRender()
        return true
      }
      reset()
      return true
    },

    draw(p: Painter) {
      if (!a) return
      const corner = typedCorner() ?? b
      if (!corner) return
      const pal = p.pal
      const u = uiStore.getState()
      const st = ctx.doc().settings
      const x0 = Math.min(a.x, corner.x)
      const y0 = Math.min(a.y, corner.y)
      const x1 = Math.max(a.x, corner.x)
      const y1 = Math.max(a.y, corner.y)
      const w = x1 - x0
      const h = y1 - y0
      const ok = w >= MIN_SIDE && h >= MIN_SIDE
      const color = ok ? pal.accent : pal.danger
      const half = u.wallKind === 'virtual' ? 0 : u.wallThickness / 2
      // outer and inner faces of the future walls
      p.polygon(
        [
          { x: x0 - half, y: y0 - half },
          { x: x1 + half, y: y0 - half },
          { x: x1 + half, y: y1 + half },
          { x: x0 - half, y: y1 + half },
        ],
        { fill: color, fillAlpha: 0.18, stroke: color, width: 1 },
      )
      if (w > half * 2 && h > half * 2 && half > 0) {
        p.polygon(
          [
            { x: x0 + half, y: y0 + half },
            { x: x1 - half, y: y0 + half },
            { x: x1 - half, y: y1 - half },
            { x: x0 + half, y: y1 - half },
          ],
          { fill: pal.bg, fillAlpha: 0.55, stroke: color, width: 1 },
        )
      }
      p.polygon(
        [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
        { stroke: color, strokeAlpha: 0.7, width: 1, dashed: true },
      )
      const iw = Math.max(0, w - half * 2)
      const ih = Math.max(0, h - half * 2)
      const c = p.S({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 })
      const size = `${formatLen(w, st.units)} × ${formatLen(h, st.units)} ${unitLabel(st.units)}`
      p.sbadge('room-size', typed ? `${typed}▏` : size, c.x, c.y - 11, { bg: typed ? pal.accent : undefined })
      p.sbadge('room-area', `${t('внутри')} ${formatArea((iw * ih) / 1e6)}`, c.x, c.y + 13, { size: 11, bgAlpha: 0.75 })
    },
  }
}
