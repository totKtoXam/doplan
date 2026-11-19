import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core/defaults'
import type { Doc } from '@core/types'
import type { BakedLevel, EngineContext } from '@/contracts'
import type { RenderShared } from '../quality'
import { status3dStore } from '../status'
import { createBakedLight } from './apply'
import { bakeSignature, geometryHash, receiversOf } from './collect'
import { BAKE_MANIFEST, bakePagePath, parseBakeManifest } from './manifest'
import { DEFAULT_LAYOUT, layoutHash, layoutOf } from './unwrap'

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** a scene with one room: its floor is the receiver */
function setup() {
  let doc: Doc = createEmptyDoc()
  const levelId = doc.levelOrder[0]
  const architecture = new THREE.Group()
  const room = new THREE.Group()
  room.name = 'room:r1'
  const live = new THREE.MeshStandardMaterial({ color: 0x806040 })
  const floor = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.PlaneGeometry(4, 3).rotateX(-Math.PI / 2), live)
  room.add(floor)
  architecture.add(room)
  const frames: ((dt: number) => void)[] = []
  const ctx = {
    roots: { architecture, items: new THREE.Group(), electrical: new THREE.Group() },
    invalidate() {},
    onBeforeRender(cb: (dt: number) => void) {
      frames.push(cb)
      return () => {}
    },
  } as unknown as EngineContext
  const shared: { baked: boolean; setBaked(on: boolean): void; bakeLights: null } = {
    baked: false,
    setBaked(on: boolean) {
      shared.baked = on
    },
    bakeLights: null,
  }
  let ceilings = false
  const loadTexture = vi.fn(async (url: string) => {
    const t = new THREE.Texture()
    t.name = url
    return t
  })
  const baked = createBakedLight(ctx, shared as unknown as RenderShared, {
    shown: () => ({ doc, levelId }),
    ceilingsShown: () => ceilings,
    flush() {},
    whenIdle: async () => {},
    withFullScene: (_c, fn) => fn(),
    loadTexture,
  })
  const receivers = receiversOf(architecture)
  const sig = bakeSignature(doc, levelId)
  const level: BakedLevel = {
    layout: DEFAULT_LAYOUT,
    layoutHash: layoutHash(layoutOf(receivers, DEFAULT_LAYOUT)),
    geometry: geometryHash(receivers),
    lights: sig.lights,
    casters: sig.casters,
    closed: { file: bakePagePath(levelId, 'closed'), scale: 2 },
    open: { file: bakePagePath(levelId, 'open'), scale: 3 },
  }
  const manifest = { version: 1 as const, levels: { [levelId]: level } }
  return {
    baked,
    floor,
    live,
    shared,
    loadTexture,
    manifest,
    frame: () => frames.forEach((f) => f(0)),
    setCeilings: (on: boolean) => {
      ceilings = on
    },
    setDoc: (next: Doc) => {
      doc = next
    },
    doc: () => doc,
  }
}

const base = 'https://example.org/plan/'

describe('baked light in the viewer', () => {
  it('shows the page of the plan as baked: a cheap material with the light-map UVs', async () => {
    const t = setup()
    t.baked.set({ manifest: t.manifest, base, live: false })
    await settle()
    const m = t.floor.material as unknown as THREE.MeshBasicMaterial
    expect(m.isMeshBasicMaterial).toBe(true)
    expect(m.color.getHex()).toBe(t.live.color.getHex())
    expect(m.lightMap?.name).toMatch(/-open\.webp$/)
    expect(m.lightMapIntensity).toBe(3)
    expect(t.floor.geometry.getAttribute('uv1')).toBeTruthy()
    expect(t.floor.userData.liveMaterial).toBe(t.live)
    expect(t.shared.baked).toBe(true)
    expect(status3dStore.getState().baked).toBe('on')
  })

  it('takes the page with the ceilings when they come on screen', async () => {
    const t = setup()
    t.baked.set({ manifest: t.manifest, base, live: false })
    await settle()
    t.setCeilings(true)
    t.frame()
    await settle()
    const m = t.floor.material as unknown as THREE.MeshBasicMaterial
    expect(m.lightMap?.name).toMatch(/-closed\.webp$/)
    expect(m.lightMapIntensity).toBe(2)
    expect(t.loadTexture).toHaveBeenCalledTimes(2)
  })

  it('lights the scene live when the visitor asks, while held, and when the plan changed', async () => {
    const t = setup()
    t.baked.set({ manifest: t.manifest, base, live: true })
    await settle()
    expect(t.floor.material).toBe(t.live)
    expect(status3dStore.getState().baked).toBe('live')

    t.baked.set({ manifest: t.manifest, base, live: false })
    await settle()
    const release = t.baked.hold()
    expect(t.floor.material).toBe(t.live)
    expect(t.shared.baked).toBe(false)
    release()
    await settle()
    expect((t.floor.material as THREE.Material).type).toBe('MeshBasicMaterial')

    const d = t.doc()
    t.setDoc({ ...d, render: { ...d.render, sunIntensity: (d.render.sunIntensity ?? 1) + 1 } })
    t.baked.refresh()
    await settle()
    expect(t.floor.material).toBe(t.live)
    expect(t.shared.baked).toBe(false)
    expect(status3dStore.getState().baked).toBe('mismatch')
  })

  it('stays live when the page does not load', async () => {
    const t = setup()
    t.loadTexture.mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t.baked.set({ manifest: t.manifest, base, live: false })
    await settle()
    warn.mockRestore()
    expect(t.floor.material).toBe(t.live)
    expect(status3dStore.getState().baked).toBe('mismatch')
  })
})

describe('bake manifest', () => {
  const level = {
    layout: { density: 20, maxSize: 2048, minSize: 256, pad: 2 },
    layoutHash: 'a',
    geometry: 'b',
    lights: 'c',
    casters: 'd',
    closed: { file: 'assets/bake/lv_1-closed.webp', scale: 2 },
    open: { file: 'assets/bake/lv_1-open.webp', scale: 3 },
  }

  it('reads a well-formed manifest', () => {
    expect(BAKE_MANIFEST).toBe('assets/bake/bake.json')
    expect(bakePagePath('lv.1', 'open')).toBe('assets/bake/lv_1-open.webp')
    expect(parseBakeManifest({ version: 1, levels: { lv_1: level } })?.levels.lv_1).toEqual(level)
  })

  it('drops levels with a page outside assets/bake, a missing page or a bad number', () => {
    const bad = [
      { ...level, closed: { file: '../secret.webp', scale: 2 } },
      { ...level, open: { file: 'https://evil.example/x.webp', scale: 2 } },
      { ...level, open: undefined },
      { ...level, closed: { ...level.closed, scale: Number.NaN } },
      { ...level, layout: { ...level.layout, maxSize: 1e9 } },
      { ...level, lights: 7 },
    ]
    for (const l of bad) expect(parseBakeManifest({ version: 1, levels: { lv_1: l } })).toBeNull()
    expect(parseBakeManifest({ version: 2, levels: { lv_1: level } })).toBeNull()
    expect(parseBakeManifest({ version: 1, levels: { '../x': level } })).toBeNull()
    expect(parseBakeManifest({ version: 1, levels: { __proto__: level } })).toBeNull()
  })
})
