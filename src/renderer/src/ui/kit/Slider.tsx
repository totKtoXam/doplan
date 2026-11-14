import { useRef, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { clamp, cn, focusRing, newGesture } from './cn'
import { fmtNum } from './units'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  /** `gesture` is stable during one drag / keyboard focus session (history merge key) */
  onChange(value: number, gesture: string): void
  /** formats the value shown on the right; pass `false` to hide it */
  format?: ((v: number) => string) | false
  label?: ReactNode
  disabled?: boolean
  className?: string
  /** CSS background of the track (e.g. a gradient for colour temperature) */
  trackStyle?: string
  'aria-label'?: string
}

/** horizontal slider with pointer drag and full keyboard support (arrows, PageUp/Down, Home/End) */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  label,
  disabled,
  className,
  trackStyle,
  ...aria
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const gesture = useRef(newGesture('sl'))
  const dragging = useRef<number | null>(null)
  const span = max - min || 1
  const frac = clamp((value - min) / span, 0, 1)

  const snap = (v: number) => {
    const s = Math.round((v - min) / step) * step + min
    return clamp(Number(s.toFixed(10)), min, max)
  }
  const set = (v: number) => {
    const n = snap(v)
    if (n !== value) onChange(n, gesture.current)
  }
  const fromPointer = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return
    set(min + ((clientX - r.left) / r.width) * span)
  }
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    gesture.current = newGesture('sl')
    dragging.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    fromPointer(e.clientX)
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) fromPointer(e.clientX)
  }
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (dragging.current !== e.pointerId) return
    dragging.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    gesture.current = newGesture('sl')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = Math.max(step, span / 10)
    let n: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = value + (e.shiftKey ? big : step)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = value - (e.shiftKey ? big : step)
    else if (e.key === 'PageUp') n = value + big
    else if (e.key === 'PageDown') n = value - big
    else if (e.key === 'Home') n = min
    else if (e.key === 'End') n = max
    if (n !== null) {
      e.preventDefault()
      e.stopPropagation()
      set(n)
    }
  }
  const fmt = format === false ? null : (format ?? ((v: number) => fmtNum(v, step >= 1 ? 0 : step >= 0.1 ? 1 : 2)))

  return (
    // w-full + flex-1: fill a block parent and grow inside flex rows (Row's value cell is a flex container)
    <div className={cn('flex w-full min-w-0 flex-1 items-center gap-2', disabled && 'opacity-50', className)}>
      {label !== undefined && <span className="shrink-0 text-[11px] text-[var(--muted)]">{label}</span>}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={fmt ? fmt(value) : undefined}
        aria-label={aria['aria-label'] ?? (typeof label === 'string' ? label : undefined)}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onFocus={() => {
          gesture.current = newGesture('sl')
        }}
        onKeyDown={onKeyDown}
        className={cn('group relative flex h-5 min-w-0 flex-1 cursor-pointer touch-none items-center rounded', focusRing)}
      >
        <div
          ref={trackRef}
          className="relative h-1 w-full rounded-full bg-[color-mix(in_srgb,var(--text)_15%,transparent)]"
          style={trackStyle ? { background: trackStyle } : undefined}
        >
          {!trackStyle && (
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" style={{ width: `${frac * 100}%` }} />
          )}
          <div
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--accent)] bg-white shadow transition-transform group-active:scale-110"
            style={{ left: `${frac * 100}%` }}
          />
        </div>
      </div>
      {fmt && <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[var(--text)]">{fmt(value)}</span>}
    </div>
  )
}
