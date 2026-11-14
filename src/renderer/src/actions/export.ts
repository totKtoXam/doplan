import { buildDisplayList, toDxf, toSvg } from '@core'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { handles, waitForEngine3D } from '@/store/handles'
import { alertDialog, setProgress, toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import type { Engine3DHandle } from '@/contracts'
import { activeLevel, currentDoc, errorText, levelSuffix, projectBaseName } from './util'

export type PlanFormat = 'png' | 'svg' | 'pdf' | 'dxf'

function planSvg(): { svg: string; widthMm: number; heightMm: number } {
  const doc = currentDoc()
  const levelId = activeLevel()
  const dl = buildDisplayList(doc, levelId, {
    dimensions: doc.settings.showDimensions,
    areas: doc.settings.showAreas,
    furniture: doc.settings.showFurniture2d,
    labels: true,
    grid: false,
    titleBlock: true,
    theme: 'light',
  })
  const levelName = doc.levels[levelId]?.name
  return toSvg(dl, { scale: 100, marginMm: 10, title: doc.levelOrder.length > 1 && levelName ? `${doc.meta.name} — ${levelName}` : doc.meta.name })
}

/** Rasterises the plan SVG (used when the 2D editor is not mounted). */
async function svgToPng(svg: string, widthMm: number, heightMm: number, pxPerPaperMm = 10): Promise<Blob> {
  const w = Math.max(1, Math.round(widthMm * pxPerPaperMm))
  const h = Math.max(1, Math.round(heightMm * pxPerPaperMm))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error(t('Не удалось растеризовать SVG')))
      im.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function exportPlan(fmt: PlanFormat): Promise<void> {
  const base = `${projectBaseName()}${levelSuffix()}`
  try {
    let saved: string | null = null
    switch (fmt) {
      case 'svg': {
        const { svg } = planSvg()
        saved = await api.files.saveText(`${base}.svg`, [{ name: 'SVG', extensions: ['svg'] }], svg)
        break
      }
      case 'pdf': {
        const { svg, widthMm, heightMm } = planSvg()
        saved = await api.files.exportPdf(svg, { widthMm, heightMm, defaultName: `${base}.pdf` })
        break
      }
      case 'dxf': {
        const dxf = toDxf(currentDoc(), activeLevel())
        saved = await api.files.saveText(`${base}.dxf`, [{ name: 'DXF', extensions: ['dxf'] }], dxf)
        break
      }
      case 'png': {
        let blob: Blob
        if (handles.editor2d) {
          blob = await handles.editor2d.snapshotPng(200)
        } else {
          const { svg, widthMm, heightMm } = planSvg()
          blob = await svgToPng(svg, widthMm, heightMm)
        }
        saved = await api.files.saveBinary(`${base}.png`, [{ name: 'PNG', extensions: ['png'] }], await blob.arrayBuffer())
        break
      }
    }
    if (saved) toast(t('Экспортировано: {file}', { file: saved.split(/[\\/]/).pop() ?? saved }), 'success')
  } catch (err) {
    await alertDialog(t('Ошибка экспорта'), errorText(err))
  }
}

/** Returns the 3D engine, switching to split view and waiting for it if necessary. */
export async function ensureEngine(): Promise<Engine3DHandle | null> {
  if (handles.engine3d) return handles.engine3d
  const ui = uiStore.getState()
  if (ui.mode === '2d') ui.setMode('split')
  setProgress({ label: t('Запуск 3D…'), value: null })
  try {
    const eng = await waitForEngine3D(30000)
    if (!eng) await alertDialog(t('3D-вид недоступен'), t('Не удалось запустить 3D-движок.'))
    return eng
  } finally {
    setProgress(null)
  }
}

export async function exportGlb(): Promise<void> {
  const eng = await ensureEngine()
  if (!eng) return
  setProgress({ label: t('Экспорт GLB…'), value: null })
  try {
    const glb = await eng.exportGlb()
    setProgress(null)
    const saved = await api.files.saveBinary(`${projectBaseName()}.glb`, [{ name: 'glTF Binary', extensions: ['glb'] }], glb)
    if (saved) toast(t('Экспортировано: {file}', { file: saved.split(/[\\/]/).pop() ?? saved }), 'success')
  } catch (err) {
    setProgress(null)
    await alertDialog(t('Ошибка экспорта'), errorText(err))
  }
}

export interface RenderStillOptions {
  width: number
  height: number
  mode: 'realtime' | 'pathtraced'
  samples?: number
  format?: 'png' | 'jpeg'
}

/** Renders a still image of the current 3D camera and asks where to save it. Resolves with the blob (or null). */
export async function renderStill(opts: RenderStillOptions): Promise<Blob | null> {
  const eng = await ensureEngine()
  if (!eng) return null
  const ctrl = new AbortController()
  const format = opts.format ?? 'png'
  setProgress({ label: t('Рендер…'), value: opts.mode === 'pathtraced' ? 0 : null, cancel: () => ctrl.abort() })
  let blob: Blob
  try {
    blob = await eng.renderStill({
      width: opts.width,
      height: opts.height,
      mode: opts.mode,
      samples: opts.samples,
      format,
      signal: ctrl.signal,
      onProgress: (s, total) => setProgress({ label: t('Рендер: {s} / {total}', { s, total }), value: total > 0 ? s / total : null, cancel: () => ctrl.abort() }),
    })
  } catch (err) {
    setProgress(null)
    if (ctrl.signal.aborted) {
      toast(t('Рендер отменён'), 'warning')
      return null
    }
    await alertDialog(t('Ошибка рендера'), errorText(err))
    return null
  }
  setProgress(null)
  const ext = format === 'jpeg' ? 'jpg' : 'png'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  try {
    const saved = await api.files.saveBinary(
      `${projectBaseName()} ${stamp}.${ext}`,
      [{ name: format === 'jpeg' ? 'JPEG' : 'PNG', extensions: [ext] }],
      await blob.arrayBuffer(),
    )
    if (saved) toast(t('Сохранено: {file}', { file: saved.split(/[\\/]/).pop() ?? saved }), 'success')
  } catch (err) {
    await alertDialog(t('Не удалось сохранить файл'), errorText(err))
  }
  return blob
}

/** Quick snapshot of the 3D viewport at 2× its size. */
export async function snapshot3d(): Promise<void> {
  const eng = handles.engine3d
  if (!eng) return
  const el = document.querySelector<HTMLElement>('[data-viewport="3d"]')
  const w = Math.round((el?.clientWidth ?? 1280) * 2)
  const h = Math.round((el?.clientHeight ?? 720) * 2)
  await renderStill({ width: Math.min(w, 7680), height: Math.min(h, 4320), mode: 'realtime' })
}
