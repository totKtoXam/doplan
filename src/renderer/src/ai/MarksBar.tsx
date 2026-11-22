/**
 * The plan marks of the level, in the chat box while «Пометить» is on: each one is in the message
 * (click the tick to take it out) or not yet (add it), and can be deleted; «Все в чат», «Очистить»,
 * Esc ends marking. Marks that went to the agent are not listed: the plan lets them go when its turn ends.
 */
import { markBadge } from '@core'
import { Check, Eraser, MessageSquarePlus, Trash2, X } from 'lucide-react'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { clearMarks, deleteMark, marksStore, useMarks } from '@/store/marks'
import { useUi } from '@/store/ui'
import { cn } from '@/ui/kit'
import { activateTool } from '@/ui/shell/tools'
import { addMarkToChat, removeMarksFromChat, useAi } from './store'
import './i18n'

const iconBtn = 'rounded p-0.5 text-muted hover:bg-hover'

export function MarksBar() {
  const t = useT()
  const on = useUi((s) => s.tool === 'pencil')
  const levelId = useUi((s) => s.activeLevelId)
  const all = useDoc((s) => s.doc.annotations)
  const chips = useAi((s) => s.chips)
  const sending = useAi((s) => s.running?.marks)
  const selected = useMarks((s) => s.selected)
  if (!on) return null
  const marks = Object.values(all ?? {})
    .filter((m) => m.levelId === levelId && !sending?.includes(m.id))
    .sort((a, b) => a.n - b.n)
  const inMsg = new Set(chips.filter((c) => c.kind === 'annotation').map((c) => c.id))
  const out = marks.filter((m) => !inMsg.has(m.id))

  return (
    <div data-ai-marks className="flex flex-wrap items-center gap-1 px-2.5 pt-2 text-[11px]">
      <span className="text-faint">{t('Пометки')}</span>
      {marks.map((m) => {
        const has = inMsg.has(m.id)
        return (
          <span
            key={m.id}
            data-mark={m.n}
            className={cn(
              'flex h-6 items-center rounded-md border pr-0.5',
              has ? 'border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-accent-soft' : 'border-dashed border-border-strong',
              m.id === selected && 'ring-1 ring-accent',
            )}
          >
            <button type="button" title={t('Показать на плане')} className="flex items-center gap-1 rounded-l-md py-0.5 pr-0.5 pl-1.5" onClick={() => marksStore.getState().select(m.id)}>
              <span className={cn('text-[12.5px] leading-none', m.done ? 'text-success' : 'text-danger')}>{markBadge(m.n)}</span>
              <span className="text-muted">{m.shape === 'zone' ? t('зона') : t('линия')}</span>
              {m.done && <span className="text-success">{t('внесено')}</span>}
            </button>
            {has ? (
              <button type="button" title={t('В сообщении — убрать из него')} aria-label={t('Убрать из сообщения')} className={cn(iconBtn, 'text-accent hover:text-text')} onClick={() => removeMarksFromChat([m.id])}>
                <Check size={12} />
              </button>
            ) : (
              <button type="button" title={t('Добавить в чат (Ctrl+L)')} aria-label={t('Добавить в чат')} className={cn(iconBtn, 'hover:text-accent')} onClick={() => void addMarkToChat(m.id)}>
                <MessageSquarePlus size={12} />
              </button>
            )}
            <button type="button" title={t('Удалить пометку')} aria-label={t('Удалить пометку')} className={cn(iconBtn, 'hover:text-danger')} onClick={() => deleteMark(m.id)}>
              <Trash2 size={11} />
            </button>
          </span>
        )
      })}
      {!marks.length && <span className="min-w-0 flex-1 truncate text-left text-faint" title={t('Обведите место на плане — пометка с номером попадёт в сообщение')}>{t('Обведите место на плане — пометка с номером попадёт в сообщение')}</span>}
      <span className="ml-auto flex items-center gap-0.5">
        {out.length > 0 && (
          <button type="button" className="rounded-md px-1.5 py-0.5 text-accent hover:bg-hover" onClick={() => out.forEach((m) => void addMarkToChat(m.id))}>
            {t('Все в чат')}
          </button>
        )}
        {marks.length > 0 && (
          <button type="button" title={t('Очистить пометки')} aria-label={t('Очистить пометки')} className={cn(iconBtn, 'p-1 hover:text-danger')} onClick={() => clearMarks(levelId)}>
            <Eraser size={12} />
          </button>
        )}
        <button type="button" title={t('Закончить пометки (Esc)')} className="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-muted hover:bg-hover hover:text-text" onClick={() => activateTool('select', t)}>
          <X size={11} />
          <span className="text-[10px]">Esc</span>
        </button>
      </span>
    </div>
  )
}
