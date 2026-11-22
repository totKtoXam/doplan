import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { FileFilter } from '../shared/ipc'
import { assertReadable, grantPath } from './access'
import { atomicWrite, cleanFileName, toArrayBuffer, toBytes } from './fsutil'
import { dropPrintPage, putPrintPage } from './protocol'
import { getMainWindow } from './window'

const MAX_READ_BYTES = 1024 * 1024 * 1024
let lastDir: string | null = null

function cleanFilters(filters: unknown): FileFilter[] {
  if (!Array.isArray(filters)) return []
  return filters
    .filter((f): f is FileFilter => !!f && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({
      name: f.name.slice(0, 80),
      extensions: f.extensions.filter((e): e is string => typeof e === 'string').map((e) => e.replace(/^\./, '').slice(0, 16)),
    }))
}

export async function pickFiles(filters: unknown, multi?: unknown): Promise<{ path: string; name: string }[]> {
  const w = getMainWindow()
  const opts: Electron.OpenDialogOptions = {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: cleanFilters(filters),
    defaultPath: lastDir ?? undefined,
  }
  const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled) return []
  if (res.filePaths[0]) lastDir = dirname(res.filePaths[0])
  return res.filePaths.map((p) => {
    grantPath(p)
    return { path: p, name: basename(p) }
  })
}

export async function readFileBytes(path: unknown): Promise<ArrayBuffer> {
  const full = await assertReadable(path)
  const st = await fsp.stat(full)
  if (st.size > MAX_READ_BYTES) throw new Error('Файл слишком большой')
  return toArrayBuffer(new Uint8Array(await fsp.readFile(full)))
}

export async function readFileText(path: unknown): Promise<string> {
  const full = await assertReadable(path)
  let text = await fsp.readFile(full, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

async function askSavePath(defaultName: unknown, filters: FileFilter[]): Promise<string | null> {
  const w = getMainWindow()
  const name = cleanFileName(typeof defaultName === 'string' ? defaultName : 'doplan')
  const opts: Electron.SaveDialogOptions = {
    defaultPath: join(lastDir ?? app.getPath('documents'), name),
    filters,
  }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  let path = res.filePath
  const exts = filters.flatMap((f) => f.extensions).filter((e) => e !== '*')
  if (exts.length && !exts.includes(extname(path).slice(1).toLowerCase())) path += `.${exts[0]}`
  lastDir = dirname(path)
  return path
}

export async function saveText(defaultName: unknown, filters: unknown, content: unknown): Promise<string | null> {
  const path = await askSavePath(defaultName, cleanFilters(filters))
  if (!path) return null
  await atomicWrite(path, typeof content === 'string' ? content : String(content ?? ''))
  grantPath(path)
  return path
}

export async function saveBinary(defaultName: unknown, filters: unknown, data: unknown): Promise<string | null> {
  const bytes = toBytes(data)
  const path = await askSavePath(defaultName, cleanFilters(filters))
  if (!path) return null
  await atomicWrite(path, bytes)
  grantPath(path)
  return path
}

const MAX_TEXT_FILES = 500

/**
 * Asks for a folder and writes several text files into it (DXF per album sheet). File names are
 * cleaned; an existing file of the same name is replaced. Returns the folder or null when cancelled.
 */
export async function saveTextFiles(title: unknown, files: unknown): Promise<string | null> {
  if (!Array.isArray(files) || !files.length || files.length > MAX_TEXT_FILES) throw new Error('Нет файлов для сохранения')
  const list = files.map((f) => {
    const o = (f && typeof f === 'object' ? f : {}) as { name?: unknown; content?: unknown }
    const name = cleanFileName(typeof o.name === 'string' ? o.name : 'file.txt')
    if (!name || name === '.' || name === '..') throw new Error('Некорректное имя файла')
    return { name, content: typeof o.content === 'string' ? o.content : String(o.content ?? '') }
  })
  const w = getMainWindow()
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title.slice(0, 120) : undefined,
    defaultPath: lastDir ?? app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }
  const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
  const dir = res.canceled ? undefined : res.filePaths[0]
  if (!dir) return null
  await fsp.mkdir(dir, { recursive: true })
  for (const f of list) {
    const p = join(dir, f.name)
    await atomicWrite(p, f.content)
    grantPath(p)
  }
  lastDir = dir
  return dir
}

function stripSvgProlog(svg: string): string {
  return svg
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim()
}

const MM_PER_INCH = 25.4

/** ids of one page of a multi-page PDF made unique (hatch patterns of every page are named h0, h1…) */
function prefixSvgIds(svg: string, prefix: string): string {
  return svg.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
}

const MAX_PDF_PAGES = 500

/**
 * Renders SVG pages into a to-scale PDF (every page = widthMm × heightMm, zero margins). One SVG
 * string makes a single-page PDF; an array makes one page per SVG (the technical project album).
 */
export async function exportPdf(svg: unknown, optsArg: unknown): Promise<string | null> {
  const opts = (optsArg && typeof optsArg === 'object' ? optsArg : {}) as {
    widthMm?: number
    heightMm?: number
    defaultName?: string
  }
  const w = Number(opts.widthMm)
  const h = Number(opts.heightMm)
  if (!(w > 0 && h > 0 && w < 20000 && h < 20000)) throw new Error('Некорректный размер страницы PDF')
  const pages = Array.isArray(svg) ? svg : [svg]
  if (!pages.length || pages.length > MAX_PDF_PAGES || pages.some((s) => typeof s !== 'string' || !s.includes('<svg'))) {
    throw new Error('Нет SVG для экспорта в PDF')
  }

  const path = await askSavePath(opts.defaultName ?? 'plan.pdf', [{ name: 'PDF', extensions: ['pdf'] }])
  if (!path) return null

  const wmm = +w.toFixed(3)
  const hmm = +h.toFixed(3)
  const multi = pages.length > 1
  const body = multi
    ? (pages as string[]).map((s, i) => `<div class="pg">${prefixSvgIds(stripSvgProlog(s), `p${i}-`)}</div>`).join('')
    : stripSvgProlog(pages[0] as string)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${wmm}mm ${hmm}mm; margin: 0; }
html, body { margin: 0; padding: 0; width: ${wmm}mm; ${multi ? '' : `height: ${hmm}mm; overflow: hidden; `}background: #fff; }
body > svg, .pg > svg { display: block; width: ${wmm}mm; height: ${hmm}mm; }
.pg { width: ${wmm}mm; height: ${hmm}mm; overflow: hidden; break-after: page; page-break-after: always; }
.pg:last-child { break-after: auto; page-break-after: auto; }
</style></head><body>${body}</body></html>`

  const token = randomBytes(12).toString('hex')
  const url = putPrintPage(token, html)
  const pxPerMm = 96 / MM_PER_INCH
  const win = new BrowserWindow({
    show: false,
    width: Math.max(200, Math.min(8000, Math.ceil(wmm * pxPerMm))),
    height: Math.max(200, Math.min(8000, Math.ceil(hmm * pxPerMm))),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      offscreen: false,
    },
  })
  try {
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadURL(url)
    const pdf = await win.webContents.printToPDF({
      pageSize: { width: wmm / MM_PER_INCH, height: hmm / MM_PER_INCH },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: true,
      landscape: false,
      scale: 1,
      pageRanges: multi ? undefined : '1',
      displayHeaderFooter: false,
    })
    await atomicWrite(path, new Uint8Array(pdf))
    grantPath(path)
    return path
  } finally {
    dropPrintPage(token)
    if (!win.isDestroyed()) win.destroy()
  }
}

export async function reveal(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path) return
  try {
    await fsp.access(path)
  } catch {
    return
  }
  // showItemInFolder only selects the item in Explorer, it never launches it
  shell.showItemInFolder(path)
}
