/**
 * VS Code-like sashes: a thin line between two areas that lights up on hover and while dragged.
 *
 * - `Sash` is the bare handle: pointer drag (coalesced to one update per frame), double click,
 *   keyboard (it is a focusable `role="separator"`), Escape cancels a drag.
 * - `ResizablePanel` is a side panel with a sash on its inner edge: min / max size, collapse by
 *   dragging below half the minimum (drag back to reopen), double click restores the default size.
 *   Sizes are controlled, so the caller decides where they are remembered.
 */
import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { beginLiveResize, endLiveResize } from '@/store/liveResize'
import { cn } from './cn'
import { availableMax, keyStep, resolveDrag } from './sashMath'

export type SashOrientation = 'vertical' | 'horizontal'

export interface SashProps {
  /** `vertical`: a vertical line resizing left/right (col-resize); `horizontal`: up/down (row-resize) */
  orientation?: SashOrientation
  /** drag started; return false to refuse it */
  onDragStart?(): boolean | void
  /** total pointer offset since the drag started, px along the resize axis (at most once a frame) */
  onDrag(offset: number): void
  /** `cancelled` when Escape aborted the drag: the owner restores the size it had at the start */
  onDragEnd?(cancelled: boolean): void
  onReset?(): void
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void
  /** at a limit the cursor shows the only way it can still go, as in VS Code */
  limit?: 'min' | 'max' | null
  /** which way growing goes for the cursor hint: +1 when the panel grows towards +x / +y */
  growSign?: 1 | -1
  label: string
  valueNow?: number
  valueMin?: number
  valueMax?: number
  /** the area this sash resizes (aria-controls) */
  controls?: string
  className?: string
  style?: CSSProperties
}

const CURSOR: Record<SashOrientation, string> = { vertical: 'col-resize', horizontal: 'row-resize' }

function limitCursor(orientation: SashOrientation, limit: 'min' | 'max' | null | undefined, growSign: 1 | -1): string {
  if (!limit) return CURSOR[orientation]
  // the side the sash can still move to
  const towardsPlus = (limit === 'min') === (growSign === 1)
  if (orientation === 'vertical') return towardsPlus ? 'e-resize' : 'w-resize'
  return towardsPlus ? 's-resize' : 'n-resize'
}

/** px the pointer must travel before a press becomes a drag (a click or double click stays one) */
const DRAG_THRESHOLD = 3

/**
 * Pointer drag shared by sashes and resize frames: window listeners, one `move` per frame with
 * the total offset since the press, Escape / pointercancel cancel.
 *
 * The press only becomes a drag once the pointer has moved DRAG_THRESHOLD px (`begin` is called
 * then). A press and release without moving ends as cancelled: nothing changes, and the click and
 * double click still land on the handle (the shield would take them otherwise). While dragging, a
 * full-window shield keeps the canvases (and their pointer handlers) out of the drag and holds the
 * cursor while the pointer leaves the thin handle. Returns a function that stops the drag.
 */
export function startPointerDrag(
  e: ReactPointerEvent,
  cursor: string,
  h: { begin?(): void; move(dx: number, dy: number): void; end(cancelled: boolean): void },
): (cancelled: boolean) => void {
  // preventDefault also keeps the focus where it was: a mouse drag must not leave the line lit
  e.preventDefault()
  const ox = e.clientX
  const oy = e.clientY
  let pending: [number, number] | null = null
  let raf = 0
  let done = false
  let shield: HTMLDivElement | null = null
  const begin = () => {
    shield = document.createElement('div')
    shield.className = 'dp-sash-shield'
    shield.style.cursor = cursor
    document.body.appendChild(shield)
    document.body.classList.add('dp-sash-dragging')
    beginLiveResize()
    h.begin?.()
  }
  const flush = () => {
    raf = 0
    if (pending) h.move(pending[0], pending[1])
    pending = null
  }
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - ox
    const dy = ev.clientY - oy
    if (!shield) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      begin()
    }
    pending = [dx, dy]
    if (!raf) raf = requestAnimationFrame(flush)
  }
  const key = (ev: globalThis.KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    stop(true)
  }
  const stop = (cancelled: boolean) => {
    if (done) return
    done = true
    const dragged = shield !== null
    if (raf) cancelAnimationFrame(raf)
    if (dragged && !cancelled && pending) h.move(pending[0], pending[1])
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    shield?.remove()
    document.body.classList.remove('dp-sash-dragging')
    // a press without a drag changes nothing
    h.end(cancelled || !dragged)
    // after the final size is committed, so views redraw at it in full quality
    if (dragged) requestAnimationFrame(endLiveResize)
  }
  const up = () => stop(false)
  const cancel = () => stop(true)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
  return stop
}

export function Sash({
  orientation = 'vertical',
  onDragStart,
  onDrag,
  onDragEnd,
  onReset,
  onKeyDown,
  limit,
  growSign = 1,
  label,
  valueNow,
  valueMin,
  valueMax,
  controls,
  className,
  style,
}: SashProps) {
  const [dragging, setDragging] = useState(false)
  const cbs = useRef({ onDrag, onDragEnd })
  cbs.current = { onDrag, onDragEnd }
  const stopRef = useRef<((cancelled: boolean) => void) | null>(null)
  useEffect(() => () => stopRef.current?.(true), [])

  const cursor = limitCursor(orientation, limit, growSign)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (onDragStart?.() === false) return
    stopRef.current = startPointerDrag(e, CURSOR[orientation], {
      begin: () => setDragging(true),
      move: (dx, dy) => cbs.current.onDrag(orientation === 'vertical' ? dx : dy),
      end: (cancelled) => {
        stopRef.current = null
        setDragging(false)
        cbs.current.onDragEnd?.(cancelled)
      },
    })
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={valueNow === undefined ? undefined : Math.round(valueNow)}
      aria-valuemin={valueMin === undefined ? undefined : Math.round(valueMin)}
      aria-valuemax={valueMax === undefined ? undefined : Math.round(valueMax)}
      aria-controls={controls}
      title={label}
      data-dragging={dragging || undefined}
      className={cn('dp-sash', orientation === 'vertical' ? 'dp-sash-v' : 'dp-sash-h', className)}
      style={{ cursor, ...style }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.preventDefault()
        onReset?.()
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        // the sash keys must not reach the editor shortcuts
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
    />
  )
}

// ───────────────────────────── ResizablePanel ─────────────────────────────

export interface ResizablePanelProps {
  /** which side of the row the panel sits on; the sash goes on the opposite (inner) edge */
  side: 'left' | 'right'
  size: number
  onSizeChange(size: number): void
  open: boolean
  onOpenChange(open: boolean): void
  defaultSize: number
  minSize: number
  maxSize: number
  /** px the row's `data-panel-fill` area keeps at least while the panel grows */
  minRest?: number
  /** collapse when dragged below half the minimum (default true) */
  collapsible?: boolean
  label: string
  id?: string
  className?: string
  children: ReactNode
}

const FLIP: Record<string, string> = { ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' }

/**
 * A side panel with a VS Code-like sash. While dragged only this component re-renders (the
 * children elements keep their identity), so heavy panel contents do not redraw every frame.
 */
export function ResizablePanel({
  side,
  size,
  onSizeChange,
  open,
  onOpenChange,
  defaultSize,
  minSize,
  maxSize,
  minRest = 320,
  collapsible = true,
  label,
  id,
  className,
  children,
}: ResizablePanelProps) {
  const box = useRef<HTMLDivElement>(null)
  // live size during a drag; committed through onSizeChange when it ends
  const [live, setLive] = useState<{ size: number; open: boolean } | null>(null)
  const liveRef = useRef<{ size: number; open: boolean } | null>(null)
  const drag = useRef<{ start: number; max: number; startOpen: boolean } | null>(null)
  const sign = side === 'left' ? 1 : -1

  const fillWidth = (): number => {
    const fill = box.current?.parentElement?.querySelector<HTMLElement>(':scope > [data-panel-fill]')
    return fill ? fill.getBoundingClientRect().width : Number.POSITIVE_INFINITY
  }
  const currentWidth = (): number => (open ? (box.current?.getBoundingClientRect().width ?? size) : 0)
  const effectiveMax = (): number => Math.max(minSize, availableMax(maxSize, currentWidth(), fillWidth(), minRest))

  const shown = live ?? { size, open }
  const limits = { min: minSize, max: maxSize, collapsible }

  const onDragStart = () => {
    drag.current = { start: currentWidth(), max: effectiveMax(), startOpen: open }
  }
  const onDrag = (offset: number) => {
    const d = drag.current
    if (!d) return
    const r = resolveDrag(d.start + sign * offset, { ...limits, max: d.max })
    // collapsing keeps the size the panel had, so reopening restores it
    const next = { size: r.collapsed ? (d.startOpen ? d.start : size) : r.size, open: !r.collapsed }
    liveRef.current = next
    setLive(next)
  }
  const onDragEnd = (cancelled: boolean) => {
    const d = drag.current
    const l = liveRef.current
    drag.current = null
    liveRef.current = null
    setLive(null)
    if (!l || cancelled) return
    if (l.open) onSizeChange(l.size)
    if (l.open !== d?.startOpen) onOpenChange(l.open)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (collapsible || !open) onOpenChange(!open)
      return
    }
    const key = side === 'right' ? (FLIP[e.key] ?? e.key) : e.key
    const max = effectiveMax()
    const next = keyStep(key, e.shiftKey, open ? currentWidth() : 0, { min: minSize, max })
    if (next === null) return
    e.preventDefault()
    if (!open) {
      if (next > 0) {
        onOpenChange(true)
        onSizeChange(Math.min(max, Math.max(minSize, size)))
      }
      return
    }
    onSizeChange(next)
  }

  const w = shown.size
  const atMin = shown.open && w <= minSize
  const atMax = shown.open && drag.current ? w >= drag.current.max : shown.open && w >= maxSize
  return (
    <div
      ref={box}
      className={cn('relative flex min-h-0', !shown.open && 'w-0')}
      style={shown.open ? { flex: `0 1 ${w}px`, width: w, minWidth: Math.min(w, minSize) } : { flex: '0 0 0px' }}
    >
      {shown.open && (
        <aside id={id} aria-label={label} className={cn('flex min-h-0 w-full min-w-0 flex-col overflow-hidden bg-panel', className)}>
          {children}
        </aside>
      )}
      <Sash
        label={label}
        controls={id}
        valueNow={shown.open ? w : 0}
        valueMin={minSize}
        valueMax={maxSize}
        limit={!shown.open ? 'min' : atMax ? 'max' : atMin && !collapsible ? 'min' : null}
        growSign={sign}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onReset={() => {
          onSizeChange(defaultSize)
          if (!open) onOpenChange(true)
        }}
        onKeyDown={onKeyDown}
        className={side === 'left' ? 'dp-sash-at-right' : 'dp-sash-at-left'}
        // a collapsed panel keeps its sash just inside the neighbouring area, to drag it back out
        style={shown.open ? undefined : side === 'left' ? { right: -6 } : { left: -6 }}
      />
    </div>
  )
}
