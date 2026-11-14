/** Tables and chairs. */
import * as THREE from 'three'
import { buildSofa, sofaSpecFromCtx } from './soft'
import {
  type Ctx,
  F,
  boxUV,
  cached,
  clamp,
  cushion,
  cyl,
  ellipseSlab,
  gkey,
  lathe,
  rbox,
  roundedSlab,
  smooth,
  sphere,
  taperedLeg,
  torus,
} from './common'

/** panel curved around the Y axis (backrests): edges come forward by bend · x² */
export function curvedPanel(w: number, h: number, t: number, bend: number): THREE.BufferGeometry {
  return cached(gkey('curvedPanel', w, h, t, bend), () => {
    const g = new THREE.BoxGeometry(w, h, t, 16, 2, 1)
    const pos = g.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setZ(i, pos.getZ(i) + bend * x * x)
    }
    const sm = smooth(g, 1e-6)
    return boxUV(sm)
  })
}

export function table(c: Ctx): void {
  const { W, H, D } = c
  const shape = c.str('shape', 'rect', ['rect', 'round', 'oval'] as const)
  const legs = c.str('legs', shape === 'rect' ? 'square' : 'pedestal', ['square', 'tapered', 'pedestal', 'frame', 'panel', 'tripod'] as const)
  const topT = clamp(c.num('topThickness', 30) / 1000, 0.012, Math.min(0.1, H * 0.3))
  const yTop = H - topT
  const round = shape !== 'rect'
  const top = round ? ellipseSlab(W, D, topT, Math.min(0.006, topT * 0.3)) : roundedSlab(W, D, topT, Math.min(0.012, Math.min(W, D) * 0.05), Math.min(0.004, topT * 0.25))
  c.add(top, 'top', F.oak, [0, yTop, 0])
  const legH = yTop
  const legMat = legs === 'frame' ? F.blackMetal : F.oak
  // leg positions
  const insetX = round ? W * 0.33 : W / 2 - 0.06
  const insetZ = round ? D * 0.33 : D / 2 - 0.06
  const corners: [number, number][] = [
    [-insetX, -insetZ],
    [insetX, -insetZ],
    [-insetX, insetZ],
    [insetX, insetZ],
  ]
  switch (legs) {
    case 'square': {
      const lw = clamp(Math.min(W, D) * 0.06, 0.035, 0.07)
      for (const [x, z] of corners) c.add(rbox(lw, legH, lw, 0.003), 'legs', legMat, [x, legH / 2, z])
      if (!round) {
        const apronH = Math.min(0.08, legH * 0.12)
        const ay = yTop - apronH / 2
        c.add(rbox(2 * insetX - lw, apronH, 0.02, 0.002), 'legs', legMat, [0, ay, insetZ])
        c.add(rbox(2 * insetX - lw, apronH, 0.02, 0.002), 'legs', legMat, [0, ay, -insetZ])
        c.add(rbox(0.02, apronH, 2 * insetZ - lw, 0.002), 'legs', legMat, [insetX, ay, 0])
        c.add(rbox(0.02, apronH, 2 * insetZ - lw, 0.002), 'legs', legMat, [-insetX, ay, 0])
      }
      break
    }
    case 'tapered': {
      const leg = taperedLeg(legH, 0.024, 0.015)
      for (const [x, z] of corners) c.add(leg, 'legs', legMat, [x, 0, z])
      break
    }
    case 'tripod': {
      // three splayed tapered legs meeting under the centre of the top
      const rTop = Math.min(W, D) * 0.18
      const splay = Math.min(W, D) * 0.14
      const len = Math.hypot(legH, splay)
      const ang = Math.atan2(splay, legH)
      const leg = taperedLeg(len, 0.02, 0.012)
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 2
        const g = c.group([0, 0, 0], [0, -a, 0])
        // leg foot at radius rTop + splay, top at rTop; tilt the top inwards
        c.add(leg, 'legs', legMat, [rTop + splay, 0, 0], [0, 0, ang], g)
      }
      c.add(cyl(rTop + 0.02, rTop + 0.02, 0.018, 40), 'legs', legMat, [0, yTop - 0.009, 0])
      break
    }
    case 'pedestal': {
      const baseW = Math.min(W, D) * 0.55
      const sx = W >= D ? 1 + (W - D) / (D * 2) : 1
      const sz = D > W ? 1 + (D - W) / (W * 2) : 1
      c.add(
        lathe(
          [
            [0.0001, 0],
            [baseW / 2, 0],
            [baseW / 2, 0.012],
            [baseW * 0.42, 0.03],
            [0.06, 0.06],
            [0.045, 0.12],
            [0.04, legH * 0.85],
            [0.07, legH - 0.012],
            [0.12, legH - 0.004],
            [0.12, legH],
            [0.0001, legH],
          ],
          48,
        ),
        'legs',
        legMat,
        [0, 0, 0],
      ).scale.set(sx, 1, sz)
      break
    }
    case 'frame': {
      const tube = 0.03
      for (const s of [-1, 1]) {
        const x = s * (W / 2 - 0.08)
        c.add(rbox(tube, legH, tube, 0.003), 'legs', legMat, [x, legH / 2, -insetZ])
        c.add(rbox(tube, legH, tube, 0.003), 'legs', legMat, [x, legH / 2, insetZ])
        c.add(rbox(tube, tube, 2 * insetZ + tube, 0.003), 'legs', legMat, [x, tube / 2, 0])
        c.add(rbox(tube, tube, 2 * insetZ + tube, 0.003), 'legs', legMat, [x, yTop - tube / 2, 0])
      }
      c.add(rbox(W - 0.16, tube * 0.8, tube * 0.8, 0.003), 'legs', legMat, [0, yTop - tube / 2, 0])
      break
    }
    case 'panel': {
      const pt = clamp(topT * 1.2, 0.025, 0.06)
      for (const s of [-1, 1]) c.add(rbox(pt, legH, D * 0.85, 0.003), 'legs', legMat, [s * (W / 2 - 0.1), legH / 2, 0])
      c.add(rbox(W - 0.2, 0.08, 0.025, 0.003), 'legs', legMat, [0, yTop - 0.06, 0])
      break
    }
  }
}

export function chair(c: Ctx): void {
  const variant = c.str('variant', 'dining', ['dining', 'office', 'stool', 'armchair'] as const)
  if (variant === 'armchair') return buildSofa(c, sofaSpecFromCtx(c, true))
  if (variant === 'stool') return stool(c)
  if (variant === 'office') return officeChair(c)
  return diningChair(c)
}

function diningChair(c: Ctx): void {
  const { W, H, D } = c
  const seatH = clamp(c.num('seatHeight', 460) / 1000, 0.2, H - 0.1)
  const upholstered = c.bool('upholstered', true)
  const seatT = 0.03
  const legW = 0.03
  const backZ = -D / 2 + legW / 2
  const frontZ = D / 2 - legW / 2 - 0.01
  const sx = W / 2 - legW / 2 - 0.01
  // seat board
  c.add(roundedSlab(W - 0.01, D - 0.04, seatT, 0.03, 0.006), 'frame', F.oak, [0, seatH - seatT, 0.01])
  if (upholstered) c.add(cushion(W - 0.04, 0.045, D - 0.08, 0.02, 0.008), 'fabric', F.fabricBeige, [0, seatH + 0.0225 - 0.004, 0.015])
  // front legs (tapered)
  const fl = taperedLeg(seatH - seatT, 0.016, 0.012)
  for (const s of [-1, 1]) c.add(fl, 'legs', F.oak, [s * sx, 0, frontZ])
  // back posts: floor → top, slightly reclined
  const recline = 0.06
  const postLen = Math.hypot(H, recline)
  const ang = Math.atan2(recline, H)
  const postZ = (y: number): number => backZ + recline * (1 - y / H)
  for (const s of [-1, 1]) {
    c.add(rbox(legW, postLen, legW, 0.006), 'legs', F.oak, [s * sx, H / 2, backZ + recline / 2], [-ang, 0, 0])
  }
  // rails under the seat
  const railY = seatH - seatT - 0.035
  c.add(rbox(2 * sx, 0.05, 0.018, 0.003), 'legs', F.oak, [0, railY, frontZ])
  c.add(rbox(2 * sx, 0.05, 0.018, 0.003), 'legs', F.oak, [0, railY, postZ(railY)])
  // curved backrest between the posts
  const backH = Math.min(0.2, (H - seatH) * 0.45)
  const by = H - backH / 2 - 0.02
  const bz = postZ(by) + 0.012
  c.add(curvedPanel(2 * sx + legW * 0.5, backH, 0.016, 0.25), upholstered ? 'fabric' : 'frame', upholstered ? F.fabricBeige : F.oak, [0, by, bz], [-ang, 0, 0])
  const midY = seatH + (H - seatH) * 0.3
  c.add(rbox(2 * sx, 0.025, 0.016, 0.004), 'legs', F.oak, [0, midY, postZ(midY)])
}

function stool(c: Ctx): void {
  const { W, H, D } = c
  const r = Math.min(W, D) / 2
  const hasBack = c.bool('back', false) && H > 0.5
  // with a backrest the item height includes the back; the seat sits at seatHeight
  const seatTop = hasBack ? clamp(c.num('seatHeight', H * 1000 * 0.7) / 1000, 0.3, H - 0.15) : H
  const seatT = Math.min(0.05, seatTop * 0.1)
  const cushT = c.bool('upholstered', false) ? Math.min(0.03, seatTop * 0.05) : 0
  const seatY = seatTop - cushT - seatT
  if (hasBack) {
    // two rear posts rising from the seat and a curved backrest
    const backH = Math.min(0.16, (H - seatTop) * 0.55)
    const postTop = H
    const postLen = postTop - seatY + 0.02
    const pz = -r * 0.78
    for (const s of [-1, 1]) {
      c.add(rbox(0.022, postLen, 0.022, 0.006), 'legs', F.blackMetal, [s * r * 0.55, seatY - 0.02 + postLen / 2, pz], [-0.08, 0, 0])
    }
    c.add(curvedPanel(r * 1.5, backH, 0.016, 0.9), 'seat', F.oak, [0, H - backH / 2 - 0.01, pz - 0.02], [-0.08, 0, 0])
  }
  c.add(
    lathe(
      [
        [0.0001, 0],
        [r * 0.92, 0],
        [r, seatT * 0.35],
        [r, seatT * 0.65],
        [r * 0.94, seatT],
        [0.0001, seatT],
      ],
      48,
    ),
    'seat',
    F.oak,
    [0, seatY, 0],
  )
  if (cushT > 0) c.add(cushion(r * 1.7, cushT, r * 1.7, r * 0.6, 0.006), 'fabric', F.fabric, [0, seatTop - cushT / 2, 0])
  // splayed legs: top at radius r·0.6, foot further out
  const legLen = seatY
  const splay = Math.min(r * 0.5, 0.08)
  const ang = Math.atan2(splay, legLen)
  const len = Math.hypot(legLen, splay)
  const leg = cyl(0.014, 0.012, len, 14)
  const metal = c.str('legs', 'wood', ['wood', 'metal'] as const) === 'metal'
  const base = r * 0.6
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const g = c.group([0, 0, 0], [0, -a, 0])
    c.add(leg, 'legs', metal ? F.blackMetal : F.oak, [base + splay / 2, legLen / 2, 0], [0, 0, ang], g)
  }
  // foot ring
  const ringY = Math.min(0.32, legLen * 0.38)
  const ringR = base + splay * (1 - ringY / legLen)
  c.add(torus(ringR, 0.008, 10, 48), 'legs', metal ? F.blackMetal : F.oak, [0, ringY, 0], [Math.PI / 2, 0, 0])
}

function officeChair(c: Ctx): void {
  const { W, H, D } = c
  const seatH = clamp(c.num('seatHeight', 480) / 1000, 0.3, H * 0.6)
  const baseR = Math.min(W, D) / 2 - 0.03
  const caster = 0.025
  // star base
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2
    const g = c.group([0, 0, 0], [0, -a, 0])
    c.add(rbox(baseR, 0.03, 0.045, 0.01), 'base', F.blackMatte, [baseR / 2, caster * 2 + 0.01, 0], [0, 0, 0.06], g)
    c.add(sphere(caster, 1, 1, 0.7, 16), 'base', F.blackMatte, [baseR - 0.01, caster, 0], undefined, g)
  }
  // gas lift
  const colTop = seatH - 0.08
  c.add(cyl(0.03, 0.035, colTop - 0.06, 20), 'metal', F.chrome, [0, 0.06 + (colTop - 0.06) / 2, 0])
  c.add(rbox(0.2, 0.05, 0.22, 0.01), 'base', F.blackMatte, [0, colTop + 0.02, 0])
  // seat
  const sw = Math.min(W - 0.08, 0.52)
  const sd = Math.min(D * 0.75, 0.5)
  c.add(cushion(sw, 0.08, sd, 0.03, 0.012), 'fabric', F.fabric, [0, seatH - 0.04, 0.03])
  // back on a stem
  const backH = Math.max(0.2, H - seatH - 0.1)
  const stemZ = 0.03 - sd / 2 - 0.04
  c.add(rbox(0.06, backH * 0.5 + 0.08, 0.02, 0.005), 'base', F.blackMatte, [0, seatH - 0.02 + (backH * 0.5) / 2, stemZ - 0.01], [-0.08, 0, 0])
  const back = curvedPanel(sw - 0.02, backH, 0.05, 0.6)
  c.add(back, 'fabric', F.fabric, [0, H - backH / 2, stemZ + 0.02], [-0.12, 0, 0])
  // armrests
  for (const s of [-1, 1]) {
    const x = s * (sw / 2 + 0.03)
    c.add(rbox(0.025, 0.22, 0.04, 0.006), 'base', F.blackMatte, [x, seatH + 0.07, 0.0])
    c.add(rbox(0.06, 0.025, 0.25, 0.01), 'base', F.blackMatte, [x, seatH + 0.19, 0.02])
  }
}
