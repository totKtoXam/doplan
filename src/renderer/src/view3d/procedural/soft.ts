/** Upholstered and textile items: bed, sofa (also used for armchairs), rug. */
import * as THREE from 'three'
import {
  type Ctx,
  F,
  cached,
  clamp,
  cushion,
  cyl,
  ellipseSlab,
  gkey,
  mat4,
  merge,
  pillow,
  rbox,
  roundedSlab,
  taperedLeg,
} from './common'

// ───────────────────────────── bed ─────────────────────────────

/** blanket draped over the mattress: inverted-U cross-section extruded along the bed length */
function drapeGeometry(w: number, d: number, drop: number, t: number, r: number): THREE.BufferGeometry {
  return extrudeSideX(gkey('drape', w, d, drop, t, r), w, drop, t, r, d)
}

function extrudeSideX(key: string, w: number, drop: number, t: number, r: number, len: number): THREE.BufferGeometry {
  return cached(key, () => {
    // cross-section in the XY plane: top at y = 0, sides hanging to y = -drop
    const s = new THREE.Shape()
    const hw = w / 2
    const ri = Math.max(0.005, r - t)
    s.moveTo(-hw, -drop)
    s.lineTo(-hw, -r)
    s.quadraticCurveTo(-hw, 0, -hw + r, 0)
    s.lineTo(hw - r, 0)
    s.quadraticCurveTo(hw, 0, hw, -r)
    s.lineTo(hw, -drop)
    s.lineTo(hw - t, -drop + 0.004)
    s.lineTo(hw - t, -r)
    s.quadraticCurveTo(hw - t, -t, hw - t - ri, -t)
    s.lineTo(-hw + t + ri, -t)
    s.quadraticCurveTo(-hw + t, -t, -hw + t, -r)
    s.lineTo(-hw + t, -drop + 0.004)
    s.closePath()
    const b = Math.min(0.012, t * 0.45)
    const g = new THREE.ExtrudeGeometry(s, {
      depth: Math.max(0.01, len - 2 * b),
      bevelEnabled: true,
      bevelThickness: b,
      bevelSize: b * 0.6,
      bevelOffset: -b * 0.6,
      bevelSegments: 3,
      curveSegments: 10,
    })
    g.translate(0, 0, -len / 2 + b)
    // gentle waviness along the hanging sides
    const pos = g.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y < -r) {
        const k = (-y - r) / Math.max(0.01, drop - r)
        const z = pos.getZ(i)
        const x = pos.getX(i)
        pos.setX(i, x + Math.sign(x) * k * 0.012 * Math.sin(z * 9.0 + (x > 0 ? 1.3 : 0)))
      }
    }
    for (const n of Object.keys(g.attributes)) if (n !== 'position') g.deleteAttribute(n)
    g.clearGroups()
    return creaseUV(g)
  })
}

function creaseUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.computeVertexNormals()
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i))
    const ay = Math.abs(nrm.getY(i))
    const az = Math.abs(nrm.getZ(i))
    if (ax >= ay && ax >= az) {
      uv[i * 2] = pos.getZ(i)
      uv[i * 2 + 1] = pos.getY(i)
    } else if (ay >= az) {
      uv[i * 2] = pos.getX(i)
      uv[i * 2 + 1] = pos.getZ(i)
    } else {
      uv[i * 2] = pos.getX(i)
      uv[i * 2 + 1] = pos.getY(i)
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return smoothNormalsNonIndexed(g)
}

/** average normals of coincident vertices whose normals differ by < 50° (soft fabric look) */
function smoothNormalsNonIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const map = new Map<string, number[]>()
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`
    let l = map.get(k)
    if (!l) map.set(k, (l = []))
    l.push(i)
  }
  const out = new Float32Array(pos.count * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const acc = new THREE.Vector3()
  for (const list of map.values()) {
    for (const i of list) {
      a.fromBufferAttribute(nrm, i)
      acc.set(0, 0, 0)
      for (const j of list) {
        b.fromBufferAttribute(nrm, j)
        if (a.dot(b) > 0.64) acc.add(b)
      }
      acc.normalize()
      out[i * 3] = acc.x
      out[i * 3 + 1] = acc.y
      out[i * 3 + 2] = acc.z
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3))
  return g
}

export function bed(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('headboard', H > 0.62 ? 'panel' : 'none', ['panel', 'channels', 'none'] as const)
  const frameStyle = c.str('frame', 'upholstered', ['upholstered', 'wood'] as const)
  // an upholstered frame takes the fabric slot, a wooden one the body slot; the duvet has its own colour
  c.slotAlias.frame = frameStyle === 'wood' ? 'body' : 'fabric'
  c.slotAlias.headboard = frameStyle === 'wood' ? 'body' : 'fabric'
  c.slotAlias.bedding = 'blanket'
  c.slotAlias.blanket = ''
  const legH = clamp(c.num('legHeight', 80) / 1000, 0, 0.3)
  const frameTop = clamp(c.num('frameHeight', 300) / 1000, legH + 0.08, Math.max(legH + 0.08, H * 0.6))
  const mattT = clamp(c.num('mattress', 200) / 1000, 0.08, 0.35)
  const hbT = style === 'none' ? 0 : Math.min(0.1, D * 0.06)
  const hbH = style === 'none' ? 0 : H
  const frameZ0 = -D / 2 + hbT
  const frameD = D - hbT
  const fr = frameStyle === 'wood' ? F.oak : F.fabric
  const frameR = frameStyle === 'wood' ? 0.006 : 0.025
  // frame / base
  const baseH = frameTop - legH
  c.add(rbox(W, baseH, frameD, frameR), 'frame', fr, [0, legH + baseH / 2, frameZ0 + frameD / 2])
  if (legH > 0.005) {
    const leg = taperedLeg(legH, 0.022, 0.016)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      c.add(leg, 'legs', F.walnut, [sx * (W / 2 - 0.06), 0, frameZ0 + frameD / 2 + sz * (frameD / 2 - 0.06)])
    }
  }
  // mattress inset slightly
  const inset = frameStyle === 'wood' ? 0.02 : 0.012
  const mw = W - 2 * inset
  const md = frameD - 2 * inset
  const mTop = Math.min(H, frameTop - 0.03 + mattT)
  c.add(cushion(mw, mattT, md, 0.04, 0.012), 'mattress', F.linen, [0, mTop - mattT / 2, frameZ0 + frameD / 2])
  // headboard
  if (style !== 'none') {
    const hz = -D / 2 + hbT / 2
    if (style === 'channels') {
      const n = Math.max(3, Math.round(W / 0.22))
      const cw = W / n
      for (let i = 0; i < n; i++) {
        c.add(cushion(cw - 0.004, hbH - 0.01, hbT, Math.min(cw * 0.4, 0.05), 0.008), 'headboard', fr, [-W / 2 + cw / 2 + i * cw, hbH / 2 + 0.005, hz])
      }
    } else {
      c.add(rbox(W, hbH, hbT, frameStyle === 'wood' ? 0.008 : 0.03), 'headboard', fr, [0, hbH / 2, hz])
    }
  }
  // pillows
  const nP = c.int('pillows', W > 1.25 ? 2 : 1, 0, 4)
  const pw = Math.min(0.7, (mw - 0.06) / Math.max(1, nP) - 0.02)
  const pd = Math.min(0.45, md * 0.22)
  const pt = 0.13
  for (let i = 0; i < nP; i++) {
    const x = -mw / 2 + (mw / nP) * (i + 0.5)
    c.add(pillow(pw, pt, pd), 'pillows', F.linen, [x, mTop + pt * 0.38, frameZ0 + inset + pd / 2 + 0.03], [0.3, 0, 0])
  }
  // blanket / duvet covering the lower part, folded edge near the pillows
  if (c.bool('blanket', true)) {
    const bt = 0.035
    const drop = Math.min(mattT + 0.1, mTop - legH - 0.02)
    const startZ = frameZ0 + inset + pd + 0.1
    const len = D / 2 - 0.025 - startZ
    if (len > 0.2) {
      const bw = mw + 0.05
      c.add(drapeGeometry(bw, len, drop, bt, 0.05), 'bedding', F.blanket, [0, mTop + bt, startZ + len / 2])
      // foot drape
      c.add(rbox(bw - 0.02, drop * 0.9, 0.025, 0.012), 'bedding', F.blanket, [0, mTop + bt - drop * 0.45, D / 2 - 0.0125])
      // folded-over cuff
      c.add(cushion(bw - 0.02, 0.04, 0.18, 0.018, 0.006), 'bedding', F.blanket, [0, mTop + bt + 0.012, startZ + 0.09])
    }
  }
}

// ───────────────────────────── sofa / armchair ─────────────────────────────

export interface SofaSpec {
  seats: number
  corner: 'none' | 'left' | 'right'
  mainDepth: number
  armW: number
  legH: number
  seatH: number
  armH: number
  legStyle: 'block' | 'tapered' | 'metal'
  /** armrests on both ends */
  arms: boolean
  /** back frame + back cushions (false: pouf / bench) */
  back: boolean
}

export function sofaSpecFromCtx(c: Ctx, armchair = false): SofaSpec {
  const { W, H, D } = c
  const arms = c.bool('arms', true)
  const back = c.bool('back', true)
  const corner = armchair ? 'none' : c.str('corner', 'none', ['none', 'left', 'right'] as const)
  const armW = arms ? clamp(c.num('armWidth', armchair ? 160 : 200) / 1000, 0.04, W * 0.25) : 0
  const mainDepth = corner === 'none' ? D : clamp(c.num('mainDepth', Math.min(950, D * 1000 * 0.6)) / 1000, 0.6, Math.max(0.61, D - 0.3))
  const seats = armchair ? 1 : c.int('seats', Math.max(1, Math.round((W - 2 * armW) / 0.7)), 1, 6)
  // without a back the item is a pouf/bench: its height is the seat height
  const seatDef = back ? H * 1000 * 0.5 : H * 1000
  return {
    seats,
    corner,
    mainDepth,
    armW,
    legH: clamp(c.num('legHeight', back ? 90 : Math.min(90, H * 1000 * 0.2)) / 1000, 0, Math.min(0.3, H * 0.4)),
    seatH: back ? clamp(c.num('seatHeight', seatDef) / 1000, 0.25, H * 0.75) : H,
    armH: clamp(c.num('armHeight', H * 1000 * 0.72) / 1000, 0.3, H),
    legStyle: c.str('legs', 'tapered', ['block', 'tapered', 'metal'] as const),
    arms,
    back,
  }
}

export function buildSofa(c: Ctx, s: SofaSpec): void {
  const { W, H, D } = c
  const fab = F.fabric
  const zb = -D / 2
  const backT = s.back ? Math.min(0.22, s.mainDepth * 0.25) : 0
  const cushT = Math.min(0.16, (s.seatH - s.legH) * 0.45)
  const baseTop = s.seatH - cushT
  const baseH = Math.max(0.02, baseTop - s.legH)
  const r = 0.02
  const cornerW = s.corner === 'none' ? 0 : Math.min(W * 0.45, Math.max(0.7, s.mainDepth))
  // base under the seats (spans between armrests)
  const innerX0 = -W / 2 + s.armW
  const innerX1 = W / 2 - s.armW
  const baseD = s.mainDepth - backT + (s.back ? 0.02 : 0)
  c.add(rbox(innerX1 - innerX0, baseH, baseD, r), 'fabric', fab, [(innerX0 + innerX1) / 2, s.legH + baseH / 2, zb + s.mainDepth - baseD / 2])
  // back frame
  if (s.back) {
    const backH = Math.min(H, s.seatH + (H - s.seatH) * 0.55)
    c.add(rbox(W - 2 * s.armW + 0.01, backH - s.legH, backT, 0.03), 'fabric', fab, [0, s.legH + (backH - s.legH) / 2, zb + backT / 2])
  }
  // armrests: left & right (the corner side armrest runs along the full depth)
  if (s.arms && s.armW > 0.01) {
    for (const side of [-1, 1] as const) {
      const isCornerSide = (s.corner === 'left' && side === -1) || (s.corner === 'right' && side === 1)
      const depth = isCornerSide ? D : s.mainDepth
      c.add(cushion(s.armW, s.armH - s.legH, depth, Math.min(0.06, s.armW * 0.35), 0.006), 'armrests', fab, [side * (W / 2 - s.armW / 2), s.legH + (s.armH - s.legH) / 2, zb + depth / 2])
    }
  }
  // seat cushions
  const seatD = s.mainDepth - backT - (s.back ? 0.01 : 0)
  const seatZ = zb + backT + seatD / 2
  const seatSpan = innerX1 - innerX0
  const n = s.seats
  const cw = seatSpan / n
  for (let i = 0; i < n; i++) {
    const x = innerX0 + cw / 2 + i * cw
    c.add(cushion(cw - 0.008, cushT, seatD, 0.04, 0.012), 'cushions', fab, [x, baseTop + cushT / 2, seatZ])
    if (!s.back) continue
    // back cushions leaning on the back frame
    const bh = Math.max(0.1, H - baseTop - cushT - 0.01)
    const bt = Math.min(0.2, seatD * 0.3)
    c.add(cushion(cw - 0.012, bh, bt, 0.045, 0.02), 'cushions', fab, [x, baseTop + cushT + bh / 2 - 0.005, zb + backT + bt / 2 - 0.015], [-0.12, 0, 0])
  }
  // chaise extension of the corner sofa
  if (s.corner !== 'none') {
    const side = s.corner === 'left' ? -1 : 1
    const extD = D - s.mainDepth
    const x0 = side < 0 ? innerX0 : innerX1 - (cornerW - s.armW)
    const ew = cornerW - s.armW
    const ez = zb + s.mainDepth + extD / 2
    c.add(rbox(ew, baseH, extD + 0.02, r), 'fabric', fab, [x0 + ew / 2, s.legH + baseH / 2, ez - 0.01])
    c.add(cushion(ew - 0.008, cushT, extD + 0.02, 0.04, 0.012), 'cushions', fab, [x0 + ew / 2, baseTop + cushT / 2, ez - 0.01])
    addSofaLegs(c, s, [
      [x0 + 0.06, zb + D - 0.06],
      [x0 + ew - 0.06, zb + D - 0.06],
    ])
  }
  // legs under the main block
  const lx = W / 2 - Math.min(0.06, W * 0.15)
  const lz0 = zb + Math.min(0.06, s.mainDepth * 0.15)
  const lz1 = zb + s.mainDepth - Math.min(0.06, s.mainDepth * 0.15)
  addSofaLegs(c, s, [
    [-lx, lz0],
    [lx, lz0],
    [-lx, lz1],
    [lx, lz1],
  ])
  if (s.corner !== 'none') {
    const side = s.corner === 'left' ? -1 : 1
    addSofaLegs(c, s, [[side * lx, zb + D - 0.06]])
  }
}

function addSofaLegs(c: Ctx, s: SofaSpec, at: [number, number][]): void {
  if (s.legH < 0.005) return
  let g: THREE.BufferGeometry
  if (s.legStyle === 'block') g = rbox(0.05, s.legH, 0.05, 0.004)
  else if (s.legStyle === 'metal') g = cyl(0.008, 0.008, s.legH, 12)
  else g = taperedLeg(s.legH, 0.02, 0.013)
  for (const [x, z] of at) {
    const y = s.legStyle === 'tapered' ? 0 : s.legH / 2
    c.add(g, 'legs', s.legStyle === 'metal' ? F.blackMetal : F.walnut, [x, y, z])
  }
}

export function sofa(c: Ctx): void {
  buildSofa(c, sofaSpecFromCtx(c))
}

// ───────────────────────────── rug ─────────────────────────────

export function rug(c: Ctx): void {
  const { W, H, D } = c
  const shape = c.str('shape', 'rect', ['rect', 'round'] as const)
  const fringe = c.bool('fringe', false) && shape === 'rect'
  const fl = fringe ? Math.min(0.06, D * 0.08) : 0
  const body = shape === 'round' ? ellipseSlab(W, D, H, Math.min(H * 0.45, 0.004)) : roundedSlab(W, D - 2 * fl, H, 0.01, Math.min(H * 0.45, 0.004))
  c.add(body, 'fabric', F.rug, [0, 0, 0])
  if (fringe) {
    const g = cached(gkey('fringe', W, fl, H), () => {
      const n = Math.max(8, Math.floor(W / 0.012))
      const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
      const strand = new THREE.CylinderGeometry(0.0015, 0.0015, fl, 4, 1)
      strand.rotateX(Math.PI / 2)
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + 0.01 + (i * (W - 0.02)) / (n - 1)
        parts.push({ g: strand, m: mat4([x, 0.0016, 0], [0, (Math.sin(i * 12.9898) * 0.15), 0]) })
      }
      return merge(parts)
    })
    c.add(g, 'fabric', F.rug, [0, 0, D / 2 - fl / 2])
    c.add(g, 'fabric', F.rug, [0, 0, -D / 2 + fl / 2])
  }
}
