/**
 * Editor for drawing pencil marks on a chat image before it is sent: lines, frames, arrows in a few
 * colours, each numbered (the numbers run on from the plan marks, so «③» is never ambiguous).
 * It covers the work area only — the chat stays open on the right. Marks go into the attached
 * picture at once (the clean one is kept for re-editing); a mini field next to each new mark
 * takes a note for it, like replying to a text selection.
 */
import { ArrowUpRight, Pencil, RotateCcw, Square, Trash2, Undo2, X } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/ui/kit'
import { MarkPrompt } from './MarkPrompt'
import { drawMarkup, isMeaningful, MARKUP_COLORS, type MarkupShape, type MarkupTool, markupBadge, markupMetrics } from './markup'
import { insertIntoComposer, nextImageMarkNumber, type PendingImage, useAi } from './store'

const TOOLS: { id: MarkupTool; label: string; key: string; icon: typeof Pencil }[] = [
  { id: 'pen', label: 'Линия', key: '1', icon: Pencil },
  { id: 'rect', label: 'Рамка', key: '2', icon: Square },
  { id: 'arrow', label: 'Стрелка', key: '3', icon: ArrowUpRight },
]

const TOOLBAR_H = 44

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось открыть изображение'))
    img.src = src
  })
}

/** the picture with the marks baked in, at the image's own size */
function bake(img: HTMLImageElement, base: string, shapes: MarkupShape[], prev: PendingImage): PendingImage {
  if (!shapes.length) {
    const mime = (/^data:(image\/[a-z]+);/.exec(base)?.[1] ?? prev.mime) as PendingImage['mime']
    return { mime, data: base.slice(base.indexOf(',') + 1), url: base, name: prev.name }
  }
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, w, h)
  c.drawImage(img, 0, 0, w, h)
  drawMarkup(c, shapes, 1, markupMetrics(w, h))
  const mime = prev.mime === 'image/png' ? 'image/png' : 'image/jpeg'
  const url = canvas.toDataURL(mime, 0.9)
  return { mime, data: url.slice(url.indexOf(',') + 1), url, name: prev.name, markup: { base, shapes } }
}

/** the screen area left of the chat dock (the editor must not hide the chat) */
function workArea(): { right: number; w: number; h: number } {
  const dock = document.querySelector<HTMLElement>('[data-ai-dock]')
  const r = dock?.getBoundingClientRect()
  const right = r && r.width > 0 ? Math.max(0, window.innerWidth - r.left) : 0
  return { right, w: window.innerWidth - right, h: window.innerHeight }
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)

export function ImageMarkup({ image, onChange, onClose }: { image: PendingImage; onChange(img: PendingImage): void; onClose(): void }) {
  const initial = useRef(image).current
  const base = initial.markup?.base ?? initial.url
  const busy = useAi((s) => !!s.running)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [shapes, setShapes] = useState<MarkupShape[]>(initial.markup?.shapes ?? [])
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<string>(MARKUP_COLORS[0])
  const [area, setArea] = useState(workArea)
  const [ask, setAsk] = useState<{ n: number; x: number; y: number } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const drawing = useRef<MarkupShape | null>(null)
  const [, redraw] = useState(0)

  // take the keyboard from the chat input so 1/2/3 and Ctrl+Z reach the editor
  useEffect(() => root.current?.focus(), [])

  useEffect(() => {
    loadImage(base).then(setImg, (e: Error) => setError(e.message))
  }, [base])

  // follow the window and the dock width
  useEffect(() => {
    const update = () => setArea(workArea())
    window.addEventListener('resize', update)
    const dock = document.querySelector('[data-ai-dock]')
    const ro = dock ? new ResizeObserver(update) : null
    if (dock) ro!.observe(dock)
    return () => {
      window.removeEventListener('resize', update)
      ro?.disconnect()
    }
  }, [])

  // marks go into the attached picture right away (so a note sent from the mini field carries them)
  const first = useRef(true)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  useEffect(() => {
    if (!img) return
    if (first.current) {
      first.current = false
      return
    }
    changeRef.current(bake(img, base, shapes, initial))
  }, [shapes, img, base, initial])

  // fit the picture into the work area under the toolbar
  const iw = img?.naturalWidth ?? 1
  const ih = img?.naturalHeight ?? 1
  const k = Math.min((area.w - 32) / iw, (area.h - TOOLBAR_H - 32) / ih, 2)
  const cw = Math.max(1, Math.round(iw * k))
  const ch = Math.max(1, Math.round(ih * k))
  const metrics = markupMetrics(iw, ih)

  useLayoutEffect(() => {
    const el = canvas.current
    if (!el || !img) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(cw * dpr)
    el.height = Math.round(ch * dpr)
    const c = el.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, cw, ch)
    c.drawImage(img, 0, 0, cw, ch)
    drawMarkup(c, drawing.current ? [...shapes, drawing.current] : shapes, k, metrics)
  })

  const undo = () => {
    setAsk(null)
    setShapes((s) => s.slice(0, -1))
  }
  const revert = () => {
    changeRef.current(initial)
    onClose()
  }

  // editor keys, unless the user is typing (chat input, mini field)
  const keys = useRef({ onClose, undo })
  keys.current = { onClose, undo }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      e.stopPropagation()
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        keys.current.onClose()
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        keys.current.undo()
      } else {
        const t = TOOLS.find((x) => x.key === e.key)
        if (t) setTool(t.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const at = (e: ReactPointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: Math.round(((e.clientX - r.left) / k) * 10) / 10, y: Math.round(((e.clientY - r.top) / k) * 10) / 10 }
  }
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !img) return
    root.current?.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    setAsk(null)
    const p = at(e)
    drawing.current = { kind: tool, color, points: [p, p] }
    redraw((n) => n + 1)
  }
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = drawing.current
    if (!s) return
    const p = at(e)
    if (s.kind === 'pen') {
      const last = s.points[s.points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) * k >= 2) s.points = [...s.points, p]
    } else s.points = [s.points[0], p]
    redraw((n) => n + 1)
  }
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = drawing.current
    drawing.current = null
    if (!s || !isMeaningful(s, 6 / k)) {
      redraw((n) => n + 1)
      return
    }
    const n = nextImageMarkNumber(shapes)
    setShapes((list) => [...list, { ...s, points: s.kind === 'pen' ? s.points.slice(1) : s.points, n }])
    setAsk({ n, x: e.clientX, y: e.clientY })
  }

  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      className="fixed top-0 bottom-0 left-0 z-[200] flex flex-col bg-black/80 text-xs text-text outline-none"
      style={{ right: area.right }}
      role="dialog"
      aria-label="Пометки на картинке"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-panel px-3 py-2" style={{ minHeight: TOOLBAR_H }}>
        <span className="mr-1 font-medium">Пометки на картинке</span>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={`${t.label} (${t.key})`}
            className={cn('flex items-center gap-1 rounded-md border px-2 py-1', tool === t.id ? 'border-accent bg-accent-soft' : 'border-border text-muted hover:text-text')}
            onClick={() => setTool(t.id)}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        {MARKUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Цвет ${c}`}
            className={cn('h-5 w-5 rounded-full border-2', color === c ? 'border-text' : 'border-transparent')}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" title="Убрать последнюю пометку (Ctrl+Z)" disabled={!shapes.length} className="rounded-md p-1 text-muted hover:text-text disabled:opacity-40" onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          title="Стереть все пометки"
          disabled={!shapes.length}
          className="rounded-md p-1 text-muted hover:text-danger disabled:opacity-40"
          onClick={() => {
            setAsk(null)
            setShapes([])
          }}
        >
          <Trash2 size={14} />
        </button>
        <span className="ml-2 min-w-0 flex-1 truncate text-muted">
          {shapes.length
            ? `Пометки ${shapes.map((s, i) => markupBadge(s.n ?? i + 1)).join(' ')} уже на картинке в чате — напишите, что сделать`
            : 'Обведите или укажите стрелкой, что изменить — рядом откроется поле для комментария'}
        </span>
        <button type="button" title="Вернуть картинку как была до открытия" className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted hover:text-text" onClick={revert}>
          <RotateCcw size={12} /> Отменить правки
        </button>
        <button type="button" className="rounded-md bg-accent px-3 py-1 text-accent-fg hover:bg-accent-hover" onClick={onClose}>
          Готово
        </button>
        <button type="button" aria-label="Закрыть" className="rounded-md p-1 text-muted hover:text-text" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <div className="text-danger">{error}</div>
        ) : (
          <canvas
            ref={canvas}
            data-markup-canvas
            className="cursor-crosshair touch-none rounded shadow-pop"
            style={{ width: cw, height: ch }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              drawing.current = null
              redraw((n) => n + 1)
            }}
          />
        )}
      </div>
      {ask && (
        <MarkPrompt
          x={ask.x}
          y={ask.y}
          badge={markupBadge(ask.n)}
          quote="пометка на картинке"
          busy={busy}
          onClose={() => {
            setAsk(null)
            root.current?.focus()
          }}
          onSubmit={(text, send) => {
            setAsk(null)
            if (text) insertIntoComposer(`${markupBadge(ask.n)} ${text}`, send)
            if (!send) root.current?.focus()
          }}
        />
      )}
    </div>,
    document.body,
  )
}
