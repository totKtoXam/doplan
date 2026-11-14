import type { ReactNode } from 'react'
import { Copy, Trash } from 'lucide-react'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { IconButton } from '@/ui/kit'
import { AddToChatButton } from '@/ai/AddToChatButton' // ai-chat

/** inspector header: icon, title, subtitle and the common duplicate/delete buttons */
export function InspectorHeader({
  icon,
  title,
  subtitle,
  canDuplicate = true,
  canDelete = true,
  extra,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  canDuplicate?: boolean
  canDelete?: boolean
  extra?: ReactNode
}) {
  const t = useT()
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
      {icon && <span className="text-[var(--muted)] [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{title}</div>
        {subtitle && <div className="truncate text-[10px] text-[var(--muted)]">{subtitle}</div>}
      </div>
      {extra}
      <AddToChatButton />
      {canDuplicate && <IconButton icon={<Copy />} label={t('Дублировать (Ctrl+D)')} onClick={() => void actions.duplicateSelection()} />}
      {canDelete && <IconButton icon={<Trash />} variant="danger" label={t('Удалить (Del)')} onClick={() => void actions.deleteSelection()} />}
    </div>
  )
}

/** read-only key/value line */
export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="tabular-nums text-[var(--text)]">{value}</span>
    </div>
  )
}

export function Pair({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-1.5">{children}</div>
}

export function Triple({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-1.5">{children}</div>
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[10px] leading-snug text-[var(--muted)]">{children}</p>
}
