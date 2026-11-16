/**
 * The «Объекты» block at the top of the right panel: a collapsible header, the layers panel and a
 * divider that sets its height (kept in localStorage). The inspector takes the rest of the column.
 */
import clsx from 'clsx'
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react'
import { useCallback, useRef, useState, type PointerEvent } from 'react'
import { useT } from '@/i18n'
import { LayersPanel } from './LayersPanel'

const OPEN_KEY = 'doplan.layers.open'
const HEIGHT_KEY = 'doplan.layers.height'
const MIN = 120
const DEFAULT = 280

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export function LayersSection() {
  const t = useT()
  const [open, setOpenState] = useState(() => read(OPEN_KEY) !== '0')
  const [height, setHeight] = useState(() => {
    const v = Number(read(HEIGHT_KEY))
    return Number.isFinite(v) && v >= MIN ? v : DEFAULT
  })
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number; max: number } | null>(null)

  const setOpen = (v: boolean) => {
    setOpenState(v)
    write(OPEN_KEY, v ? '1' : '0')
  }

  const maxHeight = useCallback(() => {
    const parent = box.current?.parentElement
    return parent ? Math.max(MIN, parent.clientHeight - 140) : 800
  }, [])

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: height, max: maxHeight() }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    setHeight(Math.round(Math.min(d.max, Math.max(MIN, d.h + e.clientY - d.y))))
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    setHeight((h) => {
      write(HEIGHT_KEY, String(h))
      return h
    })
  }

  return (
    <>
      <div
        ref={box}
        className={clsx('flex shrink-0 flex-col border-b border-[var(--border)]', open && 'min-h-0')}
        style={open ? { height, maxHeight: 'calc(100% - 140px)', minHeight: MIN } : undefined}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? t('Свернуть панель объектов') : t('Развернуть панель объектов')}
          className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <ListTree size={13} strokeWidth={1.75} />
          {t('Объекты')}
        </button>
        {open && <LayersPanel className="min-h-0 flex-1" />}
      </div>
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('Изменить высоту панели объектов')}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={() => {
            setHeight(DEFAULT)
            write(HEIGHT_KEY, String(DEFAULT))
          }}
          className="-mt-0.5 h-1 shrink-0 cursor-row-resize hover:bg-[var(--accent)]"
        />
      )}
    </>
  )
}
