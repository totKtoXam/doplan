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
import type { UnsafeGitConfig } from '../shared/ipc'
import { findGit, gitCommit, gitInit, gitListDir, gitShowFile, resetRepoConfig, unsafeRepoConfig } from './git'
import { paths } from './paths'
import { msg, setTrustRecord, trustRecord } from './settings'

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
    throw new Error(msg(`Файл повреждён: некорректный JSON (${(err as Error).message})`, `The file is damaged: invalid JSON (${(err as Error).message})`))
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
 * true when `dir` is a doplan project folder: it has plan.json and a manifest.json of format
 * 'doplan-folder'. A stray plan.json (Downloads, a web app with its own manifest.json) is not a project.
 */
export async function isProjectFolder(dir: string): Promise<boolean> {
  if (!(await exists(join(dir, PLAN_FILE)))) return false
  try {
    const raw = await fsp.readFile(join(dir, MANIFEST_FILE))
    if (raw.length > 4 * 1024 * 1024) return false
    const m = parseJsonText(new Uint8Array(raw)) as Partial<FolderManifest> | null
    return !!m && typeof m === 'object' && m.format === 'doplan-folder'
  } catch {
    return false
  }
}

/**
 * Resolves a user path to a project folder root: the folder itself, or the folder of a `plan.json`,
 * when that folder is a doplan project folder (see isProjectFolder). Returns null for anything else
 * (a .doplan archive, a PlanSpec .json, a plan.json that is not inside a project folder…).
 */
export async function folderRootOf(p: string): Promise<string | null> {
  let st: import('node:fs').Stats
  try {
    st = await fsp.stat(p)
  } catch {
    return null
  }
  const dir = st.isDirectory() ? p : basename(p).toLowerCase() === PLAN_FILE ? dirname(p) : null
  if (!dir) return null
  return (await isProjectFolder(dir)) ? resolve(dir) : null
}

// ───────────── trust ─────────────

/** what `.git` in a folder is: nothing, a repository directory, or a gitdir file (submodule, worktree) */
export async function gitState(root: string): Promise<'none' | 'repo' | 'gitfile'> {
  try {
    return (await fsp.lstat(join(root, '.git'))).isDirectory() ? 'repo' : 'gitfile'
  } catch {
    return 'none'
  }
}

async function entryId(p: string, link: boolean): Promise<string> {
  const st = link ? await fsp.lstat(p, { bigint: true }) : await fsp.stat(p, { bigint: true })
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`
}

/**
 * Identity of a project folder on disk: the folder and its `.git` (device, file id, creation time).
 * A folder deleted and replaced by another one at the same path (a received copy unpacked over a
 * trusted project) gets a different identity, and so loses the trust recorded for the old one.
 */
export async function folderIdentity(root: string): Promise<string> {
  const dir = await entryId(root, false)
  let git = '-'
  try {
    git = await entryId(join(root, '.git'), true)
  } catch {
    /* no .git */
  }
  return `${dir}|${git}`
}

export interface FolderTrust {
  /**
   * 'none': no repository yet (doplan creates one on save); 'trusted': created by doplan or confirmed by
   * the user; 'untrusted': a repository that came with the folder; 'gitfile': .git is a file (submodule,
   * worktree) — doplan keeps no history there. Git may run programs named in a repository's own config
   * (filters, fsmonitor…), so doplan runs no git command in a repository it does not trust.
   */
  git: 'none' | 'trusted' | 'untrusted' | 'gitfile'
  /**
   * the folder itself is trusted (doplan created it or the user confirmed it): the AI agent may run
   * inside it, where it reads the folder's own settings (.claude/, .codex/, .gemini/) and runs git.
   */
  folder: boolean
  /**
   * a repository whose own config has keys outside doplan's allowlist (git.unsafeRepoConfig): no git
   * command runs there, trusted or not, until the user resets the config (resetFolderGitConfig)
   */
  unsafeGit?: UnsafeGitConfig
}

export async function folderTrust(root: string): Promise<FolderTrust> {
  const state = await gitState(root)
  const rec = await trustRecord(root)
  let same = false
  if (rec) {
    try {
      same = rec.id === (await folderIdentity(root))
    } catch {
      same = false
    }
  }
  const git = state === 'none' ? 'none' : state === 'gitfile' ? 'gitfile' : same ? 'trusted' : 'untrusted'
  const unsafe = state === 'repo' && (await findGit()) ? await unsafeRepoConfig(root) : null
  return unsafe ? { git, folder: same && rec!.folder, unsafeGit: unsafe } : { git, folder: same && rec!.folder }
}

/** true when the AI agent may run inside this folder (see FolderTrust.folder) */
export async function isFolderTrusted(root: string): Promise<boolean> {
  return (await folderTrust(root)).folder
}

/** records the folder as it is on disk now; `folder`: the user (or doplan, having created it) trusts the folder itself */
export async function trustFolder(root: string, folder = true): Promise<void> {
  await setTrustRecord(root, await folderIdentity(root), folder)
}

export function untrustedError(): Error {
  return new Error(
    msg(
      'История версий этой папки не подтверждена: репозиторий git пришёл вместе с папкой. Откройте «История версий» и нажмите «Доверять этой папке».',
      'The version history of this folder is not trusted: its git repository came with the folder. Open Version history and choose “Trust this folder”.',
    ),
  )
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// ───────────── read ─────────────

/**
 * Reads plan.json of a project folder. Does not touch the open-project state: the assets are loaded
 * by loadFolderAssets once the renderer has accepted the document.
 */
export async function readFolderPlan(root: string): Promise<unknown> {
  const planPath = join(root, PLAN_FILE)
  const bytes = new Uint8Array(await fsp.readFile(planPath))
  const manifestPath = join(root, MANIFEST_FILE)
  if (await exists(manifestPath)) {
    const m = parseJsonText(new Uint8Array(await fsp.readFile(manifestPath))) as Partial<FolderManifest> | null
    if (m && typeof m.formatVersion === 'number' && m.formatVersion > FOLDER_FORMAT_VERSION) {
      throw new Error(msg('Проект создан более новой версией doplan. Обновите приложение.', 'The project was made by a newer doplan. Please update the app.'))
    }
  }
  const doc = parseJsonText(bytes)
  knownPlanHash.set(key(root), sha256(bytes))
  return doc
}

/** replaces the open-project asset directory with the folder's assets/ */
export async function loadFolderAssets(root: string): Promise<void> {
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

/**
 * git commit of the whole folder; null when git is missing, nothing changed or .git is a file (no
 * history there) or its git config is unsafe (FolderTrust.unsafeGit). Throws for an untrusted repository.
 * A folder without a repository gets one: git init creates a fresh config, so nothing from the folder runs.
 */
export async function commitFolder(root: string, message: string, onlyPaths?: string[]): Promise<string | null> {
  if (!(await findGit())) return null
  const trust = await folderTrust(root)
  if (trust.git === 'untrusted') throw untrustedError()
  if (trust.git === 'gitfile') return null
  // the user works without versions there (or has not reset the config yet): the files are saved, nothing else
  if (trust.unsafeGit) return null
  if (trust.git === 'none') {
    await gitInit(root)
    await trustFolder(root, trust.folder)
  }
  return gitCommit(root, message, onlyPaths)
}

/**
 * The user resets the git config of a trusted folder to the allowed keys (the old one is kept as
 * .git/config.doplan-backup). Returns the backup path.
 */
export async function resetFolderGitConfig(root: string): Promise<string> {
  if ((await folderTrust(root)).git !== 'trusted') throw untrustedError()
  return resetRepoConfig(root)
}

export interface CreateResult {
  root: string
  git: boolean
  commit: string | null
}

/** folders being created right now: a second request for the same folder fails instead of racing */
const creating = new Set<string>()

/** creates `<parent>/<name>/` with the scaffold, plan.json, assets, `git init` and the first commit */
export async function createFolderProject(parent: string, name: string, doc: unknown): Promise<CreateResult> {
  const folderName = cleanFileName(name, msg('Проект', 'Project'))
  const root = resolve(join(parent, folderName))
  const notEmpty = msg(
    `Папка «${folderName}» уже существует и не пуста. Выберите другое название или место.`,
    `Folder “${folderName}” already exists and is not empty. Choose another name or location.`,
  )
  if (creating.has(key(root))) throw new Error(notEmpty)
  creating.add(key(root))
  try {
    return await createFolderProjectAt(root, name, doc, notEmpty)
  } finally {
    creating.delete(key(root))
  }
}

async function createFolderProjectAt(root: string, name: string, doc: unknown, notEmpty: string): Promise<CreateResult> {
  if (await exists(root)) {
    const entries = await fsp.readdir(root).catch(() => ['?'])
    if (entries.length) throw new Error(notEmpty)
  }
  await ensureDir(root)
  await writeFolderProject(root, doc)
  await trustFolder(root)
  let commit: string | null = null
  let git = false
  try {
    if (await findGit()) {
      await gitInit(root)
      await trustFolder(root)
      git = true
      commit = await gitCommit(root, msg(`Создан проект «${docName(doc) ?? name}»`, `Created project “${docName(doc) ?? name}”`))
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
    return await commitFolder(root, msg('Инструкции для ИИ', 'AI instructions'), [AGENTS_FILE])
  } catch (err) {
    console.warn('[doplan] commit of AGENTS.md failed', err)
    return null
  }
}

// ───────────── old versions ─────────────

/** plan.json of a commit; its assets are copied into the open-project asset directory */
export async function readVersion(root: string, sha: string): Promise<unknown> {
  if ((await folderTrust(root)).git !== 'trusted') throw untrustedError()
  const plan = await gitShowFile(root, sha, PLAN_FILE)
  if (!plan) throw new Error(msg('В этой версии нет plan.json', 'This version has no plan.json'))
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
