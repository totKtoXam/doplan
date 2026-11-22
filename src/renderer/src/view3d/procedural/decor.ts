/** Decor & structure: mirror, picture, column, stairs, plant pot. */
import * as THREE from 'three'
import {
  type Ctx,
  F,
  type V3,
  box,
  cached,
  clamp,
  cyl,
  doubleSide,
  extrudeFront,
  extrudeSide,
  gkey,
  lathe,
  mat4,
  merge,
  rbox,
  rng,
  roundedRectPath,
  tube,
} from './common'

// ───────────────────────────── mirror & picture ─────────────────────────────

type Outline = 'rect' | 'round' | 'arch'

function outlinePath(p: THREE.Path, kind: Outline, w: number, h: number, r: number): void {
  if (kind === 'round') {
    p.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2, false, 0)
    return
  }
  if (kind === 'arch') {
    const ar = Math.min(w / 2, h / 2)
    p.moveTo(-w / 2, -h / 2)
    p.lineTo(w / 2, -h / 2)
    p.lineTo(w / 2, h / 2 - ar)
    p.absarc(0, h / 2 - ar, ar, 0, Math.PI, false)
    p.lineTo(-w / 2, -h / 2)
    return
  }
  roundedRectPath(p, w, h, r, 0, 0, false)
}

function outlineShape(kind: Outline, w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  outlinePath(s, kind, w, h, r)
  return s
}

function frameRing(kind: Outline, w: number, h: number, fw: number, depth: number, bevel: number): THREE.BufferGeometry {
  return extrudeFront(
    gkey('frameRing', kind, w, h, fw),
    () => {
      const s = outlineShape(kind, w, h, 0.002)
      const hole = new THREE.Path()
      outlinePath(hole, kind, w - 2 * fw, h - 2 * fw, 0.001)
      s.holes.push(hole)
      return s
    },
    depth,
    bevel,
    kind === 'rect' ? 4 : 48,
  )
}

export function mirror(c: Ctx): void {
  const { W, H, D } = c
  const kind = c.str('shape', 'rect', ['rect', 'round', 'arch'] as const)
  const fw = clamp(c.num('frameWidth', 30) / 1000, 0, Math.min(W, H) * 0.3)
  const glassT = Math.min(0.005, D * 0.5)
  if (fw < 0.002) {
    // frameless with bevelled glass edge on a backing plate
    c.add(extrudeFront(gkey('mirrorBack', kind, W, H), () => outlineShape(kind, W - 0.01, H - 0.01, 0.004), Math.max(0.002, D - glassT), 0), 'frame', F.blackMatte, [0, H / 2, -D / 2 + (D - glassT) / 2])
    c.add(extrudeFront(gkey('mirrorGlass', kind, W, H), () => outlineShape(kind, W, H, 0.004), glassT, glassT * 0.45), 'mirror', F.mirror, [0, H / 2, D / 2 - glassT / 2])
    return
  }
  c.add(frameRing(kind, W, H, fw, D, Math.min(0.004, fw * 0.3, D * 0.3)), 'frame', F.blackMetal, [0, H / 2, 0])
  c.add(extrudeFront(gkey('mirrorInner', kind, W, H, fw), () => outlineShape(kind, W - 2 * fw + 0.004, H - 2 * fw + 0.004, 0.001), glassT, 0), 'mirror', F.mirror, [0, H / 2, D / 2 - Math.min(0.006, D * 0.4) - glassT / 2])
  // backing board
  c.add(extrudeFront(gkey('mirrorBoard', kind, W, H, fw), () => outlineShape(kind, W - 2 * fw + 0.004, H - 2 * fw + 0.004, 0.001), 0.003, 0), 'frame', F.blackMatte, [0, H / 2, -D / 2 + 0.0015])
}

export function picture(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('style', 'framed', ['framed', 'canvas'] as const)
  if (style === 'canvas') {
    // gallery-wrapped canvas on a stretcher
    c.add(rbox(W, H, D, Math.min(0.003, D * 0.2)), 'canvas', F.canvas, [0, H / 2, 0])
    return
  }
  const fw = clamp(c.num('frameWidth', 25) / 1000, 0.005, Math.min(W, H) * 0.25)
  const matW = c.bool('mat', true) ? clamp(c.num('matWidth', Math.min(W, H) * 1000 * 0.12) / 1000, 0, Math.min(W, H) * 0.3) : 0
  c.add(frameRing('rect', W, H, fw, D, Math.min(0.003, fw * 0.3, D * 0.3)), 'frame', F.walnut, [0, H / 2, 0])
  const iw = W - 2 * fw + 0.004
  const ih = H - 2 * fw + 0.004
  const zFace = D / 2 - Math.min(0.006, D * 0.4)
  if (matW > 0.002) {
    c.add(box(iw, ih, 0.002), 'mat', F.white, [0, H / 2, zFace - 0.001])
    c.add(box(iw - 2 * matW, ih - 2 * matW, 0.001), 'canvas', F.canvas, [0, H / 2, zFace - 0.0015])
  } else {
    c.add(box(iw, ih, 0.002), 'canvas', F.canvas, [0, H / 2, zFace - 0.001])
  }
  // protective glass
  c.add(box(iw, ih, 0.002), 'glass', F.glass, [0, H / 2, zFace + 0.0012])
  // back board
  c.add(box(iw, ih, 0.003), 'frame', F.blackMatte, [0, H / 2, -D / 2 + 0.0015])
}

// ───────────────────────────── column ─────────────────────────────

export function column(c: Ctx): void {
  const { W, H, D } = c
  const shape = c.str('shape', 'square', ['square', 'round'] as const)
  if (shape === 'round') {
    const r = Math.max(W, D) / 2
    c.add(cyl(r, r, H, 64), 'body', F.plaster, [0, H / 2, 0]).scale.set(W / (2 * r), 1, D / (2 * r))
    return
  }
  c.add(rbox(W, H, D, Math.min(0.003, Math.min(W, D) * 0.05)), 'body', F.plaster, [0, H / 2, 0])
}

// ───────────────────────────── stairs ─────────────────────────────

interface FlightOpts {
  open: boolean
  /** stringer thickness (0 = none) */
  st: number
  /** local sides (-1 left, +1 right) that get a balustrade */
  rails: number[]
  nosing: number
}

/**
 * One straight flight in its own frame: width along X centred on 0, the first riser line at z = 0,
 * climbing towards -Z. `a` treads, tread i has its top at y0 + i·r and its front edge at -(i-1)·going.
 */
function addFlight(c: Ctx, parent: THREE.Object3D, w: number, a: number, r: number, going: number, y0: number, o: FlightOpts): void {
  if (a < 1) return
  const tt = Math.min(0.04, r * 0.4)
  const tw = w - 2 * o.st
  const depthT = going + o.nosing
  for (let i = 1; i <= a; i++) {
    const zEdge = -(i - 1) * going
    c.add(rbox(tw, tt, depthT, 0.004), 'treads', F.oak, [0, y0 + i * r - tt / 2, zEdge + o.nosing - depthT / 2], undefined, parent)
    if (!o.open) c.add(box(tw - 0.002, r - tt, 0.018), 'risers', F.white, [0, y0 + (i - 1) * r + (r - tt) / 2, zEdge - 0.009], undefined, parent)
  }
  if (o.st > 0 && a >= 2) {
    const yB = y0 + r + 0.04
    const zC = -a * going
    const yC = y0 + a * r
    const slope = ((a - 1) * r) / ((a - 1) * going)
    const band = Math.min(0.3, Math.max(0.12, a * r * 0.25))
    const yDd = Math.max(y0, yC - band - 0.04)
    let zE = zC + (yDd - y0) / slope
    if (zE > o.nosing) zE = o.nosing
    const g = extrudeSide(
      gkey('stringer', a, r, going, y0, band, o.nosing),
      () => {
        const s = new THREE.Shape()
        s.moveTo(o.nosing, y0)
        s.lineTo(o.nosing, Math.min(yC, yB))
        s.lineTo(zC, yC)
        s.lineTo(zC, yDd)
        s.lineTo(zE, y0)
        s.closePath()
        return s
      },
      o.st,
      Math.min(0.004, o.st * 0.2),
      2,
    )
    for (const sx of [-1, 1]) c.add(g, 'stringers', F.oak, [sx * (w / 2 - o.st / 2), 0, 0], undefined, parent)
  }
  const railH = 0.9
  for (const sx of o.rails) {
    const x = sx * (w / 2 - Math.max(o.st, 0.03) / 2)
    const pts: V3[] = []
    for (let i = 1; i <= a; i++) {
      const z = -(i - 0.5) * going
      const yt = y0 + i * r
      const b = c.add(cyl(0.012, 0.012, railH, 12), 'railing', F.blackMetal, [x, yt + railH / 2, z], undefined, parent)
      b.userData.overflow = true
      if (i === 1 || i === a) pts.push([x, yt + railH, z])
    }
    if (pts.length === 2) {
      const hr = c.add(tube(pts, 0.02, 8, 12), 'handrail', F.oak, [0, 0, 0], undefined, parent)
      hr.userData.overflow = true
    }
  }
}

/** landing slab with support posts at the given (x, z) points */
function addLanding(c: Ctx, cx: number, cz: number, w: number, d: number, top: number, posts: [number, number][]): void {
  const t = 0.04
  c.add(rbox(w, t, d, 0.004), 'treads', F.oak, [cx, top - t / 2, cz])
  c.add(box(w - 0.01, 0.12, d - 0.01), 'stringers', F.oak, [cx, top - t - 0.06, cz])
  for (const [x, z] of posts) {
    const h = Math.max(0.02, top - t - 0.12)
    c.add(rbox(0.07, h, 0.07, 0.004), 'stringers', F.oak, [x, h / 2, z])
  }
}

export function stairs(c: Ctx): void {
  const { W, H, D } = c
  const type = c.str('type', 'straight', ['straight', 'L', 'U'] as const)
  const N = c.int('steps', Math.max(3, Math.round(H / 0.175)), 3, 40)
  const r = H / N
  const open = c.bool('open', false)
  const st = c.bool('stringers', true) ? Math.min(0.05, W * 0.05) : 0
  const nosing = 0.02
  const railing = c.str('railing', type === 'straight' ? 'right' : 'inner', ['none', 'left', 'right', 'both', 'inner'] as const)
  const sidesFor = (inner: number): number[] =>
    railing === 'none' ? [] : railing === 'both' ? [-1, 1] : railing === 'left' ? [-1] : railing === 'right' ? [1] : [inner]
  const base = { open, st, nosing }
  if (type === 'straight' || W < 1.2 || D < 1.2) {
    const going = (D - nosing) / N
    const g = c.group([0, 0, D / 2 - nosing])
    addFlight(c, g, W, N, r, going, 0, { ...base, rails: sidesFor(1) })
    return
  }
  if (type === 'L') {
    // first flight along the right side towards the back, quarter landing, second flight to the left
    const fw = clamp(Math.min(W, D) * 0.5, 0.6, 1.1)
    const run1 = D - fw
    const run2 = W - fw
    const n1 = clamp(Math.round((N * run1) / (run1 + run2)), 2, N - 1)
    const a1 = n1 - 1
    const a2 = N - n1
    const g1 = c.group([W / 2 - fw / 2, 0, D / 2 - nosing])
    addFlight(c, g1, fw, a1, r, (run1 - nosing) / Math.max(1, a1), 0, { ...base, rails: sidesFor(-1) })
    const landTop = n1 * r
    addLanding(c, W / 2 - fw / 2, -D / 2 + fw / 2, fw, fw, landTop, [
      [W / 2 - fw + 0.035, -D / 2 + fw - 0.035],
      [W / 2 - 0.035, -D / 2 + fw - 0.035],
    ])
    const g2 = c.group([W / 2 - fw, 0, -D / 2 + fw / 2], [0, Math.PI / 2, 0])
    addFlight(c, g2, fw, a2, r, run2 / Math.max(1, a2), landTop, { ...base, rails: sidesFor(-1) })
    return
  }
  // U: two parallel flights with a half landing across the back
  const gap = Math.min(0.1, W * 0.05)
  const fw = (W - gap) / 2
  const run = D - fw
  const n1 = clamp(Math.ceil(N / 2), 2, N - 1)
  const a1 = n1 - 1
  const a2 = N - n1
  const g1 = c.group([W / 2 - fw / 2, 0, D / 2 - nosing])
  addFlight(c, g1, fw, a1, r, (run - nosing) / Math.max(1, a1), 0, { ...base, rails: sidesFor(-1) })
  const landTop = n1 * r
  addLanding(c, 0, -D / 2 + fw / 2, W, fw, landTop, [
    [W / 2 - 0.035, -D / 2 + fw - 0.035],
    [0, -D / 2 + fw - 0.035],
    [-W / 2 + 0.035, -D / 2 + fw - 0.035],
  ])
  const g2 = c.group([-W / 2 + fw / 2, 0, -D / 2 + fw], [0, Math.PI, 0])
  addFlight(c, g2, fw, a2, r, run / Math.max(1, a2), landTop, { ...base, rails: sidesFor(-1) })
}

// ───────────────────────────── plant pot ─────────────────────────────

/** single leaf lying along +X from the origin, slightly cupped and drooping, visible from both sides */
function leafGeometry(kind: 'broad' | 'small' | 'sword', len: number): THREE.BufferGeometry {
  return cached(gkey('leaf', kind, len), () => {
    const wRatio = kind === 'broad' ? 0.42 : kind === 'small' ? 0.45 : 0.09
    const hw = (len * wRatio) / 2
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    s.bezierCurveTo(len * 0.25, hw * 1.25, len * 0.7, hw * 1.0, len, 0)
    s.bezierCurveTo(len * 0.7, -hw * 1.0, len * 0.25, -hw * 1.25, 0, 0)
    const g = new THREE.ShapeGeometry(s, kind === 'sword' ? 10 : 8)
    // ShapeGeometry lies in XY; turn so the blade is in XZ (face up)
    g.rotateX(-Math.PI / 2)
    const pos = g.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const t = x / len
      const cup = (Math.abs(z) / Math.max(1e-4, hw)) ** 2 * hw * 0.35
      const droop = kind === 'sword' ? 0 : t * t * len * 0.28
      pos.setY(i, cup - droop)
    }
    g.computeVertexNormals()
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n)
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i)
      uv[i * 2 + 1] = pos.getZ(i)
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    return doubleSide(g)
  })
}

export function plantPot(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('style', 'bush', ['bush', 'tall', 'grass'] as const)
  const seed = c.int('seed', 7, 0, 1e6)
  const potH = clamp(c.num('potHeight', Math.min(H * 0.32, 0.45) * 1000) / 1000, 0.08, H * 0.6)
  const rp = clamp(c.num('potDiameter', Math.min(W, D) * 1000 * 0.55) / 2000, 0.05, Math.min(W, D) / 2)
  const rb = rp * 0.78
  const soilY = potH - 0.035
  c.add(
    lathe(
      [
        [0.0001, 0],
        [rb, 0],
        [rb + 0.004, 0.006],
        [rp - 0.004, potH - 0.035],
        [rp + 0.006, potH - 0.03],
        [rp + 0.006, potH],
        [rp - 0.008, potH],
        [rp - 0.012, soilY],
        [0.0001, soilY],
      ],
      48,
    ),
    'pot',
    F.terracotta,
    [0, 0, 0],
  )
  c.add(cyl(rp - 0.012, rp - 0.014, 0.01, 40), 'soil', F.soil, [0, soilY + 0.004, 0])
  const fH = H - soilY
  const R = rng(seed + (style === 'tall' ? 1000 : style === 'grass' ? 2000 : 0))
  const crownR = Math.max(W, D) / 2
  const leaves = cached(gkey('foliage', style, seed, W, D, fH, rp), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    if (style === 'grass') {
      const n = 18
      for (let i = 0; i < n; i++) {
        const len = fH * (0.6 + R() * 0.4)
        const leaf = leafGeometry('sword', len)
        const a = R() * Math.PI * 2
        const rr = R() * rp * 0.5
        const tilt = Math.PI / 2 - (0.08 + R() * 0.25)
        parts.push({ g: leaf, m: mat4([Math.cos(a) * rr, 0, Math.sin(a) * rr], [0, -a, tilt]) })
      }
    } else if (style === 'tall') {
      const n = 160
      const leafLen = Math.max(0.06, Math.min(0.12, crownR * 0.25))
      const leaf = leafGeometry('small', leafLen)
      const cy = fH * 0.68
      const ry = fH * 0.32
      for (let i = 0; i < n; i++) {
        const u = R() * 2 - 1
        const th = R() * Math.PI * 2
        const rad = Math.cbrt(R())
        const p: V3 = [Math.sqrt(1 - u * u) * Math.cos(th) * crownR * 0.85 * rad, cy + u * ry * rad, Math.sqrt(1 - u * u) * Math.sin(th) * crownR * 0.85 * rad]
        parts.push({ g: leaf, m: mat4(p, [R() * 0.6 - 0.3, R() * Math.PI * 2, R() * 0.9 - 0.2]) })
      }
    } else {
      const n = 46
      const leafLen = Math.max(0.1, Math.min(0.32, crownR * 0.75))
      const leaf = leafGeometry('broad', leafLen)
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2
        const h = fH * (0.25 + R() * 0.6)
        const base: V3 = [Math.cos(a) * rp * 0.25, h * 0.6, Math.sin(a) * rp * 0.25]
        const pitch = 0.2 + R() * 0.7
        const s = 0.75 + R() * 0.5
        parts.push({ g: leaf, m: mat4(base, [0, -a, pitch], [s, s, s]) })
      }
    }
    return merge(parts)
  })
  c.add(leaves, 'leaves', F.leaf, [0, soilY, 0])
  // stems / trunk
  const stems = cached(gkey('stems', style, seed, W, D, fH, rp), () => {
    const S = rng(seed + 5)
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    if (style === 'tall') {
      const trunk = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02, fH * 0.3, -0.01), new THREE.Vector3(-0.01, fH * 0.55, 0.01), new THREE.Vector3(0, fH * 0.7, 0)]),
        24,
        Math.max(0.012, rp * 0.12),
        8,
        false,
      )
      parts.push({ g: trunk })
      for (let i = 0; i < 5; i++) {
        const a = S() * Math.PI * 2
        const y0 = fH * (0.42 + S() * 0.2)
        const br = new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([new THREE.Vector3(0, y0, 0), new THREE.Vector3(Math.cos(a) * crownR * 0.35, y0 + fH * 0.12, Math.sin(a) * crownR * 0.35), new THREE.Vector3(Math.cos(a) * crownR * 0.6, y0 + fH * 0.22, Math.sin(a) * crownR * 0.6)]),
          12,
          Math.max(0.005, rp * 0.05),
          6,
          false,
        )
        parts.push({ g: br })
      }
    } else if (style === 'bush') {
      for (let i = 0; i < 9; i++) {
        const a = S() * Math.PI * 2
        const h = fH * (0.3 + S() * 0.4)
        const st = new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * rp * 0.2, h * 0.5, Math.sin(a) * rp * 0.2), new THREE.Vector3(Math.cos(a) * rp * 0.3, h * 0.6, Math.sin(a) * rp * 0.3)]),
          10,
          0.004,
          5,
          false,
        )
        parts.push({ g: st })
      }
    } else {
      parts.push({ g: new THREE.CylinderGeometry(rp * 0.3, rp * 0.35, 0.02, 16), m: mat4([0, 0.01, 0]) })
    }
    return merge(parts)
  })
  c.add(stems, 'stem', F.stem, [0, soilY, 0])
}
