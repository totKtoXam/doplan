/**
 * Re-encodes the bundled JPEG textures so the installer stays small.
 *
 *   pnpm assets:optimize [--dry]
 *
 * Poly Haven and ambientCG ship their 1K JPEGs at near-lossless quality (~0.5–0.8 MB per 1K map). The same
 * pixels re-encoded with mozjpeg at q85–88 are 70–85 % smaller at 38–42 dB PSNR against the source, which
 * is not visible on a tiled, lit surface. Files keep their names and the JPEG format, so the catalog,
 * the glTF texture URIs, saved projects and on-demand downloads are unaffected.
 *
 * Per map kind (see `textureKind`):
 *   color   q88, 4:2:0 chroma
 *   normal  q85, 4:4:4 (the X/Y vector lives in the colour channels: no chroma subsampling)
 *   packed  q88, 4:4:4 (glTF ARM/ORM and metal-rough: three independent channels)
 *   gray    q88, one channel (catalog roughness / ao / metalness; a 3-channel source keeps the
 *           channel three.js samples: G for roughness, R for ao, B for metalness)
 *
 * Idempotent: every file written carries a JPEG comment segment (`doplan-optimized/1`), so a re-run, a
 * `pnpm assets:fetch` (which calls this for the bundled pack) or an unpacked assets pack never re-encodes a
 * file twice. A re-encode that is not at least 5 % smaller keeps the original pixels (marked as well).
 */
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

export type TextureKind = 'color' | 'normal' | 'packed' | 'gray-r' | 'gray-g' | 'gray-b'

/** map kind from a path relative to resources/assets */
export function textureKind(rel: string): TextureKind {
  const p = rel.replace(/\\/g, '/').toLowerCase()
  const name = p.slice(p.lastIndexOf('/') + 1)
  if (p.startsWith('materials/')) {
    // catalog materials: fixed names written by fetch.ts (MAP_FILE)
    if (name.startsWith('normal')) return 'normal'
    if (name.startsWith('roughness')) return 'gray-g'
    if (name.startsWith('ao')) return 'gray-r'
    if (name.startsWith('metalness')) return 'gray-b'
    if (name.startsWith('arm')) return 'packed'
    return 'color'
  }
  // model textures: whatever the glTF points at; anything that is not plainly a colour or normal map
  // may be a packed metal/rough/occlusion texture, so it keeps all three channels at full resolution
  if (/(^|[_\-.])(nor|normal|nrm|norm)([_\-.]|gl|$)/.test(name)) return 'normal'
  if (/(^|[_\-.])(diff|diffuse|col|color|colour|albedo|basecolor|base_color|basecolour)([_\-.]|$)/.test(name)) return 'color'
  return 'packed'
}

export async function encodeTexture(src: Buffer, kind: TextureKind): Promise<Buffer> {
  const meta = await sharp(src).metadata()
  let img = sharp(src)
  if (kind.startsWith('gray')) {
    // one band as raw pixels first: sharp would otherwise turn a single extracted channel back into sRGB
    const band = (meta.channels ?? 3) >= 3 ? (kind === 'gray-r' ? 0 : kind === 'gray-g' ? 1 : 2) : 0
    const { data, info } = await img.extractChannel(band).raw().toBuffer({ resolveWithObject: true })
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).toColourspace('b-w').jpeg({ quality: 88, mozjpeg: true }).toBuffer()
  }
  if ((meta.channels ?? 3) === 1) return img.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
  if (meta.hasAlpha) img = img.removeAlpha()
  if (kind === 'color') return img.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
  return img.jpeg({ quality: kind === 'normal' ? 85 : 88, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer()
}


const MARK = Buffer.from('doplan-optimized/1', 'latin1')

/** true when a JPEG carries the marker comment (looked up in the header segments, before the scan data) */
export function isOptimized(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false
  let off = 2
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1]
    if (marker === 0xda || marker === 0xd9) break // start of scan / end of image: no more headers
    const len = buf.readUInt16BE(off + 2)
    if (marker === 0xfe && buf.subarray(off + 4, off + 2 + len).equals(MARK)) return true
    off += 2 + len
  }
  return false
}

/** inserts the marker comment after SOI and the APPn segments (JFIF/Exif stay first, as decoders expect) */
export function markOptimized(buf: Buffer): Buffer {
  if (isOptimized(buf) || buf[0] !== 0xff || buf[1] !== 0xd8) return buf
  let off = 2
  while (off + 4 <= buf.length && buf[off] === 0xff && buf[off + 1] >= 0xe0 && buf[off + 1] <= 0xef) off += 2 + buf.readUInt16BE(off + 2)
  const seg = Buffer.alloc(4 + MARK.length)
  seg[0] = 0xff
  seg[1] = 0xfe
  seg.writeUInt16BE(MARK.length + 2, 2)
  MARK.copy(seg, 4)
  return Buffer.concat([buf.subarray(0, off), seg, buf.subarray(off)])
}

async function listJpegs(root: string, dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(path.join(root, dir), { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) await listJpegs(root, rel, out)
    else if (/.jpe?g$/i.test(e.name)) out.push(rel)
  }
}

export interface OptimizeResult { files: number; encoded: number; before: number; after: number }

/** re-encodes every JPEG under <root>/{materials,models}; `only` limits it to those relative paths */
export async function optimizeTextures(root: string, opts: { only?: string[]; dry?: boolean; log?: (s: string) => void } = {}): Promise<OptimizeResult> {
  let rels: string[] = []
  if (opts.only) rels = opts.only.filter((r) => /.jpe?g$/i.test(r))
  else for (const d of ['materials', 'models']) await listJpegs(root, d, rels)
  rels.sort()
  const res: OptimizeResult = { files: rels.length, encoded: 0, before: 0, after: 0 }
  const queue = [...rels]
  const work = async (): Promise<void> => {
    for (let rel = queue.shift(); rel; rel = queue.shift()) {
      const file = path.join(root, ...rel.split('/'))
      let src: Buffer
      try { src = await readFile(file) } catch { continue }
      res.before += src.length
      if (isOptimized(src)) { res.after += src.length; continue }
      try {
        const out = await encodeTexture(src, textureKind(rel))
        const smaller = out.length <= src.length * 0.95
        const keep = markOptimized(smaller ? out : src)
        if (!opts.dry) {
          await writeFile(file + '.part', keep)
          await rename(file + '.part', file)
        }
        res.after += keep.length
        if (smaller) res.encoded++
      } catch (e) {
        res.after += src.length
        opts.log?.(`  FAIL optimize ${rel}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, work))
  return res
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..', '..', 'resources', 'assets')
  const dry = process.argv.includes('--dry')
  optimizeTextures(root, { dry, log: console.error }).then((r) => {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
    console.log(`${dry ? '[dry] ' : ''}textures: ${r.files} jpeg, ${r.encoded} re-encoded, ${mb(r.before)} MB -> ${mb(r.after)} MB`)
  }, (e) => {
    console.error(e)
    process.exitCode = 1
  })
}
