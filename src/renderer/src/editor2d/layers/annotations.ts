/**
 * Screen-space annotations redrawn every frame: room names / areas, item names, light symbols,
 * automatic inner dimensions, manual dimensions and text labels. Text never scales with the
 * wall geometry and is always upright.
 */
import { dimLabel, type EffectiveProvenance, itemClearances, itemGaps, type ItemGap, type Clearance, ROOM_TYPE_NAMES, roomEdgeRuns, roomMeasureStatus, runProvenance } from '@core'
import type { DerivedPlan, DerivedRoom, Doc, Item, Light, Vec2 } from '@core/types'
import { t } from '@/i18n'
import '@/ui/accuracyI18n'
import { accuracyStore } from '@/store/accuracy'
import type { EditorCtx } from '../context'
import { type BBox, bboxOf, bboxOverlap, DEG, dist, rectCorners } from '../geom'
import { formatArea, formatLen } from '../format'
import type { Painter } from '../painter'
import type { Palette } from '../theme'
import { dimensionNormal, itemCorners } from '../shapes'

interface AutoDim {
  /** run key (core/provenance) */
  key: string
  roomId: string
  a: Vec2
  b: Vec2
  /** unit normal pointing into the room */
  n: Vec2
  length: number
  box: BBox
  prov: EffectiveProvenance
}

function buildAutoDims(doc: Pick<Doc, 'walls'>, rooms: readonly DerivedRoom[]): AutoDim[] {
  const out: AutoDim[] = []
  for (const room of rooms) {
    for (const r of roomEdgeRuns(room)) {
      if (r.length < 150) continue
      out.push({ key: r.key, roomId: room.roomId, a: r.a, b: r.b, n: r.n, length: r.length, box: bboxOf([r.a, r.b]), prov: runProvenance(doc, r) })
    }
  }
  return out
}

/** colour / style of an automatic dimension by where its number comes from */
export function provenanceStyle(pal: Palette, p: Pick<EffectiveProvenance, 'source' | 'stale'>): { color: number; italic: boolean; alpha: number } {
  if (p.stale) return { color: pal.warn, italic: false, alpha: 1 }
  switch (p.source) {
    case 'measured':
      return { color: pal.ok, italic: false, alpha: 1 }
    case 'estimated':
      return { color: pal.textMuted, italic: true, alpha: 0.85 }
    case 'derived':
      return { color: pal.dimAuto, italic: true, alpha: 1 }
    default:
      return { color: pal.dimAuto, italic: false, alpha: 1 }
  }
}

const CLEARANCE_WARNING = 'размер стены не замерен: проверьте рулеткой (±1 см)'

const roomBoxes = new WeakMap<DerivedRoom, BBox>()

function roomBox(r: DerivedRoom): BBox {
  let b = roomBoxes.get(r)
  if (!b) {
    b = bboxOf(r.polygon)
    roomBoxes.set(r, b)
  }
  return b
}

export class AnnotationsLayer {
  private dimSource: unknown = null
  private dimWalls: unknown = null
  private autoDims: AutoDim[] = []
  private statusRooms: unknown = null
  private statusWalls: unknown = null
  private fullRooms = new Set<string>()
  private clrKey: unknown[] = []
  private clr: Clearance[] = []
  private gapKey: unknown[] = []
  private gaps: ItemGap[] = []

  draw(ctx: EditorCtx, p: Painter): void {
    const doc = ctx.doc()
    const derived = ctx.derived()
    const ui = ctx.ui()
    const pal = p.pal
    const cam = ctx.camera
    const scale = cam.scale
    const levelId = ctx.levelId()
    const st = doc.settings
    const view = cam.visibleBounds(40)
    const lang = ui.lang

    const acc = accuracyStore.getState()
    const surveying = ui.tool === 'survey'
    // ── automatic inner dimensions (styled by provenance) ──
    if (st.showDimensions || surveying) {
      if (this.dimSource !== derived.rooms || this.dimWalls !== doc.walls) {
        this.dimSource = derived.rooms
        this.dimWalls = doc.walls
        this.autoDims = buildAutoDims(doc, derived.rooms)
      }
      const hot = acc.target?.key ?? null
      for (const d of this.autoDims) {
        const isHot = d.key === hot || d.key === acc.hoverKey
        if (!isHot && d.length * scale < 46) continue
        if (!bboxOverlap(d.box, view)) continue
        const s = provenanceStyle(pal, d.prov)
        p.dimension(`ad:${d.roomId}:${d.key}`, d.a, d.b, d.n, 0, 15, dimLabel(formatLen(d.length, st.units), d.prov), {
          color: isHot ? pal.accent : s.color,
          alpha: isHot ? 1 : s.alpha,
          size: isHot ? 12 : 10.5,
          width: isHot ? 2 : 1,
          bold: isHot,
          italic: !isHot && s.italic,
          extension: false,
        })
      }
    }
    if (acc.legend) this.drawLegend(p)

    // rooms whose every dimension is measured
    if (this.statusRooms !== derived.rooms || this.statusWalls !== doc.walls) {
      this.statusRooms = derived.rooms
      this.statusWalls = doc.walls
      this.fullRooms.clear()
      for (const room of derived.rooms) if (roomMeasureStatus(doc, room).full) this.fullRooms.add(room.roomId)
    }

    // ── room labels ──
    for (const room of derived.rooms) {
      const box = roomBox(room)
      if (!bboxOverlap(box, view)) continue
      const wPx = (box.maxX - box.minX) * scale
      const hPx = (box.maxY - box.minY) * scale
      if (wPx < 54 || hPx < 30) continue
      const rec = doc.rooms[room.roomId]
      if (ctx.html.editingKey === `room:${room.roomId}`) continue
      let name = ''
      if (rec) name = rec.name || ROOM_TYPE_NAMES[rec.type]?.[lang] || ''
      const maxChars = Math.max(4, Math.floor(wPx / 7.2))
      if (name.length > maxChars) name = `${name.slice(0, maxChars - 1)}…`
      const s = cam.toScreen(room.labelPoint)
      const showArea = st.showAreas
      if (name) {
        p.stext(`rn:${room.roomId}`, name, s.x, s.y - (showArea ? 8 : 0), { size: 12.5, color: pal.text, bold: true })
      }
      if (showArea) {
        p.stext(`ra:${room.roomId}`, formatArea(room.area), s.x, s.y + (name ? 8 : 0), { size: 11, color: pal.textMuted })
      }
      if (this.fullRooms.has(room.roomId) && hPx > 54) {
        p.stext(`rm:${room.roomId}`, `✓ ${t('замерено полностью')}`, s.x, s.y + (name ? 8 : 0) + (showArea ? 15 : 8), {
          size: 10,
          color: pal.ok,
          bold: true,
        })
      }
    }

    // ── item names + lock marks ──
    if (st.showFurniture2d) {
      for (const id in doc.items) {
        const it = doc.items[id]
        if (it.levelId !== levelId || it.hidden) continue
        const wPx = it.size.w * scale
        const dPx = it.size.d * scale
        if (Math.max(wPx, dPx) < 26) continue
        const box = bboxOf(itemCorners(it))
        if (!bboxOverlap(box, view)) continue
        const bw = (box.maxX - box.minX) * scale
        const bh = (box.maxY - box.minY) * scale
        if (it.locked && bw > 26) {
          const c = cam.toScreen({ x: box.maxX, y: box.minY })
          const lx = c.x - 12
          const ly = c.y + 6
          p.g.roundRect(lx, ly + 3, 8, 6, 1).fill({ color: pal.textMuted, alpha: 0.95 })
          p.g
            .moveTo(lx + 1.5, ly + 3)
            .lineTo(lx + 1.5, ly + 1)
            .lineTo(lx + 4, ly - 1)
            .lineTo(lx + 6.5, ly + 1)
            .lineTo(lx + 6.5, ly + 3)
            .stroke({ width: 1.2, color: pal.textMuted })
        }
        if (bw < 64 || bh < 26 || scale < 0.045) continue
        const asset = ui.getAsset(it.assetId)
        let name = it.name || (lang === 'ru' ? asset?.nameRu || asset?.name : asset?.name || asset?.nameRu) || ''
        const sizes = st.showItemSizes && bh >= 40 ? `${formatLen(it.size.w, st.units)} × ${formatLen(it.size.d, st.units)}` : ''
        if (!name && !sizes) continue
        const maxChars = Math.floor(bw / 6.4)
        if (name.length > maxChars) name = `${name.slice(0, Math.max(1, maxChars - 1))}…`
        const c = cam.toScreen(it)
        if (name) p.stext(`in:${id}`, name, c.x, c.y - (sizes ? 7 : 0), { size: 10.5, color: pal.textMuted })
        if (sizes && sizes.length <= maxChars + 2) p.stext(`is:${id}`, sizes, c.x, c.y + (name ? 7 : 0), { size: 9.5, color: pal.textMuted, alpha: 0.85 })
      }
      // selected item: its own size and the distances to the walls around it
      const sel = ui.selection.length === 1 && ui.selection[0].kind === 'item' ? doc.items[ui.selection[0].id] : undefined
      if (sel && sel.levelId === levelId && !sel.hidden && st.showItemSizes) this.drawItemDims(ctx, p, sel, derived)
    }

    // ── lights ──
    for (const id in doc.lights) {
      const l = doc.lights[id]
      if (l.levelId !== levelId) continue
      if (l.x < view.minX || l.x > view.maxX || l.y < view.minY || l.y > view.maxY) continue
      this.drawLight(p, l)
    }

    // ── manual dimensions ──
    for (const id in doc.dimensions) {
      const d = doc.dimensions[id]
      if (d.levelId !== levelId) continue
      const length = dist(d.a, d.b)
      if (length < 1) continue
      p.dimension(`md:${id}`, d.a, d.b, dimensionNormal(d), d.offset, 0, formatLen(length, st.units), {
        color: pal.dim,
        size: 12,
        width: 1.2,
      })
    }

    // ── labels ──
    for (const id in doc.labels) {
      const l = doc.labels[id]
      if (l.levelId !== levelId) continue
      if (ctx.html.editingKey === `label:${id}`) continue
      const px = Math.min(400, l.size * scale)
      const s = cam.toScreen(l)
      if (s.x < -400 || s.y < -200 || s.x > cam.width + 400 || s.y > cam.height + 200) continue
      if (px < 4.5) {
        p.g.rect(s.x - 3, s.y - 1, 6, 2).fill({ color: pal.textMuted, alpha: 0.7 })
        continue
      }
      p.stext(`lb:${id}`, l.text, s.x, s.y, { size: px, color: pal.text, align: 'center' })
    }
  }

  private drawItemDims(ctx: EditorCtx, p: Painter, it: Item, derived: DerivedPlan): void {
    const doc = ctx.doc()
    const pal = p.pal
    const units = doc.settings.units
    const r = it.rotation * DEG
    const ux = { x: Math.cos(r), y: Math.sin(r) }
    const uy = { x: -Math.sin(r), y: Math.cos(r) }
    const hw = it.size.w / 2
    const hd = it.size.d / 2
    const at = (lx: number, ly: number): Vec2 => ({ x: it.x + ux.x * lx + uy.x * ly, y: it.y + ux.y * lx + uy.y * ly })
    // width along the front, depth along the right side (outside the footprint)
    p.dimension(`iw:${it.id}`, at(-hw, hd), at(hw, hd), uy, 0, 16, formatLen(it.size.w, units), { color: pal.accent, size: 11, bold: true })
    p.dimension(`id:${it.id}`, at(hw, -hd), at(hw, hd), ux, 0, 16, formatLen(it.size.d, units), { color: pal.accent, size: 11, bold: true })

    const key = [it, doc.walls, derived]
    if (key.length !== this.clrKey.length || key.some((k, i) => k !== this.clrKey[i])) {
      this.clrKey = key
      this.clr = itemClearances(doc, derived, it, 8000)
    }
    let unreliable = false
    for (const c of this.clr) {
      if (c.dist < 1) continue
      const d = { x: c.to.x - c.from.x, y: c.to.y - c.from.y }
      const l = Math.hypot(d.x, d.y)
      const n = { x: -d.y / l, y: d.x / l }
      if (!c.reliable) unreliable = true
      const color = c.reliable ? pal.ok : pal.warn
      const text = c.reliable ? formatLen(c.dist, units) : `${formatLen(c.dist, units)} ?`
      p.dimension(`ic:${it.id}:${c.dir}`, c.from, c.to, n, 0, 0, text, { color, size: 11, width: 1.2, extension: false, bold: true })
    }
    const gk = [it, doc.items, this.clr]
    if (gk.length !== this.gapKey.length || gk.some((k, i) => k !== this.gapKey[i])) {
      this.gapKey = gk
      this.gaps = itemGaps(it, Object.values(doc.items), 1500, this.clr)
    }
    for (const g of this.gaps) {
      if (g.dist < 1) continue
      const l = g.dist
      const n = { x: -(g.to.y - g.from.y) / l, y: (g.to.x - g.from.x) / l }
      p.dimension(`ig:${it.id}:${g.dir}`, g.from, g.to, n, 0, 0, formatLen(g.dist, units), { color: pal.ok, size: 11, width: 1.2, extension: false, bold: true })
    }
    if (unreliable) {
      const box = bboxOf(itemCorners(it))
      const s = ctx.camera.toScreen({ x: (box.minX + box.maxX) / 2, y: box.minY })
      p.sbadge(`icw:${it.id}`, `⚠ ${t(CLEARANCE_WARNING)}`, s.x, s.y - 34, { bg: pal.warn, color: 0x1b1300, size: 10.5 })
    }
  }

  /** legend of the dimension styles, bottom-left corner */
  private drawLegend(p: Painter): void {
    const pal = p.pal
    const cam = p.cam
    const rows: { label: string; sample: string; color: number; italic: boolean }[] = [
      { label: t('замерено рулеткой (±2 мм)'), sample: '✓ 3000', ...provenanceStyle(pal, { source: 'measured', stale: false }) },
      { label: t('с плана (±10 мм)'), sample: '3000', ...provenanceStyle(pal, { source: 'plan', stale: false }) },
      { label: t('выведено из площади (±20 мм)'), sample: '3000', ...provenanceStyle(pal, { source: 'derived', stale: false }) },
      { label: t('оценка по фото (±50 мм)'), sample: '≈ 3000', ...provenanceStyle(pal, { source: 'estimated', stale: false }) },
      { label: t('нарисовано, точность неизвестна'), sample: '3000', ...provenanceStyle(pal, { source: 'drawn', stale: false }) },
      { label: t('стену сдвинули после записи'), sample: '3000 ≠', ...provenanceStyle(pal, { source: 'drawn', stale: true }) },
    ]
    const x0 = 12
    const rowH = 17
    const h = rows.length * rowH + 30
    const y0 = cam.height - h - 40
    p.g.roundRect(x0, y0, 268, h, 6).fill({ color: pal.badgeBg, alpha: 0.82 })
    p.stext('lg:title', t('Откуда размеры'), x0 + 10, y0 + 14, { size: 11, color: 0xffffff, bold: true, anchorX: 0, anchorY: 0.5 })
    rows.forEach((r, i) => {
      const y = y0 + 34 + i * rowH
      p.g.moveTo(x0 + 10, y + 2).lineTo(x0 + 58, y + 2).stroke({ width: 1, color: r.color })
      p.stext(`lg:s${i}`, r.sample, x0 + 34, y, { size: 10, color: r.color, italic: r.italic, anchorY: 1 })
      p.stext(`lg:l${i}`, r.label, x0 + 68, y - 3, { size: 10.5, color: 0xd8dde6, anchorX: 0, anchorY: 0.5 })
    })
  }

  private drawLight(p: Painter, l: Light): void {
    const pal = p.pal
    const cam = p.cam
    const color = l.on ? pal.lightOn : pal.lightOff
    const s = cam.toScreen(l)
    const r = Math.min(15, Math.max(6, 110 * cam.scale))
    const g = p.g
    switch (l.kind) {
      case 'strip':
      case 'area': {
        const w = l.size?.w ?? (l.kind === 'strip' ? 1000 : 600)
        const d = l.size?.d ?? (l.kind === 'strip' ? 40 : 600)
        const c = rectCorners(l, w, Math.max(d, cam.mm(4)), l.rotation ?? 0).map((q) => cam.toScreen(q))
        const flat = [c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y]
        g.poly(flat, true).fill({ color, alpha: 0.3 })
        g.poly(flat, true).stroke({ width: 1.3, color })
        if (l.kind === 'area') {
          g.moveTo(c[0].x, c[0].y).lineTo(c[2].x, c[2].y).moveTo(c[1].x, c[1].y).lineTo(c[3].x, c[3].y).stroke({ width: 1, color, alpha: 0.7 })
        }
        break
      }
      case 'spot': {
        g.circle(s.x, s.y, r * 0.6).fill({ color, alpha: 0.35 })
        g.circle(s.x, s.y, r * 0.6).stroke({ width: 1.3, color })
        if (l.rotation !== undefined) {
          const a = l.rotation * DEG
          g.moveTo(s.x + Math.cos(a) * r * 0.6, s.y + Math.sin(a) * r * 0.6)
            .lineTo(s.x + Math.cos(a) * r * 1.5, s.y + Math.sin(a) * r * 1.5)
            .stroke({ width: 1.3, color })
        } else {
          g.circle(s.x, s.y, 1.5).fill({ color })
        }
        break
      }
      case 'pendant': {
        g.circle(s.x, s.y, r).fill({ color, alpha: 0.2 })
        g.circle(s.x, s.y, r).stroke({ width: 1.3, color })
        g.circle(s.x, s.y, r * 0.45).stroke({ width: 1.3, color })
        break
      }
      case 'point': {
        g.circle(s.x, s.y, r * 0.5).fill({ color, alpha: 0.5 })
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4
          g.moveTo(s.x + Math.cos(a) * r * 0.75, s.y + Math.sin(a) * r * 0.75).lineTo(s.x + Math.cos(a) * r * 1.2, s.y + Math.sin(a) * r * 1.2)
        }
        g.stroke({ width: 1.2, color })
        break
      }
      default: {
        // ceiling light: circle with a cross
        g.circle(s.x, s.y, r).fill({ color, alpha: 0.2 })
        g.circle(s.x, s.y, r).stroke({ width: 1.3, color })
        const k = r * 0.7071
        g.moveTo(s.x - k, s.y - k)
          .lineTo(s.x + k, s.y + k)
          .moveTo(s.x - k, s.y + k)
          .lineTo(s.x + k, s.y - k)
          .stroke({ width: 1.2, color })
        break
      }
    }
  }
}
