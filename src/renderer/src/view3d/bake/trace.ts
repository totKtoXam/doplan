/**
 * The light reaching each texel of the light map, traced on the CPU against the whole scene (walls,
 * ceilings, furniture) with three-mesh-bvh. The result is irradiance in three.js units: a white
 * Lambert surface lit by it looks as it would under the same lights, so a MeshBasic material with
 * this light map gives `albedo × value / π`, as the live lights would.
 *
 * Terms, close to what the live view draws:
 *  - sun: a directional light, softened over a small cone, with real shadows;
 *  - lamps: point / spot lights (three's distance and cone falloff) and panel lights, with shadows;
 *    the last 15 cm before a lamp do not block it (its own shade or housing);
 *  - sky through the windows: inside a room (something above it) the rays that leave the building
 *    see the sky at the brightness the live view gives its window light;
 *  - fill: the hemisphere light and the environment's even light, darkened where the surface is
 *    closed in (ambient occlusion within `aoRadius`).
 * Pure: no renderer, so it runs in workers and in tests.
 */
import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'

export type RGB = [number, number, number]

export interface BakeLights {
  sun: { dir: [number, number, number]; color: RGB; spread: number } | null
  points: {
    pos: [number, number, number]
    color: RGB
    distance: number
    decay: number
    spot?: { dir: [number, number, number]; cosOuter: number; cosInner: number }
  }[]
  /** panel lights: centre, half extents along the panel, facing `n`; `color` is radiance */
  areas: { pos: [number, number, number]; hu: [number, number, number]; hv: [number, number, number]; n: [number, number, number]; color: RGB }[]
  hemi: { sky: RGB; ground: RGB; intensity: number } | null
  /** the environment's even light per axis direction (+x −x +y −y +z −z), irradiance */
  ambient: [RGB, RGB, RGB, RGB, RGB, RGB] | null
  /** radiance of the sky seen through the openings from inside; null: no daylight */
  sky: RGB | null
}

export interface TraceOptions {
  /** rays over the hemisphere for sky and occlusion */
  skyRays: number
  /** rays toward the sun */
  sunRays: number
  /** rays per panel light */
  areaRays: number
  /** occlusion distance, metres */
  aoRadius: number
  /** texel size, metres (offsets and the "inside a wall" test) */
  texel: number
}

export const DEFAULT_TRACE: TraceOptions = { skyRays: 32, sunRays: 6, areaRays: 4, aoRadius: 0.7, texel: 0.05 }

/** a small fast generator, seeded per texel: the same scene bakes the same */
function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

const ray = new THREE.Ray()
const LAMP_CLEAR = 0.15

function hit(bvh: MeshBVH, o: THREE.Vector3, d: THREE.Vector3, far: number): THREE.Intersection | null {
  ray.origin.copy(o)
  ray.direction.copy(d)
  return bvh.raycastFirst(ray, THREE.DoubleSide, 0, far) as THREE.Intersection | null
}

function blocked(bvh: MeshBVH, o: THREE.Vector3, d: THREE.Vector3, far: number): boolean {
  return far > 0 && hit(bvh, o, d, far) !== null
}

/** three's punctual light falloff (physically based, with the range cut-off) */
export function distanceAttenuation(d: number, distance: number, decay: number): number {
  let a = 1 / Math.max(d ** decay, 0.01)
  if (distance > 0) {
    const k = Math.min(1, Math.max(0, 1 - (d / distance) ** 4))
    a *= k * k
  }
  return a
}

function smoothstep(a: number, b: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)))
  return k * k * (3 - 2 * k)
}

function ambientAt(cube: NonNullable<BakeLights['ambient']>, n: THREE.Vector3, out: RGB): void {
  const w = [Math.max(n.x, 0) ** 2, Math.max(-n.x, 0) ** 2, Math.max(n.y, 0) ** 2, Math.max(-n.y, 0) ** 2, Math.max(n.z, 0) ** 2, Math.max(-n.z, 0) ** 2]
  out[0] = out[1] = out[2] = 0
  for (let i = 0; i < 6; i++) {
    out[0] += cube[i][0] * w[i]
    out[1] += cube[i][1] * w[i]
    out[2] += cube[i][2] * w[i]
  }
}

export interface TraceResult {
  /** 3 numbers per texel */
  rgb: Float32Array
  /** 0: the texel lies inside or under something solid (filled from its neighbours later) */
  valid: Uint8Array
}

/**
 * Light for `points` (6 numbers per texel: position, normal). `onProgress` gets the share done.
 */
export function traceTexels(bvh: MeshBVH, points: Float32Array, lights: BakeLights, opts: TraceOptions = DEFAULT_TRACE, seedBase = 0, onProgress?: (k: number) => void): TraceResult {
  const n = points.length / 6
  const rgb = new Float32Array(n * 3)
  const valid = new Uint8Array(n)
  const p = new THREE.Vector3()
  const nn = new THREE.Vector3()
  const o = new THREE.Vector3()
  const d = new THREE.Vector3()
  const t1 = new THREE.Vector3()
  const t2 = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const amb: RGB = [0, 0, 0]
  const sunDir = lights.sun ? new THREE.Vector3(...lights.sun.dir).normalize() : null
  const sunU = new THREE.Vector3()
  const sunV = new THREE.Vector3()
  if (sunDir) {
    sunU.set(Math.abs(sunDir.y) < 0.9 ? 0 : 1, Math.abs(sunDir.y) < 0.9 ? 1 : 0, 0).cross(sunDir).normalize()
    sunV.crossVectors(sunDir, sunU)
  }
  const eps = Math.max(0.001, opts.texel * 0.05)
  const close = opts.texel * 0.75
  const step = Math.max(1, Math.floor(n / 50))

  for (let i = 0; i < n; i++) {
    const r = rng((i + seedBase) * 2654435761 + 1)
    p.set(points[i * 6], points[i * 6 + 1], points[i * 6 + 2])
    nn.set(points[i * 6 + 3], points[i * 6 + 4], points[i * 6 + 5]).normalize()
    o.copy(p).addScaledVector(nn, eps)
    // tangent frame
    t1.set(Math.abs(nn.y) < 0.9 ? 0 : 1, Math.abs(nn.y) < 0.9 ? 1 : 0, 0).cross(nn).normalize()
    t2.crossVectors(nn, t1)

    let R = 0
    let G = 0
    let B = 0

    // ── hemisphere: occlusion, sky through the openings, "inside something" ──
    const indoor = lights.sky ? blocked(bvh, o, tmp.set(0, 1, 0), 50) : false
    let open = 0
    let near = 0
    let inside = 0
    let sr = 0
    let sg = 0
    let sb = 0
    const N = opts.skyRays
    const side = Math.max(1, Math.round(Math.sqrt(N)))
    for (let k = 0; k < N; k++) {
      // stratified, cosine-weighted
      const u1 = ((k % side) + r()) / side
      const u2 = (Math.floor(k / side) % side + r()) / side
      const rad = Math.sqrt(u1)
      const phi = 2 * Math.PI * u2
      const x = rad * Math.cos(phi)
      const y = rad * Math.sin(phi)
      const z = Math.sqrt(Math.max(0, 1 - u1))
      d.set(0, 0, 0).addScaledVector(t1, x).addScaledVector(t2, y).addScaledVector(nn, z)
      const h = hit(bvh, o, d, Infinity)
      if (!h || h.distance > opts.aoRadius) open++
      if (h && h.distance < close) near++
      // the back of a face: the ray started inside something solid
      if (h?.face && h.face.normal.dot(d) > 0) inside++
      if (!h && indoor && lights.sky) {
        const below = d.y < 0 ? 0.3 : 1
        sr += lights.sky[0] * below
        sg += lights.sky[1] * below
        sb += lights.sky[2] * below
      }
    }
    // most of the hemisphere closed right at the surface: under a wall, inside a piece of furniture
    valid[i] = near > N * 0.5 || inside > N * 0.5 ? 0 : 1
    if (!valid[i]) continue
    const ao = open / N
    if (lights.sky) {
      R += (Math.PI * sr) / N
      G += (Math.PI * sg) / N
      B += (Math.PI * sb) / N
    }
    if (lights.hemi) {
      const k = 0.5 * nn.y + 0.5
      const I = lights.hemi.intensity * ao
      R += (lights.hemi.ground[0] + (lights.hemi.sky[0] - lights.hemi.ground[0]) * k) * I
      G += (lights.hemi.ground[1] + (lights.hemi.sky[1] - lights.hemi.ground[1]) * k) * I
      B += (lights.hemi.ground[2] + (lights.hemi.sky[2] - lights.hemi.ground[2]) * k) * I
    }
    if (lights.ambient) {
      ambientAt(lights.ambient, nn, amb)
      R += amb[0] * ao
      G += amb[1] * ao
      B += amb[2] * ao
    }

    // ── sun ──
    if (lights.sun && sunDir) {
      const ndl = nn.dot(sunDir)
      if (ndl > 0) {
        let lit = 0
        const sp = Math.tan(lights.sun.spread)
        for (let k = 0; k < opts.sunRays; k++) {
          const a = 2 * Math.PI * r()
          const s = Math.sqrt(r()) * sp
          d.copy(sunDir).addScaledVector(sunU, Math.cos(a) * s).addScaledVector(sunV, Math.sin(a) * s).normalize()
          if (!blocked(bvh, o, d, Infinity)) lit++
        }
        const k = (ndl * lit) / opts.sunRays
        R += lights.sun.color[0] * k
        G += lights.sun.color[1] * k
        B += lights.sun.color[2] * k
      }
    }

    // ── lamps ──
    for (const L of lights.points) {
      d.set(L.pos[0] - p.x, L.pos[1] - p.y, L.pos[2] - p.z)
      const dist = d.length()
      if (dist < 1e-4) continue
      d.divideScalar(dist)
      const ndl = nn.dot(d)
      if (ndl <= 0) continue
      let k = ndl * distanceAttenuation(dist, L.distance, L.decay)
      if (L.spot) k *= smoothstep(L.spot.cosOuter, L.spot.cosInner, -(d.x * L.spot.dir[0] + d.y * L.spot.dir[1] + d.z * L.spot.dir[2]))
      if (k * Math.max(L.color[0], L.color[1], L.color[2]) < 1e-4) continue
      if (blocked(bvh, o, d, dist - Math.min(LAMP_CLEAR, dist * 0.5))) continue
      R += L.color[0] * k
      G += L.color[1] * k
      B += L.color[2] * k
    }
    for (const A of lights.areas) {
      const area = 4 * Math.hypot(...cross3(A.hu, A.hv))
      let sum = 0
      for (let k = 0; k < opts.areaRays; k++) {
        const a = r() * 2 - 1
        const b = r() * 2 - 1
        d.set(A.pos[0] + A.hu[0] * a + A.hv[0] * b - p.x, A.pos[1] + A.hu[1] * a + A.hv[1] * b - p.y, A.pos[2] + A.hu[2] * a + A.hv[2] * b - p.z)
        const dist = d.length()
        if (dist < 1e-4) continue
        d.divideScalar(dist)
        const cr = nn.dot(d)
        const ce = -(d.x * A.n[0] + d.y * A.n[1] + d.z * A.n[2])
        if (cr <= 0 || ce <= 0) continue
        if (blocked(bvh, o, d, dist - Math.min(LAMP_CLEAR, dist * 0.5))) continue
        sum += (cr * ce) / Math.max(dist * dist, 0.01)
      }
      const k = (sum * area) / opts.areaRays
      R += A.color[0] * k
      G += A.color[1] * k
      B += A.color[2] * k
    }

    rgb[i * 3] = R
    rgb[i * 3 + 1] = G
    rgb[i * 3 + 2] = B
    if (onProgress && i % step === 0) onProgress(i / n)
  }
  onProgress?.(1)
  return { rgb, valid }
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
