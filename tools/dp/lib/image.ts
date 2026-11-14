/** Node image IO for the dp CLI (sharp). Pure raster algorithms live in cv.ts. */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import sharp, { type Metadata, type Sharp } from 'sharp'
import type { Gray } from './cv'
import { DpError, errMsg } from './output'

/** Claude vision cost estimate: ⌈w/28⌉·⌈h/28⌉ visual tokens (high-resolution tier). */
export function visualTokens(w: number, h: number): number {
  return Math.ceil(w / 28) * Math.ceil(h / 28)
}

/** true if the image is seen 1:1 by the model (long edge ≤ 2576 and ≤ 4784 visual tokens). */
export function fitsHi(w: number, h: number): boolean {
  return Math.max(w, h) <= 2576 && visualTokens(w, h) <= 4784
}

/** largest size with the same aspect that fits the high-resolution tier */
export function hiTierSize(w: number, h: number): { width: number; height: number } {
  let s = Math.min(1, 2576 / Math.max(w, h))
  while (visualTokens(Math.round(w * s), Math.round(h * s)) > 4784) s *= 0.98
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

export function ensureFile(file: string): void {
  if (!existsSync(file)) throw new DpError(`file not found: ${file}`)
}

export function ensureDirFor(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

const UNSUPPORTED: Record<string, string> = {
  '.pdf': 'PDF is not supported by dp directly: export the page as PNG (e.g. print-screen or "Save as image", 200 dpi) and pass the PNG',
  '.heic': 'HEIC could not be decoded: convert it to JPEG/PNG first (iPhone: Settings → Camera → Formats → Most Compatible, or share as JPEG)',
  '.heif': 'HEIF could not be decoded: convert it to JPEG/PNG first',
}

/** Open an image with sharp, giving readable errors for PDF/HEIC/garbage. */
export async function openImage(file: string): Promise<Sharp> {
  ensureFile(file)
  const ext = extname(file).toLowerCase()
  if (ext === '.pdf') throw new DpError(UNSUPPORTED['.pdf'])
  const img = sharp(file, { limitInputPixels: 400_000_000 })
  try {
    await img.metadata()
  } catch (e) {
    throw new DpError(`cannot read image ${file}: ${errMsg(e)}`, 1, UNSUPPORTED[ext])
  }
  return img
}

export interface ImageInfo {
  file: string
  format: string
  width: number
  height: number
  /** size after applying EXIF orientation */
  orientedWidth: number
  orientedHeight: number
  exifOrientation: number
  rotatedByExif: boolean
  dpi?: number
  pages?: number
  channels?: number
  hasAlpha?: boolean
  space?: string
  fitsHi: boolean
  visualTokens: number
}

export async function imageInfo(file: string): Promise<ImageInfo> {
  const img = await openImage(file)
  let meta: Metadata
  try {
    meta = await img.metadata()
  } catch (e) {
    throw new DpError(`cannot read image ${file}: ${errMsg(e)}`)
  }
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  const orientation = meta.orientation ?? 1
  const swap = orientation >= 5 && orientation <= 8
  const ow = swap ? h : w
  const oh = swap ? w : h
  return {
    file,
    format: meta.format ?? 'unknown',
    width: w,
    height: h,
    orientedWidth: ow,
    orientedHeight: oh,
    exifOrientation: orientation,
    rotatedByExif: orientation !== 1,
    dpi: meta.density,
    pages: meta.pages,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    space: meta.space,
    fitsHi: fitsHi(ow, oh),
    visualTokens: visualTokens(ow, oh),
  }
}

/** Decode to an EXIF-oriented, alpha-flattened (white) PNG buffer. */
export async function decodeOriented(file: string): Promise<{ png: Buffer; width: number; height: number }> {
  const img = await openImage(file)
  const { data, info } = await img
    .rotate()
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer({ resolveWithObject: true })
  return { png: data, width: info.width, height: info.height }
}

/** Single-channel grey raw buffer. `maxSide` downsamples (keeping aspect) when the image is larger. */
export async function loadGray(input: string | Buffer, maxSide?: number): Promise<Gray & { scale: number }> {
  if (typeof input === 'string') ensureFile(input)
  let pipe = sharp(input, { limitInputPixels: 400_000_000 }).rotate().flatten({ background: '#ffffff' })
  const meta = await sharp(input).metadata()
  const orientation = meta.orientation ?? 1
  const swap = orientation >= 5 && orientation <= 8
  const w0 = (swap ? meta.height : meta.width) ?? 0
  const h0 = (swap ? meta.width : meta.height) ?? 0
  let scale = 1
  if (maxSide && Math.max(w0, h0) > maxSide) {
    scale = maxSide / Math.max(w0, h0)
    pipe = pipe.resize({ width: Math.max(1, Math.round(w0 * scale)), height: Math.max(1, Math.round(h0 * scale)), fit: 'fill' })
  }
  const { data, info } = await pipe.greyscale().raw().toBuffer({ resolveWithObject: true })
  // greyscale() may still output >1 channel for some inputs; keep the first channel
  const ch = info.channels
  let gray: Uint8Array
  if (ch === 1) gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  else {
    gray = new Uint8Array(info.width * info.height)
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * ch]
  }
  return { data: gray, width: info.width, height: info.height, scale }
}

/** Encode a single-channel grey buffer as PNG. */
export async function grayToPng(g: Gray): Promise<Buffer> {
  return sharp(Buffer.from(g.data.buffer, g.data.byteOffset, g.data.byteLength), {
    raw: { width: g.width, height: g.height, channels: 1 },
  })
    .png()
    .toBuffer()
}
