import { createHash } from 'node:crypto'
import { lstatSync, promises as fsp } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { app, dialog } from 'electron'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { AppSettings, ProjectInfo, ProjectOpenResult, ProjectSaveOptions, ProjectSaveResult, ProjectVersion } from '../shared/ipc'
import { PLAN_FILE, tagNameFrom } from '../shared/projectFormat'
import { assertReadable, grantPath } from './access'
import { atomicWrite, cleanExt, cleanFileName, ensureDir, exists, readJson, rmrf, toBytes } from './fsutil'
import { findGit, gitLog, gitTag, gitVersion } from './git'
import { withSyncLock } from './syncLock'
import {
  ASSET_NAME_RE,
  commitFolder,
  createFolderProject,
  defaultProjectsDir,
  docName,
  folderAssetLinks,
  folderRootOf,
  folderTrust,
  getProjectRoot,
  isDirectory,
  isLinkAt,
  linkedFileError,
  loadFolderAssets,
  parseJsonText,
  planChangedOnDisk,
  planReadCount,
  readFolderPlan,
  readPickedFile,
  readInstructions,
  readVersion,
  referencedAssets,
  resetFolderGitConfig,
  rememberPlanOnDisk,
  setProjectRoot,
  trustFolder,
  untrustedError,
  writeFolderProject,
  writeInstructions,
} from './projectFolder'
import { paths } from './paths'
import { addRecent, getProjectsDir, msg, setProjectsDir } from './settings'
import { getMainWindow } from './window'

const FORMAT_VERSION = 1
const MAX_PROJECT_BYTES = 2 * 1024 * 1024 * 1024
const PROJECT_URL = 'doplan-asset://project/'
const STORED_EXT = new Set(['glb', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'ktx2', 'gif', 'mp4', 'webm', 'zip', 'hdr', 'exr'])

interface Manifest {
  format: 'doplan'
  formatVersion: number
  appVersion: string
  createdAt: string
  modifiedAt: string
  assets: { path: string; size: number; sha256: string }[]
}

interface RecoveryFile {
  path: string | null
  savedAt: string
  doc: unknown
}

const recoveryFile = () => join(paths.recovery, 'recovery.json')
/** assets of a .doplan that was read but not yet accepted by the renderer */
const stagedAssetsDir = () => `${paths.projectAssets}-pending`

const notProjectFolder = () =>
  msg(
    'Это не папка проекта doplan: в ней нет plan.json и manifest.json формата doplan.',
    'This is not a doplan project folder: it has no plan.json and doplan manifest.json.',
  )
const newerVersion = () => msg('Проект создан более новой версией doplan. Обновите приложение.', 'The project was made by a newer doplan. Please update the app.')

/** startup housekeeping: keep embedded assets only if a crash-recovery snapshot needs them */
export async function initProjectStore(): Promise<void> {
  await ensureDir(paths.recovery)
  if (!(await exists(recoveryFile()))) await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
  await rmrf(stagedAssetsDir())
}

export async function resetProjectAssets(): Promise<void> {
  await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
  setProjectRoot(null)
}

function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6)
}

async function showOpen(opts: Electron.OpenDialogOptions): Promise<string | null> {
  const w = getMainWindow()
  const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  grantPath(res.filePaths[0])
  return res.filePaths[0]
}

// ───────────── open (two steps: read → renderer validates → attach) ─────────────

/**
 * The last project read by open()/openFolder(). Nothing of the open-project state (root, asset
 * directory, recent list) changes until the renderer has parsed the document and calls
 * attach(path): a document the renderer rejects leaves the current project untouched.
 */
interface PendingOpen {
  path: string
  root: string | null
  /** directory with the assets unpacked from a .doplan */
  staged: string | null
  name: string | undefined
}
let pendingOpen: PendingOpen | null = null

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

async function openFolderAt(root: string): Promise<ProjectOpenResult> {
  const doc = await readFolderPlan(root)
  grantPath(root)
  pendingOpen = { path: root, root, staged: null, name: docName(doc) }
  const trust = await folderTrust(root)
  // no repository yet: doplan creates one on the first save (only in a folder doplan made or the user trusted)
  const git = (trust.git === 'trusted' || trust.git === 'none') && !trust.unsafeGit && !!(await findGit())
  const res: ProjectOpenResult = { path: root, doc, kind: 'folder', git, untrustedGit: trust.git === 'untrusted', gitFile: trust.git === 'gitfile' }
  if (trust.git === 'unknown') res.untrustedFolder = true
  if (trust.unsafeGit) res.unsafeGit = trust.unsafeGit
  const links = await folderAssetLinks(root)
  if (links.length) res.linkedAssets = links
  return res
}

export async function openProject(pathArg?: unknown): Promise<ProjectOpenResult | null> {
  let path: string
  if (typeof pathArg === 'string' && pathArg) {
    path = await assertReadable(pathArg)
  } else {
    const chosen = await showOpen({
      title: msg('Открыть проект', 'Open project'),
      properties: ['openFile'],
      filters: [
        { name: msg('Проект doplan (plan.json, .doplan)', 'doplan project (plan.json, .doplan)'), extensions: ['json', 'doplan'] },
        { name: msg('Все файлы', 'All files'), extensions: ['*'] },
      ],
    })
    if (!chosen) return null
    path = chosen
  }

  // a project file (.doplan, .json, plan.json) that is a link is refused before anything stats or reads through it
  if (/\.(json|doplan)$/i.test(path) && (await isLinkAt(path))) throw linkedFileError(path)
  const root = await folderRootOf(path)
  if (root) return openFolderAt(root)
  if (await isDirectory(path)) throw new Error(notProjectFolder())

  const tooLarge = () => new Error(msg('Файл проекта слишком большой', 'The project file is too large'))
  const buf = new Uint8Array(await readPickedFile(path, MAX_PROJECT_BYTES, tooLarge))
  let doc: unknown
  const zip = isZip(buf)
  let staged: string | null = null
  if (zip) {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(buf)
    } catch (err) {
      throw new Error(msg(`Не удалось распаковать проект: ${(err as Error).message}`, `Could not unpack the project: ${(err as Error).message}`))
    }
    const docBytes = files['doc.json'] ?? files['scene.json']
    if (!docBytes) throw new Error(msg('В архиве проекта нет doc.json', 'The project archive has no doc.json'))
    const manifest = files['manifest.json'] ? (parseJsonText(files['manifest.json']) as Partial<Manifest>) : null
    if (manifest && typeof manifest.formatVersion === 'number' && manifest.formatVersion > FORMAT_VERSION) throw new Error(newerVersion())
    doc = parseJsonText(docBytes)
    staged = stagedAssetsDir()
    await rmrf(staged)
    await ensureDir(staged)
    for (const [name, data] of Object.entries(files)) {
      if (!name.startsWith('assets/') || name.endsWith('/')) continue
      const file = name.slice('assets/'.length)
      if (!ASSET_NAME_RE.test(file)) continue
      await fsp.writeFile(join(staged, file), data)
    }
  } else {
    doc = parseJsonText(buf)
  }
  grantPath(path)
  pendingOpen = { path, root: null, staged, name: docName(doc) }
  return { path, doc, kind: zip ? 'zip' : 'json' }
}

export async function openProjectFolder(): Promise<ProjectOpenResult | null> {
  const chosen = await showOpen({ title: msg('Открыть папку проекта', 'Open project folder'), properties: ['openDirectory'] })
  if (!chosen) return null
  const root = await folderRootOf(chosen)
  if (!root) throw new Error(notProjectFolder())
  return openFolderAt(root)
}

async function moveDir(from: string, to: string): Promise<void> {
  await rmrf(to)
  try {
    await fsp.rename(from, to)
  } catch {
    await fsp.cp(from, to, { recursive: true })
    await rmrf(from)
  }
}

/**
 * Makes `path` the open project. For the result of the last open()/openFolder() this loads its assets
 * and sets the root (the renderer calls it after validating the document). Any other path (a recovery
 * snapshot of a folder) only sets the root and keeps the current assets. null detaches the folder.
 */
export async function attachProject(pathArg: unknown): Promise<boolean> {
  if (typeof pathArg !== 'string' || !pathArg) {
    setProjectRoot(null)
    return false
  }
  const path = await assertReadable(pathArg)
  const p = pendingOpen
  if (p && samePath(p.path, path)) {
    pendingOpen = null
    if (p.root) {
      await loadFolderAssets(p.root)
      setProjectRoot(p.root)
      await addRecent(p.root, p.name)
      return true
    }
    if (p.staged) await moveDir(p.staged, paths.projectAssets)
    else await rmrf(paths.projectAssets)
    await ensureDir(paths.projectAssets)
    setProjectRoot(null)
    if (extname(path).toLowerCase() === '.doplan') await addRecent(path, p.name)
    return false
  }
  const root = await folderRootOf(path)
  setProjectRoot(root)
  if (root) await rememberPlanOnDisk(root)
  return !!root
}

// ───────────── save ─────────────

async function buildZip(doc: unknown): Promise<Uint8Array> {
  const json = JSON.stringify(doc)
  if (json === undefined) throw new Error(msg('Пустой документ', 'Empty document'))
  const now = new Date().toISOString()
  const meta = (doc as { meta?: { createdAt?: unknown } } | null)?.meta
  const manifest: Manifest = {
    format: 'doplan',
    formatVersion: FORMAT_VERSION,
    appVersion: app.getVersion(),
    createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : now,
    modifiedAt: now,
    assets: [],
  }
  const zip: Zippable = {}
  const assetDir: Zippable = {}
  for (const name of referencedAssets(json)) {
    const file = join(paths.projectAssets, name)
    let data: Uint8Array
    try {
      data = new Uint8Array(await fsp.readFile(file))
    } catch {
      continue // missing asset: the document still opens, the reference just 404s
    }
    const ext = extname(name).slice(1).toLowerCase()
    assetDir[name] = [data, { level: STORED_EXT.has(ext) ? 0 : 6 }]
    manifest.assets.push({ path: `assets/${name}`, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  zip['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }]
  zip['doc.json'] = [strToU8(json), { level: 6 }]
  if (Object.keys(assetDir).length) zip['assets'] = assetDir
  return zipSync(zip, { mtime: new Date() })
}

async function zipSaveDialog(doc: unknown, suggested: string, title: string): Promise<string | null> {
  const w = getMainWindow()
  const opts: Electron.SaveDialogOptions = {
    title,
    defaultPath: suggested,
    filters: [{ name: msg('Проект doplan', 'doplan project'), extensions: ['doplan'] }],
  }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  let path = res.filePath
  if (extname(path).toLowerCase() !== '.doplan') path += '.doplan'
  return path
}

async function saveFolder(dir: string, doc: unknown, opts: ProjectSaveOptions): Promise<ProjectSaveResult> {
  // only an existing doplan project folder is written here; new folders are made by create()
  // the document comes from the folder as read so far: a read while the save waits is a newer screen
  const readsBefore = planReadCount(dir)
  const root = await folderRootOf(dir)
  if (!root || !samePath(root, dir)) throw new Error(notProjectFolder())
  const openBefore = getProjectRoot()
  // never in the middle of a GitHub action: it may be merging into this very folder (syncLock)
  return withSyncLock(async () => {
    if (!opts.overwrite && (await planChangedOnDisk(root))) return { path: root, externalChange: true }
    // reopened or reloaded meanwhile: that screen shows the file before this write, so its next save asks first
    await writeFolderProject(root, doc, planReadCount(root) === readsBefore)
    // another project opened while this save waited stays the open one
    const openNow = getProjectRoot()
    if (openNow === openBefore || (openNow && openBefore && samePath(openNow, openBefore))) setProjectRoot(root)
    await addRecent(root, docName(doc))
    try {
      const commit = await commitFolder(root, opts.message ?? msg('Сохранение', 'Save'))
      return { path: root, commit }
    } catch (err) {
      console.warn('[doplan] commit failed', err)
      return { path: root, commit: null, commitError: (err as Error).message }
    }
  })
}

export async function saveProject(doc: unknown, pathArg: unknown, optsArg?: unknown): Promise<ProjectSaveResult | null> {
  const opts = (optsArg && typeof optsArg === 'object' ? optsArg : {}) as ProjectSaveOptions
  const saveOpts: ProjectSaveOptions = {
    message: typeof opts.message === 'string' ? opts.message.slice(0, 2000) : undefined,
    overwrite: opts.overwrite === true,
  }
  let path: string | null = null
  if (typeof pathArg === 'string' && pathArg) {
    // only paths the user already chose/opened may be overwritten silently
    path = await assertReadable(pathArg).catch(() => null)
    if (path && (await isDirectory(path))) return saveFolder(path, doc, saveOpts)
  }
  if (!path) {
    const suggested =
      typeof pathArg === 'string' && pathArg
        ? pathArg
        : join(app.getPath('documents'), `${cleanFileName(docName(doc) ?? msg('Проект', 'Project'))}.doplan`)
    path = await zipSaveDialog(doc, suggested, msg('Сохранить проект', 'Save project'))
    if (!path) return null
  }
  if (extname(path).toLowerCase() !== '.doplan') path += '.doplan'
  const bytes = await buildZip(doc)
  await ensureDir(dirname(path))
  await atomicWrite(path, bytes)
  grantPath(path)
  setProjectRoot(null)
  await addRecent(path, docName(doc))
  return { path }
}

/** single-file .doplan copy of the document (sharing); the open project stays as it is */
export async function exportZip(doc: unknown): Promise<string | null> {
  const root = getProjectRoot()
  const base = cleanFileName(docName(doc) ?? msg('Проект', 'Project'))
  const suggested = root ? join(dirname(root), `${base}.doplan`) : join(app.getPath('documents'), `${base}.doplan`)
  const path = await zipSaveDialog(doc, suggested, msg('Экспорт в .doplan', 'Export to .doplan'))
  if (!path) return null
  const bytes = await buildZip(doc)
  await ensureDir(dirname(path))
  await atomicWrite(path, bytes)
  grantPath(path)
  return path
}

// ───────────── project folders ─────────────

/** default parent folder for new projects: Settings → «Папка проектов», else Documents/doplan */
export async function defaultLocation(): Promise<string> {
  return (await getProjectsDir()) ?? defaultProjectsDir()
}

/** folder picker for the default projects folder; stores it in the settings */
export async function pickProjectsDir(): Promise<AppSettings | null> {
  const dir = await showOpen({
    title: msg('Папка проектов по умолчанию', 'Default projects folder'),
    defaultPath: await defaultLocation(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  })
  if (!dir) return null
  await ensureDir(dir)
  return setProjectsDir(dir)
}

export async function pickLocation(defaultPath?: unknown): Promise<string | null> {
  return showOpen({
    title: msg('Где создать папку проекта', 'Where to create the project folder'),
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : await defaultLocation(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  })
}

export async function createProject(doc: unknown, nameArg: unknown, parentArg: unknown): Promise<ProjectOpenResult> {
  const name = typeof nameArg === 'string' ? nameArg.trim() : ''
  if (!name) throw new Error(msg('Укажите название проекта', 'Enter a project name'))
  let parent: string
  if (typeof parentArg === 'string' && parentArg) {
    parent = await assertReadable(parentArg)
  } else {
    parent = await defaultLocation()
  }
  await ensureDir(parent)
  const res = await createFolderProject(parent, name, doc)
  pendingOpen = null
  grantPath(res.root)
  setProjectRoot(res.root)
  await addRecent(res.root, docName(doc) ?? name)
  return { path: res.root, doc, kind: 'folder', git: res.git }
}

export async function projectInfo(): Promise<ProjectInfo> {
  const root = getProjectRoot()
  const gitAvailable = !!(await findGit())
  const trust = root ? await folderTrust(root) : null
  return {
    root,
    gitAvailable,
    repo: gitAvailable && (trust?.git === 'trusted' || trust?.git === 'untrusted'),
    trusted: trust?.git !== 'untrusted' && trust?.git !== 'unknown',
    gitFile: trust?.git === 'gitfile',
    folderTrusted: !!trust?.folder,
    gitVersion: gitVersion(),
    unsafeGit: trust?.unsafeGit ?? null,
  }
}

function requireRoot(): string {
  const root = getProjectRoot()
  if (!root) throw new Error(msg('Проект не сохранён в папку. Сохраните его как папку проекта.', 'The project is not saved as a folder. Save it as a project folder.'))
  return root
}

/** the user trusts the open project folder: its git repository (if it came with one) and the AI agent running in it */
export async function trustProjectFolder(): Promise<boolean> {
  const root = requireRoot()
  if (!(await isDirectory(root))) return false
  await trustFolder(root)
  return true
}

/** the user resets the open folder's git config to the allowed keys (see ProjectInfo.unsafeGit) */
export async function resetProjectGitConfig(): Promise<string> {
  return resetFolderGitConfig(requireRoot())
}

export async function projectInstructions(): Promise<string | null> {
  const root = getProjectRoot()
  return root ? readInstructions(root) : null
}

export async function setProjectInstructions(text: unknown): Promise<string | null> {
  if (typeof text !== 'string') throw new Error(msg('Ожидался текст', 'Text expected'))
  if (text.length > 1024 * 1024) throw new Error(msg('Слишком длинный текст инструкций', 'The instructions are too long'))
  return writeInstructions(requireRoot(), text)
}

export async function projectHistory(): Promise<ProjectVersion[]> {
  const root = getProjectRoot()
  if (!root || !(await findGit())) return []
  const trust = await folderTrust(root)
  if (trust.git !== 'trusted' || trust.unsafeGit) return []
  return gitLog(root)
}

export async function projectVersionDoc(sha: unknown): Promise<unknown> {
  if (typeof sha !== 'string') throw new Error(msg('Некорректная версия', 'Invalid version'))
  return readVersion(requireRoot(), sha)
}

export async function tagProjectVersion(sha: unknown, label: unknown): Promise<void> {
  if (typeof sha !== 'string' || typeof label !== 'string') throw new Error(msg('Некорректные аргументы', 'Invalid arguments'))
  const name = tagNameFrom(label)
  if (!name) throw new Error(msg('Введите название метки', 'Enter a tag name'))
  const root = requireRoot()
  if ((await folderTrust(root)).git !== 'trusted') throw untrustedError()
  await gitTag(root, sha, name, label.trim())
}

// ───────────── recovery ─────────────

export async function autosave(doc: unknown, path: unknown): Promise<void> {
  const rec: RecoveryFile = {
    path: typeof path === 'string' && path ? path : null,
    savedAt: new Date().toISOString(),
    doc,
  }
  await atomicWrite(recoveryFile(), JSON.stringify(rec))
}

export async function recover(): Promise<{ path: string | null; doc: unknown } | null> {
  const rec = await readJson<RecoveryFile | null>(recoveryFile(), null)
  if (!rec || typeof rec !== 'object' || rec.doc == null) return null
  if (rec.path) grantPath(rec.path)
  return { path: rec.path ?? null, doc: rec.doc }
}

export async function clearRecovery(): Promise<void> {
  await fsp.rm(recoveryFile(), { force: true })
}

export async function addProjectAsset(data: unknown, ext: unknown): Promise<string> {
  const bytes = toBytes(data)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const name = `${hash}.${cleanExt(String(ext ?? ''), 'bin')}`
  const file = join(paths.projectAssets, name)
  await ensureDir(paths.projectAssets)
  if (!(await exists(file))) await atomicWrite(file, bytes)
  return PROJECT_URL + name
}

/** .doplan / .json file, a project folder or its plan.json given on the command line */
export function projectFileFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue
    const ext = extname(a).toLowerCase()
    if (ext === '.doplan' || ext === '.json') return a
    // lstat: a plan.json that is a link is never followed here (opening refuses it with a message)
    try {
      lstatSync(join(a, PLAN_FILE))
      return a
    } catch {
      /* not a project folder */
    }
  }
  return null
}
