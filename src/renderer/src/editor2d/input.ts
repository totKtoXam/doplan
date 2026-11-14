/**
 * Pointer / wheel / keyboard wiring. Camera gestures (wheel zoom to cursor, middle / right /
 * space drag pan, two-finger pinch) are handled here; everything else is forwarded to the
 * active tool. Pointer moves are coalesced to one per animation frame.
 */
import type { ToolId } from '@/contracts'
import type { Vec2 } from '@core/types'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from './context'
import { setHover } from './tools/common'
import type { Tool } from './tools/types'

export interface InputEnv {
  ctx: EditorCtx
  tool(): Tool
  toolId(): ToolId
  /** right-click without dragging */
  onContextMenu(info: PointerInfo): void
  zoomBy(factor: number): void
}

export interface InputHandle {
  /** process the coalesced pointer move (called at the start of every frame) */
  flush(): void
  dispose(): void
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function attachInput(env: InputEnv): InputHandle {
  const { ctx } = env
  const canvas = ctx.canvas
  const cam = ctx.camera

  const touches = new Map<number, Vec2>()
  let pinch: { dist: number; cx: number; cy: number } | null = null
  let pan: { id: number; x: number; y: number; button: number; moved: number } | null = null
  let toolPointer: number | null = null
  let pending: PointerInfo | null = null
  let lastCursor: Vec2 | null = null
  let toolCursor = 'default'

  function info(ev: PointerEvent | MouseEvent): PointerInfo {
    const r = canvas.getBoundingClientRect()
    const sx = ev.clientX - r.left
    const sy = ev.clientY - r.top
    return {
      plan: cam.toPlan(sx, sy),
      screen: { x: sx, y: sy },
      client: { x: ev.clientX, y: ev.clientY },
      button: ev.button,
      shift: ev.shiftKey,
      alt: ev.altKey,
      ctrl: ev.ctrlKey || ev.metaKey,
    }
  }

  function syncKeys(ev: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
    ctx.keys.shift = ev.shiftKey
    ctx.keys.alt = ev.altKey
    ctx.keys.ctrl = ev.ctrlKey || ev.metaKey
  }

  function applyCursor(): void {
    let c = toolCursor
    if (pan) c = 'grabbing'
    else if (ctx.keys.space || env.toolId() === 'pan') c = 'grab'
    if (canvas.style.cursor !== c) canvas.style.cursor = c
  }

  ctx.setCursor = (css: string) => {
    toolCursor = css
    applyCursor()
  }

  function publishCursor(p: Vec2 | null): void {
    if (!p) {
      if (lastCursor) {
        lastCursor = null
        uiStore.getState().set({ cursor: null })
      }
      return
    }
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (lastCursor && lastCursor.x === x && lastCursor.y === y) return
    lastCursor = { x, y }
    uiStore.getState().set({ cursor: lastCursor })
  }

  function processMove(i: PointerInfo): void {
    ctx.pointer.plan = i.plan
    ctx.pointer.screen = i.screen
    const tool = env.tool()
    if (toolPointer === null) toolCursor = tool.cursor
    tool.pointerMove?.(i)
    applyCursor()
    publishCursor(ctx.snapFeedback ? ctx.snapFeedback.point : i.plan)
  }

  function flush(): void {
    if (!pending) return
    const i = pending
    pending = null
    // the camera may have moved since the event: recompute the plan position
    i.plan = cam.toPlan(i.screen.x, i.screen.y)
    processMove(i)
  }

  function startPinch(): void {
    const pts = [...touches.values()]
    if (pts.length < 2) return
    pinch = {
      dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      cx: (pts[0].x + pts[1].x) / 2,
      cy: (pts[0].y + pts[1].y) / 2,
    }
  }

  function onPointerDown(ev: PointerEvent): void {
    ctx.html.closeMenu()
    syncKeys(ev)
    ctx.pointer.inside = true
    const i = info(ev)
    if (ev.pointerType === 'touch') {
      touches.set(ev.pointerId, i.screen)
      if (touches.size === 2) {
        // second finger: abort whatever the first one started and pinch instead
        if (toolPointer !== null) {
          env.tool().cancel?.()
          toolPointer = null
        }
        pan = null
        startPinch()
        return
      }
      if (touches.size > 2) return
    }
    const wantsPan = ev.button === 1 || ev.button === 2 || (ev.button === 0 && (ctx.keys.space || env.toolId() === 'pan'))
    if (wantsPan) {
      if (ev.button === 1) ev.preventDefault()
      pan = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, button: ev.button, moved: 0 }
      try {
        canvas.setPointerCapture(ev.pointerId)
      } catch {
        /* pointer already gone */
      }
      applyCursor()
      return
    }
    if (ev.button !== 0) return
    try {
      canvas.setPointerCapture(ev.pointerId)
    } catch {
      /* pointer already gone */
    }
    flush()
    toolPointer = ev.pointerId
    ctx.pointer.plan = i.plan
    ctx.pointer.screen = i.screen
    env.tool().pointerDown?.(i)
    publishCursor(ctx.snapFeedback ? ctx.snapFeedback.point : i.plan)
    ctx.requestRender()
  }

  function onPointerMove(ev: PointerEvent): void {
    syncKeys(ev)
    const i = info(ev)
    if (ev.pointerType === 'touch' && touches.has(ev.pointerId)) {
      touches.set(ev.pointerId, i.screen)
      if (pinch && touches.size >= 2) {
        const pts = [...touches.values()]
        const d = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y))
        const cx = (pts[0].x + pts[1].x) / 2
        const cy = (pts[0].y + pts[1].y) / 2
        cam.panBy(cx - pinch.cx, cy - pinch.cy)
        cam.zoomAt(cx, cy, d / pinch.dist)
        pinch = { dist: d, cx, cy }
        ctx.requestRender()
        return
      }
    }
    if (pan && ev.pointerId === pan.id) {
      const dx = ev.clientX - pan.x
      const dy = ev.clientY - pan.y
      pan.x = ev.clientX
      pan.y = ev.clientY
      pan.moved += Math.abs(dx) + Math.abs(dy)
      // a right-button press only becomes a pan after a few px so that a click opens the menu
      if (pan.button !== 2 || pan.moved > 4) cam.panBy(dx, dy)
      ctx.pointer.screen = i.screen
      ctx.pointer.plan = i.plan
      ctx.requestRender()
      return
    }
    pending = i
    ctx.requestRender()
  }

  function onPointerUp(ev: PointerEvent): void {
    syncKeys(ev)
    const i = info(ev)
    if (ev.pointerType === 'touch') {
      touches.delete(ev.pointerId)
      if (pinch) {
        if (touches.size < 2) pinch = null
        return
      }
    }
    if (pan && ev.pointerId === pan.id) {
      const p = pan
      pan = null
      try {
        canvas.releasePointerCapture(ev.pointerId)
      } catch {
        /* not captured */
      }
      applyCursor()
      if (p.button === 2 && p.moved <= 4) env.onContextMenu(i)
      return
    }
    if (toolPointer === ev.pointerId) {
      flush()
      toolPointer = null
      try {
        canvas.releasePointerCapture(ev.pointerId)
      } catch {
        /* not captured */
      }
      env.tool().pointerUp?.(i)
      ctx.requestRender()
    }
  }

  function onPointerCancel(ev: PointerEvent): void {
    touches.delete(ev.pointerId)
    if (touches.size < 2) pinch = null
    if (pan && ev.pointerId === pan.id) {
      pan = null
      applyCursor()
    }
    if (toolPointer === ev.pointerId) {
      toolPointer = null
      env.tool().cancel?.()
      ctx.requestRender()
    }
  }

  function onPointerEnter(): void {
    ctx.pointer.inside = true
    ctx.requestRender()
  }

  function onPointerLeave(): void {
    if (toolPointer !== null || pan) return
    ctx.pointer.inside = false
    pending = null
    ctx.snapFeedback = null
    publishCursor(null)
    setHover(null)
    ctx.requestRender()
  }

  function onDblClick(ev: MouseEvent): void {
    if (ev.button !== 0) return
    if (ctx.keys.space || env.toolId() === 'pan') return
    flush()
    env.tool().doubleClick?.(info(ev))
    ctx.requestRender()
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault()
    ctx.html.closeMenu()
    const r = canvas.getBoundingClientRect()
    const sx = ev.clientX - r.left
    const sy = ev.clientY - r.top
    let dy = ev.deltaY
    if (ev.deltaMode === 1) dy *= 32
    else if (ev.deltaMode === 2) dy *= 400
    // ctrl + wheel is what a precision touchpad sends for pinch: small deltas, finer zoom
    // one mouse notch (deltaY ≈ 100, ×DPR on scaled Windows displays) ≈ 8 % zoom
    dy /= Math.max(1, window.devicePixelRatio || 1)
    const k = ev.ctrlKey ? 0.008 : 0.0008
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * k)
    cam.zoomAt(sx, sy, factor)
    if (ctx.pointer.inside && toolPointer === null && !pan) {
      pending = {
        plan: cam.toPlan(sx, sy),
        screen: { x: sx, y: sy },
        client: { x: ev.clientX, y: ev.clientY },
        button: -1,
        shift: ev.shiftKey,
        alt: ev.altKey,
        ctrl: ev.ctrlKey || ev.metaKey,
      }
    }
    ctx.requestRender()
  }

  function onContextMenuEvent(ev: MouseEvent): void {
    ev.preventDefault()
  }

  function refreshTool(): void {
    // re-run the tool's move logic with the current modifier state (Shift / Alt change snapping)
    if (!ctx.pointer.inside || !ctx.pointer.screen || pan) return
    const s = ctx.pointer.screen
    pending = {
      plan: cam.toPlan(s.x, s.y),
      screen: s,
      client: { x: 0, y: 0 },
      button: -1,
      shift: ctx.keys.shift,
      alt: ctx.keys.alt,
      ctrl: ctx.keys.ctrl,
    }
    ctx.requestRender()
  }

  function onKeyDown(ev: KeyboardEvent): void {
    const before = `${ctx.keys.shift}${ctx.keys.alt}`
    syncKeys(ev)
    if (!ctx.pointer.inside || isEditable(ev.target) || ctx.html.promptOpen) return
    if (`${ctx.keys.shift}${ctx.keys.alt}` !== before) refreshTool()

    if (ev.key === ' ' || ev.code === 'Space') {
      if (!ctx.keys.space) {
        ctx.keys.space = true
        applyCursor()
      }
      ev.preventDefault()
      return
    }
    if (ev.key === 'Escape') {
      if (ctx.html.menuOpen) {
        ctx.html.closeMenu()
      } else if (!env.tool().cancel?.()) {
        if (env.toolId() !== 'select') uiStore.getState().setTool('select')
        else return
      }
      ev.preventDefault()
      ev.stopPropagation()
      ctx.requestRender()
      return
    }
    if (env.tool().keyDown?.(ev)) {
      ev.preventDefault()
      ev.stopPropagation()
      ctx.requestRender()
      return
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (ev.key === '+' || ev.key === '=') {
      env.zoomBy(1.25)
      ev.preventDefault()
    } else if (ev.key === '-' || ev.key === '_') {
      env.zoomBy(0.8)
      ev.preventDefault()
    }
  }

  function onKeyUp(ev: KeyboardEvent): void {
    const before = `${ctx.keys.shift}${ctx.keys.alt}`
    syncKeys(ev)
    if (ev.key === ' ' || ev.code === 'Space') {
      if (ctx.keys.space) {
        ctx.keys.space = false
        applyCursor()
        if (ctx.pointer.inside && !isEditable(ev.target)) ev.preventDefault()
      }
      return
    }
    if (ctx.pointer.inside && `${ctx.keys.shift}${ctx.keys.alt}` !== before) refreshTool()
  }

  function onWindowBlur(): void {
    ctx.keys.shift = false
    ctx.keys.alt = false
    ctx.keys.ctrl = false
    ctx.keys.space = false
    applyCursor()
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('pointerenter', onPointerEnter)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('dblclick', onDblClick)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenuEvent)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onWindowBlur)

  return {
    flush,
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerenter', onPointerEnter)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenuEvent)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onWindowBlur)
    },
  }
}
