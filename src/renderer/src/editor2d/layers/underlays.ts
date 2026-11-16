import { Container, Sprite, Texture } from 'pixi.js'
import type { Id, Underlay } from '@core/types'
import type { EditorCtx } from '../context'
import { DEG } from '../geom'

interface Entry {
  sprite: Sprite
  src: string
  texture: Texture | null
  token: number
}

async function loadImage(src: string): Promise<ImageBitmap | HTMLImageElement> {
  try {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return await createImageBitmap(blob)
  } catch {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`cannot load underlay image: ${src.slice(0, 80)}`))
      img.src = src
    })
    return img
  }
}

/** Background images for tracing: one Sprite per Underlay of the active level (world space). */
export class UnderlaysLayer {
  readonly container = new Container()
  private entries = new Map<Id, Entry>()
  private token = 0
  private lastUnderlays: unknown = null
  private lastLevel: Id | null = null

  constructor() {
    this.container.eventMode = 'none'
  }

  update(ctx: EditorCtx): void {
    const { doc } = ctx.view()
    const levelId = ctx.levelId()
    if (doc.underlays === this.lastUnderlays && levelId === this.lastLevel) return
    this.lastUnderlays = doc.underlays
    this.lastLevel = levelId

    const alive = new Set<Id>()
    for (const id in doc.underlays) {
      const u = doc.underlays[id]
      if (u.levelId !== levelId) continue
      alive.add(id)
      let e = this.entries.get(id)
      if (!e) {
        const sprite = new Sprite(Texture.EMPTY)
        sprite.eventMode = 'none'
        this.container.addChild(sprite)
        e = { sprite, src: '', texture: null, token: 0 }
        this.entries.set(id, e)
      }
      if (e.src !== u.src) this.load(ctx, e, u)
      this.apply(e, u)
    }
    for (const [id, e] of this.entries) {
      if (alive.has(id)) continue
      this.dispose(e)
      this.entries.delete(id)
    }
  }

  private apply(e: Entry, u: Underlay): void {
    const s = e.sprite
    s.position.set(u.x, u.y)
    s.rotation = u.rotation * DEG
    s.alpha = Math.min(1, Math.max(0, u.opacity))
    s.visible = u.visible && !!e.texture
    if (e.texture) {
      // the sprite must cover widthPx × heightPx document pixels even if the bitmap was resampled
      const tw = e.texture.width || u.widthPx || 1
      const th = e.texture.height || u.heightPx || 1
      s.scale.set((u.scale * (u.widthPx || tw)) / tw, (u.scale * (u.heightPx || th)) / th)
    }
  }

  private load(ctx: EditorCtx, e: Entry, u: Underlay): void {
    e.src = u.src
    const token = ++this.token
    e.token = token
    const id = u.id
    loadImage(u.src)
      .then((img) => {
        if (e.token !== token || this.entries.get(id) !== e) {
          if ('close' in img) img.close()
          return
        }
        const old = e.texture
        e.texture = Texture.from(img)
        e.sprite.texture = e.texture
        old?.destroy(true)
        const cur = ctx.doc().underlays[id]
        if (cur) this.apply(e, cur)
        ctx.requestRender()
      })
      .catch((err) => {
        console.warn('[doplan] underlay failed to load', err)
      })
  }

  private dispose(e: Entry): void {
    e.token = -1
    e.sprite.destroy()
    e.texture?.destroy(true)
  }

  destroy(): void {
    for (const e of this.entries.values()) this.dispose(e)
    this.entries.clear()
    this.container.destroy()
  }
}
