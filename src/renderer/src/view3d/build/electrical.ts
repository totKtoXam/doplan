/**
 * Simple 3D models of the electrical points (layer «Электрика»): a frame with the inserts of each
 * post (socket face, switch keys, USB / data ports), cable outlets, boxes, the panel, sensors.
 * One group per point in `roots.electrical`, userData.ref = {kind:'electric', id}. Built in the
 * local frame of the point: x along the wall, y up, z out of the wall (into the room).
 */
import * as THREE from 'three'
import { electricGangs, electricType } from '@core'
import type { Doc, ElectricPoint, Id } from '@core/types'
import { releaseObjects } from './util'

const POST = 0.071 // m, post pitch of a modular frame
const FRAME = 0.086 // m, outer size of a one-post frame
const FRAME_T = 0.009 // m, frame thickness off the wall
const INSERT = 0.05 // m, insert (socket face / key) size

interface Mats {
  plastic: THREE.MeshStandardMaterial
  insert: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  metal: THREE.MeshStandardMaterial
  cable: THREE.MeshStandardMaterial
  accent: THREE.MeshStandardMaterial
}

let mats: Mats | null = null
function materials(): Mats {
  if (!mats) {
    mats = {
      plastic: new THREE.MeshStandardMaterial({ color: 0xf3f3f0, roughness: 0.45, metalness: 0 }),
      insert: new THREE.MeshStandardMaterial({ color: 0xe9e9e5, roughness: 0.5, metalness: 0 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.6, metalness: 0 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.8 }),
      cable: new THREE.MeshStandardMaterial({ color: 0xdedcd6, roughness: 0.7, metalness: 0 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.5, metalness: 0 }),
    }
  }
  return mats
}

const geoCache = new Map<string, THREE.BufferGeometry>()
function boxG(w: number, h: number, d: number): THREE.BufferGeometry {
  const k = `b:${w.toFixed(4)}:${h.toFixed(4)}:${d.toFixed(4)}`
  let g = geoCache.get(k)
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d)
    geoCache.set(k, g)
  }
  return g
}
/** cylinder along local z (out of the wall) */
function discG(r: number, d: number): THREE.BufferGeometry {
  const k = `c:${r.toFixed(4)}:${d.toFixed(4)}`
  let g = geoCache.get(k)
  if (!g) {
    g = new THREE.CylinderGeometry(r, r, d, 28)
    g.rotateX(Math.PI / 2)
    geoCache.set(k, g)
  }
  return g
}
/** cylinder along local y (vertical) */
function postG(r: number, h: number): THREE.BufferGeometry {
  const k = `p:${r.toFixed(4)}:${h.toFixed(4)}`
  let g = geoCache.get(k)
  if (!g) {
    g = new THREE.CylinderGeometry(r, r, h, 20)
    geoCache.set(k, g)
  }
  return g
}
function domeG(r: number): THREE.BufferGeometry {
  const k = `s:${r.toFixed(4)}`
  let g = geoCache.get(k)
  if (!g) {
    g = new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    g.rotateX(Math.PI / 2)
    geoCache.set(k, g)
  }
  return g
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const o = new THREE.Mesh(g, m)
  o.position.set(x, y, z)
  o.castShadow = false
  o.receiveShadow = true
  return o
}

/** the insert of one post centred at (cx, cy), on the frame face (z = FRAME_T) */
function post(g: THREE.Group, p: ElectricPoint, cx: number, cy: number): void {
  const M = materials()
  const ty = electricType(p.kind)
  const z = FRAME_T
  switch (ty.device) {
    case 'socket': {
      g.add(mesh(discG(0.024, 0.006), M.insert, cx, cy, z + 0.003))
      g.add(mesh(discG(0.0185, 0.004), M.plastic, cx, cy, z + 0.005))
      for (const s of [-1, 1]) g.add(mesh(discG(0.0026, 0.002), M.dark, cx + s * 0.0095, cy, z + 0.0072))
      if (p.kind !== 'socket') for (const s of [-1, 1]) g.add(mesh(boxG(0.003, 0.008, 0.002), M.metal, cx, cy + s * 0.0175, z + 0.0068))
      if (p.kind === 'socketUsbA' || p.kind === 'socketUsbAC') g.add(mesh(boxG(0.012, 0.0045, 0.002), M.dark, cx - (p.kind === 'socketUsbAC' ? 0.008 : 0), cy - 0.031, z + 0.002))
      if (p.kind === 'socketUsbC' || p.kind === 'socketUsbAC') g.add(mesh(boxG(0.008, 0.003, 0.002), M.dark, cx + (p.kind === 'socketUsbAC' ? 0.01 : 0), cy - 0.031, z + 0.002))
      if (p.kind === 'socketIP44' || p.kind === 'socketLid') g.add(mesh(boxG(INSERT + 0.012, INSERT + 0.012, 0.012), M.plastic, cx, cy + 0.004, z + 0.012))
      if (p.kind === 'socketPower') g.add(mesh(discG(0.0026, 0.002), M.dark, cx, cy + 0.01, z + 0.0072))
      break
    }
    case 'switch': {
      const keys = Math.max(1, ty.keys ?? 1)
      if (p.kind === 'dimmer') {
        g.add(mesh(boxG(INSERT, INSERT, 0.004), M.insert, cx, cy, z + 0.002))
        g.add(mesh(discG(0.016, 0.014), M.plastic, cx, cy, z + 0.009))
        break
      }
      const w = (INSERT - 0.002 * (keys - 1)) / keys
      for (let i = 0; i < keys; i++) {
        const kx = cx - INSERT / 2 + w / 2 + i * (w + 0.002)
        g.add(mesh(boxG(w, INSERT, 0.008), M.insert, kx, cy, z + 0.004))
      }
      if (p.kind === 'bell') g.add(mesh(discG(0.008, 0.002), M.accent, cx, cy, z + 0.009))
      if (p.kind === 'switchPass' || p.kind === 'switchCross') g.add(mesh(boxG(0.008, 0.002, 0.001), M.dark, cx, cy + 0.016, z + 0.0085))
      break
    }
    case 'usb': {
      g.add(mesh(boxG(INSERT, INSERT, 0.005), M.insert, cx, cy, z + 0.0025))
      for (const s of [-1, 1]) g.add(mesh(p.kind === 'usbA' ? boxG(0.012, 0.0045, 0.002) : boxG(0.0085, 0.003, 0.002), M.dark, cx, cy + s * 0.009, z + 0.005))
      break
    }
    case 'data': {
      g.add(mesh(boxG(INSERT, INSERT, 0.005), M.insert, cx, cy, z + 0.0025))
      if (p.kind === 'tv') {
        g.add(mesh(discG(0.0055, 0.008), M.metal, cx, cy, z + 0.007))
      } else if (p.kind === 'speaker') {
        for (const s of [-1, 1]) g.add(mesh(discG(0.004, 0.006), s < 0 ? M.accent : M.dark, cx + s * 0.01, cy, z + 0.006))
      } else {
        const w = p.kind === 'hdmi' ? 0.015 : p.kind === 'phone' ? 0.0095 : 0.012
        g.add(mesh(boxG(w, 0.009, 0.002), M.dark, cx, cy, z + 0.005))
      }
      break
    }
    case 'thermostat': {
      g.add(mesh(boxG(INSERT, INSERT, 0.008), M.insert, cx, cy, z + 0.004))
      g.add(mesh(boxG(0.034, 0.022, 0.001), M.dark, cx, cy + 0.006, z + 0.0085))
      break
    }
    default:
      break
  }
}

function buildFramed(g: THREE.Group, p: ElectricPoint): void {
  const M = materials()
  const n = electricGangs(p)
  const len = FRAME + (n - 1) * POST
  const w = p.vertical ? FRAME : len
  const h = p.vertical ? len : FRAME
  g.add(mesh(boxG(w, h, FRAME_T), M.plastic, 0, 0, FRAME_T / 2))
  for (let i = 0; i < n; i++) {
    const off = -((n - 1) * POST) / 2 + i * POST
    post(g, p, p.vertical ? 0 : off, p.vertical ? -off : 0)
  }
}

function buildDevice(g: THREE.Group, p: ElectricPoint): void {
  const M = materials()
  const ty = electricType(p.kind)
  switch (ty.device) {
    case 'cable': {
      if (p.mount === 'ceiling') {
        // outlet in the ceiling: a cover with the cable hanging down (local z = down)
        g.add(mesh(discG(0.04, 0.008), M.plastic, 0, 0, 0.004))
        g.add(mesh(discG(0.004, 0.12), M.cable, 0, 0, 0.068))
      } else {
        g.add(mesh(discG(0.03, 0.006), M.plastic, 0, 0, 0.003))
        g.add(mesh(discG(0.004, 0.09), M.cable, 0, 0, 0.05))
        g.add(mesh(boxG(0.012, 0.012, 0.012), M.accent, 0, 0, 0.096))
      }
      break
    }
    case 'box':
      g.add(mesh(discG(0.042, 0.006), M.plastic, 0, 0, 0.003))
      break
    case 'panel':
      g.add(mesh(boxG(0.3, 0.4, 0.016), M.plastic, 0, 0, 0.008))
      g.add(mesh(boxG(0.22, 0.06, 0.002), M.dark, 0, 0.06, 0.017))
      break
    case 'sensor':
      if (p.mount === 'wall') g.add(mesh(domeG(0.03), M.plastic, 0, 0, 0))
      else if (p.mount === 'floor') g.add(mesh(boxG(0.06, 0.06, 0.02), M.plastic, 0, 0, 0.01))
      else {
        g.add(mesh(discG(0.05, 0.03), M.plastic, 0, 0, 0.015))
        g.add(mesh(discG(0.004, 0.002), M.accent, 0.03, 0, 0.031))
      }
      break
    default: {
      // a point of unknown kind: a small marker
      g.add(mesh(boxG(0.06, 0.06, 0.012), M.plastic, 0, 0, 0.006))
      g.add(mesh(discG(0.01, 0.004), M.accent, 0, 0, 0.014))
    }
  }
}

/** world group of one point (positioned and oriented) */
export function buildElectricPoint(p: ElectricPoint): THREE.Group {
  const g = new THREE.Group()
  g.name = `electric:${p.id}`
  g.userData.ref = { kind: 'electric', id: p.id }
  const ty = electricType(p.kind)
  if (ty.framed) buildFramed(g, p)
  else buildDevice(g, p)
  g.position.set(p.x / 1000, p.elevation / 1000, p.y / 1000)
  if (p.mount === 'wall') {
    // local +z → plan facing (cos r, sin r), local +x → along the wall (sin r, −cos r)
    g.rotation.set(0, Math.PI / 2 - (p.rotation * Math.PI) / 180, 0)
  } else if (p.mount === 'ceiling') {
    // local +z points down
    g.rotation.set(Math.PI / 2, 0, 0)
    g.rotateZ((-p.rotation * Math.PI) / 180)
  } else {
    // floor: local +z points up
    g.rotation.set(-Math.PI / 2, 0, 0)
    g.rotateZ((-p.rotation * Math.PI) / 180)
  }
  return g
}

/** keeps `root` in sync with the points of the shown level (like the lights, at y = 0 of the level); returns true when the scene changed */
export class ElectricalBuilder {
  private built = new Map<Id, { src: ElectricPoint; obj: THREE.Group }>()

  constructor(private root: THREE.Group) {}

  sync(doc: Pick<Doc, 'electrical'>, levelId: Id): boolean {
    let changed = false
    const rec = doc.electrical ?? {}
    for (const [id, b] of this.built) {
      const p = rec[id]
      if (p && p.levelId === levelId && p === b.src) continue
      this.root.remove(b.obj)
      releaseObjects(b.obj)
      this.built.delete(id)
      changed = true
    }
    for (const id in rec) {
      const p = rec[id]
      if (p.levelId !== levelId || this.built.has(id)) continue
      const obj = buildElectricPoint(p)
      this.root.add(obj)
      this.built.set(id, { src: p, obj })
      changed = true
    }
    return changed
  }

  objectFor(id: Id): THREE.Group | undefined {
    return this.built.get(id)?.obj
  }

  clear(): void {
    for (const b of this.built.values()) {
      this.root.remove(b.obj)
      releaseObjects(b.obj)
    }
    this.built.clear()
  }
}
