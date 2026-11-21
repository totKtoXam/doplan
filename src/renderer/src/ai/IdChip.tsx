/**
 * An internal id the agent let slip into its text (it is told not to): shown as the object's name —
 * «Стена 3425 мм (Кухня / Прихожая)» — that selects it on the plan when clicked. An id of an object no
 * longer in the document reads «(удалённый объект)».
 */
import { type ReactNode, useMemo } from 'react'
import { t } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { marksStore } from '@/store/marks'
import { uiStore, useUi } from '@/store/ui'
import { type NameCtx, nameIds, nameOfId, splitIds } from './names'
import { entityLevel, lookupFor } from './summary'
import './i18n'

/** names of the live document, kept current */
function useNames(): NameCtx {
  const doc = useDoc((s) => s.doc)
  const derived = useDoc((s) => s.derived)
  const catalog = useUi((s) => s.catalog)
  const lang = useUi((s) => s.lang)
  return useMemo(() => ({ doc, plan: (lv) => derived[lv], lk: lookupFor(doc, catalog), lang }), [doc, derived, catalog, lang])
}

type Hit = NonNullable<ReturnType<typeof nameOfId>>

/** selects what the chip names on the plan (its level becomes the active one) */
export function showOnPlan(hit: Hit): void {
  const ui = uiStore.getState()
  const doc = docStore.getState().doc
  if (hit.ref) {
    const lv = entityLevel(doc, hit.ref)
    ui.set({ selection: [hit.ref], ...(lv && doc.levels[lv] ? { activeLevelId: lv } : {}) })
  } else if (hit.mark) {
    const m = doc.annotations?.[hit.mark]
    if (m && doc.levels[m.levelId]) ui.set({ activeLevelId: m.levelId })
    marksStore.getState().select(hit.mark)
  } else if (hit.levelId) ui.set({ activeLevelId: hit.levelId })
}

export function IdChip({ id }: { id: string }) {
  const names = useNames()
  const hit = useMemo(() => nameOfId(names, id), [names, id])
  if (!hit) return <span className="text-faint">{t('(удалённый объект)')}</span>
  // a material or a catalog asset: nothing on the plan to point at
  if (!hit.ref && !hit.mark && !hit.levelId) return <span>{hit.name}</span>
  const ref = hit.ref
  return (
    <button
      type="button"
      data-ai-id={id}
      title={t('Показать на плане')}
      className="mx-px inline rounded-md border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-accent-soft px-1 py-px align-baseline text-[11.5px] leading-tight text-text hover:border-accent"
      onClick={() => showOnPlan(hit)}
      onMouseEnter={() => ref && uiStore.getState().set({ hover: ref })}
      onMouseLeave={() => ref && uiStore.getState().hover?.id === ref.id && uiStore.getState().set({ hover: null })}
    >
      {hit.name}
    </button>
  )
}

/** plain text with id chips in place of the ids it carries */
export function withIdChips(text: string, key = 0): ReactNode[] {
  return splitIds(text).map((p, i) => (typeof p === 'string' ? p : <IdChip key={`${key}.${i}`} id={p.id} />))
}

/** text where a chip cannot go (inside a button): ids become names */
export function Named({ text }: { text: string }) {
  const names = useNames()
  return <>{useMemo(() => nameIds(names, text), [names, text])}</>
}
