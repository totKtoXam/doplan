/**
 * Everything that leaves the engine as a file:
 *  - exportSceneGlb: architecture + items → binary glTF
 *  - convertModel: user glb / gltf / obj(+mtl) / fbx → normalised GLB (metres, Y-up, footprint
 *    centred on the origin, standing on the floor) + size + material slot names
 *  - ThumbRenderer: asset / material thumbnails rendered into an offscreen target
 *  - readback helpers shared with realtime stills
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import type { Asset, Material } from '@core/types'
import type { EngineContext } from '@/contracts'
import { type ItemsLayer, createGltfLoader } from './items'
import type { MaterialLibraryEx } from './materials'
import { drawWhenReady } from './pipelines'

// ───────────────────────────── GLB export ─────────────────────────────

export async function exportSceneGlb(objects: THREE.Object3D[]): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter()
  for (const o of objects) o.updateMatrixWorld(true)
  const restore = drawableImages(objects)
  try {
    const result = await exporter.parseAsync(objects, { binary: true, onlyVisible: true, maxTextureSize: 2048 })
    if (result instanceof ArrayBuffer) return result
    return new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer
  } finally {
    restore()
  }
}

/**
 * GLTFExporter draws maps onto a 2D canvas (and merges metalness + roughness there), which takes
 * no raw pixel data: data textures — the 1×1 stand-ins of maps still loading or failed (materials.ts)
 * — are handed over as canvases for the export. Returns the undo.
 */
function drawableImages(objects: THREE.Object3D[]): () => void {
  const swapped = new Map<THREE.Texture, unknown>()
  const visit = (t: unknown): void => {
    const tex = t as THREE.Texture | null
    if (!tex?.isTexture || swapped.has(tex)) return
    const img = tex.image as { data?: ArrayLike<number>; width?: number; height?: number } | null
    if (!img || !img.data || typeof img.width !== 'number' || typeof img.height !== 'number') return
    const { data, width, height } = img
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) return
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const c2 = canvas.getContext('2d')
    if (!c2) return
    c2.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    swapped.set(tex, tex.image)
    tex.image = canvas
  }
  for (const root of objects)
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m) return
      for (const mat of Array.isArray(m) ? m : [m]) for (const v of Object.values(mat)) visit(v)
    })
  return () => {
    for (const [tex, img] of swapped) tex.image = img
  }
}

// ───────────────────────────── model conversion ─────────────────────────────

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ktx2: 'image/ktx2',
  bin: 'application/octet-stream',
  mtl: 'text/plain',
}

const extOf = (name: string): string => (name.split('.').pop() ?? '').toLowerCase()
const baseOf = (path: string): string => {
  const clean = path.split(/[?#]/)[0]
  let name = clean.split(/[\\/]/).pop() ?? ''
  try {
    name = decodeURIComponent(name)
  } catch {
    /* keep the raw name */
  }
  return name.toLowerCase()
}

function toStandard(src: THREE.Material, cache: Map<THREE.Material, THREE.Material>): THREE.Material {
  const hit = cache.get(src)
  if (hit) return hit
  let out: THREE.Material = src
  const any = src as THREE.MeshPhongMaterial & { isMeshStandardMaterial?: boolean; isMeshPhysicalMaterial?: boolean }
  if (!any.isMeshStandardMaterial && !any.isMeshPhysicalMaterial) {
    const std = new THREE.MeshStandardMaterial()
    std.name = src.name
    if (any.color?.isColor) std.color.copy(any.color)
    if (any.map) std.map = any.map
    if (any.normalMap) std.normalMap = any.normalMap
    if (any.emissive?.isColor) std.emissive.copy(any.emissive)
    if (any.emissiveMap) std.emissiveMap = any.emissiveMap
    if (any.alphaMap) std.alphaMap = any.alphaMap
    std.opacity = src.opacity
    std.transparent = src.transparent
    std.alphaTest = src.alphaTest
    std.side = src.side
    std.vertexColors = src.vertexColors
    const shininess = typeof any.shininess === 'number' ? any.shininess : 30
    std.roughness = THREE.MathUtils.clamp(1 - Math.sqrt(Math.max(0, shininess) / 100) * 0.8, 0.15, 1)
    std.metalness = 0
    if (std.map) std.map.colorSpace = THREE.SRGBColorSpace
    out = std
  }
  cache.set(src, out)
  return out
}

export async function convertModel(
  renderer: unknown,
  file: { name: string; data: ArrayBuffer },
  aux: { name: string; data: ArrayBuffer }[] = [],
): Promise<{ glb: ArrayBuffer; size: { w: number; d: number; h: number }; slots: string[] }> {
  const ext = extOf(file.name)
  const urls = new Map<string, string>()
  for (const f of aux) {
    const blob = new Blob([f.data], { type: MIME[extOf(f.name)] ?? 'application/octet-stream' })
    urls.set(baseOf(f.name), URL.createObjectURL(blob))
  }
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url
    return urls.get(baseOf(url)) ?? url
  })
  // count outstanding resource loads so that textures are complete before exporting
  let pending = 0
  const itemStart = manager.itemStart.bind(manager)
  const itemEnd = manager.itemEnd.bind(manager)
  const itemError = manager.itemError.bind(manager)
  manager.itemStart = (url: string) => {
    pending++
    itemStart(url)
  }
  manager.itemEnd = (url: string) => {
    pending = Math.max(0, pending - 1)
    itemEnd(url)
  }
  manager.itemError = (url: string) => {
    itemError(url)
  }
  const settle = async (): Promise<void> => {
    const deadline = performance.now() + 20000
    await new Promise((r) => setTimeout(r, 30))
    while (pending > 0 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 40))
  }

  let root: THREE.Object3D
  let gltfTools: { dispose(): void } | null = null
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const tools = createGltfLoader(renderer, manager)
      gltfTools = tools
      const gltf = await tools.loader.parseAsync(file.data, '')
      root = gltf.scene
    } else if (ext === 'obj') {
      const loader = new OBJLoader(manager)
      const mtl = aux.find((f) => extOf(f.name) === 'mtl')
      if (mtl) {
        const creator = new MTLLoader(manager).parse(new TextDecoder().decode(mtl.data), '')
        creator.preload()
        loader.setMaterials(creator)
      }
      root = loader.parse(new TextDecoder().decode(file.data))
    } else if (ext === 'fbx') {
      root = new FBXLoader(manager).parse(file.data, '')
    } else {
      throw new Error(`Unsupported model format: .${ext}`)
    }
    await settle()

    // strip what is not part of the furniture piece
    const junk: THREE.Object3D[] = []
    root.traverse((o) => {
      const any = o as THREE.Object3D & { isLight?: boolean; isCamera?: boolean }
      if (any.isLight || any.isCamera) junk.push(o)
    })
    for (const o of junk) o.removeFromParent()

    // standard materials + unique slot names
    const cache = new Map<THREE.Material, THREE.Material>()
    const slots: string[] = []
    const used = new Set<string>()
    let meshCount = 0
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      meshCount++
      const convert = (m: THREE.Material): THREE.Material => {
        const first = !cache.has(m)
        const std = toStandard(m, cache)
        if (first) {
          let name = (std.name || '').trim() || `material_${slots.length + 1}`
          const base = name
          let n = 2
          while (used.has(name)) name = `${base}_${n++}`
          used.add(name)
          std.name = name
          slots.push(name)
        }
        return std
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material)
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
    })
    if (meshCount === 0) throw new Error('The file contains no meshes')

    // normalise: metres, footprint centred on the origin, standing on the floor
    const holder = new THREE.Group()
    holder.name = 'model'
    holder.add(root)
    holder.updateMatrixWorld(true)
    let box = new THREE.Box3().setFromObject(holder)
    let dims = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(dims.x, dims.y, dims.z)
    if (!Number.isFinite(maxDim) || maxDim <= 0) throw new Error('The model has no extent')
    let scale = 1
    if (maxDim > 50) scale = maxDim > 400 ? 0.001 : 0.01 // authored in mm / cm
    else if (maxDim < 0.02) scale = maxDim * 100 < 0.2 ? 1000 : 100
    holder.scale.setScalar(scale)
    holder.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(holder)
    dims = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    holder.position.set(-center.x, -box.min.y, -center.z)
    const out = new THREE.Scene()
    out.name = file.name.replace(/\.[^.]+$/, '')
    out.add(holder)
    out.updateMatrixWorld(true)

    const exporter = new GLTFExporter()
    const result = await exporter.parseAsync(out, { binary: true, onlyVisible: false, maxTextureSize: 2048 })
    const glb = result instanceof ArrayBuffer ? result : (new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer)

    // free the temporary scene
    out.traverse((o) => {
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
    return {
      glb,
      size: {
        w: Math.max(1, Math.round(dims.x * 1000)),
        d: Math.max(1, Math.round(dims.z * 1000)),
        h: Math.max(1, Math.round(dims.y * 1000)),
      },
      slots,
    }
  } finally {
    gltfTools?.dispose()
    for (const u of urls.values()) URL.revokeObjectURL(u)
  }
}

// ───────────────────────────── pixel readback ─────────────────────────────

/** Khronos PBR Neutral tone mapping (keeps base colours exact below ~0.8, rolls off highlights) */
function neutralTone(rgb: [number, number, number]): [number, number, number] {
  const start = 0.8 - 0.04
  const desat = 0.15
  let [r, g, b] = rgb
  const x = Math.min(r, g, b)
  const off = x < 0.08 ? x - 6.25 * x * x : 0.04
  r -= off
  g -= off
  b -= off
  const peak = Math.max(r, g, b)
  if (peak < start) return [r, g, b]
  const d = 1 - start
  const np = 1 - (d * d) / (peak + d - start)
  const s = np / peak
  r *= s
  g *= s
  b *= s
  const t = 1 - 1 / (desat * (peak - np) + 1)
  return [r + (np - r) * t, g + (np - g) * t, b + (np - b) * t]
}

function srgb8(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v
  const e = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(e * 255)
}

/**
 * Reads a render target into ImageData. `linear` targets (half float / float, working colour
 * space) are encoded to sRGB here; 8-bit targets are taken as display-ready.
 */
export async function readTarget(renderer: any, target: THREE.RenderTarget, linear: boolean, toneMap = false): Promise<ImageData> {
  const w = target.width
  const h = target.height
  const raw = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)) as Uint8Array | Uint16Array | Float32Array
  const out = new Uint8ClampedArray(w * h * 4)
  // WebGL reads rows bottom-up, WebGPU top-down
  const flip = renderer.backend?.isWebGPUBackend !== true
  const isHalf = raw instanceof Uint16Array
  const isFloat = raw instanceof Float32Array
  for (let y = 0; y < h; y++) {
    const srcRow = (flip ? h - 1 - y : y) * w * 4
    const dstRow = y * w * 4
    for (let x = 0; x < w * 4; x += 4) {
      const s = srcRow + x
      const d = dstRow + x
      if (isHalf || isFloat) {
        const r = isHalf ? THREE.DataUtils.fromHalfFloat(raw[s]) : raw[s]
        const g = isHalf ? THREE.DataUtils.fromHalfFloat(raw[s + 1]) : raw[s + 1]
        const b = isHalf ? THREE.DataUtils.fromHalfFloat(raw[s + 2]) : raw[s + 2]
        const a = isHalf ? THREE.DataUtils.fromHalfFloat(raw[s + 3]) : raw[s + 3]
        if (linear) {
          const c = toneMap ? neutralTone([r, g, b]) : [r, g, b]
          out[d] = srgb8(c[0])
          out[d + 1] = srgb8(c[1])
          out[d + 2] = srgb8(c[2])
        } else {
          out[d] = Math.round(Math.min(1, Math.max(0, r)) * 255)
          out[d + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255)
          out[d + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255)
        }
        out[d + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255)
      } else if (linear) {
        out[d] = srgb8(raw[s] / 255)
        out[d + 1] = srgb8(raw[s + 1] / 255)
        out[d + 2] = srgb8(raw[s + 2] / 255)
        out[d + 3] = raw[s + 3]
      } else {
        out[d] = raw[s]
        out[d + 1] = raw[s + 1]
        out[d + 2] = raw[s + 2]
        out[d + 3] = raw[s + 3]
      }
    }
  }
  return new ImageData(out, w, h)
}

/** ImageData → encoded image, optionally downscaled and composited over a background */
export async function imageToBlob(
  image: ImageData,
  width: number,
  height: number,
  opts: { type?: 'image/png' | 'image/jpeg'; background?: string | [string, string]; opaque?: boolean } = {},
): Promise<Blob> {
  const src = document.createElement('canvas')
  src.width = image.width
  src.height = image.height
  // CPU-backed canvases: encoding a GPU canvas reads it back and waits behind the GPU process
  const sctx = src.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('2D canvas unavailable')
  if (opts.opaque) {
    const d = image.data
    for (let i = 3; i < d.length; i += 4) d[i] = 255
  }
  sctx.putImageData(image, 0, 0)
  const dst = document.createElement('canvas')
  dst.width = width
  dst.height = height
  const ctx = dst.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')
  if (opts.background) {
    if (Array.isArray(opts.background)) {
      const g = ctx.createLinearGradient(0, 0, 0, height)
      g.addColorStop(0, opts.background[0])
      g.addColorStop(1, opts.background[1])
      ctx.fillStyle = g
    } else ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, image.width, image.height, 0, 0, width, height)
  const type = opts.type ?? 'image/png'
  return new Promise<Blob>((resolve, reject) => {
    dst.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, type === 'image/jpeg' ? 0.92 : undefined)
  })
}

// ───────────────────────────── thumbnails ─────────────────────────────

/** small procedural studio environment (soft top light, neutral walls, darker floor) */
function studioEnvironment(): THREE.DataTexture {
  const w = 64
  const h = 32
  // half float: filterable on every WebGPU adapter (rgba32float needs an optional feature)
  const data = new Uint16Array(w * h * 4)
  const hf = THREE.DataUtils.toHalfFloat
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1) // 0 = bottom row of the equirect (nadir) with flipY = false … 1 = zenith
    for (let x = 0; x < w; x++) {
      const u = x / w
      let l = 0.22 + 0.55 * Math.pow(v, 1.4)
      // overhead soft box and two side strips
      if (v > 0.82) l += 2.6
      const side = Math.abs(((u + 0.12) % 0.5) - 0.25)
      if (v > 0.42 && v < 0.72 && side < 0.045) l += 1.6
      const i = (y * w + x) * 4
      data[i] = hf(l)
      data[i + 1] = hf(l)
      data[i + 2] = hf(l * 1.02)
      data[i + 3] = hf(1)
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.LinearSRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

export class ThumbRenderer {
  private env: THREE.DataTexture | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private sphere: THREE.BufferGeometry | null = null

  constructor(
    private readonly ctx: EngineContext,
    private readonly lib: MaterialLibraryEx,
    private readonly items: ItemsLayer,
  ) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async shoot(object: THREE.Object3D, size: number, direction: THREE.Vector3, margin: number): Promise<Blob> {
    const renderer = this.ctx.renderer
    const px = Math.max(16, Math.min(1024, Math.round(size)))
    const ss = px <= 512 ? 2 : 1
    const scene = new THREE.Scene()
    if (!this.env) this.env = studioEnvironment()
    scene.environment = this.env
    scene.environmentIntensity = 0.5
    scene.add(object)
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const r = Math.max(0.01, sphere.radius)

    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.copy(sphere.center).add(new THREE.Vector3(0.9, 1.6, 1.3).normalize().multiplyScalar(r * 4))
    key.target.position.copy(sphere.center)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = -r * 1.2
    key.shadow.camera.right = r * 1.2
    key.shadow.camera.top = r * 1.2
    key.shadow.camera.bottom = -r * 1.2
    key.shadow.camera.near = r * 0.5
    key.shadow.camera.far = r * 8
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55)
    fill.position.copy(sphere.center).add(new THREE.Vector3(-1.4, 0.6, 0.8).multiplyScalar(r * 3))
    fill.target.position.copy(sphere.center)
    const rim = new THREE.DirectionalLight(0xfff1dd, 0.5)
    rim.position.copy(sphere.center).add(new THREE.Vector3(0.2, 1.2, -1.6).multiplyScalar(r * 3))
    rim.target.position.copy(sphere.center)
    scene.add(key, key.target, fill, fill.target, rim, rim.target, new THREE.HemisphereLight(0xffffff, 0xb9bcc2, 0.3))

    const fov = 28
    const camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 100)
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(fov / 2))) * margin
    camera.position.copy(sphere.center).addScaledVector(direction.clone().normalize(), dist)
    camera.near = Math.max(0.005, dist - r * 2)
    camera.far = dist + r * 3
    camera.lookAt(sphere.center)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)

    const target = new THREE.RenderTarget(px * ss, px * ss, { type: THREE.HalfFloatType, depthBuffer: true })
    const draw = (): void => {
      const prevTarget = renderer.getRenderTarget()
      const prevColor = renderer.getClearColor(new THREE.Color())
      const prevAlpha = renderer.getClearAlpha()
      try {
        renderer.setRenderTarget(target)
        renderer.setClearColor(0x000000, 0)
        renderer.render(scene, camera)
      } finally {
        renderer.setRenderTarget(prevTarget)
        renderer.setClearColor(prevColor, prevAlpha)
      }
    }
    try {
      // a model met for the first time compiles its pipelines first (pipelines.ts)
      await drawWhenReady(renderer, draw)
      const image = await readTarget(renderer, target, true, true)
      return await imageToBlob(image, px, px, { background: ['#f2f3f4', '#d8dadd'] })
    } finally {
      target.dispose()
      scene.remove(object)
      key.dispose()
      fill.dispose()
      rim.dispose()
      this.ctx.invalidate()
    }
  }

  renderAsset(asset: Asset, size: number): Promise<Blob> {
    return this.enqueue(async () => {
      const object = await this.items.buildStandalone(asset)
      await this.lib.whenIdle(5000)
      try {
        const flat = asset.size.h < Math.max(asset.size.w, asset.size.d) * 0.08
        const dir = flat ? new THREE.Vector3(0.55, 1.1, 0.9) : new THREE.Vector3(0.85, 0.55, 1.15)
        return await this.shoot(object, size, dir, 1.04)
      } finally {
        object.traverse((o) => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
          if (g && !g.userData.shared) g.dispose()
        })
      }
    })
  }

  renderMaterial(material: Material, size: number): Promise<Blob> {
    return this.enqueue(async () => {
      if (!this.sphere) {
        const g = new THREE.SphereGeometry(0.5, 96, 48)
        // UVs in metres: circumference π m around, π/2 m pole to pole
        const uv = g.getAttribute('uv')
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI, uv.getY(i) * (Math.PI / 2))
        uv.needsUpdate = true
        g.userData.shared = true
        this.sphere = g
      }
      const mat = this.lib.fromDefinition(material)
      await this.lib.whenIdle(6000)
      const mesh = new THREE.Mesh(this.sphere, mat)
      mesh.castShadow = false
      mesh.receiveShadow = false
      return this.shoot(mesh, size, new THREE.Vector3(0.35, 0.3, 1), 1.02)
    })
  }

  dispose(): void {
    this.env?.dispose()
    this.env = null
    this.sphere?.dispose()
    this.sphere = null
  }
}
