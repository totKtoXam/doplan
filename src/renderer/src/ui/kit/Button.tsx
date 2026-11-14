import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn, focusRing } from './cn'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  /** shows a spinner and disables the button */
  loading?: boolean
  active?: boolean
}

const variants: Record<ButtonVariant, string> = {
  default:
    'bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_14%,transparent)] border border-[var(--border)]',
  primary: 'bg-[var(--accent)] text-white hover:brightness-110 border border-transparent',
  ghost: 'bg-transparent text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] border border-transparent',
  danger: 'bg-[color-mix(in_srgb,#e5484d_18%,transparent)] text-[#ff8589] hover:bg-[color-mix(in_srgb,#e5484d_30%,transparent)] border border-[color-mix(in_srgb,#e5484d_40%,transparent)]',
  outline: 'bg-transparent text-[var(--text)] border border-[var(--border)] hover:border-[var(--accent)]',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-[11px] gap-1',
  md: 'h-7 px-2.5 text-xs gap-1.5',
  lg: 'h-9 px-4 text-sm gap-2',
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
    />
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, loading, active, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        variants[variant],
        sizes[size],
        active && 'border-[var(--accent)] text-[var(--accent)]',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  /** accessible name; also shown as native tooltip */
  label: string
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  variant?: 'ghost' | 'default' | 'danger'
}

const iconSizes = { sm: 'size-6', md: 'size-7', lg: 'size-9' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, active, size = 'md', variant = 'ghost', className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        '[&_svg]:size-4',
        focusRing,
        iconSizes[size],
        variant === 'ghost' && 'text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:text-[var(--text)]',
        variant === 'default' &&
          'border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_12%,transparent)]',
        variant === 'danger' && 'text-[var(--muted)] hover:bg-[color-mix(in_srgb,#e5484d_20%,transparent)] hover:text-[#ff8589]',
        active && 'bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)] hover:text-[var(--accent)]',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
})
