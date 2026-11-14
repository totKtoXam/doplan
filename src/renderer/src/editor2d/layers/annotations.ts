/**
 * Screen-space annotations redrawn every frame: room names / areas, item names, light symbols,
 * automatic inner dimensions, manual dimensions and text labels. Text never scales with the
 * wall geometry and is always upright.
 */
import { ROOM_TYPE_NAMES } from '@core'
import type { DerivedRoom, Light, Vec2 } from '@core/types'
import type { EditorCtx } from '../context'
import { type BBox, bboxOf, bboxOverlap, DEG, dist, pointInPolygon, rectCorners } from '../geom'
import { formatArea, formatLen } from '../format'
import type { Painter } from '../painter'
import { dimensionNormal, itemCorners } from '../shapes'

interface AutoDim {
  a: Vec2
  b: Vec2
  /** unit normal pointing into the room */
  n: Vec2
  length: number
  box: BBox
}

function buildAutoDims(rooms: readonly DerivedRoom[]): AutoDim[] {
  const out: AutoDim[] = []
  for (const room of rooms) {
    // merge consecutive collinear edges (a wall face split by a T-junction on its other side)
    const runs: { a: Vec2; b: Vec2 }[] = []
    for (const e of room.edges) {
      const last = runs[runs.length - 1]
      if (last && dist(last.b, e.from) < 1) {
        const d1x = last.b.x - last.a.x
        const d1y = last.b.y - last.a.y
        const d2x = e.to.x - e.from.x
        const d2y = e.to.y - e.from.y
        const l1 = Math.hypot(d1x, d1y)
        const l2 = Math.hypot(d2x, d2y)
        if (l1 > 1 && l2 > 1 && Math.abs(d1x * d2y - d1y * d2x) / (l1 * l2) < 0.01 && d1x * d2x + d1y * d2y > 0) {
          last.b = e.to
          continue
        }
      }
      runs.push({ a: e.from, b: e.to })
    }
    for (const r of runs) {
      const dx = r.b.x - r.a.x
      const dy = r.b.y - r.a.y
      const l = Math.hypot(dx, dy)
      if (l < 150) continue
      let n = { x: -dy / l, y: dx / l }
      const m = { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 }
      const probe = { x: m.x + n.x * 8, y: m.y + n.y * 8 }
      const inside = pointInPolygon(probe, room.polygon) && !room.holes.some((h) => pointInPolygon(probe, h))
      if (!inside) n = { x: -n.x, y: -n.y }
      out.push({ a: r.a, b: r.b, n, length: l, box: bboxOf([r.a, r.b]) })
    }
  }
  return out
}

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
  private autoDims: AutoDim[] = []

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

    // ── automatic inner dimensions ──
    if (st.showDimensions) {
      if (this.dimSource !== derived.rooms) {
        this.dimSource = derived.rooms
        this.autoDims = buildAutoDims(derived.rooms)
      }
      let i = 0
      for (const d of this.autoDims) {
        i++
        if (d.length * scale < 46) continue
        if (!bboxOverlap(d.box, view)) continue
        p.dimension(`ad:${i}`, d.a, d.b, d.n, 0, 15, formatLen(d.length, st.units), {
          color: pal.dimAuto,
          size: 10.5,
          extension: false,
        })
      }
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
        if (!name) continue
        const maxChars = Math.floor(bw / 6.4)
        if (name.length > maxChars) name = `${name.slice(0, Math.max(1, maxChars - 1))}…`
        p.stext(`in:${id}`, name, cam.toScreen(it).x, cam.toScreen(it).y, { size: 10.5, color: pal.textMuted })
      }
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
