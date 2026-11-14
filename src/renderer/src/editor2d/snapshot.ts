/**
 * Raster snapshot of a level without any editor chrome. Drawn through the core display list
 * (the single source of every non-interactive plan drawing), not from the Pixi stage.
 */
import { buildDisplayList, drawToCanvas } from '@core'
import type { Id } from '@core/types'
import { docStore } from '@/store/document'

const MAX_SIDE = 8192

export async function snapshotPng(levelId: Id, pixelsPerMetre: number): Promise<Blob> {
  const { doc } = docStore.getState()
  const dl = buildDisplayList(doc, levelId, { theme: 'light' })
  const bw = Math.max(1, dl.bounds.maxX - dl.bounds.minX)
  const bh = Math.max(1, dl.bounds.maxY - dl.bounds.minY)
  let pxPerMm = Math.max(1, Number.isFinite(pixelsPerMetre) ? pixelsPerMetre : 100) / 1000
  if (bw * pxPerMm > MAX_SIDE || bh * pxPerMm > MAX_SIDE) pxPerMm = MAX_SIDE / Math.max(bw, bh)
  const width = Math.max(1, Math.ceil(bw * pxPerMm))
  const height = Math.max(1, Math.ceil(bh * pxPerMm))

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const c2d = canvas.getContext('2d')
    if (!c2d) throw new Error('snapshotPng: 2D context is not available')
    drawToCanvas(c2d, dl, { pxPerMm, width, height, background: dl.background || '#ffffff' })
    return canvas.convertToBlob({ type: 'image/png' })
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const c2d = canvas.getContext('2d')
  if (!c2d) throw new Error('snapshotPng: 2D context is not available')
  drawToCanvas(c2d, dl, { pxPerMm, width, height, background: dl.background || '#ffffff' })
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshotPng: toBlob failed'))), 'image/png')
  })
}
