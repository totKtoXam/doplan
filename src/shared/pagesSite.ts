/**
 * Published plan viewer (GitHub Pages): what goes into the static site of one plan.
 *
 * A plan folder is self-contained:
 *   index.html, viewer/…       the read-only viewer build (out/viewer), a copy per plan
 *   view-plan.json             the document, every doplan-asset:// URL rewritten to ./assets/…
 *   view-catalog.json          only the catalog entries the plan uses (builtin ones excluded)
 *   view-site.json             title, publish time, content hash, app version
 *   assets/c/…  assets/l/…  assets/p/…   files of the bundled pack, the user library, the project
 *
 * Pure functions only (shared by main, renderer and tests); copying and pushing live in main.
 */

export const SITE_FILES = { plan: 'view-plan.json', catalog: 'view-catalog.json', site: 'view-site.json' } as const

/** GitHub Pages limits: a published site ≤ 1 GB, a single file in a git push ≤ 100 MB */
export const PAGES_LIMITS = { siteBytes: 1024 ** 3, fileBytes: 100 * 1024 ** 2 } as const

/** prefix of rewritten URLs inside view-plan.json / view-catalog.json; the viewer resolves it against the page */
export const SITE_URL_PREFIX = './assets/'

const ASSET_URL = /^doplan-asset:\/\/(catalog|library|project)\/([^?#]*)/
const HOST_DIR: Record<string, string> = { catalog: 'c', library: 'l', project: 'p' }

export type AssetHost = 'catalog' | 'library' | 'project'

export interface SiteFile {
  /** source: host + path relative to that host's root (decoded, forward slashes) */
  host: AssetHost
  rel: string
  /** destination inside the plan folder, e.g. `assets/c/models/x/x.glb` */
  path: string
}

/** a clean relative path: no empty, `.` or `..` segments, no drive letters or backslashes */
export function safeRel(rel: string): string | null {
  if (!rel || rel.includes('\\') || rel.includes('\0') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return rel
}

/** `doplan-asset://catalog/models/a%20b.glb?v=2` → { host, rel: 'models/a b.glb', path: 'assets/c/models/a b.glb' } */
export function siteFileOf(url: string): SiteFile | null {
  const m = ASSET_URL.exec(url)
  if (!m) return null
  let rel: string
  try {
    rel = m[2]
      .split('/')
      .map((p) => decodeURIComponent(p))
      .join('/')
  } catch {
    return null
  }
  const clean = safeRel(rel)
  if (!clean) return null
  const host = m[1] as AssetHost
  return { host, rel: clean, path: `assets/${HOST_DIR[host]}/${clean}` }
}

/** a site path as written into the JSON files (URL-encoded segments, ./ prefix) */
export function siteUrlOf(path: string): string {
  return `./${path.split('/').map(encodeURIComponent).join('/')}`
}

/** every string anywhere inside a JSON-like value */
export function collectStrings(value: unknown, out: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [value]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') out.add(v)
    else if (Array.isArray(v)) for (const x of v) stack.push(x)
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) stack.push(x)
  }
  return out
}

/** deep copy with every string passed through `fn` */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x)
      return o
    }
    return v
  }
  return walk(value) as T
}

interface Entry {
  id: string
  src?: string
  thumb?: string
  slots?: Record<string, string>
  defaultParams?: Record<string, unknown>
  remote?: boolean
}

export interface CatalogLike {
  version?: number
  materials: Entry[]
  assets: Entry[]
  hdris: Entry[]
}

export interface SiteContent {
  /** view-plan.json */
  doc: unknown
  /** view-catalog.json (used, non-builtin entries) */
  catalog: { version: number; materials: unknown[]; assets: unknown[]; hdris: unknown[] }
  /** files to copy, de-duplicated by destination */
  files: SiteFile[]
  /** catalog entries the plan uses that are not downloaded yet (their files cannot be copied) */
  notDownloaded: string[]
}

/**
 * The plan's site content: which catalog entries it uses (ids mentioned anywhere in the document,
 * plus the default materials of the models used), with every doplan-asset:// URL rewritten to a
 * relative site URL and listed in `files`. Thumbnails of catalog entries are dropped (the viewer has
 * no catalog browser). `builtinIds` are entries every viewer already has (colours, procedural models).
 */
export function planSite(doc: unknown, catalog: CatalogLike, builtinIds: ReadonlySet<string> = new Set()): SiteContent {
  const used = collectStrings(doc)
  const pick = (list: Entry[]) => list.filter((e) => e && typeof e.id === 'string' && used.has(e.id) && !builtinIds.has(e.id))

  const assets = pick(catalog.assets ?? [])
  // a model's default slot materials are used even when the item does not override them
  for (const a of assets) {
    for (const v of Object.values(a.slots ?? {})) if (typeof v === 'string') used.add(v)
    for (const v of Object.values(a.defaultParams ?? {})) if (typeof v === 'string') used.add(v)
  }
  const materials = pick(catalog.materials ?? [])
  const hdris = pick(catalog.hdris ?? [])

  const files = new Map<string, SiteFile>()
  const rewrite = (s: string): string => {
    const f = siteFileOf(s)
    if (!f) return s
    if (!files.has(f.path)) files.set(f.path, f)
    return siteUrlOf(f.path)
  }
  const stripThumb = (e: Entry): Entry => {
    const { thumb: _thumb, ...rest } = e
    return rest
  }
  const notDownloaded = [...assets, ...materials, ...hdris].filter((e) => e.remote).map((e) => e.id)

  return {
    doc: mapStrings(doc, rewrite),
    catalog: {
      version: catalog.version ?? 1,
      materials: materials.map((e) => mapStrings(stripThumb(e), rewrite)),
      assets: assets.map((e) => mapStrings(stripThumb(e), rewrite)),
      hdris: hdris.map((e) => mapStrings(stripThumb(e), rewrite)),
    },
    files: [...files.values()],
    notDownloaded,
  }
}

/** relative file URIs a .gltf (JSON) depends on: buffers and images, data: URIs excluded */
export function gltfDependencies(json: unknown): string[] {
  const out: string[] = []
  const o = (json ?? {}) as { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] }
  for (const list of [o.buffers, o.images]) {
    if (!Array.isArray(list)) continue
    for (const x of list) {
      const uri = x?.uri
      if (typeof uri !== 'string' || !uri || /^[a-z][a-z0-9+.-]*:/i.test(uri)) continue
      let rel: string
      try {
        rel = decodeURIComponent(uri.split(/[?#]/)[0])
      } catch {
        continue
      }
      if (!out.includes(rel)) out.push(rel)
    }
  }
  return out
}

/** `dir/a.gltf` + `../tex/b.png` → `tex/b.png`; null when it climbs out of the root */
export function joinRel(base: string, rel: string): string | null {
  const parts = base.split('/').slice(0, -1)
  for (const p of rel.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(p)
  }
  return parts.length ? parts.join('/') : null
}

// ───────────── identity of a publication ─────────────

/** 53-bit string hash (cyrb53), hex; stable across runs and platforms */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** canonical JSON (sorted keys) so equal documents hash equally whatever the key order */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** what the viewer shows of a document: everything but the modification stamp */
export function docContentHash(doc: unknown): string {
  const d = (doc ?? {}) as { meta?: Record<string, unknown> }
  const meta = d.meta ? { ...d.meta, modifiedAt: undefined } : undefined
  return hashString(canonical({ ...d, meta }))
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ә: 'a', ғ: 'g', қ: 'k',
  ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
}

/**
 * Readable slug of a plan: a part from the project name plus a short suffix from its stable id, so
 * two projects with one name do not collide (the base of the separate `…-view` repository name when
 * the project has no repository of its own). `[a-z0-9-]`, at most 48 characters.
 */
export function planSlug(name: string, id: string): string {
  const latin = (name || '')
    .toLowerCase()
    .split('')
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const suffix = hashString(id || name || 'plan').slice(-6)
  return `${latin || 'plan'}-${suffix}`
}

export type ViewerView = '2d' | '3d'
export type ViewerCam = 'orbit' | 'walk' | 'top'

export interface ViewerParams {
  view: ViewerView
  cam: ViewerCam
  /** level id, when the plan has several */
  level?: string
}

export const DEFAULT_VIEWER_PARAMS: ViewerParams = { view: '3d', cam: 'orbit' }

/** `?view=3d&cam=walk&level=…` of a viewer URL; unknown values fall back to the defaults */
export function parseViewerParams(search: string): ViewerParams {
  const q = new URLSearchParams(search)
  const view = q.get('view')
  const cam = q.get('cam')
  const level = q.get('level')
  return {
    view: view === '2d' || view === '3d' ? view : DEFAULT_VIEWER_PARAMS.view,
    cam: cam === 'orbit' || cam === 'walk' || cam === 'top' ? cam : DEFAULT_VIEWER_PARAMS.cam,
    ...(level ? { level } : {}),
  }
}

/** the query string for `p` (defaults omitted, so the plain link stays short) */
export function viewerQuery(p: ViewerParams): string {
  const q = new URLSearchParams()
  if (p.view !== DEFAULT_VIEWER_PARAMS.view) q.set('view', p.view)
  if (p.view === '3d' && p.cam !== DEFAULT_VIEWER_PARAMS.cam) q.set('cam', p.cam)
  if (p.level) q.set('level', p.level)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** view-site.json */
export interface SiteInfo {
  title: string
  publishedAt: string
  contentHash: string
  app: string
}

// ───────────── GitHub repositories and Pages ─────────────

export interface RepoRef {
  owner: string
  repo: string
}

/** owner/repo of a github.com remote URL (https, ssh, scp-like git@…), or null */
export function parseGithubRemote(url: string): RepoRef | null {
  const s = url.trim()
  const m =
    /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s) ??
    /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s)
  if (!m) return null
  const [owner, repo] = [m[1], m[2]]
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !isValidRepoName(repo)) return null
  return { owner, repo }
}

/** url of the "origin" remote in the text of a .git/config, or null */
export function originUrlFromGitConfig(text: string): string | null {
  let inOrigin = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line)
    if (sec) {
      inOrigin = sec[1].toLowerCase() === 'remote' && sec[2] === 'origin'
      continue
    }
    if (!inOrigin) continue
    const kv = /^url\s*=\s*(.*)$/i.exec(line)
    if (kv) return kv[1].replace(/^"(.*)"$/, '$1').trim() || null
  }
  return null
}

export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name)
}

/** https://owner.github.io/repo/ (the user site repository `<owner>.github.io` is served at the root) */
export function pagesUrlOf(ref: RepoRef): string {
  const host = `${ref.owner.toLowerCase()}.github.io`
  return ref.repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${encodeURIComponent(ref.repo)}/`
}

/** name of the separate public repository that carries only the site: `<project repo or slug>-view` */
export function viewRepoName(base: string): string {
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 90) || 'plan'
  return `${clean}-view`
}

/** the branch that holds the published site (orphan, one commit, force-pushed) */
export const PAGES_BRANCH = 'gh-pages'

/** a published plan, remembered by the app per document id */
export interface PagesRecord {
  owner: string
  repo: string
  url: string
  contentHash: string
  publishedAt: string
  /** the site lives in a repository of its own (`…-view`), not in the project's */
  separate: boolean
}

export type PagesTargetKind = 'project' | 'separate'

/** where the plan would be published and what is in the way */
export interface PagesTarget {
  kind: PagesTargetKind
  ref: RepoRef
  /** the repository exists on GitHub */
  exists: boolean
  isPrivate: boolean
  /** a private repository on GitHub Free cannot have Pages: the user has to choose */
  needsChoice: boolean
}

export interface PagesStatus {
  gh: { installed: boolean; loggedIn: boolean; user?: string }
  git: boolean
  record: PagesRecord | null
  /** the plan changed since it was published */
  outdated: boolean
  /** null: no GitHub repository found for the project (a separate one is offered) */
  project: PagesTarget | null
  /** the name a separate public repository would get */
  separateName: string
  plan?: string
}

/** how to deal with a private project repository on GitHub Free */
export type PagesPrivateChoice = 'makePublic' | 'separate'

export interface PagesPublishRequest {
  docId: string
  content: SiteContent
  info: SiteInfo
  /** where to publish: the project repository or a separate public one */
  target: PagesTargetKind
  /** given for a private project repository on GitHub Free */
  privateChoice?: PagesPrivateChoice
}

export interface PagesPublishResult {
  record: PagesRecord
  bytes: number
  files: number
  missing: string[]
}

export interface PagesProgress {
  step: 'build' | 'repo' | 'push' | 'pages' | 'done'
}

export interface PagesStatusQuery {
  docId: string
  /** docContentHash of the current plan (compared with the published one) */
  contentHash: string
  /** plan name (gives the separate repository its name) */
  name: string
  /** ask GitHub again instead of the cached sign-in state */
  fresh?: boolean
}

/** window.doplan.pages */
export interface PagesApi {
  status(q: PagesStatusQuery): Promise<PagesStatus>
  publish(req: PagesPublishRequest): Promise<PagesPublishResult>
  unpublish(docId: string): Promise<void>
  onProgress(cb: (p: PagesProgress) => void): () => void
  /** opens a GitHub page or the published site in the system browser */
  openUrl(url: string): Promise<void>
}
