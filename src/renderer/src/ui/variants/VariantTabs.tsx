import clsx from 'clsx'
import { ArrowLeftRight, Columns2, Copy, Pencil, Plus, Sofa, SquareDashed, Trash, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listVariants, strayEntities } from '@core'
import type { Doc, Id } from '@core/types'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { toast } from '@/store/notify'
import { useUi } from '@/store/ui'
import { ContextMenu, IconBtn, type MenuEntry } from '@/ui/shell/primitives'
import './i18n'

/** approximate menu row height, to open menus upwards from the bottom bar */
const MENU_ROW = 28

/**
 * Furnishing-variant tabs (right part of the level bar): click switches, double-click renames,
 * right-click for more; ⚠ marks furniture left outside the rooms (click selects it).
 * Also raises a toast when a wall edit leaves furniture of any variant outside the rooms.
 */
export function VariantTabs() {
  const t = useT()
  const variantsRec = useDoc((s) => s.doc.variants)
  const items = useDoc((s) => s.doc.items)
  const lights = useDoc((s) => s.doc.lights)
  const derived = useDoc((s) => s.derived)
  const loadId = useDoc((s) => s.loadId)
  const doc = useDoc((s) => s.doc)
  const catalog = useUi((s) => s.catalog)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuEntry[] } | null>(null)
  const close = useCallback(() => setMenu(null), [])

  const variants = useMemo(() => listVariants({ variants: variantsRec } as Doc), [variantsRec])

  const transient = useDoc((s) => s.transientActive)
  const lastStray = useRef<Map<Id, number> | null>(null)
  // furniture outside the rooms, per variant (depends on the shared geometry and each variant's furniture);
  // a drag keeps the last counts (the toast below waits for the commit too), so no frame of it pays
  const stray = useMemo(() => {
    if (transient && lastStray.current) return lastStray.current
    const out = new Map<Id, number>()
    for (const v of variants) {
      try {
        out.set(v.id, strayEntities(doc, derived, v.id, catalog).length)
      } catch {
        out.set(v.id, 0)
      }
    }
    lastStray.current = out
    return out
    // `doc` changes on every edit; the result only depends on these
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, items, lights, derived, catalog, transient])

  // a geometry edit (the derived plan changed) that pushed furniture out of the rooms: say so.
  // Drag previews (transient) are skipped and compared against the last committed state, so one
  // gesture gives at most one toast; variants that just appeared (copy, undo of a delete) are not "grown".
  const prev = useRef<{ loadId: number; derived: unknown; counts: Map<Id, number> } | null>(null)
  useEffect(() => {
    if (transient) return
    const p = prev.current
    prev.current = { loadId, derived, counts: stray }
    if (!p || p.loadId !== loadId || p.derived === derived) return
    const grown = variants.filter((v) => p.counts.has(v.id) && (stray.get(v.id) ?? 0) > (p.counts.get(v.id) ?? 0))
    if (!grown.length) return
    const list = grown.map((v) => `${t(v.name)} — ${stray.get(v.id)}`).join(', ')
    toast(t('После правки стен вне помещений оказались предметы: {list}', { list }), 'warning', 8000, {
      label: t('Показать'),
      run: () => actions.selectStray(grown[0].id),
    })
  }, [stray, derived, loadId, variants, transient, t])

  const upMenu = (el: HTMLElement, entries: MenuEntry[]) => {
    const r = el.getBoundingClientRect()
    const rows = entries.filter((e) => e.type !== 'separator').length
    const seps = entries.length - rows
    const h = rows * MENU_ROW + seps * 9 + 10
    setMenu({ at: { x: Math.min(r.left, window.innerWidth - 240), y: Math.max(8, r.top - h - 4) }, items: entries })
  }

  const tabMenu = (id: Id): MenuEntry[] => {
    const idx = variants.findIndex((v) => v.id === id)
    const n = stray.get(id) ?? 0
    return [
      { label: t('Переименовать'), icon: Pencil, onSelect: () => void actions.renameVariant(id) },
      {
        label: t('Дублировать вариант'),
        icon: Copy,
        onSelect: () => void actions.createVariant('copy', id),
      },
      { label: t('Выделить предметы вне помещений'), icon: TriangleAlert, disabled: n === 0, onSelect: () => actions.selectStray(id) },
      { type: 'separator' },
      { label: t('Сдвинуть влево'), icon: ArrowLeftRight, disabled: idx <= 0, onSelect: () => actions.moveVariant(id, -1) },
      { label: t('Сдвинуть вправо'), disabled: idx >= variants.length - 1, onSelect: () => actions.moveVariant(id, 1) },
      { type: 'separator' },
      { label: t('Удалить вариант'), icon: Trash, danger: true, disabled: variants.length <= 1, onSelect: () => void actions.deleteVariant(id) },
    ]
  }

  const addMenu: MenuEntry[] = [
    { type: 'header', label: t('Новый вариант') },
    { label: t('Копия текущего'), icon: Copy, onSelect: () => void actions.createVariant('copy') },
    { label: t('Пустой (без мебели и света)'), icon: SquareDashed, onSelect: () => void actions.createVariant('empty') },
  ]

  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5"
      title={t('Варианты обстановки: мебель, свет, отделка и стиль. Стены, проёмы и помещения общие.')}
    >
      <Sofa size={13} className="mr-1 shrink-0 text-muted" aria-hidden />
      <div role="tablist" aria-label={t('Варианты обстановки')} className="flex items-center gap-0.5">
        {variants.map((v) => {
          const n = stray.get(v.id) ?? 0
          return (
            <div
              key={v.id}
              role="tab"
              tabIndex={0}
              aria-selected={v.active}
              onClick={() => actions.switchVariant(v.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  actions.switchVariant(v.id)
                }
              }}
              onDoubleClick={() => void actions.renameVariant(v.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                upMenu(e.currentTarget, tabMenu(v.id))
              }}
              title={`${t(v.name)} · Ctrl+PgUp / Ctrl+PgDn`}
              className={clsx(
                'inline-flex h-5.5 max-w-[220px] shrink-0 cursor-pointer items-center gap-1 rounded px-2.5 text-[11px] transition-colors select-none',
                v.active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              <span className="truncate">{t(v.name)}</span>
              {n > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 rounded px-0.5 text-[10px] text-warning hover:bg-hover"
                  title={t('{n} вне помещений — показать', { n })}
                  aria-label={t('Вне помещений: {n}', { n })}
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.selectStray(v.id)
                  }}
                >
                  <TriangleAlert size={11} />
                  {n}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <IconBtn
        icon={Plus}
        size="sm"
        label={`${t('Новый вариант')} · ${t('Отделка копируется из текущего варианта')}`}
        tipSide="top"
        onClick={(e) => upMenu(e.currentTarget, addMenu)}
      />
      <IconBtn
        icon={Columns2}
        size="sm"
        label={t('Сравнить варианты')}
        tipSide="top"
        disabled={variants.length < 2}
        onClick={() => actions.openVariantCompare()}
      />
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={close} />
    </div>
  )
}
