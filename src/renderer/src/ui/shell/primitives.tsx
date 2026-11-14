/**
 * Small, dependency-free primitives used by the shell chrome (tool rail, top bar, menus).
 * Panels use the shared UI kit; the shell keeps its own minimal set so it never blocks on it.
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

// ───────────── tooltip ─────────────

export function Tip({
  label,
  kbd,
  side = 'bottom',
  children,
}: {
  label: ReactNode
  kbd?: string
  side?: 'bottom' | 'right' | 'top' | 'left'
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const show = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const el = ref.current?.firstElementChild ?? ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      switch (side) {
        case 'right':
          setPos({ x: r.right + 8, y: r.top + r.height / 2 })
          break
        case 'left':
          setPos({ x: r.left - 8, y: r.top + r.height / 2 })
          break
        case 'top':
          setPos({ x: r.left + r.width / 2, y: r.top - 8 })
          break
        default:
          setPos({ x: r.left + r.width / 2, y: r.bottom + 8 })
      }
    }, 450)
  }, [side])

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setPos(null)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const transform =
    side === 'right'
      ? 'translate(0,-50%)'
      : side === 'left'
        ? 'translate(-100%,-50%)'
        : side === 'top'
          ? 'translate(-50%,-100%)'
          : 'translate(-50%,0)'

  return (
    <span ref={ref} className="contents" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div className="dp-tooltip" style={{ left: pos.x, top: pos.y, transform }}>
            {label}
            {kbd && <span className="dp-kbd">{kbd}</span>}
          </div>,
          document.body,
        )}
    </span>
  )
}

// ───────────── buttons ─────────────

export interface IconBtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon: LucideIcon
  label: string
  kbd?: string
  active?: boolean
  size?: 'sm' | 'md'
  tipSide?: 'bottom' | 'right' | 'top' | 'left'
}

export function IconBtn({ icon: Icon, label, kbd, active, size = 'md', tipSide = 'bottom', className, ...rest }: IconBtnProps) {
  return (
    <Tip label={label} kbd={kbd} side={tipSide}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={clsx(
          'inline-flex shrink-0 items-center justify-center rounded-md transition-colors',
          size === 'sm' ? 'h-6 w-6' : 'h-8 w-8',
          active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-text',
          'disabled:pointer-events-none disabled:opacity-35',
          className,
        )}
        {...rest}
      >
        <Icon size={size === 'sm' ? 14 : 17} strokeWidth={1.75} />
      </button>
    </Tip>
  )
}

export function TextBtn({
  children,
  variant = 'default',
  className,
  ...rest
}: ComponentProps<'button'> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        variant === 'primary' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        variant === 'default' && 'border border-border bg-panel-2 text-text hover:bg-panel-3',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-text',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string; kbd?: string }[]
  onChange(v: T): void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex shrink-0 items-center rounded-md border border-border bg-input p-0.5">
      {options.map((o) => {
        const btn = (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex items-center gap-1 rounded-[5px] font-medium transition-colors',
              size === 'sm' ? 'h-5 px-1.5 text-[11px]' : 'h-6 px-2.5 text-xs',
              value === o.value ? 'bg-panel-3 text-text shadow-sm' : 'text-muted hover:text-text',
            )}
          >
            {o.label}
          </button>
        )
        return o.title ? (
          <Tip key={o.value} label={o.title} kbd={o.kbd}>
            {btn}
          </Tip>
        ) : (
          btn
        )
      })}
    </div>
  )
}

// ───────────── dropdown menu ─────────────

export type MenuEntry =
  | { type?: 'item'; label: string; icon?: LucideIcon; kbd?: string; disabled?: boolean; danger?: boolean; checked?: boolean; onSelect(): void }
  | { type: 'separator' }
  | { type: 'header'; label: string }
  | { type: 'submenu'; label: string; icon?: LucideIcon; items: MenuEntry[]; disabled?: boolean }

function MenuList({ items, onClose, style }: { items: MenuEntry[]; onClose(): void; style?: CSSProperties }) {
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null)
  return (
    <div
      className="dp-fade-in fixed z-[900] min-w-[210px] rounded-lg border border-border-strong bg-panel py-1 shadow-pop"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="my-1 h-px bg-border" />
        if (it.type === 'header')
          return (
            <div key={i} className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
              {it.label}
            </div>
          )
        const Icon = it.icon
        if (it.type === 'submenu') {
          return (
            <div
              key={i}
              className={clsx(
                'flex h-7 items-center gap-2 px-3 text-xs',
                it.disabled ? 'opacity-40' : 'hover:bg-accent-soft',
                sub?.index === i && 'bg-accent-soft',
              )}
              onPointerEnter={(e) => {
                if (it.disabled) return
                const r = e.currentTarget.getBoundingClientRect()
                setSub({ index: i, x: r.right - 2, y: r.top - 4 })
              }}
            >
              <span className="flex w-4 justify-center text-muted">{Icon && <Icon size={14} />}</span>
              <span className="flex-1 truncate">{it.label}</span>
              <ChevronRight size={13} className="text-muted" />
              {sub?.index === i && <MenuList items={it.items} onClose={onClose} style={{ left: sub.x, top: sub.y }} />}
            </div>
          )
        }
        return (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onPointerEnter={() => setSub(null)}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
            className={clsx(
              'flex h-7 w-full items-center gap-2 px-3 text-left text-xs',
              'hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-40',
              it.danger && 'text-danger',
            )}
          >
            <span className="flex w-4 justify-center text-muted">
              {it.checked ? <span className="text-accent">✓</span> : Icon ? <Icon size={14} /> : null}
            </span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.kbd && <span className="ml-4 font-mono text-[10px] text-faint">{it.kbd}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Button that opens a dropdown menu below itself. */
export function DropdownMenu({
  trigger,
  items,
  align = 'left',
}: {
  trigger: (props: { open: boolean; toggle(): void }) => ReactNode
  items: MenuEntry[] | (() => MenuEntry[])
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const el = anchor.current.firstElementChild ?? anchor.current
    const r = el.getBoundingClientRect()
    setPos({ x: align === 'right' ? r.right : r.left, y: r.bottom + 4 })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const list = typeof items === 'function' ? (open ? items() : []) : items

  return (
    <span ref={anchor} className="contents" onPointerDown={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        pos &&
        createPortal(
          <MenuList
            items={list}
            onClose={() => setOpen(false)}
            style={align === 'right' ? { right: window.innerWidth - pos.x, top: pos.y } : { left: pos.x, top: pos.y }}
          />,
          document.body,
        )}
    </span>
  )
}

/** Context menu at an arbitrary point (e.g. right-click on a level tab). */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuEntry[]; onClose(): void }) {
  useEffect(() => {
    if (!at) return
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
    }
  }, [at, onClose])
  if (!at) return null
  return createPortal(<MenuList items={items} onClose={onClose} style={{ left: at.x, top: at.y }} />, document.body)
}

// ───────────── dense inputs for the options bar ─────────────

export function MiniNumber({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  width = 64,
  title,
}: {
  value: number
  onChange(v: number): void
  min?: number
  max?: number
  step?: number
  suffix?: string
  width?: number
  title?: string
}) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(Math.round(value * 100) / 100))
  }, [value])
  const commit = () => {
    const v = Number(text.replace(',', '.'))
    if (Number.isFinite(v)) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
      onChange(clamped)
      setText(String(clamped))
    } else {
      setText(String(value))
    }
  }
  return (
    <label
      className="inline-flex h-6 shrink-0 items-center rounded-md border border-border bg-input pr-1.5 focus-within:border-accent"
      title={title}
    >
      <input
        className="dp-num h-full bg-transparent px-1.5 text-right font-mono text-[11px] text-text outline-none"
        style={{ width }}
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        onFocus={(e) => {
          focused.current = true
          e.currentTarget.select()
        }}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setText(String(value))
            e.currentTarget.blur()
          }
        }}
      />
      {suffix && <span className="text-[10px] text-faint">{suffix}</span>}
    </label>
  )
}

export function MiniSelect<T extends string | number>({
  value,
  options,
  onChange,
  title,
  width,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange(v: T): void
  title?: string
  width?: number
}) {
  return (
    <select
      title={title}
      value={String(value)}
      style={width ? { width } : undefined}
      onChange={(e) => {
        const raw = e.target.value
        const opt = options.find((o) => String(o.value) === raw)
        if (opt) onChange(opt.value)
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="h-6 shrink-0 rounded-md border border-border bg-input px-1.5 text-[11px] text-text outline-none focus:border-accent"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function MiniToggle({ checked, onChange, label, title }: { checked: boolean; onChange(v: boolean): void; label: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors',
        checked ? 'border-accent/50 bg-accent-soft text-accent' : 'border-border text-muted hover:text-text',
      )}
    >
      {label}
    </button>
  )
}

export function Sep() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-border" />
}
