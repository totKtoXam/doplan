/**
 * Lighting rig of the 3D view (area: 3d-rendering).
 *
 *  - sun: one DirectionalLight driven by doc.render (manual azimuth/elevation or time of day),
 *    shadow camera fitted to the level bounds;
 *  - sky: HDRI (HDRLoader / EXRLoader) or a procedural equirect sky → scene.background and
 *    scene.environment (WebGPURenderer builds the PMREM itself);
 *  - fill: hemisphere light + one RectAreaLight "sky portal" per window opening, pointing inward;
 *  - fixtures: doc.lights → PointLight / SpotLight / RectAreaLight with small emissive meshes
 *    placed in ctx.roots.lights (userData.ref = {kind:'light', id});
 *  - tone mapping + exposure on the renderer.
 *
 * Light units. Fixtures are specified in lumens and converted to candela / nits, then scaled by
 * LUMEN_SCALE so that `render.exposure = 1` gives a pleasant evening interior. The sun is not
 * scaled photometrically (a real sun is ~500× brighter than a lamp and would need a separate
 * exposure): `render.sunIntensity = 1` gives a bright but not clipped sun patch.
 */
import * as THREE from 'three'
import { RectAreaLightNode } from 'three/webgpu'
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { pointInPolygon, toWorld, visibleDoc, visiblePlan } from '@core'
import type { DerivedPlan, Doc, Id, Light, Opening, RenderSettings, Wall, WallGeom } from '@core/types'
import type { EngineContext, LightingRig } from '@/contracts'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { t } from '@/i18n'
import type { BakeLights, RGB } from './bake/trace'
import { BAKED_LIGHTS, currentQuality, getShared, type QualitySettings } from './quality'

// ───────────────────────────── calibration constants ─────────────────────────────

/** candela (or nits) → three intensity at exposure 1 */
const LUMEN_SCALE = 0.12
/** spots concentrate their flux; keep the hot spot inside the tone mapper's range */
const SPOT_SCALE = 0.5
/** DirectionalLight intensity for render.sunIntensity = 1 with the sun high in the sky */
const SUN_BASE = 3.2
/** radiance of a window portal at full daylight */
const PORTAL_RADIANCE = 3
/** share of the environment used as (unoccluded) image-based light in the raster path */
const ENV_RASTER = 0.3
const HEMI_DAY = 0.35
const HEMI_NIGHT = 0.035
/** latitude / declination used by the time-of-day model (mid latitudes, late spring) */
const LATITUDE = 55
const DECLINATION = 12

const DEG = Math.PI / 180

let ltcReady = false
function ensureAreaLightLib(): void {
  if (ltcReady) return
  try {
    RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
    ltcReady = true
  } catch (err) {
    console.warn('[lighting] RectAreaLight LTC init failed', err)
  }
}

// ───────────────────────────── small maths helpers ─────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function smoothstep(a: number, b: number, x: number): number {
  const k = clamp((x - a) / (b - a), 0, 1)
  return k * k * (3 - 2 * k)
}
function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

/** Colour temperature (Kelvin) → linear-sRGB colour (Tanner Helland fit). */
export function kelvinToColor(kelvin: number, target = new THREE.Color()): THREE.Color {
  const k = clamp(kelvin || 4000, 1000, 15000) / 100
  let r: number
  let g: number
  let b: number
  if (k <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(k) - 161.1195681661
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492)
    b = 255
  }
  return target.setRGB(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255, THREE.SRGBColorSpace)
}

/** Compass azimuth (clockwise from north) and elevation of the sun for a local solar time. */
export function solarPosition(hours: number): { azimuth: number; elevation: number } {
  const h = ((((hours % 24) + 24) % 24) - 12) * 15 * DEG
  const lat = LATITUDE * DEG
  const dec = DECLINATION * DEG
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h)
  const elevation = Math.asin(clamp(sinEl, -1, 1))
  // azimuth measured from south, positive towards west; +180° turns it into a compass bearing
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat))
  return { azimuth: (((az / DEG + 180) % 360) + 360) % 360, elevation: elevation / DEG }
}

export interface SunState {
  /** unit vector pointing from the scene towards the sun (world space) */
  direction: THREE.Vector3
  /** degrees above the horizon */
  elevation: number
  /** degrees clockwise from plan "up" (−y) */
  planAzimuth: number
  color: THREE.Color
  /** three DirectionalLight intensity */
  intensity: number
  /** 0 at night … 1 in full daylight */
  day: number
  /** 0 … 1 warmth of the low sun (sunrise / sunset) */
  warmth: number
}

/** Sun derived from the render settings (shared with the 2D north arrow / UI if needed). */
export function computeSun(r: RenderSettings): SunState {
  let compass = r.sunAzimuth || 0
  let elevation = r.sunElevation ?? 45
  if (r.sunAuto) {
    const s = solarPosition(r.timeOfDay ?? 12)
    compass = s.azimuth
    elevation = s.elevation
  }
  elevation = clamp(elevation, -90, 90)
  const planAzimuth = compass + (r.north || 0)
  const a = planAzimuth * DEG
  const e = elevation * DEG
  // plan "up" is −y → world −z; clockwise on the plan (y down) → (sin a, −cos a)
  const direction = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize()
  const day = smoothstep(-6, 8, elevation)
  const warmth = (1 - smoothstep(2, 24, elevation)) * smoothstep(-8, -1, elevation)
  const color = kelvinToColor(1900 + 3900 * smoothstep(-2, 35, elevation))
  const above = Math.pow(smoothstep(-1.5, 9, elevation), 0.8)
  const intensity = Math.max(0, r.sunIntensity ?? 1) * SUN_BASE * above
  return { direction, elevation, planAzimuth, color, intensity, day, warmth }
}

// ───────────────────────────── procedural sky ─────────────────────────────

const SKY = {
  dayZenith: [0.16, 0.32, 0.72],
  dayHorizon: [0.62, 0.74, 0.9],
  duskZenith: [0.1, 0.13, 0.3],
  duskHorizon: [1.0, 0.52, 0.22],
  nightZenith: [0.004, 0.006, 0.016],
  nightHorizon: [0.012, 0.015, 0.026],
  ground: [0.2, 0.19, 0.18],
}

function mix3(a: number[], b: number[], k: number, out: number[]): number[] {
  out[0] = a[0] + (b[0] - a[0]) * k
  out[1] = a[1] + (b[1] - a[1]) * k
  out[2] = a[2] + (b[2] - a[2]) * k
  return out
}

/** Average sky colour (linear) for fill lights. */
function skyTint(sun: SunState, target: THREE.Color): THREE.Color {
  const day = [0.78, 0.87, 1.0]
  const dusk = [1.0, 0.72, 0.5]
  const night = [0.25, 0.32, 0.55]
  const c = mix3(night, mix3(day, dusk, sun.warmth * 0.8, [0, 0, 0]), sun.day, [0, 0, 0])
  return target.setRGB(c[0], c[1], c[2])
}

/**
 * Analytic gradient sky with a sun glow, written as an equirectangular half-float texture so
 * the very same image feeds the background and the PMREM environment.
 */
function buildSkyTexture(width: number, sun: SunState): THREE.DataTexture {
  const w = Math.max(64, Math.floor(width))
  const h = w >> 1
  const data = new Uint16Array(w * h * 4)
  const toHalf = THREE.DataUtils.toHalfFloat
  const one = toHalf(1)

  const zenith = mix3(SKY.nightZenith, mix3(SKY.dayZenith, SKY.duskZenith, sun.warmth, [0, 0, 0]), sun.day, [0, 0, 0])
  const horizonCool = mix3(SKY.nightHorizon, SKY.dayHorizon, sun.day, [0, 0, 0])
  const horizonWarm = mix3(SKY.nightHorizon, SKY.duskHorizon, Math.max(sun.day, sun.warmth), [0, 0, 0])
  const groundLum = 0.12 + 0.88 * sun.day
  const ground = [SKY.ground[0] * groundLum, SKY.ground[1] * groundLum, SKY.ground[2] * groundLum]

  const sd = sun.direction
  const sunVisible = smoothstep(-3, 2, sun.elevation)
  const sunAzLen = Math.hypot(sd.x, sd.z) || 1
  const sunAx = sd.x / sunAzLen
  const sunAz = sd.z / sunAzLen
  const discRadius = Math.max(0.9, (1.6 * 360) / w) * DEG
  const cosOuter = Math.cos(discRadius)
  const cosInner = Math.cos(discRadius * 0.55)
  const sr = sun.color.r
  const sg = sun.color.g
  const sb = sun.color.b

  const cosPhi = new Float32Array(w)
  const sinPhi = new Float32Array(w)
  for (let i = 0; i < w; i++) {
    const phi = ((i + 0.5) / w - 0.5) * Math.PI * 2
    cosPhi[i] = Math.cos(phi)
    sinPhi[i] = Math.sin(phi)
  }
  const hz = [0, 0, 0]
  for (let j = 0; j < h; j++) {
    const theta = ((j + 0.5) / h - 0.5) * Math.PI
    const dy = Math.sin(theta)
    const ct = Math.cos(theta)
    const up = dy > 0 ? Math.pow(dy, 0.5) : 0
    const below = dy < 0 ? smoothstep(0, -0.12, dy) : 0
    for (let i = 0; i < w; i++) {
      const dx = ct * cosPhi[i]
      const dz = ct * sinPhi[i]
      // warm horizon only on the sun's side of the sky
      const side = 0.5 + 0.5 * (cosPhi[i] * sunAx + sinPhi[i] * sunAz)
      mix3(horizonCool, horizonWarm, sun.warmth * side * side, hz)
      let r = hz[0] + (zenith[0] - hz[0]) * up
      let g = hz[1] + (zenith[1] - hz[1]) * up
      let b = hz[2] + (zenith[2] - hz[2]) * up
      if (below > 0) {
        r += (ground[0] - r) * below
        g += (ground[1] - g) * below
        b += (ground[2] - b) * below
      }
      if (sunVisible > 0 && dy > -0.03) {
        const c = dx * sd.x + dy * sd.y + dz * sd.z
        if (c > 0) {
          const c2 = c * c
          const c8 = c2 * c2 * c2 * c2
          const c64 = c8 * c8 * c8 * c8 * c8 * c8 * c8 * c8
          const glow = (0.1 * c8 + 0.55 * c64 + 22 * smoothstep(cosOuter, cosInner, c)) * sunVisible
          r += sr * glow
          g += sg * glow
          b += sb * glow
        }
      }
      const o = (j * w + i) * 4
      data[o] = toHalf(r)
      data[o + 1] = toHalf(g)
      data[o + 2] = toHalf(b)
      data[o + 3] = one
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.LinearSRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.name = 'doplan-sky'
  tex.needsUpdate = true
  return tex
}

/** Mean colour of an HDR equirect (normalised to luminance 1); white when it cannot be read. */
function averageTint(tex: THREE.Texture, target: THREE.Color): THREE.Color {
  target.setRGB(1, 1, 1)
  const img = tex.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined
  const data = img?.data
  if (!data || !img?.width || !img?.height) return target
  const channels = Math.round(data.length / (img.width * img.height))
  if (channels < 3) return target
  const half = tex.type === THREE.HalfFloatType
  const step = Math.max(1, Math.floor((img.width * img.height) / 4096))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let p = 0; p < img.width * img.height; p += step) {
    const o = p * channels
    let cr = data[o]
    let cg = data[o + 1]
    let cb = data[o + 2]
    if (half) {
      cr = THREE.DataUtils.fromHalfFloat(cr)
      cg = THREE.DataUtils.fromHalfFloat(cg)
      cb = THREE.DataUtils.fromHalfFloat(cb)
    }
    // clamp the sun so one pixel cannot decide the tint
    r += Math.min(cr, 4)
    g += Math.min(cg, 4)
    b += Math.min(cb, 4)
    n++
  }
  if (n === 0) return target
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n
  if (!(lum > 1e-5)) return target
  return target.setRGB(mix(1, r / n / lum, 0.6), mix(1, g / n / lum, 0.6), mix(1, b / n / lum, 0.6))
}

// ───────────────────────────── HDRI loading ─────────────────────────────

/** HDRIs by URL, shared by the engines alive at once; emptied when the last of them closes */
const hdriCache = new Map<string, Promise<THREE.DataTexture>>()
let liveRigs = 0

function loadHdri(src: string): Promise<THREE.DataTexture> {
  let p = hdriCache.get(src)
  if (p) return p
  const isExr = /\.exr(\?|#|$)/i.test(src)
  p = (async () => {
    let tex: THREE.DataTexture
    if (isExr) {
      const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js')
      tex = (await new EXRLoader().loadAsync(src)) as THREE.DataTexture
    } else {
      tex = (await new HDRLoader().loadAsync(src)) as THREE.DataTexture
    }
    tex.mapping = THREE.EquirectangularReflectionMapping
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.name = 'doplan-hdri'
    tex.needsUpdate = true
    return tex
  })()
  p.catch(() => hdriCache.delete(src))
  hdriCache.set(src, p)
  return p
}

// ───────────────────────────── window portals ─────────────────────────────

const PORTAL_KINDS = new Set<Opening['kind']>(['window', 'frenchWindow', 'balconyDoor', 'balconyBlock'])

interface PortalSpec {
  key: string
  /** world metres */
  position: [number, number, number]
  /** unit vector pointing into the room (world XZ) */
  inward: [number, number]
  width: number
  height: number
  /** split between the two faces when the wall has rooms on both sides */
  share: number
}

function collectPortals(doc: Doc, levelId: Id, plan: DerivedPlan | undefined, max: number): PortalSpec[] {
  if (!plan || max <= 0) return []
  const out: PortalSpec[] = []
  const rooms = plan.rooms
  const insideAnyRoom = (x: number, y: number): boolean => {
    for (const room of rooms) {
      if (pointInPolygon({ x, y }, room.polygon)) return true
    }
    return false
  }
  const push = (wall: Wall, geom: WallGeom, key: string, along: number, widthMm: number, sillMm: number, heightMm: number): void => {
    if (!(geom.length > 1) || widthMm < 200 || heightMm < 200) return
    const dx = (geom.b.x - geom.a.x) / geom.length
    const dy = (geom.b.y - geom.a.y) / geom.length
    const cx = geom.a.x + dx * along
    const cy = geom.a.y + dy * along
    // left normal on the plan (y down): (dy, −dx)
    const nx = dy
    const ny = -dx
    const probe = wall.thickness / 2 + 160
    const leftIn = insideAnyRoom(cx + nx * probe, cy + ny * probe)
    const rightIn = insideAnyRoom(cx - nx * probe, cy - ny * probe)
    const sides: number[] = leftIn && rightIn ? [1, -1] : leftIn ? [1] : rightIn ? [-1] : rooms.length === 0 ? [1, -1] : []
    const off = wall.thickness / 2 + 70
    for (const s of sides) {
      const p = toWorld(cx + nx * s * off, cy + ny * s * off, sillMm + heightMm / 2)
      out.push({
        key: `${key}:${s}`,
        position: p,
        inward: [nx * s, ny * s],
        width: Math.max(0.2, widthMm / 1000 - 0.08),
        height: Math.max(0.2, heightMm / 1000 - 0.08),
        share: sides.length === 2 ? 0.6 : 1,
      })
    }
  }
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (!PORTAL_KINDS.has(o.kind)) continue
    const wall = doc.walls[o.wallId]
    if (!wall || wall.levelId !== levelId) continue
    const geom = plan.wallGeoms[wall.id]
    if (!geom) continue
    push(wall, geom, o.id, o.offset, o.width, o.sill, o.height)
  }
  for (const id in doc.walls) {
    const wall = doc.walls[id]
    if (wall.levelId !== levelId || wall.kind !== 'glazing') continue
    const geom = plan.wallGeoms[wall.id]
    if (!geom) continue
    push(wall, geom, wall.id, geom.length / 2, geom.length, 150, Math.max(400, wall.height - 300))
  }
  out.sort((a, b) => b.width * b.height - a.width * a.height)
  return out.slice(0, max)
}

/**
 * The environment's light on a surface facing each axis (+x −x +y −y +z −z): the irradiance the
 * equirectangular image gives, rotated as the scene rotates it, times `scale`. An even sky of the
 * fallback colour when the image has no pixels on the CPU.
 */
function ambientCube(tex: THREE.Texture | null, rotY: number, scale: number, fallback: THREE.Color): [RGB, RGB, RGB, RGB, RGB, RGB] {
  const out: [RGB, RGB, RGB, RGB, RGB, RGB] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const img = tex?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined
  const data = img?.data
  const w = img?.width ?? 0
  const h = img?.height ?? 0
  const channels = data && w && h ? Math.round(data.length / (w * h)) : 0
  if (!data || channels < 3) {
    // E = π L on every side
    for (const c of out) {
      c[0] = Math.PI * fallback.r * scale
      c[1] = Math.PI * fallback.g * scale
      c[2] = Math.PI * fallback.b * scale
    }
    return out
  }
  const half = tex?.type === THREE.HalfFloatType
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 8192)))
  const cr = Math.cos(rotY)
  const sr = Math.sin(rotY)
  let total = 0
  for (let y = 0; y < h; y += step) {
    const lat = ((y + 0.5) / h - 0.5) * Math.PI
    const cl = Math.cos(lat)
    const dy = Math.sin(lat)
    for (let x = 0; x < w; x += step) {
      const lon = ((x + 0.5) / w - 0.5) * 2 * Math.PI
      const lx = cl * Math.cos(lon)
      const lz = cl * Math.sin(lon)
      const dx = lx * cr + lz * sr
      const dz = -lx * sr + lz * cr
      const o = (y * w + x) * channels
      let r = data[o]
      let g = data[o + 1]
      let b = data[o + 2]
      if (half) {
        r = THREE.DataUtils.fromHalfFloat(r)
        g = THREE.DataUtils.fromHalfFloat(g)
        b = THREE.DataUtils.fromHalfFloat(b)
      }
      // the sun is its own light: its disc must not count twice
      r = Math.min(r, 8)
      g = Math.min(g, 8)
      b = Math.min(b, 8)
      total += cl
      const axes = [dx, -dx, dy, -dy, dz, -dz]
      for (let a = 0; a < 6; a++) {
        const c = axes[a]
        if (c <= 0) continue
        out[a][0] += r * c * cl
        out[a][1] += g * c * cl
        out[a][2] += b * c * cl
      }
    }
  }
  // Σ L cosθ dΩ, dΩ = 4π cl / Σ cl
  const norm = total > 0 ? (4 * Math.PI * scale) / total : 0
  for (const c of out) {
    c[0] *= norm
    c[1] *= norm
    c[2] *= norm
  }
  return out
}

// ───────────────────────────── fixtures ─────────────────────────────

interface FixtureGeoms {
  disc: THREE.BufferGeometry
  bulb: THREE.BufferGeometry
  shade: THREE.BufferGeometry
  cord: THREE.BufferGeometry
  can: THREE.BufferGeometry
  lens: THREE.BufferGeometry
  box: THREE.BufferGeometry
}

function createFixtureGeoms(): FixtureGeoms {
  return {
    disc: new THREE.CylinderGeometry(0.16, 0.17, 0.035, 32),
    bulb: new THREE.SphereGeometry(0.045, 20, 14),
    shade: new THREE.SphereGeometry(0.12, 28, 18),
    cord: new THREE.CylinderGeometry(0.004, 0.004, 1, 6),
    can: new THREE.CylinderGeometry(0.045, 0.05, 0.06, 20),
    lens: new THREE.CylinderGeometry(0.036, 0.036, 0.006, 20),
    box: new THREE.BoxGeometry(1, 1, 1),
  }
}

const SPOT_HALF = 38 * DEG

function panelSize(l: Light): { w: number; d: number } {
  return {
    w: Math.max(0.03, (l.size?.w ?? (l.kind === 'strip' ? 1000 : 600)) / 1000),
    d: Math.max(0.01, (l.size?.d ?? (l.kind === 'strip' ? 40 : 600)) / 1000),
  }
}

/** straight down, or tilted 30° from the vertical towards the plan direction `rotation` (0 = +x, clockwise) */
function spotDirection(l: Light, out: THREE.Vector3): THREE.Vector3 {
  if (l.rotation === undefined || l.rotation === null) return out.set(0, -1, 0)
  const a = l.rotation * DEG
  const tilt = 30 * DEG
  return out.set(Math.cos(a) * Math.sin(tilt), -Math.cos(tilt), Math.sin(a) * Math.sin(tilt))
}

function lightSignature(l: Light): string {
  return [l.id, l.kind, l.x, l.y, l.elevation, l.temperature, l.lumens, l.on ? 1 : 0, l.rotation ?? '', l.size?.w ?? '', l.size?.d ?? ''].join(',')
}

// ───────────────────────────── the rig ─────────────────────────────

export function createLighting(ctx: EngineContext): LightingRig {
  liveRigs++
  const renderer = ctx.renderer
  const scene = ctx.scene
  const shared = getShared(ctx)
  ensureAreaLightLib()

  const rig = new THREE.Group()
  rig.name = 'doplan-light-rig'
  rig.userData.helper = true
  scene.add(rig)

  const sun = new THREE.DirectionalLight(0xffffff, 0)
  sun.name = 'doplan-sun'
  sun.castShadow = false
  // the shadow maps are drawn again only when something that casts moved (refreshShadows), not
  // every frame: orbiting a still scene costs no shadow pass
  sun.shadow.autoUpdate = false
  rig.add(sun)
  rig.add(sun.target)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8478, 0)
  hemi.name = 'doplan-hemisphere'
  rig.add(hemi)

  const portalGroup = new THREE.Group()
  portalGroup.name = 'doplan-window-portals'
  rig.add(portalGroup)

  // ── live lamp slots ──
  // Every lit material's shader is built for the set of lights in the scene (each light, its kind
  // and whether it casts a shadow): a light added, removed, hidden or switched to casting compiles
  // every material again — a pause of seconds on a weak device. So the lamps are a pool that only
  // grows: a lamp turned off, moved or left out (the baked light shows) just gets no intensity.
  type SlotKind = 'point' | 'spot' | 'area'
  type SlotLight = THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight
  interface Slot {
    light: SlotLight
    casts: boolean
  }
  interface LampSpec {
    kind: SlotKind
    casts: boolean
    position: THREE.Vector3
    color: THREE.Color
    intensity: number
    /** spot: unit direction; area: rotation about Y */
    direction?: THREE.Vector3
    rotationY?: number
    width?: number
    depth?: number
  }
  const slotGroup = new THREE.Group()
  slotGroup.name = 'doplan-lamp-slots'
  rig.add(slotGroup)
  const slots: Record<SlotKind, Slot[]> = { point: [], spot: [], area: [] }

  const geoms = createFixtureGeoms()
  const fixtureMaterials = new Map<string, THREE.MeshStandardMaterial>()
  const housingMaterial = new THREE.MeshStandardMaterial({ color: 0xd9d9d6, roughness: 0.55, metalness: 0.1 })
  const cordMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 })
  const fixtureGroups = new Map<Id, THREE.Group>()

  let disposed = false
  let skyTexture: THREE.DataTexture | null = null
  let skySig = ''
  let envSig = ''
  let hdriToken = 0
  let hdriTexture: THREE.DataTexture | null = null
  let hdriSrc = ''
  let hdriFailed = ''
  /** the HDRI file on its way (settles either way) */
  let hdriLoading: Promise<unknown> | null = null
  const hdriTint = new THREE.Color(1, 1, 1)
  let portalSig = ''
  let fixtureSig = ''
  let lampsSig = ''
  let shadowSig = ''
  let shadowTypeApplied: number | null = null
  let scheduled = 0

  const tmpColor = new THREE.Color()
  const tmpV = new THREE.Vector3()
  const tmpBox = new THREE.Box3()
  const tmpSphere = new THREE.Sphere()
  const fitCam = new THREE.OrthographicCamera()

  // ── tone mapping ──
  function applyToneMapping(r: RenderSettings): boolean {
    const mode = r.toneMapping === 'aces' ? THREE.ACESFilmicToneMapping : r.toneMapping === 'agx' ? THREE.AgXToneMapping : THREE.NeutralToneMapping
    const exposure = clamp(r.exposure ?? 1, 0.02, 16)
    let changed = false
    if (renderer.toneMapping !== mode) {
      renderer.toneMapping = mode
      changed = true
    }
    if (renderer.toneMappingExposure !== exposure) {
      renderer.toneMappingExposure = exposure
      changed = true
    }
    return changed
  }

  // ── shadows ──
  function applyShadowType(q: QualitySettings): void {
    const type = q.shadowType === 'vsm' ? THREE.VSMShadowMap : q.shadowType === 'basic' ? THREE.BasicShadowMap : THREE.PCFShadowMap
    if (!renderer.shadowMap) return
    if (renderer.shadowMap.enabled !== true) renderer.shadowMap.enabled = true
    if (shadowTypeApplied !== type) {
      renderer.shadowMap.type = type
      shadowTypeApplied = type
    }
  }

  function setShadowMapSize(light: THREE.Light & { shadow?: any }, size: number): void {
    const shadow = light.shadow
    if (!shadow) return
    if (shadow.mapSize.x !== size || shadow.mapSize.y !== size) {
      shadow.mapSize.set(size, size)
      if (shadow.map) {
        shadow.map.dispose()
        shadow.map = null
      }
    }
  }

  function fitSunShadow(s: SunState, q: QualitySettings): boolean {
    const bounds = ctx.getBounds()
    tmpBox.copy(bounds)
    if (tmpBox.isEmpty() || !Number.isFinite(tmpBox.min.x) || !Number.isFinite(tmpBox.max.x)) {
      tmpBox.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5))
    }
    tmpBox.expandByScalar(0.6)
    tmpBox.min.y = Math.min(tmpBox.min.y, -0.3)
    const sig = [
      tmpBox.min.x.toFixed(2), tmpBox.min.y.toFixed(2), tmpBox.min.z.toFixed(2),
      tmpBox.max.x.toFixed(2), tmpBox.max.y.toFixed(2), tmpBox.max.z.toFixed(2),
      s.direction.x.toFixed(4), s.direction.y.toFixed(4), s.direction.z.toFixed(4),
      q.shadowMapSize, q.shadowRadius, q.sunShadows ? 1 : 0, shared.baked ? 1 : 0,
    ].join(',')
    if (sig === shadowSig) return false
    shadowSig = sig

    tmpBox.getBoundingSphere(tmpSphere)
    const centre = tmpSphere.center
    const dir = tmpV.copy(s.direction)
    // a perfectly vertical light makes lookAt() degenerate
    if (Math.abs(dir.y) > 0.9995) dir.set(0.02, dir.y, 0.02).normalize()
    // keep the light above the horizon for the shadow frustum even when the sun has set
    if (dir.y < 0.02) dir.setY(0.02).normalize()
    sun.position.copy(centre).addScaledVector(dir, tmpSphere.radius + 6)
    sun.target.position.copy(centre)
    sun.updateMatrixWorld(true)
    sun.target.updateMatrixWorld(true)

    // not tied to the sun's height: a sun that sets would change the light set (a recompile); the
    // baked light holds the shadows of the walls itself, the furniture goes without
    const casts = q.sunShadows && !shared.baked
    sun.castShadow = casts
    if (casts) {
      setShadowMapSize(sun, q.shadowMapSize)
      fitCam.position.copy(sun.position)
      fitCam.up.set(0, 1, 0)
      fitCam.lookAt(centre)
      fitCam.updateMatrixWorld(true)
      const inv = fitCam.matrixWorldInverse.copy(fitCam.matrixWorld).invert()
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      for (let i = 0; i < 8; i++) {
        tmpV.set(i & 1 ? tmpBox.max.x : tmpBox.min.x, i & 2 ? tmpBox.max.y : tmpBox.min.y, i & 4 ? tmpBox.max.z : tmpBox.min.z).applyMatrix4(inv)
        minX = Math.min(minX, tmpV.x)
        maxX = Math.max(maxX, tmpV.x)
        minY = Math.min(minY, tmpV.y)
        maxY = Math.max(maxY, tmpV.y)
        minZ = Math.min(minZ, tmpV.z)
        maxZ = Math.max(maxZ, tmpV.z)
      }
      const cam = sun.shadow.camera
      cam.left = minX
      cam.right = maxX
      cam.bottom = minY
      cam.top = maxY
      cam.near = Math.max(0.1, -maxZ - 1)
      cam.far = -minZ + 1
      cam.updateProjectionMatrix()
      const texel = Math.max(maxX - minX, maxY - minY) / q.shadowMapSize
      sun.shadow.bias = -0.0003
      sun.shadow.normalBias = clamp(texel * 2.5, 0.012, 0.07)
      sun.shadow.radius = q.shadowRadius
      sun.shadow.needsUpdate = true
    }
    return true
  }

  // ── sky / environment ──
  function applyEnvironmentLevels(r: RenderSettings, usingHdri: boolean): void {
    const k = clamp(r.hdriIntensity ?? 1, 0, 8)
    scene.backgroundIntensity = k
    scene.environmentIntensity = ENV_RASTER * k
    const rot = usingHdri ? (r.hdriRotation || 0) * DEG : 0
    scene.backgroundRotation.set(0, rot, 0)
    scene.environmentRotation.set(0, rot, 0)
    scene.backgroundBlurriness = 0
  }

  function setEnvironmentTexture(tex: THREE.Texture | null): void {
    if (scene.background !== tex) scene.background = tex
    if (scene.environment !== tex) scene.environment = tex
  }

  function useProceduralSky(s: SunState, q: QualitySettings): boolean {
    const sig = [q.skyWidth, s.direction.x.toFixed(3), s.direction.y.toFixed(3), s.direction.z.toFixed(3), s.day.toFixed(3), s.warmth.toFixed(3)].join(',')
    if (sig === skySig && skyTexture && scene.environment === skyTexture) return false
    const old = skyTexture
    skyTexture = buildSkyTexture(q.skyWidth, s)
    skySig = sig
    setEnvironmentTexture(skyTexture)
    if (old && old !== skyTexture) old.dispose()
    return true
  }

  function syncEnvironment(r: RenderSettings, s: SunState, q: QualitySettings): boolean {
    const hdri = r.hdriId ? uiStore.getState().getHdri(r.hdriId) : undefined
    const src = hdri?.src ?? ''
    let changed = false
    if (src && src !== hdriFailed) {
      if (src === hdriSrc && hdriTexture) {
        if (scene.environment !== hdriTexture) {
          setEnvironmentTexture(hdriTexture)
          changed = true
        }
      } else if (src !== hdriSrc) {
        hdriSrc = src
        hdriTexture = null
        const token = ++hdriToken
        // show the procedural sky until the file arrives
        changed = useProceduralSky(s, q) || changed
        const loading = loadHdri(src)
        hdriLoading = loading.then(
          () => undefined,
          () => undefined,
        )
        loading.then(
          (tex) => {
            if (disposed || token !== hdriToken) return
            hdriTexture = tex
            averageTint(tex, hdriTint)
            envSig = ''
            requestSync()
          },
          (err) => {
            if (disposed || token !== hdriToken) return
            console.warn('[lighting] HDRI load failed', src, err)
            hdriFailed = src
            hdriSrc = ''
            uiStore.getState().set({ hint: t('Не удалось загрузить HDRI-окружение, используется процедурное небо') })
            requestSync()
          },
        )
      } else {
        // still loading
        changed = useProceduralSky(s, q) || changed
      }
    } else {
      if (hdriSrc || hdriTexture) {
        hdriToken++
        hdriSrc = ''
        hdriTexture = null
      }
      changed = useProceduralSky(s, q) || changed
    }
    const usingHdri = !!hdriTexture && scene.environment === hdriTexture
    if (usingHdri && skyTexture) {
      skyTexture.dispose()
      skyTexture = null
      skySig = ''
    }
    const sig = [usingHdri ? hdriSrc : 'sky', r.hdriIntensity, r.hdriRotation].join('|')
    if (sig !== envSig) {
      envSig = sig
      applyEnvironmentLevels(r, usingHdri)
      changed = true
    }
    return changed
  }

  // ── fill lights ──
  function syncFill(r: RenderSettings, s: SunState, usingHdri: boolean): void {
    const k = clamp(r.hdriIntensity ?? 1, 0, 8)
    const day = usingHdri ? 1 : s.day
    if (usingHdri) tmpColor.copy(hdriTint)
    else skyTint(s, tmpColor)
    hemi.color.copy(tmpColor)
    hemi.groundColor.setRGB(0.42, 0.4, 0.37).multiplyScalar(0.6 + 0.4 * day)
    hemi.intensity = (HEMI_NIGHT + (HEMI_DAY - HEMI_NIGHT) * day) * Math.max(0.15, k)
    const radiance = PORTAL_RADIANCE * day * k
    for (const child of portalGroup.children) {
      const light = child as THREE.RectAreaLight
      light.color.copy(tmpColor)
      // an unused portal stays in the scene, dark (see the lamp slots)
      light.intensity = radiance * (light.userData.share ?? 1)
    }
  }

  /** whether a portal light was added (the light set changed) */
  function syncPortals(doc: Doc, levelId: Id, plan: DerivedPlan | undefined, q: QualitySettings): boolean {
    const max = shared.baked ? Math.min(q.maxPortals, BAKED_LIGHTS.portals) : q.maxPortals
    const specs = collectPortals(doc, levelId, plan, max)
    const sig = specs
      .map((p) => `${p.key}@${p.position.map((v) => v.toFixed(3)).join(',')}/${p.inward[0].toFixed(3)},${p.inward[1].toFixed(3)}/${p.width.toFixed(3)}x${p.height.toFixed(3)}/${p.share}`)
      .join(';')
    if (sig === portalSig) return false
    portalSig = sig
    let added = false
    for (let i = specs.length; i < portalGroup.children.length; i++) portalGroup.children[i].userData.share = 0
    specs.forEach((p, i) => {
      let light = portalGroup.children[i] as THREE.RectAreaLight | undefined
      if (!light) {
        light = new THREE.RectAreaLight(0xffffff, 0, 1, 1)
        light.name = 'doplan-window-portal'
        portalGroup.add(light)
        added = true
      }
      light.width = p.width
      light.height = p.height
      light.position.set(p.position[0], p.position[1], p.position[2])
      // lights "look" along −Z like cameras: aim at a point further inside the room
      light.lookAt(p.position[0] + p.inward[0], p.position[1], p.position[2] + p.inward[1])
      light.userData.share = p.share
      light.updateMatrixWorld(true)
    })
    return added
  }

  // ── fixtures ──
  function emissiveMaterial(kelvin: number, on: boolean): THREE.MeshStandardMaterial {
    const key = `${Math.round(kelvin / 100)}:${on ? 1 : 0}`
    let m = fixtureMaterials.get(key)
    if (!m) {
      const c = kelvinToColor(kelvin)
      m = new THREE.MeshStandardMaterial({
        color: on ? 0xffffff : 0xe6e6e2,
        emissive: on ? c : new THREE.Color(0, 0, 0),
        emissiveIntensity: on ? 4 : 0,
        roughness: 0.5,
        metalness: 0,
      })
      m.name = `fixture-${key}`
      fixtureMaterials.set(key, m)
    }
    return m
  }

  function fixtureMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  function disposeFixtureGroup(group: THREE.Group): void {
    group.removeFromParent()
  }

  /** the body of a fixture: meshes only, its light lives in a slot (see the lamp slots) */
  function buildFixture(l: Light, on: boolean, ceilingMm: number): THREE.Group {
    const group = new THREE.Group()
    group.name = `light:${l.id}`
    group.userData.ref = { kind: 'light', id: l.id }
    group.userData.isLightFixture = true
    const p = toWorld(l.x, l.y, l.elevation)
    group.position.set(p[0], p[1], p[2])
    const glow = emissiveMaterial(l.temperature, on)

    if (l.kind === 'strip' || l.kind === 'area') {
      const { w, d } = panelSize(l)
      group.rotation.y = -((l.rotation ?? 0) * DEG)
      const body = fixtureMesh(geoms.box, glow)
      body.scale.set(w, 0.014, d)
      body.position.y = -0.007
      group.add(body)
    } else if (l.kind === 'spot') {
      const can = fixtureMesh(geoms.can, housingMaterial)
      can.position.y = -0.03
      group.add(can)
      const lens = fixtureMesh(geoms.lens, glow)
      lens.position.y = -0.062
      group.add(lens)
      if (l.rotation !== undefined && l.rotation !== null) {
        const dir = spotDirection(l, new THREE.Vector3())
        const q4 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir)
        can.quaternion.copy(q4)
        lens.quaternion.copy(q4)
        lens.position.copy(dir).multiplyScalar(0.062)
        can.position.copy(dir).multiplyScalar(0.03)
      }
    } else if (l.kind === 'ceiling') {
      const disc = fixtureMesh(geoms.disc, glow)
      disc.position.y = -0.0175
      group.add(disc)
    } else if (l.kind === 'pendant') {
      group.add(fixtureMesh(geoms.shade, glow))
      const cordLen = Math.max(0, (ceilingMm - l.elevation) / 1000 - 0.11)
      if (cordLen > 0.02) {
        const cord = fixtureMesh(geoms.cord, cordMaterial)
        cord.scale.y = cordLen
        cord.position.y = 0.11 + cordLen / 2
        group.add(cord)
      }
    } else {
      group.add(fixtureMesh(geoms.bulb, glow))
    }
    return group
  }

  /** the live light of a fixture (the same numbers the bake uses) */
  function lampSpec(l: Light, casts: boolean): LampSpec {
    const p = toWorld(l.x, l.y, l.elevation)
    const color = kelvinToColor(l.temperature)
    const lumens = Math.max(0, l.lumens || 0)
    if (l.kind === 'strip' || l.kind === 'area') {
      const { w, d } = panelSize(l)
      const nits = lumens / (Math.PI * w * d)
      // keep very thin strips from producing absurd radiance values
      return { kind: 'area', casts: false, position: new THREE.Vector3(p[0], p[1] - 0.02, p[2]), color, intensity: Math.min(nits * LUMEN_SCALE, 4000), rotationY: -((l.rotation ?? 0) * DEG), width: w, depth: d }
    }
    if (l.kind === 'spot') {
      const candela = lumens / (2 * Math.PI * (1 - Math.cos(SPOT_HALF)))
      return { kind: 'spot', casts, position: new THREE.Vector3(p[0], p[1] - 0.07, p[2]), color, intensity: candela * LUMEN_SCALE * SPOT_SCALE, direction: spotDirection(l, new THREE.Vector3()) }
    }
    // a flush ceiling fixture radiates into the lower hemisphere only
    const candela = l.kind === 'ceiling' ? lumens / (2 * Math.PI) : lumens / (4 * Math.PI)
    return { kind: 'point', casts, position: new THREE.Vector3(p[0], p[1] + (l.kind === 'ceiling' ? -0.1 : 0), p[2]), color, intensity: candela * LUMEN_SCALE }
  }

  function createSlot(kind: SlotKind, casts: boolean, q: QualitySettings): Slot {
    let light: SlotLight
    if (kind === 'area') light = new THREE.RectAreaLight(0xffffff, 0, 1, 1)
    else if (kind === 'spot') {
      const spot = new THREE.SpotLight(0xffffff, 0, 14, SPOT_HALF, 0.55, 2)
      slotGroup.add(spot.target)
      light = spot
    } else light = new THREE.PointLight(0xffffff, 0, 16, 2)
    light.name = `lamp-slot:${kind}${casts ? ':shadow' : ''}`
    if (casts && kind !== 'area') {
      const l = light as THREE.PointLight | THREE.SpotLight
      l.castShadow = true
      setShadowMapSize(l, q.fixtureShadowMapSize)
      l.shadow.bias = kind === 'point' ? -0.004 : -0.0015
      l.shadow.normalBias = 0.03
      l.shadow.radius = 2
      l.shadow.camera.near = 0.08
      l.shadow.camera.far = 14
      l.shadow.camera.updateProjectionMatrix()
      l.shadow.autoUpdate = false
      l.shadow.needsUpdate = true
    }
    slotGroup.add(light)
    return { light, casts }
  }

  function disposeSlots(which: (s: Slot) => boolean): void {
    for (const kind of Object.keys(slots) as SlotKind[]) {
      slots[kind] = slots[kind].filter((slot) => {
        if (!which(slot)) return true
        const l = slot.light as SlotLight & { shadow?: any }
        if (l.shadow?.map) {
          l.shadow.map.dispose()
          l.shadow.map = null
        }
        if ((l as THREE.SpotLight).isSpotLight) (l as THREE.SpotLight).target.removeFromParent()
        l.removeFromParent()
        l.dispose()
        return false
      })
    }
  }

  /** puts the lamps into the slots; whether a slot was added (the light set changed) */
  function assignSlots(specs: LampSpec[], q: QualitySettings): boolean {
    let added = false
    const used = new Set<Slot>()
    for (const spec of specs) {
      let slot = slots[spec.kind].find((s) => s.casts === spec.casts && !used.has(s))
      if (!slot) {
        slot = createSlot(spec.kind, spec.casts, q)
        slots[spec.kind].push(slot)
        added = true
      }
      used.add(slot)
      const light = slot.light
      light.color.copy(spec.color)
      light.intensity = spec.intensity
      light.position.copy(spec.position)
      if (spec.kind === 'spot') {
        const spot = light as THREE.SpotLight
        spot.target.position.copy(spec.position).add(spec.direction!)
        spot.target.updateMatrixWorld(true)
      } else if (spec.kind === 'area') {
        const area = light as THREE.RectAreaLight
        area.width = spec.width!
        area.height = spec.depth!
        area.rotation.set(-Math.PI / 2, spec.rotationY ?? 0, 0, 'YXZ')
      }
      light.updateMatrixWorld(true)
    }
    for (const kind of Object.keys(slots) as SlotKind[]) for (const slot of slots[kind]) if (!used.has(slot)) slot.light.intensity = 0
    return added
  }

  /** draws the shadow maps again on the next frame (they are kept while nothing moves) */
  function refreshShadows(): void {
    if (sun.castShadow) sun.shadow.needsUpdate = true
    for (const kind of Object.keys(slots) as SlotKind[])
      for (const slot of slots[kind]) if (slot.casts) (slot.light as THREE.PointLight | THREE.SpotLight).shadow.needsUpdate = true
  }

  /** whether the scene changed; `structure` when a light was added (every lit material compiles again) */
  function syncFixtures(doc: Doc, levelId: Id, q: QualitySettings): { changed: boolean; structure: boolean } {
    const list: Light[] = []
    for (const id in doc.lights) {
      const l = doc.lights[id]
      if (l.levelId === levelId) list.push(l)
    }
    const globalOn = doc.render.lightsOn !== false
    const ceilingMm = doc.levels[levelId]?.height ?? doc.settings.wallHeight ?? 2700
    const root = ctx.roots.lights
    // the engine may have emptied the root while rebuilding the scene
    let detached = false
    for (const g of fixtureGroups.values()) {
      if (g.parent !== root) {
        detached = true
        break
      }
    }
    const sig = list.map(lightSignature).sort().join(';') + `#${globalOn ? 1 : 0}#${ceilingMm}`
    let changed = false
    if (sig !== fixtureSig || detached) {
      fixtureSig = sig
      changed = true
      for (const g of fixtureGroups.values()) disposeFixtureGroup(g)
      fixtureGroups.clear()
      for (const l of list) {
        const group = buildFixture(l, globalOn && l.on, ceilingMm)
        fixtureGroups.set(l.id, group)
        root.add(group)
      }
      root.updateMatrixWorld(true)
    }

    // the live lamps: the brightest ones; under the baked light only a couple, for the furniture
    const maxLive = shared.baked ? Math.min(q.maxLights, BAKED_LIGHTS.lamps) : q.maxLights
    const maxShadows = shared.baked ? 0 : q.maxShadowLights
    const byPower = list.filter((l) => globalOn && l.on && l.lumens > 0).sort((x, y) => y.lumens - x.lumens || (x.id < y.id ? -1 : 1))
    let shadows = 0
    const specs = byPower.slice(0, maxLive).map((l) => {
      const casts = shadows < maxShadows && l.kind !== 'strip' && l.kind !== 'area'
      if (casts) shadows++
      return lampSpec(l, casts)
    })
    const lampSig = specs
      .map((x) => `${x.kind}${x.casts ? '*' : ''}@${x.position.toArray().map((v) => v.toFixed(3))}/${x.color.getHexString()}/${x.intensity.toFixed(3)}/${x.direction?.toArray().map((v) => v.toFixed(3)) ?? ''}/${x.rotationY ?? ''}/${x.width ?? ''}x${x.depth ?? ''}`)
      .join(';')
    if (lampSig === lampsSig) return { changed, structure: false }
    lampsSig = lampSig
    const structure = assignSlots(specs, q)
    if (specs.some((x) => x.casts)) refreshShadows()
    return { changed: true, structure }
  }

  /**
   * The lights for a bake once the HDRI the document asks for is in place; null when it could not
   * be had (the procedural sky would be baked under the HDRI's name).
   */
  async function lightsForBake(): Promise<BakeLights | null> {
    sync()
    const end = Date.now() + 120000
    while (hdriLoading && hdriSrc && !hdriTexture && Date.now() < end) {
      const pending = hdriLoading
      await Promise.race([pending, new Promise((r) => setTimeout(r, 1000))])
      if (disposed) return null
      sync()
    }
    if (disposed) return null
    const r = docStore.getState().doc.render
    const wanted = r.hdriId ? (uiStore.getState().getHdri(r.hdriId)?.src ?? '') : ''
    if (wanted && !(hdriTexture && scene.environment === hdriTexture)) return null
    return bakeLights()
  }

  // ── for a bake: every light of the level, not only those the quality preset keeps live ──
  function bakeLights(): BakeLights {
    const doc = visibleDoc(docStore.getState().doc)
    const r = doc.render
    const active = uiStore.getState().activeLevelId
    const levelId = doc.levels[active] ? active : doc.levelOrder[0]
    const s = computeSun(r)
    const k = clamp(r.hdriIntensity ?? 1, 0, 8)
    const usingHdri = !!hdriTexture && scene.environment === hdriTexture
    const day = usingHdri ? 1 : s.day
    const tint = usingHdri ? hdriTint.clone() : skyTint(s, new THREE.Color())
    const out: BakeLights = { sun: null, points: [], areas: [], hemi: null, ambient: null, sky: null }
    if (s.intensity > 0)
      out.sun = { dir: [s.direction.x, s.direction.y, s.direction.z], color: [s.color.r * s.intensity, s.color.g * s.intensity, s.color.b * s.intensity], spread: 0.025 }
    out.hemi = { sky: [hemi.color.r, hemi.color.g, hemi.color.b], ground: [hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b], intensity: hemi.intensity }
    out.ambient = ambientCube(scene.environment as THREE.Texture | null, usingHdri ? (r.hdriRotation || 0) * DEG : 0, ENV_RASTER * k, tint)
    const radiance = PORTAL_RADIANCE * day * k
    if (radiance > 1e-4) out.sky = [tint.r * radiance, tint.g * radiance, tint.b * radiance]
    if (r.lightsOn === false) return out
    for (const id in doc.lights) {
      const l = doc.lights[id]
      const lumens = Math.max(0, l.lumens || 0)
      if (l.levelId !== levelId || !l.on || lumens <= 0) continue
      const p = toWorld(l.x, l.y, l.elevation)
      const c = kelvinToColor(l.temperature)
      if (l.kind === 'strip' || l.kind === 'area') {
        const w = Math.max(0.03, (l.size?.w ?? (l.kind === 'strip' ? 1000 : 600)) / 1000)
        const d = Math.max(0.01, (l.size?.d ?? (l.kind === 'strip' ? 40 : 600)) / 1000)
        const a = -((l.rotation ?? 0) * DEG)
        const nits = Math.min((lumens / (Math.PI * w * d)) * LUMEN_SCALE, 4000)
        out.areas.push({
          pos: [p[0], p[1] - 0.02, p[2]],
          hu: [(Math.cos(a) * w) / 2, 0, (-Math.sin(a) * w) / 2],
          hv: [(Math.sin(a) * d) / 2, 0, (Math.cos(a) * d) / 2],
          n: [0, -1, 0],
          color: [c.r * nits, c.g * nits, c.b * nits],
        })
      } else if (l.kind === 'spot') {
        const half = SPOT_HALF
        const I = (lumens / (2 * Math.PI * (1 - Math.cos(half)))) * LUMEN_SCALE * SPOT_SCALE
        const dir = spotDirection(l, tmpV).toArray() as [number, number, number]
        out.points.push({
          pos: [p[0], p[1] - 0.07, p[2]],
          color: [c.r * I, c.g * I, c.b * I],
          distance: 14,
          decay: 2,
          spot: { dir, cosOuter: Math.cos(half), cosInner: Math.cos(half * (1 - 0.55)) },
        })
      } else {
        const I = (l.kind === 'ceiling' ? lumens / (2 * Math.PI) : lumens / (4 * Math.PI)) * LUMEN_SCALE
        out.points.push({ pos: [p[0], p[1] + (l.kind === 'ceiling' ? -0.1 : 0), p[2]], color: [c.r * I, c.g * I, c.b * I], distance: 16, decay: 2 })
      }
    }
    return out
  }

  // ── main entry ──
  function sync(): void {
    if (disposed) return
    const state = docStore.getState()
    const doc = visibleDoc(state.doc)
    const r = doc.render
    const q = currentQuality(ctx)
    const ui = uiStore.getState()
    const levelId = doc.levels[ui.activeLevelId] ? ui.activeLevelId : doc.levelOrder[0]
    const fullPlan = state.derived[levelId]
    const plan = fullPlan && visiblePlan(state.doc, fullPlan)

    let changed = applyToneMapping(r)
    applyShadowType(q)

    const s = computeSun(r)
    if (sun.intensity !== s.intensity || !sun.color.equals(s.color)) {
      sun.intensity = s.intensity
      sun.color.copy(s.color)
      changed = true
    }
    changed = fitSunShadow(s, q) || changed

    let structure = false
    changed = syncEnvironment(r, s, q) || changed
    if (syncPortals(doc, levelId, plan, q)) {
      structure = true
      changed = true
    }
    const usingHdri = !!hdriTexture && scene.environment === hdriTexture
    const fillSig = `${hemi.intensity}|${hemi.color.getHex()}|${(portalGroup.children[0] as THREE.RectAreaLight | undefined)?.intensity ?? 0}`
    syncFill(r, s, usingHdri)
    if (fillSig !== `${hemi.intensity}|${hemi.color.getHex()}|${(portalGroup.children[0] as THREE.RectAreaLight | undefined)?.intensity ?? 0}`) changed = true

    const fixtures = syncFixtures(doc, levelId, q)
    if (fixtures.changed) changed = true
    if (fixtures.structure) structure = true

    if (changed) {
      shared.emitLightingChanged({ structure })
      shared.post?.kick()
      ctx.invalidate()
    }
  }

  function requestSync(): void {
    if (disposed || scheduled) return
    scheduled = requestAnimationFrame(() => {
      scheduled = 0
      sync()
    })
  }

  // ── subscriptions: the rig follows the document on its own; the engine may also call sync() ──
  let last = docStore.getState()
  const unsubDoc = docStore.subscribe((state) => {
    const a = state.doc
    const b = last.doc
    const relevant =
      a.render !== b.render ||
      a.lights !== b.lights ||
      a.openings !== b.openings ||
      a.walls !== b.walls ||
      a.nodes !== b.nodes ||
      a.rooms !== b.rooms ||
      a.levels !== b.levels ||
      a.groupFlags !== b.groupFlags ||
      a.layers !== b.layers ||
      state.derived !== last.derived
    last = state
    if (relevant) requestSync()
  })
  let lastUi = uiStore.getState()
  const unsubUi = uiStore.subscribe((state) => {
    const relevant = state.activeLevelId !== lastUi.activeLevelId || state.catalog !== lastUi.catalog
    lastUi = state
    if (relevant) requestSync()
  })
  const unsubScene = ctx.onSceneChanged(() => {
    // bounds may have moved and the lights root may have been emptied
    shadowSig = ''
    sync()
    // something that casts may have moved
    refreshShadows()
  })
  const unsubQuality = shared.onQualityChanged(() => {
    // new shadow map sizes and light counts: the pool starts over
    disposeSlots(() => true)
    shadowSig = ''
    lampsSig = ''
    sync()
  })
  const unsubBaked = shared.onBakedChanged(() => {
    // the baked light holds the shadows: the lamps that cast them go (one recompile per switch)
    if (shared.baked) disposeSlots((slot) => slot.casts)
    lampsSig = ''
    sync()
  })
  shared.bakeLights = lightsForBake
  shared.refreshShadows = refreshShadows

  return {
    sync,
    dispose() {
      if (disposed) return
      disposed = true
      if (scheduled) cancelAnimationFrame(scheduled)
      unsubDoc()
      unsubUi()
      unsubScene()
      unsubQuality()
      unsubBaked()
      if (shared.bakeLights === lightsForBake) shared.bakeLights = null
      if (shared.refreshShadows === refreshShadows) shared.refreshShadows = null
      hdriToken++
      for (const g of fixtureGroups.values()) disposeFixtureGroup(g)
      fixtureGroups.clear()
      disposeSlots(() => true)
      for (const m of fixtureMaterials.values()) m.dispose()
      fixtureMaterials.clear()
      housingMaterial.dispose()
      cordMaterial.dispose()
      for (const g of Object.values(geoms)) (g as THREE.BufferGeometry).dispose()
      for (const child of [...portalGroup.children]) (child as THREE.RectAreaLight).dispose()
      portalGroup.clear()
      if (sun.shadow?.map) {
        sun.shadow.map.dispose()
        ;(sun.shadow as any).map = null
      }
      sun.dispose()
      hemi.dispose()
      rig.removeFromParent()
      if (skyTexture) {
        if (scene.background === skyTexture) scene.background = null
        if (scene.environment === skyTexture) scene.environment = null
        skyTexture.dispose()
        skyTexture = null
      }
      if (hdriTexture) {
        if (scene.background === hdriTexture) scene.background = null
        if (scene.environment === hdriTexture) scene.environment = null
        hdriTexture = null
      }
      // the decoded HDRIs stay only while an engine may use them
      if (--liveRigs === 0) {
        for (const p of hdriCache.values()) void p.then((t) => t.dispose(), () => undefined)
        hdriCache.clear()
      }
    },
  }
}
