/**
 * Door / window placement: hovering a wall shows a ghost opening snapped to the wall (centre snap,
 * 50 mm steps) with distances to both wall ends; click places it using OPENING_DEFAULTS.
 */
import { addOpening, OPENING_DEFAULTS } from '@core'
import type { OpeningKind } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { add, mul } from '../geom'
import { formatLen } from '../format'
import type { WallHit } from '../hit'
import { buildOpeningSymbol, emptySymbol, isWindowKind } from '../layers/openings'
import type { Painter } from '../painter'
import { framePoint, openingFrame, openingRect } from '../shapes'
import { type OpeningPlacement, placeOpeningOnWall } from './common'
import type { Tool } from './types'

interface Ghost {
  hit: WallHit
  place: OpeningPlacement
  kind: OpeningKind
  hinge: 'a' | 'b'
  swing: 'left' | 'right'
}

export function createOpeningTool(ctx: EditorCtx, mode: 'door' | 'window'): Tool {
  let ghost: Ghost | null = null

  function kindFor(): OpeningKind {
    const k = uiStore.getState().openingKind
    const isWin = isWindowKind(k)
    if (mode === 'window') return isWin ? k : 'window'
    return isWin ? 'door' : k
  }

  function update(e: PointerInfo): void {
    const hit = ctx.hit.nearestWall(e.plan, ctx.mm(22))
    if (!hit) {
      ghost = null
      return
    }
    const kind = kindFor()
    const def = OPENING_DEFAULTS[kind] ?? OPENING_DEFAULTS.door
    const place = placeOpeningOnWall(ctx, hit, def.width, hit.t * hit.geom.length, { alt: e.alt })
    ghost = {
      hit,
      place,
      kind,
      hinge: place.offset <= hit.geom.length / 2 ? 'a' : 'b',
      swing: hit.side,
    }
  }

  function hint(): void {
    ctx.setHint(
      mode === 'door'
        ? t('Дверь: наведите на стену и щёлкните · сторона курсора задаёт направление открывания · Alt — без привязки')
        : t('Окно: наведите на стену и щёлкните · Alt — без привязки'),
    )
  }

  return {
    cursor: 'crosshair',

    activate() {
      ghost = null
      hint()
    },

    deactivate() {
      ghost = null
      ctx.setHint('')
    },

    pointerMove(e) {
      update(e)
      ctx.requestRender()
    },

    pointerDown(e) {
      if (e.button !== 0) return
      update(e)
      const g = ghost
      if (!g || !g.place.valid) return
      const def = OPENING_DEFAULTS[g.kind] ?? OPENING_DEFAULTS.door
      let created: string | null = null
      docStore.getState().transact(mode === 'door' ? t('Дверь') : t('Окно'), (d) => {
        created = addOpening(d, g.place.wallId, g.kind, g.place.offset, {
          hinge: g.hinge,
          swing: g.swing,
          ...(Math.abs(g.place.width - def.width) > 0.5 ? { width: g.place.width } : {}),
        })
      })
      const id = created as string | null
      if (id && docStore.getState().doc.openings[id]) uiStore.getState().select([{ kind: 'opening', id }])
      update(e)
      ctx.requestRender()
    },

    cancel() {
      return false
    },

    draw(p: Painter) {
      const g = ghost
      if (!g || !ctx.pointer.inside) return
      const pal = p.pal
      const doc = ctx.doc()
      const wall = doc.walls[g.hit.wallId]
      if (!wall) return
      const color = g.place.valid ? pal.accent : pal.danger
      const f = openingFrame(g.hit.geom, wall.thickness, g.place.offset, g.place.width)
      p.polygon(openingRect(f), { fill: color, fillAlpha: 0.3, stroke: color, width: 1.5 })
      const out = emptySymbol()
      buildOpeningSymbol({ kind: g.kind, width: g.place.width, hinge: g.hinge, swing: g.swing }, f.h, (s, k) => framePoint(f, s, k), out)
      p.segments(out.thin, color, 1, 0.7)
      p.segments(out.glass, color, 1, 0.9)
      p.segments(out.main, color, 1.5, 1)
      if (g.place.centred) p.diamond(f.c, 5, pal.guide, 2)

      // distances from the opening edges to the wall ends
      const units = doc.settings.units
      const left = g.place.offset - g.place.width / 2
      const right = g.hit.geom.length - g.place.offset - g.place.width / 2
      const side = g.swing === 'left' ? -1 : 1
      const a = g.hit.geom.a
      const n = mul(f.n, side)
      if (left > 1) {
        p.dimension('op-da', a, framePoint(f, -f.w2, 0), n, f.h, 14, formatLen(left, units), {
          color: g.place.centred ? pal.guide : pal.text,
          size: 11,
          bold: true,
        })
      }
      if (right > 1) {
        p.dimension('op-db', framePoint(f, f.w2, 0), add(a, mul(f.u, g.hit.geom.length)), n, f.h, 14, formatLen(right, units), {
          color: g.place.centred ? pal.guide : pal.text,
          size: 11,
          bold: true,
        })
      }
      p.dimension('op-dw', framePoint(f, -f.w2, 0), framePoint(f, f.w2, 0), n, f.h, 14, formatLen(g.place.width, units), {
        color,
        size: 11,
      })
    },
  }
}
