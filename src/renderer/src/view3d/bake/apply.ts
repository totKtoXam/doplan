/**
 * The baked light in the running 3D view.
 *
 * Viewer: the published pages are shown on the walls, floors and ceilings while the shown plan
 * still is what was baked: the same lights and sky, the same furniture, the same geometry laid out
 * the same way. The receivers then get a cheap material (their colour and picture times the light
 * map, no live lights), the sun and the lamps stop casting shadow maps and the screen-space
 * occlusion is off. Anything else (a hidden chair, a lamp switched off, the visitor's "live light")
 * shows the live light.
 *
 * Each level has two pages with one layout: with the ceilings in place (the walk, or the ceiling
 * shown) and without them (the dollhouse views, where the sun and the sky come in from above, as
 * the live light has them).
 *
 * Editor: bakes the shown level for publishing.
 *
 * A receiver keeps the live material in `userData.liveMaterial` (the material library counts it as
 * used) and gets a non-indexed copy of its geometry with the light-map UVs in `uv1`, which the live
 * material ignores.
 */
import * as THREE from 'three'
import type { Doc, Id } from '@core/types'
import type { BakedLevel, BakeOutput, BakeVariant, EngineContext } from '@/contracts'
import type { RenderShared } from '../quality'
import { setBakedState } from '../status'
import { bakeSignature, castersOf, geometryHash, type Receiver, receiversOf } from './collect'
import { DEFAULT_LAYOUT, type Layout, layoutHash, layoutOf } from './unwrap'

export interface BakedLightDeps {
  /** the document as the scene shows it, and its level */
  shown(): { doc: Doc; levelId: Id }
  /** the ceilings are on screen (walk, or the ceiling shown) */
  ceilingsShown(): boolean
  /** applies pending document changes to the scene */
  flush(): void
  /** textures and models settled */
  whenIdle(): Promise<void>
  /** runs `fn` with full-height walls, and the ceilings shown or left out */
  withFullScene<T>(ceilings: boolean, fn: () => T): T
  /** a page by URL (tests give their own) */
  loadTexture?(url: string): Promise<THREE.Texture>
}

export interface BakedLightSource {
  manifest: { levels: Record<string, BakedLevel> }
  base: string
  live: boolean
}

export interface BakedLight {
  set(src: BakedLightSource | null): void
  /** after the scene or the shown document changed */
  refresh(): void
  /** live materials until the returned function is called (path tracing, export) */
  hold(): () => void
  bake(opts?: { onProgress?(done: number, total: number): void; signal?: AbortSignal }): Promise<BakeOutput | null>
  dispose(): void
}

interface Applied {
  live: THREE.Material
  baked: THREE.MeshBasicMaterial
}

/** bump when the tracing or the page changes: a cached bake is then made again */
const BAKE_VERSION = 2
/** the last bake of each level in this session: publishing again without a change is quick */
const lastBake = new Map<Id, { key: string; out: BakeOutput }>()

const isBasic = (m: unknown): m is THREE.MeshBasicMaterial => !!m && (m as THREE.MeshBasicMaterial).isMeshBasicMaterial === true

/** the light map's own material for a live one: its colour and picture, lit by the page only */
function bakedFor(live: THREE.Material): THREE.MeshBasicMaterial {
  const s = live as THREE.MeshStandardMaterial
  const m = new THREE.MeshBasicMaterial({
    color: s.color ? s.color.clone() : new THREE.Color(1, 1, 1),
    map: s.map ?? null,
    side: live.side,
  })
  m.name = `${live.name || 'material'} (baked)`
  m.polygonOffset = live.polygonOffset
  m.polygonOffsetFactor = live.polygonOffsetFactor
  m.polygonOffsetUnits = live.polygonOffsetUnits
  m.userData.bakedFrom = live
  return m
}

/** a non-indexed copy of the receiver's geometry with the light-map UVs of its triangles */
function withUv1(g: THREE.BufferGeometry, uv: Float32Array): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone()
  out.setAttribute('uv1', new THREE.BufferAttribute(uv, 2))
  return out
}

function defaultLoad(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url)
}

export function createBakedLight(ctx: EngineContext, shared: RenderShared, deps: BakedLightDeps): BakedLight {
  let src: BakedLightSource | null = null
  let holds = 0
  /** pages by level and variant, loaded once */
  const pages = new Map<string, Promise<THREE.Texture | null>>()
  /** the cheap material of each live one, for the level shown */
  let mats = new Map<THREE.Material, THREE.MeshBasicMaterial>()
  const applied = new Map<THREE.Mesh, Applied>()
  /** what the meshes were last laid out for: level, geometry and layout */
  let shownKey = ''
  /** the level and the variant whose page the materials show */
  let shownLevel: { id: Id; level: BakedLevel } | null = null
  let shownVariant: BakeVariant | null = null
  let request = 0

  const variantNow = (): BakeVariant => (deps.ceilingsShown() ? 'closed' : 'open')

  const loadPage = (levelId: Id, level: BakedLevel, variant: BakeVariant): Promise<THREE.Texture | null> => {
    const k = `${levelId}|${variant}`
    let p = pages.get(k)
    if (!p) {
      const url = new URL(level[variant].file, src?.base ?? location.href).href
      p = (deps.loadTexture ?? defaultLoad)(url)
        .then((tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          tex.channel = 1
          tex.anisotropy = 4
          tex.needsUpdate = true
          return tex
        })
        .catch((err: unknown) => {
          console.warn('[doplan] baked light not loaded', err)
          return null
        })
      pages.set(k, p)
    }
    return p
  }

  function unapply(): void {
    for (const [mesh, a] of applied) if (mesh.material === a.baked) mesh.material = a.live
    applied.clear()
    for (const m of mats.values()) m.dispose()
    mats = new Map()
    shownKey = ''
    shownLevel = null
    shownVariant = null
    shared.setBaked(false)
    ctx.invalidate()
  }

  function showPage(page: THREE.Texture, scale: number): void {
    for (const m of mats.values()) {
      if (m.lightMap !== page) {
        m.lightMap = page
        m.needsUpdate = true
      }
      m.lightMapIntensity = scale
    }
    ctx.invalidate()
  }

  function apply(receivers: Receiver[], layout: Layout, key: string): void {
    // geometry shared between meshes is replaced, not disposed
    const users = new Map<THREE.BufferGeometry, number>()
    ctx.roots.architecture.traverse((o) => {
      const g = (o as THREE.Mesh).geometry
      if (g) users.set(g, (users.get(g) ?? 0) + 1)
    })
    const next = new Map<THREE.Material, THREE.MeshBasicMaterial>()
    receivers.forEach((r, i) => {
      const mesh = r.mesh
      if (mesh.userData.bakedKey !== key) {
        const old = mesh.geometry
        mesh.geometry = withUv1(old, layout.uv[i])
        mesh.userData.bakedKey = key
        if ((users.get(old) ?? 0) <= 1) old.dispose()
      }
      const current = mesh.material as THREE.Material
      const live = isBasic(current) && current.userData.bakedFrom ? (current.userData.bakedFrom as THREE.Material) : current
      let baked = next.get(live)
      if (!baked) {
        baked = mats.get(live) ?? bakedFor(live)
        next.set(live, baked)
      }
      mesh.userData.liveMaterial = live
      mesh.material = baked
      applied.set(mesh, { live, baked })
    })
    for (const [live, m] of mats) if (next.get(live) !== m) m.dispose()
    mats = next
    shownKey = key
  }

  /** shows the page of the wanted variant (loading it first); false when it could not be had */
  async function showVariant(token: number, levelId: Id, level: BakedLevel, variant: BakeVariant): Promise<boolean> {
    const page = await loadPage(levelId, level, variant)
    if (token !== request || !src || src.live || holds > 0) return true
    if (!page) return false
    showPage(page, level[variant].scale)
    shownVariant = variant
    return true
  }

  function refresh(): void {
    const token = ++request
    if (!src) {
      if (applied.size || shared.baked) unapply()
      setBakedState('none')
      return
    }
    if (src.live || holds > 0) {
      if (applied.size || shared.baked) unapply()
      setBakedState(src.live ? 'live' : 'on')
      return
    }
    const mismatch = () => {
      if (applied.size || shared.baked) unapply()
      setBakedState('mismatch')
    }
    const { doc, levelId } = deps.shown()
    const level = Object.hasOwn(src.manifest.levels, levelId) ? src.manifest.levels[levelId] : undefined
    const sig = level ? bakeSignature(doc, levelId) : null
    if (!level || !sig || sig.lights !== level.lights || sig.casters !== level.casters) return mismatch()
    const receivers = receiversOf(ctx.roots.architecture)
    const geometry = geometryHash(receivers)
    if (geometry !== level.geometry) return mismatch()
    const key = `${levelId}|${geometry}|${level.layoutHash}`
    // the same meshes laid out for the same page: only new meshes of a rebuilt group need it
    const fresh = receivers.some((r) => r.mesh.userData.bakedKey !== key || !applied.has(r.mesh))
    if (key === shownKey && !fresh) return
    const layout = layoutOf(receivers, level.layout)
    if (layoutHash(layout) !== level.layoutHash) return mismatch()
    if (shownKey && shownKey !== key) unapply()
    const variant = variantNow()
    setBakedState('loading')
    void loadPage(levelId, level, variant).then((page) => {
      if (token !== request || !src || src.live || holds > 0) return
      if (!page) return mismatch()
      apply(receivers, layout, key)
      shownLevel = { id: levelId, level }
      showPage(page, level[variant].scale)
      shownVariant = variant
      shared.setBaked(true)
      setBakedState('on')
    })
  }

  let switching = false
  const offFrame = ctx.onBeforeRender(() => {
    // the live material's picture arrives after it was copied (textures decode in the background)
    for (const [live, m] of mats) {
      const s = live as THREE.MeshStandardMaterial
      const map = s.map ?? null
      if (m.map !== map) {
        m.map = map
        m.needsUpdate = true
      }
      if (s.color && !m.color.equals(s.color)) m.color.copy(s.color)
    }
    // the ceilings came or went (walk, the ceiling button): the other page
    if (shownLevel && shownVariant && !switching) {
      const want = variantNow()
      if (want !== shownVariant) {
        switching = true
        const { id, level } = shownLevel
        void showVariant(request, id, level, want).then((ok) => {
          switching = false
          if (!ok) refresh()
        })
      }
    }
  })

  return {
    set(next) {
      const before = src
      src = next
      if (!next || !before || before.base !== next.base || before.manifest !== next.manifest) {
        for (const p of pages.values()) void p.then((t) => t?.dispose())
        pages.clear()
        if (applied.size) unapply()
      }
      refresh()
    },
    refresh() {
      if (src || applied.size) refresh()
    },
    hold() {
      holds++
      if (applied.size || shared.baked) unapply()
      let released = false
      return () => {
        if (released) return
        released = true
        holds = Math.max(0, holds - 1)
        if (holds === 0 && src) refresh()
      }
    },
    async bake(opts = {}) {
      deps.flush()
      await deps.whenIdle()
      const lights = shared.bakeLights?.()
      if (!lights) return null
      const { doc, levelId } = deps.shown()
      const release = this.hold()
      try {
        const roots = [ctx.roots.architecture, ctx.roots.items, ctx.roots.electrical]
        const { receivers, closed } = deps.withFullScene(true, () => ({
          receivers: receiversOf(ctx.roots.architecture),
          closed: castersOf(roots),
        }))
        const open = deps.withFullScene(false, () => castersOf(roots))
        if (!receivers.length) return null
        const sig = bakeSignature(doc, levelId)
        const geometry = geometryHash(receivers)
        const key = JSON.stringify([BAKE_VERSION, DEFAULT_LAYOUT, geometry, sig, lights])
        const cached = lastBake.get(levelId)
        if (cached?.key === key) {
          opts.onProgress?.(1, 1)
          return cached.out
        }
        const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
        const { bakeLightMap } = await import('./run')
        const pass = async (casters: Float32Array, part: number) =>
          bakeLightMap(receivers, casters, lights, {
            layout: DEFAULT_LAYOUT,
            workers: Math.max(1, Math.min(8, cores - 1)),
            onProgress: opts.onProgress && ((done, total) => opts.onProgress?.(part * total + done, 2 * total)),
            signal: opts.signal,
          })
        const c = await pass(closed, 0)
        const o = await pass(open, 1)
        const out: BakeOutput = {
          levelId,
          level: { layout: DEFAULT_LAYOUT, layoutHash: c.layoutHash, geometry, lights: sig.lights, casters: sig.casters },
          size: c.layout.size,
          pages: { closed: { rgba: c.rgba, scale: c.scale }, open: { rgba: o.rgba, scale: o.scale } },
        }
        lastBake.set(levelId, { key, out })
        return out
      } finally {
        release()
      }
    },
    dispose() {
      offFrame()
      request++
      src = null
      for (const m of mats.values()) m.dispose()
      mats.clear()
      applied.clear()
      for (const p of pages.values()) void p.then((t) => t?.dispose())
      pages.clear()
    },
  }
}
