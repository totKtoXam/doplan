import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { cn, focusRing } from './cn'

export interface ThumbProps {
  /** image URL */
  src?: string
  /** fallback background colour (material swatch) */
  color?: string
  /** fallback content (icon) when there is no image */
  fallback?: ReactNode
  label: string
  sublabel?: string
  selected?: boolean
  onClick?(): void
  onDoubleClick?(): void
  /** top-right corner overlay (favourite star, download button …) */
  corner?: ReactNode
  /** bottom overlay inside the image (progress bar) */
  overlay?: ReactNode
  badge?: ReactNode
  draggable?: boolean
  onDragStart?(e: DragEvent<HTMLDivElement>): void
  className?: string
  /** image fit */
  fit?: 'cover' | 'contain'
  title?: string
}

/** catalogue tile: square preview + caption; keyboard activatable (Enter/Space) */
export function Thumb({
  src,
  color,
  fallback,
  label,
  sublabel,
  selected,
  onClick,
  onDoubleClick,
  corner,
  overlay,
  badge,
  draggable,
  onDragStart,
  className,
  fit = 'contain',
  title,
}: ThumbProps) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const showImg = !!src && !failed
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      title={title ?? (sublabel ? `${label}\n${sublabel}` : label)}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      className={cn(
        'group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border text-left transition-colors',
        focusRing,
        selected
          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:border-[color-mix(in_srgb,var(--accent)_60%,var(--border))]',
        className,
      )}
    >
      <div
        className="relative flex aspect-square w-full items-center justify-center overflow-hidden text-[var(--muted)] [&>svg]:size-7"
        style={!showImg && color ? { background: color } : undefined}
      >
        {showImg ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
            style={color && fit === 'contain' ? { background: color } : undefined}
          />
        ) : (
          !color && fallback
        )}
        {overlay}
        {badge && (
          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] leading-4 text-white">{badge}</span>
        )}
      </div>
      {corner && <div className="absolute right-0.5 top-0.5 flex gap-0.5">{corner}</div>}
      <div className="min-w-0 px-1.5 py-1">
        <div className="truncate text-[11px] leading-tight text-[var(--text)]">{label}</div>
        {sublabel && <div className="truncate text-[10px] leading-tight text-[var(--muted)]">{sublabel}</div>}
      </div>
    </div>
  )
}
