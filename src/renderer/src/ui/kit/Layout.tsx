import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn, focusRing, newGesture } from './cn'

// ───────────────────────────── Tabs ─────────────────────────────

export interface TabItem<T extends string = string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  title?: string
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[]
  value: T
  onChange(id: T): void
  className?: string
  /** id prefix used to link tabs with panels: panel id = `${idBase}-panel-${id}` */
  idBase?: string
  variant?: 'underline' | 'pill'
  'aria-label'?: string
}

/** WAI-ARIA tablist with roving tabindex and arrow/Home/End navigation */
export function Tabs<T extends string = string>({ items, value, onChange, className, idBase, variant = 'underline', ...aria }: TabsProps<T>) {
  const auto = useId()
  const base = idBase ?? auto
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((it) => it.id === value)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % items.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = items.length - 1
    if (n >= 0) {
      e.preventDefault()
      onChange(items[n].id)
      e.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')[n]?.focus()
    }
  }
  return (
    <div
      role="tablist"
      aria-label={aria['aria-label']}
      onKeyDown={onKey}
      className={cn(
        'flex min-w-0 shrink-0',
        variant === 'underline' ? 'border-b border-[var(--border)]' : 'gap-1 rounded-md bg-[var(--bg)] p-0.5',
        className,
      )}
    >
      {items.map((it) => {
        const sel = it.id === value
        return (
          <button
            key={it.id}
            id={`${base}-tab-${it.id}`}
            type="button"
            role="tab"
            aria-selected={sel}
            aria-controls={`${base}-panel-${it.id}`}
            tabIndex={sel ? 0 : -1}
            title={it.title}
            onClick={() => onChange(it.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate text-[11px] font-medium transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0',
              focusRing,
              variant === 'underline'
                ? cn('-mb-px h-8 border-b-2 px-1.5', sel ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]')
                : cn('h-6 rounded px-2', sel ? 'bg-[var(--panel)] text-[var(--text)] shadow' : 'text-[var(--muted)] hover:text-[var(--text)]'),
            )}
          >
            {it.icon}
            <span className="truncate">{it.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ idBase, id, children, className }: { idBase: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} className={className}>
      {children}
    </div>
  )
}

// ───────────────────────────── Section / Row / ScrollArea ─────────────────────────────

const collapsedMemory = new Map<string, boolean>()

export interface SectionProps {
  title: ReactNode
  children: ReactNode
  /** remembered collapse state key */
  id?: string
  defaultOpen?: boolean
  actions?: ReactNode
  className?: string
}

/** collapsible inspector section (button header with aria-expanded) */
export function Section({ title, children, id, defaultOpen = true, actions, className }: SectionProps) {
  const [open, setOpenState] = useState(() => (id && collapsedMemory.has(id) ? !collapsedMemory.get(id) : defaultOpen))
  const bodyId = useId()
  const setOpen = (o: boolean) => {
    if (id) collapsedMemory.set(id, !o)
    setOpenState(o)
  }
  return (
    <section className={cn('border-b border-[var(--border)]', className)}>
      <div className="flex h-8 items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-1 pl-2 text-left text-[12px] font-semibold text-[var(--text)] hover:text-[var(--accent)]',
            focusRing,
          )}
        >
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="truncate">{title}</span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {open && (
        <div id={bodyId} className="flex flex-col gap-1.5 px-3 pb-3">
          {children}
        </div>
      )}
    </section>
  )
}

export interface RowProps {
  label?: ReactNode
  children: ReactNode
  className?: string
  /** stack label above the control */
  stacked?: boolean
  hint?: ReactNode
}

/** label + control row used throughout the inspector */
export function Row({ label, children, className, stacked, hint }: RowProps) {
  return (
    <div className={cn(stacked ? 'flex flex-col gap-1' : 'grid grid-cols-[minmax(0,38%)_minmax(0,1fr)] items-center gap-2', className)}>
      {label !== undefined && <span className="truncate text-[11px] text-[var(--muted)]">{label}</span>}
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      {hint && <div className={cn('text-[10px] text-[var(--muted)]', !stacked && 'col-span-2')}>{hint}</div>}
    </div>
  )
}

export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-color:color-mix(in_srgb,var(--text)_25%,transparent)_transparent] [scrollbar-width:thin]',
        className,
      )}
    >
      {children}
    </div>
  )
}

// ───────────────────────────── ColorInput ─────────────────────────────

export interface ColorInputProps {
  /** '#rrggbb' or undefined (empty) */
  value: string | undefined
  /** `gesture` stays stable while the native picker is open (history merge key) */
  onChange(value: string, gesture: string): void
  /** shows a clear button that calls onClear */
  onClear?(): void
  className?: string
  disabled?: boolean
  'aria-label'?: string
  swatches?: string[]
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

export function normaliseHex(s: string): string | null {
  const m = HEX_RE.exec(s.trim())
  if (!m) return null
  let h = m[1].toLowerCase()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return `#${h}`
}

/** colour swatch (opens the native picker) + editable hex field + optional preset swatches */
export function ColorInput({ value, onChange, onClear, className, disabled, swatches, ...aria }: ColorInputProps) {
  const pickerRef = useRef<HTMLInputElement>(null)
  const gesture = useRef(newGesture('c'))
  const [text, setText] = useState<string | null>(null)
  const commit = (s: string) => {
    const h = normaliseHex(s)
    if (h && h !== value) onChange(h, newGesture('c'))
    setText(null)
  }
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          aria-label={aria['aria-label'] ?? 'Цвет'}
          onClick={() => {
            gesture.current = newGesture('c')
            pickerRef.current?.click()
          }}
          className={cn(
            'relative size-7 shrink-0 overflow-hidden rounded-md border border-[var(--border)] disabled:opacity-50',
            focusRing,
          )}
          style={{
            background: value ?? 'repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px',
          }}
        >
          <input
            ref={pickerRef}
            type="color"
            tabIndex={-1}
            aria-hidden
            value={value ?? '#ffffff'}
            onChange={(e) => onChange(e.target.value, gesture.current)}
            className="pointer-events-none absolute inset-0 opacity-0"
          />
        </button>
        <input
          type="text"
          spellCheck={false}
          disabled={disabled}
          aria-label={`${aria['aria-label'] ?? 'Цвет'} (hex)`}
          value={text ?? value ?? ''}
          placeholder="—"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit(e.currentTarget.value)
            if (e.key === 'Escape') setText(null)
          }}
          className="h-7 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-[11px] uppercase text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
        {onClear && value && (
          <button
            type="button"
            onClick={onClear}
            className={cn('shrink-0 rounded px-1 text-[11px] text-[var(--muted)] hover:text-[var(--text)]', focusRing)}
          >
            ✕
          </button>
        )}
      </div>
      {swatches && swatches.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {swatches.map((s) => (
            <button
              key={s}
              type="button"
              aria-label={s}
              title={s}
              onClick={() => onChange(s, newGesture('c'))}
              className={cn('size-4 rounded-sm border border-[var(--border)]', s === value && 'ring-1 ring-[var(--accent)]', focusRing)}
              style={{ background: s }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
