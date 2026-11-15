/**
 * Mini «what to do here?» field that pops up next to a pencil mark just drawn — like replying to a
 * text selection in Claude: the mark is quoted on top, Enter sends, Ctrl+Enter only adds the note
 * to the message so several marks can go in one request.
 */
import { ArrowUp, Plus } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/i18n'
import './i18n'

const W = 340

export function MarkPrompt({
  x,
  y,
  badge,
  quote,
  busy,
  onSubmit,
  onClose,
}: {
  /** client px of the point the card hangs from */
  x: number
  y: number
  badge: string
  quote: string
  /** the agent is working: Enter only adds to the message */
  busy: boolean
  onSubmit(text: string, send: boolean): void
  onClose(): void
}) {
  const tr = useT()
  const [text, setText] = useState('')
  const card = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState({ left: x + 12, top: y + 12 })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // keep the card on screen
  useLayoutEffect(() => {
    const h = card.current?.offsetHeight ?? 110
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - W - 8))
    const top = y + 12 + h > window.innerHeight - 8 ? Math.max(8, y - 12 - h) : y + 12
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    ta.current?.focus()
    const onDown = (e: PointerEvent) => {
      if (card.current && !card.current.contains(e.target as Node)) closeRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(120, el.scrollHeight)}px`
  }, [text])

  const submit = (send: boolean) => onSubmit(text.trim(), send && !busy)

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation() // no plan hotkeys while typing
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(!(e.ctrlKey || e.metaKey))
    }
  }

  return createPortal(
    <div
      ref={card}
      data-mark-prompt
      className="fixed z-[300] rounded-xl border border-border-strong bg-panel p-2 text-xs text-text shadow-pop"
      style={{ left: pos.left, top: pos.top, width: W }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 truncate border-l-2 border-accent pl-2 text-muted" title={quote}>
        <span className="mr-1 text-[13px] text-danger">{badge}</span>
        {quote}
      </div>
      <div className="flex items-end gap-1.5 rounded-lg border border-border bg-input px-2 py-1 focus-within:border-accent">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={tr(busy ? 'Что здесь сделать? (ИИ занят — добавится в сообщение)' : 'Что здесь сделать?')}
          className="min-h-[22px] flex-1 resize-none bg-transparent py-0.5 text-[12.5px] leading-snug outline-none placeholder:text-faint"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="button" title={tr('Добавить в сообщение, не отправляя (Ctrl+Enter)')} className="rounded-md p-1 text-muted hover:bg-hover hover:text-text" onClick={() => submit(false)}>
          <Plus size={14} />
        </button>
        <button
          type="button"
          title={tr(busy ? 'ИИ занят — добавится в сообщение' : 'Отправить (Enter)')}
          className="rounded-full bg-accent p-1 text-accent-fg hover:bg-accent-hover"
          onClick={() => submit(true)}
        >
          <ArrowUp size={13} />
        </button>
      </div>
      <div className="mt-1 px-0.5 text-[10.5px] text-faint">{tr('Enter — отправить · Ctrl+Enter — в сообщение · Esc — закрыть')}</div>
    </div>,
    document.body,
  )
}
