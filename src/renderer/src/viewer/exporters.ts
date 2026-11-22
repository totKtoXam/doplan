/**
 * Files a visitor can take away from a published plan: the 2D plan as PNG, the plan with dimensions
 * as PDF, the 3D view as PNG, the scene as GLB and — when the author allowed it — the plan itself.
 * Everything is made in the browser from what is on the page (works offline).
 */
import { buildDisplayList, serializeDoc, toSvg } from '@core'
import type { Doc, Id } from '@core/types'
import type { Editor2DHandle, Engine3DHandle } from '@/contracts'
import { mapStrings } from '@shared/pagesSite'

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

/** drawing scales a plan is printed at, the first whose sheet fits A3 wins */
export const PDF_SCALES = [100, 200, 250, 500, 1000] as const

/** the plan of the level with dimensions, areas and furniture, light theme, on an A4 / A3 page */
export async function planPdf(doc: Doc, levelId: Id, title: string): Promise<Blob> {
  // a true scale: a plan too big for A3 at 1:100 is drawn at 1:200 (…) and says so, never shrunk
  let sheet: ReturnType<typeof toSvg> | null = null
  for (const scale of PDF_SCALES) {
    const dl = buildDisplayList(doc, levelId, { dimensions: true, areas: true, furniture: true, labels: true, grid: false, titleBlock: true, theme: 'light', scale })
    sheet = toSvg(dl, { scale, marginMm: 10, title })
    if (pdfLayout(sheet.widthMm, sheet.heightMm).w >= sheet.widthMm - 0.01) break
  }
  if (!sheet) throw new Error('PDF')
  const { svg, widthMm, heightMm } = sheet
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
  return engine.renderStill({ width: Math.max(16, Math.round(r.width * k)), height: Math.max(16, Math.round(r.height * k)), format: 'png' })
}

export async function sceneGlb(engine: Engine3DHandle): Promise<Blob> {
  return new Blob([await engine.exportGlb()], { type: 'model/gltf-binary' })
}

/**
 * The plan as a .doplan another doplan opens: the author's own library entries (imported models and
 * materials, `custom`), which no visitor has, go into the document's own tables. Catalogue entries
 * do not: the visitor's app has them (or downloads them) by id, and a copy in the document would win
 * over its working one. The site's relative file URLs become absolute ones; planFile then carries
 * the library files themselves inside.
 */
export function downloadableDoc(doc: Doc, site: { materials?: unknown[]; assets?: unknown[] }, base: string): Doc {
  const abs = (s: string) => {
    if (!s.startsWith('./assets/')) return s
    try {
      return new URL(s, base).href
    } catch {
      return s
    }
  }
  const out = mapStrings(doc, abs)
  const embed = <T extends { id: string }>(table: Record<string, T>, list: unknown[] | undefined) => {
    const next = { ...table }
    for (const e of list ?? []) {
      const id = (e as { id?: unknown })?.id
      if (typeof id === 'string' && (e as { custom?: unknown }).custom === true && !Object.hasOwn(next, id)) next[id] = mapStrings(e as T, abs)
    }
    return next
  }
  return { ...out, materials: embed(out.materials ?? {}, site.materials), assets: embed(out.assets ?? {}, site.assets) }
}

/** one file larger than this stays a link to the site (a data: URL of it would bloat the plan file) */
const INLINE_MAX = 40 * 1024 * 1024
/**
 * all files inside together: past it the rest stay links. Their base64 is a third larger and goes
 * into one JSON string, which has a ceiling (about 512 M characters in V8); a phone runs out of
 * memory much earlier, so the budget is well below that.
 */
const INLINE_TOTAL = 120 * 1024 * 1024
/** files fetched at once: each is held as bytes, a binary string and base64 while it is converted */
const INLINE_PARALLEL = 3
const MIME: Record<string, string> = { glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ktx2: 'image/ktx2', hdr: 'image/vnd.radiance' }

async function dataUrl(b: Blob, url: string): Promise<string> {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''
  const type = MIME[ext] ?? (b.type || 'application/octet-stream')
  const bytes = new Uint8Array(await b.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(bin)}`
}

/**
 * The site's files the document points at (underlays, its own models and materials), carried inside
 * as data: URLs, so the plan opens in the desktop app (which loads no https files) and after the plan
 * is unpublished. A .gltf stays a link: its buffers and textures are separate files. A file that fails
 * to load, is too large, or would go past the total budget stays a link. Underlays come first (the
 * plan is traced over them), then materials, then models.
 */
export async function inlineSiteFiles(
  doc: Doc,
  base: string,
  load: (url: string) => Promise<Response> = (u) => fetch(u),
  budget: { file: number; total: number } = { file: INLINE_MAX, total: INLINE_TOTAL },
): Promise<Doc> {
  let root: string
  try {
    root = new URL('./assets/', base).href
  } catch {
    return doc
  }
  const urls = new Set<string>()
  const collect = (s: string) => {
    if (s.startsWith(root) && !/\.gltf(?:[?#]|$)/i.test(s)) urls.add(s)
    return s
  }
  mapStrings(doc.underlays, collect)
  mapStrings(doc.materials, collect)
  mapStrings(doc.assets, collect)
  const queue = [...urls]
  const data = new Map<string, string>()
  // bytes taken by files inside, and by files being fetched (their size as soon as it is known)
  let used = 0
  const fits = (n: number) => n <= budget.file && used + n <= budget.total
  const worker = async () => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      let held = 0
      try {
        const r = await load(u)
        if (!r.ok) continue
        const told = Number(r.headers.get('content-length'))
        if (told > 0 && !fits(told)) continue
        const b = await r.blob()
        if (!fits(b.size)) continue
        used += held = b.size
        data.set(u, await dataUrl(b, u))
        held = 0
      } catch {
        // stays a link
      } finally {
        used -= held
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(INLINE_PARALLEL, queue.length) }, worker))
  if (!data.size) return doc
  const swap = (s: string) => data.get(s) ?? s
  return { ...doc, underlays: mapStrings(doc.underlays, swap), assets: mapStrings(doc.assets, swap), materials: mapStrings(doc.materials, swap) }
}

export async function planFile(doc: Doc, base = typeof location !== 'undefined' ? location.href : ''): Promise<Blob> {
  return new Blob([serializeDoc(await inlineSiteFiles(doc, base))], { type: 'application/json' })
}
