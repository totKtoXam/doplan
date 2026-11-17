/**
 * Build a doplan asset feed (the `doplan` feed or your own, see docs/ASSET-FEEDS.md) from the upstream
 * sources of every on-demand catalog entry (`remote: true` in resources/assets/catalog.json).
 *
 *   pnpm assets:mirror [--out=DIR] [--only=id,id,…] [--kind=assets|materials|hdris] [--limit=N] [--force] [--no-optimize]
 *
 * For each entry: downloads exactly what the app would download from upstream (`download.files` / the
 * mapped files of `download.zip`), re-encodes the JPEG textures like `pnpm assets:optimize`, and writes
 * DIR/<id>.zip whose entry names are the library paths the catalog names (deterministic: sorted entries,
 * fixed timestamps). DIR/index.json records file, sha256 and size per id and is rewritten after every
 * entry, so an interrupted run resumes where it stopped; entries already in the index with a matching
 * zip are skipped unless --force. Default DIR: release/asset-feed.
 *
 * Uploading is a separate, manual step (printed at the end).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { expectedFiles, sha256 } from '../../src/main/feeds'
import { DOPLAN_FEED_URL } from '../../src/shared/feeds'
import { CATALOG_PATH, ROOT, zipLevel } from './bundle'
import { optimizeTextures } from './optimize'

interface DownloadSpec {
  files?: { url: string; path: string }[]
  zip?: { url: string; files: Record<string, string> }
}
interface Entry {
  id: string
  remote?: boolean
  download?: DownloadSpec
}
interface IndexFile {
  format: 'doplan-feed'
  version: 1
  entries: Record<string, { file: string; sha256: string; bytes: number }>
}

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const OUT = path.resolve(arg('out') ?? path.join(ROOT, 'release', 'asset-feed'))
const ONLY = new Set((arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const KIND = arg('kind') as 'assets' | 'materials' | 'hdris' | undefined
const LIMIT = Number(arg('limit') ?? '0') || 0
const FORCE = argv.includes('--force')
const NO_OPTIMIZE = argv.includes('--no-optimize')
const CONCURRENCY = 3
const UA = 'doplan-asset-mirror/0.1'
/** same fixed timestamp as assets:pack: DOS zip times are local, a local Date keeps the bytes TZ-independent */
const MTIME = new Date(2026, 0, 1, 0, 0, 0)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function httpGet(url: string): Promise<Uint8Array> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(180_000) })
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
        throw new Error(`HTTP ${res.status}`)
      }
      return new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      if ((e as { fatal?: boolean }).fatal) break
      await sleep(1500 * 2 ** attempt)
    }
  }
  throw new Error(`${url} -> ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

const baseName = (p: string) => p.split('/').pop() ?? p

/** the files of an entry from its upstream source, keyed by library path (mirrors catalog.ts fromUpstream) */
async function fromUpstream(spec: DownloadSpec): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  const want = expectedFiles(spec)
  for (const f of spec.files ?? []) out.set(expectedFiles({ files: [f] })[0], await httpGet(f.url))
  if (spec.zip) {
    const wanted = spec.zip.files
    const exact = new Set(Object.keys(wanted))
    const byBase = new Map(Object.keys(wanted).map((k) => [baseName(k), k]))
    const entries = unzipSync(await httpGet(spec.zip.url), { filter: (f) => exact.has(f.name) || byBase.has(baseName(f.name)) })
    const found = new Map<string, Uint8Array>()
    for (const [name, data] of Object.entries(entries)) if (exact.has(name)) found.set(name, data)
    for (const [name, data] of Object.entries(entries)) {
      const key = byBase.get(baseName(name))
      if (key && !found.has(key)) found.set(key, data)
    }
    const missing = Object.keys(wanted).filter((k) => !found.has(k))
    if (missing.length) throw new Error(`upstream zip lacks ${missing.join(', ')}`)
    for (const [entryName, rel] of Object.entries(wanted)) out.set(expectedFiles({ files: [{ url: '', path: rel }] })[0], found.get(entryName)!)
  }
  const missing = want.filter((p) => !out.has(p))
  if (missing.length) throw new Error(`no data for ${missing.join(', ')}`)
  return out
}

function listFiles(dir: string, base: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) listFiles(abs, base, out)
    else out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}

function readIndex(): IndexFile {
  const p = path.join(OUT, 'index.json')
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, 'utf8')) as IndexFile
    if (j.format === 'doplan-feed' && j.version === 1 && j.entries) return j
  }
  return { format: 'doplan-feed', version: 1, entries: {} }
}

function writeIndex(index: IndexFile): void {
  const entries = Object.fromEntries(Object.entries(index.entries).sort(([a], [b]) => (a < b ? -1 : 1)))
  writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify({ ...index, entries }, null, 1)}\n`)
}

async function mirrorEntry(e: Entry, index: IndexFile): Promise<{ raw: number; bytes: number }> {
  const stage = path.join(OUT, '.staging', e.id)
  rmSync(stage, { recursive: true, force: true })
  const files = await fromUpstream(e.download!)
  let raw = 0
  for (const [rel, data] of files) {
    const abs = path.join(stage, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    raw += data.length
  }
  if (!NO_OPTIMIZE) await optimizeTextures(stage, { log: () => {} })
  const zippable: Zippable = {}
  for (const rel of listFiles(stage, stage).sort()) zippable[rel] = [readFileSync(path.join(stage, ...rel.split('/'))), { level: zipLevel(rel), mtime: MTIME }]
  const zip = zipSync(zippable)
  const file = `${e.id}.zip`
  writeFileSync(path.join(OUT, `${file}.part`), zip)
  renameSync(path.join(OUT, `${file}.part`), path.join(OUT, file))
  rmSync(stage, { recursive: true, force: true })
  index.entries[e.id] = { file, sha256: sha256(zip), bytes: zip.length }
  writeIndex(index)
  return { raw, bytes: zip.length }
}

async function main(): Promise<void> {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<'assets' | 'materials' | 'hdris', Entry[]>
  let todo = (['assets', 'materials', 'hdris'] as const)
    .filter((k) => !KIND || k === KIND)
    .flatMap((k) => catalog[k] ?? [])
    .filter((e) => e.remote === true && e.download && (!ONLY.size || ONLY.has(e.id)))
  const unknown = [...ONLY].filter((id) => !todo.some((e) => e.id === id))
  if (unknown.length) throw new Error(`not on-demand catalog entries: ${unknown.join(', ')}`)
  mkdirSync(OUT, { recursive: true })
  const index = readIndex()
  const done = (e: Entry) => {
    const it = index.entries[e.id]
    if (!it) return false
    const p = path.join(OUT, it.file)
    return existsSync(p) && statSync(p).size === it.bytes && sha256(readFileSync(p)) === it.sha256
  }
  if (!FORCE) todo = todo.filter((e) => !done(e))
  if (LIMIT) todo = todo.slice(0, LIMIT)
  console.log(`[assets:mirror] ${todo.length} entries to mirror into ${OUT} (${Object.keys(index.entries).length} already in index.json)`)

  let raw = 0
  let packed = 0
  const failed: string[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length) {
        const e = todo[next++]
        try {
          const r = await mirrorEntry(e, index)
          raw += r.raw
          packed += r.bytes
          console.log(`  ${e.id}: ${(r.raw / 1e6).toFixed(1)} → ${(r.bytes / 1e6).toFixed(1)} MB`)
        } catch (err) {
          failed.push(e.id)
          console.error(`  ${e.id}: FAILED ${(err as Error).message}`)
        }
      }
    }),
  )
  rmSync(path.join(OUT, '.staging'), { recursive: true, force: true })
  const total = Object.values(index.entries).reduce((s, x) => s + x.bytes, 0)
  console.log(`[assets:mirror] upstream ${(raw / 1e6).toFixed(1)} MB → feed ${(packed / 1e6).toFixed(1)} MB this run; index.json: ${Object.keys(index.entries).length} entries, ${(total / 1e6).toFixed(1)} MB`)
  if (failed.length) {
    console.error(`[assets:mirror] ${failed.length} failed (re-run to retry): ${failed.join(', ')}`)
    process.exitCode = 1
  }
  const m = /github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(DOPLAN_FEED_URL)
  if (m) {
    console.log(`\nUpload as the doplan feed (manual, see docs/ASSET-FEEDS.md):`)
    console.log(`  gh release create ${m[2]} --repo ${m[1]} --title "doplan asset feed ${m[2]}" --notes "On-demand assets for doplan" --latest=false   # once`)
    console.log(`  gh release upload ${m[2]} --repo ${m[1]} --clobber "${OUT}"/*.zip`)
    console.log(`  gh release upload ${m[2]} --repo ${m[1]} --clobber "${OUT}/index.json"   # last`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
