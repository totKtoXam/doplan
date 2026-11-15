/**
 * Sandboxed preload (CJS bundle, only `electron` may be required). Exposes `window.doplan`
 * exactly as `DoplanApi` from src/shared/ipc.ts. No logic beyond argument plumbing.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DoplanApi, MenuCommand } from '../shared/ipc'
// ── ai-chat block ──
import type { AiLoginEvent, AiProviderId, AiRunEvent, AiToolCall } from '../shared/aiChat'
// ── end ai-chat block ──
import { CH, VERSION_ARG } from '../main/channels'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

/** main may hand back a Uint8Array/Buffer view; the contract promises a standalone ArrayBuffer */
function asArrayBuffer(x: unknown): ArrayBuffer {
  if (x instanceof ArrayBuffer) return x
  if (ArrayBuffer.isView(x)) {
    const out = new ArrayBuffer(x.byteLength)
    new Uint8Array(out).set(new Uint8Array(x.buffer, x.byteOffset, x.byteLength))
    return out
  }
  throw new Error('Ожидались двоичные данные')
}

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// close handshake: answer immediately if nobody in the page listens
const closeListeners = new Set<() => void>()
ipcRenderer.on(CH.evCloseRequest, () => {
  if (closeListeners.size === 0) {
    ipcRenderer.send(CH.windowConfirmClose)
    return
  }
  for (const l of closeListeners) l()
})

// open-file events may arrive before the page subscribes: buffer them
const openListeners = new Set<(path: string) => void>()
const pendingOpen: string[] = []
ipcRenderer.on(CH.evOpenFile, (_e, path: unknown) => {
  if (typeof path !== 'string') return
  if (openListeners.size === 0) pendingOpen.push(path)
  else for (const l of openListeners) l(path)
})

const versionArg = process.argv.find((a) => a.startsWith(VERSION_ARG))

const api: DoplanApi = {
  platform: process.platform,
  version: versionArg ? versionArg.slice(VERSION_ARG.length) : '0.0.0',

  project: {
    open: (path) => invoke(CH.projectOpen, path),
    save: (doc, path, opts) => invoke(CH.projectSave, doc, path, opts ?? {}),
    autosave: (doc, path) => invoke(CH.projectAutosave, doc, path),
    recover: () => invoke(CH.projectRecover),
    clearRecovery: () => invoke(CH.projectClearRecovery),
    reset: () => invoke(CH.projectReset),
    addAsset: (data, ext) => invoke(CH.projectAddAsset, data, ext),
    // project folders + git versions
    root: () => invoke(CH.projectRoot),
    instructions: () => invoke(CH.projectInstructions),
    setInstructions: (text) => invoke(CH.projectSetInstructions, text),
    info: () => invoke(CH.projectInfo),
    defaultLocation: () => invoke(CH.projectDefaultLocation),
    pickLocation: (defaultPath) => invoke(CH.projectPickLocation, defaultPath ?? null),
    pickProjectsDir: () => invoke(CH.projectPickProjectsDir),
    create: (doc, name, parent) => invoke(CH.projectCreate, doc, name, parent),
    openFolder: () => invoke(CH.projectOpenFolder),
    exportZip: (doc) => invoke(CH.projectExportZip, doc),
    attach: (path) => invoke(CH.projectAttach, path),
    trustFolder: () => invoke(CH.projectTrustFolder),
    history: () => invoke(CH.projectHistory),
    versionDoc: (sha) => invoke(CH.projectVersionDoc, sha),
    tagVersion: (sha, label) => invoke(CH.projectTagVersion, sha, label),
  },

  files: {
    pick: (filters, multi) => invoke(CH.filesPick, filters, !!multi),
    read: async (path) => asArrayBuffer(await invoke<unknown>(CH.filesRead, path)),
    readText: (path) => invoke(CH.filesReadText, path),
    saveText: (defaultName, filters, content) => invoke(CH.filesSaveText, defaultName, filters, content),
    saveBinary: (defaultName, filters, data) => invoke(CH.filesSaveBinary, defaultName, filters, data),
    exportPdf: (svg, opts) => invoke(CH.filesExportPdf, svg, opts),
    reveal: (path) => invoke(CH.filesReveal, path),
  },

  catalog: {
    load: () => invoke(CH.catalogLoad),
    importModel: (glb, meta, thumbPng) => invoke(CH.catalogImportModel, glb, meta, thumbPng ?? null),
    importMaterial: (meta, maps) => invoke(CH.catalogImportMaterial, meta, maps),
    download: (kind, id) => invoke(CH.catalogDownload, kind, id),
    remove: (kind, id) => invoke(CH.catalogRemove, kind, id),
    saveThumb: (kind, id, png) => invoke(CH.catalogSaveThumb, kind, id, png),
    onProgress: (cb) => subscribe<[{ id: string; done: number; total: number }]>(CH.evCatalogProgress, (p) => cb(p)),
  },

  settings: {
    get: () => invoke(CH.settingsGet),
    set: (patch) => invoke(CH.settingsSet, patch),
    setApiKey: (key) => invoke(CH.settingsSetApiKey, key),
  },

  ai: {
    planFromImage: (image, mime, hint) => invoke(CH.aiPlanFromImage, image, mime, hint ?? ''),
  },

  // ── ai-chat block ──
  aiChat: {
    providers: (refresh) => invoke(CH.aiChatProviders, !!refresh),
    run: (req) => invoke(CH.aiChatRun, req),
    stop: (runId) => invoke(CH.aiChatStop, runId),
    onEvent: (cb) => subscribe<[string, AiRunEvent]>(CH.evAiChatEvent, (runId, ev) => cb(runId, ev)),
    onToolCall: (cb) => subscribe<[AiToolCall]>(CH.evAiChatToolCall, (call) => cb(call)),
    toolResult: (callId, result) => ipcRenderer.send(CH.aiChatToolResult, callId, result),
    listChats: (projectPath) => invoke(CH.aiChatList, projectPath),
    loadChat: (projectPath, chatId) => invoke(CH.aiChatLoad, projectPath, chatId),
    saveChat: (projectPath, chat) => invoke(CH.aiChatSave, projectPath, chat),
    deleteChat: (projectPath, chatId) => invoke(CH.aiChatDelete, projectPath, chatId),
    getSettings: (projectPath) => invoke(CH.aiChatGetSettings, projectPath),
    setSettings: (projectPath, s) => invoke(CH.aiChatSetSettings, projectPath, s),
    login: (provider) => invoke(CH.aiChatLogin, provider),
    loginInput: (text) => invoke(CH.aiChatLoginInput, text),
    loginCancel: () => invoke(CH.aiChatLoginCancel),
    onLogin: (cb) => subscribe<[AiProviderId, AiLoginEvent]>(CH.evAiChatLogin, (provider, ev) => cb(provider, ev)),
  },
  // ── end ai-chat block ──

  window: {
    setTitle: (title, dirty) => ipcRenderer.send(CH.windowSetTitle, title, dirty),
    onMenu: (cb) => subscribe<[MenuCommand]>(CH.evMenu, (cmd) => cb(cmd)),
    onCloseRequest: (cb) => {
      const l = () => cb()
      closeListeners.add(l)
      return () => {
        closeListeners.delete(l)
      }
    },
    confirmClose: () => ipcRenderer.send(CH.windowConfirmClose),
    onOpenFile: (cb) => {
      const l = (p: string) => cb(p)
      openListeners.add(l)
      while (pendingOpen.length) l(pendingOpen.shift()!)
      return () => {
        openListeners.delete(l)
      }
    },
  },
}

contextBridge.exposeInMainWorld('doplan', api)
