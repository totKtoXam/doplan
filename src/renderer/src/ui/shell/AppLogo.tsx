import { useId } from 'react'

/**
 * doplan logo: a lowercase "d" drawn as plan walls with a swing door (masters in resources/logo).
 * Below 32 px it draws the pixel-snapped variant without the thin door arc.
 */
export function AppLogo({ size, className }: { size: number; className?: string }) {
  // gradient ids must be valid in url(#…): drop the separators React puts into useId()
  const bg = `doplan-logo-${useId().replace(/[^\w-]/g, '')}`
  const compact = size < 32
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden className={className}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5d9bff" />
          <stop offset="1" stopColor="#2c63d6" />
        </linearGradient>
      </defs>
      {compact ? (
        <>
          <rect x="8" y="8" width="240" height="240" rx="52" fill={`url(#${bg})`} />
          <path d="M128 136 H80 A48 48 0 0 0 128 184 Z" fill="#fff" fillOpacity=".55" />
          <g fill="#fff">
            <rect x="168" y="40" width="32" height="176" />
            <rect x="48" y="104" width="32" height="112" />
            <rect x="48" y="184" width="152" height="32" />
            <rect x="128" y="104" width="72" height="32" />
          </g>
        </>
      ) : (
        <>
          <rect x="8" y="8" width="240" height="240" rx="56" fill={`url(#${bg})`} />
          <path d="M150 104 H96 A54 54 0 0 0 150 158 Z" fill="#fff" fillOpacity=".32" />
          <path d="M96 104 A54 54 0 0 0 150 158" fill="none" stroke="#fff" strokeWidth="8" />
          <path d="M150 104 V158" stroke="#fff" strokeWidth="8" />
          <g fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="square">
            <path d="M184 48 V206 H70 V104 H96" />
            <path d="M150 104 H184" />
          </g>
        </>
      )}
    </svg>
  )
}
