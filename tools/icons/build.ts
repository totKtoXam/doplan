/**
 * Renders the app icons from the master SVGs in resources/logo:
 *   resources/icon.ico        Windows exe / installer / .doplan file icon (16–256, BMP frames below 256, PNG at 256)
 *   resources/icon.png        1024 px PNG (window icon in dev, generic use)
 *   resources/icon-512.png    512 px PNG
 *   src/renderer/public/favicon.ico   web build favicon (16, 32, 48)
 * Small sizes use pixel-snapped variants: doplan-16.svg for 16 px, doplan-32.svg for 20–32 px.
 * Run: pnpm icons:build
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../..', import.meta.url))
const logo = (name: string) => readFileSync(join(root, 'resources', 'logo', name))

function sourceFor(size: number): Buffer {
  if (size <= 16) return logo('doplan-16.svg')
  if (size <= 32) return logo('doplan-32.svg')
  return logo('doplan.svg')
}

async function renderRgba(size: number): Promise<Buffer> {
  return sharp(sourceFor(size), { density: (72 * size) / 256 }).resize(size, size).ensureAlpha().raw().toBuffer()
}

async function renderPng(size: number): Promise<Buffer> {
  return sharp(sourceFor(size), { density: (72 * size) / 256 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
}

/** 32-bit BGRA DIB (bottom-up) with an empty AND mask, as Windows expects inside an ICO */
function dib(rgba: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND masks
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4
      const dst = ((size - 1 - y) * size + x) * 4
      pixels[dst] = rgba[src + 2]
      pixels[dst + 1] = rgba[src + 1]
      pixels[dst + 2] = rgba[src]
      pixels[dst + 3] = rgba[src + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

async function ico(sizes: number[]): Promise<Buffer> {
  const frames = await Promise.all(sizes.map(async (s) => (s >= 256 ? renderPng(s) : dib(await renderRgba(s), s))))
  const dir = Buffer.alloc(6 + 16 * sizes.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(sizes.length, 4)
  let offset = dir.length
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i
    dir.writeUInt8(s >= 256 ? 0 : s, e)
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(frames[i].length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += frames[i].length
  })
  return Buffer.concat([dir, ...frames])
}

const out = (...p: string[]) => join(root, ...p)
writeFileSync(out('resources', 'icon.ico'), await ico([16, 20, 24, 32, 40, 48, 64, 128, 256]))
writeFileSync(out('resources', 'icon.png'), await renderPng(1024))
writeFileSync(out('resources', 'icon-512.png'), await renderPng(512))
writeFileSync(out('src', 'renderer', 'public', 'favicon.ico'), await ico([16, 32, 48]))
console.log('icons written')
