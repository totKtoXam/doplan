import clsx from 'clsx'
import { ArrowLeftRight, Copy, Eye, EyeOff, Layers, Pencil, Plus, Trash } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { Id } from '@core/types'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { VariantTabs } from '@/ui/variants/VariantTabs'
import { ContextMenu, IconBtn, type MenuEntry } from './primitives'

export function LevelTabs() {
  const t = useT()
  const order = useDoc((s) => s.doc.levelOrder)
  const levels = useDoc((s) => s.doc.levels)
  const active = useUi((s) => s.activeLevelId)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: Id } | null>(null)
  const close = useCallback(() => setMenu(null), [])

  const menuItems = (id: Id): MenuEntry[] => {
    const lv = levels[id]
    const idx = order.indexOf(id)
    return [
      { label: t('Переименовать'), icon: Pencil, onSelect: () => void actions.renameLevel(id) },
      { label: t('Копировать этаж'), icon: Copy, onSelect: () => actions.addLevel(id) },
      { label: lv?.visible ? t('Скрыть в 3D') : t('Показать в 3D'), icon: lv?.visible ? EyeOff : Eye, onSelect: () => actions.toggleLevelVisible(id) },
      { type: 'separator' },
      { label: t('Сдвинуть влево'), icon: ArrowLeftRight, disabled: idx <= 0, onSelect: () => actions.moveLevel(id, -1) },
      { label: t('Сдвинуть вправо'), disabled: idx >= order.length - 1, onSelect: () => actions.moveLevel(id, 1) },
      { type: 'separator' },
      { label: t('Удалить этаж'), icon: Trash, danger: true, disabled: order.length <= 1, onSelect: () => void actions.deleteLevel(id) },
    ]
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border bg-panel px-1.5">
      <Layers size={13} className="mr-1 shrink-0 text-muted" />
      {order.map((id) => {
        const lv = levels[id]
        if (!lv) return null
        const isActive = id === active
        return (
          <button
            key={id}
            type="button"
            onClick={() => uiStore.getState().set({ activeLevelId: id, selection: [] })}
            onDoubleClick={() => void actions.renameLevel(id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ at: { x: e.clientX, y: e.clientY }, id })
            }}
            title={`${lv.name} · ${t('отметка')} ${(lv.elevation / 1000).toFixed(2)} ${t('м')}`}
            className={clsx(
              'inline-flex h-5.5 shrink-0 items-center gap-1 rounded px-2.5 text-[11px] transition-colors',
              isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-hover hover:text-text',
              !lv.visible && 'italic opacity-60',
            )}
          >
            {lv.name}
          </button>
        )
      })}
      <IconBtn icon={Plus} size="sm" label={t('Добавить этаж')} tipSide="top" onClick={() => actions.addLevel()} />
      <ContextMenu at={menu?.at ?? null} items={menu ? menuItems(menu.id) : []} onClose={close} />
      <VariantTabs />
    </div>
  )
}
