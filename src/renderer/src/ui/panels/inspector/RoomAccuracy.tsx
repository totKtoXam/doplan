/**
 * Room inspector: honest area report (computed vs the area printed on the source plan, with the
 * uncertainty from dimension provenance) and the «Обмер» status of the room.
 */
import { roomAreaReport, roomEdgeRuns, roomMeasureStatus, runProvenance, sourceAreaChecks } from '@core'
import type { DerivedPlan, DerivedRoom, Id } from '@core/types'
import { ClipboardCheck } from 'lucide-react'
import { t as tt, useT } from '@/i18n'
import '@/ui/accuracyI18n'
import { accuracyStore } from '@/store/accuracy'
import { useDoc } from '@/store/document'
import { Button, NumberInput, Row, fmtNum } from '@/ui/kit'
import { activateTool } from '@/ui/shell/tools'
import { tx } from '../common/catalog'
import { Hint, Stat } from './shared'

const LEVEL_CLASS = { ok: 'text-success', warn: 'text-warning', bad: 'text-danger' } as const

export function RoomAccuracy({ id, dr }: { id: Id; dr: DerivedRoom }) {
  const t = useT()
  const doc = useDoc((s) => s.doc)
  const room = doc.rooms[id]
  const plan = useDoc((s) => (room ? (s.derived as Record<Id, DerivedPlan>)[room.levelId] : undefined))
  if (!room) return null
  const rep = roomAreaReport(doc, dr)
  const status = roomMeasureStatus(doc, dr)
  const checks = plan ? sourceAreaChecks(doc, plan).filter((c) => c.contradiction) : []
  const sign = (v: number) => (v >= 0 ? '+' : '−')

  const startSurvey = () => {
    const run = roomEdgeRuns(dr).find((r) => runProvenance(doc, r).source !== 'measured') ?? roomEdgeRuns(dr)[0]
    activateTool('survey', tt)
    if (run) accuracyStore.getState().setTarget({ key: run.key, roomId: id })
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Row label={t('Площадь на плане')}>
        <NumberInput
          kind="number"
          value={room.labelledArea ?? null}
          min={0}
          step={0.1}
          decimals={2}
          suffix="м²"
          placeholder="—"
          onChange={(v, g) =>
            tx(
              'Площадь на плане',
              (d) => {
                const r = d.rooms[id]
                if (!r) return
                if (v > 0) r.labelledArea = Math.round(v * 100) / 100
                else delete r.labelledArea
              },
              `room.${id}.labelled.${g}`,
            )
          }
        />
      </Row>
      {rep.labelled !== undefined && rep.delta !== undefined && rep.pct !== undefined && (
        <div className="flex flex-col gap-0.5 rounded-md bg-[var(--bg)] p-2">
          <Stat label={t('Расчёт по стенам')} value={`${fmtNum(rep.computed, 2)} м²`} />
          <Stat label={t('Подписано на плане')} value={`${fmtNum(rep.labelled, 2)} м²`} />
          <Stat
            label={t('Расхождение')}
            value={
              <span className={rep.level ? LEVEL_CLASS[rep.level] : undefined}>
                {sign(rep.delta)}
                {fmtNum(Math.abs(rep.delta), 2)} м² ({sign(rep.pct)}
                {fmtNum(Math.abs(rep.pct), 1)} %)
              </span>
            }
          />
          {rep.uncertainty !== undefined && <Stat label={t('Погрешность размеров')} value={`±${fmtNum(rep.uncertainty, 2)} м²`} />}
        </div>
      )}
      {rep.contradiction && (
        <Hint>
          <span className="text-warning">
            {t(
              'Размеры этой комнаты взяты с плана, но подписанная площадь с ними не сходится сильнее, чем позволяет их точность. Ошибка в самом плане (или площадь посчитана до отделки) — проверьте стены рулеткой.',
            )}
          </span>
        </Hint>
      )}
      {!rep.contradiction && rep.withinTolerance === false && (
        <Hint>{t('Расхождение больше погрешности размеров: какие-то размеры неточны. Замерьте стены рулеткой («Обмер»).')}</Hint>
      )}
      {rep.withinTolerance === true && rep.delta !== undefined && Math.abs(rep.delta) >= 0.05 && (
        <Hint>{t('Расхождение в пределах точности размеров. Чтобы его убрать, замерьте стены рулеткой.')}</Hint>
      )}
      {checks.map((c) => (
        <Hint key={c.kind}>
          <span className="text-warning">
            {c.kind === 'total' ? t('Общая площадь на плане') : t('Жилая площадь на плане')}: {fmtNum(c.labelled, 2)} м², {t('сумма подписанных комнат')}{' '}
            {fmtNum(c.sum, 2)} м² — {t('подписи плана противоречат друг другу')}.
          </span>
        </Hint>
      ))}
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] ${status.full ? 'text-success' : 'text-[var(--muted)]'}`}>
          {status.full ? `✓ ${t('замерено полностью')}` : `${t('Замерено размеров')}: ${status.measured} / ${status.runs}`}
        </span>
        <Button size="sm" onClick={startSurvey}>
          <ClipboardCheck size={13} />
          {t('Обмер')}
        </Button>
      </div>
    </div>
  )
}
