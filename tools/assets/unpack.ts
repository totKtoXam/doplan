/**
 * Restore the heavy assets from an assets-pack zip (the CI side of pack.ts).
 *
 *   pnpm assets:unpack <doplan-assets-N.zip> [--dest=DIR]
 *
 * Checks the zip's sha256 against tools/assets/pack.json, then writes its files into DIR
 * (default resources/assets). Only `models/… | materials/… | hdris/…` entries are accepted
 * (no `..`, no absolute paths); anything else aborts before a single file is written.
 * Refuses to write into a DIR whose models/materials/hdris already exist, so it never mixes packs
 * or touches a developer's own assets. Run `pnpm assets:check` afterwards.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { ASSETS_DIR, PACK_DIRS, PACK_JSON, safeEntryName, type PackInfo } from './bundle'

function fail(msg: string): never {
  console.error(`[assets:unpack] ${msg}`)
  process.exit(1)
}

function main(): void {
  const argv = process.argv.slice(2)
  const zipArg = argv.find((a) => !a.startsWith('--'))
  if (!zipArg) fail('usage: pnpm assets:unpack <doplan-assets-N.zip> [--dest=DIR]')
  const dest = path.resolve(argv.find((a) => a.startsWith('--dest='))?.slice(7) ?? ASSETS_DIR)
  const info = JSON.parse(readFileSync(PACK_JSON, 'utf8')) as PackInfo

  const zip = readFileSync(zipArg)
  const sha256 = createHash('sha256').update(zip).digest('hex')
  if (!info.sha256) fail('tools/assets/pack.json has no sha256: run `pnpm assets:pack` first')
  if (sha256 !== info.sha256) fail(`sha256 mismatch for ${zipArg}: got ${sha256}, pack.json (pack ${info.pack}) wants ${info.sha256}`)

  for (const d of PACK_DIRS) if (existsSync(path.join(dest, d))) fail(`${path.join(dest, d)} already exists; refusing to overwrite`)

  const entries = unzipSync(new Uint8Array(zip.buffer, zip.byteOffset, zip.length))
  const files: [string, Uint8Array][] = []
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') && data.length === 0) continue // directory entry
    const safe = safeEntryName(name)
    if (!safe) fail(`refusing zip entry ${JSON.stringify(name)}`)
    files.push([safe, data])
  }
  for (const [rel, data] of files) {
    const abs = path.join(dest, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, data)
  }
  console.log(`[assets:unpack] pack ${info.pack}: ${files.length} files → ${dest}`)
}

main()
