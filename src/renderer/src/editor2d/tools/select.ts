/**
 * Select tool: click / shift-click / marquee selection and every direct-manipulation drag
 * (nodes, walls, openings along and between walls, items with wall snapping, lights, labels,
 * dimension offsets, resize / rotate handles, the 3D camera gizmo). Drags run as transient
 * transactions and become one history entry on pointer-up; Esc cancels.
 */
import {
  clampItemSize,
  type ItemPose,
  minItemSize,
  moveNode,
  moveOpening,
  nearestWallFace,
  placeElectricOnWall,
  clampOnFace,
  electricHalfWidth,
  detachElectric,
  layerIndex,
  pickableRefs,
  planResizeTargets,
  resizedParams,
  resizeFromFace,
  snapValue,
  wallFaceSegments,
} from '@core'
import type { Dimension, ElectricPoint, EntityRef, Id, Item, Opening, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { handles as appHandles } from '@/store/handles'
import { resizePrefs } from '@/store/resizePrefs'
import { uiStore } from '@/store/ui'
import type { EditorCtx, PointerInfo } from '../context'
import { add, cross, dist, dot, leftOf, lineLine, mid, mul, norm, normDeg, projectOnLine, sub } from '../geom'
import { formatAngle, formatLen, formatLenUnit } from '../format'
import { computeHandles, type Handle, handleAt, handleCursor } from '../handles'
import type { WallHit } from '../hit'
import type { Painter } from '../painter'
import { dimensionNormal, itemToLocal, itemToPlan } from '../shapes'
import { gridSteps, lengthStep, snapPoint, snapToGrid } from '../snap'
import { placeItem, placeOpeningOnWall, selectOnly, setHover, toggleSelection } from './common'
import type { Tool } from './types'
import { requestWallFrom } from './wallStart'

type Cam = { position: [number, number, number]; target: [number, number, number]; fov: number }

type Drag =
  | { type: 'none' }
  | { type: 'pending'; start: PointerInfo; hit: EntityRef | null; handle: Handle | null; wasSelected: boolean }
  | { type: 'marquee'; start: Vec2; cur: Vec2; additive: boolean }
  | { type: 'node'; nodeId: Id; grab: Vec2; excludeWalls: Set<Id> }
  | {
      type: 'move'
      start: Vec2
      primary: Vec2
      nodes: Map<Id, Vec2>
      points: { ref: EntityRef; x: number; y: number }[]
      dims: { id: Id; a: Vec2; b: Vec2 }[]
      single: Item | null
      excludeWalls: Set<Id>
      snapObjects: boolean
    }
  | {
      type: 'wallMid'
      wallId: Id
      start: Vec2
      /** end nodes with their start positions and, when the node has exactly one other wall, that wall's direction */
      a: { id: Id; p: Vec2; slide: Vec2 | null }
      b: { id: Id; p: Vec2; slide: Vec2 | null }
      u: Vec2
      n: Vec2
      excludeWalls: Set<Id>
    }
  | { type: 'opening'; id: Id; base: Opening; startWall: Id; grab: number }
  /** an electrical point: slides along wall faces (Alt: free) */
  | { type: 'electric'; id: Id; base: ElectricPoint; grab: Vec2 }
  | { type: 'openingEnd'; id: Id; base: Opening; end: 'a' | 'b' }
  | { type: 'itemResize'; id: Id; base: Item; sx: number; sy: number }
  | { type: 'itemRotate'; id: Id; base: Item }
  | { type: 'dimOffset'; id: Id; base: Dimension }
  | { type: 'camera'; start: Vec2; cam: Cam; targetOnly: boolean }

const MOVABLE = new Set(['wall', 'node', 'item', 'light', 'electric', 'label', 'dimension', 'underlay'])

export function createSelectTool(ctx: EditorCtx): Tool {
  let drag: Drag = { type: 'none' }
  let changed = false
  let badge: { at: Vec2; text: string } | null = null
  /** handle being dragged (highlighted by the overlay) */
  let dragHandle: Handle | null = null
  /** last plain click: repeated clicks on the same spot cycle through overlapping entities */
  let lastClick: { screen: Vec2; time: number; refs: EntityRef[]; index: number } | null = null

  const current = (): Drag => drag
  const doc = () => ctx.doc()
  const store = () => docStore.getState()
  const ui = () => uiStore.getState()

  function transient(label: string, fn: Parameters<ReturnType<typeof store>['transact']>[1]): void {
    store().transact(label, fn, { transient: true })
    changed = true
  }

  function wallsAtNodes(ids: Iterable<Id>): Set<Id> {
    const set = new Set(ids)
    const out = new Set<Id>()
    const d = doc()
    for (const id in d.walls) {
      const w = d.walls[id]
      if (set.has(w.a) || set.has(w.b)) out.add(id)
    }
    return out
  }

  /**
   * Direction of the only other wall at `nodeId` (pointing away from the node), used to slide the
   * node along that wall when the wall `wallId` is dragged sideways. Null for free ends and junctions.
   */
  function slideDirection(nodeId: Id, wallId: Id, u: Vec2): Vec2 | null {
    const d = doc()
    let other: Id | null = null
    for (const id in d.walls) {
      if (id === wallId) continue
      const w = d.walls[id]
      if (w.a !== nodeId && w.b !== nodeId) continue
      if (other) return null
      other = id
    }
    if (!other) return null
    const w = d.walls[other]
    const n0 = d.nodes[nodeId]
    const n1 = d.nodes[w.a === nodeId ? w.b : w.a]
    if (!n0 || !n1) return null
    const dir = norm(sub(n1, n0))
    // nearly collinear neighbours cannot be intersected reliably: translate instead
    return Math.abs(cross(dir, u)) < 0.17 ? null : dir
  }

  /** perpendicular drag of one wall; its single neighbours stay straight */
  function wallMidDrag(wallId: Id, start: Vec2): Extract<Drag, { type: 'wallMid' }> | null {
    const d = doc()
    const w = d.walls[wallId]
    const na = w && d.nodes[w.a]
    const nb = w && d.nodes[w.b]
    if (!w || !na || !nb || dist(na, nb) < 1) return null
    // an end shared with a locked wall (layers panel) stays put, so the wall cannot be dragged
    const vis = layerIndex(d)
    if (vis.locked('node', w.a) || vis.locked('node', w.b)) return null
    const u = norm(sub(nb, na))
    return {
      type: 'wallMid',
      wallId,
      start,
      a: { id: w.a, p: { x: na.x, y: na.y }, slide: slideDirection(w.a, wallId, u) },
      b: { id: w.b, p: { x: nb.x, y: nb.y }, slide: slideDirection(w.b, wallId, u) },
      u,
      n: leftOf(u),
      excludeWalls: wallsAtNodes([w.a, w.b]),
    }
  }

  /**
   * Hands the gesture over to the wall tool anchored at the node: it keeps receiving this pointer's
   * moves, places the first segment where the button is released and returns here when the chain ends.
   */
  function startWallDrag(nodeId: Id, press: PointerInfo): void {
    drag = { type: 'none' }
    dragHandle = null
    badge = null
    ctx.snapFeedback = null
    lastClick = null
    requestWallFrom(ctx, nodeId, { pressScreen: press.screen, returnToSelect: true })
  }

  /** status-bar hint for the current selection (a lone node advertises "continue the wall") */
  function selectionHint(): string {
    const sel = ui().selection
    if (sel.length === 1 && sel[0].kind === 'node') {
      return t('Узел: перетаскивание — переместить · «+» или Ctrl+перетаскивание — новая стена отсюда · W — продолжить стену')
    }
    return t('Щелчок — выбрать · Shift — добавить · перетаскивание — переместить или выделить рамкой')
  }

  function beginDrag(e: PointerInfo, pend: Extract<Drag, { type: 'pending' }>): void {
    const d = doc()
    const derived = ctx.derived()
    const h = pend.handle
    const start = pend.start.plan
    changed = false
    badge = null
    dragHandle = h

    if (h) {
      switch (h.type) {
        case 'node': {
          const n = d.nodes[h.nodeId]
          if (!n) break
          if (pend.start.ctrl) {
            startWallDrag(h.nodeId, pend.start)
            return
          }
          drag = { type: 'node', nodeId: h.nodeId, grab: sub(start, n), excludeWalls: wallsAtNodes([h.nodeId]) }
          return
        }
        case 'wallMid': {
          const wd = wallMidDrag(h.wallId, start)
          if (!wd) break
          drag = wd
          return
        }
        case 'openingEnd': {
          const o = d.openings[h.openingId]
          if (!o) break
          drag = { type: 'openingEnd', id: h.openingId, base: { ...o }, end: h.end }
          return
        }
        case 'itemResize': {
          const it = d.items[h.itemId]
          if (!it) break
          drag = { type: 'itemResize', id: h.itemId, base: { ...it, size: { ...it.size } }, sx: h.sx, sy: h.sy }
          return
        }
        case 'itemRotate': {
          const it = d.items[h.itemId]
          if (!it) break
          drag = { type: 'itemRotate', id: h.itemId, base: { ...it, size: { ...it.size } } }
          return
        }
        case 'dimOffset': {
          const dm = d.dimensions[h.dimId]
          if (!dm) break
          drag = { type: 'dimOffset', id: h.dimId, base: { ...dm } }
          return
        }
        case 'camera':
        case 'cameraTarget': {
          const engine = appHandles.engine3d
          if (!engine) break
          const c = engine.getCamera()
          drag = {
            type: 'camera',
            start,
            cam: { position: [...c.position], target: [...c.target], fov: c.fov },
            targetOnly: h.type === 'cameraTarget',
          }
          return
        }
        default:
          break
      }
      drag = { type: 'none' }
      return
    }

    const hit = pend.hit
    if (!hit || hit.kind === 'room') {
      drag = { type: 'marquee', start, cur: e.plan, additive: pend.start.shift }
      return
    }
    if (hit.kind === 'node') {
      const n = d.nodes[hit.id]
      if (n && pend.start.ctrl) {
        // Ctrl+drag from a junction draws a new wall from it (plain drag moves the node)
        startWallDrag(hit.id, pend.start)
        return
      }
      if (n) {
        drag = { type: 'node', nodeId: hit.id, grab: sub(start, n), excludeWalls: wallsAtNodes([hit.id]) }
        return
      }
    }
    if (hit.kind === 'opening') {
      const o = d.openings[hit.id]
      const g = o && derived.wallGeoms[o.wallId]
      if (o && g) {
        const proj = projectOnLine(start, g.a, g.b).t * g.length
        drag = { type: 'opening', id: hit.id, base: { ...o }, startWall: o.wallId, grab: o.offset - proj }
        return
      }
    }
    if (hit.kind === 'dimension') {
      const dm = d.dimensions[hit.id]
      if (dm) {
        drag = { type: 'dimOffset', id: hit.id, base: { ...dm } }
        return
      }
    }
    if (hit.kind === 'electric') {
      // alone (not part of a group selection) the point slides along the walls
      const q = d.electrical?.[hit.id]
      const all = ui().selection
      if (q && all.length <= 1) {
        drag = { type: 'electric', id: hit.id, base: { ...q }, grab: sub(q, start) }
        return
      }
    }

    if (hit.kind === 'wall' && !pend.start.ctrl) {
      // dragging the body of the only selected wall moves it sideways (Ctrl = free translate)
      const all = ui().selection
      if (all.length === 1 && all[0].kind === 'wall' && all[0].id === hit.id) {
        const wd = wallMidDrag(hit.id, start)
        if (wd) {
          const g = derived.wallGeoms[hit.id]
          dragHandle = g ? { type: 'wallMid', pos: mid(g.a, g.b), wallId: hit.id } : null
          drag = wd
          return
        }
      }
    }

    // group move of everything movable in the selection
    // hidden / locked objects selected in the layers panel stay put
    const sel = pickableRefs(d, ui().selection).filter((r) => MOVABLE.has(r.kind))
    const nodes = new Map<Id, Vec2>()
    const points: { ref: EntityRef; x: number; y: number }[] = []
    const dims: { id: Id; a: Vec2; b: Vec2 }[] = []
    let primary: Vec2 | null = null
    let hitMovable = false
    // a node shared with a locked wall stays put
    const vis = layerIndex(d)
    const addNode = (id: Id): void => {
      const n = d.nodes[id]
      if (n && !nodes.has(id) && !vis.locked('node', id)) nodes.set(id, { x: n.x, y: n.y })
    }
    for (const r of sel) {
      const isHit = r.kind === hit.kind && r.id === hit.id
      switch (r.kind) {
        case 'wall': {
          const w = d.walls[r.id]
          if (!w) break
          addNode(w.a)
          addNode(w.b)
          if (isHit) {
            hitMovable = true
            primary = nodes.get(w.a) ?? nodes.get(w.b) ?? null
          }
          break
        }
        case 'node':
          addNode(r.id)
          if (isHit) {
            hitMovable = true
            primary = nodes.get(r.id) ?? null
          }
          break
        case 'item': {
          const it = d.items[r.id]
          if (!it || it.locked) break
          points.push({ ref: r, x: it.x, y: it.y })
          if (isHit) {
            hitMovable = true
            primary = { x: it.x, y: it.y }
          }
          break
        }
        case 'light': {
          const l = d.lights[r.id]
          if (!l) break
          points.push({ ref: r, x: l.x, y: l.y })
          if (isHit) {
            hitMovable = true
            primary = { x: l.x, y: l.y }
          }
          break
        }
        case 'electric': {
          const q = d.electrical?.[r.id]
          if (!q) break
          points.push({ ref: r, x: q.x, y: q.y })
          if (isHit) {
            hitMovable = true
            primary = { x: q.x, y: q.y }
          }
          break
        }
        case 'label': {
          const l = d.labels[r.id]
          if (!l) break
          points.push({ ref: r, x: l.x, y: l.y })
          if (isHit) {
            hitMovable = true
            primary = { x: l.x, y: l.y }
          }
          break
        }
        case 'underlay': {
          const u = d.underlays[r.id]
          if (!u || u.locked) break
          points.push({ ref: r, x: u.x, y: u.y })
          if (isHit) {
            hitMovable = true
            primary = { x: u.x, y: u.y }
          }
          break
        }
        case 'dimension': {
          const dm = d.dimensions[r.id]
          if (!dm) break
          dims.push({ id: r.id, a: { ...dm.a }, b: { ...dm.b } })
          if (isHit) {
            hitMovable = true
            primary = { ...dm.a }
          }
          break
        }
        default:
          break
      }
    }
    if (!hitMovable || !primary) {
      drag = { type: 'none' }
      return
    }
    let single: Item | null = null
    if (points.length === 1 && nodes.size === 0 && dims.length === 0 && points[0].ref.kind === 'item') {
      const it = d.items[points[0].ref.id]
      if (it) single = { ...it, size: { ...it.size } }
    }
    drag = {
      type: 'move',
      start,
      primary,
      nodes,
      points,
      dims,
      single,
      excludeWalls: wallsAtNodes(nodes.keys()),
      snapObjects: nodes.size > 0,
    }
  }

  function currentWallHit(wallId: Id, p: Vec2): WallHit | null {
    const g = ctx.derived().wallGeoms[wallId]
    if (!g) return null
    const pr = projectOnLine(p, g.a, g.b)
    const n = leftOf(norm(sub(g.b, g.a)))
    return {
      wallId,
      geom: g,
      t: pr.t,
      point: pr.point,
      dist: pr.dist,
      bodyDist: pr.dist,
      side: dot(sub(p, g.a), n) >= 0 ? 'left' : 'right',
    }
  }

  function applyDrag(e: PointerInfo): void {
    const d = doc()
    const st = d.settings
    switch (drag.type) {
      case 'marquee':
        drag.cur = e.plan
        break
      case 'node': {
        const id = drag.nodeId
        if (!d.nodes[id]) break
        const snap = snapPoint(ctx, sub(e.plan, drag.grab), {
          excludeNodes: new Set([id]),
          excludeWalls: drag.excludeWalls,
          alt: e.alt,
          noAngle: true,
        })
        ctx.snapFeedback = snap
        transient(t('Перемещение узла'), (dr) => moveNode(dr, id, snap.point.x, snap.point.y))
        break
      }
      case 'move': {
        const m = drag
        let delta = sub(e.plan, m.start)
        if (m.single) {
          const it = d.items[m.single.id]
          if (!it) break
          const asset = ui().getAsset(m.single.assetId)
          const place = placeItem(ctx, { size: m.single.size, mount: m.single.mount, rotation: it.rotation }, asset, add(m.primary, delta), {
            alt: e.alt,
            keepRotation: e.shift,
          })
          const sid = m.single.id
          transient(t('Перемещение'), (dr) => {
            const x = dr.items[sid]
            if (!x) return
            x.x = place.x
            x.y = place.y
            x.rotation = place.rotation
          })
          break
        }
        if (e.shift) delta = Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }
        const target = add(m.primary, delta)
        let snapped = target
        if (m.snapObjects) {
          const snap = snapPoint(ctx, target, {
            excludeNodes: new Set(m.nodes.keys()),
            excludeWalls: m.excludeWalls,
            alt: e.alt,
            noAngle: true,
          })
          ctx.snapFeedback = snap
          snapped = snap.point
        } else {
          snapped = snapToGrid(ctx, target, e.alt)
        }
        if (e.shift) {
          // keep the axis lock after snapping
          if (delta.y === 0) snapped = { x: snapped.x, y: m.primary.y }
          else snapped = { x: m.primary.x, y: snapped.y }
        }
        const dd = sub(snapped, m.primary)
        transient(t('Перемещение'), (dr) => {
          for (const [id, p] of m.nodes) moveNode(dr, id, p.x + dd.x, p.y + dd.y)
          for (const pt of m.points) {
            if (pt.ref.kind === 'electric') {
              // wall points are put back on their faces by normalize
              const q = dr.electrical?.[pt.ref.id]
              if (q) {
                q.x = pt.x + dd.x
                q.y = pt.y + dd.y
              }
              continue
            }
            const coll =
              pt.ref.kind === 'item'
                ? dr.items
                : pt.ref.kind === 'light'
                  ? dr.lights
                  : pt.ref.kind === 'label'
                    ? dr.labels
                    : dr.underlays
            const x = coll[pt.ref.id]
            if (!x) continue
            x.x = pt.x + dd.x
            x.y = pt.y + dd.y
          }
          for (const dm of m.dims) {
            const x = dr.dimensions[dm.id]
            if (!x) continue
            x.a = add(dm.a, dd)
            x.b = add(dm.b, dd)
          }
        })
        break
      }
      case 'wallMid': {
        const m = drag
        const baseMid = mid(m.a.p, m.b.p)
        const raw = add(baseMid, mul(m.n, dot(sub(e.plan, m.start), m.n)))
        const snap = snapPoint(ctx, raw, {
          excludeNodes: new Set([m.a.id, m.b.id]),
          excludeWalls: m.excludeWalls,
          alt: e.alt,
          noAngle: true,
        })
        const dn = dot(sub(snap.point, baseMid), m.n)
        ctx.snapFeedback = snap.kind === 'align' || snap.kind === 'node' ? snap : null
        const off = mul(m.n, dn)
        // ArchiCAD-like: an end with exactly one neighbouring wall slides along that wall so the
        // neighbour stays straight; other ends are translated with the wall
        const endAt = (end: { p: Vec2; slide: Vec2 | null }): Vec2 => {
          const moved = add(end.p, off)
          if (!end.slide) return moved
          const r = lineLine(moved, m.u, end.p, end.slide)
          if (!r || !Number.isFinite(r.point.x) || !Number.isFinite(r.point.y)) return moved
          // a very oblique neighbour would throw the node far away: translate instead
          return dist(r.point, end.p) > Math.abs(dn) * 6 + 10 ? moved : r.point
        }
        const pa = endAt(m.a)
        const pb = endAt(m.b)
        if (dist(pa, pb) < 10) break
        transient(t('Перемещение стены'), (dr) => {
          moveNode(dr, m.a.id, pa.x, pa.y)
          moveNode(dr, m.b.id, pb.x, pb.y)
        })
        badge = { at: add(baseMid, off), text: formatLenUnit(Math.abs(dn), st.units) }
        break
      }
      case 'electric': {
        const m = drag
        if (!d.electrical?.[m.id]) break
        const target = add(e.plan, m.grab)
        const levelId = m.base.levelId
        if (m.base.mount === 'wall' && !e.alt) {
          const hit = nearestWallFace(d, levelId, target, Math.max(ctx.mm(40), 300), { prefer: m.base.wallId })
          if (hit) {
            const tt = clampOnFace(d, hit.wallId, hit.side, Math.round(hit.t / 10) * 10, electricHalfWidth(d.electrical[m.id]))
            transient(t('Перемещение'), (dr) => placeElectricOnWall(dr, m.id, hit.wallId, hit.side, tt))
            break
          }
        }
        const g = snapToGrid(ctx, target, e.alt)
        transient(t('Перемещение'), (dr) => {
          const q = dr.electrical?.[m.id]
          if (!q) return
          detachElectric(q)
          q.x = g.x
          q.y = g.y
        })
        break
      }
      case 'opening': {
        const m = drag
        const cur = d.openings[m.id]
        if (!cur) break
        const near = ctx.hit.nearestWall(e.plan, ctx.mm(26))
        const wh = near ?? currentWallHit(cur.wallId, e.plan)
        if (!wh) break
        const raw = projectOnLine(e.plan, wh.geom.a, wh.geom.b).t * wh.geom.length + (wh.wallId === m.startWall ? m.grab : 0)
        const place = placeOpeningOnWall(ctx, wh, m.base.width, raw, { alt: e.alt, ignoreId: m.id })
        if (!place.valid || Math.abs(place.width - m.base.width) > 0.5) break
        transient(t('Перемещение проёма'), (dr) => moveOpening(dr, m.id, place.wallId, place.offset))
        break
      }
      case 'openingEnd': {
        const m = drag
        const g = ctx.derived().wallGeoms[m.base.wallId]
        if (!g) break
        const step = e.alt || !st.snapGrid ? 1 : ctx.camera.scale >= 0.25 ? 10 : 50
        let s = projectOnLine(e.plan, g.a, g.b).t * g.length
        let width: number
        let offset: number
        if (m.end === 'b') {
          const fixed = m.base.offset - m.base.width / 2
          s = Math.min(g.length, Math.max(fixed + 300, s))
          width = Math.max(300, Math.round((s - fixed) / step) * step)
          if (fixed + width > g.length) width = g.length - fixed
          offset = fixed + width / 2
        } else {
          const fixed = m.base.offset + m.base.width / 2
          s = Math.max(0, Math.min(fixed - 300, s))
          width = Math.max(300, Math.round((fixed - s) / step) * step)
          if (fixed - width < 0) width = fixed
          offset = fixed - width / 2
        }
        let overlap = false
        for (const id in d.openings) {
          const o = d.openings[id]
          if (id === m.id || o.wallId !== m.base.wallId) continue
          if (Math.abs(o.offset - offset) < (o.width + width) / 2 - 0.5) overlap = true
        }
        if (overlap || width < 300) break
        transient(t('Размер проёма'), (dr) => {
          const o = dr.openings[m.id]
          if (!o) return
          o.width = width
          o.offset = offset
        })
        badge = { at: e.plan, text: formatLenUnit(width, st.units) }
        break
      }
      case 'itemResize': {
        // same face-anchored math as the 3D handles (core/manipulate.ts): the opposite face (or corner)
        // stays put, the dragged face snaps to wall faces, neighbours' edges and the grid (Alt — free)
        const m = drag
        const b = m.base
        const asset = ui().getAsset(b.assetId)
        const min = minItemSize(asset)
        const start: ItemPose = { x: b.x, y: b.y, rotation: b.rotation, elevation: b.elevation, size: b.size }
        const p = itemToLocal(b, e.plan)
        const snapOn = !e.alt
        const step = snapOn && st.snapGrid ? gridSteps(st.gridMm, ctx.camera.scale).minor : 0
        const doc = ctx.doc()
        const lid = ctx.levelId()
        const objSnap = snapOn && st.snapObjects !== false
        const near = objSnap ? Object.values(doc.items).filter((o) => o.levelId === lid) : []
        const walls = objSnap ? wallFaceSegments(doc.walls, ctx.derived().wallGeoms, lid) : []
        const lenFor = (axis: 'w' | 'd', side: 1 | -1, raw: number): number =>
          snapValue(raw, snapOn ? planResizeTargets(start, axis, side, { walls, items: near, selfId: m.id }) : [], ctx.mm(8), step).value
        const lockPref = resizePrefs.getState().lockRatio
        let w = m.sx !== 0 ? lenFor('w', m.sx as 1 | -1, m.sx * p.x + b.size.w / 2) : b.size.w
        let dep = m.sy !== 0 ? lenFor('d', m.sy as 1 | -1, m.sy * p.y + b.size.d / 2) : b.size.d
        let h = b.size.h
        let pose: ItemPose
        if (m.sx !== 0 && m.sy !== 0 && (e.shift || lockPref)) {
          // corner with proportions kept (Shift or the inspector's lock): the opposite corner stays
          const k = Math.max(w / b.size.w, dep / b.size.d, min.w / b.size.w, min.d / b.size.d)
          w = b.size.w * k
          dep = b.size.d * k
          if (lockPref) h = Math.max(min.h, b.size.h * k)
          pose = resizeFromFace(start, 'w', m.sx as 1 | -1, w, { min })
          pose = resizeFromFace(pose, 'd', m.sy as 1 | -1, dep, { min })
          pose = { ...pose, size: { ...pose.size, h } }
        } else if (m.sx !== 0 && m.sy !== 0) {
          pose = resizeFromFace(start, 'w', m.sx as 1 | -1, w, { min })
          pose = resizeFromFace(pose, 'd', m.sy as 1 | -1, dep, { min })
        } else {
          const axis = m.sx !== 0 ? 'w' : 'd'
          const side = (m.sx !== 0 ? m.sx : m.sy) as 1 | -1
          pose = resizeFromFace(start, axis, side, axis === 'w' ? w : dep, { min, lockRatio: lockPref, fixedBack: b.mount === 'wall' })
        }
        const size = clampItemSize({ w: Math.round(pose.size.w), d: Math.round(pose.size.d), h: Math.round(pose.size.h) }, asset)
        const params = resizedParams(asset, b.params, b.size, size) ?? b.params
        transient(t('Изменить размер'), (dr) => {
          const it = dr.items[m.id]
          if (!it) return
          it.size = size
          it.x = pose.x
          it.y = pose.y
          it.elevation = pose.elevation
          if (params) it.params = { ...params }
          else delete it.params
        })
        badge = { at: e.plan, text: `${formatLen(size.w, st.units)} × ${formatLen(size.d, st.units)}${lockPref ? ` × ${formatLen(size.h, st.units)}` : ''}` }
        break
      }
      case 'itemRotate': {
        const m = drag
        const f = sub(e.plan, { x: m.base.x, y: m.base.y })
        if (Math.hypot(f.x, f.y) < 1) break
        let r = (Math.atan2(-f.x, f.y) * 180) / Math.PI
        if (!e.alt) {
          const step = e.shift ? 45 : st.snapAngle ? 15 : 1
          r = Math.round(r / step) * step
        }
        r = normDeg(r)
        transient(t('Поворот'), (dr) => {
          const it = dr.items[m.id]
          if (it) it.rotation = r
        })
        badge = { at: e.plan, text: formatAngle(r) }
        break
      }
      case 'dimOffset': {
        const m = drag
        const n = dimensionNormal(m.base)
        let off = dot(sub(e.plan, m.base.a), n)
        if (!e.alt && st.snapGrid) {
          const ls = lengthStep(ctx.camera.scale)
          off = Math.round(off / ls) * ls
        }
        transient(t('Размер'), (dr) => {
          const x = dr.dimensions[m.id]
          if (x) x.offset = off
        })
        break
      }
      case 'camera': {
        const m = drag
        const engine = appHandles.engine3d
        if (!engine) break
        const dx = (e.plan.x - m.start.x) / 1000
        const dz = (e.plan.y - m.start.y) / 1000
        if (m.targetOnly) {
          engine.setCamera({
            position: m.cam.position,
            target: [e.plan.x / 1000, m.cam.target[1], e.plan.y / 1000],
          })
        } else {
          engine.setCamera({
            position: [m.cam.position[0] + dx, m.cam.position[1], m.cam.position[2] + dz],
            target: [m.cam.target[0] + dx, m.cam.target[1], m.cam.target[2] + dz],
          })
        }
        break
      }
      default:
        break
    }
    ctx.requestRender()
  }

  function finish(commit: boolean): void {
    const was = drag
    drag = { type: 'none' }
    badge = null
    dragHandle = null
    ctx.snapFeedback = null
    if (was.type === 'camera') {
      if (!commit) appHandles.engine3d?.setCamera({ position: was.cam.position, target: was.cam.target })
    } else if (changed) {
      if (commit) {
        const label =
          was.type === 'node'
            ? t('Перемещение узла')
            : was.type === 'wallMid'
              ? t('Перемещение стены')
              : was.type === 'opening'
              ? t('Перемещение проёма')
              : was.type === 'itemResize'
                ? t('Изменить размер')
                : was.type === 'openingEnd'
                ? t('Изменение размера')
                : was.type === 'itemRotate'
                  ? t('Поворот')
                  : t('Перемещение')
        store().commitTransient(label)
      } else {
        store().cancelTransient()
      }
    }
    changed = false
    ctx.requestRender()
  }

  function nudge(dx: number, dy: number, step: number): boolean {
    const sel = pickableRefs(store().doc, ui().selection)
    if (!sel.length) return false
    // a node shared with a locked wall stays put
    const vis = layerIndex(store().doc)
    store().transact(
      t('Сдвиг'),
      (dr) => {
        const nodes = new Set<Id>()
        for (const r of sel) {
          switch (r.kind) {
            case 'wall': {
              const w = dr.walls[r.id]
              if (w) {
                if (!vis.locked('node', w.a)) nodes.add(w.a)
                if (!vis.locked('node', w.b)) nodes.add(w.b)
              }
              break
            }
            case 'node':
              nodes.add(r.id)
              break
            case 'item': {
              const it = dr.items[r.id]
              if (it && !it.locked) {
                it.x += dx
                it.y += dy
              }
              break
            }
            case 'light': {
              const l = dr.lights[r.id]
              if (l) {
                l.x += dx
                l.y += dy
              }
              break
            }
            case 'electric': {
              // a wall point moves along its wall: the shift across it is undone by normalize
              const q = dr.electrical?.[r.id]
              if (q) {
                q.x += dx
                q.y += dy
              }
              break
            }
            case 'label': {
              const l = dr.labels[r.id]
              if (l) {
                l.x += dx
                l.y += dy
              }
              break
            }
            case 'underlay': {
              const u = dr.underlays[r.id]
              if (u && !u.locked) {
                u.x += dx
                u.y += dy
              }
              break
            }
            case 'dimension': {
              const dm = dr.dimensions[r.id]
              if (dm) {
                dm.a = { x: dm.a.x + dx, y: dm.a.y + dy }
                dm.b = { x: dm.b.x + dx, y: dm.b.y + dy }
              }
              break
            }
            case 'opening': {
              const o = dr.openings[r.id]
              const w = o && dr.walls[o.wallId]
              const a = w && dr.nodes[w.a]
              const b = w && dr.nodes[w.b]
              if (!o || !a || !b) break
              const s = dot({ x: dx, y: dy }, norm(sub(b, a)))
              if (Math.abs(s) > 0.3 * step) moveOpening(dr, r.id, o.wallId, o.offset + Math.sign(s) * step)
              break
            }
            default:
              break
          }
        }
        for (const id of nodes) {
          const n = dr.nodes[id]
          if (n) moveNode(dr, id, n.x + dx, n.y + dy)
        }
      },
      { merge: 'editor2d:nudge' },
    )
    return true
  }

  return {
    cursor: 'default',

    activate() {
      ctx.setHint(selectionHint())
      // the shell writes the generic tool hint right after switching tools: put ours back
      queueMicrotask(() => {
        if (ui().tool === 'select') ctx.setHint(selectionHint())
      })
    },

    deactivate() {
      if (drag.type !== 'none') finish(false)
      setHover(null)
    },

    activeHandle() {
      return drag.type !== 'none' && drag.type !== 'pending' ? dragHandle : null
    },

    pointerDown(e) {
      if (e.button !== 0) return
      if (drag.type !== 'none') finish(true)
      const list = computeHandles(ctx)
      const handle = handleAt(ctx, list, e.screen)
      if (handle?.type === 'nodeAdd') {
        // "+" next to the selected node: draw a new wall from it (drag, or click then click)
        startWallDrag(handle.nodeId, e)
        return
      }
      if (handle) {
        drag = { type: 'pending', start: e, hit: null, handle, wasSelected: true }
        return
      }
      const refs = ctx.hit.hitAll(e.plan, ctx.mm(8))
      let hit: EntityRef | null = refs[0] ?? null
      const now = performance.now()
      const prev = lastClick
      if (
        !e.shift &&
        prev &&
        refs.length > 1 &&
        now - prev.time > 450 &&
        Math.hypot(e.screen.x - prev.screen.x, e.screen.y - prev.screen.y) <= 3 &&
        refs.length === prev.refs.length &&
        refs.every((r, i) => r.kind === prev.refs[i].kind && r.id === prev.refs[i].id)
      ) {
        // clicking again on the same spot picks the next entity underneath
        const index = (prev.index + 1) % refs.length
        hit = refs[index]
        lastClick = { screen: e.screen, time: now, refs, index }
      } else {
        lastClick = { screen: e.screen, time: now, refs, index: 0 }
      }
      const wasSelected = !!hit && ctx.isSelected(hit)
      if (hit && !e.shift && !wasSelected) selectOnly(hit)
      drag = { type: 'pending', start: e, hit, handle: null, wasSelected }
    },

    pointerMove(e) {
      if (drag.type === 'none') {
        const handle = handleAt(ctx, computeHandles(ctx), e.screen)
        if (handle) {
          // a wall end handle is a junction: hovering it shows the angles there
          setHover(handle.type === 'node' ? { kind: 'node', id: handle.nodeId } : null)
          ctx.setCursor(handle.type === 'node' && e.ctrl ? 'copy' : handleCursor(handle))
          return
        }
        const hit = ctx.hit.hit(e.plan, ctx.mm(8))
        setHover(hit && hit.kind !== 'room' ? hit : null)
        ctx.setCursor(
          hit?.kind === 'node' && e.ctrl ? 'copy' : hit && hit.kind !== 'room' ? (ctx.isSelected(hit) ? 'move' : 'pointer') : 'default',
        )
        return
      }
      if (drag.type === 'pending') {
        const s = drag.start.screen
        if (Math.hypot(e.screen.x - s.x, e.screen.y - s.y) < 4) return
        setHover(null)
        lastClick = null
        beginDrag(e, drag)
      }
      const now = current()
      if (now.type === 'none' || now.type === 'pending') return
      applyDrag(e)
    },

    pointerUp(e) {
      if (drag.type === 'pending') {
        const pend = drag
        drag = { type: 'none' }
        if (pend.handle) return
        if (e.shift) {
          if (pend.hit) toggleSelection(pend.hit)
        } else if (!pend.hit) {
          selectOnly(null)
        } else if (pend.wasSelected && ui().selection.length > 1) {
          selectOnly(pend.hit)
        }
        return
      }
      if (drag.type === 'marquee') {
        const m = drag
        drag = { type: 'none' }
        const box = {
          minX: Math.min(m.start.x, m.cur.x),
          minY: Math.min(m.start.y, m.cur.y),
          maxX: Math.max(m.start.x, m.cur.x),
          maxY: Math.max(m.start.y, m.cur.y),
        }
        const refs = ctx.hit.inRect(box, m.cur.x < m.start.x)
        if (m.additive) {
          const cur = ui().selection
          const extra = refs.filter((r) => !cur.some((c) => c.kind === r.kind && c.id === r.id))
          ui().select([...cur, ...extra])
        } else {
          ui().select(refs)
        }
        ctx.requestRender()
        return
      }
      if (drag.type !== 'none') finish(true)
    },

    doubleClick(e) {
      const hit = ctx.hit.hit(e.plan, ctx.mm(8))
      if (!hit) return
      const d = doc()
      if (hit.kind === 'label') {
        const l = d.labels[hit.id]
        if (!l) return
        const s = ctx.camera.toScreen(l)
        ctx.html.prompt({
          x: s.x,
          y: s.y,
          value: l.text,
          key: `label:${hit.id}`,
          width: 220,
          onCommit: (text) => {
            store().transact(t('Текст'), (dr) => {
              const x = dr.labels[hit.id]
              if (x) x.text = text
            })
          },
        })
      } else if (hit.kind === 'room') {
        const rec = d.rooms[hit.id]
        const room = ctx.derived().rooms.find((r) => r.roomId === hit.id)
        if (!rec || !room) return
        const s = ctx.camera.toScreen(room.labelPoint)
        ctx.html.prompt({
          x: s.x,
          y: s.y,
          value: rec.name,
          key: `room:${hit.id}`,
          title: t('Название комнаты'),
          onCommit: (text) => {
            store().transact(t('Переименование комнаты'), (dr) => {
              const x = dr.rooms[hit.id]
              if (x) x.name = text
            })
          },
        })
      } else if (hit.kind === 'wall') {
        // double-click a wall: select the whole connected chain of walls
        const start = d.walls[hit.id]
        if (!start) return
        const byNode = new Map<Id, Id[]>()
        for (const id in d.walls) {
          const w = d.walls[id]
          if (w.levelId !== start.levelId) continue
          for (const n of [w.a, w.b]) {
            const list = byNode.get(n)
            if (list) list.push(id)
            else byNode.set(n, [id])
          }
        }
        const seen = new Set<Id>([hit.id])
        const queue = [hit.id]
        while (queue.length) {
          const w = d.walls[queue.pop() as Id]
          for (const n of [w.a, w.b]) {
            for (const other of byNode.get(n) ?? []) {
              if (!seen.has(other)) {
                seen.add(other)
                queue.push(other)
              }
            }
          }
        }
        ui().select(pickableRefs(d, [...seen].map((id) => ({ kind: 'wall' as const, id }))))
      }
    },

    keyDown(e) {
      if (drag.type !== 'none' && drag.type !== 'pending') return false
      const step = e.shiftKey ? 100 : 10
      switch (e.key) {
        case 'ArrowLeft':
          return nudge(-step, 0, step)
        case 'ArrowRight':
          return nudge(step, 0, step)
        case 'ArrowUp':
          return nudge(0, -step, step)
        case 'ArrowDown':
          return nudge(0, step, step)
        default:
          return false
      }
    },

    cancel() {
      if (drag.type !== 'none') {
        if (drag.type === 'pending' || drag.type === 'marquee') {
          drag = { type: 'none' }
          ctx.requestRender()
        } else finish(false)
        return true
      }
      if (ui().selection.length) {
        ui().clearSelection()
        return true
      }
      return false
    },

    draw(p: Painter) {
      const pal = p.pal
      // in 3D (or 2D+3D with the pointer over the 3D view) the 3D view owns the status hint
      if (drag.type === 'none' && (ui().mode === '2d' || ctx.pointer.inside)) ctx.setHint(selectionHint())
      if (drag.type === 'marquee') {
        const a = p.S(drag.start)
        const b = p.S(drag.cur)
        const crossing = drag.cur.x < drag.start.x
        const x = Math.min(a.x, b.x)
        const y = Math.min(a.y, b.y)
        const w = Math.abs(a.x - b.x)
        const h = Math.abs(a.y - b.y)
        const color = crossing ? pal.ok : pal.accent
        p.g.rect(x, y, w, h).fill({ color, alpha: 0.1 })
        if (crossing) {
          p.sdashed(x, y, x + w, y, color, 1, 1)
          p.sdashed(x + w, y, x + w, y + h, color, 1, 1)
          p.sdashed(x + w, y + h, x, y + h, color, 1, 1)
          p.sdashed(x, y + h, x, y, color, 1, 1)
        } else {
          p.g.rect(x, y, w, h).stroke({ width: 1, color })
        }
        return
      }
      const d = doc()
      const units = d.settings.units
      if (drag.type === 'node' || drag.type === 'wallMid' || (drag.type === 'move' && drag.nodes.size > 0 && drag.nodes.size <= 4)) {
        // live lengths of the walls that are being stretched
        const ids = drag.type === 'node' ? [drag.nodeId] : drag.type === 'wallMid' ? [drag.a.id, drag.b.id] : [...drag.nodes.keys()]
        const set = new Set(ids)
        const geoms = ctx.derived().wallGeoms
        let n = 0
        for (const id in d.walls) {
          const w = d.walls[id]
          if (!set.has(w.a) && !set.has(w.b)) continue
          const g = geoms[id]
          if (!g || n > 12) continue
          n++
          p.badge(`sel-len:${n}`, formatLen(dist(g.a, g.b), units), mid(g.a, g.b), { size: 11 })
        }
      }
      if (drag.type === 'opening') {
        const o = d.openings[drag.id]
        const g = o && ctx.derived().wallGeoms[o.wallId]
        if (o && g) {
          const u = norm(sub(g.b, g.a))
          const left = o.offset - o.width / 2
          const right = g.length - o.offset - o.width / 2
          p.badge('sel-oa', formatLen(left, units), add(g.a, mul(u, left / 2)), { size: 11, dy: -18 })
          p.badge('sel-ob', formatLen(right, units), add(g.a, mul(u, g.length - right / 2)), { size: 11, dy: -18 })
        }
      }
      if (badge) p.badge('sel-badge', badge.text, badge.at, { dx: 18, dy: -22 })
    },
  }
}
