/**
 * Pre-build check: every file the installer must ship is on disk.
 *
 *   pnpm assets:check [--root=DIR]
 *
 * For every bundled (`remote !== true`) entry in resources/assets/catalog.json, each
 * `models/… | materials/… | hdris/…` path must exist as a non-empty file under the assets root
 * (default resources/assets). A bundled `.gltf` is also opened and its buffers/images must exist.
 * Exits 1 with the list of missing files otherwise. Used by the release workflow before `pnpm dist`.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSETS_DIR, CATALOG_PATH, bundledPaths, gltfDependencies, type CatalogLike } from './bundle'

export interface CheckResult {
  checked: number
  missing: { path: string; usedBy: string }[]
}

function isFile(p: string): boolean {
  try {
    const s = statSync(p)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

export function checkBundledAssets(catalog: CatalogLike, root: string): CheckResult {
  const missing: CheckResult['missing'] = []
  let checked = 0
  for (const { path: rel, ids } of bundledPaths(catalog)) {
    checked++
    const abs = path.join(root, rel)
    if (!isFile(abs)) {
      missing.push({ path: rel, usedBy: ids.join(', ') })
      continue
    }
    if (rel.toLowerCase().endsWith('.gltf')) {
      let deps: string[]
      try {
        deps = gltfDependencies(rel, JSON.parse(readFileSync(abs, 'utf8')))
      } catch (err) {
        missing.push({ path: `${rel} (unreadable glTF: ${(err as Error).message})`, usedBy: ids.join(', ') })
        continue
      }
      for (const dep of deps) {
        checked++
        if (!isFile(path.join(root, dep))) missing.push({ path: dep, usedBy: `${rel} (${ids.join(', ')})` })
      }
    }
  }
  return { checked, missing }
}

function main(): void {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='))?.slice(7)
  const root = rootArg ? path.resolve(rootArg) : ASSETS_DIR
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogLike
  const { checked, missing } = checkBundledAssets(catalog, root)
  if (missing.length) {
    console.error(`[assets:check] ${missing.length} of ${checked} bundled files missing under ${root}:`)
    for (const m of missing) console.error(`  - ${m.path}   ← ${m.usedBy}`)
    console.error('Restore them with the assets pack (docs/RELEASING.md) or `pnpm assets:fetch`.')
    process.exit(1)
  }
  console.log(`[assets:check] ok: ${checked} bundled files present under ${root}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
