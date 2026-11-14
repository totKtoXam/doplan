/**
 * Project folders: `<Name>/plan.json` + `manifest.json` + `assets/` + `AGENTS.md` (+ `CLAUDE.md`,
 * `.gitignore`, `.gitattributes`), versioned with git (see ./git.ts).
 *
 * The editor keeps working with the single "open project" asset directory (`paths.projectAssets`,
 * served as doplan-asset://project/…): opening a folder copies its `assets/` there, saving copies the
 * referenced files back and drops unreferenced content-addressed ones.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import {
  AGENTS_FILE,
  ASSETS_DIR,
  agentsTemplate,
  CLAUDE_FILE,
  CLAUDE_MD,
  FOLDER_FORMAT_VERSION,
  GITATTRIBUTES,
  GITIGNORE,
  MANIFEST_FILE,
  PLAN_FILE,
  stableStringify,
} from '../shared/projectFormat'
import { atomicWrite, cleanFileName, ensureDir, exists, rmrf } from './fsutil'
import { findGit, gitCommit, gitInit, gitListDir, gitShowFile, isRepo } from './git'
import { paths } from './paths'

export const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** names produced by addProjectAsset: sha256.ext — only these are ever deleted from assets/ */
const HASHED_ASSET_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/

export interface FolderManifest {
  format: 'doplan-folder'
  formatVersion: number
  appVersion: string
  createdAt: string
  plan: string
  assets: { path: string; size: number; sha256: string }[]
}

// ───────────── current project root (main-side source of truth for the AI chat) ─────────────

let currentRoot: string | null = null
/** sha256 of plan.json as last read or written by the app, per root (lower-cased) */
const knownPlanHash = new Map<string, string>()

export function getProjectRoot(): string | null {
  return currentRoot
}

export function setProjectRoot(root: string | null): void {
  currentRoot = root ? resolve(root) : null
}

const key = (root: string) => resolve(root).toLowerCase()
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

export function docName(doc: unknown): string | undefined {
  const name = (doc as { meta?: { name?: unknown } } | null)?.meta?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

export function parseJsonText(bytes: Uint8Array): unknown {
  let text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Файл повреждён: некорректный JSON (${(err as Error).message})`)
  }
}

export function referencedAssets(json: string): string[] {
  const out = new Set<string>()
  const re = /doplan-asset:\/\/project\/([A-Za-z0-9][A-Za-z0-9._%-]{0,200})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(json))) {
    let name = m[1]
    try {
      name = decodeURIComponent(name)
    } catch {
      continue
    }
    if (ASSET_NAME_RE.test(name)) out.add(name)
  }
  return [...out]
}

// ───────────── detection ─────────────

/**
 * Resolves a user path to a project folder root: the folder itself, or the folder of a `plan.json`.
 * Returns null for anything else (a .doplan archive, a PlanSpec .json…).
 */
export async function folderRootOf(p: string): Promise<string | null> {
  let st: import('node:fs').Stats
  try {
    st = await fsp.stat(p)
  } catch {
    return null
  }
  if (st.isDirectory()) return (await exists(join(p, PLAN_FILE))) ? resolve(p) : null
  if (basename(p).toLowerCase() === PLAN_FILE) return resolve(dirname(p))
  return null
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// ───────────── read ─────────────

/** reads plan.json and loads the folder's assets into the open-project asset directory */
export async function readFolderProject(root: string): Promise<unknown> {
  const planPath = join(root, PLAN_FILE)
  const bytes = new Uint8Array(await fsp.readFile(planPath))
  const manifestPath = join(root, MANIFEST_FILE)
  if (await exists(manifestPath)) {
    const m = parseJsonText(new Uint8Array(await fsp.readFile(manifestPath))) as Partial<FolderManifest> | null
    if (m && typeof m.formatVersion === 'number' && m.formatVersion > FOLDER_FORMAT_VERSION) {
      throw new Error('Проект создан более новой версией doplan. Обновите приложение.')
    }
  }
  const doc = parseJsonText(bytes)
  await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
  const assetsDir = join(root, ASSETS_DIR)
  let names: string[] = []
  try {
    names = await fsp.readdir(assetsDir)
  } catch {
    /* no assets */
  }
  for (const name of names) {
    if (!ASSET_NAME_RE.test(name)) continue
    const from = join(assetsDir, name)
    try {
      if (!(await fsp.stat(from)).isFile()) continue
      await fsp.copyFile(from, join(paths.projectAssets, name))
    } catch (err) {
      console.warn('[doplan] asset copy failed', name, err)
    }
  }
  knownPlanHash.set(key(root), sha256(bytes))
  return doc
}

/** remembers the on-disk plan.json as "seen" (e.g. after restoring a recovery snapshot of this folder) */
export async function rememberPlanOnDisk(root: string): Promise<void> {
  try {
    knownPlanHash.set(key(root), sha256(new Uint8Array(await fsp.readFile(join(root, PLAN_FILE)))))
  } catch {
    knownPlanHash.delete(key(root))
  }
}

/** true when plan.json on disk differs from what the app last read or wrote */
export async function planChangedOnDisk(root: string): Promise<boolean> {
  const known = knownPlanHash.get(key(root))
  if (!known) return false
  try {
    return sha256(new Uint8Array(await fsp.readFile(join(root, PLAN_FILE)))) !== known
  } catch {
    return false
  }
}

// ───────────── write ─────────────

async function writeIfMissing(file: string, content: string): Promise<void> {
  if (!(await exists(file))) await atomicWrite(file, content)
}

async function writeScaffold(root: string, name: string): Promise<void> {
  await writeIfMissing(join(root, AGENTS_FILE), agentsTemplate(name))
  await writeIfMissing(join(root, CLAUDE_FILE), CLAUDE_MD)
  await writeIfMissing(join(root, '.gitignore'), GITIGNORE)
  await writeIfMissing(join(root, '.gitattributes'), GITATTRIBUTES)
}

/** writes plan.json, manifest.json and assets/ (missing scaffold files are recreated) */
export async function writeFolderProject(root: string, doc: unknown): Promise<void> {
  const plan = stableStringify(doc)
  const compact = JSON.stringify(doc)
  await ensureDir(root)
  await writeScaffold(root, docName(doc) ?? basename(root))

  // assets: copy what the document references, drop content-addressed files it no longer uses
  const assetsDir = join(root, ASSETS_DIR)
  const wanted = new Set(referencedAssets(compact))
  const manifestAssets: FolderManifest['assets'] = []
  if (wanted.size) await ensureDir(assetsDir)
  for (const name of [...wanted].sort()) {
    const src = join(paths.projectAssets, name)
    const dst = join(assetsDir, name)
    let data: Buffer | null = null
    try {
      data = await fsp.readFile(src)
    } catch {
      try {
        data = await fsp.readFile(dst) // already in the folder (e.g. added by hand)
      } catch {
        continue // missing asset: the document still opens, the reference just 404s
      }
    }
    if (!(await exists(dst))) await atomicWrite(dst, data)
    manifestAssets.push({ path: `${ASSETS_DIR}/${name}`, size: data.length, sha256: sha256(data) })
  }
  try {
    for (const name of await fsp.readdir(assetsDir)) {
      if (HASHED_ASSET_RE.test(name) && !wanted.has(name)) await fsp.rm(join(assetsDir, name), { force: true })
    }
    if (!wanted.size && !(await fsp.readdir(assetsDir)).length) await fsp.rmdir(assetsDir)
  } catch {
    /* no assets dir */
  }

  const meta = (doc as { meta?: { createdAt?: unknown } } | null)?.meta
  const manifest: FolderManifest = {
    format: 'doplan-folder',
    formatVersion: FOLDER_FORMAT_VERSION,
    appVersion: app.getVersion(),
    createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : new Date().toISOString(),
    plan: PLAN_FILE,
    assets: manifestAssets,
  }
  await atomicWrite(join(root, MANIFEST_FILE), stableStringify(manifest))
  await atomicWrite(join(root, PLAN_FILE), plan)
  knownPlanHash.set(key(root), sha256(plan))
}

/** git commit of the whole folder; null when git is missing or nothing changed */
export async function commitFolder(root: string, message: string, onlyPaths?: string[]): Promise<string | null> {
  if (!(await findGit())) return null
  if (!(await isRepo(root))) await gitInit(root)
  return gitCommit(root, message, onlyPaths)
}

export interface CreateResult {
  root: string
  git: boolean
  commit: string | null
}

/** creates `<parent>/<name>/` with the scaffold, plan.json, assets, `git init` and the first commit */
export async function createFolderProject(parent: string, name: string, doc: unknown): Promise<CreateResult> {
  const folderName = cleanFileName(name, 'Проект')
  const root = resolve(join(parent, folderName))
  if (await exists(root)) {
    const entries = await fsp.readdir(root).catch(() => ['?'])
    if (entries.length) throw new Error(`Папка «${folderName}» уже существует и не пуста. Выберите другое название или место.`)
  }
  await ensureDir(root)
  await writeFolderProject(root, doc)
  let commit: string | null = null
  let git = false
  try {
    if (await findGit()) {
      await gitInit(root)
      git = true
      commit = await gitCommit(root, `Создан проект «${docName(doc) ?? name}»`)
    }
  } catch (err) {
    console.warn('[doplan] git init failed', err)
  }
  return { root, git, commit }
}

// ───────────── instructions ─────────────

export async function readInstructions(root: string): Promise<string> {
  try {
    let text = await fsp.readFile(join(root, AGENTS_FILE), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return text
  } catch {
    return ''
  }
}

export async function writeInstructions(root: string, text: string): Promise<string | null> {
  const normalized = text.replace(/\r\n?/g, '\n')
  await atomicWrite(join(root, AGENTS_FILE), normalized.endsWith('\n') ? normalized : `${normalized}\n`)
  await writeIfMissing(join(root, CLAUDE_FILE), CLAUDE_MD)
  try {
    return await commitFolder(root, 'Инструкции для ИИ', [AGENTS_FILE])
  } catch (err) {
    console.warn('[doplan] commit of AGENTS.md failed', err)
    return null
  }
}

// ───────────── old versions ─────────────

/** plan.json of a commit; its assets are copied into the open-project asset directory */
export async function readVersion(root: string, sha: string): Promise<unknown> {
  const plan = await gitShowFile(root, sha, PLAN_FILE)
  if (!plan) throw new Error('В этой версии нет plan.json')
  const doc = parseJsonText(new Uint8Array(plan))
  await ensureDir(paths.projectAssets)
  const wanted = new Set(referencedAssets(JSON.stringify(doc)))
  for (const name of await gitListDir(root, sha, ASSETS_DIR)) {
    if (!wanted.has(name) || !ASSET_NAME_RE.test(name)) continue
    const dst = join(paths.projectAssets, name)
    if (await exists(dst)) continue
    const data = await gitShowFile(root, sha, `${ASSETS_DIR}/${name}`)
    if (data) await atomicWrite(dst, data)
  }
  return doc
}

export function defaultProjectsDir(): string {
  return join(app.getPath('documents'), 'doplan')
}
