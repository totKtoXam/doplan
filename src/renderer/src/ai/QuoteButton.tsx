/**
 * «Цитировать»: a floating button next to text selected in the conversation (any message, the user's or
 * the assistant's). A click puts the passage into the input box as a quote; the selection stays until then.
 */
import { Quote } from 'lucide-react'
import { type RefObject, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/i18n'
import { addQuote } from './store'

interface Spot {
  text: string
  x: number
  y: number
}

/** the selection inside `root`, with the point under its end where the button goes (viewport coordinates) */
function selectionIn(root: HTMLElement): Spot | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  // text selected in a field (editing a message) is not a passage of the conversation
  const a = document.activeElement
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = sel.toString().trim()
  if (!text) return null
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
  const box = root.getBoundingClientRect()
  const last = rects.at(-1) ?? range.getBoundingClientRect()
  // under the end of the selection, kept inside the conversation
  const x = Math.min(Math.max(last.right, box.left + 50), box.right - 50)
  const y = Math.min(Math.max(last.bottom + 4, box.top + 4), box.bottom - 30)
  return { text, x, y }
}

export function QuoteButton({ root }: { root: RefObject<HTMLElement | null> }) {
  const [spot, setSpot] = useState<Spot | null>(null)

  useEffect(() => {
    let down = false
    const update = () => {
      const el = root.current
      setSpot(el && !down ? selectionIn(el) : null)
    }
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-ai-quote-btn]')) return
      down = true
      setSpot(null)
    }
    const onUp = () => {
      down = false
      // the selection settles after the mouseup
      requestAnimationFrame(update)
    }
    const onSel = () => {
      if (!down) update()
    }
    const el = root.current
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('selectionchange', onSel)
    el?.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('selectionchange', onSel)
      el?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [root])

  if (!spot) return null
  return createPortal(
    <button
      type="button"
      data-ai-quote-btn
      className="fixed z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border-strong bg-panel px-2 py-1 text-[11px] text-text shadow-pop hover:bg-hover"
      style={{ left: spot.x, top: spot.y }}
      // keeps the selection (and the focus) where they are
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        addQuote(spot.text)
        window.getSelection()?.removeAllRanges()
        setSpot(null)
      }}
    >
      <Quote size={11} className="text-accent" />
      {t('Цитировать')}
    </button>,
    document.body,
  )
}
