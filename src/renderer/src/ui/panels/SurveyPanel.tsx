/**
 * «Обмер» panels over the 2D viewport:
 *  - SurveyPanel: the dimension picked by the survey tool → measured length, which end moves,
 *    a dry-run preview (core/measure on a copy) and Apply;
 *  - MeasureChecklist: dimensions that are not measured yet, kitchen and bathroom first.
 */
import { applyMeasuredLength, DIM_SOURCE_NAMES, findRun, type MeasureResult, ROOM_TYPE_NAMES, runProvenance, setRunSource, unmeasuredChecklist } from '@core'
import type { DerivedPlan, Doc, Id } from '@core/types'
import { Check, ListChecks, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { t, useT } from '@/i18n'
import '@/ui/accuracyI18n'
import { accuracyStore, useAccuracy } from '@/store/accuracy'
import { docStore, useDoc } from '@/store/document'
import { toast } from '@/store/notify'
import { uiStore, useUi } from '@/store/ui'
import { activateTool } from '@/ui/shell/ToolRail'
import { TextBtn } from '@/ui/shell/primitives'

function parseMm(s: string): number | null {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(мм|mm|см|cm|м|m)?\s*$/i.exec(s)
  if (!m) return null
  const v = Number.parseFloat(m[1].replace(',', '.'))
  const u = (m[2] ?? 'мм').toLowerCase()
  return u === 'см' || u === 'cm' ? v * 10 : u === 'м' || u === 'm' ? v * 1000 : v
}

/** "левый / правый", "верхний / нижний" end of a run by its direction on screen (y down) */
function endNames(u: { x: number; y: number }): { a: string; b: string } {
  if (Math.abs(u.x) >= Math.abs(u.y)) return u.x > 0 ? { a: 'левый', b: 'правый' } : { a: 'правый', b: 'левый' }
  return u.y > 0 ? { a: 'верхний', b: 'нижний' } : { a: 'нижний', b: 'верхний' }
}

function roomName(doc: Doc, roomId: Id): string {
  const r = doc.rooms[roomId]
  return r ? r.name || ROOM_TYPE_NAMES[r.type].ru : ''
}

function usePlan(): { doc: Doc; plan: DerivedPlan | undefined; levelId: Id } {
  const doc = useDoc((s) => s.doc)
  const levelId = useUi((s) => s.activeLevelId)
  const plan = useDoc((s) => (s.derived as Record<Id, DerivedPlan>)[levelId])
  return { doc, plan, levelId }
}

export function SurveyPanel() {
  const tr = useT()
  const tool = useUi((s) => s.tool)
  const target = useAccuracy((s) => s.target)
  const moveEnd = useAccuracy((s) => s.moveEnd)
  const { doc, plan, levelId } = usePlan()
  const [value, setValue] = useState('')
  const [tol, setTol] = useState('2')
  const run = target && plan ? findRun(plan, target.key) : null
  const mm = parseMm(value)

  const preview: MeasureResult | null = useMemo(() => {
    if (!run || mm === null || !target) return null
    const copy = structuredClone(doc)
    return applyMeasuredLength(copy, levelId, target.key, mm, moveEnd)
  }, [doc, levelId, target, run, mm, moveEnd])

  if (tool !== 'survey' || !target || !run) return null
  const prov = runProvenance(doc, run)
  const names = endNames(run.u)
  const fmt = (v: number) => `${Math.round(v)} ${tr('мм')}`
  const tolMm = parseMm(tol) ?? 2

  const apply = () => {
    if (mm === null) return
    let res: MeasureResult | null = null
    docStore.getState().transact(t('Обмер'), (d: Doc) => {
      res = applyMeasuredLength(d, levelId, target.key, mm, moveEnd, { tol: tolMm })
    })
    const r = res as MeasureResult | null
    if (!r) return
    if (!r.ok) {
      toast(r.error ?? t('Не удалось применить обмер'), 'error', 6000)
      return
    }
    const sign = r.delta >= 0 ? '+' : '−'
    toast(`${t('Замерено')}: ${fmt(mm)} (${sign}${Math.abs(Math.round(r.delta))} ${t('мм')})`, 'success')
    if (r.conflicts.length)
      toast(`${t('Изменились ранее замеренные размеры')}: ${r.conflicts.map((c) => `${c.roomName} ${fmt(c.before)} → ${fmt(c.after)}`).join('; ')}`, 'warning', 9000)
    setValue('')
    accuracyStore.getState().setTarget(null)
  }

  const confirmAsDrawn = () => {
    docStore.getState().transact(t('Обмер'), (d: Doc) => {
      setRunSource(d, levelId, target.key, 'measured', { tol: tolMm })
    })
    accuracyStore.getState().setTarget(null)
  }

  return (
    <div
      className="absolute top-2 right-2 z-20 w-[300px] rounded-lg border border-border-strong bg-panel p-3 text-xs shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="font-semibold">
          {tr('Обмер')}: {roomName(doc, target.roomId)}
        </div>
        <button type="button" className="text-muted hover:text-text" onClick={() => accuracyStore.getState().setTarget(null)} aria-label={tr('Закрыть')}>
          <X size={14} />
        </button>
      </div>
      <div className="mb-2 text-muted">
        {tr('Сейчас')}: {fmt(run.length)} · {tr(DIM_SOURCE_NAMES[prov.source].ru)}
        {prov.stale ? ` (${tr('стену сдвинули')})` : prov.tol !== undefined ? ` ±${prov.tol} ${tr('мм')}` : ''}
        {prov.date ? ` · ${prov.date}` : ''}
      </div>
      <label className="mb-1 block text-muted">{tr('Длина по рулетке (в свету), мм')}</label>
      <input
        autoFocus
        value={value}
        placeholder={String(Math.round(run.length))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && preview?.ok) apply()
          if (e.key === 'Escape') accuracyStore.getState().setTarget(null)
        }}
        className="mb-2 h-8 w-full rounded-md border border-border bg-input px-2.5 text-sm text-text outline-none focus:border-accent"
      />
      <div className="mb-1 text-muted">{tr('Какой конец сдвинуть')}</div>
      <div className="mb-2 flex gap-1">
        {(['a', 'b'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => accuracyStore.getState().setMoveEnd(e)}
            className={`flex-1 rounded-md border px-2 py-1 ${moveEnd === e ? 'border-accent bg-accent/15 text-text' : 'border-border text-muted hover:text-text'}`}
          >
            {tr(e === 'a' ? names.a : names.b)}
          </button>
        ))}
      </div>
      <div className="mb-2 flex items-center gap-2 text-muted">
        <span>{tr('Точность ±')}</span>
        <input
          value={tol}
          onChange={(e) => setTol(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-6 w-14 rounded border border-border bg-input px-1.5 text-text outline-none focus:border-accent"
        />
        <span>{tr('мм')}</span>
      </div>
      {preview && (
        <div className={`mb-2 rounded-md px-2 py-1.5 ${preview.ok ? 'bg-input text-text' : 'bg-danger/15 text-danger'}`}>
          {preview.ok ? (
            <>
              {tr('Сдвиг')}: {preview.delta >= 0 ? '+' : '−'}
              {Math.abs(Math.round(preview.delta))} {tr('мм')} · {tr('узлов')}: {preview.moved.length}
              {preview.conflicts.length > 0 && (
                <div className="mt-1 text-warning">
                  {tr('Изменятся замеренные размеры')}: {preview.conflicts.map((c) => `${c.roomName} ${fmt(c.before)} → ${fmt(c.after)}`).join('; ')}
                </div>
              )}
            </>
          ) : (
            preview.error
          )}
        </div>
      )}
      <div className="flex justify-between gap-2">
        <TextBtn onClick={confirmAsDrawn} title={tr('Рулетка показала столько же, сколько на плане')}>
          <Check size={13} />
          {tr('Совпадает')}
        </TextBtn>
        <TextBtn variant="primary" disabled={!preview?.ok} onClick={apply}>
          {tr('Применить')}
        </TextBtn>
      </div>
      <div className="mt-2 text-[11px] text-muted">{tr('Tab — сменить конец · Esc — отмена')}</div>
    </div>
  )
}

export function MeasureChecklist() {
  const tr = useT()
  const open = useAccuracy((s) => s.checklist)
  const target = useAccuracy((s) => s.target)
  const { doc, plan } = usePlan()
  const entries = useMemo(() => (open && plan ? unmeasuredChecklist(doc, plan) : []), [open, doc, plan])
  if (!open) return null
  return (
    <div
      className="absolute top-2 left-2 z-20 flex max-h-[60%] w-[260px] flex-col rounded-lg border border-border-strong bg-panel text-xs shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 font-semibold">
          <ListChecks size={14} />
          {tr('Не замерено')}: {entries.length}
        </div>
        <button type="button" className="text-muted hover:text-text" onClick={() => accuracyStore.getState().setChecklist(false)} aria-label={tr('Закрыть')}>
          <X size={14} />
        </button>
      </div>
      <div className="overflow-auto py-1">
        {entries.length === 0 && <div className="px-3 py-2 text-muted">{tr('Все размеры замерены')}</div>}
        {entries.map((e, i) => {
          const first = i === 0 || entries[i - 1].roomId !== e.roomId
          return (
            <div key={`${e.roomId}:${e.run.key}`}>
              {first && <div className="px-3 pt-2 pb-0.5 font-medium text-text">{e.roomName}</div>}
              <button
                type="button"
                className={`flex w-full justify-between px-3 py-0.5 text-left hover:bg-input ${target?.key === e.run.key ? 'text-accent' : 'text-muted'}`}
                onClick={() => {
                  if (uiStore.getState().tool !== 'survey') activateTool('survey', t)
                  accuracyStore.getState().setTarget({ key: e.run.key, roomId: e.roomId })
                }}
              >
                <span>
                  {Math.round(e.run.length)} {tr('мм')}
                </span>
                <span className={e.prov.source === 'estimated' ? 'italic' : ''}>{tr(DIM_SOURCE_NAMES[e.prov.source].ru)}</span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
