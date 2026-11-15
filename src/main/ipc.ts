import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { planFromImage } from './ai'
import { downloadEntry, importMaterial, importModel, loadCatalog, removeEntry, saveThumb } from './catalog'
import { CH } from './channels'
import { exportPdf, pickFiles, readFileBytes, readFileText, reveal, saveBinary, saveText } from './files'
import { addProjectAsset, autosave, clearRecovery, openProject, recover, resetProjectAssets, saveProject } from './project'
import {
  attachProject,
  createProject,
  defaultLocation,
  exportZip,
  openProjectFolder,
  pickLocation,
  pickProjectsDir,
  projectHistory,
  projectInfo,
  projectInstructions,
  projectVersionDoc,
  setProjectInstructions,
  tagProjectVersion,
  trustProjectFolder,
  resetProjectGitConfig,
} from './project'
import { getProjectRoot } from './projectFolder'
import { getSettings, setApiKey, setSettings } from './settings'
import { confirmClose, getMainWindow, isTrustedUrl, setWindowTitle } from './window'

function senderOk(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = e.senderFrame
  if (!frame) return false
  if (!isTrustedUrl(frame.url)) return false
  // only the editor window talks to main
  const w = getMainWindow()
  return !!w && e.sender === w.webContents
}

type Handler = (...args: any[]) => unknown

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (e, ...args: unknown[]) => {
    if (!senderOk(e)) throw new Error('IPC: недоверенный отправитель')
    return fn(...args)
  })
}

function on(channel: string, fn: Handler): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (!senderOk(e)) return
    fn(...args)
  })
}

/** exported for feature modules that register their own channels (ai-chat) */
export { handle as handleIpc, on as onIpc }

export function registerIpc(): void {
  handle(CH.projectOpen, (path?: unknown) => openProject(path))
  handle(CH.projectSave, (doc: unknown, path: unknown, opts: unknown) => saveProject(doc, path, opts))
  handle(CH.projectAutosave, (doc: unknown, path: unknown) => autosave(doc, path))
  handle(CH.projectRecover, () => recover())
  handle(CH.projectClearRecovery, () => clearRecovery())
  handle(CH.projectReset, () => resetProjectAssets())
  handle(CH.projectAddAsset, (data: unknown, ext: unknown) => addProjectAsset(data, ext))

  // project folders + git versions
  handle(CH.projectRoot, () => getProjectRoot())
  handle(CH.projectInstructions, () => projectInstructions())
  handle(CH.projectSetInstructions, (text: unknown) => setProjectInstructions(text))
  handle(CH.projectInfo, () => projectInfo())
  handle(CH.projectDefaultLocation, () => defaultLocation())
  handle(CH.projectPickLocation, (defaultPath: unknown) => pickLocation(defaultPath))
  handle(CH.projectPickProjectsDir, () => pickProjectsDir())
  handle(CH.projectCreate, (doc: unknown, name: unknown, parent: unknown) => createProject(doc, name, parent))
  handle(CH.projectOpenFolder, () => openProjectFolder())
  handle(CH.projectExportZip, (doc: unknown) => exportZip(doc))
  handle(CH.projectAttach, (path: unknown) => attachProject(path))
  handle(CH.projectTrustFolder, () => trustProjectFolder())
  handle(CH.projectResetGitConfig, () => resetProjectGitConfig())
  handle(CH.projectHistory, () => projectHistory())
  handle(CH.projectVersionDoc, (sha: unknown) => projectVersionDoc(sha))
  handle(CH.projectTagVersion, (sha: unknown, label: unknown) => tagProjectVersion(sha, label))

  handle(CH.filesPick, (filters: unknown, multi: unknown) => pickFiles(filters, multi))
  handle(CH.filesRead, (path: unknown) => readFileBytes(path))
  handle(CH.filesReadText, (path: unknown) => readFileText(path))
  handle(CH.filesSaveText, (name: unknown, filters: unknown, content: unknown) => saveText(name, filters, content))
  handle(CH.filesSaveBinary, (name: unknown, filters: unknown, data: unknown) => saveBinary(name, filters, data))
  handle(CH.filesExportPdf, (svg: unknown, opts: unknown) => exportPdf(svg, opts))
  handle(CH.filesReveal, (path: unknown) => reveal(path))

  handle(CH.catalogLoad, () => loadCatalog())
  handle(CH.catalogImportModel, (glb: unknown, meta: unknown, thumb: unknown) => importModel(glb, meta, thumb ?? undefined))
  handle(CH.catalogImportMaterial, (meta: unknown, maps: unknown) => importMaterial(meta, maps))
  handle(CH.catalogDownload, (kind: unknown, id: unknown) => downloadEntry(kind, id))
  handle(CH.catalogRemove, (kind: unknown, id: unknown) => removeEntry(kind, id))
  handle(CH.catalogSaveThumb, (kind: unknown, id: unknown, png: unknown) => saveThumb(kind, id, png))

  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch: unknown) => setSettings(patch))
  handle(CH.settingsSetApiKey, (key: unknown) => setApiKey(typeof key === 'string' ? key : null))

  handle(CH.aiPlanFromImage, (image: unknown, mime: unknown, hint: unknown) => planFromImage(image, mime, hint))

  on(CH.windowSetTitle, (title: unknown, dirty: unknown) => setWindowTitle(title, dirty))
  on(CH.windowConfirmClose, () => confirmClose())
}
