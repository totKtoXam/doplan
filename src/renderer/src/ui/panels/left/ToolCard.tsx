import type { ReactNode } from 'react'
import { cn, focusRing } from '@/ui/kit'

export function ToolCard({
  icon,
  label,
  sub,
  active,
  onClick,
  title,
}: {
  icon: ReactNode
  label: string
  sub?: string
  active?: boolean
  onClick(): void
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col items-center gap-1 rounded-md border px-1 pb-1.5 pt-2 text-center transition-colors [&_svg]:shrink-0',
        focusRing,
        active
          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text)]'
          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-[var(--muted)] hover:border-[color-mix(in_srgb,var(--accent)_60%,var(--border))] hover:text-[var(--text)]',
      )}
    >
      {icon}
      <span className="w-full truncate text-[11px] leading-tight text-[var(--text)]">{label}</span>
      {sub && <span className="w-full truncate text-[10px] leading-tight text-[var(--muted)]">{sub}</span>}
    </button>
  )
}

export function CardGrid({ children, cols = 3 }: { children: ReactNode; cols?: number }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}
