import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { useDoc } from '@/store/document'
import { clamp, cn, newGesture } from './cn'
import {
  defaultDecimals,
  evalExpression,
  formatValue,
  fromDisplay,
  toDisplay,
  UNIT_LABEL,
  type LengthUnit,
  type NumberKind,
} from './units'

export interface NumberInputProps {
  /** value in base units: mm for lengths, degrees for angles, fraction 0..1 for percent; null = mixed / empty */
  value: number | null | undefined
  /**
   * called with the new base-unit value. `gesture` is stable during one drag-scrub / focus session —
   * use it as the history merge key suffix so a scrub becomes one undo step.
   */
  onChange(value: number, gesture: string): void
  kind?: NumberKind
  /** display unit for lengths; defaults to the document setting */
  unit?: LengthUnit
  /** step in BASE units (default: length 10 mm, angle 1°, percent 0.01, number 1) */
  step?: number
  min?: number
  max?: number
  /** decimals shown */
  decimals?: number
  /** round committed value to this many base units (e.g. 1 mm) */
  round?: number
  /** suffix override */
  suffix?: string
  /** optional leading label; it also acts as the drag-scrub handle */
  label?: ReactNode
  disabled?: boolean
  className?: string
  placeholder?: string
  'aria-label'?: string
  title?: string
}

function defaultStep(kind: NumberKind): number {
  return kind === 'length' ? 10 : kind === 'angle' ? 1 : kind === 'percent' ? 0.01 : 1
}

/**
 * Numeric field for a pro tool: unit-aware display (mm/cm/m), arithmetic expressions ("3200+150", "1.2м+15см"),
 * ArrowUp/Down (Shift ×10, Alt ×0.1), PageUp/PageDown (×10), horizontal drag scrubbing on the field or label
 * (Shift fine, Ctrl coarse), Enter commits, Escape reverts.
 */
export function NumberInput({
  value,
  onChange,
  kind = 'number',
  unit,
  step,
  min,
  max,
  decimals,
  round,
  suffix,
  label,
  disabled,
  className,
  placeholder,
  title,
  ...aria
}: NumberInputProps) {
  const docUnit = useDoc((s) => s.doc.settings.units)
  const u: LengthUnit = unit ?? docUnit ?? 'mm'
  const st = step ?? defaultStep(kind)
  const dec = decimals ?? defaultDecimals(kind, u)
  const sfx = suffix ?? (kind === 'length' ? UNIT_LABEL[u] : kind === 'angle' ? '°' : kind === 'percent' ? '%' : '')

  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const gestureRef = useRef<string>(newGesture('n'))
  const scrub = useRef<{ x: number; start: number; moved: boolean; id: number; last: number } | null>(null)

  const shown = value === null || value === undefined || !Number.isFinite(value) ? '' : formatValue(value, kind, u, dec)

  useEffect(() => {
    if (!focused) setText(shown)
  }, [shown, focused])

  const normalise = (v: number): number => {
    let r = clamp(v, min, max)
    if (round) r = Math.round(r / round) * round
    return r
  }

  const emit = (v: number) => {
    const n = normalise(v)
    if (value !== n) onChange(n, gestureRef.current)
    return n
  }

  const commitText = (): boolean => {
    if (text.trim() === '' || text === shown) {
      setInvalid(false)
      return true
    }
    const d = evalExpression(text, kind, u)
    if (d === null) {
      setInvalid(true)
      return false
    }
    setInvalid(false)
    const n = emit(fromDisplay(d, kind, u))
    setText(formatValue(n, kind, u, dec))
    return true
  }

  const bump = (dir: number, e: { shiftKey: boolean; altKey: boolean }) => {
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    const fromText = focused ? evalExpression(text, kind, u) : null
    const base = fromText !== null ? fromDisplay(fromText, kind, u) : (value ?? 0)
    const n = emit(base + dir * st * mult)
    setText(formatValue(n, kind, u, dec))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (commitText()) {
        gestureRef.current = newGesture('n')
        inputRef.current?.select()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setText(shown)
      setInvalid(false)
      inputRef.current?.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      bump(e.key === 'ArrowUp' ? 1 : -1, e)
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      bump(e.key === 'PageUp' ? 10 : -10, { shiftKey: false, altKey: false })
    }
    // keep editor shortcuts (Delete, Ctrl+Z…) from reaching the canvas while typing
    e.stopPropagation()
  }

  // ── drag scrubbing ──
  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return
    if (focused && e.currentTarget === inputRef.current) return // normal text selection while editing
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { x: e.clientX, start: value ?? 0, moved: false, id: e.pointerId, last: value ?? 0 }
    gestureRef.current = newGesture('s')
  }
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const s = scrub.current
    if (!s || s.id !== e.pointerId) return
    const dx = e.clientX - s.x
    if (!s.moved && Math.abs(dx) < 3) return
    s.moved = true
    const mult = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1
    const raw = s.start + Math.round(dx / 2) * st * mult
    const n = normalise(raw)
    if (n !== s.last) {
      s.last = n
      onChange(n, gestureRef.current)
    }
  }
  const onPointerUp = (e: RPointerEvent<HTMLElement>) => {
    const s = scrub.current
    if (!s || s.id !== e.pointerId) return
    scrub.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (!s.moved) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }
  const scrubHandlers = disabled
    ? {}
    : { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

  return (
    <div
      className={cn(
        'group flex h-7 min-w-0 items-center rounded-md border bg-[var(--bg)] text-xs transition-colors',
        invalid ? 'border-[#e5484d]' : focused ? 'border-[var(--accent)]' : 'border-[var(--border)] hover:border-[color-mix(in_srgb,var(--text)_30%,var(--border))]',
        disabled && 'opacity-50',
        className,
      )}
      title={title}
    >
      {label !== undefined && (
        <span
          {...scrubHandlers}
          className={cn(
            'flex h-full shrink-0 select-none items-center pl-2 pr-1 text-[11px] text-[var(--muted)]',
            !disabled && 'cursor-ew-resize hover:text-[var(--text)]',
          )}
        >
          {label}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        disabled={disabled}
        aria-label={aria['aria-label'] ?? (typeof label === 'string' ? label : undefined)}
        aria-invalid={invalid || undefined}
        role="spinbutton"
        aria-valuenow={value ?? undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        placeholder={value === null ? '—' : placeholder}
        value={focused ? text : shown}
        onChange={(e) => {
          setText(e.target.value)
          setInvalid(false)
        }}
        onFocus={() => {
          setFocused(true)
          setText(shown)
          gestureRef.current = newGesture('n')
        }}
        onBlur={() => {
          commitText()
          setFocused(false)
          setInvalid(false)
        }}
        onKeyDown={onKeyDown}
        {...scrubHandlers}
        className={cn(
          'h-full w-full min-w-0 flex-1 bg-transparent px-2 text-right tabular-nums text-[var(--text)] outline-none',
          label !== undefined && 'pl-1',
          !focused && !disabled && 'cursor-ew-resize',
        )}
      />
      {sfx && <span className="shrink-0 select-none pr-2 text-[11px] text-[var(--muted)]">{sfx}</span>}
    </div>
  )
}

export { toDisplay, fromDisplay }
