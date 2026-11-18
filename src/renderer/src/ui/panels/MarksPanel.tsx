/**
 * «Пометки» (top-left of the 2D view while marking): the marks of the level with «В чат» and delete,
 * «Очистить пометки». Marking itself starts from the «Пометить» button in the chat input row (or P);
 * the shape (Линия / Лассо / Рамка) is picked there too.
 */
import { markBadge } from '@core'
import { Check, MessageSquarePlus, Trash2, X } from 'lucide-react'
import '@/ai/i18n'
import { MARK_SHAPES } from '@/ai/MarkButton'
import { addMarkToChat } from '@/ai/store'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { clearMarks, deleteMark, marksStore, useMarks } from '@/store/marks'
import { useUi } from '@/store/ui'
import { cn } from '@/ui/kit'
import { activateTool } from '@/ui/shell/tools'

export function MarksPanel() {
  const tr = useT()
  const tool = useUi((s) => s.tool)
  const levelId = useUi((s) => s.activeLevelId)
  const all = useDoc((s) => s.doc.annotations)
  const shape = useMarks((s) => s.shape)
  const selected = useMarks((s) => s.selected)
  if (tool !== 'pencil') return null
  const marks = Object.values(all ?? {})
    .filter((m) => m.levelId === levelId)
    .sort((a, b) => a.n - b.n)
  const cur = MARK_SHAPES.find((s) => s.id === shape) ?? MARK_SHAPES[0]

  return (
    <div data-marks-panel className="absolute top-2 left-2 z-20 w-[230px] rounded-lg border border-border-strong bg-panel p-2 text-xs shadow-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center gap-1.5 px-0.5">
        <span className="font-semibold text-text">{tr('Пометки')}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[10.5px] text-muted" title={tr('Форма — у кнопки «Пометить» в чате')}>
          <cur.icon size={11} className="shrink-0" /> {tr(cur.label)}
        </span>
        <button type="button" title={tr('Закончить пометки (Esc)')} aria-label={tr('Закончить пометки (Esc)')} className="rounded p-0.5 text-muted hover:text-text" onClick={() => activateTool('select', tr)}>
          <X size={12} />
        </button>
      </div>
      {!marks.length ? (
        <div className="px-1 py-1 text-muted">{tr('Обведите место на плане: пометка получит номер, его можно упомянуть в чате — «в ① ширина 180 см».')}</div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          {marks.map((m) => (
            <div
              key={m.id}
              className={cn('group flex items-center gap-1 rounded-md px-1.5 py-0.5', m.id === selected ? 'bg-active' : 'hover:bg-hover')}
              onClick={() => marksStore.getState().select(m.id)}
            >
              <span className={cn('w-5 text-[13px]', m.done ? 'text-success' : 'text-danger')}>{markBadge(m.n)}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {m.shape === 'zone' ? tr('зона') : tr('линия')}
                {m.done && (
                  <span className="ml-1 text-success">
                    <Check size={11} className="inline" /> {tr('внесено')}
                  </span>
                )}
              </span>
              <button type="button" title={tr('Добавить в чат (Ctrl+L)')} className="rounded p-0.5 text-muted hover:text-accent" onClick={() => void addMarkToChat(m.id)}>
                <MessageSquarePlus size={13} />
              </button>
              <button type="button" title={tr('Удалить пометку')} className="rounded p-0.5 text-muted hover:text-danger" onClick={() => deleteMark(m.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {marks.length > 0 && (
        <div className="mt-1.5 flex gap-1 border-t border-border pt-1.5">
          <button type="button" className="flex-1 rounded-md bg-accent px-2 py-1 text-accent-fg hover:bg-accent-hover" onClick={() => marks.forEach((m) => void addMarkToChat(m.id))}>
            {tr('Все в чат')}
          </button>
          <button type="button" className="rounded-md border border-border px-2 py-1 text-muted hover:text-danger" onClick={() => clearMarks(levelId)}>
            {tr('Очистить пометки')}
          </button>
        </div>
      )}
    </div>
  )
}
