import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { clampRatio, SPLIT } from '@/store/layout'
import { uiStore, useUi } from '@/store/ui'
import { Sash } from '@/ui/kit/Sash'
import { splitLimits } from '@/ui/kit/sashMath'
import { Viewport2D } from './Viewport2D'
import { Viewport3D } from './Viewport3D'

/** the 2D share limits: each view keeps SPLIT.minPx, inside the range clampRatio stores */
const ratioLimits = (total: number) => splitLimits(total, SPLIT.minPx)

/** a 3D view hidden behind the plan this long is closed: its GPU memory goes back to the system */
export const RELEASE_3D_MS = 60_000

/**
 * 2D / 3D / split viewports. The 3D engine is created lazily the first time it is shown and kept
 * alive (hidden) while the plan alone is shown, so switching back is instant; after RELEASE_3D_MS of
 * plan only it is closed (the next one starts from the same camera).
 */
export function Workspace() {
  const t = useT()
  const mode = useUi((s) => s.mode)
  const ratio = useUi((s) => s.splitRatio)
  const [used3d, setUsed3d] = useState(mode !== '2d')
  const box = useRef<HTMLDivElement>(null)
  const pane2d = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startPx: number; total: number; ratio: number } | null>(null)

  useEffect(() => {
    if (mode !== '2d') {
      setUsed3d(true)
      return
    }
    if (!used3d) return
    const timer = window.setTimeout(() => setUsed3d(false), RELEASE_3D_MS)
    return () => window.clearTimeout(timer)
  }, [mode, used3d])

  const show2d = mode !== '3d'
  const show3d = mode !== '2d'
  const split = mode === 'split'

  const total = () => box.current?.getBoundingClientRect().width ?? 0
  const limits = ratioLimits(total())
  // the width goes straight to the DOM while dragging so the viewports are not re-rendered every
  // frame; their ResizeObservers resize the canvases
  const applyLive = (r: number) => {
    if (pane2d.current) pane2d.current.style.width = `${r * 100}%`
  }
  const commit = (r: number) => uiStore.setState({ splitRatio: clampRatio(r) })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { min, max } = ratioLimits(total())
    const step = e.shiftKey ? 0.1 : 0.02
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = ratio - step
    else if (e.key === 'ArrowRight') next = ratio + step
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    else if (e.key === 'Enter') next = SPLIT.defaultRatio
    if (next === null) return
    e.preventDefault()
    commit(Math.min(max, Math.max(min, next)))
  }

  return (
    <div ref={box} className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={pane2d}
        id="dp-view-2d"
        className={show2d ? 'relative flex min-h-0 min-w-0' : 'hidden'}
        style={split ? { width: `${ratio * 100}%`, flex: 'none' } : { flex: 1 }}
      >
        <Viewport2D />
        {split && (
          <Sash
            label={t('Граница видов')}
            controls="dp-view-2d"
            className="dp-sash-at-right"
            valueNow={ratio * 100}
            valueMin={limits.min * 100}
            valueMax={limits.max * 100}
            onDragStart={() => {
              const w = total()
              const startPx = pane2d.current?.getBoundingClientRect().width ?? w * ratio
              drag.current = { startPx, total: w, ratio }
            }}
            onDrag={(offset) => {
              const d = drag.current
              if (!d || d.total <= 0) return
              const { min, max } = ratioLimits(d.total)
              d.ratio = Math.min(max, Math.max(min, (d.startPx + offset) / d.total))
              applyLive(d.ratio)
            }}
            onDragEnd={(cancelled) => {
              const d = drag.current
              drag.current = null
              if (!d) return
              if (cancelled) applyLive(ratio)
              else commit(d.ratio)
            }}
            onReset={() => {
              applyLive(SPLIT.defaultRatio)
              commit(SPLIT.defaultRatio)
            }}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {used3d && (
        <div className={show3d ? cn3d(split) : 'hidden'}>
          <Viewport3D />
        </div>
      )}
    </div>
  )
}

function cn3d(split: boolean): string {
  return split ? 'flex min-h-0 min-w-0 flex-1 border-l border-border' : 'flex min-h-0 min-w-0 flex-1'
}
