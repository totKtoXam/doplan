/**
 * Items layer: one child of `roots.items` per document Item.
 *  - procedural assets come from the ProceduralFactory
 *  - model assets are GLB / glTF files loaded once (shared template cache) and cloned per item,
 *    scaled so that the model's bounding box fills `item.size` (uniformly when the catalog size
 *    contradicts the model's proportions, see assets/fit.ts)
 *  - items are diffed per id: a moved item only gets a new transform
 */
import * as THREE from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { clone as cloneWithSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import basisJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url'
import basisWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url'
import dracoWasmUrl from 'three/addons/libs/draco/gltf/draco_decoder.wasm?url'
import dracoJsUrl from 'three/addons/libs/draco/gltf/draco_wasm_wrapper.js?url'
import { toWorld } from '@core'
import type { Asset, Doc, EntityRef, Id, Item } from '@core/types'
import type { EngineContext, ProceduralFactory } from '@/contracts'
import { uiStore } from '@/store/ui'
import { fitScale, pickVariant, type NamedBox, type Vec3 } from './assets/fit'
import { disposeGeometries, stampRef } from './build/util'
import type { MaterialLibraryEx } from './materials'
import { resolveAssetUrl } from './textures'
import { modelLoadEnded, modelLoadStarted } from './status'

export interface ModelTemplate {
  scene: THREE.Object3D
  /** bounding box of `scene` in its own space */
  box: THREE.Box3
}

interface ItemRec {
  item: Item
  asset: Asset | undefined
  key: string
  root: THREE.Group
  token: number
}

const DECODER_FILES: Record<string, string> = {
  'draco_wasm_wrapper.js': dracoJsUrl,
  'draco_decoder.wasm': dracoWasmUrl,
  'basis_transcoder.js': basisJsUrl,
  'basis_transcoder.wasm': basisWasmUrl,
}

/**
 * GLTFLoader with meshopt, Draco and KTX2 support. The decoder binaries are bundled by Vite
 * (`?url` imports) and mapped through the loading manager, so nothing is fetched from a CDN
 * and nothing is loaded at all until a file actually needs a decoder.
 */
export function createGltfLoader(renderer: unknown, manager?: THREE.LoadingManager): { loader: GLTFLoader; dispose(): void } {
  const loader = new GLTFLoader(manager ?? new THREE.LoadingManager())
  loader.setMeshoptDecoder(MeshoptDecoder)
  // decoders get their own manager so that a caller-supplied URL modifier cannot hide them
  const decoderManager = new THREE.LoadingManager()
  decoderManager.setURLModifier((url) => {
    const name = url.split(/[\\/]/).pop() ?? ''
    return DECODER_FILES[name] ?? url
  })
  const draco = new DRACOLoader(decoderManager)
  draco.setDecoderPath('decoders/')
  draco.setDecoderConfig({ type: 'wasm' })
  loader.setDRACOLoader(draco)
  let ktx2: KTX2Loader | null = null
  try {
    ktx2 = new KTX2Loader(decoderManager)
    ktx2.setTranscoderPath('decoders/')
    if (renderer) ktx2.detectSupport(renderer as never)
    loader.setKTX2Loader(ktx2)
  } catch (err) {
    console.warn('[doplan] KTX2 textures unavailable', err)
    ktx2 = null
  }
  return {
    loader,
    dispose() {
      draco.dispose()
      ktx2?.dispose()
    },
  }
}

function prepareTemplate(scene: THREE.Object3D, variants: boolean): ModelTemplate {
  let unnamed = 0
  const named = new Map<THREE.Material, string>()
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.receiveShadow = true
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    let seeThrough = false
    for (const m of mats) {
      if (!m) continue
      if (!m.name) {
        let n = named.get(m)
        if (!n) {
          n = `material_${unnamed++}`
          named.set(m, n)
        }
        m.name = n
      }
      // material names are the override slots of model assets (picking reads userData.slot)
      m.userData.slot = m.name
      const pm = m as THREE.MeshPhysicalMaterial
      if ((pm.transmission ?? 0) > 0.3 || (m.transparent && m.opacity < 0.6)) seeThrough = true
    }
    if (!Array.isArray(mesh.material) && mesh.material) mesh.userData.slot = mesh.material.name
    mesh.castShadow = !seeThrough
    // instances share the template geometry: never dispose it together with an item
    if (mesh.geometry) mesh.geometry.userData.shared = true
  })
  scene.updateMatrixWorld(true)
  if (variants) keepFirstVariant(scene)
  const box = new THREE.Box3().setFromObject(scene)
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(0.25, 0.5, 0.25))
  return { scene, box }
}

/**
 * Catalog models are sized by their first variant (tools/assets/sizes.ts); user imports (and their
 * blob: previews) are sized by the whole file and must never lose parts.
 */
function trimsVariants(asset: Asset): boolean {
  return !asset.custom && !!asset.src && !/^(blob|data):/.test(asset.src)
}

/** variant collections (several plants side by side in one file) keep only their first variant */
function keepFirstVariant(scene: THREE.Object3D): void {
  const roots = scene.children
  if (roots.length < 2) return
  const boxes: NamedBox[] = roots.map((o) => {
    const b = new THREE.Box3().setFromObject(o)
    return { name: o.name, min: b.min.toArray() as Vec3, max: b.max.toArray() as Vec3 }
  })
  const keep = pickVariant(boxes)
  if (!keep) return
  const kept = new Set(keep.map((i) => roots[i]))
  for (const o of [...roots]) if (!kept.has(o)) scene.remove(o)
}

/** main-thread time one scene sync spends building procedural items before leaving the rest to later frames */
const SYNC_BUDGET_MS = 12

export class ItemsLayer {
  private records = new Map<Id, ItemRec>()
  private templates = new Map<string, Promise<ModelTemplate>>()
  /** templates whose download finished, for synchronous re-instantiation */
  private ready = new Map<string, ModelTemplate>()
  private gltf: { loader: GLTFLoader; dispose(): void } | null = null
  private tokens = 0
  private disposed = false
  /** assets already reported for a catalog size that contradicts the model */
  private warnedSize = new Set<string>()
  /**
   * Procedural items left for later frames: a sync that rebuilds many (opening 3D, a variant or a
   * level switch, a quality change) builds for SYNC_BUDGET_MS and leaves the rest to `pump`, so the
   * window keeps answering; one edited item is always built at once (no flicker while dragging).
   */
  private deferred = new Set<ItemRec>()
  /** end of this sync's build time, 0 outside a sync */
  private budgetEnd = 0

  constructor(
    private readonly ctx: EngineContext,
    private readonly lib: MaterialLibraryEx,
    private readonly factory: ProceduralFactory,
    /** called when an asynchronously loaded model was swapped in */
    private readonly onAsyncChange: () => void,
  ) {}

  /** the loaders hold renderer capabilities: call after the renderer was re-created */
  resetLoaders(): void {
    this.gltf?.dispose()
    this.gltf = null
  }

  /** `variants`: trim variant collections to their first variant (catalog models only, see fit.ts) */
  loadTemplate(src: string, variants = false): Promise<ModelTemplate> {
    const key = this.templateKey(src, variants)
    let p = this.templates.get(key)
    if (!p) {
      if (!this.gltf) this.gltf = createGltfLoader(this.ctx.renderer)
      p = this.gltf.loader.loadAsync(resolveAssetUrl(src)).then((g) => {
        const tpl = prepareTemplate(g.scene, variants)
        this.ready.set(key, tpl)
        return tpl
      })
      this.templates.set(key, p)
      p.catch(() => {
        // allow a retry after a failed download
        if (this.templates.get(key) === p) this.templates.delete(key)
      })
    }
    return p
  }

  private templateKey(src: string, variants: boolean): string {
    const url = resolveAssetUrl(src)
    return variants ? `variant:${url}` : url
  }

  /** clone of a template fitted into `size` (mm), origin at the footprint centre on the floor */
  private instantiate(tpl: ModelTemplate, item: Item, asset: Asset | undefined): THREE.Object3D {
    const inst = cloneWithSkeleton(tpl.scene)
    const overrides = item.overrides
    const tint = item.tint
    if ((overrides && Object.keys(overrides).length) || tint) {
      inst.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const swap = (m: THREE.Material): THREE.Material => {
          const id = overrides?.[m.name]
          if (id) return this.lib.getForItem(id)
          if (tint) return this.lib.tinted(m, tint)
          return m
        }
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
      })
    }
    const size = tpl.box.getSize(new THREE.Vector3())
    const center = tpl.box.getCenter(new THREE.Vector3())
    const fit = new THREE.Group()
    fit.name = 'fit'
    const { scale, uniform, mismatch } = fitScale(size.toArray() as Vec3, item.size, asset?.size)
    if (uniform && asset && !this.warnedSize.has(asset.id)) {
      this.warnedSize.add(asset.id)
      const mm = (v: number) => Math.round(v * 1000)
      console.warn(
        `[doplan] catalog size of ${asset.id} (${asset.size.w}×${asset.size.d}×${asset.size.h} mm) does not match the model ` +
          `(${mm(size.x)}×${mm(size.z)}×${mm(size.y)} mm, proportions off ×${mismatch.toFixed(2)}): scaling uniformly`,
      )
    }
    const [sx, sy, sz] = scale
    fit.scale.set(sx, sy, sz)
    fit.position.set(-center.x * sx, -tpl.box.min.y * sy, -center.z * sz)
    fit.add(inst)
    return fit
  }

  private placeholder(item: Item): THREE.Mesh {
    const w = Math.max(0.02, item.size.w / 1000)
    const h = Math.max(0.02, item.size.h / 1000)
    const d = Math.max(0.02, item.size.d / 1000)
    const geo = new THREE.BoxGeometry(w, h, d)
    geo.translate(0, h / 2, 0)
    const mesh = new THREE.Mesh(geo, this.lib.plain({ color: '#9aa4b0', roughness: 0.9, opacity: 0.55 }))
    mesh.userData.placeholder = true
    mesh.castShadow = false
    return mesh
  }

  private applyTransform(root: THREE.Group, item: Item): void {
    const p = toWorld(item.x, item.y, item.elevation)
    root.position.set(p[0], p[1], p[2])
    // plan degrees are clockwise with y down; plan y maps to world +z → negative rotation about Y
    root.rotation.set(0, -THREE.MathUtils.degToRad(item.rotation || 0), 0)
    root.scale.set(item.mirrored ? -1 : 1, 1, 1)
    root.visible = !item.hidden
    root.updateMatrixWorld(true)
  }

  private fill(rec: ItemRec): void {
    this.deferred.delete(rec)
    const { item, asset, root } = rec
    const ref: EntityRef = { kind: 'item', id: item.id }
    const token = rec.token
    const setContent = (obj: THREE.Object3D): void => {
      for (const child of [...root.children]) {
        root.remove(child)
        disposeGeometries(child)
      }
      root.add(obj)
      stampRef(obj, ref, !obj.userData.placeholder)
    }
    if (!asset) {
      setContent(this.placeholder(item))
      return
    }
    if (asset.kind === 'procedural') {
      // the old content (if any) stays until the new one is built
      if (this.budgetEnd && performance.now() > this.budgetEnd) {
        this.deferred.add(rec)
        return
      }
      try {
        setContent(this.factory.build(asset, item, this.lib))
      } catch (err) {
        console.warn('[doplan] procedural asset failed:', asset.id, err)
        setContent(this.placeholder(item))
      }
      return
    }
    if (!asset.src || asset.remote) {
      setContent(this.placeholder(item))
      return
    }
    // an already loaded model is swapped in at once: going through the promise would show the
    // placeholder box for a frame on every resize / parameter step of a drag (flicker)
    const loaded = this.ready.get(this.templateKey(asset.src, trimsVariants(asset)))
    if (loaded) {
      setContent(this.instantiate(loaded, item, asset))
      return
    }
    setContent(this.placeholder(item))
    modelLoadStarted()
    this.loadTemplate(asset.src, trimsVariants(asset))
      .then(
        (tpl) => {
          if (this.disposed || rec.token !== token || this.records.get(item.id) !== rec) return
          setContent(this.instantiate(tpl, rec.item, rec.asset))
          this.onAsyncChange()
        },
        (err) => console.warn('[doplan] model failed to load:', asset.src, err),
      )
      .finally(modelLoadEnded)
  }

  /** returns true when the scene graph changed (not for pure moves) */
  sync(doc: Doc, levelId: Id, epoch: number): { changed: boolean; moved: boolean } {
    this.budgetEnd = performance.now() + SYNC_BUDGET_MS
    try {
      return this.syncInner(doc, levelId, epoch)
    } finally {
      this.budgetEnd = 0
    }
  }

  /** whether procedural items wait to be built */
  get hasDeferred(): boolean {
    return this.deferred.size > 0
  }

  /** builds waiting procedural items for about `ms`; true when something was built */
  pump(ms = SYNC_BUDGET_MS): boolean {
    if (!this.deferred.size) return false
    const end = performance.now() + ms
    let built = false
    for (const rec of Array.from(this.deferred)) {
      if (built && performance.now() > end) break
      this.deferred.delete(rec)
      if (rec.token < 0 || this.records.get(rec.item.id) !== rec) continue
      this.fill(rec)
      built = true
    }
    return built
  }

  /** builds every waiting item now (stills, export, baking need the whole scene) */
  drain(): boolean {
    let built = false
    while (this.deferred.size) built = this.pump(Infinity) || built
    return built
  }

  private syncInner(doc: Doc, levelId: Id, epoch: number): { changed: boolean; moved: boolean } {
    const ui = uiStore.getState()
    let changed = false
    let moved = false
    const seen = new Set<Id>()
    for (const id in doc.items) {
      const item = doc.items[id]
      if (item.levelId !== levelId) continue
      seen.add(id)
      const asset = ui.getAsset(item.assetId)
      const old = this.records.get(id)
      if (old && old.item === item && old.asset === asset && old.key.startsWith(`${epoch}|`)) continue
      const key = `${epoch}|${JSON.stringify([item.assetId, item.size, item.overrides ?? null, item.tint ?? null, item.params ?? null, item.mount])}`
      if (old && old.key === key && old.asset === asset) {
        old.item = item
        this.applyTransform(old.root, item)
        moved = true
        continue
      }
      let rec = old
      if (!rec) {
        const root = new THREE.Group()
        root.name = `item:${id}`
        root.userData.ref = { kind: 'item', id } satisfies EntityRef
        rec = { item, asset, key, root, token: 0 }
        this.records.set(id, rec)
        this.ctx.roots.items.add(root)
      }
      rec.item = item
      rec.asset = asset
      rec.key = key
      rec.token = ++this.tokens
      this.applyTransform(rec.root, item)
      this.fill(rec)
      changed = true
    }
    for (const [id, rec] of Array.from(this.records)) {
      if (seen.has(id)) continue
      rec.token = -1
      this.deferred.delete(rec)
      rec.root.removeFromParent()
      disposeGeometries(rec.root)
      this.records.delete(id)
      changed = true
    }
    return { changed, moved }
  }

  objectFor(id: Id): THREE.Object3D | undefined {
    return this.records.get(id)?.root
  }

  /**
   * Stand-alone, fully loaded instance of an asset at its default size (thumbnails).
   * The caller owns the returned object.
   */
  async buildStandalone(asset: Asset): Promise<THREE.Object3D> {
    const item: Item = {
      id: 'thumb',
      levelId: '',
      assetId: asset.id,
      x: 0,
      y: 0,
      elevation: 0,
      rotation: 0,
      size: { ...asset.size },
      mount: asset.mount,
      params: asset.defaultParams ? { ...asset.defaultParams } : undefined,
    }
    const root = new THREE.Group()
    let content: THREE.Object3D
    if (asset.kind === 'procedural') content = this.factory.build(asset, item, this.lib)
    else if (asset.src && !asset.remote) content = this.instantiate(await this.loadTemplate(asset.src, trimsVariants(asset)), item, asset)
    else content = this.placeholder(item)
    root.add(content)
    stampRef(root, { kind: 'item', id: 'thumb' })
    return root
  }

  clear(): void {
    for (const rec of this.records.values()) {
      rec.token = -1
      rec.root.removeFromParent()
      disposeGeometries(rec.root)
    }
    this.records.clear()
    this.deferred.clear()
  }

  dispose(): void {
    this.disposed = true
    this.deferred.clear()
    this.clear()
    for (const p of this.templates.values()) {
      p.then((tpl) => {
        tpl.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry?.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) {
            if (!m) continue
            for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose()
            m.dispose()
          }
        })
      }).catch(() => undefined)
    }
    this.templates.clear()
    this.ready.clear()
    this.gltf?.dispose()
    this.gltf = null
  }
}
