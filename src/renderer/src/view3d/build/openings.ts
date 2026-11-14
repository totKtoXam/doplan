/**
 * Parametric doors, windows and balcony blocks that fill the holes cut by walls.ts
 * (both read the same numbers from holes.ts), plus curtains from the procedural factory.
 *
 * Local frame of an opening group: origin on the wall axis under the opening centre at floor
 * level, X along the wall (a → b), Y up, +Z = `right` side of the wall, -Z = `left` side.
 */
import * as THREE from 'three'
import { DEFAULT_MATERIALS } from '@core'
import type { DoorLeafStyle, EntityRef, Opening, Wall, WallGeom } from '@core/types'
import type { ProceduralFactory } from '@/contracts'
import type { MaterialLibraryEx } from '../materials'
import { balconyParts } from './holes'
import { GeoBuilder, MM, stampRef, w3 } from './util'

export interface OpeningInput {
  opening: Opening
  wall: Wall
  geom: WallGeom
  /** wall side that faces the room (window handles, sill board) */
  interior: 'left' | 'right'
  /** ceiling height on the curtain side, mm */
  ceilingMm: number
}

interface Parts {
  frame: GeoBuilder
  leaf: GeoBuilder
  /** lites set into an opaque leaf (always the default glass) */
  glass: GeoBuilder
  /** an all-glass leaf: the leaf material when one is chosen, else the default glass; paints as the leaf */
  glassLeaf: GeoBuilder
  metal: GeoBuilder
}

interface Frame {
  /** local z of the wall faces */
  zLeft: number
  zRight: number
  wallH: number
}

const sgn = (side: 'left' | 'right'): number => (side === 'left' ? -1 : 1)

export function buildOpening(input: OpeningInput, lib: MaterialLibraryEx, factory: ProceduralFactory): THREE.Group {
  const { opening: o, wall, geom } = input
  const ref: EntityRef = { kind: 'opening', id: o.id }
  const group = new THREE.Group()
  group.name = `opening:${o.id}`
  group.userData.ref = ref
  const L = geom.length || 1
  const dx = (geom.b.x - geom.a.x) / L
  const dy = (geom.b.y - geom.a.y) / L
  group.position.copy(w3(geom.a.x + dx * o.offset, geom.a.y + dy * o.offset, 0))
  group.rotation.y = -Math.atan2(dy, dx)

  // signed offsets of the faces along the left normal (dy, -dx); local z = -offset
  const off = (p: { x: number; y: number }): number => (p.x - geom.a.x) * dy + (p.y - geom.a.y) * -dx
  let zLeft = -off(geom.left[0]) * MM
  let zRight = -off(geom.right[0]) * MM
  if (wall.kind === 'glazing' || Math.abs(zRight - zLeft) < 0.02) {
    zLeft = -0.035
    zRight = 0.035
  }
  if (zLeft > zRight) [zLeft, zRight] = [zRight, zLeft]
  const fr: Frame = { zLeft, zRight, wallH: wall.height * MM }
  const parts: Parts = { frame: new GeoBuilder(), leaf: new GeoBuilder(), glass: new GeoBuilder(), glassLeaf: new GeoBuilder(), metal: new GeoBuilder() }

  const W = Math.max(0.2, o.width * MM)
  const y0 = Math.max(0, o.sill * MM)
  const y1 = Math.min(fr.wallH, (o.sill + o.height) * MM)
  const x0 = -W / 2
  const x1 = W / 2
  const isDoor = o.kind === 'door' || o.kind === 'doubleDoor' || o.kind === 'slidingDoor' || o.kind === 'entranceDoor'
  const leafId = o.leafMaterialId ?? DEFAULT_MATERIALS.door
  const frameId = o.frameMaterialId ?? (isDoor ? (o.leafMaterialId ?? DEFAULT_MATERIALS.door) : DEFAULT_MATERIALS.frame)
  const leafDef = lib.resolve(leafId)
  const glassLeaf = (leafDef.transmission ?? 0) > 0.3
  const look: LeafLook = o.style ?? (glassLeaf ? 'glass' : 'panel')

  if (y1 - y0 > 0.1) {
    switch (o.kind) {
      case 'door':
        doorFrame(parts, fr, x0, x1, y0, y1, 0.032, true)
        hingedLeaf(parts, fr, o, x0 + 0.032, x1 - 0.032, y0, y1 - 0.032, o.hinge, 0.04, 0.38, look)
        break
      case 'doubleDoor': {
        doorFrame(parts, fr, x0, x1, y0, y1, 0.032, true)
        const mid = 0
        hingedLeaf(parts, fr, o, x0 + 0.032, mid - 0.002, y0, y1 - 0.032, 'a', 0.04, 0.34, look)
        hingedLeaf(parts, fr, o, mid + 0.002, x1 - 0.032, y0, y1 - 0.032, 'b', 0.04, 0.16, look)
        break
      }
      case 'entranceDoor':
        doorFrame(parts, fr, x0, x1, y0, y1, 0.05, true)
        hingedLeaf(parts, fr, o, x0 + 0.05, x1 - 0.05, y0 + 0.012, y1 - 0.05, o.hinge, 0.07, 0, o.style === 'flush' ? 'entranceFlush' : o.style === 'glazed' || o.style === 'glass' ? 'entranceGlazed' : 'entrance')
        parts.metal.addBox(x0 + 0.05, y0, fr.zLeft, x1 - 0.05, y0 + 0.014, fr.zRight)
        break
      case 'slidingDoor': {
        const slide = o.slide ?? 'surface'
        if (slide === 'pocket') {
          doorFrame(parts, fr, x0, x1, y0, y1, 0.02, true)
          pocketLeaf(parts, fr, o, x0 + 0.02, x1 - 0.02, y0, y1 - 0.02, look === 'glass')
        } else if (slide === 'barn') {
          doorFrame(parts, fr, x0, x1, y0, y1, 0.02, false)
          barnLeaf(parts, fr, o, x0, x1, y0, y1, look === 'glass')
        } else if (slide === 'folding') {
          doorFrame(parts, fr, x0, x1, y0, y1, 0.032, true)
          foldingLeaf(parts, fr, o, x0 + 0.032, x1 - 0.032, y0, y1 - 0.032, look === 'glass')
        } else {
          doorFrame(parts, fr, x0, x1, y0, y1, 0.02, false)
          slidingLeaf(parts, fr, o, x0, x1, y0, y1, look === 'glass')
        }
        break
      }
      case 'window':
        windowUnit(parts, fr, input, x0, x1, y0, y1, autoSashes(o, W), false, true)
        break
      case 'frenchWindow':
        windowUnit(parts, fr, input, x0, x1, y0, y1, o.sashes ?? 2, true, false)
        break
      case 'balconyDoor':
        windowUnit(parts, fr, input, x0, x1, y0, y1, 1, true, false)
        break
      case 'balconyBlock': {
        const bp = balconyParts(o)
        windowUnit(parts, fr, input, bp.door.x0 * MM, bp.door.x1 * MM, bp.door.v0 * MM, Math.min(fr.wallH, bp.door.v1 * MM), 1, true, false)
        const ww = (bp.window.x1 - bp.window.x0) * MM
        windowUnit(
          parts,
          fr,
          input,
          bp.window.x0 * MM,
          bp.window.x1 * MM,
          bp.window.v0 * MM,
          Math.min(fr.wallH, bp.window.v1 * MM),
          o.sashes ?? (ww <= 0.9 ? 1 : ww <= 1.7 ? 2 : 3),
          false,
          true,
        )
        break
      }
      default:
        // 'arch' and 'opening' are plain plastered holes: reveals come from the wall builder
        break
    }
  }

  const add = (gb: GeoBuilder, material: THREE.Material, part: string, shadow = true, slot = part): void => {
    const mesh = gb.mesh(material, ref, { part, slot })
    if (!mesh) return
    mesh.castShadow = shadow
    group.add(mesh)
  }
  add(parts.frame, lib.get(frameId), 'frame')
  add(parts.leaf, lib.get(leafId), 'leaf', !glassLeaf)
  add(parts.glass, lib.get(DEFAULT_MATERIALS.glass), 'glass', false)
  add(parts.glassLeaf, lib.get(o.leafMaterialId ?? DEFAULT_MATERIALS.glass), 'glassLeaf', false, 'leaf')
  add(parts.metal, lib.plain({ color: '#b4b7bb', roughness: 0.32, metalness: 1 }), 'hardware')

  // ── curtains ──
  const cur = o.curtain
  if (cur && cur.kind !== 'none') {
    try {
      const top = cur.fullHeight ? Math.max(y1 + 0.1, input.ceilingMm * MM - 0.04) : Math.min(fr.wallH, y1 + 0.14)
      const bottom = cur.fullHeight || y0 < 0.15 ? 0.015 : Math.max(0.015, y0 - 0.12)
      const obj = factory.buildCurtain(cur, { width: W + 2 * Math.max(0, cur.overhang) * MM, top, bottom }, lib)
      const s = sgn(cur.side)
      const holder = new THREE.Group()
      holder.name = 'curtain'
      holder.position.set(0, 0, (cur.side === 'left' ? fr.zLeft : fr.zRight) + s * 0.1)
      // the factory builds the curtain facing +Z; turn it so that it faces into the room
      holder.rotation.y = s < 0 ? Math.PI : 0
      holder.add(obj)
      stampRef(holder, ref)
      holder.userData.part = 'curtain'
      holder.userData.slot = 'curtain'
      group.add(holder)
    } catch (err) {
      console.warn('[doplan] curtain build failed', err)
    }
  }
  return group
}

function autoSashes(o: Opening, w: number): number {
  const n = o.sashes ?? (w <= 0.9 ? 1 : w <= 1.7 ? 2 : 3)
  return Math.max(1, Math.min(6, Math.round(n)))
}

// ───────────────────────────── doors ─────────────────────────────

/** lining through the wall thickness + optional architraves on both faces */
function doorFrame(p: Parts, fr: Frame, x0: number, x1: number, y0: number, y1: number, ft: number, casing: boolean): void {
  const za = fr.zLeft - 0.004
  const zb = fr.zRight + 0.004
  p.frame.addBox(x0, y0, za, x0 + ft, y1, zb)
  p.frame.addBox(x1 - ft, y0, za, x1, y1, zb)
  p.frame.addBox(x0 + ft, y1 - ft, za, x1 - ft, y1, zb)
  if (!casing) return
  const cw = 0.07
  const ct = 0.012
  const lap = 0.012
  const top = Math.min(fr.wallH, y1 + cw - lap)
  for (const s of [-1, 1]) {
    const z = s < 0 ? fr.zLeft : fr.zRight
    const zo = z + s * ct
    p.frame.addBox(x0 - cw + lap, y0, z, x0 + lap, top, zo)
    p.frame.addBox(x1 - lap, y0, z, x1 + cw - lap, top, zo)
    if (top - (y1 - lap) > 0.01) p.frame.addBox(x0 + lap, y1 - lap, z, x1 - lap, top, zo)
  }
}

function hingedLeaf(
  p: Parts,
  fr: Frame,
  o: Opening,
  xa: number,
  xb: number,
  y0: number,
  y1: number,
  hinge: 'a' | 'b',
  th: number,
  angle: number,
  style: LeafLook,
): void {
  const width = xb - xa - 0.004
  const yb = y0 + 0.006
  const yt = y1 - 0.003
  if (width < 0.1 || yt - yb < 0.2) return
  const dirSign = hinge === 'a' ? 1 : -1
  const sw = sgn(o.swing)
  const zFace = (o.swing === 'left' ? fr.zLeft : fr.zRight) - sw * 0.012
  const xHinge = hinge === 'a' ? xa + 0.002 : xb - 0.002
  const m = new THREE.Matrix4()
    .makeRotationY(-sw * dirSign * angle)
    .setPosition(xHinge, 0, zFace)
  // leaf-local helper: u runs from the hinge (0) to the free edge (width), z from the swing-side face inwards
  const box = (gb: GeoBuilder, u0: number, u1: number, ya: number, yb2: number, d0: number, d1: number): void => {
    gb.addBox(dirSign * u0, ya, -sw * d0, dirSign * u1, yb2, -sw * d1, m)
  }
  const entrance = style === 'entrance' || style === 'entranceFlush' || style === 'entranceGlazed'
  if (style === 'glass') {
    box(p.glassLeaf, 0, width, yb, yt, 0.012, 0.022)
  } else if (style === 'glazed' || style === 'insert') {
    leafFace(p, box, style, width, yb, yt, th)
  } else {
    const h = yt - yb
    const mx = Math.min(0.13, width * 0.18)
    // glazed entrance door: a narrow vertical lite near the free edge, cut through the leaf
    const g0 = width * 0.6
    const g1 = width - 0.15
    const ga = yb + 0.37
    const gt = yt - 0.27
    if (style === 'entranceGlazed' && g1 - g0 > 0.06 && h > 1.2) {
      box(p.leaf, 0, g0, yb, yt, 0, th)
      box(p.leaf, g1, width, yb, yt, 0, th)
      box(p.leaf, g0, g1, yb, ga, 0, th)
      box(p.leaf, g0, g1, gt, yt, 0, th)
      // steel beads round the cut-out on both faces, the glass unit in the middle of the leaf
      const b = 0.02
      for (const [d0, d1] of [
        [-0.006, 0.004],
        [th - 0.004, th + 0.006],
      ]) {
        box(p.metal, g0 - b, g1 + b, ga - b, ga + 0.004, d0, d1)
        box(p.metal, g0 - b, g1 + b, gt - 0.004, gt + b, d0, d1)
        box(p.metal, g0 - b, g0 + 0.004, ga, gt, d0, d1)
        box(p.metal, g1 - 0.004, g1 + b, ga, gt, d0, d1)
      }
      box(p.glass, g0, g1, ga, gt, th / 2 - 0.012, th / 2 + 0.012)
    } else {
      box(p.leaf, 0, width, yb, yt, 0, th)
    }
    if (style === 'panel' && width > 0.4 && h > 1.2) {
      const split = yb + h * 0.42
      for (const [d0, d1] of [
        [-0.005, 0],
        [th, th + 0.005],
      ]) {
        box(p.leaf, mx, width - mx, yb + 0.16, split - 0.05, d0, d1)
        box(p.leaf, mx, width - mx, split + 0.05, yt - 0.13, d0, d1)
      }
    } else if (style === 'entrance') {
      for (const [d0, d1] of [
        [-0.004, 0],
        [th, th + 0.004],
      ]) {
        box(p.leaf, mx, width - mx, yb + 0.14, yt - 0.14, d0, d1)
      }
      // peephole
      box(p.metal, width / 2 - 0.012, width / 2 + 0.012, yb + 1.5, yb + 1.524, -0.008, th + 0.008)
    }
  }
  // lever handles on both faces
  const d0 = style === 'glass' ? 0.012 : 0
  const d1 = style === 'glass' ? 0.022 : th
  const hy = Math.min(yb + 1.0, (yb + yt) / 2)
  const hu = width - 0.065
  for (const [face, out] of [
    [d0, -1],
    [d1, 1],
  ]) {
    const a = face
    const b = face + out * 0.008
    box(p.metal, hu - 0.026, hu + 0.026, hy - 0.026, hy + 0.026, a, b)
    box(p.metal, hu - 0.009, hu + 0.009, hy - 0.009, hy + 0.009, b, face + out * 0.05)
    box(p.metal, hu - 0.12, hu + 0.009, hy - 0.009, hy + 0.009, face + out * 0.036, face + out * 0.054)
    if (entrance) box(p.metal, hu - 0.02, hu + 0.02, hy - 0.16, hy - 0.08, a, face + out * 0.006)
  }
}

function slidingLeaf(p: Parts, fr: Frame, o: Opening, x0: number, x1: number, y0: number, y1: number, glass: boolean): void {
  const sw = sgn(o.swing)
  const w = x1 - x0
  const zFace = o.swing === 'left' ? fr.zLeft : fr.zRight
  const za = zFace + sw * 0.014
  const zb = zFace + sw * (glass ? 0.024 : 0.054)
  const open = o.hinge === 'a' ? -1 : 1
  const shift = open * w * 0.14
  ;(glass ? p.glassLeaf : p.leaf).addBox(x0 - 0.03 + shift, y0 + 0.008, Math.min(za, zb), x1 + 0.03 + shift, y1 + 0.035, Math.max(za, zb))
  // top rail covers the closed and the fully open position
  const rx0 = open < 0 ? x0 - w - 0.05 : x0 - 0.05
  const rx1 = open < 0 ? x1 + 0.05 : x1 + w + 0.05
  const ry = Math.min(fr.wallH - 0.05, y1 + 0.035)
  p.metal.addBox(rx0, ry, zFace + sw * 0.004, rx1, ry + 0.05, zFace + sw * 0.064)
  // flush pull near the free edge, both faces
  const hx = open < 0 ? x1 + shift - 0.06 : x0 + shift + 0.06
  const hy = Math.min(y0 + 1.0, (y0 + y1) / 2)
  p.metal.addBox(hx - 0.012, hy - 0.09, Math.min(za, zb) - 0.004, hx + 0.012, hy + 0.09, Math.max(za, zb) + 0.004)
}

type LeafLook = DoorLeafStyle | 'entrance' | 'entranceFlush' | 'entranceGlazed'
type LeafBox = (gb: GeoBuilder, u0: number, u1: number, ya: number, yb2: number, d0: number, d1: number) => void

/**
 * Rail-and-stile leaf. "glazed": a glass lite over a solid lower panel; "insert" (царговая): the
 * field is split by cross rails into recessed panels.
 */
function leafFace(p: Parts, box: LeafBox, style: 'glazed' | 'insert', width: number, yb: number, yt: number, th: number): void {
  const st = Math.min(0.11, width * 0.16)
  const h = yt - yb
  const bottom = Math.min(0.2, h * 0.1)
  const top = Math.min(0.12, h * 0.07)
  box(p.leaf, 0, st, yb, yt, 0, th)
  box(p.leaf, width - st, width, yb, yt, 0, th)
  box(p.leaf, st, width - st, yb, yb + bottom, 0, th)
  box(p.leaf, st, width - st, yt - top, yt, 0, th)
  const f0 = yb + bottom
  const f1 = yt - top
  const mid = th / 2
  if (style === 'glazed') {
    const split = yb + h * 0.38
    box(p.leaf, st, width - st, f0, split, 0, th)
    // glazing beads on both faces, the lite in the middle of the leaf
    for (const [d0, d1] of [
      [-0.006, 0.004],
      [th - 0.004, th + 0.006],
    ]) {
      box(p.leaf, st, width - st, split, split + 0.018, d0, d1)
      box(p.leaf, st, width - st, f1 - 0.018, f1, d0, d1)
      box(p.leaf, st, st + 0.018, split, f1, d0, d1)
      box(p.leaf, width - st - 0.018, width - st, split, f1, d0, d1)
    }
    box(p.glass, st, width - st, split, f1, mid - 0.003, mid + 0.003)
    return
  }
  const rails = 3
  const railH = 0.05
  const step = (f1 - f0 - rails * railH) / (rails + 1)
  let y = f0
  for (let i = 0; i <= rails; i++) {
    box(p.leaf, st, width - st, y, y + step, mid - 0.008, mid + 0.008)
    y += step
    if (i < rails) {
      box(p.leaf, st, width - st, y, y + railH, 0, th)
      y += railH
    }
  }
}

/** pocket door: the leaf runs inside the wall; drawn partly slid into the pocket */
function pocketLeaf(p: Parts, fr: Frame, o: Opening, x0: number, x1: number, y0: number, y1: number, glass: boolean): void {
  const w = x1 - x0
  const zc = (fr.zLeft + fr.zRight) / 2
  const t = glass ? 0.01 : Math.min(0.04, Math.max(0.02, (fr.zRight - fr.zLeft) * 0.4))
  const open = o.hinge === 'a' ? -1 : 1
  const shift = open * w * 0.3
  ;(glass ? p.glassLeaf : p.leaf).addBox(x0 + shift, y0 + 0.008, zc - t / 2, x1 + shift, y1 - 0.004, zc + t / 2)
  // recessed pull on the visible edge, both faces
  const hx = open < 0 ? x1 + shift - 0.05 : x0 + shift + 0.05
  const hy = Math.min(y0 + 1.0, (y0 + y1) / 2)
  p.metal.addBox(hx - 0.015, hy - 0.08, zc - t / 2 - 0.002, hx + 0.015, hy + 0.08, zc + t / 2 + 0.002)
}

/** barn door: wide leaf on the wall face, exposed rail on stand-offs with two rollers */
function barnLeaf(p: Parts, fr: Frame, o: Opening, x0: number, x1: number, y0: number, y1: number, glass: boolean): void {
  const sw = sgn(o.swing)
  const zFace = o.swing === 'left' ? fr.zLeft : fr.zRight
  const z = (d: number): number => zFace + sw * d
  const span = (d0: number, d1: number): [number, number] => [Math.min(z(d0), z(d1)), Math.max(z(d0), z(d1))]
  const w = x1 - x0 + 0.1
  const open = o.hinge === 'a' ? -1 : 1
  const shift = open * w * 0.3
  const lx0 = x0 - 0.05 + shift
  const lx1 = x1 + 0.05 + shift
  const ly0 = y0 + 0.01
  const ly1 = Math.min(fr.wallH - 0.14, y1 + 0.05)
  const [za, zb] = span(0.02, 0.055)
  ;(glass ? p.glassLeaf : p.leaf).addBox(lx0, ly0, za, lx1, ly1, zb)
  if (!glass) {
    // Z-brace: two ledges and a diagonal, proud of the room-side face
    const [zl, zh] = span(0.055, 0.067)
    const lh = Math.min(0.14, (ly1 - ly0) * 0.08)
    p.leaf.addBox(lx0 + 0.02, ly0 + 0.12, zl, lx1 - 0.02, ly0 + 0.12 + lh, zh)
    p.leaf.addBox(lx0 + 0.02, ly1 - 0.12 - lh, zl, lx1 - 0.02, ly1 - 0.12, zh)
    // the turned brace keeps 20 mm inside the leaf edges (its ends stick out by up to lh·sin)
    const dx = lx1 - lx0 - 0.04 - lh
    const dy = ly1 - ly0 - 0.24 - 2 * lh
    const len = Math.hypot(dx, dy)
    const m = new THREE.Matrix4().makeRotationZ(Math.atan2(dy, dx)).setPosition((lx0 + lx1) / 2, (ly0 + ly1) / 2, 0)
    p.leaf.addBox(-len / 2, -lh / 2, zl, len / 2, lh / 2, zh, m)
  } else {
    const [zl, zh] = span(0.017, 0.058)
    p.metal.addBox(lx0, ly0, zl, lx0 + 0.03, ly1, zh)
    p.metal.addBox(lx1 - 0.03, ly0, zl, lx1, ly1, zh)
    p.metal.addBox(lx0, ly0, zl, lx1, ly0 + 0.03, zh)
    p.metal.addBox(lx0, ly1 - 0.03, zl, lx1, ly1, zh)
  }
  // rail covering the closed and the open position
  const ry = Math.min(fr.wallH - 0.03, ly1 + 0.08)
  const rx0 = open < 0 ? x0 - w - 0.1 : x0 - 0.1
  const rx1 = open < 0 ? x1 + 0.1 : x1 + w + 0.1
  const [zr0, zr1] = span(0.03, 0.042)
  p.metal.addBox(rx0, ry - 0.02, zr0, rx1, ry + 0.02, zr1)
  const [zs0, zs1] = span(0, 0.03)
  for (const x of [rx0 + 0.05, rx1 - 0.05]) p.metal.addBox(x - 0.012, ry - 0.012, zs0, x + 0.012, ry + 0.012, zs1)
  // rollers (octagons from two turned squares) with straps down to the leaf
  for (const cx of [lx0 + 0.14, lx1 - 0.14]) {
    for (const rot of [0, Math.PI / 4]) {
      const m = new THREE.Matrix4().makeRotationZ(rot).setPosition(cx, ry + 0.035, 0)
      p.metal.addBox(-0.035, -0.035, za, 0.035, 0.035, zb, m)
    }
    p.metal.addBox(cx - 0.018, ly1 - 0.12, za - 0.004, cx + 0.018, ry + 0.035, zb + 0.004)
  }
  // bar pull on the room-side face near the free edge
  const hx = open < 0 ? lx1 - 0.08 : lx0 + 0.08
  const [zp0, zp1] = span(0.055, 0.1)
  p.metal.addBox(hx - 0.012, y0 + 0.8, zp0, hx + 0.012, y0 + 1.25, zp1)
}

/** folding (accordion) door: narrow panels in a zigzag, drawn half-folded towards the hinge side */
function foldingLeaf(p: Parts, fr: Frame, o: Opening, x0: number, x1: number, y0: number, y1: number, glass: boolean): void {
  const W = x1 - x0
  const n = W <= 0.7 ? 4 : W <= 1.0 ? 6 : 8
  const pw = W / n
  const a = 0.5
  const zc = (fr.zLeft + fr.zRight) / 2
  const t = 0.018
  const dir = o.hinge === 'a' ? 1 : -1
  // track across the head of the opening
  p.metal.addBox(x0, y1 - 0.03, zc - 0.025, x1, y1, zc + 0.025)
  let x = dir > 0 ? x0 : x1
  // plan k = -local z: the plan symbol starts at k < 0, i.e. on the +z side, and zigzags towards -z
  let zz = zc + (pw * Math.sin(a)) / 2
  const gb = glass ? p.glassLeaf : p.leaf
  for (let i = 0; i < n; i++) {
    const up = i % 2 === 0 ? 1 : -1
    // panel from (x, zz) to (x + dir·pw·cos a, zz - up·pw·sin a)
    const m = new THREE.Matrix4().makeRotationY(dir * up * a).setPosition(x, 0, zz)
    gb.addBox(dir > 0 ? 0 : -pw, y0 + 0.01, -t / 2, dir > 0 ? pw : 0, y1 - 0.035, t / 2, m)
    if (i > 0) p.metal.addBox(x - 0.007, y0 + 0.2, zz - 0.007, x + 0.007, y1 - 0.25, zz + 0.007)
    x += dir * pw * Math.cos(a)
    zz -= up * pw * Math.sin(a)
  }
  const hy = Math.min(y0 + 1.0, (y0 + y1) / 2)
  p.metal.addBox(x - dir * 0.04 - 0.01, hy - 0.01, zz - 0.04, x - dir * 0.04 + 0.01, hy + 0.01, zz + 0.04)
}

// ───────────────────────────── windows ─────────────────────────────

function sash(
  p: Parts,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  zc: number,
  handleSide: -1 | 0 | 1,
  handleY: number,
  interior: number,
): void {
  const sf = 0.055
  const sd = 0.058
  if (x1 - x0 < sf * 2.2 || y1 - y0 < sf * 2.2) {
    p.frame.addBox(x0, y0, zc - sd / 2, x1, y1, zc + sd / 2)
    return
  }
  const za = zc - sd / 2
  const zb = zc + sd / 2
  p.frame.addBox(x0, y0, za, x1, y0 + sf, zb)
  p.frame.addBox(x0, y1 - sf, za, x1, y1, zb)
  p.frame.addBox(x0, y0 + sf, za, x0 + sf, y1 - sf, zb)
  p.frame.addBox(x1 - sf, y0 + sf, za, x1, y1 - sf, zb)
  // double glazing: two panes with an air gap
  const gi = sf * 0.75
  p.glass.addBox(x0 + gi, y0 + gi, zc + 0.008, x1 - gi, y1 - gi, zc + 0.012)
  p.glass.addBox(x0 + gi, y0 + gi, zc - 0.012, x1 - gi, y1 - gi, zc - 0.008)
  if (handleSide !== 0) {
    const hx = handleSide > 0 ? x1 - sf / 2 : x0 + sf / 2
    const hy = Math.max(y0 + 0.2, Math.min(y1 - 0.2, handleY))
    const zf = zc + (interior * sd) / 2
    p.metal.addBox(hx - 0.014, hy - 0.035, zf, hx + 0.014, hy + 0.035, zf + interior * 0.01)
    p.metal.addBox(hx - 0.008, hy - 0.008, zf, hx + 0.008, hy + 0.008, zf + interior * 0.04)
    p.metal.addBox(hx - 0.009, hy - 0.115, zf + interior * 0.028, hx + 0.009, hy + 0.009, zf + interior * 0.042)
  }
}

function windowUnit(
  p: Parts,
  fr: Frame,
  input: OpeningInput,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  sashes: number,
  doorLike: boolean,
  withSill: boolean,
): void {
  const o = input.opening
  if (x1 - x0 < 0.15 || y1 - y0 < 0.15) return
  const interior = sgn(input.interior)
  const T = fr.zRight - fr.zLeft
  const fw = 0.06
  const fd = Math.min(0.07, Math.max(0.04, T))
  // the frame sits towards the exterior face of the wall
  const zExteriorFace = interior > 0 ? fr.zLeft : fr.zRight
  const inset = Math.min(0.05, T * 0.25)
  let zc = zExteriorFace + interior * (inset + fd / 2)
  if (T < fd + 0.02) zc = (fr.zLeft + fr.zRight) / 2
  const za = zc - fd / 2
  const zb = zc + fd / 2
  p.frame.addBox(x0, y0, za, x1, y0 + fw, zb)
  p.frame.addBox(x0, y1 - fw, za, x1, y1, zb)
  p.frame.addBox(x0, y0 + fw, za, x0 + fw, y1 - fw, zb)
  p.frame.addBox(x1 - fw, y0 + fw, za, x1, y1 - fw, zb)

  const n = Math.max(1, Math.min(6, Math.round(sashes)))
  const imp = 0.05
  const ix0 = x0 + fw
  const ix1 = x1 - fw
  const iy0 = y0 + fw
  const iy1 = y1 - fw
  const sw = (ix1 - ix0 - (n - 1) * imp) / n
  const handleY = doorLike ? 1.05 : (iy0 + iy1) / 2
  for (let i = 0; i < n; i++) {
    const sx0 = ix0 + i * (sw + imp)
    const sx1 = sx0 + sw
    if (i > 0) p.frame.addBox(sx0 - imp, iy0, za, sx0, iy1, zb)
    let handle: -1 | 0 | 1 = 0
    if (n === 1) handle = o.hinge === 'a' ? 1 : -1
    else if (i === n - 1) handle = -1
    else if (i === 0 && (n >= 3 || doorLike)) handle = 1
    sash(p, sx0 + 0.004, sx1 - 0.004, iy0 + 0.004, iy1 - 0.004, zc + interior * 0.008, handle, handleY, interior)
  }

  if (withSill && y0 > 0.3) {
    const zInteriorFace = interior > 0 ? fr.zRight : fr.zLeft
    const revealDepth = Math.abs(zInteriorFace - (zc + (interior * fd) / 2))
    const wanted = o.sillBoard === undefined ? revealDepth + 0.05 : o.sillBoard * MM
    if (wanted > 0.001) {
      const depth = Math.max(wanted, revealDepth + 0.025)
      const zs = zc + (interior * fd) / 2
      p.frame.addBox(x0 - 0.05, y0 - 0.012, zs, x1 + 0.05, y0 + 0.022, zs + interior * depth)
    }
    // exterior drip sill
    const ze = zc - (interior * fd) / 2
    const out = Math.abs(zExteriorFace - ze) + 0.03
    p.metal.addBox(x0, y0 - 0.008, ze, x1, y0 + 0.004, ze - interior * out)
  }
}
