/**
 * From traced texels to the published picture: the light is smoothed within each chart (the sky
 * and occlusion rays leave a little noise), spread into the gaps around the charts (so filtering at
 * a chart's edge never reads black), and stored as 8-bit sRGB scaled by the page's own brightness,
 * which the viewer gives back as the light map's intensity.
 */

export interface Page {
  size: number
  /** 3 numbers per texel, linear */
  rgb: Float32Array
  /** chart of each texel, −1 where none */
  chart: Int32Array
}

/** one page from traced texels (index: row * size + column) */
export function pageOf(size: number, index: Int32Array, chartOf: Int32Array, rgb: Float32Array, valid: Uint8Array): Page {
  const out = new Float32Array(size * size * 3)
  const chart = new Int32Array(size * size).fill(-1)
  for (let i = 0; i < index.length; i++) {
    if (!valid[i]) continue
    const t = index[i]
    chart[t] = chartOf[i]
    out[t * 3] = rgb[i * 3]
    out[t * 3 + 1] = rgb[i * 3 + 1]
    out[t * 3 + 2] = rgb[i * 3 + 2]
  }
  return { size, rgb: out, chart }
}

/** a 3 × 3 average over the texels of the same chart */
export function smooth(page: Page): Page {
  const { size, rgb, chart } = page
  const out = new Float32Array(rgb.length)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = y * size + x
      const c = chart[t]
      if (c < 0) continue
      let r = 0
      let g = 0
      let b = 0
      let w = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
          const s = yy * size + xx
          if (chart[s] !== c) continue
          const k = dx === 0 && dy === 0 ? 2 : 1
          r += rgb[s * 3] * k
          g += rgb[s * 3 + 1] * k
          b += rgb[s * 3 + 2] * k
          w += k
        }
      out[t * 3] = r / w
      out[t * 3 + 1] = g / w
      out[t * 3 + 2] = b / w
    }
  return { size, rgb: out, chart }
}

/** fills `passes` rings of empty texels around the charts with the average of their filled neighbours */
export function dilate(page: Page, passes = 4): Page {
  const { size } = page
  let rgb = page.rgb
  let filled = new Uint8Array(size * size)
  for (let t = 0; t < filled.length; t++) filled[t] = page.chart[t] >= 0 ? 1 : 0
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(rgb)
    const nextFilled = new Uint8Array(filled)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const t = y * size + x
        if (filled[t]) continue
        let r = 0
        let g = 0
        let b = 0
        let w = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
            const s = yy * size + xx
            if (!filled[s]) continue
            r += rgb[s * 3]
            g += rgb[s * 3 + 1]
            b += rgb[s * 3 + 2]
            w++
          }
        if (!w) continue
        next[t * 3] = r / w
        next[t * 3 + 1] = g / w
        next[t * 3 + 2] = b / w
        nextFilled[t] = 1
      }
    rgb = next
    filled = nextFilled
  }
  return { size, rgb, chart: page.chart }
}

function toSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

/**
 * 8-bit RGBA (sRGB) and the scale that brings it back: the brightest 0.5 % of the charted texels
 * clip, so a sun patch does not leave the rest of the page with a few levels of grey.
 */
export function encode(page: Page): { rgba: Uint8ClampedArray; scale: number } {
  const { size, rgb, chart } = page
  const peaks: number[] = []
  for (let t = 0; t < size * size; t++) if (chart[t] >= 0) peaks.push(Math.max(rgb[t * 3], rgb[t * 3 + 1], rgb[t * 3 + 2]))
  peaks.sort((a, b) => a - b)
  const scale = Math.max(1e-4, peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.995))] : 1)
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let t = 0; t < size * size; t++) {
    rgba[t * 4] = Math.round(255 * toSrgb(Math.min(1, rgb[t * 3] / scale)))
    rgba[t * 4 + 1] = Math.round(255 * toSrgb(Math.min(1, rgb[t * 3 + 1] / scale)))
    rgba[t * 4 + 2] = Math.round(255 * toSrgb(Math.min(1, rgb[t * 3 + 2] / scale)))
    rgba[t * 4 + 3] = 255
  }
  return { rgba, scale }
}
