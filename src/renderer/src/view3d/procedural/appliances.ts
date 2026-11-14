/** Appliances: fridge, stove/hob, oven, hood, dishwasher, washing machine, tv, air conditioner, radiator. */
import * as THREE from 'three'
import {
  type Ctx,
  F,
  addHandle,
  box,
  cached,
  clamp,
  cyl,
  cylX,
  cylZ,
  extrudeSide,
  gkey,
  lathe,
  mat4,
  merge,
  rbox,
  torus,
} from './common'

// ───────────────────────────── shared parts ─────────────────────────────

/** control knob pointing +Z, back face at z */
export function addKnob(c: Ctx, x: number, y: number, z: number, r = 0.018, parent?: THREE.Object3D): void {
  const g = cached(gkey('knob', r), () => {
    const body = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.0001, 0),
        new THREE.Vector2(r * 1.05, 0),
        new THREE.Vector2(r * 1.05, r * 0.25),
        new THREE.Vector2(r, r * 0.35),
        new THREE.Vector2(r * 0.95, r * 1.1),
        new THREE.Vector2(r * 0.85, r * 1.25),
        new THREE.Vector2(0.0001, r * 1.25),
      ],
      32,
    )
    const grip = new THREE.BoxGeometry(r * 0.35, r * 1.5, r * 0.5)
    return merge([
      { g: body, m: mat4([0, 0, 0], [Math.PI / 2, 0, 0]) },
      { g: grip, m: mat4([0, 0, r * 1.3]) },
    ])
  })
  c.add(g, 'knobs', F.steel, [x, y, z], undefined, parent)
}

/**
 * Oven front (control strip + glazed door + bar handle) filling [x0,x1]×[y0,y1]; back face at z.
 * Used by `oven`, `stove` and `kitchenTall` (layout 'oven').
 */
export function addOvenFront(c: Ctx, x0: number, x1: number, y0: number, y1: number, z: number, parent?: THREE.Object3D, withPanel = true): void {
  const w = x1 - x0
  const h = y1 - y0
  const cx = (x0 + x1) / 2
  const g = 0.003
  const panelH = withPanel ? clamp(h * 0.16, 0.05, 0.1) : 0
  if (withPanel) {
    const py = y1 - panelH / 2
    c.add(rbox(w - 2 * g, panelH - g, 0.02, 0.002), 'front', F.steel, [cx, py, z + 0.01], undefined, parent)
    // display
    c.add(rbox(Math.min(0.14, w * 0.25), panelH * 0.42, 0.004, 0.0015), 'screen', F.screen, [cx, py, z + 0.021], undefined, parent)
    const kx = Math.min(w * 0.36, w / 2 - 0.05)
    addKnob(c, cx - kx, py, z + 0.02, Math.min(0.019, panelH * 0.3), parent)
    addKnob(c, cx + kx, py, z + 0.02, Math.min(0.019, panelH * 0.3), parent)
  }
  const dh = h - panelH - 2 * g
  const dy = y0 + g + dh / 2
  // door: steel frame with a large dark glass pane
  c.add(rbox(w - 2 * g, dh, 0.022, 0.003), 'front', F.steel, [cx, dy, z + 0.011], undefined, parent)
  c.add(rbox(w - 2 * g - 0.006, dh * 0.86, 0.006, 0.002), 'glass', F.blackGlass, [cx, dy + dh * 0.04, z + 0.024], undefined, parent)
  addHandle(c, 'bar', cx, y0 + g + dh - Math.min(0.045, dh * 0.12), z + 0.028, w * 0.78, false, parent)
}

/**
 * Microwave front filling [x0,x1]x[y0,y1] with its back face at z: side-hinged glazed door on the
 * left, control column (display, buttons, dial) on the right.
 */
export function addMicrowaveFront(c: Ctx, x0: number, x1: number, y0: number, y1: number, z: number, parent?: THREE.Object3D): void {
  const w = x1 - x0
  const h = y1 - y0
  const cy = (y0 + y1) / 2
  const g = 0.003
  const ctrlW = clamp(w * 0.24, 0.07, 0.14)
  const doorW = w - ctrlW - 3 * g
  const dx = x0 + g + doorW / 2
  // bezel behind everything
  c.add(rbox(w - 2 * g, h - 2 * g, 0.012, 0.002), 'front', F.steel, [(x0 + x1) / 2, cy, z + 0.006], undefined, parent)
  // door with a large dark window
  c.add(rbox(doorW, h - 2 * g, 0.02, 0.003), 'front', F.steel, [dx, cy, z + 0.022], undefined, parent)
  c.add(rbox(doorW - 0.03, (h - 2 * g) * 0.74, 0.004, 0.002), 'glass', F.blackGlass, [dx - 0.004, cy, z + 0.0335], undefined, parent)
  addHandle(c, 'bar', x0 + g + doorW - 0.02, cy, z + 0.032, Math.min(0.6 * h, 0.22), true, parent)
  // control column
  const kx = x1 - g - ctrlW / 2
  c.add(rbox(ctrlW - 0.006, h - 2 * g - 0.006, 0.004, 0.0015), 'panel', F.blackMatte, [kx, cy, z + 0.0145], undefined, parent)
  const disp = c.add(rbox(ctrlW * 0.6, Math.min(0.022, h * 0.08), 0.002, 0.001), 'screen', F.screen, [kx, y1 - g - h * 0.16, z + 0.0175], undefined, parent)
  disp.userData.emissiveReady = true
  const btn = Math.min(0.012, ctrlW * 0.14)
  for (let r = 0; r < 2; r++) {
    for (let col = 0; col < 2; col++) {
      c.add(rbox(btn * 1.6, btn, 0.002, 0.0008), 'knobs', F.steel, [kx + (col - 0.5) * btn * 2.4, y1 - g - h * 0.3 - r * btn * 1.8, z + 0.0175], undefined, parent)
    }
  }
  addKnob(c, kx, y0 + g + h * 0.28, z + 0.0165, Math.min(0.016, ctrlW * 0.2), parent)
}

/** hob (cooktop) with its top surface at y; centred at (cx, cz) */
export function addHob(c: Ctx, type: 'gas' | 'induction' | 'electric', cx: number, y: number, cz: number, w: number, d: number, withKnobs: boolean, parent?: THREE.Object3D): void {
  const zones: { x: number; z: number; r: number }[] = []
  const two = w < 0.5
  if (two) {
    zones.push({ x: cx, z: cz - d * 0.22, r: Math.min(0.075, w * 0.3) })
    zones.push({ x: cx, z: cz + d * 0.22, r: Math.min(0.095, w * 0.36) })
  } else {
    const ox = w * 0.24
    const oz = d * 0.22
    zones.push({ x: cx - ox, z: cz - oz, r: Math.min(0.08, w * 0.14) })
    zones.push({ x: cx + ox, z: cz - oz, r: Math.min(0.07, w * 0.12) })
    zones.push({ x: cx - ox, z: cz + oz, r: Math.min(0.07, w * 0.12) })
    zones.push({ x: cx + ox, z: cz + oz, r: Math.min(0.1, w * 0.16) })
  }
  if (type === 'gas') {
    const plateT = 0.008
    c.add(rbox(w, plateT, d, 0.003), 'metal', F.steel, [cx, y - plateT / 2, cz], undefined, parent)
    for (const zn of zones) {
      const br = zn.r * 0.55
      const burner = lathe(
        [
          [0.0001, 0],
          [br * 1.25, 0],
          [br * 1.2, 0.006],
          [br, 0.012],
          [br * 0.95, 0.02],
          [br * 0.85, 0.024],
          [0.0001, 0.026],
        ],
        32,
      )
      c.add(burner, 'burners', F.blackMetal, [zn.x, y - 0.0005, zn.z], undefined, parent)
      // grate: ring + 4 fingers
      const gr = cached(gkey('grate', zn.r), () => {
        const ring = new THREE.TorusGeometry(zn.r * 1.05, 0.004, 8, 40)
        ring.rotateX(Math.PI / 2)
        const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = [{ g: ring, m: mat4([0, 0.03, 0]) }]
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4
          const finger = new THREE.BoxGeometry(zn.r * 0.75, 0.007, 0.007)
          parts.push({ g: finger, m: mat4([Math.cos(a) * zn.r * 0.72, 0.03, Math.sin(a) * zn.r * 0.72], [0, -a, 0]) })
          const foot = new THREE.CylinderGeometry(0.004, 0.005, 0.03, 8)
          parts.push({ g: foot, m: mat4([Math.cos(a) * zn.r * 1.05, 0.015, Math.sin(a) * zn.r * 1.05]) })
        }
        return merge(parts)
      })
      c.add(gr, 'grates', F.blackMetal, [zn.x, y, zn.z], undefined, parent)
    }
  } else {
    const t = 0.006
    c.add(rbox(w, t, d, 0.003), 'glass', F.blackGlass, [cx, y - t / 2, cz], undefined, parent)
    for (const zn of zones) {
      const ring = torus(zn.r, 0.0007, 6, 64)
      c.add(ring, 'print', F.grey, [zn.x, y - 0.0006, zn.z], [Math.PI / 2, 0, 0], parent)
      if (type === 'electric') {
        const inner = torus(zn.r * 0.6, 0.0006, 6, 48)
        c.add(inner, 'print', F.grey, [zn.x, y - 0.0006, zn.z], [Math.PI / 2, 0, 0], parent)
      }
    }
    // touch control strip
    c.add(box(Math.min(0.24, w * 0.4), 0.0006, 0.022), 'print', F.grey, [cx, y - 0.0003, cz + d / 2 - 0.03], undefined, parent)
  }
  if (withKnobs && type === 'gas') {
    const n = zones.length
    for (let i = 0; i < n; i++) {
      const kx = cx - w * 0.38 + (i * (w * 0.76)) / Math.max(1, n - 1)
      addKnob(c, kx, y + 0.0, cz + d / 2 - 0.035, 0.016, parent)
    }
  }
}

// ───────────────────────────── generators ─────────────────────────────

export function fridge(c: Ctx): void {
  const { W, H, D } = c
  const layout = c.str('layout', 'bottomFreezer', ['bottomFreezer', 'topFreezer', 'sideBySide', 'single'] as const)
  const hinge = c.str('hinge', 'right', ['left', 'right'] as const)
  const doorT = Math.min(0.06, D * 0.1)
  const gap = 0.004
  const baseH = Math.min(0.05, H * 0.04)
  const bodyD = D - doorT - 0.002
  c.add(rbox(W, H, bodyD, 0.008), 'body', F.steel, [0, H / 2, -D / 2 + bodyD / 2])
  const zDoor = -D / 2 + bodyD + 0.002
  // ventilation grille at the bottom
  c.add(rbox(W - 0.02, baseH - gap, doorT * 0.5, 0.002), 'grille', F.blackMatte, [0, baseH / 2, zDoor + doorT * 0.25])
  const y0 = baseH
  const y1 = H
  const avail = y1 - y0
  const door = (x0: number, x1: number, ya: number, yb: number, handleSide: 'left' | 'right', handleAt: 'top' | 'bottom' | 'middle') => {
    const w = x1 - x0 - gap
    const h = yb - ya - gap
    const cx = (x0 + x1) / 2
    const cy = (ya + yb) / 2
    c.add(rbox(w, h, doorT, 0.012), 'front', F.steel, [cx, cy, zDoor + doorT / 2])
    const hx = handleSide === 'left' ? cx - w / 2 + 0.035 : cx + w / 2 - 0.035
    const len = Math.min(h * 0.55, 0.45)
    const hy = handleAt === 'top' ? yb - gap - len / 2 - 0.04 : handleAt === 'bottom' ? ya + gap + len / 2 + 0.04 : cy
    addHandle(c, 'bar', hx, hy, zDoor + doorT, len, true)
  }
  const hs = hinge === 'right' ? 'left' : 'right'
  if (layout === 'sideBySide') {
    door(-W / 2, 0, y0, y1, 'right', 'middle')
    door(0, W / 2, y0, y1, 'left', 'middle')
  } else if (layout === 'single') {
    door(-W / 2, W / 2, y0, y1, hs, 'middle')
  } else if (layout === 'topFreezer') {
    const split = y1 - avail * 0.28
    door(-W / 2, W / 2, split, y1, hs, 'bottom')
    door(-W / 2, W / 2, y0, split, hs, 'top')
  } else {
    const split = y0 + avail * 0.36
    door(-W / 2, W / 2, split, y1, hs, 'bottom')
    door(-W / 2, W / 2, y0, split, hs, 'top')
  }
}

export function stove(c: Ctx): void {
  const { W, H, D } = c
  const type = c.str('type', 'induction', ['gas', 'induction', 'electric'] as const)
  if (H < 0.2) {
    // built-in hob only
    addHob(c, type, 0, H, 0, W, D, false)
    if (H > 0.012) c.add(rbox(W * 0.92, H - 0.008, D * 0.9, 0.002), 'body', F.blackMatte, [0, (H - 0.008) / 2, 0])
    return
  }
  const topT = type === 'gas' ? 0.04 : 0.008
  const bodyH = H - topT
  const frontT = 0.03
  const bodyD = D - frontT
  c.add(rbox(W, bodyH, bodyD, 0.004), 'body', F.steel, [0, bodyH / 2, -D / 2 + bodyD / 2])
  const zf = -D / 2 + bodyD
  // storage drawer + oven front
  const drawerH = Math.min(0.13, bodyH * 0.15)
  c.add(rbox(W - 0.006, drawerH - 0.006, 0.02, 0.003), 'front', F.steel, [0, drawerH / 2 + 0.01, zf + 0.01])
  addHandle(c, 'bar', 0, drawerH * 0.62, zf + 0.02, W * 0.5, false)
  addOvenFront(c, -W / 2, W / 2, drawerH + 0.012, bodyH, zf)
  // hob on top
  if (type === 'gas') {
    c.add(rbox(W, 0.008, D, 0.003), 'metal', F.steel, [0, bodyH + 0.004, 0])
    addHob(c, 'gas', 0, bodyH + 0.008, -0.01, W - 0.02, D - 0.06, false)
  } else {
    addHob(c, type, 0, H, 0, W, D, false)
  }
}

export function oven(c: Ctx): void {
  const { W, H, D } = c
  const frontT = 0.03
  const bodyD = Math.max(0.05, D - frontT)
  c.add(rbox(W - 0.004, H - 0.004, bodyD, 0.003), 'body', F.blackMatte, [0, H / 2, -D / 2 + bodyD / 2])
  if (c.bool('microwave', false)) addMicrowaveFront(c, -W / 2, W / 2, 0, H, -D / 2 + bodyD)
  else addOvenFront(c, -W / 2, W / 2, 0, H, -D / 2 + bodyD, undefined, c.bool('panel', true))
}

export function hood(c: Ctx): void {
  const { W, H, D } = c
  const style = c.str('style', 'chimney', ['chimney', 'flat', 'inclined', 'island'] as const)
  if (style === 'flat') {
    c.add(rbox(W, H, D, 0.004), 'body', F.steel, [0, H / 2, 0])
    c.add(rbox(W - 0.01, H * 0.4, 0.006, 0.002), 'glass', F.blackGlass, [0, H * 0.25, D / 2 - 0.002])
    c.add(box(W * 0.8, 0.002, D * 0.6), 'filter', F.aluminium, [0, 0.0005, 0])
    addLights(c, W, D, 0.001)
    return
  }
  if (style === 'inclined') {
    // slanted black-glass front panel over a slim body
    const bodyD = Math.min(D * 0.5, 0.2)
    c.add(rbox(W * 0.98, H, bodyD, 0.004), 'body', F.blackMatte, [0, H / 2, -D / 2 + bodyD / 2])
    const panelLen = Math.hypot(D - bodyD, H * 0.85)
    const ang = Math.atan2(D - bodyD, H * 0.85)
    const g = c.group([0, H * 0.06 + (H * 0.85) / 2, -D / 2 + bodyD + (D - bodyD) / 2], [ang, 0, 0])
    c.add(rbox(W, panelLen * 0.98, 0.008, 0.003), 'glass', F.blackGlass, [0, 0, 0], undefined, g)
    c.add(box(W * 0.9, 0.006, Math.min(0.02, D * 0.1)), 'metal', F.steel, [0, 0.003, D / 2 - 0.01])
    return
  }
  const canopyH = Math.min(0.13, H * 0.3)
  const chimneyW = Math.min(0.3, W * 0.45)
  const chimneyD = Math.min(0.26, D * 0.55)
  const island = style === 'island'
  const czChim = island ? 0 : -D / 2 + chimneyD / 2
  const front = Math.min(0.05, canopyH * 0.5)
  const topBackZ = czChim + chimneyD / 2 + 0.02
  const prof = extrudeSide(gkey('hoodShape', W, D, canopyH, front, topBackZ, island), () => {
    const s = new THREE.Shape()
    if (island) {
      s.moveTo(-D / 2, 0)
      s.lineTo(D / 2, 0)
      s.lineTo(D / 2, front)
      s.lineTo(chimneyD / 2 + 0.02, canopyH)
      s.lineTo(-chimneyD / 2 - 0.02, canopyH)
      s.lineTo(-D / 2, front)
    } else {
      s.moveTo(-D / 2, 0)
      s.lineTo(D / 2, 0)
      s.lineTo(D / 2, front)
      s.lineTo(topBackZ, canopyH)
      s.lineTo(-D / 2, canopyH)
    }
    s.closePath()
    return s
  }, W, 0.003, 4)
  c.add(prof, 'body', F.steel, [0, 0, 0])
  c.add(box(W * 0.86, 0.002, D * 0.7), 'filter', F.aluminium, [0, -0.0005 + 0.002, 0])
  addLights(c, W, D, 0.0015)
  c.add(rbox(chimneyW, H - canopyH + 0.002, chimneyD, 0.002), 'body', F.steel, [0, canopyH + (H - canopyH) / 2 - 0.001, czChim])
  // control buttons on the front lip
  for (let i = 0; i < 4; i++) {
    c.add(cylZ(0.006, 0.004, 16), 'knobs', F.blackMatte, [W * 0.25 + i * 0.022 - 0.033, front * 0.5, D / 2 + 0.0005])
  }
}

function addLights(c: Ctx, W: number, D: number, y: number): void {
  for (const sx of [-1, 1]) {
    const m = c.add(cyl(0.022, 0.022, 0.003, 24), 'light', F.emissive, [sx * W * 0.3, y, D * 0.15])
    m.userData.emissiveReady = true
  }
}

export function dishwasher(c: Ctx): void {
  const { W, H, D } = c
  const integrated = c.bool('integrated', false)
  const frontT = 0.02
  const bodyD = D - frontT
  c.add(rbox(W, H, bodyD, 0.003), 'body', F.steel, [0, H / 2, -D / 2 + bodyD / 2])
  const zf = -D / 2 + bodyD
  if (integrated) {
    const plinth = Math.min(0.1, H * 0.12)
    c.add(box(W - 0.004, plinth - 0.004, 0.016), 'plinth', F.white, [0, plinth / 2, zf - 0.04])
    c.add(rbox(W - 0.006, H - plinth - 0.006, 0.018, 0.0015), 'front', F.white, [0, plinth + (H - plinth) / 2, zf + 0.009])
    addHandle(c, c.str('handle', 'bar', ['bar', 'knob', 'none', 'edge'] as const), 0, H - 0.06, zf + 0.018, Math.min(0.32, W * 0.5), false)
    return
  }
  const panelH = Math.min(0.1, H * 0.12)
  const doorH = H - panelH - 0.004
  c.add(rbox(W - 0.004, doorH, frontT, 0.004), 'front', F.steel, [0, doorH / 2 + 0.002, zf + frontT / 2])
  c.add(rbox(W - 0.004, panelH - 0.004, frontT, 0.003), 'panel', F.blackMatte, [0, H - panelH / 2, zf + frontT / 2])
  // display and buttons
  c.add(rbox(0.09, panelH * 0.35, 0.003, 0.001), 'screen', F.screen, [W * 0.18, H - panelH / 2, zf + frontT + 0.001])
  for (let i = 0; i < 4; i++) {
    c.add(cylZ(0.006, 0.004, 16), 'knobs', F.steel, [-W * 0.3 + i * 0.03, H - panelH / 2, zf + frontT + 0.0015])
  }
  // recessed grip
  c.add(rbox(W * 0.6, 0.02, 0.01, 0.004), 'handles', F.steel, [0, doorH - 0.03, zf + frontT + 0.004])
}

export function washingMachine(c: Ctx): void {
  const { W, H, D } = c
  const bodyD = D - 0.03
  const zf = -D / 2 + bodyD
  c.add(rbox(W, H, bodyD, 0.012), 'body', F.white, [0, H / 2, -D / 2 + bodyD / 2])
  const panelH = Math.min(0.12, H * 0.14)
  const py = H - panelH / 2 - 0.004
  // control panel strip
  c.add(rbox(W - 0.01, panelH - 0.008, 0.008, 0.003), 'panel', F.whiteGloss, [0, py, zf + 0.004])
  // detergent drawer
  c.add(rbox(W * 0.32, panelH * 0.7, 0.014, 0.004), 'panel', F.whiteGloss, [-W / 2 + W * 0.2, py, zf + 0.009])
  c.add(rbox(W * 0.08, panelH * 0.18, 0.006, 0.003), 'handles', F.grey, [-W / 2 + W * 0.2, py - panelH * 0.18, zf + 0.016])
  // display + programme knob
  c.add(rbox(W * 0.18, panelH * 0.4, 0.003, 0.0015), 'screen', F.screen, [W * 0.05, py, zf + 0.0095])
  addKnob(c, W / 2 - W * 0.17, py, zf + 0.008, Math.min(0.026, panelH * 0.3))
  // porthole door
  const avail = H - panelH
  const R = Math.min(W * 0.34, avail * 0.36)
  const dy = panelH > 0 ? avail * 0.5 : H / 2
  const door = c.group([0, dy, zf])
  c.add(torus(R - 0.012, 0.022, 16, 64), 'door', F.chrome, [0, 0, 0.012], undefined, door)
  c.add(torus(R - 0.04, 0.013, 12, 64), 'gasket', F.rubber, [0, 0, 0.002], undefined, door)
  c.add(cylZ(R - 0.045, 0.01, 48), 'drum', F.steel, [0, 0, -0.012], undefined, door)
  const dome = lathe(
    [
      [R - 0.02, 0],
      [R * 0.92, 0.012],
      [R * 0.7, 0.026],
      [R * 0.4, 0.033],
      [0.0001, 0.035],
    ],
    48,
  )
  c.add(dome, 'glass', F.glass, [0, 0, 0.004], [Math.PI / 2, 0, 0], door)
  c.add(rbox(0.03, 0.08, 0.02, 0.008), 'handles', F.grey, [R - 0.005, 0, 0.026], undefined, door)
  // service hatch outline
  c.add(rbox(0.14, 0.1, 0.002, 0.004), 'panel', F.whiteGloss, [W / 2 - 0.12, 0.08, zf + 0.001])
}

export function tv(c: Ctx): void {
  const { W, H, D } = c
  const wall = c.has('stand') ? !c.bool('stand', true) : c.item.mount === 'wall'
  const standH = wall ? 0 : Math.min(0.09, H * 0.12)
  const ph = H - standH
  const panelT = Math.min(0.012, D * 0.5)
  const panelZ = wall ? D / 2 - panelT / 2 : 0
  const g = c.group([0, standH, panelZ])
  c.add(rbox(W, ph, panelT, 0.002), 'body', F.blackMatte, [0, ph / 2, 0], undefined, g)
  const scr = c.add(box(W - 0.012, ph - (wall ? 0.012 : 0.03), 0.0015), 'screen', F.screen, [0, ph / 2 + (wall ? 0 : 0.009), panelT / 2 + 0.0004], undefined, g)
  scr.userData.screen = true
  scr.userData.emissiveReady = true
  // electronics hump on the back
  const humpD = Math.max(0.004, Math.min(0.035, (wall ? D - panelT : D / 2 - panelT / 2) - 0.002))
  c.add(rbox(W * 0.62, ph * 0.55, humpD, Math.min(0.01, humpD / 2)), 'body', F.blackMatte, [0, ph * 0.45, -panelT / 2 - humpD / 2 + 0.001], undefined, g)
  if (!wall) {
    const style = c.str('standStyle', 'pedestal', ['pedestal', 'feet'] as const)
    if (style === 'feet') {
      for (const sx of [-1, 1]) {
        const foot = c.group([sx * W * 0.38, 0, 0])
        c.add(rbox(0.02, standH * 0.9, Math.min(0.03, D * 0.2), 0.004), 'metal', F.blackMetal, [0, standH / 2, 0], undefined, foot)
        c.add(rbox(0.05, 0.01, D * 0.9, 0.003), 'metal', F.blackMetal, [0, 0.005, 0], undefined, foot)
      }
    } else {
      c.add(rbox(Math.min(0.4, W * 0.32), 0.012, D, 0.004), 'metal', F.blackMetal, [0, 0.006, 0])
      c.add(rbox(0.06, standH + ph * 0.25, 0.018, 0.004), 'metal', F.blackMetal, [0, (standH + ph * 0.25) / 2, -panelT / 2 - 0.012])
    }
  }
}

/** outdoor condenser unit: sheet-metal casing, round fan grille on the front, side fins, feet */
function acOutdoor(c: Ctx): void {
  const { W, H, D } = c
  const footH = Math.min(0.03, H * 0.06)
  const bodyH = H - footH
  c.add(rbox(W, bodyH, D, 0.006), 'body', F.whiteGloss, [0, footH + bodyH / 2, 0])
  for (const sx of [-1, 1]) c.add(rbox(0.04, footH, D * 0.9, 0.003), 'metal', F.blackMetal, [sx * (W / 2 - 0.08), footH / 2, 0])
  const fanR = Math.min(bodyH * 0.42, W * 0.3)
  const fx = -W / 2 + Math.max(fanR + 0.04, W * 0.4)
  const fy = footH + bodyH / 2
  const zf = D / 2
  // dark fan cavity, blades and the protective grille
  c.add(cylZ(fanR, 0.004, 48), 'vent', F.anthracite, [fx, fy, zf - 0.0015])
  const blades = cached(gkey('acFan', fanR), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    for (let i = 0; i < 3; i++) {
      const b = new THREE.BoxGeometry(fanR * 0.32, fanR * 0.82, 0.003)
      b.translate(0, fanR * 0.45, 0)
      parts.push({ g: b, m: mat4([0, 0, 0], [0.35, 0, (i * Math.PI * 2) / 3]) })
    }
    parts.push({ g: new THREE.CylinderGeometry(fanR * 0.14, fanR * 0.14, 0.04, 20).rotateX(Math.PI / 2) })
    return merge(parts)
  })
  c.add(blades, 'metal', F.blackMetal, [fx, fy, zf - 0.03])
  const grille = cached(gkey('acGrille', fanR), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    const rings = Math.max(3, Math.round(fanR / 0.025))
    for (let i = 1; i <= rings; i++) parts.push({ g: new THREE.TorusGeometry((fanR * i) / rings, 0.0022, 6, 64) })
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.CylinderGeometry(0.0025, 0.0025, fanR * 2, 6)
      parts.push({ g: bar, m: mat4([0, 0, 0], [0, 0, (i * Math.PI) / 4]) })
    }
    return merge(parts)
  })
  c.add(grille, 'metal', F.blackMetal, [fx, fy, zf + 0.004])
  // service panel
  const px = W / 2 - Math.min(0.12, W * 0.12)
  c.add(rbox(Math.min(0.18, W * 0.2), bodyH * 0.35, 0.004, 0.002), 'body', F.whiteGloss, [px, footH + bodyH * 0.72, zf + 0.002])
  // louvred left side
  const fins = Math.max(6, Math.floor((bodyH * 0.8) / 0.02))
  const finG = cached(gkey('acFins', D, bodyH, fins), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    for (let i = 0; i < fins; i++) parts.push({ g: new THREE.BoxGeometry(0.004, 0.006, D * 0.8), m: mat4([0, -bodyH * 0.4 + (i * bodyH * 0.8) / (fins - 1), 0], [0.5, 0, 0]) })
    return merge(parts)
  })
  c.add(finG, 'metal', F.blackMetal, [-W / 2 + 0.0015, fy, 0])
  // refrigerant valves on the right side
  for (const k of [0, 1]) c.add(cylX(0.008, 0.02, 12), 'metal', F.steel, [W / 2 - 0.006, footH + 0.08 + k * 0.04, D * 0.25])
}

export function airConditioner(c: Ctx): void {
  if (c.bool('outdoor', false)) {
    acOutdoor(c)
    return
  }
  const { W, H, D } = c
  const r = Math.min(D * 0.45, H * 0.35)
  const shape = extrudeSide(gkey('acShape', W, H, D), () => {
    const s = new THREE.Shape()
    const zb = -D / 2
    const zf = D / 2
    s.moveTo(zb, H * 0.18)
    s.lineTo(zb + D * 0.25, 0)
    s.lineTo(zf - D * 0.45, 0)
    s.quadraticCurveTo(zf, H * 0.02, zf, H * 0.4)
    s.lineTo(zf, H - r)
    s.quadraticCurveTo(zf, H, zf - r, H)
    s.lineTo(zb, H)
    s.closePath()
    return s
  }, W, Math.min(0.008, W * 0.02), 16)
  c.add(shape, 'body', F.whiteGloss, [0, 0, 0])
  // louvre flap in the outlet
  const flap = c.group([0, H * 0.1, D * 0.08], [-0.5, 0, 0])
  c.add(rbox(W * 0.86, 0.006, D * 0.32, 0.002), 'louvre', F.whiteGloss, [0, 0, 0], undefined, flap)
  // outlet shadow slot
  c.add(box(W * 0.88, 0.004, D * 0.36), 'vent', F.anthracite, [0, 0.003, D * 0.02])
  // status display
  const disp = c.add(rbox(0.05, 0.012, 0.002, 0.001), 'screen', F.screen, [W * 0.32, H * 0.55, D / 2 + 0.0002])
  disp.userData.emissiveReady = true
}

/** heated towel rail: two vertical chrome posts with horizontal bars */
function towelRail(c: Ctx): void {
  const { W, H, D } = c
  const bars = c.int('sections', Math.max(4, Math.round(H / 0.1)), 2, 40)
  const postR = Math.min(0.016, W * 0.05, D * 0.25)
  const barR = Math.min(0.0115, postR * 0.75)
  const zc = D / 2 - postR - 0.002
  const g = cached(gkey('towelRail', W, H, D, bars), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    for (const sx of [-1, 1]) {
      const post = new THREE.CylinderGeometry(postR, postR, H - 2 * postR, 20)
      parts.push({ g: post, m: mat4([sx * (W / 2 - postR), H / 2, zc]) })
      for (const y of [postR, H - postR]) parts.push({ g: new THREE.SphereGeometry(postR, 16, 10), m: mat4([sx * (W / 2 - postR), y, zc]) })
      // wall brackets
      for (const y of [H * 0.15, H * 0.85]) {
        const br = new THREE.CylinderGeometry(postR * 0.5, postR * 0.5, D - postR, 12)
        br.rotateX(Math.PI / 2)
        parts.push({ g: br, m: mat4([sx * (W / 2 - postR), y, -D / 2 + (D - postR) / 2]) })
      }
    }
    for (let i = 0; i < bars; i++) {
      const t = i / Math.max(1, bars - 1)
      const y = 0.06 + (H - 0.12) * t
      const bar = new THREE.CylinderGeometry(barR, barR, W - 2 * postR, 14)
      bar.rotateZ(Math.PI / 2)
      parts.push({ g: bar, m: mat4([0, y, zc]) })
    }
    return merge(parts)
  })
  c.add(g, 'body', F.chrome, [0, 0, 0])
}

export function radiator(c: Ctx): void {
  const { W, H, D } = c
  const type = c.str('type', 'sectional', ['sectional', 'panel', 'ladder'] as const)
  if (type === 'ladder') {
    towelRail(c)
    return
  }
  const style = c.str('style', type === 'panel' ? 'panel' : 'sectional', ['sectional', 'panel'] as const)
  if (style === 'panel') {
    const plateT = Math.min(0.012, D * 0.2)
    const g = cached(gkey('radPanel', W, H, D), () => {
      const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
      // front plate with horizontal ribs
      const front = new THREE.BoxGeometry(W, H * 0.94, plateT)
      parts.push({ g: front, m: mat4([0, H * 0.47, D / 2 - plateT / 2]) })
      const ribs = Math.max(3, Math.floor((H * 0.94) / 0.05))
      for (let i = 0; i < ribs; i++) {
        const rib = new THREE.CylinderGeometry(0.004, 0.004, W - 0.01, 8)
        rib.rotateZ(Math.PI / 2)
        parts.push({ g: rib, m: mat4([0, 0.03 + (i * (H * 0.94 - 0.06)) / Math.max(1, ribs - 1), D / 2 - plateT + 0.0015]) })
      }
      // back plate
      parts.push({ g: new THREE.BoxGeometry(W, H * 0.94, plateT), m: mat4([0, H * 0.47, -D / 2 + plateT / 2]) })
      // side covers
      for (const sx of [-1, 1]) parts.push({ g: new THREE.BoxGeometry(0.004, H, D), m: mat4([sx * (W / 2 - 0.002), H / 2, 0]) })
      // top grille
      const slats = Math.max(4, Math.floor(W / 0.02))
      for (let i = 0; i < slats; i++) {
        parts.push({ g: new THREE.BoxGeometry(0.004, 0.003, D - 0.01), m: mat4([-W / 2 + 0.01 + (i * (W - 0.02)) / (slats - 1), H - 0.0015, 0]) })
      }
      parts.push({ g: new THREE.BoxGeometry(W, H * 0.06, 0.004), m: mat4([0, H * 0.97, D / 2 - 0.002]) })
      return merge(parts)
    })
    c.add(g, 'body', F.white, [0, 0, 0])
    c.add(cylZ(0.009, 0.03, 16), 'metal', F.chrome, [W / 2 - 0.03, 0.03, Math.max(-D / 2 + 0.016, D / 2 - 0.02)])
    return
  }
  const n = c.int('sections', Math.max(3, Math.round(W / 0.08)), 2, 60)
  const pitch = W / n
  const g = cached(gkey('radSect', W, H, D, n), () => {
    const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4 }[] = []
    const colR = Math.min(0.012, pitch * 0.18)
    for (let i = 0; i < n; i++) {
      const x = -W / 2 + pitch / 2 + i * pitch
      // two vertical columns per section joined by top/bottom hubs
      for (const sz of [-1, 1]) {
        const col = new THREE.CylinderGeometry(colR, colR, H - 0.07, 12, 1)
        parts.push({ g: col, m: mat4([x, H / 2, sz * (D / 2 - colR - 0.002)]) })
      }
      parts.push({ g: rbox(pitch * 0.82, H - 0.04, D * 0.3, 0.006), m: mat4([x, H / 2, 0]) })
      for (const y of [0.035, H - 0.035]) {
        const hub = new THREE.CylinderGeometry(0.03, 0.03, pitch * 0.9, 16, 1)
        hub.rotateZ(Math.PI / 2)
        parts.push({ g: hub, m: mat4([x, y, 0], undefined, [1, 1, Math.min(1, (D - 0.004) / 0.06)]) })
      }
    }
    return merge(parts)
  })
  c.add(g, 'body', F.white, [0, 0, 0])
}
