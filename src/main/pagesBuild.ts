/**
 * Writes the static site of one published plan into a folder (see shared/pagesSite for the layout):
 * the viewer build, view-plan.json / view-catalog.json / view-site.json and every asset file the plan uses, with the
 * buffers and textures of .gltf models. No Electron imports: the roots come in as arguments (tests).
 */
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { gltfDependencies, joinRel, PAGES_LIMITS, SITE_FILES, type AssetHost, type SiteContent, type SiteFile, type SiteInfo } from '@shared/pagesSite'
import { safeJoin } from './fsutil'

export interface BuildSiteOptions {
  /** the plan folder (created; existing content is replaced) */
  outDir: string
  /** out/viewer: viewer.html + viewer/… + favicon.ico */
  viewerDir: string
  content: SiteContent
  info: SiteInfo
  /** filesystem roots of the doplan-asset:// hosts */
  roots: Record<AssetHost, string>
}

export interface BuildSiteResult {
  /** total size of the plan folder, bytes */
  bytes: number
  /** number of files written */
  files: number
  /** asset files the plan refers to that are not on disk (skipped) */
  missing: string[]
  /** files over the 100 MB push limit of GitHub (the site cannot be published) */
  tooLarge: string[]
}

async function copyTree(from: string, to: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  await fsp.mkdir(to, { recursive: true })
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const s = join(from, e.name)
    const d = join(to, e.name)
    if (e.isDirectory()) {
      const r = await copyTree(s, d)
      bytes += r.bytes
      files += r.files
    } else if (e.isFile()) {
      await fsp.copyFile(s, d)
      bytes += (await fsp.stat(d)).size
      files++
    }
  }
  return { bytes, files }
}

export async function buildSite(opts: BuildSiteOptions): Promise<BuildSiteResult> {
  const { outDir, viewerDir, content, info, roots } = opts
  await fsp.rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })

  let bytes = 0
  let count = 0
  const missing: string[] = []
  const tooLarge: string[] = []

  // ── the viewer: viewer.html becomes the folder's index.html ──
  const html = await fsp.readFile(join(viewerDir, 'viewer.html'))
  await fsp.writeFile(join(outDir, 'index.html'), html)
  bytes += html.byteLength
  count++
  for (const name of await fsp.readdir(viewerDir)) {
    if (name === 'viewer.html') continue
    const src = join(viewerDir, name)
    const st = await fsp.stat(src)
    if (st.isDirectory()) {
      const r = await copyTree(src, join(outDir, name))
      bytes += r.bytes
      count += r.files
    } else if (st.isFile()) {
      await fsp.copyFile(src, join(outDir, name))
      bytes += st.size
      count++
    }
  }

  // ── data ──
  const writeJson = async (name: string, value: unknown) => {
    const text = JSON.stringify(value)
    await fsp.writeFile(join(outDir, name), text)
    bytes += Buffer.byteLength(text)
    count++
  }
  await writeJson(SITE_FILES.plan, content.doc)
  await writeJson(SITE_FILES.catalog, content.catalog)
  await writeJson(SITE_FILES.site, info)

  // ── assets (+ the files .gltf models point to) ──
  const queue: SiteFile[] = [...content.files]
  const done = new Set<string>()
  while (queue.length) {
    const f = queue.shift() as SiteFile
    if (done.has(f.path)) continue
    done.add(f.path)
    const root = Object.prototype.hasOwnProperty.call(roots, f.host) ? roots[f.host] : null
    const src = root ? safeJoin(root, f.rel) : null
    const dest = safeJoin(outDir, f.path)
    if (!src || !dest) {
      missing.push(f.path)
      continue
    }
    let size: number
    try {
      const st = await fsp.stat(src)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      missing.push(f.path)
      continue
    }
    if (size > PAGES_LIMITS.fileBytes) tooLarge.push(f.path)
    await fsp.mkdir(dirname(dest), { recursive: true })
    await fsp.copyFile(src, dest)
    bytes += size
    count++
    if (/\.gltf$/i.test(f.rel)) {
      let deps: string[] = []
      try {
        deps = gltfDependencies(JSON.parse(await fsp.readFile(src, 'utf8')))
      } catch {
        /* unreadable glTF: the viewer reports the model as failed */
      }
      for (const dep of deps) {
        const rel = joinRel(f.rel, dep)
        const path = joinRel(f.path, dep)
        if (rel && path && path.startsWith('assets/')) queue.push({ host: f.host, rel, path })
        else missing.push(`${f.path} → ${dep}`)
      }
    }
  }

  // GitHub Pages runs Jekyll unless told not to (it would drop files starting with "_")
  await fsp.writeFile(join(outDir, '.nojekyll'), '')
  count++

  return { bytes, files: count, missing, tooLarge }
}
