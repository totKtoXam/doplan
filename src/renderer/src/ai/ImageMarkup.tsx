/**
 * Full-screen editor for drawing pencil marks on a chat image before it is sent: lines, frames,
 * arrows in a few colours; every mark gets a number ①② to refer to in the message.
 * «Готово» bakes the marks into the attached picture and keeps the clean one for re-editing.
 */
import { ArrowUpRight, Pencil, Square, Trash2, Undo2, X } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/ui/kit'
import { drawMarkup, isMeaningful, MARKUP_COLORS, type MarkupShape, type MarkupTool, markupBadge, markupMetrics } from './markup'
import type { PendingImage } from './store'

const TOOLS: { id: MarkupTool; label: string; key: string; icon: typeof Pencil }[] = [
  { id: 'pen', label: 'Линия', key: '1', icon: Pencil },
  { id: 'rect', label: 'Рамка', key: '2', icon: Square },
  { id: 'arrow', label: 'Стрелка', key: '3', icon: ArrowUpRight },
]

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

export function ImageMarkup({ image, onDone, onClose }: { image: PendingImage; onDone(img: PendingImage): void; onClose(): void }) {
  const base = image.markup?.base ?? image.url
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [shapes, setShapes] = useState<MarkupShape[]>(image.markup?.shapes ?? [])
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<string>(MARKUP_COLORS[0])
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<MarkupShape | null>(null)
  const [, redraw] = useState(0)

  useEffect(() => {
    loadImage(base).then(setImg, (e: Error) => setError(e.message))
  }, [base])

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // fit the picture into the window under the toolbar
  const iw = img?.naturalWidth ?? 1
  const ih = img?.naturalHeight ?? 1
  const k = Math.min((view.w - 48) / iw, (view.h - 120) / ih, 2)
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

  const done = () => {
    if (!img) return
    onDone(bake(img, base, shapes, image))
  }

  // the editor owns the keyboard while open (no plan hotkeys underneath)
  const keys = useRef({ done, onClose, undo: () => setShapes((s) => s.slice(0, -1)) })
  keys.current = { done, onClose, undo: () => setShapes((s) => s.slice(0, -1)) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') keys.current.onClose()
      else if (e.key === 'Enter') {
        e.preventDefault()
        keys.current.done()
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
    e.currentTarget.setPointerCapture(e.pointerId)
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
  const up = () => {
    const s = drawing.current
    drawing.current = null
    if (s && isMeaningful(s, 6 / k)) setShapes((list) => [...list, s.kind === 'pen' ? { ...s, points: s.points.slice(1) } : s])
    else redraw((n) => n + 1)
  }

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-black/80 text-xs text-text" role="dialog" aria-label="Пометки на картинке">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-3 py-2">
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
        <button type="button" title="Отменить (Ctrl+Z)" disabled={!shapes.length} className="rounded-md p-1 text-muted hover:text-text disabled:opacity-40" onClick={() => setShapes((s) => s.slice(0, -1))}>
          <Undo2 size={14} />
        </button>
        <button type="button" title="Стереть все пометки" disabled={!shapes.length} className="rounded-md p-1 text-muted hover:text-danger disabled:opacity-40" onClick={() => setShapes([])}>
          <Trash2 size={14} />
        </button>
        <span className="ml-2 min-w-0 flex-1 truncate text-muted">
          {shapes.length
            ? `Пометки ${shapes.map((_, i) => markupBadge(i + 1)).join(' ')} — сошлитесь на номер в сообщении: «в ① …»`
            : 'Обведите или укажите стрелкой, что изменить; у каждой пометки будет номер'}
        </span>
        <button type="button" className="rounded-md border border-border px-2.5 py-1 hover:bg-hover" onClick={onClose}>
          Отмена
        </button>
        <button type="button" disabled={!img} className="rounded-md bg-accent px-3 py-1 text-accent-fg hover:bg-accent-hover disabled:opacity-50" onClick={done}>
          Готово
        </button>
        <button type="button" aria-label="Закрыть" className="rounded-md p-1 text-muted hover:text-text" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
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
            onPointerCancel={up}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
