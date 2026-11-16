/**
 * Resize handles for a box (a floating panel or a dialog), as in Claude Desktop / VS Code
 * windows: thin edges that light up on hover, corners, and a faint grip in the main corner.
 *
 * The live size goes straight to the target element while dragging (no React render per frame);
 * the owner gets the final size through `onCommit` and renders it. Double click resets, Escape
 * cancels a drag, the grip is focusable and resizes with the arrow keys (Shift: bigger steps).
 */
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react'
import { cn } from './cn'
import { startPointerDrag } from './Sash'
import { type Box, type BoxEdge, edgeSigns, resizeBox } from './sashMath'

const CURSOR: Record<BoxEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

export interface ResizeFrameProps {
  /** the element whose size changes */
  target: RefObject<HTMLElement | null>
  /** the edges and corners that can be dragged */
  edges: BoxEdge[]
  /** the corner with the visible grip; it is also the keyboard handle */
  grip?: BoxEdge
  min: Box
  /** the largest size right now (the space around the box) */
  max(): Box
  /** 2 for a centred box: both sides move, so the dragged edge follows the pointer */
  factor?: number
  /** the final size; only the axes the drag changed */
  onCommit(size: Partial<Box>): void
  /** double click: back to the default size */
  onReset(): void
  label: string
}

type Saved = Pick<CSSStyleDeclaration, 'width' | 'height' | 'maxWidth' | 'maxHeight'>

export function ResizeFrame({ target, edges, grip, min, max, factor = 1, onCommit, onReset, label }: ResizeFrameProps) {
  const [dragging, setDragging] = useState<BoxEdge | null>(null)
  const stopRef = useRef<((cancelled: boolean) => void) | null>(null)
  useEffect(() => () => stopRef.current?.(true), [])

  const measure = (): Box | null => {
    const r = target.current?.getBoundingClientRect()
    return r ? { w: r.width, h: r.height } : null
  }

  const onPointerDown = (edge: BoxEdge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = target.current
    const start = measure()
    if (!el || !start) return
    e.stopPropagation()
    const s = edgeSigns(edge)
    const saved: Saved = { width: el.style.width, height: el.style.height, maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight }
    const limit = max()
    let last = start
    stopRef.current = startPointerDrag(e, CURSOR[edge], {
      begin: () => {
        // the live size must not be capped by the box's own max-width / max-height classes
        if (s.x) el.style.maxWidth = 'none'
        if (s.y) el.style.maxHeight = 'none'
        setDragging(edge)
      },
      move: (dx, dy) => {
        last = resizeBox(start, edge, dx, dy, min, limit, factor)
        if (s.x) el.style.width = `${last.w}px`
        if (s.y) el.style.height = `${last.h}px`
      },
      end: (cancelled) => {
        stopRef.current = null
        setDragging(null)
        // the owner renders the committed size; hand the element back to it as it was
        Object.assign(el.style, saved)
        // a click without a drag (or Escape) keeps the size as it was, automatic or remembered
        if (cancelled) return
        const out: Partial<Box> = {}
        if (s.x) out.w = last.w
        if (s.y) out.h = last.h
        onCommit(out)
      },
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 50 : 10
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const m = d[e.key]
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
    const start = measure()
    if (!start) return
    // arrows grow right / down whatever corner the grip is in; a step is the same size change
    // for a centred box too
    const next = resizeBox(start, 'se', m[0] / factor, m[1] / factor, min, max(), factor)
    onCommit(m[0] ? { w: next.w } : { h: next.h })
  }

  return (
    <>
      {edges.map((edge) => {
        const isGrip = edge === grip
        return (
          <div
            key={edge}
            role={isGrip ? 'separator' : undefined}
            aria-label={isGrip ? label : undefined}
            aria-hidden={isGrip ? undefined : true}
            tabIndex={isGrip ? 0 : undefined}
            title={isGrip ? label : undefined}
            data-dragging={dragging === edge || undefined}
            className={cn('dp-rz', `dp-rz-${edge}`, isGrip && 'dp-rz-grip')}
            style={{ cursor: CURSOR[edge] }}
            onPointerDown={onPointerDown(edge)}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onReset()
            }}
            onKeyDown={isGrip ? onKeyDown : undefined}
          />
        )
      })}
    </>
  )
}
