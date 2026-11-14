import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { RotateCcw, TriangleExclamationPoint } from 'lucide-react'
import { checkQuad, orderQuad, planRectification, warpPerspective } from '@core/homography'
import type { Id, Underlay, Vec2 } from '@core/types'
import { docStore, useDoc } from '@/store/document'
import { addTranslations, useT } from '@/i18n'
import { Button, Dialog, NumberInput, Row, Spinner, Toggle, cn } from '@/ui/kit'
import { errorText } from './common/catalog'

addTranslations('en', {
  'Выровнять перспективу': 'Correct perspective',
  'Щёлкните 4 угла прямоугольника известного размера (наружные стены или рамка листа), в любом порядке. Углы можно перетаскивать.':
    'Click the 4 corners of a rectangle of known size (outer walls or the sheet frame), in any order. Corners can be dragged.',
  'Ширина — верхняя сторона, высота — левая (после выравнивания).': 'Width is the top side, height the left side (after correction).',
  'Ширина прямоугольника': 'Rectangle width',
  'Высота прямоугольника': 'Rectangle height',
  'Сохранить поля вокруг прямоугольника': 'Keep a margin around the rectangle',
  'Сбросить': 'Reset',
  'Применить': 'Apply',
  'Отмена': 'Cancel',
  'Углов отмечено: {n} из 4': 'Corners marked: {n} of 4',
  'Загрузка изображения…': 'Loading image…',
  'Не удалось загрузить изображение подложки': 'Could not load the underlay image',
  'Введите реальные ширину и высоту прямоугольника': 'Enter the real width and height of the rectangle',
  'Подложка заблокирована': 'The underlay is locked',
  'Выравниваю…': 'Correcting…',
  'Угол {n}': 'Corner {n}',
  'Фото снято под углом? «Выровнять перспективу»: отметьте 4 угла прямоугольника известного размера.':
    'Photo taken at an angle? “Correct perspective”: mark the 4 corners of a rectangle of known size.',
})

/** longest side of the corrected image (texture-friendly, keeps memory reasonable) */
const MAX_SIDE = 4096
/** margin kept around the rectangle, fraction of its size per side (clipped to the photo) */
const PAD = 0.1
const CORNER_KEYS = ['c1', 'c2', 'c3', 'c4']

type Source = { el: ImageBitmap | HTMLImageElement; w: number; h: number; url: string; revoke: boolean }

async function loadSource(src: string): Promise<Source> {
  try {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    return { el: bmp, w: bmp.width, h: bmp.height, url: URL.createObjectURL(blob), revoke: true }
  } catch {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('load'))
      img.src = src
    })
    return { el: img, w: img.naturalWidth, h: img.naturalHeight, url: src, revoke: false }
  }
}

function disposeSource(s: Source | null): void {
  if (!s) return
  if (s.revoke) URL.revokeObjectURL(s.url)
  if ('close' in s.el) s.el.close()
}

/** image px of the (possibly resampled) bitmap → plan mm, with the underlay transform (see editor2d underlayCorners) */
function imageToPlan(u: Underlay, s: Source, p: Vec2): Vec2 {
  const kx = (u.widthPx || s.w) / s.w
  const ky = (u.heightPx || s.h) / s.h
  const lx = p.x * kx * u.scale
  const ly = p.y * ky * u.scale
  const r = (u.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const sn = Math.sin(r)
  return { x: u.x + lx * c - ly * sn, y: u.y + lx * sn + ly * c }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось закодировать PNG'))), 'image/png'),
  )
}

export interface PerspectiveDialogProps {
  open: boolean
  onClose(): void
  underlayId: Id
}

/** «Выровнять перспективу»: 4 corners of a known rectangle on the underlay → rectified PNG asset, exact mm/px */
export function PerspectiveDialog({ open, onClose, underlayId }: PerspectiveDialogProps) {
  const t = useT()
  const u = useDoc((s) => s.doc.underlays[underlayId])
  const src = u?.src
  const [source, setSource] = useState<Source | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [points, setPoints] = useState<Vec2[]>([])
  const [widthMm, setWidthMm] = useState<number | null>(null)
  const [heightMm, setHeightMm] = useState<number | null>(null)
  const [keepMargin, setKeepMargin] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // ── load the underlay bitmap ──
  useEffect(() => {
    if (!open || !src) return
    let alive = true
    let loaded: Source | null = null
    setSource(null)
    setLoadFailed(false)
    setPoints([])
    setWidthMm(null)
    setHeightMm(null)
    setError('')
    loadSource(src)
      .then((s) => {
        if (!alive) return disposeSource(s)
        loaded = s
        setSource(s)
      })
      .catch(() => alive && setLoadFailed(true))
    return () => {
      alive = false
      disposeSource(loaded)
    }
  }, [open, src])

  // ── stage size: fit the image into the available width and ~60 % of the window height ──
  const [wrapW, setWrapW] = useState(0)
  // callback ref: the dialog body mounts only while open
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    setWrapW(el.clientWidth)
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const maxH = Math.max(240, Math.min(620, window.innerHeight * 0.6))
  const k = source && wrapW > 0 ? Math.min(wrapW / source.w, maxH / source.h) : 0
  const dispW = source ? Math.round(source.w * k) : 0
  const dispH = source ? Math.round(source.h * k) : 0

  // ── corners ──
  const quad = useMemo(() => (points.length === 4 ? orderQuad(points) : null), [points])
  const quadError = useMemo(() => {
    if (!quad) return ''
    try {
      checkQuad(quad, 'Углы')
      return ''
    } catch (e) {
      return errorText(e)
    }
  }, [quad])

  // prefill the real size from the current underlay scale once the 4 corners are set
  useEffect(() => {
    if (!quad || quadError || !u || !source || widthMm !== null || heightMm !== null) return
    const d = (a: Vec2, b: Vec2) => {
      const pa = imageToPlan(u, source, a)
      const pb = imageToPlan(u, source, b)
      return Math.hypot(pb.x - pa.x, pb.y - pa.y)
    }
    const w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2
    const h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2
    setWidthMm(Math.max(10, Math.round(w / 10) * 10))
    setHeightMm(Math.max(10, Math.round(h / 10) * 10))
  }, [quad, quadError, u, source, widthMm, heightMm])

  const drag = useRef<{ idx: number; pointer: number } | null>(null)
  const toImage = (e: RPointerEvent<HTMLElement>, el: HTMLElement): Vec2 => {
    const r = el.getBoundingClientRect()
    const sw = source?.w ?? 1
    const sh = source?.h ?? 1
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * sw
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * sh
    return { x: Math.min(sw, Math.max(0, x)), y: Math.min(sh, Math.max(0, y)) }
  }
  const onStageDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || busy || !source) return
    const stage = e.currentTarget
    const marker = (e.target as HTMLElement).closest<HTMLElement>('[data-corner]')
    let idx: number
    if (marker) idx = Number(marker.dataset.corner)
    else if (points.length < 4) {
      idx = points.length
      const p = toImage(e, stage)
      setPoints((ps) => [...ps, p])
    } else return
    e.preventDefault()
    stage.setPointerCapture(e.pointerId)
    drag.current = { idx, pointer: e.pointerId }
    setError('')
  }
  const onStageMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    const p = toImage(e, e.currentTarget)
    setPoints((ps) => ps.map((q, i) => (i === d.idx ? p : q)))
  }
  const onStageUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // renumber as TL, TR, BR, BL so marker numbers match the messages and the width/height sides
    setPoints((ps) => (ps.length === 4 ? orderQuad(ps) : ps))
  }

  const reset = () => {
    setPoints([])
    setWidthMm(null)
    setHeightMm(null)
    setError('')
  }

  const sizeOk = widthMm !== null && heightMm !== null && widthMm > 0 && heightMm > 0
  const canApply = !!quad && !quadError && sizeOk && !!source && !!u && !u.locked && !busy

  const apply = async () => {
    if (!quad || !source || !u || !sizeOk) return
    setBusy(true)
    setError('')
    // let the spinner paint before the synchronous warp
    await new Promise((r) => window.setTimeout(r, 30))
    try {
      const plan = planRectification(quad, source.w, source.h, {
        rectMm: { width: widthMm, height: heightMm },
        pad: keepMargin ? PAD : 0,
        maxSide: MAX_SIDE,
      })
      const mmPerPx = plan.mmPerPx
      if (!mmPerPx || !Number.isFinite(mmPerPx)) throw new Error('Не удалось вычислить масштаб')

      const inCanvas = document.createElement('canvas')
      inCanvas.width = source.w
      inCanvas.height = source.h
      const ictx = inCanvas.getContext('2d', { willReadFrequently: true })
      if (!ictx) throw new Error('Canvas 2D недоступен')
      ictx.drawImage(source.el, 0, 0)
      let pixels: ImageData
      try {
        pixels = ictx.getImageData(0, 0, source.w, source.h)
      } catch {
        throw new Error('Нет доступа к пикселям изображения подложки')
      }
      const out = warpPerspective({ width: pixels.width, height: pixels.height, data: pixels.data, channels: 4 }, plan.quad, plan.width, plan.height)
      inCanvas.width = 1 // release the source copy early
      const outCanvas = document.createElement('canvas')
      outCanvas.width = out.width
      outCanvas.height = out.height
      const octx = outCanvas.getContext('2d')
      if (!octx) throw new Error('Canvas 2D недоступен')
      octx.putImageData(new ImageData(out.data as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0)
      const blob = await canvasToPng(outCanvas)
      const url = await window.doplan.project.addAsset(await blob.arrayBuffer(), 'png')

      const tl = imageToPlan(u, source, quad[0])
      const x = tl.x - plan.rect.x * mmPerPx
      const y = tl.y - plan.rect.y * mmPerPx
      docStore.getState().transact('Выровнять перспективу', (d) => {
        const target = d.underlays[underlayId]
        if (!target) return
        target.src = url
        target.widthPx = out.width
        target.heightPx = out.height
        target.scale = mmPerPx
        target.rotation = 0
        target.x = Math.round(x * 10) / 10
        target.y = Math.round(y * 10) / 10
      })
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const pct = (p: Vec2) => ({ left: `${(p.x / (source?.w || 1)) * 100}%`, top: `${(p.y / (source?.h || 1)) * 100}%` })
  const poly = quad ?? points

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Выровнять перспективу')}
      width="max-w-4xl"
      modalLock={busy}
      footer={
        <>
          <span className="mr-auto text-[10px] text-[var(--muted)]">{t('Углов отмечено: {n} из 4', { n: points.length })}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('Отмена')}
          </Button>
          <Button variant="primary" disabled={!canApply} loading={busy} onClick={() => void apply()}>
            {busy ? t('Выравниваю…') : t('Применить')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[11px] leading-snug">
          {t('Щёлкните 4 угла прямоугольника известного размера (наружные стены или рамка листа), в любом порядке. Углы можно перетаскивать.')}
        </p>
        <div ref={wrapRef} className="flex min-h-40 w-full items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)]">
          {!source && !loadFailed && (
            <span className="flex items-center gap-2 py-16 text-[var(--muted)]">
              <Spinner /> {t('Загрузка изображения…')}
            </span>
          )}
          {loadFailed && <span className="py-16 text-[#ff8589]">{t('Не удалось загрузить изображение подложки')}</span>}
          {source && dispW > 0 && (
            <div
              className={cn('relative select-none touch-none', points.length < 4 ? 'cursor-crosshair' : 'cursor-default')}
              style={{ width: dispW, height: dispH }}
              onPointerDown={onStageDown}
              onPointerMove={onStageMove}
              onPointerUp={onStageUp}
              onPointerCancel={onStageUp}
            >
              <img src={source.url} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
              <svg
                className="pointer-events-none absolute inset-0 size-full"
                viewBox={`0 0 ${source.w} ${source.h}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                {poly.length >= 2 && (
                  <polygon
                    points={poly.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill={quad && !quadError ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'none'}
                    stroke={quadError ? '#ff8589' : 'var(--accent)'}
                    strokeWidth={2}
                    strokeDasharray={quad ? undefined : '6 4'}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {quad && !quadError && (
                  <>
                    {/* top side = width, left side = height */}
                    <line x1={quad[0].x} y1={quad[0].y} x2={quad[1].x} y2={quad[1].y} stroke="#f0b75a" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                    <line x1={quad[0].x} y1={quad[0].y} x2={quad[3].x} y2={quad[3].y} stroke="#4fc3f7" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                  </>
                )}
              </svg>
              {points.map((p, i) => (
                <div
                  key={CORNER_KEYS[i]}
                  data-corner={i}
                  role="img"
                  aria-label={t('Угол {n}', { n: i + 1 })}
                  title={t('Угол {n}', { n: i + 1 })}
                  className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-move items-center justify-center rounded-full border-2 border-white bg-[var(--accent)] text-[10px] font-bold text-white shadow"
                  style={pct(p)}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
          <Row label={<span className="text-[#f0b75a]">{t('Ширина прямоугольника')}</span>} stacked>
            <NumberInput kind="length" value={widthMm} min={1} round={1} disabled={busy} onChange={(v) => setWidthMm(v)} />
          </Row>
          <Row label={<span className="text-[#4fc3f7]">{t('Высота прямоугольника')}</span>} stacked>
            <NumberInput kind="length" value={heightMm} min={1} round={1} disabled={busy} onChange={(v) => setHeightMm(v)} />
          </Row>
          <Button icon={<RotateCcw className="size-3.5" />} onClick={reset} disabled={busy || points.length === 0}>
            {t('Сбросить')}
          </Button>
        </div>
        <p className="text-[10px] leading-snug text-[var(--muted)]">{t('Ширина — верхняя сторона, высота — левая (после выравнивания).')}</p>
        <Toggle checked={keepMargin} onChange={setKeepMargin} disabled={busy} label={t('Сохранить поля вокруг прямоугольника')} />
        {(quadError || error || (quad && !sizeOk) || u?.locked) && (
          <div className="flex items-start gap-1.5 text-[11px] text-[#ff8589]" role="alert">
            <TriangleExclamationPoint className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{quadError || error || (u?.locked ? t('Подложка заблокирована') : t('Введите реальные ширину и высоту прямоугольника'))}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
