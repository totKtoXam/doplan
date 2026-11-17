import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { encodeTexture, isOptimized, markOptimized, optimizeTextures, textureKind } from './optimize'

describe('textureKind', () => {
  it('classifies catalog material maps by their fixed names', () => {
    expect(textureKind('materials/oak/color.jpg')).toBe('color')
    expect(textureKind('materials/oak/normal.jpg')).toBe('normal')
    expect(textureKind('materials/oak/roughness.jpg')).toBe('gray-g')
    expect(textureKind('materials/oak/ao.jpg')).toBe('gray-r')
    expect(textureKind('materials/oak/metalness.jpg')).toBe('gray-b')
  })
  it('keeps every channel of model textures that are not plainly colour or normal', () => {
    expect(textureKind('models/sofa_02/textures/sofa_02_diff_1k.jpg')).toBe('color')
    expect(textureKind('models/sofa_02/textures/sofa_02_nor_gl_1k.jpg')).toBe('normal')
    expect(textureKind('models/sofa_02/textures/sofa_02_arm_1k.jpg')).toBe('packed')
    expect(textureKind('models/sofa_03/textures/sofa_03_rough_1k.jpg')).toBe('packed')
    expect(textureKind('models/lamp/textures/lamp_emissive_1k.jpg')).toBe('packed')
  })
})

/** 64×64 RGB image with a different gradient per channel */
async function rgb(): Promise<Buffer> {
  const px = Buffer.alloc(64 * 64 * 3)
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 3
      px[i] = x * 4
      px[i + 1] = y * 4
      px[i + 2] = 255 - x * 4
    }
  return sharp(px, { raw: { width: 64, height: 64, channels: 3 } }).jpeg({ quality: 100 }).toBuffer()
}

describe('encodeTexture', () => {
  it('writes the channel three.js samples into a one-channel JPEG', async () => {
    const src = await rgb()
    const g = await encodeTexture(src, 'gray-g')
    const meta = await sharp(g).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.channels).toBe(1)
    const { data } = await sharp(g).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
    // row 40 of the green gradient is ~160 everywhere
    expect(Math.abs(data[40 * 64 + 10] - 160)).toBeLessThan(8)
  })
  it('keeps size and channels of packed textures', async () => {
    const out = await encodeTexture(await rgb(), 'packed')
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height, meta.channels]).toEqual([64, 64, 3])
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const i = (20 * 64 + 50) * 3
    expect(Math.abs(data[i] - 200)).toBeLessThan(8)
    expect(Math.abs(data[i + 1] - 80)).toBeLessThan(8)
    expect(Math.abs(data[i + 2] - 55)).toBeLessThan(8)
  })
})

describe('optimization marker', () => {
  it('is a JPEG comment after the APPn headers that decoders ignore', async () => {
    const src = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().toBuffer()
    expect(isOptimized(src)).toBe(false)
    const marked = markOptimized(src)
    expect(isOptimized(marked)).toBe(true)
    expect(markOptimized(marked)).toBe(marked)
    expect(marked.length - src.length).toBe(22)
    // any APPn header (JFIF/Exif) still comes first
    if (src[3] >= 0xe0 && src[3] <= 0xef) expect(marked[3]).toBe(src[3])
    const meta = await sharp(marked).metadata()
    expect([meta.format, meta.width]).toEqual(['jpeg', 8])
  })
})

describe('optimizeTextures', () => {
  it('re-encodes once and records the result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'doplan-opt-'))
    try {
      await mkdir(path.join(root, 'materials', 'm'), { recursive: true })
      // a noisy near-lossless JPEG, like the source packs
      const noise = Buffer.alloc(256 * 256 * 3)
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
      const big = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } }).blur(1.2).jpeg({ quality: 100 }).toBuffer()
      const file = path.join(root, 'materials', 'm', 'color.jpg')
      await writeFile(file, big)
      const first = await optimizeTextures(root)
      expect(first.encoded).toBe(1)
      const after = await readFile(file)
      expect(after.length).toBeLessThan(big.length)
      const second = await optimizeTextures(root)
      expect(second.encoded).toBe(0)
      expect((await readFile(file)).equals(after)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
