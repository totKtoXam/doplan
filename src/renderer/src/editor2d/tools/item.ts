/**
 * Item placement: a ghost footprint of the asset chosen in the catalog follows the cursor, snaps
 * to walls (back to the wall, rotation aligned), R rotates by 90°, click places; the tool stays
 * active for repeated placement until Esc.
 */
import { addItem } from '@core'
import type { Asset, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx } from '../context'
import { add, DEG, mul, normDeg, rectCorners } from '../geom'
import type { Painter } from '../painter'
import { itemFront } from '../shapes'
import { drawItemSketch, SegmentSketch, sketchKind } from '../symbols'
import { type ItemPlacement, placeItem } from './common'
import type { Tool } from './types'

export function createItemTool(ctx: EditorCtx): Tool {
  let rotation = 0
  let ghost: ItemPlacement | null = null
  let lastAssetId: string | null = null
  /** set once the user rotated manually: wall snapping then keeps the chosen orientation */
  let manual = false

  function asset(): Asset | undefined {
    const u = uiStore.getState()
    return u.placingAssetId ? u.getAsset(u.placingAssetId) : undefined
  }

  function hint(): void {
    const a = asset()
    ctx.setHint(
      a
        ? t('Щёлкните, чтобы поставить · R — повернуть на 90° · Shift — не поворачивать к стене · Alt — без привязки · Esc — закончить')
        : t('Выберите предмет в каталоге'),
    )
  }

  function update(plan: Vec2 | null, alt: boolean, shift: boolean): void {
    const a = asset()
    if (a?.id !== lastAssetId) {
      lastAssetId = a?.id ?? null
      manual = false
      rotation = 0
      hint()
    }
    if (!a || !plan) {
      ghost = null
      return
    }
    ghost = placeItem(ctx, { size: a.size, mount: a.mount, rotation }, a, plan, { alt, keepRotation: shift || manual })
  }

  return {
    cursor: 'crosshair',

    activate() {
      rotation = 0
      ghost = null
      lastAssetId = null
      manual = false
      hint()
    },

    deactivate() {
      ghost = null
      ctx.setHint('')
    },

    pointerMove(e) {
      update(e.plan, e.alt, e.shift)
      ctx.requestRender()
    },

    pointerDown(e) {
      if (e.button !== 0) return
      update(e.plan, e.alt, e.shift)
      const a = asset()
      const g = ghost
      if (!a || !g) return
      const levelId = ctx.levelId()
      let created: string | null = null
      docStore.getState().transact(t('Добавление предмета'), (d) => {
        created = addItem(d, levelId, a, g.x, g.y, { rotation: normDeg(g.rotation) })
      })
      const id = created as string | null
      if (id && docStore.getState().doc.items[id]) uiStore.getState().select([{ kind: 'item', id }])
      ctx.requestRender()
    },

    keyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false
      if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        rotation = normDeg(rotation + (e.shiftKey ? -90 : 90))
        manual = true
        update(ctx.pointer.plan, ctx.keys.alt, true)
        ctx.requestRender()
        return true
      }
      return false
    },

    cancel() {
      return false
    },

    draw(p: Painter) {
      const a = asset()
      const g = ghost
      if (!a || !g || !ctx.pointer.inside) return
      const pal = p.pal
      const c = { x: g.x, y: g.y }
      const corners = rectCorners(c, a.size.w, a.size.d, g.rotation)
      p.polygon(corners, { fill: pal.accent, fillAlpha: 0.2, stroke: pal.accent, width: 1.5 })
      const segs: number[] = []
      const sk = new SegmentSketch(segs)
      sk.setTransform(g.x, g.y, g.rotation * DEG, false)
      drawItemSketch(sketchKind(a), a.size.w, a.size.d, sk)
      p.segments(segs, pal.accent, 1, 0.8)
      // front marker
      const front = itemFront(g.rotation)
      const tip = add(c, mul(front, a.size.d / 2))
      p.line(tip, add(tip, mul(front, p.cam.mm(12))), pal.accent, 2)
      if (g.wallId) p.diamond(add(c, mul(front, -a.size.d / 2)), 4, pal.guide, 2)
    },
  }
}
