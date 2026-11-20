/**
 * The publish optimizer's image codec in the renderer: decode with the browser (JPEG / PNG / WebP),
 * downscale on an OffscreenCanvas with high-quality filtering, encode WebP.
 *
 * - Colour pictures are brought to sRGB (a Display P3 or Adobe RGB photo keeps its colours, the
 *   profile is not carried over) and encoded lossy.
 * - Normal and packed data maps (roughness / AO / metalness in one picture) are taken as they are
 *   (no colour conversion) and encoded losslessly: lossy WebP halves the colour resolution, which
 *   bends normals and lets the packed channels bleed into each other.
 * - A picture with any transparent pixel is left as it is: the canvas keeps pixels premultiplied, so
 *   the colour under a fully transparent pixel would come back black (dark fringes on cut-outs, black
 *   models where an opaque material ignores a junk alpha channel).
 */
import type { FittedImage, ImageCodec, TextureUse } from './optimize'

/** WebP quality by use; 1 is lossless in Chromium */
const QUALITY: Record<TextureUse, number> = { color: 0.82, normal: 1, data: 1 }

function hasTransparency(g: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
  const px = g.getImageData(0, 0, w, h).data
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true
  return false
}

export const browserCodec: ImageCodec = {
  async fit(data: Uint8Array, mime: string, maxPx: number, use: TextureUse): Promise<FittedImage | null> {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null
    let bmp: ImageBitmap
    try {
      bmp = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }), {
        colorSpaceConversion: use === 'color' ? 'default' : 'none',
        premultiplyAlpha: 'none',
      })
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
      // JPEG has no alpha; PNG and WebP may
      if (mime !== 'image/jpeg' && hasTransparency(g, w, h)) return null
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY[use] })
      if (blob.type !== 'image/webp') return null
      return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp' }
    } finally {
      bmp.close()
    }
  },
}
