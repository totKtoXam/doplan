import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { app, dialog } from 'electron'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { assertReadable, grantPath } from './access'
import { atomicWrite, cleanExt, cleanFileName, ensureDir, exists, readJson, rmrf, toBytes } from './fsutil'
import { paths } from './paths'
import { addRecent } from './settings'
import { getMainWindow } from './window'

const FORMAT_VERSION = 1
const MAX_PROJECT_BYTES = 2 * 1024 * 1024 * 1024
const PROJECT_URL = 'doplan-asset://project/'
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
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

function docName(doc: unknown): string | undefined {
  const name = (doc as { meta?: { name?: unknown } } | null)?.meta?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

/** startup housekeeping: keep embedded assets only if a crash-recovery snapshot needs them */
export async function initProjectStore(): Promise<void> {
  await ensureDir(paths.recovery)
  if (!(await exists(recoveryFile()))) await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
}

export async function resetProjectAssets(): Promise<void> {
  await rmrf(paths.projectAssets)
  await ensureDir(paths.projectAssets)
}

function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6)
}

function parseJsonText(bytes: Uint8Array): unknown {
  let text = strFromU8(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Файл повреждён: некорректный JSON (${(err as Error).message})`)
  }
}

export async function openProject(pathArg?: unknown): Promise<{ path: string; doc: unknown } | null> {
  let path: string
  if (typeof pathArg === 'string' && pathArg) {
    path = await assertReadable(pathArg)
  } else {
    const w = getMainWindow()
    const opts: Electron.OpenDialogOptions = {
      title: 'Открыть проект',
      properties: ['openFile'],
      filters: [
        { name: 'Проект doplan', extensions: ['doplan'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    path = res.filePaths[0]
    grantPath(path)
  }

  const st = await fsp.stat(path)
  if (st.size > MAX_PROJECT_BYTES) throw new Error('Файл проекта слишком большой')
  const buf = new Uint8Array(await fsp.readFile(path))
  let doc: unknown
  if (isZip(buf)) {
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
  return { path, doc }
}

function referencedAssets(json: string): string[] {
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

export async function saveProject(doc: unknown, pathArg: unknown): Promise<{ path: string } | null> {
  let path: string | null = null
  if (typeof pathArg === 'string' && pathArg) {
    // only paths the user already chose/opened may be overwritten silently
    path = await assertReadable(pathArg).catch(() => null)
  }
  if (!path) {
    const w = getMainWindow()
    const suggested =
      typeof pathArg === 'string' && pathArg
        ? pathArg
        : join(app.getPath('documents'), `${cleanFileName(docName(doc) ?? 'Проект')}.doplan`)
    const opts: Electron.SaveDialogOptions = {
      title: 'Сохранить проект',
      defaultPath: suggested,
      filters: [{ name: 'Проект doplan', extensions: ['doplan'] }],
    }
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    path = res.filePath
  }
  if (extname(path).toLowerCase() !== '.doplan') path += '.doplan'

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
  const bytes = zipSync(zip, { mtime: new Date() })
  await ensureDir(dirname(path))
  await atomicWrite(path, bytes)
  grantPath(path)
  await addRecent(path, docName(doc))
  return { path }
}

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

export function projectFileFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue
    const ext = extname(a).toLowerCase()
    if (ext === '.doplan' || ext === '.json') return a
  }
  return null
}

