/**
 * «Пометить» in the chat input row: starts (or ends) marking on the plan; the small arrow opens the
 * shape choice — Линия / Лассо / Рамка. The marks themselves: editor2d/tools/pencil; their list: MarksBar.
 */
import { Check, ChevronDown, Highlighter, Lasso, Pencil, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '@/i18n'
import { marksStore, type PencilShape, useMarks } from '@/store/marks'
import { useUi } from '@/store/ui'
import { cn, Popover } from '@/ui/kit'
import { activateTool } from '@/ui/shell/tools'
import './i18n'

export const MARK_SHAPES: { id: PencilShape; label: string; icon: typeof Pencil }[] = [
  { id: 'free', label: 'Линия', icon: Pencil },
  { id: 'lasso', label: 'Лассо', icon: Lasso },
  { id: 'rect', label: 'Рамка', icon: Square },
]

export function MarkButton() {
  const t = useT()
  const on = useUi((s) => s.tool === 'pencil')
  // marks are drawn on the 2D plan
  const off = useUi((s) => s.mode === '3d')
  const shape = useMarks((s) => s.shape)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const cur = MARK_SHAPES.find((s) => s.id === shape) ?? MARK_SHAPES[0]

  return (
    <>
      <div
        ref={anchor}
        data-ai-mark
        className={cn('flex shrink-0 items-center rounded-lg text-muted', on && 'bg-accent-soft text-text', off && 'opacity-40')}
      >
        <button
          type="button"
          aria-pressed={on}
          disabled={off}
          title={off ? t('Пометки рисуются на 2D-плане') : on ? t('Закончить пометки (Esc)') : t('Пометить место на плане (P)')}
          className={cn('flex items-center gap-1 rounded-l-lg py-1 pr-0.5 pl-1.5 text-[11px]', !off && 'hover:bg-hover hover:text-text')}
          onClick={() => activateTool(on ? 'select' : 'pencil', t)}
        >
          <Highlighter size={14} className={cn(on && 'text-accent')} />
          <span>{t('Пометить')}</span>
        </button>
        <button
          type="button"
          disabled={off}
          aria-label={t('Форма пометки')}
          title={`${t('Форма пометки')}: ${t(cur.label)}`}
          className={cn('flex items-center gap-0.5 rounded-r-lg py-1 pr-1 pl-0.5', !off && 'hover:bg-hover hover:text-text', open && 'bg-hover text-text')}
          onClick={() => setOpen((o) => !o)}
        >
          <cur.icon size={11} />
          <ChevronDown size={10} />
        </button>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={170} aria-label={t('Форма пометки')}>
        <div className="p-1">
          {MARK_SHAPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={s.id === shape}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover"
              onClick={() => {
                setOpen(false)
                marksStore.getState().setShape(s.id)
                // picking a shape means «mark now»
                if (!on) activateTool('pencil', t)
              }}
            >
              <s.icon size={13} className="text-muted" />
              <span className="flex-1">{t(s.label)}</span>
              {s.id === shape && <Check size={12} className="text-accent" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
