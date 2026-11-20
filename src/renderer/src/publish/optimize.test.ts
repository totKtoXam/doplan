import { Document, WebIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { AssetHost, SiteContent, SiteFile } from '@shared/pagesSite'
import { budgetForSize, type ImageCodec, optimizeModel, optimizeSite, type TextureUse, mapUseOfName } from './optimize'

/** a stand-in codec: halves the bytes and calls them WebP, remembering what it was asked */
function fakeCodec() {
  const calls: { bytes: number; px: number; use: TextureUse }[] = []
  const codec: ImageCodec = {
    async fit(data, _mime, px, use) {
      calls.push({ bytes: data.byteLength, px, use })
      return { data: data.slice(0, Math.ceil(data.byteLength / 2)), mime: 'image/webp' }
    },
  }
  return { codec, calls }
}

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)
const file = (host: AssetHost, rel: string, path: string): SiteFile => ({ host, rel, path })
const content = (files: SiteFile[], catalog: Partial<SiteContent['catalog']>, doc: unknown = {}): SiteContent => ({
  doc,
  catalog: { version: 1, materials: [], assets: [], hdris: [], ...catalog },
  files,
  notDownloaded: [],
})

async function io(): Promise<WebIO> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready])
  return new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })
}

/** a textured flat grid of n × n quads, written as .gltf + .bin + .png */
async function gridModel(n: number): Promise<Record<string, Uint8Array>> {
  const doc = new Document()
  const buffer = doc.createBuffer().setURI('chair.bin')
  const pos: number[] = []
  const uv: number[] = []
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      pos.push(x / n, 0, y / n)
      uv.push(x / n, y / n)
    }
  const idx: number[] = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2)
    }
  const tex = doc.createTexture('wood').setImage(bytes(40_000, 7)).setMimeType('image/png').setURI('tex.png')
  const mat = doc.createMaterial('fabric').setBaseColorTexture(tex)
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
    .setMaterial(mat)
  doc.createScene().addChild(doc.createNode('chair').setMesh(doc.createMesh('chair').addPrimitive(prim)))
  const { json, resources } = await (await io()).writeJSON(doc)
  return { 'chair.gltf': new TextEncoder().encode(JSON.stringify(json)), ...resources }
}

describe('publish budgets', () => {
  it('fits textures and triangles to the size an object is seen at', () => {
    expect(budgetForSize(80)).toEqual({ px: 256, tris: 12_000 })
    expect(budgetForSize(500)).toEqual({ px: 512, tris: 25_000 })
    expect(budgetForSize(2200)).toEqual({ px: 1024, tris: 80_000 })
    expect(budgetForSize(Number.NaN).px).toBe(1024)
  })

  it('tells colour, normal and data maps apart by name', () => {
    expect(mapUseOfName('assets/c/oak_diffuse.jpg')).toBe('color')
    expect(mapUseOfName('assets/c/oak_nor_gl.png')).toBe('normal')
    expect(mapUseOfName('assets/c/oak-rough.jpg')).toBe('data')
    expect(mapUseOfName('assets/c/arm.png')).toBe('data')
  })
})

describe('optimizeSite', () => {
  it('re-encodes textures as WebP, merges identical files, leaves HDRIs alone and rewrites every reference', async () => {
    const src: Record<string, Uint8Array> = {
      'tex/wood.jpg': bytes(10_000, 1),
      'tex/copy-of-wood.jpg': bytes(10_000, 1),
      'tex/wood_rough.png': bytes(8_000, 2),
      'hdri/sky.jpg': bytes(50_000, 3),
    }
    const read: string[] = []
    const { codec, calls } = fakeCodec()
    const site = content(
      [
        file('catalog', 'tex/wood.jpg', 'assets/c/tex/wood.jpg'),
        file('library', 'tex/copy-of-wood.jpg', 'assets/l/tex/copy-of-wood.jpg'),
        file('catalog', 'tex/wood_rough.png', 'assets/c/tex/wood_rough.png'),
        file('catalog', 'hdri/sky.jpg', 'assets/c/hdri/sky.jpg'),
      ],
      {
        materials: [
          { id: 'oak', maps: { color: './assets/c/tex/wood.jpg', roughness: './assets/c/tex/wood_rough.png' } },
          { id: 'mine', maps: { color: './assets/l/tex/copy-of-wood.jpg' } },
        ],
        hdris: [{ id: 'sky', src: './assets/c/hdri/sky.jpg' }],
      },
      { underlay: './assets/l/tex/copy-of-wood.jpg' },
    )
    const { content: out, report } = await optimizeSite(site, {
      codec,
      read: async (f) => {
        read.push(f.rel)
        return src[f.rel]
      },
    })
    expect(read).not.toContain('hdri/sky.jpg')
    expect(out.files.map((f) => f.path).sort()).toEqual(['assets/c/hdri/sky.jpg', 'assets/c/tex/wood.webp', 'assets/c/tex/wood_rough.webp'])
    expect(out.files.find((f) => f.path === 'assets/c/tex/wood.webp')?.data?.byteLength).toBe(5_000)
    expect(out.files.find((f) => f.path === 'assets/c/hdri/sky.jpg')?.data).toBeUndefined()
    const mats = out.catalog.materials as { maps: Record<string, string> }[]
    expect(mats[0].maps).toEqual({ color: './assets/c/tex/wood.webp', roughness: './assets/c/tex/wood_rough.webp' })
    // the library copy was the same picture: one file, both point at it
    expect(mats[1].maps.color).toBe('./assets/c/tex/wood.webp')
    expect(out.doc).toEqual({ underlay: './assets/c/tex/wood.webp' })
    expect(calls.find((c) => c.bytes === 8_000)).toMatchObject({ px: 1024, use: 'data' })
    expect(calls.find((c) => c.bytes === 10_000)).toMatchObject({ px: 1024, use: 'color' })
    expect(report).toMatchObject({ changed: 2, duplicates: 1, kept: 1 })
    expect(report.after).toBeLessThan(report.before)
  })

  it('turns a .gltf into one lighter .glb (simplified, WebP textures, meshopt) the viewer can read', async () => {
    const files = await gridModel(160)
    const { codec, calls } = fakeCodec()
    const site = content([file('library', 'm/chair.gltf', 'assets/l/m/chair.gltf')], {
      assets: [{ id: 'chair', src: './assets/l/m/chair.gltf', size: { w: 500, d: 500, h: 450 } }],
    })
    const { content: out, report } = await optimizeSite(site, { codec, read: async (f) => files[f.rel.slice(2)] })
    expect(out.files).toHaveLength(1)
    const glb = out.files[0]
    expect(glb.path).toBe('assets/l/m/chair.glb')
    expect((out.catalog.assets as { src: string }[])[0].src).toBe('./assets/l/m/chair.glb')
    // the budget of a 0.5 m object: 512 px textures
    expect(calls).toEqual([{ bytes: 40_000, px: 512, use: 'color' }])
    const back = await (await io()).readBinary(glb.data as Uint8Array)
    const used = back
      .getRoot()
      .listExtensionsUsed()
      .map((e) => e.extensionName)
    expect(used).toEqual(expect.arrayContaining(['EXT_meshopt_compression', 'EXT_texture_webp']))
    const prim = back.getRoot().listMeshes()[0].listPrimitives()[0]
    // 51 200 triangles of a flat grid: far fewer, the material slot keeps its name
    expect((prim.getIndices()?.getCount() ?? 0) / 3).toBeLessThan(25_000 * 1.2)
    expect(prim.getMaterial()?.getName()).toBe('fabric')
    expect(report.changed).toBe(1)
  })

  it('publishes a file as it is when it cannot be read or would not get smaller; a second run uses the cache', async () => {
    const { codec, calls } = fakeCodec()
    const cache = new Map<string, Promise<Uint8Array | null>>()
    const site = content([file('catalog', 'broken.glb', 'assets/c/broken.glb'), file('catalog', 'a.png', 'assets/c/a.png')], {})
    const env = { codec, cache, read: async (f: SiteFile) => (f.rel === 'a.png' ? bytes(4_000, 5) : bytes(100, 9)) }
    const first = await optimizeSite(site, env)
    expect(first.content.files.map((f) => [f.path, !!f.data])).toEqual([
      ['assets/c/broken.glb', false],
      ['assets/c/a.webp', true],
    ])
    const progress: number[] = []
    const second = await optimizeSite(site, { ...env, onProgress: (done) => progress.push(done) })
    expect(second.content.files.map((f) => f.path)).toEqual(['assets/c/broken.glb', 'assets/c/a.webp'])
    expect(calls).toHaveLength(1)
    expect(progress.sort()).toEqual([1, 2])
  })

  it('a missing file goes out as it is and the others are still made lighter; underlays are never touched', async () => {
    const { codec, calls } = fakeCodec()
    const site = content(
      [file('project', 'gone.png', 'assets/p/gone.png'), file('project', 'scan.png', 'assets/p/scan.png'), file('catalog', 'a.png', 'assets/c/a.png')],
      {},
      { underlays: { u1: { src: './assets/p/scan.png', scale: 2 } } },
    )
    const { content: out } = await optimizeSite(site, {
      codec,
      read: async (f) => {
        if (f.rel === 'gone.png') throw new Error('404 gone.png')
        return bytes(4_000, 5)
      },
    })
    expect(out.files.map((f) => [f.path, !!f.data])).toEqual([
      ['assets/p/gone.png', false],
      ['assets/p/scan.png', false],
      ['assets/c/a.webp', true],
    ])
    expect(calls).toHaveLength(1)
    expect((out.doc as { underlays: { u1: { src: string } } }).underlays.u1.src).toBe('./assets/p/scan.png')
  })

  it("keeps a model's override slots: unnamed materials get the names the 3D view gave the original", async () => {
    // Chair has its own mesh and a child Cushion: compression moves Chair's mesh into a new node after it
    const doc = new Document()
    const buffer = doc.createBuffer()
    const prim = (m: ReturnType<Document['createMaterial']> | null) => {
      const p = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
      return m ? p.setMaterial(m) : p
    }
    const a = doc.createMaterial().setBaseColorFactor([1, 0, 0, 1])
    const b = doc.createMaterial().setBaseColorFactor([0, 0, 1, 1])
    const chair = doc.createNode('Chair').setMesh(doc.createMesh().addPrimitive(prim(a)))
    chair.addChild(doc.createNode('Cushion').setMesh(doc.createMesh().addPrimitive(prim(b)).addPrimitive(prim(null))))
    doc.createScene().addChild(chair)
    const { codec } = fakeCodec()
    const back = await (await io()).readBinary(await optimizeModel(doc, { px: 1024, tris: Infinity }, codec))
    const byColour = new Map(back.getRoot().listMaterials().map((m) => [m.getBaseColorFactor().join(','), m.getName()]))
    expect(byColour.get('1,0,0,1')).toBe('material_0')
    expect(byColour.get('0,0,1,1')).toBe('material_1')
    expect(byColour.get('1,1,1,1')).toBe('material_2')
  })

  it('names a material shared by primitives with and without vertex colours twice, as the 3D view does', async () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const vec3 = (a: number[]) => doc.createAccessor().setType('VEC3').setArray(new Float32Array(a)).setBuffer(buffer)
    const mat = doc.createMaterial()
    const prim = (colour: boolean) => {
      const p = doc
        .createPrimitive()
        .setAttribute('POSITION', vec3([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        .setAttribute('NORMAL', vec3([0, 0, 1, 0, 0, 1, 0, 0, 1]))
        .setMaterial(mat)
      return colour ? p.setAttribute('COLOR_0', vec3([1, 1, 1, 1, 0, 0, 0, 1, 0])) : p
    }
    doc
      .createScene()
      .addChild(doc.createNode('Plain').setMesh(doc.createMesh().addPrimitive(prim(false))))
      .addChild(doc.createNode('Painted').setMesh(doc.createMesh().addPrimitive(prim(true))))
    const original = await (await io()).writeBinary(doc)
    const { codec } = fakeCodec()
    const optimized = await optimizeModel(doc, { px: 1024, tris: Infinity }, codec)
    /** what the 3D view calls each mesh's material (view3d/items prepareTemplate), by vertex colours */
    const slots = async (glb: Uint8Array) => {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
      const gltf = await loader.parseAsync(glb.slice().buffer, '')
      let unnamed = 0
      const named = new Map<THREE.Material, string>()
      const out = new Map<boolean, string>()
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const m = mesh.material as THREE.Material
        if (!m.name) {
          if (!named.has(m)) named.set(m, `material_${unnamed++}`)
          m.name = named.get(m) as string
        }
        out.set(!!mesh.geometry.getAttribute('color'), m.name)
      })
      return out
    }
    const before = await slots(original)
    expect(new Set(before.values()).size).toBe(2)
    expect(await slots(optimized)).toEqual(before)
  })

  it('a .gltf whose texture changed on disk is made lighter again; the session keeps only the last plan', async () => {
    const files = await gridModel(20)
    const { codec, calls } = fakeCodec()
    const cache = new Map<string, Promise<Uint8Array | null>>()
    const site = content([file('library', 'm/chair.gltf', 'assets/l/m/chair.gltf')], {})
    const env = { codec, cache, read: async (f: SiteFile) => files[f.rel.slice(2)] }
    await optimizeSite(site, env)
    await optimizeSite(site, env)
    expect(calls).toHaveLength(1)
    files['tex.png'] = bytes(40_000, 8)
    await optimizeSite(site, env)
    expect(calls).toHaveLength(2)
    expect(cache.size).toBe(1)
  })
})
