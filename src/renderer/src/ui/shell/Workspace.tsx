import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { uiStore, useUi } from '@/store/ui'
import { Viewport2D } from './Viewport2D'
import { Viewport3D } from './Viewport3D'

/**
 * 2D / 3D / split viewports. The 3D engine is created lazily the first time it is shown and then
 * kept alive (hidden) so switching views is instant.
 */
export function Workspace() {
  const t = useT()
  const mode = useUi((s) => s.mode)
  const ratio = useUi((s) => s.splitRatio)
  const [used3d, setUsed3d] = useState(mode !== '2d')
  const box = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (mode !== '2d') setUsed3d(true)
  }, [mode])

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = box.current
    if (!el) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const r = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width))
      uiStore.setState({ splitRatio: r })
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const show2d = mode !== '3d'
  const show3d = mode !== '2d'
  const split = mode === 'split'

  return (
    <div ref={box} className="relative flex min-h-0 min-w-0 flex-1">
      <div className={show2d ? 'flex min-h-0 min-w-0' : 'hidden'} style={split ? { width: `${ratio * 100}%` } : { flex: 1 }}>
        <Viewport2D />
      </div>
      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Граница видов')}
          onPointerDown={onDividerDown}
          onDoubleClick={() => uiStore.setState({ splitRatio: 0.5 })}
          className={`dp-divider relative z-10 w-1 shrink-0 bg-border transition-colors hover:bg-accent ${dragging ? 'bg-accent' : ''}`}
        >
          <div className="absolute inset-y-0 -right-1.5 -left-1.5" />
        </div>
      )}
      {used3d && (
        <div className={show3d ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>
          <Viewport3D />
        </div>
      )}
      {/* while dragging the divider, keep canvases from eating pointer events */}
      {dragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}
    </div>
  )
}
