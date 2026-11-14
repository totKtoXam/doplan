/**
 * Wall tool: click-click polyline chain with a rubber band, full snapping, live length/angle
 * badge, the angle to the previous segment (or to the axis for a free first segment) and typed
 * numeric length (digits + Enter, optional `<angle`). Every segment is its own history entry;
 * Backspace steps back, Enter / Esc / double-click finish, closing onto the first point ends the
 * chain.
 *
 * The chain can start anchored at an existing node ("continue the wall from here": W with a node
 * selected, the context menu, the "+" handle or Ctrl+drag in the select tool). The new walls then
 * join that node and inherit the thickness, kind and height of the wall they continue; a start by
 * dragging places the first segment on release and goes back to the select tool when the chain ends.
 */
import { addWall } from '@core'
import type { Id, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { angleToHorizontal, nodeRays, type Ray, rayTo, type Sector, sectorsOf } from '../angles'
import type { EditorCtx, PointerInfo } from '../context'
import { add, DEG, dist, leftOf, mid, mul, norm, normDeg, sub } from '../geom'
import { formatAngle, formatLenUnit, isLengthChar, parseLengthInput } from '../format'
import { type BadgeBox, badgeWidth, drawSector } from '../layers/angles'
import type { Painter } from '../painter'
import { type SnapResult, snapPoint } from '../snap'
import { setHover } from './common'
import type { Tool } from './types'
import { inheritedWallProps, takeWallStart } from './wallStart'

export function createWallTool(ctx: EditorCtx): Tool {
  /** points placed so far (the last one is the start of the rubber band) */
  let chain: Vec2[] = []
  /** whether placing chain[i] (i ≥ 1) produced a history entry */
  let committed: boolean[] = []
  let snap: SnapResult | null = null
  let typed = ''
  /** node the chain was started from ("continue the wall from here") */
  let anchorNode: Id | null = null
  /** press position of a drag that started the chain: releasing away from it places the first segment */
  let pressScreen: Vec2 | null = null
  /** chain started from the select tool: go back there when it ends */
  let returnToSelect = false
  /** screen point + time of the press that started an anchored chain (to swallow a double-click on "+") */
  let anchorPress: { x: number; y: number; t: number } | null = null
  type WallProps = { wallThickness: number; wallKind: ReturnType<typeof uiStore.getState>['wallKind']; wallHeight: number }
  /** tool settings replaced by the inherited ones of an anchored chain: put back when it ends */
  let savedProps: { prev: WallProps; applied: WallProps } | null = null

  function restoreProps(): void {
    const s = savedProps
    savedProps = null
    if (!s) return
    const u = uiStore.getState()
    // only when the user did not change them meanwhile
    if (u.wallThickness === s.applied.wallThickness && u.wallKind === s.applied.wallKind && u.wallHeight === s.applied.wallHeight) {
      u.set(s.prev)
    }
  }

  const wallOpts = () => {
    const u = uiStore.getState()
    return { thickness: u.wallThickness, height: u.wallHeight, kind: u.wallKind }
  }

  function updateHint(): void {
    if (!chain.length) ctx.setHint(t('Стена: щёлкните первую точку'))
    else if (anchorNode && chain.length === 1) {
      ctx.setHint(
        t('Стена от узла: щёлкните или отпустите в следующей точке · цифры и Enter — точная длина · Shift — шаг 45° · Alt — без привязки · Esc — отмена'),
      )
    } else {
      ctx.setHint(
        t('Следующая точка · цифры и Enter — точная длина · Shift — шаг 45° · Alt — без привязки · Esc или двойной щелчок — закончить'),
      )
    }
  }

  function reset(): void {
    chain = []
    committed = []
    typed = ''
    snap = null
    anchorNode = null
    pressScreen = null
    anchorPress = null
    restoreProps()
    ctx.snapFeedback = null
    updateHint()
    ctx.requestRender()
  }

  /** the chain is over (Esc, Enter, double-click, closed loop, stepped back past the start) */
  function finishChain(): void {
    const back = returnToSelect
    returnToSelect = false
    reset()
    if (back) uiStore.getState().setTool('select')
  }

  function resnap(e: { plan: Vec2; shift: boolean; alt: boolean }): SnapResult {
    const from = chain.length ? chain[chain.length - 1] : undefined
    const s = snapPoint(ctx, e.plan, {
      from,
      shift: e.shift,
      alt: e.alt,
      extraPoints: chain.length >= 2 ? [chain[0]] : undefined,
    })
    snap = s
    ctx.snapFeedback = s
    return s
  }

  /** starts the chain on an existing node with the properties of the wall it continues */
  function startAt(nodeId: Id, req: { pressScreen: Vec2 | null; returnToSelect: boolean }): void {
    const doc = ctx.doc()
    const n = doc.nodes[nodeId]
    if (!n || n.levelId !== ctx.levelId()) return
    const props = inheritedWallProps(doc, nodeId)
    const ui = uiStore.getState()
    if (props && (props.thickness !== ui.wallThickness || props.kind !== ui.wallKind || props.height !== ui.wallHeight)) {
      const applied: WallProps = { wallThickness: props.thickness, wallKind: props.kind, wallHeight: props.height }
      savedProps = { prev: { wallThickness: ui.wallThickness, wallKind: ui.wallKind, wallHeight: ui.wallHeight }, applied }
      ui.set(applied)
    }
    chain = [{ x: n.x, y: n.y }]
    committed = [false]
    anchorNode = nodeId
    pressScreen = req.pressScreen
    anchorPress = req.pressScreen ? { ...req.pressScreen, t: performance.now() } : null
    returnToSelect = req.returnToSelect
    // the rubber band start marks the node now; a stale selection would only confuse
    if (uiStore.getState().selection.length) uiStore.getState().clearSelection()
    setHover(null)
    const p = ctx.pointer.plan
    if (p && ctx.pointer.inside) resnap({ plan: p, shift: ctx.keys.shift, alt: ctx.keys.alt })
    updateHint()
  }

  function place(pt: Vec2): void {
    // once a point is placed by any means, a pending drag release must not place another one
    pressScreen = null
    if (!chain.length) {
      chain = [pt]
      committed = [false]
      updateHint()
      return
    }
    const from = chain[chain.length - 1]
    if (dist(from, pt) < 5) return
    const before = docStore.getState().revision
    const levelId = ctx.levelId()
    docStore.getState().transact(t('Стена'), (d) => {
      addWall(d, levelId, from, pt, wallOpts())
    })
    const didCommit = docStore.getState().revision !== before
    if (chain.length >= 2 && dist(pt, chain[0]) < 1) {
      finishChain()
      return
    }
    chain.push(pt)
    committed.push(didCommit)
    typed = ''
    updateHint()
  }

  function typedTarget(): Vec2 | null {
    if (!chain.length) return null
    const parsed = parseLengthInput(typed, ctx.doc().settings.units)
    if (!parsed) return null
    const from = chain[chain.length - 1]
    let dir: Vec2
    if (parsed.angleDeg !== undefined) {
      const a = parsed.angleDeg * DEG
      dir = { x: Math.cos(a), y: -Math.sin(a) }
    } else if (snap && dist(snap.point, from) > 1) {
      dir = norm(sub(snap.point, from))
    } else {
      dir = { x: 1, y: 0 }
    }
    return add(from, mul(dir, parsed.length))
  }

  /** rays of the walls already meeting at `from` (or the previous segment when no node is there) */
  function raysAt(from: Vec2): Ray[] {
    const lv = ctx.levelId()
    let nodeId: Id | null = null
    let best = 1
    for (const n of ctx.hit.nodesNear(from, 1)) {
      const d = dist(n, from)
      if (n.levelId === lv && d <= best) {
        best = d
        nodeId = n.id
      }
    }
    const rays = nodeId ? nodeRays(ctx.doc(), nodeId) : []
    if (!rays.length && chain.length >= 2) {
      const r = rayTo('prev', from, chain[chain.length - 2])
      if (r) rays.push(r)
    }
    return rays
  }

  /** angle of the rubber band to the walls at its start, or to the horizontal axis on a free start */
  function drawAngles(p: Painter, from: Vec2, to: Vec2, length: number, avoid: BadgeBox[]): void {
    const pal = p.pal
    const lenPx = length * p.cam.scale
    if (lenPx < 24) return
    const nr = rayTo('new', from, to)
    if (!nr) return
    const u = uiStore.getState()
    const half = u.wallKind === 'virtual' ? 0 : (u.wallThickness / 2) * p.cam.scale
    const r = Math.min(Math.max(30, half + 16), lenPx * 0.45)
    const others = raysAt(from)
    if (!others.length) {
      const h = angleToHorizontal(sub(to, from))
      if (h.deg < 0.05 || h.deg > 89.95) return
      const a = Math.atan2(to.y - from.y, to.x - from.x)
      // sector between the axis and the segment, swept in growing atan2
      let start = h.axis
      let sweep = a - h.axis
      while (sweep > Math.PI) sweep -= Math.PI * 2
      while (sweep < -Math.PI) sweep += Math.PI * 2
      if (sweep < 0) {
        start = a
        sweep = -sweep
      }
      const s = p.S(from)
      p.sdashed(s.x, s.y, s.x + Math.cos(h.axis) * (r + 14), s.y, pal.guide, 1, 0.8, 4, 3)
      drawSector(p, 'wall-ang:axis', from, { start, sweep, deg: h.deg, mid: start + sweep / 2 }, r, pal.guide, { avoid })
      return
    }
    let adj: Sector[] = sectorsOf([...others, nr]).filter((s) => s.from.id === 'new' || s.to.id === 'new')
    // one neighbour: its two sectors add up to 360°, the convex one is the angle of the corner
    if (others.length === 1 && adj.length === 2) adj = [adj[0].deg <= adj[1].deg ? adj[0] : adj[1]]
    adj.forEach((s, i) => {
      const b = drawSector(p, `wall-ang:${i}`, from, s, r, pal.accent, { avoid })
      if (b) avoid.push(b)
    })
  }

  return {
    cursor: 'crosshair',

    activate() {
      returnToSelect = false
      reset()
      const req = takeWallStart(ctx)
      let nodeId: Id | null = req?.nodeId ?? null
      if (!req) {
        // W / the toolbar button with exactly one node selected continues the wall from that node
        const sel = uiStore.getState().selection
        if (sel.length === 1 && sel[0].kind === 'node') nodeId = sel[0].id
      }
      if (nodeId) startAt(nodeId, { pressScreen: req?.pressScreen ?? null, returnToSelect: req?.returnToSelect ?? false })
      // the shell writes the generic tool hint right after switching tools: put ours back
      queueMicrotask(() => {
        if (uiStore.getState().tool === 'wall') updateHint()
      })
      ctx.requestRender()
    },

    deactivate() {
      returnToSelect = false
      reset()
      ctx.setHint('')
    },

    pointerDown(e: PointerInfo) {
      if (e.button !== 0) return
      const ap = anchorPress
      if (ap && anchorNode && chain.length === 1 && performance.now() - ap.t < 500 && Math.hypot(e.screen.x - ap.x, e.screen.y - ap.y) <= 6) {
        // second click of a double-click on the "+" handle: no stub wall (the dblclick then ends the chain)
        resnap(e)
        ctx.requestRender()
        return
      }
      const s = resnap(e)
      place(s.point)
      // the rubber band now starts at the new point
      if (chain.length) resnap(e)
      ctx.requestRender()
    },

    pointerMove(e: PointerInfo) {
      resnap(e)
      ctx.requestRender()
    },

    pointerUp(e: PointerInfo) {
      const ps = pressScreen
      pressScreen = null
      if (!ps || !chain.length || e.button !== 0) return
      // a drag from the node / its "+" handle: the release point ends the first segment
      if (Math.hypot(e.screen.x - ps.x, e.screen.y - ps.y) <= 4) return
      const s = resnap(e)
      place(s.point)
      if (chain.length) resnap(e)
      ctx.requestRender()
    },

    doubleClick() {
      if (chain.length) finishChain()
    },

    keyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return false
      if (e.key === 'Enter') {
        if (typed) {
          const target = typedTarget()
          if (target) {
            place(target)
            const p = ctx.pointer.plan
            if (p && chain.length) resnap({ plan: p, shift: ctx.keys.shift, alt: ctx.keys.alt })
          }
          typed = ''
          ctx.requestRender()
          return true
        }
        if (chain.length) {
          finishChain()
          return true
        }
        return false
      }
      if (e.key === 'Backspace') {
        if (typed) {
          typed = typed.slice(0, -1)
          ctx.requestRender()
          return true
        }
        if (chain.length > 1) {
          chain.pop()
          if (committed.pop()) docStore.getState().undo()
          const p = ctx.pointer.plan
          if (p) resnap({ plan: p, shift: ctx.keys.shift, alt: ctx.keys.alt })
          updateHint()
          ctx.requestRender()
          return true
        }
        if (chain.length === 1) {
          finishChain()
          return true
        }
        return false
      }
      if (chain.length && e.key.length === 1 && isLengthChar(e.key)) {
        if (!typed && !/[0-9.,]/.test(e.key)) return false
        if (typed.length < 16) typed += e.key
        ctx.requestRender()
        return true
      }
      return false
    },

    cancel() {
      if (!chain.length && !typed) return false
      finishChain()
      return true
    },

    draw(p: Painter) {
      const pal = p.pal
      const u = uiStore.getState()
      const st = ctx.doc().settings
      if (!chain.length) {
        if (snap && ctx.pointer.inside) p.disc(snap.point, 3, pal.accent)
        return
      }
      const from = chain[chain.length - 1]
      let to = snap ? snap.point : from
      const tt = typed ? typedTarget() : null
      if (tt) to = tt
      const length = dist(from, to)
      if (chain.length >= 2) p.ring(chain[0], 7, pal.ok, 1.5)
      if (anchorNode && chain.length === 1) p.ring(from, 8, pal.accent, 1.5)
      p.disc(from, 3.5, pal.accent)
      if (length > 1) {
        const dir = norm(sub(to, from))
        if (u.wallKind !== 'virtual' && u.wallThickness > 0) {
          const n = mul(leftOf(dir), u.wallThickness / 2)
          p.polygon([add(from, n), add(to, n), sub(to, n), sub(from, n)], {
            fill: pal.accent,
            fillAlpha: 0.25,
            stroke: pal.accent,
            strokeAlpha: 0.9,
            width: 1,
          })
          p.dashed(from, to, pal.accent, 1, 0.8, 6, 4)
        } else {
          p.dashed(from, to, pal.accent, 1.5, 1, 8, 5)
        }
        const ang = normDeg((-Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI)
        const m = p.S(mid(from, to))
        // put the badge beside the segment, on the upper side
        let nx = -dir.y
        let ny = dir.x
        if (ny > 0 || (ny === 0 && nx > 0)) {
          nx = -nx
          ny = -ny
        }
        const off = Math.max(22, (u.wallThickness / 2) * p.cam.scale + 16)
        const text = typed
          ? `${typed}▏`
          : `${formatLenUnit(length, st.units)}  ·  ${formatAngle(Math.abs(ang - 360) < 0.05 ? 0 : ang)}`
        const bx = m.x + nx * off
        const by = m.y + ny * off
        drawAngles(p, from, to, length, [{ x: bx, y: by, w: badgeWidth(text), h: 21 }])
        p.sbadge('wall-len', text, bx, by, { bg: typed ? pal.accent : undefined })
      } else if (typed) {
        const s = p.S(from)
        p.sbadge('wall-len', `${typed}▏`, s.x + 30, s.y - 24, { bg: pal.accent })
      }
    },
  }
}
