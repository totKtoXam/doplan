/**
 * Contract of `window.doplan` exposed by the preload script (contextIsolation + sandbox).
 * Implemented in src/main + src/preload. Consumed by the renderer.
 *
 * Asset URL scheme (privileged, streaming, served by main via protocol.handle):
 *   doplan-asset://catalog/<relative path>   → bundled pack: <resources>/assets/…
 *   doplan-asset://library/<relative path>   → user library: <userData>/library/…  (imports + downloads)
 *   doplan-asset://project/<file name>       → files embedded in the currently open project
 * `catalog.load()` returns entries whose `src` / `maps.*` / `thumb` are already absolute doplan-asset:// URLs.
 */
import type { Asset, Catalog, Hdri, Material } from '../core/types'
// ── ai-chat block ──
import type { AiChatApi } from './aiChat'
// ── end ai-chat block ──
import type { UpdatesApi } from './updater'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface RecentProject {
  path: string
  name: string
  modifiedAt: string
}

export interface AppSettings {
  lang: 'ru' | 'en'
  theme: 'dark' | 'light'
  /** 'webgpu' | 'webgl' — renderer backend preference for 3D */
  backend: 'webgpu' | 'webgl'
  autosaveSec: number
  anthropicApiKeySet: boolean
  recent: RecentProject[]
}

export type MenuCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'importPlanSpec'
  | 'importUnderlay'
  | 'importModel'
  | 'exportPng'
  | 'exportSvg'
  | 'exportPdf'
  | 'exportDxf'
  | 'exportGlb'
  | 'exportRender'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'selectAll'
  | 'view2d'
  | 'view3d'
  | 'viewSplit'
  | 'zoomFit'
  | 'settings'
  | 'checkUpdates'
  | 'installUpdate'
  | 'about'

export interface DoplanApi {
  platform: string
  version: string

  project: {
    /** shows an open dialog when `path` is omitted. Returns parsed doc.json (unvalidated). */
    open(path?: string): Promise<{ path: string; doc: unknown } | null>
    /** `path` null → save dialog. Writes the .doplan zip atomically, embedding project assets. */
    save(doc: unknown, path: string | null): Promise<{ path: string } | null>
    /** crash-recovery snapshot in userData/recovery */
    autosave(doc: unknown, path: string | null): Promise<void>
    /** returns a recovery snapshot left by a crashed session, if any */
    recover(): Promise<{ path: string | null; doc: unknown } | null>
    clearRecovery(): Promise<void>
    /** resets the project asset dir (new project) */
    reset(): Promise<void>
    /** copies bytes into the project asset dir; returns a doplan-asset://project/… URL */
    addAsset(data: ArrayBuffer, ext: string): Promise<string>
  }

  files: {
    pick(filters: FileFilter[], multi?: boolean): Promise<{ path: string; name: string }[]>
    read(path: string): Promise<ArrayBuffer>
    readText(path: string): Promise<string>
    /** save dialog + write; returns the chosen path or null */
    saveText(defaultName: string, filters: FileFilter[], content: string): Promise<string | null>
    saveBinary(defaultName: string, filters: FileFilter[], data: ArrayBuffer): Promise<string | null>
    /** renders an SVG string to a to-scale PDF page (mm) with a hidden window + printToPDF */
    exportPdf(svg: string, opts: { widthMm: number; heightMm: number; defaultName: string }): Promise<string | null>
    reveal(path: string): Promise<void>
  }

  catalog: {
    /** bundled catalog merged with the user library; URLs absolute */
    load(): Promise<Catalog>
    /** stores a GLB (already converted in the renderer) in the user library */
    importModel(glb: ArrayBuffer, meta: Omit<Asset, 'id' | 'src' | 'kind'>, thumbPng?: ArrayBuffer): Promise<Asset>
    /** stores texture files in the user library and creates a material */
    importMaterial(
      meta: Omit<Material, 'id' | 'maps'>,
      maps: Partial<Record<'color' | 'normal' | 'roughness' | 'metalness' | 'ao' | 'arm' | 'displacement', { data: ArrayBuffer; ext: string }>>,
    ): Promise<Material>
    /** downloads a `remote: true` entry into the user library; resolves with the local entry */
    download(kind: 'asset' | 'material' | 'hdri', id: string): Promise<Asset | Material | Hdri>
    remove(kind: 'asset' | 'material', id: string): Promise<void>
    saveThumb(kind: 'asset' | 'material', id: string, png: ArrayBuffer): Promise<string>
    onProgress(cb: (p: { id: string; done: number; total: number }) => void): () => void
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<Omit<AppSettings, 'anthropicApiKeySet' | 'recent'>>): Promise<AppSettings>
    setApiKey(key: string | null): Promise<void>
  }

  ai: {
    /** in-app photo → PlanSpec using the stored Anthropic API key; returns PlanSpec JSON text */
    planFromImage(image: ArrayBuffer, mime: string, hint?: string): Promise<string>
  }

  // ── ai-chat block ──
  /** AI chat: providers (Claude Code / Codex / Anthropic API), runs, doc tool bridge, chat storage */
  aiChat: AiChatApi
  // ── end ai-chat block ──

  /** GitHub Releases updates (electron-updater); see src/shared/updater.ts */
  updates: UpdatesApi

  window: {
    setTitle(title: string, dirty: boolean): void
    onMenu(cb: (cmd: MenuCommand) => void): () => void
    /** main asks before closing; renderer answers via confirmClose */
    onCloseRequest(cb: () => void): () => void
    confirmClose(): void
    /** file opened via OS association / CLI arg / external PlanSpec drop */
    onOpenFile(cb: (path: string) => void): () => void
  }
}

declare global {
  interface Window {
    doplan: DoplanApi
  }
}
