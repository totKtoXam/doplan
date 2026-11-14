import { forwardRef, useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { cn, focusRing, inputBase } from './cn'

// ───────────────────────────── Toggle ─────────────────────────────

export interface ToggleProps {
  checked: boolean
  onChange(checked: boolean): void
  label?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  size?: 'sm' | 'md'
}

/** accessible switch (role=switch, Space/Enter toggles) */
export function Toggle({ checked, onChange, label, disabled, className, title, size = 'md' }: ToggleProps) {
  const id = useId()
  const sw = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        size === 'md' ? 'h-4 w-7' : 'h-3.5 w-6',
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_12%,transparent)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute rounded-full bg-white shadow transition-transform',
          size === 'md' ? 'size-3' : 'size-2.5',
          checked ? (size === 'md' ? 'translate-x-[13px]' : 'translate-x-[11px]') : 'translate-x-[1px]',
        )}
      />
    </button>
  )
  if (!label) return <span className={className}>{sw}</span>
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs text-[var(--text)]', className)}>
      {sw}
      <label htmlFor={id} className={cn('cursor-pointer select-none', disabled && 'opacity-50')}>
        {label}
      </label>
    </span>
  )
}

// ───────────────────────────── Input ─────────────────────────────

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string
  onChange(value: string): void
  /** called on Enter / blur with the final value */
  onCommit?(value: string): void
  className?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, onChange, onCommit, className, onKeyDown, onBlur, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onCommit) onCommit(e.currentTarget.value)
        onKeyDown?.(e)
      }}
      onBlur={(e) => {
        onCommit?.(e.currentTarget.value)
        onBlur?.(e)
      }}
      className={cn(inputBase, className)}
      {...rest}
    />
  )
})

export interface SearchInputProps {
  value: string
  onChange(value: string): void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void
}

export function SearchInput({ value, onChange, placeholder, className, autoFocus, onKeyDown }: SearchInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-[var(--muted)]" />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
          onKeyDown?.(e)
        }}
        className={cn(inputBase, 'pl-7 pr-7 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button
          type="button"
          aria-label="Очистить"
          onClick={() => {
            onChange('')
            ref.current?.focus()
          }}
          className={cn('absolute right-1.5 rounded p-0.5 text-[var(--muted)] hover:text-[var(--text)]', focusRing)}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

// ───────────────────────────── Select ─────────────────────────────

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
  group?: string
}

export interface SelectProps<T extends string = string> {
  value: T | ''
  options: readonly SelectOption<T>[]
  onChange(value: T): void
  className?: string
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
  id?: string
}

/** native select (fully keyboard accessible) with pro-tool styling; supports option groups */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  className,
  disabled,
  placeholder,
  id,
  ...aria
}: SelectProps<T>) {
  const groups: { name: string | undefined; opts: SelectOption<T>[] }[] = []
  for (const o of options) {
    const last = groups[groups.length - 1]
    if (last && last.name === o.group) last.opts.push(o)
    else groups.push({ name: o.group, opts: [o] })
  }
  const renderOpt = (o: SelectOption<T>) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  )
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={aria['aria-label']}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        inputBase,
        'cursor-pointer appearance-none bg-[length:10px] bg-[right_6px_center] bg-no-repeat pr-6',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.5'/%3E%3C/svg%3E\")]",
        className,
      )}
    >
      {value === '' && (
        <option value="" disabled>
          {placeholder ?? '—'}
        </option>
      )}
      {groups.map((g, i) =>
        g.name ? (
          <optgroup key={`${g.name}_${i}`} label={g.name}>
            {g.opts.map(renderOpt)}
          </optgroup>
        ) : (
          g.opts.map(renderOpt)
        ),
      )}
    </select>
  )
}

// ───────────────────────────── Segmented ─────────────────────────────

export interface SegmentedProps<T extends string> {
  value: T
  options: readonly { value: T; label: ReactNode; title?: string }[]
  onChange(v: T): void
  className?: string
  'aria-label'?: string
}

/** compact radio group (arrow keys move the selection) */
export function Segmented<T extends string>({ value, options, onChange, className, ...aria }: SegmentedProps<T>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value)
    let n = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % options.length
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + options.length) % options.length
    if (n >= 0) {
      e.preventDefault()
      onChange(options[n].value)
      const btn = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[n]
      btn?.focus()
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label={aria['aria-label']}
      onKeyDown={onKey}
      className={cn('inline-flex h-7 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1 rounded px-1.5 text-[11px] transition-colors [&_svg]:size-3.5',
            focusRing,
            o.value === value
              ? 'bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] text-[var(--text)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
