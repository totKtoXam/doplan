/**
 * Build the assets pack for CI from a local checkout that has the heavy assets.
 *
 *   pnpm assets:pack [--pack=N] [--out=DIR] [--force]
 *
 * Zips resources/assets/{models,materials,hdris} (everything in them, exactly what a local `pnpm dist`
 * would ship) into DIR/doplan-assets-N.zip (default DIR: release/assets-pack, N: the number in
 * tools/assets/pack.json) and records N, sha256, size and file count in tools/assets/pack.json.
 * The zip is deterministic (sorted entries, fixed timestamps), so the same files give the same sha256.
 *
 * Refuses to pack when `pnpm assets:check` would fail, and refuses to re-record a different sha256
 * under an already-recorded N (that pack is already uploaded; bump with --pack=N+1) unless --force.
 * Uploading is a separate, manual step (printed at the end; see docs/RELEASING.md).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync, type Zippable } from 'fflate'
import { ASSETS_DIR, CATALOG_PATH, PACK_DIRS, PACK_JSON, ROOT, packFile, packTag, zipLevel, type CatalogLike, type PackInfo } from './bundle'
import { checkBundledAssets } from './check'

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const FORCE = argv.includes('--force')

/** fixed local-time timestamp: DOS zip times are local, so a local Date keeps the bytes TZ-independent */
const MTIME = new Date(2026, 0, 1, 0, 0, 0)

/** files under dir (symlinked folders followed), as forward-slash paths relative to `base` */
function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, base, out)
    else if (st.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
}

function main(): void {
  const prev = JSON.parse(readFileSync(PACK_JSON, 'utf8')) as PackInfo
  const n = Number(arg('pack') ?? prev.pack)
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad --pack: ${arg('pack')}`)
  const outDir = path.resolve(arg('out') ?? path.join(ROOT, 'release', 'assets-pack'))

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogLike
  const { checked, missing, stray } = checkBundledAssets(catalog, ASSETS_DIR)
  if (missing.length || stray.length) {
    console.error(
      `[assets:pack] ${missing.length} of ${checked} bundled files missing, ${stray.length} unused files on disk, refusing to pack. Run \`pnpm assets:check\`.`,
    )
    process.exit(1)
  }

  const files: string[] = []
  for (const d of PACK_DIRS) walk(path.join(ASSETS_DIR, d), ASSETS_DIR, files)
  files.sort()
  const zippable: Zippable = {}
  let raw = 0
  for (const rel of files) {
    const data = readFileSync(path.join(ASSETS_DIR, rel))
    raw += data.length
    zippable[rel] = [new Uint8Array(data.buffer, data.byteOffset, data.length), { level: zipLevel(rel), mtime: MTIME }]
  }
  const zip = zipSync(zippable)
  const sha256 = createHash('sha256').update(zip).digest('hex')

  if (n === prev.pack && prev.sha256 && prev.sha256 !== sha256 && !FORCE) {
    console.error(
      `[assets:pack] assets changed since pack ${n} was recorded (sha256 ${prev.sha256.slice(0, 12)}… → ${sha256.slice(0, 12)}…).\n` +
        `  ${packTag(n)} is already published with the old zip: make a new pack with --pack=${n + 1}` +
        ' (or --force if pack ' + n + ' was never uploaded).',
    )
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const zipPath = path.join(outDir, packFile(n))
  writeFileSync(zipPath, zip)
  const info: PackInfo = { pack: n, sha256, bytes: zip.length, files: files.length }
  writeFileSync(PACK_JSON, `${JSON.stringify(info, null, 2)}\n`)

  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`
  console.log(`[assets:pack] ${files.length} files, ${mb(raw)} → ${zipPath} (${mb(zip.length)})`)
  console.log(`[assets:pack] sha256 ${sha256}; tools/assets/pack.json updated (commit it)`)
  if (n === prev.pack && prev.sha256 === sha256)
    console.log(`[assets:pack] identical to the recorded pack ${n}: if ${packTag(n)} is already published, nothing to upload`)
  console.log(
    `\nUpload (public, needs gh auth):\n  gh release create ${packTag(n)} "${zipPath}" -R totKtoXam/doplan --latest=false` +
      ` --title "doplan assets pack ${n}" --notes "CC0 models/materials/HDRIs for CI release builds (not an app release)."`,
  )
}

main()
