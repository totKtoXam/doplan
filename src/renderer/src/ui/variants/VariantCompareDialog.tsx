import clsx from 'clsx'
import { Check, FileDown, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  bomTotals,
  buildDisplayList,
  computeBom,
  findStyle,
  formatMoney,
  listVariants,
  materializeVariant,
  mergeCatalog,
  strayEntities,
  toSvg,
  variantCollection,
  type VariantInfo,
} from '@core'
import type { Catalog, DerivedPlan, Doc, Id, Item } from '@core/types'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { Button, Dialog, Select } from '@/ui/kit'
import { builtins } from '@/ui/panels/common/catalog'
import { DropdownMenu, type MenuEntry } from '@/ui/shell/primitives'
import './i18n'

interface Card {
  v: VariantInfo
  svg: string
  items: number
  lights: number
  total: number | null
  stray: number
  style?: string
  onlyHere: number
  moved: number
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** items of `mine` that the reference variant does not have / has elsewhere (same id = same piece) */
function diff(mine: Record<Id, Item>, ref: Record<Id, Item>): { onlyHere: number; moved: number } {
  let onlyHere = 0
  let moved = 0
  for (const it of Object.values(mine)) {
    const o = ref[it.id]
    if (!o || o.assetId !== it.assetId) onlyHere++
    else if (Math.hypot(o.x - it.x, o.y - it.y) > 1 || Math.abs(o.rotation - it.rotation) > 0.1 || o.size.w !== it.size.w || o.size.d !== it.size.d) moved++
  }
  return { onlyHere, moved }
}

function buildCards(doc: Doc, derived: Record<Id, DerivedPlan>, levelId: Id, cat: Catalog, lang: 'ru' | 'en'): Card[] {
  const list = listVariants(doc)
  const active = list.find((v) => v.active)!
  const refItems = variantCollection(doc, active.id, 'items', cat)
  return list.map((v) => {
    const view = materializeVariant(doc, v.id, cat)
    const dl = buildDisplayList(view, levelId, {
      dimensions: false,
      areas: false,
      furniture: true,
      labels: true,
      grid: false,
      titleBlock: false,
      theme: 'light',
      lang,
      derived: derived[levelId],
    })
    const { svg } = toSvg(dl, { scale: 100, marginMm: 5 })
    let total: number | null = null
    try {
      const totals = bomTotals(computeBom(view, cat))
      total = totals.priced ? totals.total : null
    } catch {
      total = null
    }
    const items = variantCollection(doc, v.id, 'items', cat)
    const styleId = view.design?.styleId
    const style = styleId ? findStyle(styleId) : undefined
    return {
      v,
      svg: svgUrl(svg),
      items: Object.keys(items).length,
      lights: Object.keys(variantCollection(doc, v.id, 'lights', cat)).length,
      total,
      stray: strayEntities(doc, derived, v.id, cat).length,
      style: style ? (lang === 'en' ? style.name : style.nameRu) : undefined,
      ...(v.active ? { onlyHere: 0, moved: 0 } : diff(items, refItems)),
    }
  })
}

/** Furnishing variants side by side: plans of one level, item / light counts, estimate totals. */
export function VariantCompareDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const doc = useDoc((s) => s.doc)
  const derived = useDoc((s) => s.derived)
  const catalog = useUi((s) => s.catalog)
  const activeLevelId = useUi((s) => s.activeLevelId)
  const [levelPick, setLevelPick] = useState<Id | null>(null)
  const levelId = levelPick && doc.levels[levelPick] ? levelPick : doc.levels[activeLevelId] ? activeLevelId : doc.levelOrder[0]
  const locale = lang === 'en' ? 'en-US' : 'ru-RU'

  const cards = useMemo(() => {
    if (!open) return []
    const cat = mergeCatalog(builtins(), catalog)
    return buildCards(doc, derived, levelId, cat, lang === 'en' ? 'en' : 'ru')
  }, [open, doc, derived, levelId, catalog, lang])

  const cols = cards.length <= 2 ? 'grid-cols-2' : cards.length === 3 ? 'grid-cols-3' : 'grid-cols-2 xl:grid-cols-3'

  const exportMenu = (id: Id): MenuEntry[] => [
    { type: 'header', label: t('Экспорт плана') },
    { label: 'PNG', onSelect: () => void actions.exportPlan('png', id) },
    { label: 'SVG', onSelect: () => void actions.exportPlan('svg', id) },
    { label: 'PDF', onSelect: () => void actions.exportPlan('pdf', id) },
    { label: 'DXF (AutoCAD)', onSelect: () => void actions.exportPlan('dxf', id) },
  ]

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Сравнить варианты')}
      width="max-w-6xl"
      footer={
        <>
          <span className="mr-auto text-[10px] text-[var(--muted)]">{t('Планы активного этажа; предметы и стоимость — по смете каждого варианта.')}</span>
          <Button variant="ghost" onClick={onClose}>
            {t('Закрыть')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {doc.levelOrder.length > 1 && (
          <label className="flex items-center gap-1.5 self-start text-[11px] text-[var(--muted)]">
            {t('Этаж')}
            <Select
              value={levelId}
              options={doc.levelOrder.map((id) => ({ value: id, label: doc.levels[id]?.name ?? id }))}
              onChange={setLevelPick}
              aria-label={t('Этаж')}
              className="w-40"
            />
          </label>
        )}
        <div className={clsx('grid gap-3', cols)}>
          {cards.map((c) => (
            <section
              key={c.v.id}
              aria-label={t(c.v.name)}
              className={clsx('flex min-w-0 flex-col overflow-hidden rounded-lg border', c.v.active ? 'border-[var(--accent)]' : 'border-[var(--border)]')}
            >
              <header className="flex items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5">
                <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={t(c.v.name)}>
                  {t(c.v.name)}
                </h3>
                {c.v.active ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)]">
                    <Check className="size-3" />
                    {t('Активный')}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      actions.switchVariant(c.v.id)
                      onClose()
                    }}
                  >
                    {t('Открыть')}
                  </Button>
                )}
                <DropdownMenu
                  align="right"
                  items={exportMenu(c.v.id)}
                  trigger={({ toggle }) => (
                    <Button variant="ghost" icon={<FileDown className="size-3.5" />} onClick={toggle} aria-label={t('Экспорт плана')} title={t('Экспорт плана')} />
                  )}
                />
              </header>
              <div className="flex aspect-[4/3] items-center justify-center bg-white p-2">
                <img src={c.svg} alt={t(c.v.name)} className="max-h-full max-w-full object-contain" draggable={false} />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-[var(--border)] px-2.5 py-2 text-[11px]">
                <dt className="text-[var(--muted)]">{t('Предметов')}</dt>
                <dd className="tabular-nums">{c.items}</dd>
                <dt className="text-[var(--muted)]">{t('Светильников')}</dt>
                <dd className="tabular-nums">{c.lights}</dd>
                <dt className="text-[var(--muted)]">{t('Стоимость по смете')}</dt>
                <dd className="tabular-nums">{c.total !== null ? formatMoney(c.total, doc.design?.currency, locale) : <span className="text-[var(--muted)]">{t('нет цен')}</span>}</dd>
                {c.style && (
                  <>
                    <dt className="text-[var(--muted)]">{t('Стиль')}</dt>
                    <dd className="truncate">{c.style}</dd>
                  </>
                )}
                {!c.v.active && (c.onlyHere > 0 || c.moved > 0) && (
                  <>
                    <dt className="text-[var(--muted)]">{t('Отличия')}</dt>
                    <dd>
                      {[c.onlyHere ? t('только здесь: {n}', { n: c.onlyHere }) : '', c.moved ? t('переставлено: {n}', { n: c.moved }) : ''].filter(Boolean).join(', ')}
                    </dd>
                  </>
                )}
                {c.stray > 0 && (
                  <>
                    <dt className="text-warning">
                      <TriangleAlert className="inline size-3" />
                    </dt>
                    <dd>
                      <button
                        type="button"
                        className="text-warning underline-offset-2 hover:underline"
                        onClick={() => {
                          actions.selectStray(c.v.id)
                          onClose()
                        }}
                      >
                        {t('Вне помещений: {n}', { n: c.stray })}
                      </button>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
