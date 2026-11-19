/**
 * The publish optimizer's image codec in the renderer: decode with the browser (JPEG / PNG / WebP),
 * downscale on an OffscreenCanvas with high-quality filtering, encode WebP. Pixels are taken as they
 * are (no colour-space conversion, no premultiplication), so normal and data maps keep their values.
 */
import type { FittedImage, ImageCodec, TextureUse } from './optimize'

/** WebP quality by use: normals show blockiness as lighting artefacts, colour hides it best */
const QUALITY: Record<TextureUse, number> = { color: 0.82, normal: 0.9, data: 0.85 }

export const browserCodec: ImageCodec = {
  async fit(data: Uint8Array, mime: string, maxPx: number, use: TextureUse): Promise<FittedImage | null> {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null
    let bmp: ImageBitmap
    try {
      bmp = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    } catch {
      return null
    }
    try {
      const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height, 1))
      const w = Math.max(1, Math.round(bmp.width * k))
      const h = Math.max(1, Math.round(bmp.height * k))
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')
      if (!g) return null
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(bmp, 0, 0, w, h)
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY[use] })
      if (blob.type !== 'image/webp') return null
      return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp' }
    } finally {
      bmp.close()
    }
  },
}
