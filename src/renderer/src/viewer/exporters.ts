/**
 * Files a visitor can take away from a published plan: the 2D plan as PNG, the plan with dimensions
 * as PDF, the 3D view as PNG, the scene as GLB and — when the author allowed it — the plan itself.
 * Everything is made in the browser from what is on the page (works offline).
 */
import { buildDisplayList, serializeDoc, toSvg } from '@core'
import type { Doc, Id } from '@core/types'
import type { Editor2DHandle, Engine3DHandle } from '@/contracts'

export function fileName(title: string, suffix: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in file names
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'plan'
  return `${base}${suffix}`
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** the 2D plan as it is drawn on the page, at 2 px per centimetre of the plan (1:50 on screen) */
export function planPng(editor: Editor2DHandle): Promise<Blob> {
  return editor.snapshotPng(200)
}

async function rasterize(svg: string, widthMm: number, heightMm: number, pxPerMm: number): Promise<HTMLCanvasElement> {
  const w = Math.max(1, Math.round(widthMm * pxPerMm))
  const h = Math.max(1, Math.round(heightMm * pxPerMm))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('SVG'))
      im.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')
    if (!g) throw new Error('Canvas 2D unavailable')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, w, h)
    g.drawImage(img, 0, 0, w, h)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** the page a plan of this size goes on: A4, else A3, at 1:100 when it fits (paper mm) */
export function pdfLayout(widthMm: number, heightMm: number): { page: [number, number]; x: number; y: number; w: number; h: number } {
  const landscape = widthMm >= heightMm
  const sheets: [number, number][] = landscape
    ? [
        [297, 210],
        [420, 297],
      ]
    : [
        [210, 297],
        [297, 420],
      ]
  const margin = 10
  const page = sheets.find(([pw, ph]) => widthMm <= pw - 2 * margin && heightMm <= ph - 2 * margin) ?? sheets[1]
  const k = Math.min(1, (page[0] - 2 * margin) / widthMm, (page[1] - 2 * margin) / heightMm)
  const w = widthMm * k
  const h = heightMm * k
  return { page, x: (page[0] - w) / 2, y: (page[1] - h) / 2, w, h }
}

/** the plan of the level with dimensions, areas and furniture, light theme, on an A4 / A3 page */
export async function planPdf(doc: Doc, levelId: Id, title: string): Promise<Blob> {
  const dl = buildDisplayList(doc, levelId, { dimensions: true, areas: true, furniture: true, labels: true, grid: false, titleBlock: true, theme: 'light' })
  const { svg, widthMm, heightMm } = toSvg(dl, { scale: 100, marginMm: 10, title })
  // a raster page: the browser draws the text with its own fonts (Cyrillic included)
  const canvas = await rasterize(svg, widthMm, heightMm, Math.min(8, 8000 / Math.max(widthMm, heightMm, 1)))
  const lay = pdfLayout(widthMm, heightMm)
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: lay.page[0] >= lay.page[1] ? 'landscape' : 'portrait', unit: 'mm', format: lay.page, compress: true })
  pdf.setProperties({ title, creator: 'doplan' })
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', lay.x, lay.y, lay.w, lay.h)
  return pdf.output('blob')
}

/** the 3D view as it is on the screen, sharper (up to twice the pixels, 4K at most) */
export function scenePng(engine: Engine3DHandle, host: HTMLElement): Promise<Blob> {
  const r = host.getBoundingClientRect()
  const k = Math.min(2, 3840 / Math.max(r.width, 1), 2160 / Math.max(r.height, 1))
  return engine.renderStill({ width: Math.max(16, Math.round(r.width * k)), height: Math.max(16, Math.round(r.height * k)), mode: 'realtime', format: 'png' })
}

export async function sceneGlb(engine: Engine3DHandle): Promise<Blob> {
  return new Blob([await engine.exportGlb()], { type: 'model/gltf-binary' })
}

export function planFile(doc: Doc): Blob {
  return new Blob([serializeDoc(doc)], { type: 'application/json' })
}
