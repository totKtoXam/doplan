/**
 * 3D measurements of the selected item, drawn as an HTML/SVG overlay over the canvas (always on top,
 * crisp, no effect on the scene or the outline):
 *  - clear distances from the footprint to the nearest walls (core `itemClearances`, as in 2D:
 *    green = measured wall, amber «≈» = the wall is not measured);
 *  - gaps to neighbouring items closer than 1.5 m (core `itemGaps`);
 *  - a W×D×H label above the item.
 * Lines lie just above the floor of the active level. Toggle: «Размеры мебели» (settings.showItemSizes).
 */
import * as THREE from 'three'
import { isHidden, itemClearances, itemGaps, type Vec2 } from '@core'
import type { DerivedPlan, Id, Item } from '@core/types'
import { formatLen } from '@/editor2d/format'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'

const OK = '#4cd08a'
const WARN = '#ffb547'
const FLOOR = 0.012 // m above the floor

interface Seg {
  a: Vec2
  b: Vec2
  text: string
  color: string
}

export interface Measure3D {
  /** re-project after the camera moved (call after each rendered frame) */
  update(): void
  dispose(): void
}

export function createMeasure3D(container: HTMLElement, camera: THREE.Camera): Measure3D {
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
  const root = document.createElement('div')
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2;font:600 11px/1 system-ui,sans-serif'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible')
  root.appendChild(svg)
  container.appendChild(root)

  let segs: Seg[] = []
  let size: { item: Item; text: string } | null = null
  let cacheKey: unknown[] = []
  const v = new THREE.Vector3()

  /** recomputes the measurements when the selection / document changed */
  function compute(): void {
    const ui = uiStore.getState()
    const ds = docStore.getState()
    const doc = ds.doc
    const sel = ui.selection.length === 1 && ui.selection[0].kind === 'item' ? doc.items[ui.selection[0].id as Id] : undefined
    const key = [sel, doc.items, doc.walls, ds.derived, doc.settings.showItemSizes, doc.settings.units, doc.groupFlags, doc.layers]
    if (key.length === cacheKey.length && key.every((k, i) => k === cacheKey[i])) return
    cacheKey = key
    segs = []
    size = null
    if (!sel || isHidden(doc, { kind: 'item', id: sel.id }) || !doc.settings.showItemSizes) return
    const units = doc.settings.units
    const plan = (ds.derived as Record<Id, DerivedPlan>)[sel.levelId]
    const clr = plan ? itemClearances(doc, plan, sel, 8000) : []
    {
      for (const c of clr) {
        if (c.dist < 1) continue
        segs.push({ a: c.from, b: c.to, text: c.reliable ? formatLen(c.dist, units) : `≈ ${formatLen(c.dist, units)}`, color: c.reliable ? OK : WARN })
      }
    }
    for (const g of itemGaps(sel, Object.values(doc.items), 1500, clr)) {
      if (g.dist < 1) continue
      segs.push({ a: g.from, b: g.to, text: formatLen(g.dist, units), color: OK })
    }
    const elev = sel.elevation > 0.5 ? `  ↑ ${formatLen(sel.elevation, units)}` : ''
    size = { item: sel, text: `${formatLen(sel.size.w, units)} × ${formatLen(sel.size.d, units)} × ${formatLen(sel.size.h, units)}${elev}` }
  }

  function project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null {
    v.set(x, y, z).project(camera)
    if (v.z < -1 || v.z > 1) return null
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h }
  }

  function label(text: string, x: number, y: number, color: string, big = false): HTMLDivElement {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);padding:${big ? '3px 7px' : '2px 5px'};border-radius:4px;background:rgba(20,24,31,.82);color:${color};white-space:nowrap;${big ? 'font-size:12px;' : ''}`
    return el
  }

  function update(): void {
    compute()
    while (root.lastChild && root.lastChild !== svg) root.removeChild(root.lastChild)
    svg.replaceChildren()
    if (!segs.length && !size) return
    const w = container.clientWidth
    const h = container.clientHeight
    camera.updateMatrixWorld()
    const parts: string[] = []
    for (const s of segs) {
      const p = project(s.a.x / 1000, FLOOR, s.a.y / 1000, w, h)
      const q = project(s.b.x / 1000, FLOOR, s.b.y / 1000, w, h)
      if (!p || !q) continue
      const dx = q.x - p.x
      const dy = q.y - p.y
      const l = Math.hypot(dx, dy)
      if (l < 4) continue
      const nx = (-dy / l) * 5
      const ny = (dx / l) * 5
      parts.push(
        `<g stroke="${s.color}" stroke-width="1.6" stroke-linecap="round"><line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke-dasharray="${s.color === WARN ? '5 3' : ''}"/>` +
          `<line x1="${p.x - nx}" y1="${p.y - ny}" x2="${p.x + nx}" y2="${p.y + ny}"/><line x1="${q.x - nx}" y1="${q.y - ny}" x2="${q.x + nx}" y2="${q.y + ny}"/></g>`,
      )
      if (l > 24) root.appendChild(label(s.text, (p.x + q.x) / 2, (p.y + q.y) / 2, s.color))
    }
    svg.innerHTML = parts.join('')
    if (size) {
      const it = size.item
      const top = project(it.x / 1000, (it.elevation + it.size.h) / 1000 + 0.12, it.y / 1000, w, h)
      if (top) root.appendChild(label(size.text, top.x, top.y, '#ffffff', true))
    }
  }

  // selection / document changes also redraw when no frame is rendered (on-demand rendering)
  let raf = 0
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0
      update()
    })
  }
  const unsubUi = uiStore.subscribe((s, p) => {
    if (s.selection !== p.selection) schedule()
  })
  const unsubDoc = docStore.subscribe((s, p) => {
    if (s.doc !== p.doc || s.derived !== p.derived) schedule()
  })

  return {
    update,
    dispose() {
      unsubUi()
      unsubDoc()
      if (raf) cancelAnimationFrame(raf)
      root.remove()
    },
  }
}
