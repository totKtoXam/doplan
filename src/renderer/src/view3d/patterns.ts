/**
 * Procedural laying patterns (tiles + grout, parquet, planks) baked into a periodic canvas
 * texture set: albedo, tangent-space normal (bevelled tile edges) and roughness (rougher grout).
 * The result is plain texture data, so raster, path tracer and GLB export share one code path.
 *
 * Everything is laid out in millimetres inside one rectangular period; the canvases tile
 * seamlessly with RepeatWrapping and `repeat = 1000 / periodMm` (UVs are in metres).
 */
import type { TilePattern } from '@core/types'

export interface PatternTile {
  /** outline in mm, already inset by half the grout width */
  poly: [number, number][]
  cx: number
  cy: number
  /** direction of the tile's long axis, radians (canvas space) */
  angle: number
  id: number
  alt: boolean
}

export interface PatternLayout {
  tiles: PatternTile[]
  /** size of one seamless period, mm */
  periodMm: [number, number]
  /** extra rotation of the whole pattern, degrees (diagonal, herringbone) */
  extraRotation: number
  /** canvas size, px */
  width: number
  height: number
  grout: number
}

export interface PatternSource {
  image: CanvasImageSource & { width: number; height: number }
  /** image rows are stored bottom-up (ImageBitmap decoded with flipY) */
  flipped: boolean
}

export interface PatternPaintInput {
  pattern: TilePattern
  /** base colour multiplied into every tile, '#rrggbb' */
  color: string
  roughness: number
  /** real-world size covered by the source images, mm */
  sizeMm: [number, number]
  colorSrc?: PatternSource | null
  normalSrc?: PatternSource | null
  /** grey image, white = rough */
  roughSrc?: PatternSource | null
}

export interface PatternCanvases {
  albedo: HTMLCanvasElement
  normal: HTMLCanvasElement
  roughness: HTMLCanvasElement
}

// ───────────────────────────── layout ─────────────────────────────

function rectTile(x: number, y: number, w: number, h: number, g: number, id: number, alt = false, angle?: number): PatternTile {
  const i = g / 2
  return {
    poly: [
      [x + i, y + i],
      [x + w - i, y + i],
      [x + w - i, y + h - i],
      [x + i, y + h - i],
    ],
    cx: x + w / 2,
    cy: y + h / 2,
    angle: angle ?? (w >= h ? 0 : Math.PI / 2),
    id,
    alt,
  }
}

function reps(unit: number, target: number, min: number, max: number, multiple = 1): number {
  let n = Math.max(min, Math.min(max, Math.ceil(target / Math.max(1, unit))))
  if (n % multiple !== 0) n += multiple - (n % multiple)
  return n
}

function hash01(n: number, salt: number): number {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function layoutPattern(p: TilePattern, maxSize: number): PatternLayout {
  const w = Math.max(10, p.tileW)
  const h = Math.max(10, p.tileH)
  const g = Math.max(0, Math.min(p.grout, Math.min(w, h) * 0.4))
  const pw = w + g
  const ph = h + g
  const tiles: PatternTile[] = []
  let px = pw
  let py = ph
  let extraRotation = 0
  let id = 0
  const checker = !!p.altColor

  switch (p.type) {
    case 'diagonal':
    case 'grid': {
      const nx = reps(pw, 1200, 1, 16, checker ? 2 : 1)
      const ny = reps(ph, 1200, 1, 16, checker ? 2 : 1)
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) tiles.push(rectTile(i * pw, j * ph, pw, ph, g, id++, ((i + j) & 1) === 1))
      px = nx * pw
      py = ny * ph
      if (p.type === 'diagonal') extraRotation = 45
      break
    }
    case 'brick':
    case 'brickThird': {
      const k = p.type === 'brick' ? 2 : 3
      const nx = reps(pw, 1200, 1, 12)
      const ny = reps(ph, 900, k, 24, k)
      for (let j = 0; j < ny; j++) {
        const off = ((j % k) * pw) / k
        for (let i = 0; i < nx; i++) tiles.push(rectTile(i * pw + off, j * ph, pw, ph, g, id++, (j & 1) === 1))
      }
      px = nx * pw
      py = ny * ph
      break
    }
    case 'planks': {
      const nx = reps(pw, 2400, 2, 6)
      const ny = reps(ph, 1400, 3, 20)
      for (let j = 0; j < ny; j++) {
        const off = hash01(j, 17) * pw
        for (let i = 0; i < nx; i++) tiles.push(rectTile(i * pw + off, j * ph, pw, ph, g, id++, false, 0))
      }
      px = nx * pw
      py = ny * ph
      break
    }
    case 'basket': {
      const k = Math.max(1, Math.round(pw / ph))
      const block = pw
      const strip = block / k
      const n = reps(block, 600, 1, 8) * 2
      for (let by = 0; by < n; by++) {
        for (let bx = 0; bx < n; bx++) {
          const horizontal = ((bx + by) & 1) === 0
          for (let s = 0; s < k; s++) {
            if (horizontal) tiles.push(rectTile(bx * block, by * block + s * strip, block, strip, g, id++, false, 0))
            else tiles.push(rectTile(bx * block + s * strip, by * block, strip, block, g, id++, true, Math.PI / 2))
          }
        }
      }
      px = n * block
      py = n * block
      break
    }
    case 'herringbone': {
      // lattice v1 = (W, W), v2 = (L, -L); the rectangular period is 2L × 2L and holds 2k L-shaped pairs
      const L = pw
      const k = Math.max(1, Math.round(L / ph))
      const W = L / k
      const P = 2 * L
      const rep = L < 500 ? 2 : 1
      for (let ry = 0; ry < rep; ry++) {
        for (let rx = 0; rx < rep; rx++) {
          for (let m = 0; m < 2 * k; m++) {
            const ox = rx * P + m * W
            const oy = ry * P + m * W
            tiles.push(rectTile(ox, oy, L, W, g, id++, false, 0))
            tiles.push(rectTile(ox, oy + W, W, L, g, id++, true, Math.PI / 2))
          }
        }
      }
      px = P * rep
      py = P * rep
      extraRotation = 45
      break
    }
    case 'chevron': {
      const a = Math.PI / 4
      const t = Math.tan(a)
      const cw = w * Math.cos(a) + g
      const pitch = ph / Math.cos(a)
      const yi = g / 2 / Math.cos(a)
      const nxPairs = reps(2 * cw, 1000, 1, 8)
      const ny = reps(pitch, 1000, 2, 24)
      for (let c = 0; c < nxPairs * 2; c++) {
        const rising = (c & 1) === 0
        const x0 = c * cw
        const xa = x0 + g / 2
        const xb = x0 + cw - g / 2
        const rise = (x: number): number => (rising ? (x - x0) * t : (x0 + cw - x) * t)
        for (let j = 0; j < ny; j++) {
          const y0 = j * pitch
          const poly: [number, number][] = [
            [xa, y0 + yi + rise(xa)],
            [xb, y0 + yi + rise(xb)],
            [xb, y0 + pitch - yi + rise(xb)],
            [xa, y0 + pitch - yi + rise(xa)],
          ]
          tiles.push({
            poly,
            cx: x0 + cw / 2,
            cy: y0 + pitch / 2 + rise(x0 + cw / 2),
            angle: rising ? a : -a,
            id: id++,
            alt: !rising,
          })
        }
      }
      px = nxPairs * 2 * cw
      py = ny * pitch
      break
    }
    case 'hex': {
      const pitch = pw
      const rowH = (pitch / Math.sqrt(3)) * 1.5
      const r = w / Math.sqrt(3)
      const nx = reps(pitch, 900, 1, 24)
      const ny = reps(rowH, 900, 2, 24, 2)
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const cx = i * pitch + ((j & 1) * pitch) / 2 + pitch / 2
          const cy = j * rowH + rowH / 2
          const poly: [number, number][] = []
          for (let q = 0; q < 6; q++) {
            const ang = Math.PI / 6 + (q * Math.PI) / 3
            poly.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)])
          }
          tiles.push({ poly, cx, cy, angle: 0, id: id++, alt: ((i + j) & 1) === 1 })
        }
      }
      px = nx * pitch
      py = ny * rowH
      break
    }
    default: {
      tiles.push(rectTile(0, 0, pw, ph, g, id++))
      break
    }
  }

  // ~1 px per mm, limited by the per-preset texture budget
  const ppm = Math.min(1, maxSize / Math.max(px, py))
  const width = Math.max(64, Math.round((px * ppm) / 4) * 4)
  const height = Math.max(64, Math.round((py * ppm) / 4) * 4)
  return { tiles, periodMm: [px, py], extraRotation, width, height, grout: g }
}

// ───────────────────────────── painting ─────────────────────────────

export function createPatternCanvases(layout: PatternLayout): PatternCanvases {
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = layout.width
    c.height = layout.height
    return c
  }
  return { albedo: make(), normal: make(), roughness: make() }
}

function polyArea(poly: [number, number][]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    s += p[0] * q[1] - q[0] * p[1]
  }
  return s / 2
}

function grey(v: number): string {
  const g = Math.max(0, Math.min(255, Math.round(v * 255)))
  return `rgb(${g},${g},${g})`
}

/** (re)paints the three canvases; call again when the base images finish loading */
export function paintPattern(layout: PatternLayout, canvases: PatternCanvases, input: PatternPaintInput): void {
  const { pattern } = input
  const [px, py] = layout.periodMm
  const sx = layout.width / px
  const sy = layout.height / py
  const variation = Math.max(0, Math.min(1, pattern.variation ?? (input.colorSrc ? 0.12 : 0.06)))
  const groutRough = Math.min(1, Math.max(input.roughness + 0.3, 0.85))
  const bevelMm = Math.max(Math.min(layout.grout * 0.9, 3), 1.6 / Math.min(sx, sy))
  const tilt = layout.grout > 0.01 ? 0.5 : 0.28

  const ca = canvases.albedo.getContext('2d')
  const cn = canvases.normal.getContext('2d')
  const cr = canvases.roughness.getContext('2d')
  if (!ca || !cn || !cr) return
  const all = [ca, cn, cr]
  for (const c of all) {
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalCompositeOperation = 'source-over'
    c.globalAlpha = 1
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
  }
  ca.fillStyle = pattern.groutColor || '#b8b8b4'
  ca.fillRect(0, 0, layout.width, layout.height)
  cn.fillStyle = 'rgb(128,128,255)'
  cn.fillRect(0, 0, layout.width, layout.height)
  cr.fillStyle = grey(groutRough)
  cr.fillRect(0, 0, layout.width, layout.height)
  for (const c of all) c.setTransform(sx, 0, 0, sy, 0, 0)

  const patterns = new Map<CanvasRenderingContext2D, CanvasPattern | null>()
  const patternFor = (c: CanvasRenderingContext2D, src: PatternSource | null | undefined): CanvasPattern | null => {
    if (!src) return null
    if (!patterns.has(c)) patterns.set(c, c.createPattern(src.image, 'repeat'))
    return patterns.get(c) ?? null
  }
  const pa = patternFor(ca, input.colorSrc)
  const pn = patternFor(cn, input.normalSrc)
  const pr = patternFor(cr, input.roughSrc)

  const path = (c: CanvasRenderingContext2D, poly: [number, number][]): void => {
    c.beginPath()
    c.moveTo(poly[0][0], poly[0][1])
    for (let i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1])
    c.closePath()
  }
  /** fills the current clip with a random crop of a source image, oriented along the tile */
  const fillFromSource = (
    c: CanvasRenderingContext2D,
    pat: CanvasPattern,
    src: PatternSource,
    tile: PatternTile,
    radius: number,
  ): void => {
    const iw = src.image.width
    const ih = src.image.height
    const r1 = hash01(tile.id, 1)
    const r2 = hash01(tile.id, 2)
    const flip = hash01(tile.id, 3) > 0.5 ? Math.PI : 0
    c.save()
    c.translate(tile.cx, tile.cy)
    c.rotate(tile.angle + flip)
    c.scale(input.sizeMm[0] / iw, (input.sizeMm[1] / ih) * (src.flipped ? -1 : 1))
    c.translate(-r1 * iw, -r2 * ih)
    c.fillStyle = pat
    const rx = (radius * iw) / input.sizeMm[0] + iw
    const ry = (radius * ih) / input.sizeMm[1] + ih
    c.fillRect(r1 * iw - rx, r2 * ih - ry, rx * 2, ry * 2)
    c.restore()
  }

  for (const tile of layout.tiles) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of tile.poly) {
      minX = Math.min(minX, p[0])
      minY = Math.min(minY, p[1])
      maxX = Math.max(maxX, p[0])
      maxY = Math.max(maxY, p[1])
    }
    const radius = Math.hypot(maxX - minX, maxY - minY) / 2 + 2
    const ccw = polyArea(tile.poly) < 0
    // wrap-around copies so that the period is seamless
    const kx0 = Math.floor(minX / px)
    const kx1 = Math.floor(maxX / px)
    const ky0 = Math.floor(minY / py)
    const ky1 = Math.floor(maxY / py)
    for (let ky = ky0; ky <= ky1; ky++) {
      for (let kx = kx0; kx <= kx1; kx++) {
        const ox = -kx * px
        const oy = -ky * py
        for (const c of all) {
          c.save()
          c.translate(ox, oy)
          path(c, tile.poly)
          c.clip()
        }
        // albedo
        const useAlt = tile.alt && !!pattern.altColor
        if (useAlt) {
          ca.fillStyle = pattern.altColor as string
          ca.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
        } else if (pa && input.colorSrc) {
          fillFromSource(ca, pa, input.colorSrc, tile, radius)
          if (input.color.toLowerCase() !== '#ffffff') {
            ca.globalCompositeOperation = 'multiply'
            ca.fillStyle = input.color
            ca.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
            ca.globalCompositeOperation = 'source-over'
          }
        } else {
          ca.fillStyle = input.color
          ca.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
        }
        if (variation > 0) {
          const v = (hash01(tile.id, 4) - 0.5) * 2 * variation
          ca.globalAlpha = Math.min(0.6, Math.abs(v) * 0.6)
          ca.fillStyle = v > 0 ? '#ffffff' : '#000000'
          ca.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
          ca.globalAlpha = 1
        }
        // roughness
        if (pr && input.roughSrc && !useAlt) fillFromSource(cr, pr, input.roughSrc, tile, radius)
        else {
          cr.fillStyle = grey(input.roughness + (hash01(tile.id, 5) - 0.5) * 0.06)
          cr.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2)
        }
        // normal: base detail + bevel towards the grout
        if (pn && input.normalSrc && !useAlt) fillFromSource(cn, pn, input.normalSrc, tile, radius)
        cn.lineCap = 'butt'
        cn.lineWidth = bevelMm * 2
        for (let i = 0; i < tile.poly.length; i++) {
          const p = tile.poly[i]
          const q = tile.poly[(i + 1) % tile.poly.length]
          const ex = q[0] - p[0]
          const ey = q[1] - p[1]
          const el = Math.hypot(ex, ey) || 1
          // outward normal in canvas space (y down)
          // positive shoelace area in y-down space = clockwise on screen → (ey, -ex) points outward
          const sign = ccw ? -1 : 1
          const nx = (ey / el) * sign
          const ny = (-ex / el) * sign
          const r = Math.round((0.5 + 0.5 * nx * tilt) * 255)
          const gch = Math.round((0.5 - 0.5 * ny * tilt) * 255)
          const b = Math.round((0.5 + 0.5 * Math.sqrt(1 - tilt * tilt)) * 255)
          cn.strokeStyle = `rgb(${r},${gch},${b})`
          cn.beginPath()
          cn.moveTo(p[0], p[1])
          cn.lineTo(q[0], q[1])
          cn.stroke()
        }
        for (const c of all) c.restore()
      }
    }
  }
}

/** converts an ARM-packed image (AO, Roughness, Metalness) to a grey roughness image usable as a pattern source */
export function roughnessFromArm(src: PatternSource): PatternSource {
  const c = document.createElement('canvas')
  const w = Math.min(1024, src.image.width)
  const h = Math.min(1024, src.image.height)
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return src
  ctx.drawImage(src.image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  const d = data.data
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i + 1]
    d[i] = g
    d[i + 2] = g
    d[i + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return { image: c, flipped: src.flipped }
}

/**
 * Texture offset (in periods) that moves a laid pattern by (offsetX, offsetY) mm along the surface
 * axes. three applies `offset` after `rotation`, so the shift has to be rotated as well, otherwise a
 * diagonal or herringbone layout would slide along the tile edges instead of along the wall/floor.
 */
export function patternOffset(offsetX: number, offsetY: number, rotation: number, periodMm: [number, number]): [number, number] {
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  return [-(c * offsetX + s * offsetY) / periodMm[0], -(c * offsetY - s * offsetX) / periodMm[1]]
}
