import { Container, Graphics } from 'pixi.js'
import type { TilePattern, Vec2 } from '@core/types'
import { type EditorCtx, sameInputs } from '../context'
import { DEG, hatchPolygon } from '../geom'
import { luminance, mixColor, multiplyColor, parseHex } from '../theme'

function flat(pts: readonly Vec2[]): number[] {
  const out: number[] = new Array(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    out[i * 2] = pts[i].x
    out[i * 2 + 1] = pts[i].y
  }
  return out
}

/** line families (angle offset in degrees, spacing in mm) hinting at a laying pattern */
function patternFamilies(p: TilePattern): { angle: number; spacing: number }[] {
  const w = Math.max(20, p.tileW)
  const h = Math.max(20, p.tileH)
  switch (p.type) {
    case 'none':
      return []
    case 'planks':
      return [{ angle: 0, spacing: h }]
    case 'brick':
    case 'brickThird':
      return [
        { angle: 0, spacing: h },
        { angle: 90, spacing: w },
      ]
    case 'herringbone':
    case 'chevron':
      return [
        { angle: 45, spacing: Math.min(w, h) * 1.4142 },
        { angle: -45, spacing: Math.min(w, h) * 1.4142 },
      ]
    case 'diagonal':
      return [
        { angle: 45, spacing: h },
        { angle: -45, spacing: w },
      ]
    case 'hex':
      return [
        { angle: 0, spacing: h },
        { angle: 60, spacing: h },
        { angle: -60, spacing: h },
      ]
    default:
      return [
        { angle: 0, spacing: h },
        { angle: 90, spacing: w },
      ]
  }
}

/** Room floor fills tinted by the floor material colour + a sparse laying-pattern hint (world space). */
export class RoomsLayer {
  readonly container = new Container()
  private fills = new Graphics()
  private pattern = new Graphics()
  private key: unknown[] = []
  /** smallest hatch spacing in mm; the hint is hidden when it gets denser than a few px */
  private minSpacing = Infinity

  constructor() {
    this.container.eventMode = 'none'
    this.fills.eventMode = 'none'
    this.pattern.eventMode = 'none'
    this.container.addChild(this.fills, this.pattern)
  }

  update(ctx: EditorCtx): void {
    const { doc, derived } = ctx.view()
    const ui = ctx.ui()
    const pal = ctx.palette()
    this.pattern.visible = this.minSpacing * ctx.camera.scale >= 7
    const key = [derived.rooms, doc.rooms, doc.materials, ui.catalog, pal]
    if (sameInputs(key, this.key)) return
    this.key = key

    const g = this.fills
    const pg = this.pattern
    g.clear()
    pg.clear()
    this.minSpacing = Infinity
    const segs: number[] = []

    for (const room of derived.rooms) {
      if (room.polygon.length < 3) continue
      const rec = doc.rooms[room.roomId]
      const finish = rec?.floor
      const mat = finish ? ui.getMaterial(finish.materialId) : undefined
      let color = pal.roomDefault
      if (mat) {
        let c = parseHex(mat.color, pal.roomDefault)
        if (finish?.tint) c = multiplyColor(c, parseHex(finish.tint, 0xffffff))
        // keep enough contrast with walls and text: blend the material colour into the paper colour
        const mixAmount = luminance(pal.bg) < 0.5 ? pal.roomMix * (0.55 + 0.45 * (1 - luminance(c))) : pal.roomMix
        color = mixColor(pal.roomDefault, c, mixAmount)
      }
      g.poly(flat(room.polygon), true).fill({ color })
      for (const hole of room.holes) {
        if (hole.length >= 3) g.poly(flat(hole), true).cut()
      }

      const pattern = finish?.pattern ?? mat?.pattern
      if (pattern && pattern.type !== 'none') {
        const rings = [room.polygon, ...room.holes]
        for (const fam of patternFamilies(pattern)) {
          const part = hatchPolygon(rings, (pattern.rotation + fam.angle) * DEG, fam.spacing, 0, 160)
          if (part.length) {
            for (const v of part) segs.push(v)
            // effective spacing after the line-count limiter
            this.minSpacing = Math.min(this.minSpacing, fam.spacing)
          }
        }
      }
    }

    if (segs.length) {
      for (let i = 0; i + 3 < segs.length; i += 4) pg.moveTo(segs[i], segs[i + 1]).lineTo(segs[i + 2], segs[i + 3])
      pg.stroke({ width: 1, color: pal.roomPattern, alpha: pal.roomPatternAlpha, pixelLine: true })
    }
    this.pattern.visible = this.minSpacing * ctx.camera.scale >= 7
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}
