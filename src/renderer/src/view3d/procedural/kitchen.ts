/** Cabinetry: box, kitchen modules, worktop (with cut-outs), wardrobe, shelving. */
import * as THREE from 'three'
import { addHob, addMicrowaveFront, addOvenFront } from './appliances'
import {
  type Ctx,
  F,
  type FrontOpts,
  type HandleStyle,
  addFaucet,
  addFronts,
  bowl,
  box,
  clamp,
  cyl,
  taperedLeg,
  plateWithHoles,
  rbox,
} from './common'

const HANDLES = ['bar', 'knob', 'none', 'edge'] as const
const PANEL = 0.018

export function boxKind(c: Ctx): void {
  c.add(rbox(c.W, c.H, c.D, Math.min(0.004, Math.min(c.W, c.H, c.D) * 0.1)), 'body', F.white, [0, c.H / 2, 0])
}

/**
 * Open-top carcass made of panels (sides, bottom, back, top rails) occupying
 * x ∈ [-w/2, w/2], y ∈ [y0, y0+h], z ∈ [zb, zb+d].
 */
function addCarcass(c: Ctx, w: number, h: number, d: number, y0: number, zb: number, opts: { closedTop: boolean; shelves?: number; parent?: THREE.Object3D }): void {
  const t = Math.min(PANEL, w / 4, d / 4)
  const p = opts.parent
  const zc = zb + d / 2
  for (const sx of [-1, 1]) c.add(rbox(t, h, d, 0.001), 'body', F.white, [sx * (w / 2 - t / 2), y0 + h / 2, zc], undefined, p)
  c.add(box(w - 2 * t, t, d), 'body', F.white, [0, y0 + t / 2, zc], undefined, p)
  c.add(box(w - 2 * t, h - 2 * t, 0.004), 'body', F.white, [0, y0 + h / 2, zb + 0.002], undefined, p)
  if (opts.closedTop) {
    c.add(box(w - 2 * t, t, d), 'body', F.white, [0, y0 + h - t / 2, zc], undefined, p)
  } else {
    const rail = Math.min(0.08, d / 3)
    c.add(box(w - 2 * t, t, rail), 'body', F.white, [0, y0 + h - t / 2, zb + d - rail / 2], undefined, p)
    c.add(box(w - 2 * t, t, rail), 'body', F.white, [0, y0 + h - t / 2, zb + rail / 2], undefined, p)
  }
  const n = opts.shelves ?? 0
  for (let i = 1; i <= n; i++) {
    const y = y0 + t + ((h - 2 * t) * i) / (n + 1)
    c.add(box(w - 2 * t - 0.002, t, d - 0.02), 'shelves', F.white, [0, y, zc - 0.006], undefined, p)
  }
}

function frontOpts(c: Ctx, defLayout: FrontOpts['layout'], handlePos: FrontOpts['handlePos'], allowed: readonly FrontOpts['layout'][]): FrontOpts {
  const layout = c.str('layout', defLayout, allowed)
  return {
    layout,
    doors: c.has('doors') ? c.int('doors', 1, 1, 8) : c.W > 0.62 ? 2 : 1,
    drawers: c.int('drawers', 3, 1, 6),
    handle: c.str('handle', 'bar', HANDLES) as HandleStyle,
    handlePos,
    gap: 0.003,
    thick: c.num('frontThickness', 18, 10, 40) / 1000,
  }
}

interface CutoutSpec {
  kind: 'none' | 'sink' | 'hob'
  x: number
  w: number
  d: number
  bowls: number
  hob: 'gas' | 'induction' | 'electric'
  faucet: boolean
}

function cutoutSpec(c: Ctx, W: number, D: number): CutoutSpec {
  const kind = c.str('cutout', 'none', ['none', 'sink', 'hob'] as const)
  const bowls = c.int('bowls', 1, 1, 2)
  const defW = kind === 'hob' ? Math.min(0.58, W - 0.08) : bowls === 2 ? Math.min(0.76, W - 0.1) : Math.min(0.5, W - 0.1)
  return {
    kind,
    x: c.num('cutoutX', 0) / 1000,
    w: clamp(c.num('cutoutWidth', defW * 1000) / 1000, 0.15, Math.max(0.16, W - 0.06)),
    d: clamp(c.num('cutoutDepth', Math.min(0.44, D - 0.14) * 1000) / 1000, 0.15, Math.max(0.16, D - 0.08)),
    bowls,
    hob: c.str('hob', 'induction', ['gas', 'induction', 'electric'] as const),
    faucet: c.bool('faucet', true),
  }
}

/**
 * Worktop slab of size w × t × d whose top is at y, centred on (0, cz); with optional sink/hob cut-out.
 */
function addWorktop(c: Ctx, w: number, t: number, d: number, yTop: number, cz: number, cut: CutoutSpec): void {
  const edgeR = Math.min(0.003, t / 3)
  if (cut.kind === 'none') {
    c.add(rbox(w, t, d, edgeR), 'worktop', F.stone, [0, yTop - t / 2, cz])
    return
  }
  const cx = clamp(cut.x, -w / 2 + cut.w / 2 + 0.03, w / 2 - cut.w / 2 - 0.03)
  const czh = cz + 0.02
  const holes =
    cut.kind === 'sink' && cut.bowls === 2
      ? [
          { w: cut.w * 0.56, d: cut.d, r: 0.02, x: cx - cut.w * 0.21, z: 0.02 },
          { w: cut.w * 0.38, d: cut.d, r: 0.02, x: cx + cut.w * 0.3, z: 0.02 },
        ]
      : [{ w: cut.w, d: cut.d, r: cut.kind === 'sink' ? 0.025 : 0.004, x: cx, z: 0.02 }]
  c.add(plateWithHoles(w, d, 0.0005, holes, t, edgeR), 'worktop', F.stone, [0, yTop - t, cz])
  if (cut.kind === 'hob') {
    addHob(c, cut.hob, cx, yTop, czh, cut.w + 0.02, cut.d + 0.02, cut.hob === 'gas')
    return
  }
  // undermount stainless bowls hanging from the underside of the worktop
  const depth = Math.min(0.2, Math.max(0.08, yTop - t - 0.02))
  for (const h of holes) {
    c.add(bowl(h.w + 0.012, h.d + 0.012, h.r + 0.006, depth, 0.03, 0.004, true), 'sink', F.steel, [h.x, yTop - t + 0.0005, cz + h.z])
    // waste outlet
    const drain = c.add(cylinderDisc(0.035), 'metal', F.chrome, [h.x, yTop - t - depth + 0.0012, cz + h.z])
    drain.receiveShadow = true
  }
  if (cut.faucet) addFaucet(c, cx, yTop, cz + 0.02 - cut.d / 2 - 0.045, 0.3, Math.min(0.22, cut.d * 0.55))
}

function cylinderDisc(r: number): THREE.BufferGeometry {
  return rbox(r * 2, 0.002, r * 2, 0.0009)
}

export function kitchenBase(c: Ctx): void {
  const { W, H, D } = c
  const hasTop = c.bool('worktop', true)
  const wt = hasTop ? clamp(c.num('worktopThickness', 38) / 1000, 0.01, H * 0.2) : 0
  const ov = hasTop ? clamp(c.num('overhang', 20) / 1000, 0, D * 0.2) : 0
  const plinth = Math.min(c.num('plinth', 100, 0, 250) / 1000, H * 0.3)
  const fo = frontOpts(c, 'doors', 'top', ['doors', 'drawers', 'mixed', 'glass'])
  const island = c.bool('island', false)
  // islands: seating overhang at the back, closed by a finished back panel
  const backOv = island && hasTop && D > 0.75 ? clamp(c.num('backOverhang', Math.min(300, D * 1000 * 0.3)) / 1000, 0, D * 0.4) : 0
  const backPanel = island ? PANEL : 0
  const zb = -D / 2 + backOv + backPanel
  const Dc = Math.max(0.05, D - ov - fo.thick - 0.001 - backOv - backPanel)
  const Hc = Math.max(0.05, H - wt - plinth)
  const cut = hasTop ? cutoutSpec(c, W, D) : { kind: 'none' as const, x: 0, w: 0, d: 0, bowls: 1, hob: 'induction' as const, faucet: false }
  addCarcass(c, W, Hc, Dc, plinth, zb, { closedTop: cut.kind !== 'sink', shelves: fo.layout === 'drawers' ? 0 : 1 })
  if (plinth > 0.005) {
    c.add(box(W - 0.002, plinth - 0.002, 0.016), 'plinth', F.white, [0, plinth / 2, zb + Dc - 0.04])
    // dark void behind the plinth
    c.add(box(W - 0.04, 0.002, Dc - 0.08), 'body', F.anthracite, [0, 0.001, zb + (Dc - 0.08) / 2 + 0.02])
    if (island) c.add(box(W - 0.002, plinth - 0.002, 0.016), 'plinth', F.white, [0, plinth / 2, zb + 0.04])
  }
  // finished back panel of an island in the front material
  if (island) c.add(rbox(W, H - wt, backPanel, 0.0015), 'front', F.white, [0, (H - wt) / 2, zb - backPanel / 2])
  const zf = zb + Dc + 0.001
  if (c.bool('corner', false)) {
    // blind corner unit: a fixed filler panel on the blind side, one working door on the other
    const blindLeft = c.str('cornerSide', 'left', ['left', 'right'] as const) === 'left'
    const doorW = clamp(c.num('cornerDoorWidth', Math.min(450, W * 500)) / 1000, 0.2, Math.max(0.21, W - 0.1))
    const blindW = W - doorW
    const bx = blindLeft ? -W / 2 + blindW / 2 : W / 2 - blindW / 2
    c.add(rbox(blindW - 0.006, Hc - 0.006, fo.thick, 0.0015), 'front', F.white, [bx, plinth + Hc / 2, zf + fo.thick / 2])
    const dx0 = blindLeft ? W / 2 - doorW : -W / 2
    addFronts(c, dx0, dx0 + doorW, plinth, plinth + Hc, zf, { ...fo, layout: fo.layout === 'drawers' ? 'drawers' : 'doors', doors: 1 })
  } else {
    addFronts(c, -W / 2, W / 2, plinth, plinth + Hc, zf, fo)
  }
  if (hasTop) addWorktop(c, W, wt, D, H, 0, cut)
}

export function kitchenWall(c: Ctx): void {
  const { W, H, D } = c
  const fo = frontOpts(c, 'doors', 'bottom', ['doors'])
  const layout = c.str('layout', 'doors', ['doors', 'glass', 'lift', 'open'] as const)
  const Dc = Math.max(0.05, D - (layout === 'open' ? 0 : fo.thick + 0.001))
  const shelves = Math.max(0, Math.round(H / 0.32) - 1)
  addCarcass(c, W, H, Dc, 0, -D / 2, { closedTop: true, shelves })
  if (layout === 'open') return
  if (layout === 'lift') fo.layout = 'lift'
  else if (layout === 'glass') fo.layout = 'glass'
  else fo.layout = 'doors'
  addFronts(c, -W / 2, W / 2, 0, H, -D / 2 + Dc + 0.001, fo)
  if (c.bool('underLight', false)) {
    const strip = c.add(box(W - 0.06, 0.004, 0.012), 'light', F.emissive, [0, 0.002, -D / 2 + Dc * 0.7])
    strip.userData.emissiveReady = true
  }
}

export function kitchenTall(c: Ctx): void {
  const { W, H, D } = c
  const plinth = Math.min(c.num('plinth', 100, 0, 250) / 1000, H * 0.15)
  const layout = c.str('layout', 'doors', ['doors', 'oven', 'fridge', 'pantry'] as const)
  const fo = frontOpts(c, 'doors', 'middle', ['doors'])
  const Dc = Math.max(0.05, D - fo.thick - 0.001)
  const Hc = H - plinth
  const zb = -D / 2
  const zf = zb + Dc + 0.001
  addCarcass(c, W, Hc, Dc, plinth, zb, { closedTop: true, shelves: 4 })
  if (plinth > 0.005) c.add(box(W - 0.002, plinth - 0.002, 0.016), 'plinth', F.white, [0, plinth / 2, zb + Dc - 0.04])
  const y0 = plinth
  const y1 = H
  const x0 = -W / 2
  const x1 = W / 2
  if (layout === 'oven') {
    const drawersTop = y0 + Math.min(0.5, Hc * 0.24)
    const ovenTop = drawersTop + Math.min(0.6, Hc * 0.3)
    addFronts(c, x0, x1, y0, drawersTop, zf, { ...fo, layout: 'drawers', drawers: 2 })
    // oven niche + oven
    c.add(box(W - 2 * PANEL, ovenTop - drawersTop, 0.004), 'body', F.anthracite, [0, (drawersTop + ovenTop) / 2, zf - 0.02])
    addOvenFront(c, x0 + 0.004, x1 - 0.004, drawersTop + 0.003, ovenTop - 0.003, zf - 0.01)
    let doorsFrom = ovenTop
    const mwH = Math.min(0.39, Hc * 0.19)
    if (c.bool('microwave', false) && y1 - ovenTop > mwH + 0.25) {
      // built-in microwave in its own niche above the oven
      const mwTop = ovenTop + mwH
      c.add(box(W - 2 * PANEL, mwH, 0.004), 'body', F.anthracite, [0, (ovenTop + mwTop) / 2, zf - 0.02])
      addMicrowaveFront(c, x0 + 0.004, x1 - 0.004, ovenTop + 0.003, mwTop - 0.003, zf - 0.01)
      doorsFrom = mwTop
    }
    addFronts(c, x0, x1, doorsFrom, y1, zf, { ...fo, layout: 'doors', handlePos: 'bottom' })
    return
  }
  if (layout === 'fridge') {
    const split = y0 + Hc * 0.36
    addFronts(c, x0, x1, y0, split, zf, { ...fo, layout: 'doors', doors: 1, handlePos: 'top' })
    addFronts(c, x0, x1, split, y1, zf, { ...fo, layout: 'doors', doors: 1, handlePos: 'bottom' })
    return
  }
  if (layout === 'pantry') {
    const split = y0 + Hc * 0.3
    addFronts(c, x0, x1, y0, split, zf, { ...fo, layout: 'drawers', drawers: 2 })
    addFronts(c, x0, x1, split, y1, zf, { ...fo, layout: 'doors' })
    return
  }
  const split = y1 - Math.min(0.45, Hc * 0.22)
  addFronts(c, x0, x1, y0, split, zf, { ...fo, layout: 'doors', handlePos: 'middle' })
  addFronts(c, x0, x1, split, y1, zf, { ...fo, layout: 'doors', handlePos: 'bottom' })
}

export function worktop(c: Ctx): void {
  const { W, H, D } = c
  addWorktop(c, W, H, D, H, 0, cutoutSpec(c, W, D))
  if (c.bool('legs', false)) {
    // bar counter: round support posts from the underside down to the floor below the item. They
    // extend below the item's box (elevation), so they are flagged as overflow for the size fit.
    const drop = clamp(c.num('legLength', c.item.elevation ?? 0) / 1000, 0, 3)
    if (drop < 0.05) return
    const r = 0.025
    const xs = W > 1.2 ? [-W / 2 + 0.12, W / 2 - 0.12] : [W / 2 - 0.12]
    for (const x of xs) {
      const post = c.add(cyl(r, r, drop, 24), 'legs', F.chrome, [x, -drop / 2, 0])
      post.userData.overflow = true
      const flange = c.add(cyl(0.045, 0.045, 0.008, 32), 'legs', F.chrome, [x, -0.004, 0])
      flange.userData.overflow = true
      const foot = c.add(cyl(0.04, 0.045, 0.012, 32), 'legs', F.chrome, [x, -drop + 0.006, 0])
      foot.userData.overflow = true
    }
  }
}

export function wardrobe(c: Ctx): void {
  const { W, H, D } = c
  const type = c.str('doorType', 'hinged', ['hinged', 'sliding'] as const)
  const mirror = c.bool('mirror', false)
  const legs = c.bool('legs', false)
  const plinth = legs
    ? clamp(c.num('legHeight', Math.min(120, H * 1000 * 0.22)) / 1000, 0.03, H * 0.3)
    : Math.min(c.num('plinth', 70, 0, 200) / 1000, H * 0.1)
  const cornice = c.bool('cornice', false) ? 0.04 : 0
  const handle = c.str('handle', 'bar', HANDLES) as HandleStyle
  const sliding = type === 'sliding'
  const frontT = sliding ? 0.04 : 0.018
  const trackD = sliding ? 0.09 : 0
  const Dc = Math.max(0.1, D - (sliding ? trackD : frontT + 0.001))
  const zb = -D / 2
  const bodyH = H - plinth - cornice
  // carcass: sides, top, bottom, back; with section dividers
  const sections = c.int('sections', Math.max(1, Math.round(W / 0.9)), 1, 8)
  const t = PANEL
  const sideY0 = legs ? plinth : 0
  const sideH = H - cornice - sideY0
  for (const sx of [-1, 1]) c.add(rbox(t, sideH, D, 0.001), 'body', F.white, [sx * (W / 2 - t / 2), sideY0 + sideH / 2, 0])
  c.add(box(W - 2 * t, t, Dc), 'body', F.white, [0, H - cornice - t / 2, zb + Dc / 2])
  c.add(box(W - 2 * t, t, Dc), 'body', F.white, [0, plinth + t / 2, zb + Dc / 2])
  c.add(box(W - 2 * t, bodyH, 0.004), 'body', F.white, [0, plinth + bodyH / 2, zb + 0.002])
  for (let i = 1; i < sections; i++) {
    c.add(box(t, bodyH - 2 * t, Dc - 0.004), 'body', F.white, [-W / 2 + (W * i) / sections, plinth + bodyH / 2, zb + Dc / 2 + 0.002])
  }
  if (legs) {
    const leg = taperedLeg(plinth, 0.017, 0.012)
    const ix = W / 2 - 0.05
    const iz = D / 2 - 0.05
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.add(leg, 'legs', F.walnut, [sx * ix, 0, sz * iz])
  } else if (plinth > 0.005) {
    c.add(box(W - 2 * t, plinth, 0.016), 'plinth', F.white, [0, plinth / 2, zb + Dc - 0.03])
  }
  if (cornice > 0) c.add(rbox(W, cornice, D, 0.003), 'cornice', F.white, [0, H - cornice / 2, 0])
  const y0 = plinth + 0.002
  const y1 = H - cornice - 0.002
  if (sliding) {
    // top and bottom aluminium tracks spanning the inner width
    const iw = W - 2 * t
    c.add(box(iw, 0.03, trackD), 'metal', F.aluminium, [0, y1 - 0.015, D / 2 - trackD / 2])
    c.add(box(iw, 0.012, trackD), 'metal', F.aluminium, [0, plinth + 0.006, D / 2 - trackD / 2])
    const n = c.int('count', W > 2.2 ? 3 : 2, 2, 5)
    const overlap = 0.03
    const pw = (iw + overlap * (n - 1)) / n
    const ph = y1 - 0.03 - (plinth + 0.012)
    const py = plinth + 0.012 + ph / 2
    for (let i = 0; i < n; i++) {
      const x = -iw / 2 + pw / 2 + i * (pw - overlap)
      const z = D / 2 - (i % 2 === 0 ? 0.022 : 0.062)
      const g = c.group([x, py, z])
      // aluminium frame profiles
      const prof = 0.02
      for (const sx of [-1, 1]) c.add(rbox(prof, ph, 0.03, 0.003), 'metal', F.aluminium, [sx * (pw / 2 - prof / 2), 0, 0], undefined, g)
      for (const sy of [-1, 1]) c.add(box(pw - 2 * prof, 0.025, 0.026), 'metal', F.aluminium, [0, sy * (ph / 2 - 0.0125), 0], undefined, g)
      const useMirror = mirror && (n === 2 ? i === 1 : i % 2 === 1)
      if (useMirror) c.add(box(pw - 2 * prof, ph - 0.05, 0.006), 'mirror', F.mirror, [0, 0, 0.004], undefined, g)
      else c.add(box(pw - 2 * prof, ph - 0.05, 0.016), 'front', F.white, [0, 0, 0], undefined, g)
    }
    return
  }
  const doors = c.int('count', Math.max(1, Math.round(W / 0.45)), 0, 12)
  const nDrawers = c.int('drawers', 0, 0, 8)
  const zf = zb + Dc + 0.001
  const base: FrontOpts = { layout: 'drawers', doors: 1, drawers: Math.max(1, nDrawers), handle, handlePos: 'middle', gap: 0.003, thick: frontT }
  if (doors === 0) {
    // chest of drawers / nightstand: drawer columns per section
    for (let s = 0; s < sections; s++) {
      const sx0 = -W / 2 + (W * s) / sections
      const sx1 = -W / 2 + (W * (s + 1)) / sections
      addFronts(c, sx0, sx1, y0, y1, zf, base)
    }
    return
  }
  // optional drawer band below the doors
  const drawerTop = nDrawers > 0 ? y0 + Math.min((y1 - y0) * 0.45, nDrawers * 0.2) : y0
  const topDoors = c.bool('topDoors', H > 2.2)
  const split = topDoors ? y1 - Math.min(0.45, (y1 - drawerTop) * 0.2) : y1
  // distribute doors over sections
  const perSection: number[] = []
  for (let s = 0; s < sections; s++) perSection.push(Math.floor(doors / sections) + (s < doors % sections ? 1 : 0))
  for (let s = 0; s < sections; s++) {
    const sx0 = -W / 2 + (W * s) / sections
    const sx1 = -W / 2 + (W * (s + 1)) / sections
    const nd = Math.max(1, perSection[s])
    if (nDrawers > 0) addFronts(c, sx0, sx1, y0, drawerTop, zf, base)
    const opts: FrontOpts = { ...base, layout: 'doors', doors: nd, handlePos: split - drawerTop < 1 ? 'top' : 'middle' }
    addFronts(c, sx0, sx1, drawerTop, split, zf, opts)
    if (mirror) {
      const dw = (sx1 - sx0 - 0.003 * (nd + 1)) / nd
      for (let i = 0; i < nd; i++) {
        if (nd > 1 && i % 2 === 0) continue
        const cx = sx0 + 0.003 + dw / 2 + i * (dw + 0.003)
        c.add(rbox(dw * 0.78, (split - drawerTop) * 0.8, 0.005, 0.002), 'mirror', F.mirror, [cx, (drawerTop + split) / 2, zf + frontT + 0.0025])
      }
    }
    if (topDoors) addFronts(c, sx0, sx1, split, y1, zf, { ...opts, handlePos: 'bottom' })
  }
}

export function shelf(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('style', 'bookcase', ['bookcase', 'floating', 'ladder'] as const)
  const n = c.int('shelves', Math.max(1, Math.round(H / 0.35)), 1, 20)
  const boardT = clamp(c.num('boardThickness', 25) / 1000, 0.012, 0.06)
  if (style === 'floating') {
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? H - boardT / 2 : boardT / 2 + ((H - boardT) * i) / (n - 1)
      c.add(rbox(W, boardT, D, 0.002), 'shelves', F.oak, [0, y, 0])
    }
    return
  }
  if (style === 'ladder') {
    // two leaning uprights with boards of decreasing depth
    const lean = Math.min(D * 0.6, H * 0.18)
    const ang = Math.atan2(lean, H)
    const len = Math.hypot(H, lean)
    for (const sx of [-1, 1]) {
      c.add(rbox(0.03, len, 0.03, 0.004), 'frame', F.walnut, [sx * (W / 2 - 0.015), H / 2, D / 2 - 0.015 - lean / 2], [-ang, 0, 0])
    }
    for (let i = 0; i < n; i++) {
      const y = 0.1 + ((H - 0.15) * i) / Math.max(1, n - 1)
      const zFront = D / 2 - (lean * y) / H
      const depth = Math.max(0.12, zFront + D / 2 - 0.01)
      c.add(rbox(W - 0.07, boardT, depth, 0.002), 'shelves', F.oak, [0, y, zFront - depth / 2])
    }
    return
  }
  const back = c.bool('back', true)
  const cols = c.int('columns', Math.max(1, Math.round(W / 0.8)), 1, 8)
  const sideT = PANEL
  for (const sx of [-1, 1]) c.add(rbox(sideT, H, D, 0.0015), 'body', F.oak, [sx * (W / 2 - sideT / 2), H / 2, 0])
  const iw = W - 2 * sideT
  const plinth = Math.min(0.06, H * 0.08)
  c.add(box(iw, plinth, 0.016), 'body', F.oak, [0, plinth / 2, D / 2 - 0.02])
  const boards = Math.max(2, n + 1)
  for (let i = 0; i < boards; i++) {
    const y = plinth + boardT / 2 + ((H - plinth - boardT) * i) / (boards - 1)
    c.add(box(iw, boardT, D - (back ? 0.006 : 0)), 'shelves', F.oak, [0, y, back ? 0.003 : 0])
  }
  for (let i = 1; i < cols; i++) {
    c.add(box(sideT, H - plinth - 2 * boardT, D - 0.01), 'body', F.oak, [-iw / 2 + (iw * i) / cols, plinth + boardT + (H - plinth - 2 * boardT) / 2, 0.005])
  }
  if (back) c.add(box(iw, H - plinth, 0.006), 'back', F.white, [0, plinth + (H - plinth) / 2, -D / 2 + 0.003])
}
