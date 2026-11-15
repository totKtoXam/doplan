/**
 * «Электроточка»: puts sockets, switches, low-voltage and cable outlets on the plan. Wall kinds
 * stick to the nearest wall face (facing the room) and show their distances to the room corners;
 * Alt places a point freely. The kind, posts and height come from the «Электрика» panel.
 */
import { ELECTRIC_KINDS, addElectric, electricBinding, electricType, nearestWallFace } from '@core'
import type { ElectricKind, ElectricPoint, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { drawElectricGlyph } from '../electricGlyph'
import { formatLen } from '../format'
import type { Painter } from '../painter'
import { snapToGrid } from '../snap'
import type { Tool } from './types'
import '@/ui/electricI18n'

/** optional UiState fields the «Электрика» panel sets (not part of the UiState contract) */
export interface ElectricToolState {
  electricKind?: ElectricKind
  electricGangs?: number
  /** mounting height override, mm (undefined: the catalog height of the kind) */
  electricElevation?: number
}

export function electricToolState(): ElectricToolState {
  return uiStore.getState() as unknown as ElectricToolState
}

interface Preview {
  point: ElectricPoint
  wallId?: string
  side?: 'left' | 'right'
}

export function createElectricTool(ctx: EditorCtx): Tool {
  let at: Preview | null = null

  function settings(): { kind: ElectricKind; gangs?: number; elevation?: number } {
    const s = electricToolState()
    const kind = s.electricKind && ELECTRIC_KINDS.includes(s.electricKind) ? s.electricKind : 'socket'
    const ty = electricType(kind)
    return {
      kind,
      gangs: ty.framed && s.electricGangs && s.electricGangs > 1 ? s.electricGangs : undefined,
      elevation: ty.mount === 'wall' && s.electricElevation !== undefined && Number.isFinite(s.electricElevation) ? s.electricElevation : undefined,
    }
  }

  function preview(e: PointerInfo): Preview {
    const { kind, gangs, elevation } = settings()
    const ty = electricType(kind)
    const doc = ctx.doc()
    const levelId = ctx.levelId()
    const base: ElectricPoint = {
      id: '',
      levelId,
      kind,
      mount: ty.mount,
      x: e.plan.x,
      y: e.plan.y,
      elevation: elevation ?? ty.elevation,
      rotation: 0,
    }
    if (gangs) base.gangs = gangs
    if (ty.mount === 'wall' && !e.alt) {
      const hit = nearestWallFace(doc, levelId, e.plan, Math.max(ctx.mm(40), 300))
      if (hit) {
        // a round distance along the face: 10 mm steps
        const w = doc.walls[hit.wallId]
        const a = doc.nodes[w.a]
        const b = doc.nodes[w.b]
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const k = Math.min(len, Math.max(0, Math.round(hit.t / 10) * 10)) - hit.t
        const pt: Vec2 = { x: hit.point.x + ((b.x - a.x) / len) * k, y: hit.point.y + ((b.y - a.y) / len) * k }
        return { point: { ...base, x: pt.x, y: pt.y, rotation: hit.rotation, wallId: hit.wallId, side: hit.side }, wallId: hit.wallId, side: hit.side }
      }
    }
    const g = snapToGrid(ctx, e.plan, e.alt)
    return { point: { ...base, x: g.x, y: g.y } }
  }

  function hint(): void {
    const { kind } = settings()
    const ty = electricType(kind)
    const name = uiStore.getState().lang === 'en' ? ty.en : ty.ru
    ctx.setHint(
      ty.mount === 'wall'
        ? `${name}: ${t('щёлкните у стены — точка встанет на её грань · Alt — без привязки · Esc — закончить')}`
        : `${name}: ${t('щёлкните, чтобы поставить · Esc — закончить')}`,
    )
  }

  return {
    cursor: 'crosshair',
    activate() {
      at = null
      hint()
    },
    deactivate() {
      at = null
      ctx.setHint('')
    },
    pointerMove(e) {
      at = preview(e)
      hint()
      ctx.requestRender()
    },
    pointerDown(e) {
      if (e.button !== 0) return
      const pv = preview(e)
      const { kind, gangs, elevation } = settings()
      const levelId = ctx.levelId()
      let created: string | null = null
      docStore.getState().transact(t('Электроточка'), (d) => {
        created = addElectric(d, levelId, kind, pv.point.x, pv.point.y, {
          wallId: pv.wallId,
          side: pv.side,
          gangs,
          elevation,
          // Alt or far from walls: a free point
          snap: 0,
        })
      })
      const id = created as string | null
      if (id && docStore.getState().doc.electrical?.[id]) uiStore.getState().select([{ kind: 'electric', id }])
    },
    cancel() {
      return false
    },
    draw(p: Painter) {
      if (!at || !ctx.pointer.inside) return
      drawElectricGlyph(p, at.point, { color: p.pal.electric, alpha: 0.75, width: 1.6 })
      if (!at.wallId) return
      const b = electricBinding(ctx.doc(), ctx.derived(), at.point)
      if (!b) return
      const units = ctx.doc().settings.units
      const o = { color: p.pal.electric, size: 11, bold: true }
      if (b.fromA >= 1) p.dimension('ept:a', b.a, b.foot, b.n, 0, 22, formatLen(b.fromA, units), o)
      if (b.fromB >= 1) p.dimension('ept:b', b.foot, b.b, b.n, 0, 22, formatLen(b.fromB, units), o)
    },
  }
}
