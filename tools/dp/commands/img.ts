/** `dp img …` — image preparation and reading aids for the vision model. */
import { writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'
import { type Args, parseNumList } from '../lib/args'
import {
  autoMaxThick,
  autoMinThick,
  estimateSkew,
  extractWalls,
  type Gray,
  type WallCandidate,
} from '../lib/cv'
import {
  canvasWithImage,
  drawGrid,
  drawMarker,
  haloText,
  LABEL_FONT,
  loadPng,
  niceStep,
  savePng,
} from '../lib/draw'
// relative path on purpose (see lib/core.ts): homography.ts is pure and does not pull the whole core index
import { orderQuad, planRectification, type Rectification } from '../../../src/core/homography'
import { decodeOriented, ensureDirFor, fitsHi, imageInfo, loadGray, visualTokens, warpPng } from '../lib/image'
import { type CommandResult, DpError, errMsg, r2, r4 } from '../lib/output'

// ───────────────────────── img info ─────────────────────────

export async function imgInfo(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const info = await imageInfo(file)
  return {
    data: { ok: true, ...info },
    text: [
      `${basename(file)}: ${info.format} ${info.width}x${info.height}` +
        (info.rotatedByExif ? ` (EXIF orientation ${info.exifOrientation} → ${info.orientedWidth}x${info.orientedHeight})` : ' (orientation ok)'),
      `dpi=${info.dpi ?? '?'} channels=${info.channels ?? '?'} alpha=${info.hasAlpha ? 'yes' : 'no'}`,
      `vision: ~${info.visualTokens} tokens, fits hi-res tier 1:1: ${info.fitsHi ? 'yes' : 'no (run img prep)'}`,
    ],
  }
}

// ───────────────────────── img prep ─────────────────────────

/** flat-field (divide by blurred background) + stretch: removes shadows / paper tint of photos */
async function enhanceGray(png: Buffer): Promise<Buffer> {
  const base = sharp(png).greyscale()
  const { data: g, info } = await base.clone().raw().toBuffer({ resolveWithObject: true })
  const sigma = Math.max(8, Math.round(Math.max(info.width, info.height) / 60))
  const { data: bg } = await sharp(png).greyscale().blur(sigma).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const out = Buffer.alloc(info.width * info.height)
  for (let i = 0; i < out.length; i++) {
    const v = g[i * ch]
    const b = Math.max(1, bg[i * ch])
    out[i] = Math.max(0, Math.min(255, Math.round((v / b) * 255)))
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
    .normalise({ lower: 1, upper: 99 })
    .png()
    .toBuffer()
}

interface PerspectiveInfo {
  /** TL, TR, BR, BL of the chosen rectangle in px of the original (EXIF-oriented) image */
  corners: number[][]
  /** rectified image size before the other prep steps */
  size: number[]
  /** margin kept around the rectangle (fraction of its size per side, clipped to the photo) */
  pad: number
  /** the rectangle in the rectified image: x, y, w, h (px) */
  rectPx: number[]
  /** the rectangle in work.png (only when no crop/deskew followed) */
  workRectPx?: number[]
  rectMm?: number[]
  /** mm per px of the rectified image (only with --rect-mm) */
  mmPerPx?: number
  /** mm per px of work.png (after the final resize) */
  workMmPerPx?: number
}

export async function imgPrep(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const outDir = resolve(a.req('out'))
  const maxSide = a.num('max', 2000)
  const minSide = a.num('min', 1000)
  const notes: string[] = []
  const transforms: Record<string, unknown>[] = []

  const info = await imageInfo(file)
  let { png, width, height } = await decodeOriented(file)
  if (info.rotatedByExif) transforms.push({ op: 'exifOrient', orientation: info.exifOrientation })

  // perspective rectification first: corners are px of the ORIGINAL (EXIF-oriented) image
  let perspective: PerspectiveInfo | undefined
  const corners = a.nums('perspective', 8)
  const rectMm = a.nums('rect-mm', 2)
  if (rectMm && !corners) throw new DpError('--rect-mm needs --perspective x1,y1,…,x4,y4')
  if (corners) {
    const quad = orderQuad([0, 2, 4, 6].map((i) => ({ x: corners[i], y: corners[i + 1] })))
    for (const p of quad) {
      if (p.x < -0.25 * width || p.y < -0.25 * height || p.x > 1.25 * width || p.y > 1.25 * height) {
        throw new DpError(
          `--perspective corner ${p.x},${p.y} is far outside the ${width}x${height} image`,
          1,
          'corners are px of the original image (after EXIF orientation): read them from `dp img grid` of the original',
        )
      }
    }
    if (rectMm && !(rectMm[0] > 0 && rectMm[1] > 0)) throw new DpError('--rect-mm expects W,H > 0 (mm)')
    const pad = a.num('pad', 0.1)
    if (!(pad >= 0 && pad <= 1)) throw new DpError('--pad expects a fraction 0…1 (0 = crop to the rectangle)')
    let plan: Rectification
    try {
      plan = planRectification(quad, width, height, {
        rectMm: rectMm ? { width: rectMm[0], height: rectMm[1] } : undefined,
        pad,
        maxSide: 8000,
      })
    } catch (e) {
      throw new DpError(`--perspective: ${errMsg(e)}`, 1, 'give the 4 corners of one rectangle (outer walls or the sheet frame), no three on a line')
    }
    const r = await warpPng(png, plan.quad, plan.width, plan.height)
    png = r.png
    width = r.width
    height = r.height
    const rectPx = [plan.rect.x, plan.rect.y, plan.rect.width, plan.rect.height].map(r2)
    perspective = {
      corners: quad.map((p) => [r2(p.x), r2(p.y)]),
      size: [width, height],
      pad,
      rectPx,
      ...(rectMm ? { rectMm: [rectMm[0], rectMm[1]], mmPerPx: plan.mmPerPx } : {}),
    }
    transforms.push({ op: 'perspective', corners: perspective.corners, size: [width, height], pad, rectPx, ...(rectMm ? { rectMm } : {}) })
    notes.push(
      `perspective rectified: ${perspective.corners.map((c) => c.join(',')).join(' ')} → ${width}x${height}, rectangle at ${rectPx.join(',')}` +
        (plan.mmPerPx ? ` (${r4(plan.mmPerPx)} mm/px before resize)` : ' (aspect estimated from the photo: give --rect-mm W,H for an exact one)'),
    )
  }

  const crop = a.nums('crop', 4)
  if (crop) {
    const [cx, cy, cw, ch] = crop.map((v) => Math.round(v))
    const left = Math.max(0, cx)
    const top = Math.max(0, cy)
    const w = Math.min(width - left, cw - (left - cx))
    const h = Math.min(height - top, ch - (top - cy))
    if (w < 8 || h < 8) throw new DpError(`--crop ${crop.join(',')} is outside the ${width}x${height} image`)
    const r = await sharp(png).extract({ left, top, width: w, height: h }).png().toBuffer({ resolveWithObject: true })
    png = r.data
    width = r.info.width
    height = r.info.height
    transforms.push({ op: 'crop', x: left, y: top, w, h })
  }

  let deskewDeg = 0
  const deskew = a.str('deskew')
  if (a.bool('deskew') || (deskew !== undefined && deskew !== 'off')) {
    let angle: number
    let confidence = 1
    const manual = deskew !== undefined ? Number(deskew.replace(',', '.')) : Number.NaN
    if (Number.isFinite(manual)) angle = manual
    else {
      const g = await loadGray(png, 900)
      const est = estimateSkew(g, a.num('deskew-max', 5), 0.1)
      angle = est.angle
      confidence = est.confidence
    }
    if (Math.abs(angle) >= 0.05) {
      const r = await sharp(png)
        .rotate(-angle, { background: '#ffffff' })
        .png()
        .toBuffer({ resolveWithObject: true })
      png = r.data
      width = r.info.width
      height = r.info.height
      deskewDeg = angle
      transforms.push({ op: 'rotate', deg: -angle, note: 'deskew; canvas expanded, white fill' })
      notes.push(`deskewed by ${r2(-angle)}° (confidence ${confidence})`)
    } else notes.push('deskew: drawing is already straight')
  }

  if (a.bool('contrast')) {
    png = await enhanceGray(png)
    transforms.push({ op: 'contrast', note: 'flat-field + normalise, greyscale' })
  } else if (a.bool('gray')) {
    png = await sharp(png).greyscale().png().toBuffer()
    transforms.push({ op: 'greyscale' })
  }

  let scale = 1
  const long = Math.max(width, height)
  if (long > maxSide) scale = maxSide / long
  else if (long < minSide && a.bool('upscale', true)) scale = Math.min(2, maxSide / long)
  if (scale !== 1) {
    const nw = Math.max(1, Math.round(width * scale))
    const nh = Math.max(1, Math.round(height * scale))
    const r = await sharp(png)
      .resize({ width: nw, height: nh, fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer({ resolveWithObject: true })
    png = r.data
    width = r.info.width
    height = r.info.height
    transforms.push({ op: 'scale', factor: r2(scale) })
    if (scale > 1) notes.push(`small image upscaled ×${r2(scale)}`)
  }

  if (perspective) {
    if (perspective.mmPerPx) perspective.workMmPerPx = perspective.mmPerPx / scale
    if (!transforms.some((t) => t.op === 'crop' || t.op === 'rotate')) perspective.workRectPx = perspective.rectPx.map((v) => r2(v * scale))
  }

  const outFile = join(outDir, 'work.png')
  ensureDirFor(outFile)
  writeFileSync(outFile, png)
  const prep = {
    source: file,
    work: outFile,
    sourceSize: [info.orientedWidth, info.orientedHeight],
    size: [width, height],
    deskewDeg,
    scale,
    transforms,
    ...(perspective ? { perspective } : {}),
    fitsHi: fitsHi(width, height),
    visualTokens: visualTokens(width, height),
  }
  writeFileSync(join(outDir, 'prep.json'), JSON.stringify(prep, null, 2))
  return {
    data: { ok: true, ...prep, notes },
    text: [
      `work: ${outFile} (${width}x${height}, ~${prep.visualTokens} tokens, fits hi-res: ${prep.fitsHi ? 'yes' : 'no'})`,
      `transforms: ${transforms.map((t) => t.op).join(' → ') || 'none'}`,
      ...notes,
      ...(perspective?.workMmPerPx
        ? [`work.png scale: ${r4(perspective.workMmPerPx)} mm/px (from --rect-mm; still confirm with a printed dimension: dp spec scale)`]
        : []),
      `next: dp img grid ${outFile} --out ${join(outDir, 'grid.png')}`,
    ],
  }
}

// ───────────────────────── img grid ─────────────────────────

export async function imgGrid(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const out = resolve(a.req('out'))
  const img = await loadPng(file)
  const step = a.num('step', 100)
  if (step < 5) throw new DpError('--step must be ≥ 5 px')
  const major = a.num('major', step >= 100 ? step * 5 : step * 4)
  const margin = a.num('margin', 64)
  const region = { x: 0, y: 0, w: img.width, h: img.height }
  const { canvas, ctx, ox, oy } = canvasWithImage(img, region, 1, margin)
  drawGrid(ctx, { ox, oy, scale: 1, region, step, major, margin, inner: a.bool('inner', true) })
  const saved = savePng(canvas, out)
  return {
    data: { ok: true, out: saved.file, size: [saved.width, saved.height], imageSize: [img.width, img.height], step, major, margin },
    text: [
      `grid: ${saved.file} (${saved.width}x${saved.height}); step ${step}px, major ${major}px; labels = px of ${basename(file)}`,
      `image origin is at canvas (${margin},${margin}) — always read coordinates from the printed numbers`,
    ],
  }
}

// ───────────────────────── img tiles / zoom ─────────────────────────

async function renderZoom(
  file: string,
  rect: { x: number; y: number; w: number; h: number },
  out: string,
  opts: { scale?: number; step?: number; target?: number; margin?: number },
): Promise<{ file: string; rect: number[]; scale: number; step: number; size: number[] }> {
  const img = await loadPng(file)
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const w = Math.min(img.width - x, Math.round(rect.w))
  const h = Math.min(img.height - y, Math.round(rect.h))
  if (w < 4 || h < 4) throw new DpError(`rect ${rect.x},${rect.y},${rect.w},${rect.h} is outside the ${img.width}x${img.height} image`)
  const target = opts.target ?? 1400
  const scale = opts.scale ?? Math.max(1, Math.min(8, target / Math.max(w, h)))
  const margin = opts.margin ?? 64
  const region = { x, y, w, h }
  const { canvas, ctx, ox, oy } = canvasWithImage(img, region, scale, margin)
  const step = opts.step ?? niceStep(scale, 45)
  const major = step * (step % 25 === 0 || step % 10 === 0 ? 5 : 4)
  drawGrid(ctx, { ox, oy, scale, region, step, major, margin, inner: true })
  const saved = savePng(canvas, out)
  return { file: saved.file, rect: [x, y, w, h], scale: r2(scale), step, size: [saved.width, saved.height] }
}

export async function imgTiles(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const outDir = resolve(a.req('out'))
  const n = (a.str('n') ?? '2x2').toLowerCase().split('x').map(Number)
  const cols = n[0]
  const rows = n[1] ?? n[0]
  if (!(cols >= 1 && rows >= 1 && cols <= 8 && rows <= 8)) throw new DpError('--n expects CxR, e.g. 2x2 or 3x2')
  const ov = Math.max(0, Math.min(0.5, a.num('overlap', 0.15)))
  const img = await loadPng(file)
  const tw = img.width / (cols - (cols - 1) * ov)
  const th = img.height / (rows - (rows - 1) * ov)
  const tiles = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round(c * tw * (1 - ov))
      const y = Math.round(r * th * (1 - ov))
      const rect = { x, y, w: Math.min(img.width - x, Math.round(tw)), h: Math.min(img.height - y, Math.round(th)) }
      const t = await renderZoom(file, rect, join(outDir, `tile_r${r + 1}_c${c + 1}.png`), {
        scale: a.num('scale'),
        step: a.num('step'),
        target: a.num('target', 1400),
      })
      tiles.push({ row: r + 1, col: c + 1, ...t })
    }
  }
  return {
    data: { ok: true, image: file, imageSize: [img.width, img.height], grid: [cols, rows], overlap: ov, tiles },
    text: [
      `${tiles.length} tiles of ${basename(file)} (labels in ORIGINAL px):`,
      ...tiles.map((t) => `  ${t.file}  rect=${t.rect.join(',')}  zoom×${t.scale}  step ${t.step}px`),
    ],
  }
}

export async function imgZoom(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const rect = a.nums('rect', 4)
  if (!rect) throw new DpError('missing required option --rect x,y,w,h')
  const out = resolve(a.req('out'))
  const t = await renderZoom(file, { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, out, {
    scale: a.num('scale'),
    step: a.num('step'),
    target: a.num('target', 1400),
  })
  return {
    data: { ok: true, image: file, ...t },
    text: [`zoom: ${t.file} rect=${t.rect.join(',')} zoom×${t.scale} step ${t.step}px (labels in ORIGINAL px)`],
  }
}

// ───────────────────────── img mark ─────────────────────────

export async function imgMark(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const out = resolve(a.req('out'))
  const pts = (a.req('points') ?? '')
    .split(';')
    .filter((s) => s.trim())
    .map((s) => parseNumList(s, '--points item', 2))
  const labels = (a.str('labels') ?? '').split(',').filter((s) => s.length > 0)
  const rects = (a.str('rects') ?? '')
    .split(';')
    .filter((s) => s.trim())
    .map((s) => parseNumList(s, '--rects item', 4))
  const img = await loadPng(file)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  rects.forEach((r, i) => {
    ctx.strokeStyle = '#0077ff'
    ctx.lineWidth = 2
    ctx.strokeRect(r[0], r[1], r[2], r[3])
    ctx.font = `bold 13px ${LABEL_FONT}`
    ctx.textBaseline = 'bottom'
    haloText(ctx, `R${i + 1}`, r[0] + 2, r[1] - 2, '#0077ff')
  })
  pts.forEach((p, i) => drawMarker(ctx, p[0], p[1], labels[i] ?? String(i + 1)))
  const saved = savePng(canvas, out)
  return {
    data: { ok: true, out: saved.file, points: pts, rects },
    text: [`marked ${pts.length} point(s), ${rects.length} rect(s): ${saved.file}`],
  }
}

// ───────────────────────── img lines (CV assist) ─────────────────────────

const CLUSTER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000']

export async function imgLines(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<file>'))
  const outJson = resolve(a.req('out'))
  const g: Gray = await loadGray(file)
  const minThick = a.num('min-thick', autoMinThick(g.width, g.height))
  const maxThick = a.num('max-thick', autoMaxThick(g.width, g.height))
  if (minThick < 1 || maxThick < minThick) throw new DpError('need 1 ≤ --min-thick ≤ --max-thick')
  const res = extractWalls(
    g,
    {
      minThick,
      maxThick,
      minLen: a.num('min-len'),
      gap: a.num('gap'),
      closePx: a.num('close', 0),
    },
    a.num('threshold'),
  )
  const walls = res.walls
  const payload = {
    ok: true,
    hint: 'HINTS ONLY: candidate axis-aligned wall bands detected by thresholding + run-lengths. Coordinates are px of the input image (centre-lines); thickness in px. Verify every candidate against the image before using it.',
    image: file,
    size: [g.width, g.height],
    threshold: res.threshold,
    minThick,
    maxThick,
    clusters: res.clusters,
    walls,
  }
  ensureDirFor(outJson)
  writeFileSync(outJson, JSON.stringify(payload, null, 2))

  let overlay: string | undefined
  const overlayPath = a.str('overlay')
  if (overlayPath) {
    const img = await loadPng(file)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, img.width, img.height)
    ctx.globalAlpha = 0.35
    ctx.drawImage(img, 0, 0)
    ctx.globalAlpha = 1
    drawCandidates(ctx, walls)
    overlay = savePng(canvas, resolve(overlayPath)).file
  }
  return {
    data: { ...payload, walls: walls.length, json: outJson, overlay },
    text: [
      `${walls.length} wall candidates (HINTS) → ${outJson}${overlay ? `, overlay ${overlay}` : ''}`,
      `threshold ${res.threshold}, thickness range ${minThick}–${maxThick}px`,
      `thickness clusters (px): ${res.clusters.map((c) => `${c.thickness}px×${c.count} (${c.lengthPx}px long)`).join(', ') || 'none'}`,
      ...(walls.length === 0
        ? ['no bands found: walls may be hollow double lines (try --close <wall px>) or thinner than --min-thick']
        : []),
    ],
  }
}

function drawCandidates(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, walls: WallCandidate[]): void {
  ctx.font = `bold 12px ${LABEL_FONT}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const w of walls) {
    const color = CLUSTER_COLORS[(w.cluster ?? 0) % CLUSTER_COLORS.length]
    ctx.globalAlpha = 0.55
    ctx.fillStyle = color
    const t = w.thickness
    if (w.orient === 'h') ctx.fillRect(Math.min(w.x1, w.x2), w.y1 - t / 2, Math.abs(w.x2 - w.x1), t)
    else ctx.fillRect(w.x1 - t / 2, Math.min(w.y1, w.y2), t, Math.abs(w.y2 - w.y1))
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(w.x1, w.y1)
    ctx.lineTo(w.x2, w.y2)
    ctx.stroke()
    haloText(ctx, w.id, (w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2, '#000000')
  }
}

// ───────────────────────── img paste (clipboard → file) ─────────────────────────

/** Saves the clipboard image to a PNG (images pasted into a chat are often not on disk). */
export async function imgPaste(a: Args): Promise<CommandResult> {
  const { spawnSync } = await import('node:child_process')
  const { existsSync, mkdirSync } = await import('node:fs')
  const outArg = a.str('out') ?? 'inbox'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = resolve(outArg.toLowerCase().endsWith('.png') ? outArg : join(outArg, `clipboard-${stamp}.png`))
  mkdirSync(resolve(out, '..'), { recursive: true })
  let res: ReturnType<typeof spawnSync>
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      "if ($img -eq $null) { Write-Output 'NOIMAGE'; exit 3 }",
      `$img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "Write-Output 'OK'",
    ].join('; ')
    res = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' })
  } else if (process.platform === 'darwin') {
    const script = `set f to (open for access POSIX file "${out}" with write permission)\nwrite (the clipboard as «class PNGf») to f\nclose access f`
    res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
  } else {
    res = spawnSync('sh', ['-c', `xclip -selection clipboard -t image/png -o > "${out}"`], { encoding: 'utf8' })
  }
  if (res.status !== 0 || !existsSync(out)) {
    throw new DpError(
      'no image in the clipboard (or clipboard access failed)',
      1,
      'ask the user to save the plan image into the inbox/ folder and give its path',
    )
  }
  const info = await imageInfo(out)
  return { data: { ok: true, out, size: [info.width, info.height] }, text: [`saved clipboard image → ${out} (${info.width}x${info.height})`] }
}
