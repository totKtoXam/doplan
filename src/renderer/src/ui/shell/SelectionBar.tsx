/**
 * A small floating bar above the selection on the plan: rotate 90°, duplicate, add to the AI chat,
 * delete. Follows the selection while the plan is panned or zoomed; hidden while a mouse button is
 * down (dragging), while another tool than «Выбор» is active and when nothing is selected.
 */
import { CopyPlus, MessageSquarePlus, RotateCw, Trash } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { selectionBounds } from '@/editor2d/bounds'
import { actions } from '@/actions'
import { addSelectionToChat } from '@/ai'
import { useT } from '@/i18n'
import { docStore } from '@/store/document'
import { handles } from '@/store/handles'
import { uiStore, useUi } from '@/store/ui'
import { IconBtn } from './primitives'
import '@/ui/shellI18n'

const ROTATABLE = new Set(['wall', 'node', 'item', 'light', 'electric'])
/** gap between the selection box and the bar, px */
const GAP = 10

export function SelectionBar() {
  const t = useT()
  const bar = useRef<HTMLDivElement>(null)
  const count = useUi((s) => s.selection.length)
  const tool = useUi((s) => s.tool)
  const canRotate = useUi((s) => s.selection.some((r) => ROTATABLE.has(r.kind)))
  const [pressed, setPressed] = useState(false)

  // dragging an object or a frame: the bar would only get in the way
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setPressed(true)
    }
    const up = () => setPressed(false)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', up)
    }
  }, [])

  const shown = count > 0 && tool === 'select' && !pressed

  // follow the selection every frame (pan, zoom, edits) without re-rendering React
  useEffect(() => {
    if (!shown) return
    let raf = 0
    const place = () => {
      raf = requestAnimationFrame(place)
      const el = bar.current
      const host = el?.offsetParent as HTMLElement | null
      const ed = handles.editor2d
      if (!el || !host || !ed) return
      const { doc, derived } = docStore.getState()
      const ui = uiStore.getState()
      const box = selectionBounds(doc, derived[ui.activeLevelId], ui.selection)
      if (!box) {
        el.style.visibility = 'hidden'
        return
      }
      const hr = host.getBoundingClientRect()
      const corners = [ed.toScreen({ x: box.minX, y: box.minY }), ed.toScreen({ x: box.maxX, y: box.maxY })]
      const left = Math.min(corners[0].x, corners[1].x) - hr.left
      const right = Math.max(corners[0].x, corners[1].x) - hr.left
      const top = Math.min(corners[0].y, corners[1].y) - hr.top
      const bottom = Math.max(corners[0].y, corners[1].y) - hr.top
      const w = el.offsetWidth
      const h = el.offsetHeight
      // off screen entirely: nothing to point at
      if (right < 0 || left > hr.width || bottom < 0 || top > hr.height) {
        el.style.visibility = 'hidden'
        return
      }
      const x = Math.min(hr.width - w - 6, Math.max(6, (left + right) / 2 - w / 2))
      // above the selection, below it when there is no room, inside the view as a last resort
      let y = top - h - GAP
      if (y < 6) y = bottom + GAP
      if (y + h > hr.height - 6) y = Math.max(6, Math.min(hr.height - h - 6, top + 6))
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
      el.style.visibility = 'visible'
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [shown])

  if (!shown) return null
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('Действия с выделенным')}
      className="dp-fade-in absolute top-0 left-0 z-20 flex items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-0.5 shadow-pop"
      style={{ visibility: 'hidden' }}
    >
      <IconBtn icon={RotateCw} size="sm" label={t('Повернуть на 90°')} kbd="Shift+R" tipSide="top" disabled={!canRotate} onClick={() => actions.groupRotate(90)} />
      <IconBtn icon={CopyPlus} size="sm" label={t('Дублировать')} kbd="Ctrl+D" tipSide="top" onClick={() => actions.duplicateSelection()} />
      <IconBtn icon={MessageSquarePlus} size="sm" label={t('Добавить в чат с ИИ')} kbd="Ctrl+L" tipSide="top" onClick={() => addSelectionToChat()} />
      <div className="mx-0.5 h-4 w-px bg-border" />
      <IconBtn icon={Trash} size="sm" label={t('Удалить')} kbd="Del" tipSide="top" className="hover:!text-danger" onClick={() => actions.deleteSelection()} />
    </div>
  )
}
