/**
 * Pre-build check: every file the installer must ship is on disk.
 *
 *   pnpm assets:check [--root=DIR]
 *
 * For every bundled (`remote !== true`) entry in resources/assets/catalog.json, each
 * `models/… | materials/… | hdris/…` path must exist as a non-empty file under the assets root
 * (default resources/assets). A bundled `.gltf` is also opened and its buffers/images must exist.
 * Files under models/materials/hdris that no bundled entry uses (e.g. a model that became an on-demand
 * download but is still on disk) are refused too: electron-builder and the assets pack copy the whole
 * folders, so they would ship unreferenced. `*.fix.json` repair markers are ignored.
 * Exits 1 with the list of missing or stray files otherwise. Used by the release workflow before `pnpm dist`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSETS_DIR, CATALOG_PATH, PACK_DIRS, bundledPaths, gltfDependencies, type CatalogLike } from './bundle'

export interface CheckResult {
  checked: number
  missing: { path: string; usedBy: string }[]
  /** files on disk that no bundled entry uses */
  stray: string[]
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
  const used = new Set<string>()
  let checked = 0
  for (const { path: rel, ids } of bundledPaths(catalog)) {
    checked++
    used.add(rel)
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
        used.add(dep)
        if (!isFile(path.join(root, dep))) missing.push({ path: dep, usedBy: `${rel} (${ids.join(', ')})` })
      }
    }
  }
  const stray: string[] = []
  for (const d of PACK_DIRS) listFiles(path.join(root, d), d, stray)
  return { checked, missing, stray: stray.filter((f) => !used.has(f) && !f.endsWith('.fix.json')).sort() }
}

function listFiles(abs: string, rel: string, out: string[]): void {
  let names: string[]
  try { names = readdirSync(abs) } catch { return }
  for (const name of names) {
    const a = path.join(abs, name)
    const r = `${rel}/${name}`
    const st = statSync(a)
    if (st.isDirectory()) listFiles(a, r, out)
    else if (st.isFile()) out.push(r)
  }
}

function main(): void {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='))?.slice(7)
  const root = rootArg ? path.resolve(rootArg) : ASSETS_DIR
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogLike
  const { checked, missing, stray } = checkBundledAssets(catalog, root)
  if (stray.length) {
    console.error(`[assets:check] ${stray.length} files under ${root} are not used by any bundled catalog entry and would ship in the installer:`)
    for (const f of stray.slice(0, 50)) console.error(`  - ${f}`)
    if (stray.length > 50) console.error(`  … and ${stray.length - 50} more`)
    console.error('Delete them (on-demand entries download into the user library), or bundle the entry in tools/assets/fetch.ts.')
  }
  if (missing.length) {
    console.error(`[assets:check] ${missing.length} of ${checked} bundled files missing under ${root}:`)
    for (const m of missing) console.error(`  - ${m.path}   ← ${m.usedBy}`)
    console.error('Restore them with the assets pack (docs/RELEASING.md) or `pnpm assets:fetch`.')
    process.exit(1)
  }
  if (stray.length) process.exit(1)
  console.log(`[assets:check] ok: ${checked} bundled files present under ${root}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
