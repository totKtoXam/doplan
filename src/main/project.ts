import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { app, dialog } from 'electron'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { AppSettings, ProjectInfo, ProjectOpenResult, ProjectSaveOptions, ProjectSaveResult, ProjectVersion } from '../shared/ipc'
import { PLAN_FILE, tagNameFrom } from '../shared/projectFormat'
import { assertReadable, grantPath } from './access'
import { atomicWrite, cleanExt, cleanFileName, ensureDir, exists, readJson, rmrf, toBytes } from './fsutil'
import { findGit, gitLog, gitTag, gitVersion, isRepo } from './git'
import {
  ASSET_NAME_RE,
  commitFolder,
  createFolderProject,
  defaultProjectsDir,
  docName,
  folderRootOf,
  getProjectRoot,
  isDirectory,
  parseJsonText,
  planChangedOnDisk,
  readFolderProject,
  readInstructions,
  readVersion,
  referencedAssets,
  rememberPlanOnDisk,
  setProjectRoot,
  writeFolderProject,
  writeInstructions,
} from './projectFolder'
import { paths } from './paths'
import { addRecent, getProjectsDir, setProjectsDir } from './settings'
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

/** startup housekeeping: keep embedded assets only if a crash-recovery snapshot needs them */
export async function initProjectStore(): Promise<void> {
  await ensureDir(paths.recovery)
  if (!(await exists(recoveryFile()))) await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
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

async function openFolderAt(root: string): Promise<ProjectOpenResult> {
  const doc = await readFolderProject(root)
  grantPath(root)
  setProjectRoot(root)
  await addRecent(root, docName(doc))
  const git = !!(await findGit()) && (await isRepo(root).catch(() => false))
  return { path: root, doc, kind: 'folder', git }
}

export async function openProject(pathArg?: unknown): Promise<ProjectOpenResult | null> {
  let path: string
  if (typeof pathArg === 'string' && pathArg) {
    path = await assertReadable(pathArg)
  } else {
    const chosen = await showOpen({
      title: 'Открыть проект',
      properties: ['openFile'],
      filters: [
        { name: 'Проект doplan (plan.json, .doplan)', extensions: ['json', 'doplan'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    })
    if (!chosen) return null
    path = chosen
  }

  const root = await folderRootOf(path)
  if (root) return openFolderAt(root)
  if (await isDirectory(path)) throw new Error('В этой папке нет plan.json — это не папка проекта doplan')

  const st = await fsp.stat(path)
  if (st.size > MAX_PROJECT_BYTES) throw new Error('Файл проекта слишком большой')
  const buf = new Uint8Array(await fsp.readFile(path))
  let doc: unknown
  const zip = isZip(buf)
  if (zip) {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(buf)
    } catch (err) {
      throw new Error(`Не удалось распаковать проект: ${(err as Error).message}`)
    }
    const docBytes = files['doc.json'] ?? files['scene.json']
    if (!docBytes) throw new Error('В архиве проекта нет doc.json')
    const manifest = files['manifest.json'] ? (parseJsonText(files['manifest.json']) as Partial<Manifest>) : null
    if (manifest && typeof manifest.formatVersion === 'number' && manifest.formatVersion > FORMAT_VERSION) {
      throw new Error('Проект создан более новой версией doplan. Обновите приложение.')
    }
    doc = parseJsonText(docBytes)
    await resetProjectAssets()
    for (const [name, data] of Object.entries(files)) {
      if (!name.startsWith('assets/') || name.endsWith('/')) continue
      const file = name.slice('assets/'.length)
      if (!ASSET_NAME_RE.test(file)) continue
      await fsp.writeFile(join(paths.projectAssets, file), data)
    }
  } else {
    doc = parseJsonText(buf)
    await resetProjectAssets()
  }
  grantPath(path)
  if (extname(path).toLowerCase() === '.doplan') await addRecent(path, docName(doc))
  return { path, doc, kind: zip ? 'zip' : 'json' }
}

export async function openProjectFolder(): Promise<ProjectOpenResult | null> {
  const chosen = await showOpen({ title: 'Открыть папку проекта', properties: ['openDirectory'] })
  if (!chosen) return null
  const root = await folderRootOf(chosen)
  if (!root) throw new Error('В этой папке нет plan.json — это не папка проекта doplan')
  return openFolderAt(root)
}

async function buildZip(doc: unknown): Promise<Uint8Array> {
  const json = JSON.stringify(doc)
  if (json === undefined) throw new Error('Пустой документ')
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
    filters: [{ name: 'Проект doplan', extensions: ['doplan'] }],
  }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  let path = res.filePath
  if (extname(path).toLowerCase() !== '.doplan') path += '.doplan'
  return path
}

async function saveFolder(root: string, doc: unknown, opts: ProjectSaveOptions): Promise<ProjectSaveResult> {
  if (!opts.overwrite && (await planChangedOnDisk(root))) return { path: root, externalChange: true }
  await writeFolderProject(root, doc)
  grantPath(root)
  setProjectRoot(root)
  await addRecent(root, docName(doc))
  try {
    const commit = await commitFolder(root, opts.message ?? 'Сохранение')
    return { path: root, commit }
  } catch (err) {
    console.warn('[doplan] commit failed', err)
    return { path: root, commit: null, commitError: (err as Error).message }
  }
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
        : join(app.getPath('documents'), `${cleanFileName(docName(doc) ?? 'Проект')}.doplan`)
    path = await zipSaveDialog(doc, suggested, 'Сохранить проект')
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
  const base = cleanFileName(docName(doc) ?? 'Проект')
  const suggested = root ? join(dirname(root), `${base}.doplan`) : join(app.getPath('documents'), `${base}.doplan`)
  const path = await zipSaveDialog(doc, suggested, 'Экспорт в .doplan')
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
    title: 'Папка проектов по умолчанию',
    defaultPath: await defaultLocation(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  })
  if (!dir) return null
  await ensureDir(dir)
  return setProjectsDir(dir)
}

export async function pickLocation(defaultPath?: unknown): Promise<string | null> {
  return showOpen({
    title: 'Где создать папку проекта',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : await defaultLocation(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  })
}

export async function createProject(doc: unknown, nameArg: unknown, parentArg: unknown): Promise<ProjectOpenResult> {
  const name = typeof nameArg === 'string' ? nameArg.trim() : ''
  if (!name) throw new Error('Укажите название проекта')
  let parent: string
  if (typeof parentArg === 'string' && parentArg) {
    parent = await assertReadable(parentArg)
  } else {
    parent = await defaultLocation()
  }
  await ensureDir(parent)
  const res = await createFolderProject(parent, name, doc)
  grantPath(res.root)
  setProjectRoot(res.root)
  await addRecent(res.root, docName(doc) ?? name)
  return { path: res.root, doc, kind: 'folder', git: res.git }
}

export async function attachProject(pathArg: unknown): Promise<boolean> {
  if (typeof pathArg !== 'string' || !pathArg) {
    setProjectRoot(null)
    return false
  }
  const path = await assertReadable(pathArg)
  const root = await folderRootOf(path)
  setProjectRoot(root)
  if (root) await rememberPlanOnDisk(root)
  return !!root
}

export async function projectInfo(): Promise<ProjectInfo> {
  const root = getProjectRoot()
  const gitAvailable = !!(await findGit())
  const repo = !!root && gitAvailable && (await isRepo(root).catch(() => false))
  return { root, gitAvailable, repo, gitVersion: gitVersion() }
}

function requireRoot(): string {
  const root = getProjectRoot()
  if (!root) throw new Error('Проект не сохранён в папку. Сохраните его как папку проекта.')
  return root
}

export async function projectInstructions(): Promise<string | null> {
  const root = getProjectRoot()
  return root ? readInstructions(root) : null
}

export async function setProjectInstructions(text: unknown): Promise<string | null> {
  if (typeof text !== 'string') throw new Error('Ожидался текст')
  if (text.length > 1024 * 1024) throw new Error('Слишком длинный текст инструкций')
  return writeInstructions(requireRoot(), text)
}

export async function projectHistory(): Promise<ProjectVersion[]> {
  const root = getProjectRoot()
  if (!root || !(await findGit()) || !(await isRepo(root))) return []
  return gitLog(root)
}

export async function projectVersionDoc(sha: unknown): Promise<unknown> {
  if (typeof sha !== 'string') throw new Error('Некорректная версия')
  return readVersion(requireRoot(), sha)
}

export async function tagProjectVersion(sha: unknown, label: unknown): Promise<void> {
  if (typeof sha !== 'string' || typeof label !== 'string') throw new Error('Некорректные аргументы')
  const name = tagNameFrom(label)
  if (!name) throw new Error('Введите название метки')
  await gitTag(requireRoot(), sha, name, label.trim())
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
    if (existsSync(join(a, PLAN_FILE))) return a
  }
  return null
}
