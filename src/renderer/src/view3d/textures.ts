/**
 * Shared, ref-counted image store for material textures.
 * One decoded image per (url, max size); materials take cheap per-material THREE.Texture
 * wrappers around it (own repeat / rotation / colour space), so the pixels are decoded once.
 */
import * as THREE from 'three'

export type TexImage = ImageBitmap | HTMLImageElement

export interface SharedImage {
  readonly key: string
  readonly url: string
  /** resolves with the decoded image, or null when loading failed */
  readonly ready: Promise<TexImage | null>
  image: TexImage | null
  /** true when the image rows were flipped while decoding (ImageBitmap path) */
  flipped: boolean
  failed: boolean
  refs: number
}

/** `doplan-asset://…`, `data:`, `blob:`, `http(s):` stay as they are; bare relative paths belong to the bundled catalog */
export function resolveAssetUrl(src: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src
  return `doplan-asset://catalog/${src.replace(/^\.?\/+/, '')}`
}

async function decode(url: string, maxSize: number): Promise<{ image: TexImage; flipped: boolean }> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const probe = await createImageBitmap(blob)
    const scale = Math.min(1, maxSize / Math.max(probe.width, probe.height))
    const opts: ImageBitmapOptions = {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    }
    if (scale < 1) {
      opts.resizeWidth = Math.max(1, Math.round(probe.width * scale))
      opts.resizeHeight = Math.max(1, Math.round(probe.height * scale))
      opts.resizeQuality = 'high'
    }
    probe.close()
    const bmp = await createImageBitmap(blob, opts)
    return { image: bmp, flipped: true }
  } catch {
    // custom schemes that are not fetch-enabled still work through <img>
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`cannot load ${url}`))
      img.src = url
    })
    return { image: img, flipped: false }
  }
}

export class TextureStore {
  private images = new Map<string, SharedImage>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = 0
  private idleWaiters: (() => void)[] = []
  maxSize = 2048

  /** number of images still decoding */
  get loading(): number {
    return this.pending
  }

  acquire(src: string): SharedImage {
    const url = resolveAssetUrl(src)
    const key = `${url}|${this.maxSize}`
    let entry = this.images.get(key)
    if (!entry) {
      this.pending++
      const holder: { entry?: SharedImage } = {}
      const ready = decode(url, this.maxSize)
        .then((r) => {
          if (holder.entry) {
            holder.entry.image = r.image
            holder.entry.flipped = r.flipped
          }
          return r.image as TexImage | null
        })
        .catch((err) => {
          console.warn('[doplan] texture failed:', url, err)
          if (holder.entry) holder.entry.failed = true
          return null
        })
        .finally(() => {
          this.pending--
          if (this.pending === 0) {
            const w = this.idleWaiters
            this.idleWaiters = []
            for (const fn of w) fn()
          }
        })
      entry = { key, url, ready, image: null, flipped: false, failed: false, refs: 0 }
      holder.entry = entry
      this.images.set(key, entry)
    }
    const t = this.timers.get(key)
    if (t) {
      clearTimeout(t)
      this.timers.delete(key)
    }
    entry.refs++
    return entry
  }

  release(entry: SharedImage): void {
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0 || this.timers.has(entry.key)) return
    // delayed so that a rebuild that drops and re-requests a material does not re-decode
    const timer = setTimeout(() => {
      this.timers.delete(entry.key)
      if (entry.refs > 0) return
      // the bitmap is not closed explicitly: a texture that is still alive elsewhere keeps it usable,
      // otherwise the garbage collector frees it
      this.images.delete(entry.key)
    }, 8000)
    this.timers.set(entry.key, timer)
  }

  /** resolves when nothing is decoding (or after `timeoutMs`) */
  whenIdle(timeoutMs = 6000): Promise<void> {
    if (this.pending === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.idleWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const e of this.images.values()) {
      const img = e.image as ImageBitmap | null
      if (img && typeof (img as ImageBitmap).close === 'function') (img as ImageBitmap).close()
      e.image = null
    }
    this.images.clear()
  }
}

export interface TextureParams {
  srgb: boolean
  /** repeats per metre of UV (UVs are in metres) */
  repeat: [number, number]
  rotation?: number
  anisotropy: number
}

/** per-material texture wrapper around a decoded shared image */
export function makeTexture(image: TexImage, flipped: boolean, p: TextureParams): THREE.Texture {
  const tex = new THREE.Texture(image as unknown as HTMLImageElement)
  tex.flipY = !flipped
  applyTextureParams(tex, p)
  tex.needsUpdate = true
  return tex
}

/** a 1×1 texture of one colour (bytes; sRGB when `p.srgb`) sampled like a real map with the same params */
export function placeholderTexture(rgb: [number, number, number], p: TextureParams): THREE.Texture {
  const tex = new THREE.DataTexture(new Uint8Array([rgb[0], rgb[1], rgb[2], 255]), 1, 1)
  applyTextureParams(tex, p)
  tex.name = 'placeholder'
  tex.needsUpdate = true
  return tex
}

export function applyTextureParams(tex: THREE.Texture, p: TextureParams): void {
  tex.colorSpace = p.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(p.repeat[0], p.repeat[1])
  tex.center.set(0, 0)
  tex.rotation = p.rotation ?? 0
  tex.anisotropy = p.anisotropy
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
}
