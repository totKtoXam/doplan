/** Canvas drawing helpers (labelled coordinate grids, markers) on @napi-rs/canvas. */
import { writeFileSync } from 'node:fs'
import { type Canvas, createCanvas, type Image, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { decodeOriented, ensureDirFor } from './image'

export const LABEL_FONT = 'Arial, "Segoe UI", "DejaVu Sans", sans-serif'
export const GRID_MINOR = 'rgba(230, 0, 170, 0.28)'
export const GRID_MAJOR = 'rgba(230, 0, 170, 0.72)'
export const GRID_TEXT = '#b0007f'

/**
 * Load an image for drawing. File paths go through sharp first so the pixels are EXIF-oriented
 * (same coordinate frame as `img info` / `img prep`) and missing/unsupported files give readable errors.
 */
export async function loadPng(input: string | Buffer): Promise<Image> {
  if (typeof input === 'string') return loadImage((await decodeOriented(input)).png)
  return loadImage(input)
}

export function savePng(canvas: Canvas, file: string): { file: string; width: number; height: number } {
  ensureDirFor(file)
  writeFileSync(file, canvas.toBuffer('image/png'))
  return { file, width: canvas.width, height: canvas.height }
}

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]

/** smallest "nice" step (in source px) whose on-screen spacing is at least `minScreenPx` */
export function niceStep(scale: number, minScreenPx: number): number {
  for (const s of NICE) if (s * scale >= minScreenPx) return s
  return NICE[NICE.length - 1]
}

export interface GridRegion {
  /** region of the SOURCE image shown, in source px */
  x: number
  y: number
  w: number
  h: number
}

export interface GridOptions {
  /** where the region's top-left is drawn on the canvas, and the canvas px per source px */
  ox: number
  oy: number
  scale: number
  region: GridRegion
  /** grid spacing in source px */
  step: number
  /** major line spacing in source px (labelled inside the image) */
  major: number
  /** margin width around the image on the canvas */
  margin: number
  /** labels at major intersections inside the image */
  inner: boolean
  fontPx?: number
}

/**
 * Draws a pixel-coordinate grid over an image already drawn at (ox, oy) with `scale`.
 * All numbers are SOURCE-image px, so zoomed crops and tiles stay in global coordinates.
 */
export function drawGrid(ctx: SKRSContext2D, o: GridOptions): void {
  const fontPx = o.fontPx ?? 13
  const { region: r, scale, ox, oy } = o
  const x0 = Math.ceil(r.x / o.step) * o.step
  const y0 = Math.ceil(r.y / o.step) * o.step
  const toX = (v: number) => ox + (v - r.x) * scale
  const toY = (v: number) => oy + (v - r.y) * scale
  const right = ox + r.w * scale
  const bottom = oy + r.h * scale

  ctx.save()
  ctx.font = `${fontPx}px ${LABEL_FONT}`
  const maxLabel = String(Math.round(Math.max(r.x + r.w, r.y + r.h)))
  const labelW = ctx.measureText(maxLabel).width + 6
  // label every k-th line so horizontal labels never overlap
  let kx = 1
  while (o.step * kx * scale < labelW) kx++
  let ky = 1
  while (o.step * ky * scale < fontPx + 3) ky++

  const isMajor = (v: number) => Math.abs(v / o.major - Math.round(v / o.major)) < 1e-9
  for (let v = x0; v <= r.x + r.w; v += o.step) {
    const X = Math.round(toX(v)) + 0.5
    ctx.strokeStyle = isMajor(v) ? GRID_MAJOR : GRID_MINOR
    ctx.lineWidth = isMajor(v) ? 1.4 : 1
    ctx.beginPath()
    ctx.moveTo(X, oy)
    ctx.lineTo(X, bottom)
    ctx.stroke()
  }
  for (let v = y0; v <= r.y + r.h; v += o.step) {
    const Y = Math.round(toY(v)) + 0.5
    ctx.strokeStyle = isMajor(v) ? GRID_MAJOR : GRID_MINOR
    ctx.lineWidth = isMajor(v) ? 1.4 : 1
    ctx.beginPath()
    ctx.moveTo(ox, Y)
    ctx.lineTo(right, Y)
    ctx.stroke()
  }

  // margin labels on all four sides
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'middle'
  let i = 0
  for (let v = x0; v <= r.x + r.w; v += o.step, i++) {
    if (Math.round(v / o.step) % kx !== 0) continue
    const X = toX(v)
    const s = String(v)
    ctx.textAlign = 'center'
    ctx.fillStyle = isMajor(v) ? GRID_TEXT : '#222222'
    ctx.fillText(s, X, oy - o.margin / 2)
    ctx.fillText(s, X, bottom + o.margin / 2)
    // tick marks
    ctx.fillRect(X - 0.5, oy - 6, 1, 6)
    ctx.fillRect(X - 0.5, bottom, 1, 6)
  }
  for (let v = y0; v <= r.y + r.h; v += o.step) {
    if (Math.round(v / o.step) % ky !== 0) continue
    const Y = toY(v)
    const s = String(v)
    ctx.fillStyle = isMajor(v) ? GRID_TEXT : '#222222'
    ctx.textAlign = 'right'
    ctx.fillText(s, ox - 8, Y)
    ctx.textAlign = 'left'
    ctx.fillText(s, right + 8, Y)
    ctx.fillRect(ox - 6, Y - 0.5, 6, 1)
    ctx.fillRect(right, Y - 0.5, 6, 1)
  }

  // labels at major intersections inside the image: "x,y"
  if (o.inner) {
    const small = Math.max(10, fontPx - 2)
    ctx.font = `${small}px ${LABEL_FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const mx0 = Math.ceil(r.x / o.major) * o.major
    const my0 = Math.ceil(r.y / o.major) * o.major
    for (let vy = my0; vy <= r.y + r.h; vy += o.major) {
      for (let vx = mx0; vx <= r.x + r.w; vx += o.major) {
        const s = `${vx},${vy}`
        const tw = ctx.measureText(s).width
        const X = toX(vx) + 2
        const Y = toY(vy) + 2
        if (X + tw > right || Y + small > bottom) continue
        ctx.fillStyle = 'rgba(255,255,255,0.78)'
        ctx.fillRect(X - 1, Y - 1, tw + 2, small + 2)
        ctx.fillStyle = GRID_TEXT
        ctx.fillText(s, X, Y)
      }
    }
  }

  // frame
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 1
  ctx.strokeRect(ox - 0.5, oy - 0.5, r.w * scale + 1, r.h * scale + 1)
  ctx.restore()
}

/** white canvas with an image region drawn at `scale`, leaving `margin` on all sides */
export function canvasWithImage(
  img: Image,
  region: GridRegion,
  scale: number,
  margin: number,
): { canvas: Canvas; ctx: SKRSContext2D; ox: number; oy: number } {
  const W = Math.round(region.w * scale) + 2 * margin
  const H = Math.round(region.h * scale) + 2 * margin
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, region.x, region.y, region.w, region.h, margin, margin, region.w * scale, region.h * scale)
  return { canvas, ctx, ox: margin, oy: margin }
}

/** numbered marker (circle + label) */
export function drawMarker(ctx: SKRSContext2D, x: number, y: number, label: string, color = '#e6007e'): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 7, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - 11, y)
  ctx.lineTo(x + 11, y)
  ctx.moveTo(x, y - 11)
  ctx.lineTo(x, y + 11)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.font = `bold 13px ${LABEL_FONT}`
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  const tw = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(x + 9, y - 25, tw + 6, 17)
  ctx.fillStyle = color
  ctx.fillText(label, x + 12, y - 9)
  ctx.restore()
}

/** text with a white halo, for labels over drawings */
export function haloText(ctx: SKRSContext2D, text: string, x: number, y: number, color: string): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 4
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}
