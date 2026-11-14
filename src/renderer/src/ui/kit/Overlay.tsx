import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn, focusRing } from './cn'
import { IconButton } from './Button'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

// ───────────────────────────── Dialog ─────────────────────────────

export interface DialogProps {
  open: boolean
  onClose(): void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** tailwind width class, default max-w-lg */
  width?: string
  /** do not close on backdrop click (e.g. while working) */
  modalLock?: boolean
  className?: string
  /** drawer docked to the right instead of centred */
  drawer?: boolean
}

/** modal dialog: portal, Escape closes, focus trap, focus restore, labelled by its title */
export function Dialog({ open, onClose, title, children, footer, width, modalLock, className, drawer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => {
      const root = ref.current
      if (!root) return
      const auto = root.querySelector<HTMLElement>('[autofocus],[data-autofocus]')
      const first = auto ?? focusables(root).find((el) => !el.dataset.dialogClose) ?? root
      first.focus()
    }, 0)
    return () => {
      window.clearTimeout(t)
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!modalLock) closeRef.current()
      return
    }
    if (e.key === 'Tab' && ref.current) {
      const els = focusables(ref.current)
      if (els.length === 0) return
      const first = els[0]
      const last = els[els.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    // dialogs swallow keys so editor shortcuts do not fire behind them
    e.stopPropagation()
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[1000] flex',
        drawer ? 'justify-end bg-black/10' : 'items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]',
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !modalLock) closeRef.current()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'flex flex-col border border-[var(--border)] bg-[var(--panel)] text-[var(--text)] shadow-2xl outline-none',
          drawer ? 'h-full w-full max-w-sm border-y-0 border-r-0' : cn('max-h-[90vh] w-full rounded-lg', width ?? 'max-w-lg'),
          className,
        )}
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] pl-4 pr-2">
          <h2 id={titleId} className="truncate text-sm font-semibold">
            {title}
          </h2>
          <IconButton icon={<X />} label="Закрыть" data-dialog-close="1" onClick={() => closeRef.current()} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-xs">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ───────────────────────────── Popover ─────────────────────────────

export interface PopoverProps {
  open: boolean
  onClose(): void
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  /** px; default = anchor width (min 220) */
  width?: number
  placement?: 'bottom-start' | 'bottom-end' | 'left-start' | 'right-start'
  className?: string
  role?: string
  'aria-label'?: string
}

/** floating panel anchored to an element; closes on outside click and Escape, flips to stay on screen */
export function Popover({ open, onClose, anchorRef, children, width, placement = 'bottom-start', className, role, ...aria }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const place = useCallback(() => {
    const a = anchorRef.current
    const el = ref.current
    if (!a || !el) return
    const r = a.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left: number
    let top: number
    if (placement === 'left-start' || placement === 'right-start') {
      left = placement === 'left-start' ? r.left - w - 4 : r.right + 4
      if (left < 4) left = r.right + 4
      if (left + w > vw - 4) left = Math.max(4, r.left - w - 4)
      top = Math.min(r.top, vh - h - 4)
    } else {
      left = placement === 'bottom-end' ? r.right - w : r.left
      top = r.bottom + 4
      if (top + h > vh - 4 && r.top - h - 4 > 4) top = r.top - h - 4
    }
    left = Math.max(4, Math.min(left, vw - w - 4))
    top = Math.max(4, top)
    setPos({ left, top, maxH: vh - top - 8 })
  }, [anchorRef, placement])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    const ro = new ResizeObserver(place)
    if (ref.current) ro.observe(ref.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      // clicks inside nested popovers opened from this one (deeper) do not close it
      if (t instanceof Element) {
        const root = t.closest<HTMLElement>('[data-popover-root]')
        if (root && Number(root.dataset.depth ?? 0) > Number(ref.current?.dataset.depth ?? 0)) return
      }
      closeRef.current()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        anchorRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchorRef])

  if (!open) return null
  const anchorW = anchorRef.current?.offsetWidth ?? 220
  const depth = (anchorRef.current?.closest('[data-popover-root]') as HTMLElement | null)?.dataset.depth
  return createPortal(
    <div
      ref={ref}
      role={role ?? 'dialog'}
      aria-label={aria['aria-label']}
      data-popover-root=""
      data-depth={String(Number(depth ?? 0) + 1)}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        'fixed z-[1100] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] text-xs text-[var(--text)] shadow-2xl',
        className,
      )}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: width ?? Math.max(220, anchorW),
        maxHeight: pos?.maxH,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

// ───────────────────────────── Menu ─────────────────────────────

export interface MenuItem {
  label?: string
  icon?: ReactNode
  onSelect?(): void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  hint?: string
}

export interface MenuProps {
  /** content of the trigger button */
  trigger: ReactNode
  items: MenuItem[]
  /** trigger button className */
  className?: string
  label?: string
  placement?: 'bottom-start' | 'bottom-end'
  width?: number
}

/** dropdown menu: button + role=menu with arrow key navigation, Enter/Space select, Escape closes */
export function Menu({ trigger, items, className, label, placement = 'bottom-start', width = 200 }: MenuProps) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      els[(i + 1) % els.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      els[(i - 1 + els.length) % els.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      els[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      els[els.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] [&_svg]:size-4',
          focusRing,
          className,
        )}
      >
        {trigger}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={btn} width={width} placement={placement} role="presentation">
        <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKeyDown} className="py-1">
          {items.map((it, i) =>
            it.separator ? (
              <div key={`sep${i}`} role="separator" className="my-1 h-px bg-[var(--border)]" />
            ) : (
              <div
                key={`${it.label}${i}`}
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                onClick={() => {
                  if (it.disabled) return
                  setOpen(false)
                  it.onSelect?.()
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !it.disabled) {
                    e.preventDefault()
                    setOpen(false)
                    btn.current?.focus()
                    it.onSelect?.()
                  }
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 outline-none [&_svg]:size-3.5',
                  'hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] focus:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]',
                  it.disabled && 'cursor-not-allowed opacity-40',
                  it.danger && 'text-[#ff8589]',
                )}
              >
                <span className="flex w-4 justify-center text-[var(--muted)]">{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-[10px] text-[var(--muted)]">{it.hint}</span>}
              </div>
            ),
          )}
        </div>
      </Popover>
    </>
  )
}

// ───────────────────────────── Tooltip ─────────────────────────────

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  /** ms */
  delay?: number
  side?: 'top' | 'bottom' | 'right'
  className?: string
}

/** hover/focus tooltip rendered in a portal; the trigger gets aria-describedby */
export function Tooltip({ content, children, delay = 400, side = 'top', className }: TooltipProps) {
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number>(0)

  const show = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      if (side === 'right') setPos({ x: r.right + 6, y: r.top + r.height / 2 })
      else setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top - 6 : r.bottom + 6 })
    }, delay)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setPos(null)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <span
      ref={ref}
      className={cn('inline-flex', className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos &&
        content &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[1200] max-w-64 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[11px] leading-snug text-[var(--text)] shadow-lg"
            style={{
              left: pos.x,
              top: pos.y,
              transform:
                side === 'top' ? 'translate(-50%, -100%)' : side === 'bottom' ? 'translate(-50%, 0)' : 'translate(0, -50%)',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}
