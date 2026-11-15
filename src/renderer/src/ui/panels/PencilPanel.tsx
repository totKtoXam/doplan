/**
 * «Карандаш» panel (top-left of the 2D view while the pencil tool is active): line / lasso /
 * rectangle, the marks of the level with «В чат» and delete, «Очистить пометки».
 */
import { derivePlan, markBadge, markTargets } from '@core'
import { Check, Lasso, MessageSquarePlus, Pencil, Square, Trash2 } from 'lucide-react'
import '@/ai/i18n'
import { MarkPrompt } from '@/ai/MarkPrompt'
import { addMarkToChat, insertIntoComposer, useAi } from '@/ai/store'
import { t, useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { clearMarks, deleteMark, marksStore, type PencilShape, useMarks } from '@/store/marks'
import { useUi } from '@/store/ui'
import { cn } from '@/ui/kit'

const SHAPES: { id: PencilShape; label: string; icon: typeof Pencil }[] = [
  { id: 'free', label: 'Линия', icon: Pencil },
  { id: 'lasso', label: 'Лассо', icon: Lasso },
  { id: 'rect', label: 'Рамка', icon: Square },
]

/** what the mark is about, in a few words (the quote on top of the mini field) */
function markQuote(id: string): string {
  const { doc, derived } = docStore.getState()
  const m = doc.annotations?.[id]
  if (!m) return ''
  const tg = markTargets(doc, derived[m.levelId] ?? derivePlan(doc, m.levelId), m)
  const run = tg.runs[0]
  if (run) return t('«{room}», стена {len} мм', { room: run.roomName, len: Math.round(run.length) }) + (tg.runs.length > 1 ? t(' и ещё {n}', { n: tg.runs.length - 1 }) : '')
  if (tg.rooms.length) return tg.rooms.map((r) => `«${r.name}»`).join(', ')
  return t('место на плане')
}

/** the mini «what to do here?» field next to a mark just drawn */
function PlanMarkPrompt() {
  const prompt = useMarks((s) => s.prompt)
  const mark = useDoc((s) => (prompt ? s.doc.annotations?.[prompt.id] : undefined))
  const busy = useAi((s) => !!s.running)
  if (!prompt || !mark) return null
  const badge = markBadge(mark.n)
  return (
    <MarkPrompt
      key={prompt.id}
      x={prompt.x}
      y={prompt.y}
      badge={badge}
      quote={markQuote(prompt.id)}
      busy={busy}
      onClose={() => marksStore.getState().setPrompt(null)}
      onSubmit={(text, send) => {
        marksStore.getState().setPrompt(null)
        void addMarkToChat(prompt.id, false).then(() => {
          if (text) insertIntoComposer(`${badge} ${text}`, send)
        })
      }}
    />
  )
}

export function PencilPanel() {
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

  return (
    <div className="absolute top-2 left-2 z-20 w-[230px] rounded-lg border border-border-strong bg-panel p-2 text-xs shadow-pop" onPointerDown={(e) => e.stopPropagation()}>
      <PlanMarkPrompt />
      <div className="mb-1.5 flex gap-1">
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={cn('flex flex-1 items-center justify-center gap-1 rounded-md border px-1.5 py-1', shape === s.id ? 'border-accent bg-accent-soft text-text' : 'border-border text-muted hover:text-text')}
            onClick={() => marksStore.getState().setShape(s.id)}
          >
            <s.icon size={12} /> {tr(s.label)}
          </button>
        ))}
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
