/** Sanitary ware: kitchen sink, toilet, bathtub, shower, washbasin (vanity). */
import * as THREE from 'three'
import {
  type Ctx,
  F,
  type HandleStyle,
  addFaucet,
  addFronts,
  bowl,
  box,
  clamp,
  cyl,
  cylX,
  ellipsePath,
  ellipseShape,
  ellipseSlab,
  lathe,
  merge,
  mat4,
  cached,
  gkey,
  plateWithHole,
  plateWithHoles,
  rbox,
  roundedRectPath,
  roundedRectShape,
  slabFromShape,
  tube,
} from './common'

function drainDisc(c: Ctx, x: number, y: number, z: number, r = 0.035, parent?: THREE.Object3D): void {
  c.add(rbox(r * 2, 0.003, r * 2, 0.0012), 'metal', F.chrome, [x, y + 0.0015, z], undefined, parent)
}

// ───────────────────────────── kitchen sink ─────────────────────────────

export function sink(c: Ctx): void {
  const { W, H, D } = c
  // a stand-alone sink's bowl and deck use the body slot (built-in sinks in a worktop use 'metal')
  c.slotAlias.sink = 'body'
  const bowls = c.int('bowls', 1, 1, 2)
  const drainer = c.bool('drainer', W > 0.68)
  const faucet = c.bool('faucet', true) && H > 0.3
  const pt = 0.012
  const bowlDepth = clamp(c.num('bowlDepth', 180) / 1000, 0.06, Math.max(0.07, (faucet ? H - 0.15 : H) - pt))
  const yTop = faucet ? bowlDepth + pt : H
  const depth = yTop - pt
  const area = drainer ? W * 0.56 : W - 0.06
  const ax = drainer ? -W / 2 + 0.03 + area / 2 : 0
  const bd = D - 0.12
  const bz = 0.02
  const holes =
    bowls === 2
      ? [
          { w: area * 0.57, d: bd, r: 0.03, x: ax - area * 0.215, z: bz },
          { w: area * 0.39, d: bd, r: 0.03, x: ax + area * 0.3, z: bz },
        ]
      : [{ w: area, d: bd, r: 0.035, x: ax, z: bz }]
  // deck plate with rounded edge
  c.add(plateWithHoles(W, D, 0.012, holes, pt, 0.004), 'sink', F.steel, [0, yTop - pt, 0])
  for (const h of holes) {
    c.add(bowl(h.w + 0.006, h.d + 0.006, h.r + 0.003, depth, 0.025, 0.005, true), 'sink', F.steel, [h.x, yTop - pt + 0.0005, h.z])
    drainDisc(c, h.x, yTop - pt - depth, h.z)
  }
  if (drainer) {
    // pressed ribs on the drainer
    const dx0 = ax + area / 2 + 0.03
    const dw = W / 2 - 0.03 - dx0
    const g = cached(gkey('drainerRibs', dw, bd), () => {
      const n = Math.max(3, Math.floor(dw / 0.03))
      const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
      const rib = new THREE.CapsuleGeometry(0.005, bd * 0.7, 4, 8)
      rib.rotateX(Math.PI / 2)
      rib.scale(1, 0.25, 1)
      for (let i = 0; i < n; i++) parts.push({ g: rib, m: mat4([-dw / 2 + (i + 0.5) * (dw / n), 0, 0]) })
      return merge(parts)
    })
    c.add(g, 'sink', F.steel, [dx0 + dw / 2, yTop - 0.0005, bz])
  }
  if (faucet) addFaucet(c, ax, yTop, -D / 2 + 0.04, H - yTop, Math.min(0.22, bd * 0.6))
}

// ───────────────────────────── toilet ─────────────────────────────

export function toilet(c: Ctx): void {
  const { W, H, D } = c
  const wallHung = c.bool('wallHung', c.item.mount === 'wall')
  const hasTank = c.bool('tank', !wallHung && H > 0.55)
  const lidOpen = c.bool('lidOpen', false)
  const bidet = c.bool('bidet', false)
  const tankD = hasTank ? Math.min(0.2, D * 0.3) : Math.min(0.08, D * 0.15)
  const seatTop = hasTank ? Math.min(0.43, H * 0.56) : H
  const seatT = 0.022
  const lidT = 0.025
  // a bidet has no seat: its rim is the top; leave room for the mixer on the rear deck
  const rimY = bidet ? H - 0.012 : seatTop - (lidOpen ? seatT : seatT + lidT)
  const R = W / 2 - 0.005
  const bowlLen = D - tankD - 0.005
  const k = bowlLen / (2 * R)
  const bowlZ = D / 2 - bowlLen / 2
  const bottom = wallHung ? Math.max(0, rimY - 0.36) : 0
  const prof: [number, number][] = wallHung
    ? [
        [0.0001, bottom],
        [0.45 * R, bottom + 0.005],
        [0.68 * R, bottom + 0.05],
        [0.88 * R, rimY - 0.12],
        [0.98 * R, rimY - 0.03],
        [R, rimY - 0.008],
        [0.96 * R, rimY],
        [0.8 * R, rimY - 0.004],
        [0.62 * R, rimY - 0.07],
        [0.34 * R, rimY - 0.17],
        [0.15 * R, rimY - 0.22],
        [0.0001, rimY - 0.23],
      ]
    : [
        [0.0001, 0],
        [0.6 * R, 0],
        [0.6 * R, 0.008],
        [0.52 * R, 0.05],
        [0.5 * R, 0.13],
        [0.6 * R, 0.2],
        [0.82 * R, rimY - 0.1],
        [0.97 * R, rimY - 0.03],
        [R, rimY - 0.008],
        [0.96 * R, rimY],
        [0.8 * R, rimY - 0.004],
        [0.62 * R, rimY - 0.07],
        [0.34 * R, rimY - 0.17],
        [0.15 * R, rimY - 0.22],
        [0.0001, Math.max(0.02, rimY - 0.23)],
      ]
  c.add(lathe(prof, 48, k), 'ceramic', F.ceramic, [0, 0, bowlZ])
  // back body joining bowl and wall / tank
  const backLen = Math.max(0.05, D - bowlLen * 0.55 - (hasTank ? tankD : 0))
  const backZ = -D / 2 + (hasTank ? tankD : 0) + backLen / 2
  c.add(rbox(R * 1.1, rimY - bottom - 0.02, backLen, 0.04), 'ceramic', F.ceramic, [0, bottom + (rimY - bottom - 0.02) / 2, backZ])
  if (bidet) {
    // mixer tap on the rear deck, spout pointing into the bowl
    addFaucet(c, 0, rimY - 0.004, bowlZ - bowlLen / 2 + 0.035, 0.12, 0.07)
    // the tap rises above the rim (the item height is the rim height): keep it out of the size fit
    c.root.children[c.root.children.length - 1].traverse((o) => {
      o.userData.overflow = true
    })
    c.add(rbox(R * 1.6, Math.max(0.05, rimY - bottom), tankD, 0.01), 'ceramic', F.ceramic, [0, bottom + (rimY - bottom) / 2, -D / 2 + tankD / 2])
    return
  }
  // seat ring + lid
  const sw = 2 * R * 0.98
  const sd = bowlLen * 0.96
  const seat = slabFromShape(
    gkey('toiletSeat', sw, sd),
    () => {
      const s = ellipseShape(sw, sd)
      s.holes.push(ellipsePath(sw * 0.58, sd * 0.6, 0, sd * 0.04))
      return s
    },
    seatT,
    0.008,
    48,
  )
  c.add(seat, 'seat', F.whiteGloss, [0, rimY, bowlZ])
  if (lidOpen) {
    const lid = c.group([0, rimY + seatT, bowlZ - sd / 2 + 0.01], [-Math.PI / 2 + 0.12, 0, 0])
    c.add(ellipseSlab(sw, sd, lidT, 0.01), 'seat', F.whiteGloss, [0, 0, sd / 2], undefined, lid)
  } else {
    c.add(ellipseSlab(sw, sd, lidT, 0.01), 'seat', F.whiteGloss, [0, rimY + seatT, bowlZ])
  }
  // hinge block
  c.add(rbox(0.12, 0.02, 0.04, 0.006), 'seat', F.whiteGloss, [0, rimY + 0.01, bowlZ - sd / 2 - 0.01])
  if (hasTank) {
    const tw = Math.min(W, 0.4)
    const tankY0 = rimY - 0.02
    const th = H - tankY0
    c.add(rbox(tw - 0.01, th - 0.024, tankD - 0.01, 0.02), 'ceramic', F.ceramic, [0, tankY0 + (th - 0.024) / 2, -D / 2 + tankD / 2])
    c.add(rbox(tw, 0.02, tankD, 0.008), 'ceramic', F.ceramic, [0, H - 0.014, -D / 2 + tankD / 2])
    c.add(cyl(0.025, 0.025, 0.006, 24), 'metal', F.chrome, [0, H - 0.003, -D / 2 + tankD / 2])
  } else {
    // wall plate / frame cover
    c.add(rbox(R * 1.6, Math.max(0.05, rimY - bottom), tankD, 0.01), 'ceramic', F.ceramic, [0, bottom + (rimY - bottom) / 2, -D / 2 + tankD / 2])
  }
}

// ───────────────────────────── bathtub ─────────────────────────────

function addTubSpout(c: Ctx, x: number, yTop: number, z: number, dirX: number): void {
  // flat cascade spout + two mixer handles mounted flush on the rim
  c.add(rbox(0.11, 0.014, 0.05, 0.004), 'metal', F.chrome, [x + dirX * 0.02, yTop - 0.007, z])
  for (const s of [-1, 1]) c.add(cyl(0.018, 0.02, 0.014, 20), 'metal', F.chrome, [x - dirX * 0.015, yTop - 0.007, z + s * 0.08])
}

export function bathtub(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('style', 'builtIn', ['builtIn', 'freestanding'] as const)
  const faucet = c.bool('faucet', true)
  const fH = faucet ? 0.014 : 0
  const rimTop = H - fH
  const rimT = 0.03
  if (style === 'freestanding') {
    const R = Math.min(W, D) / 2 - 0.005
    const wall = 0.05
    c.add(bowl(W, D, R, rimTop - rimT, 0.18, 0.05, false, true), 'ceramic', F.ceramic, [0, rimTop - rimT, 0])
    c.add(bowl(W - 2 * wall, D - 2 * wall, R - wall, rimTop - rimT - 0.06, 0.12, 0.06, true), 'ceramic', F.ceramic, [0, rimTop - rimT + 0.0005, 0])
    c.add(
      slabFromShape(
        gkey('tubRim', W, D, R, wall),
        () => {
          const s = roundedRectShape(W, D, R)
          const hole = new THREE.Path()
          roundedRectPath(hole, W - 2 * wall + 0.002, D - 2 * wall + 0.002, R - wall, 0, 0, true)
          s.holes.push(hole)
          return s
        },
        rimT,
        0.012,
        32,
      ),
      'ceramic',
      F.ceramic,
      [0, rimTop - rimT, 0],
    )
    drainDisc(c, -W / 2 + wall + 0.15, 0.06, 0)
    if (faucet) addTubSpout(c, W / 2 - wall / 2 - 0.005, H, 0, -1)
    return
  }
  const sideRim = 0.06
  const endRim = 0.1
  const iw = W - 2 * endRim
  const id = D - 2 * sideRim
  const cr = Math.min(0.14, id * 0.3)
  c.add(plateWithHole(W, D, 0.004, iw, id, cr, 0, 0, rimT, 0.006), 'ceramic', F.ceramic, [0, rimTop - rimT, 0])
  const depth = rimTop - rimT - 0.04
  c.add(bowl(iw + 0.004, id + 0.004, cr + 0.002, depth, 0.1, Math.min(0.08, iw * 0.06), true), 'ceramic', F.ceramic, [0, rimTop - rimT + 0.0005, 0])
  // apron panels
  const ah = rimTop - rimT
  c.add(box(W, ah, 0.02), 'apron', F.ceramic, [0, ah / 2, D / 2 - 0.01])
  c.add(box(W, ah, 0.02), 'apron', F.ceramic, [0, ah / 2, -D / 2 + 0.01])
  for (const s of [-1, 1]) c.add(box(0.02, ah, D - 0.04), 'apron', F.ceramic, [s * (W / 2 - 0.01), ah / 2, 0])
  drainDisc(c, -iw / 2 + 0.18, rimTop - rimT - depth, 0)
  // overflow cover on the end wall
  c.add(cylX(0.03, 0.008, 24), 'metal', F.chrome, [-iw / 2 + 0.002 + Math.min(0.08, iw * 0.06) * 0.3, rimTop - rimT - 0.08, 0])
  if (faucet) addTubSpout(c, W / 2 - endRim / 2, H, 0, -1)
}

// ───────────────────────────── shower ─────────────────────────────

export function shower(c: Ctx): void {
  const { W, H, D } = c
  const enclosure = c.str('enclosure', 'corner', ['corner', 'niche', 'walkIn', 'none'] as const)
  const hasTray = c.bool('tray', true)
  const trayH = hasTray ? clamp(c.num('trayHeight', 40) / 1000, 0.015, 0.2) : 0.004
  if (hasTray) {
    // low stone-resin tray
    c.add(rbox(W, trayH, D, 0.008), 'tray', F.ceramic, [0, trayH / 2, 0])
    drainDisc(c, 0, trayH, 0, 0.05)
  } else {
    // level-access floor: linear drain channel along the back wall + glass base profile
    c.add(rbox(Math.min(W - 0.2, 0.8), 0.004, 0.06, 0.0015), 'metal', F.steel, [0, 0.002, -D / 2 + 0.08])
  }
  const gT = 0.008
  const gy0 = trayH + 0.005
  const gh = H - gy0 - 0.03
  const glass = (w: number, x: number, z: number, alongX: boolean) => {
    c.add(alongX ? box(w, gh, gT) : box(gT, gh, w), 'glass', F.glass, [x, gy0 + gh / 2, z])
  }
  const profile = (x: number, z: number, alongX: boolean, len: number) => {
    c.add(alongX ? box(len, 0.02, 0.02) : box(0.02, 0.02, len), 'metal', F.chrome, [x, gy0 + gh + 0.01, z])
  }
  const wallChannel = (x: number, z: number) => c.add(box(0.02, gh, 0.02), 'metal', F.chrome, [x, gy0 + gh / 2, z])
  const zF = D / 2 - 0.02
  const xR = W / 2 - 0.02
  if (enclosure === 'corner' || enclosure === 'niche') {
    // front: fixed panel + hinged door with a vertical handle
    const fixedW = enclosure === 'niche' ? Math.max(0, W - 0.04 - 0.8) : W * 0.42
    const doorW = W - 0.04 - fixedW - 0.006
    if (fixedW > 0.05) glass(fixedW, -W / 2 + 0.02 + fixedW / 2, zF, true)
    const dx = W / 2 - 0.02 - doorW / 2 - (enclosure === 'corner' ? 0.01 : 0)
    glass(doorW, dx, zF + gT + 0.002, true)
    c.add(cyl(0.011, 0.011, 0.3, 16), 'metal', F.chrome, [dx - doorW / 2 + 0.06, gy0 + gh * 0.5, zF + gT + 0.04])
    for (const s of [-1, 1]) c.add(box(0.012, 0.012, 0.04), 'metal', F.chrome, [dx - doorW / 2 + 0.06, gy0 + gh * 0.5 + s * 0.12, zF + gT + 0.02])
    for (const s of [-1, 1]) c.add(rbox(0.03, 0.05, 0.02, 0.004), 'metal', F.chrome, [dx + doorW / 2 - 0.025, gy0 + gh * 0.5 + s * gh * 0.38, zF + gT + 0.004])
    wallChannel(-W / 2 + 0.01, zF)
    if (enclosure === 'corner') {
      glass(D - 0.04, xR, 0, false)
      wallChannel(xR, -D / 2 + 0.01)
      c.add(box(0.025, gh, 0.025), 'metal', F.chrome, [xR, gy0 + gh / 2, zF])
      profile(xR, 0, false, D - 0.04)
    } else {
      wallChannel(W / 2 - 0.01, zF)
    }
    profile(0, zF, true, W - 0.04)
  } else if (enclosure === 'walkIn') {
    const pw = W * 0.6
    glass(pw, -W / 2 + 0.02 + pw / 2, zF, true)
    wallChannel(-W / 2 + 0.01, zF)
    // stabiliser bar to the back wall
    c.add(cyl(0.008, 0.008, D - 0.04, 12), 'metal', F.chrome, [-W / 2 + 0.02 + pw - 0.03, gy0 + gh, 0], [Math.PI / 2, 0, 0])
  }
  // mixer column on the back wall (left side)
  const mx = enclosure === 'corner' ? -W * 0.15 : 0
  const zw = -D / 2 + 0.04
  const mixY = Math.min(1.1, H * 0.5)
  c.add(cylX(0.026, 0.3, 24), 'metal', F.chrome, [mx, mixY, zw])
  for (const s of [-1, 1]) c.add(cylX(0.03, 0.03, 24), 'metal', F.chrome, [mx + s * 0.165, mixY, zw])
  const riserTop = H - 0.06
  c.add(cyl(0.011, 0.011, riserTop - mixY, 16), 'metal', F.chrome, [mx, (mixY + riserTop) / 2, zw])
  const reach = Math.min(0.3, D * 0.35)
  c.add(
    tube(
      [
        [0, 0, 0],
        [0, 0.03, 0.01],
        [0, 0.04, reach * 0.4],
        [0, 0.035, reach],
      ],
      0.01,
      32,
      10,
    ),
    'metal',
    F.chrome,
    [mx, riserTop, zw],
  )
  const headR = Math.min(0.13, W * 0.18, D * 0.18)
  c.add(cyl(headR, headR, 0.008, 40), 'metal', F.chrome, [mx, riserTop + 0.03 - 0.004, zw + reach])
  // hand shower in its holder
  c.add(cyl(0.013, 0.011, 0.2, 16), 'metal', F.chrome, [mx + 0.08, mixY + 0.3, zw + 0.02], [0.2, 0, 0])
  c.add(cyl(0.04, 0.03, 0.03, 24), 'metal', F.chrome, [mx + 0.08, mixY + 0.41, zw + 0.045], [0.2, 0, 0])
}

// ───────────────────────────── washbasin / vanity ─────────────────────────────

export function washbasin(c: Ctx): void {
  const { W, H, D } = c
  const hasCabinet = c.bool('cabinet', true)
  const basin = c.str('basin', 'integrated', ['integrated', 'vessel'] as const)
  const wantMirror = c.bool('mirror', false)
  const mirror = wantMirror && H > 1.2
  const faucetH = basin === 'vessel' ? 0.3 : 0.2
  const vh = mirror ? clamp(c.num('vanityHeight', 550) / 1000, 0.25, H - 0.5) : Math.max(0.15, H - faucetH)
  const topT = basin === 'vessel' ? 0.03 : 0.04
  const vanityD = D
  const zb = -D / 2
  // countertop / basin slab
  // the vanity carcass follows the fronts; the mirror frame is metal unless overridden
  c.slotAlias.frame = 'metal'
  const nBowls = W >= 0.95 ? c.int('bowls', 1, 1, 2) : 1
  const bw = Math.min(nBowls === 2 ? W / 2 - 0.1 : W - 0.1, basin === 'vessel' ? 0.42 : nBowls === 2 ? W * 0.32 : W * 0.62)
  const bdp = Math.min(vanityD - 0.12, basin === 'vessel' ? 0.36 : vanityD * 0.6)
  const bz = zb + vanityD / 2 + 0.02
  const bxs = nBowls === 2 ? [-W / 4, W / 4] : [0]
  if (basin === 'integrated') {
    const br = Math.min(0.06, bdp * 0.3)
    c.add(
      plateWithHoles(W, vanityD, 0.01, bxs.map((x) => ({ w: bw, d: bdp, r: br, x, z: 0.02 })), topT, 0.008),
      'ceramic',
      F.ceramic,
      [0, vh - topT, zb + vanityD / 2],
    )
    for (const x of bxs) {
      c.add(bowl(bw + 0.004, bdp + 0.004, br + 0.002, 0.13, 0.05, 0.02, true), 'ceramic', F.ceramic, [x, vh - 0.0005, bz])
      drainDisc(c, x, vh - 0.13, bz, 0.02)
      addFaucet(c, x, vh, bz - bdp / 2 - 0.045, Math.min(0.2, (mirror ? 0.25 : H - vh) - 0.002), 0.11)
    }
  } else {
    c.add(rbox(W, topT, vanityD, 0.003), 'top', F.stone, [0, vh - topT / 2, zb + vanityD / 2])
    // vessel basin: lathe with outer + inner surfaces
    const vr = Math.min(bw, bdp) / 2
    const vh2 = 0.14
    const k = bdp / bw
    for (const x of bxs) {
    c.add(
      lathe(
        [
          [0.0001, 0],
          [vr * 0.55, 0],
          [vr * 0.8, vh2 * 0.25],
          [vr * 0.97, vh2 * 0.7],
          [vr, vh2],
          [vr * 0.94, vh2],
          [vr * 0.9, vh2 * 0.7],
          [vr * 0.7, vh2 * 0.3],
          [vr * 0.35, vh2 * 0.12],
          [0.0001, vh2 * 0.1],
        ],
        48,
        k,
      ),
      'ceramic',
      F.ceramic,
      [x, vh, bz],
    ).scale.set(bw / (2 * vr), 1, 1)
    drainDisc(c, x, vh + vh2 * 0.1, bz, 0.02)
    addFaucet(c, x, vh, bz - bdp / 2 - 0.05, Math.min(0.3, (mirror ? 0.35 : H - vh) - 0.002), Math.min(0.2, bdp * 0.6))
    }
  }
  const cabH = vh - topT
  if (hasCabinet) {
    const frontT = 0.018
    const cabD = vanityD - 0.02 - frontT
    c.add(rbox(W - 0.01, cabH, cabD, 0.002), 'cabinet', F.white, [0, cabH / 2, zb + cabD / 2])
    const layout = c.str('layout', 'drawers', ['drawers', 'doors'] as const)
    addFronts(c, -W / 2 + 0.005, W / 2 - 0.005, 0, cabH, zb + cabD + 0.001, {
      layout,
      doors: W > 0.7 ? 2 : 1,
      drawers: c.int('drawers', cabH > 0.5 ? 2 : 1, 1, 4),
      handle: c.str('handle', 'bar', ['bar', 'knob', 'none', 'edge'] as const) as HandleStyle,
      handlePos: 'top',
      gap: 0.003,
      thick: frontT,
    })
  } else {
    // pedestal
    c.add(
      lathe(
        [
          [0.0001, 0],
          [0.12, 0],
          [0.11, 0.02],
          [0.085, 0.1],
          [0.075, cabH * 0.6],
          [0.1, cabH - 0.02],
          [0.16, cabH],
          [0.0001, cabH],
        ],
        40,
        0.8,
      ),
      'ceramic',
      F.ceramic,
      [0, 0, bz - 0.04],
    )
  }
  if (mirror) {
    const my0 = vh + 0.3
    const mh = H - my0
    const mw = W * 0.9
    c.add(rbox(mw, mh, 0.02, 0.004), 'frame', F.blackMetal, [0, my0 + mh / 2, zb + 0.01])
    c.add(box(mw - 0.02, mh - 0.02, 0.004), 'mirror', F.mirror, [0, my0 + mh / 2, zb + 0.022])
  }
}
