/**
 * A panel floating over a view (pinned to a top corner of its positioned parent) that the user
 * can resize from its free edges and the bottom corner. The size is remembered under `boxKey`;
 * double click on an edge restores the default.
 *
 * The panel is a flex column: give the part that should scroll `min-h-0 flex-1 overflow-auto`, so
 * a smaller height scrolls it instead of clipping.
 */
import { type ReactNode, useRef } from 'react'
import { useBoxSize } from '@/store/layout'
import { cn } from './cn'
import { ResizeFrame } from './ResizeFrame'
import type { Box, BoxEdge } from './sashMath'

/** the gap the panel keeps to the edges of the view (top-2 / left-2 / right-2) */
const GAP = 16

const EDGES: Record<'top-left' | 'top-right', { edges: BoxEdge[]; grip: BoxEdge }> = {
  'top-left': { edges: ['e', 's', 'se'], grip: 'se' },
  'top-right': { edges: ['w', 's', 'sw'], grip: 'sw' },
}

export interface FloatingPanelProps {
  /** the name its size is remembered under */
  boxKey: string
  /** the corner it is pinned to; the opposite edges resize it */
  anchor: 'top-left' | 'top-right'
  defaultWidth: number
  minSize?: Box
  /** aria label of the resize grip */
  label: string
  /** position and look, e.g. `top-2 right-2 z-20 rounded-lg border bg-panel` */
  className?: string
  children: ReactNode
}

export function FloatingPanel({ boxKey, anchor, defaultWidth, minSize = { w: 200, h: 120 }, label, className, children }: FloatingPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { size, set } = useBoxSize(boxKey)
  const { edges, grip } = EDGES[anchor]
  return (
    <div
      ref={ref}
      className={cn('absolute flex flex-col', className)}
      style={{
        width: size?.w ?? defaultWidth,
        maxWidth: `calc(100% - ${GAP}px)`,
        ...(size?.h ? { height: size.h, maxHeight: `calc(100% - ${GAP}px)` } : null),
      }}
      // the view under the panel must not get the clicks
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
      <ResizeFrame
        target={ref}
        edges={edges}
        grip={grip}
        min={minSize}
        max={() => {
          const p = ref.current?.offsetParent?.getBoundingClientRect()
          return p ? { w: p.width - GAP, h: p.height - GAP } : { w: 4000, h: 4000 }
        }}
        onCommit={set}
        onReset={() => set(null)}
        label={label}
      />
    </div>
  )
}
