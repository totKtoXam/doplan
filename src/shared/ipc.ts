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
  /** default parent folder for new projects chosen in Settings; null → Documents/doplan */
  projectsDir: string | null
}

// ── project folders + git versions ──

export interface ProjectOpenResult {
  /** project folder, .doplan or .json path */
  path: string
  doc: unknown
  /** 'folder' = project folder (path is the folder); 'zip' = .doplan; 'json' = bare document JSON */
  kind?: 'folder' | 'zip' | 'json'
  /** folder projects: doplan keeps the version history in git (the repository exists or is created on the first save) */
  git?: boolean
  /**
   * folders: the folder came with a git repository doplan did not create and the user has not trusted
   * yet. No git command runs there until project.trustFolder() (git may run programs from a repo's config).
   */
  untrustedGit?: boolean
  /** folders: .git is a file (submodule, worktree) — doplan keeps no version history there */
  gitFile?: boolean
  /** folders: the repository config has keys outside doplan's allowlist; no git command runs there (see UnsafeGitConfig) */
  unsafeGit?: UnsafeGitConfig
}

/**
 * A folder's git config (.git/config, .git/config.worktree) with keys through which git or the programs
 * it starts (git-lfs, gpg…) could run commands: anything outside a short list of plain keys (core.filemode,
 * user.name, remote.*.url…). doplan runs no git there until project.resetGitConfig(); or the user works
 * without versions.
 */
export interface UnsafeGitConfig {
  keys: string[]
  /** project.resetGitConfig() can make it safe */
  resettable: boolean
}

export interface ProjectSaveOptions {
  /** commit message for folder projects (default «Сохранение») */
  message?: string
  /** write even if plan.json was changed on disk by someone else since it was read */
  overwrite?: boolean
}

export interface ProjectSaveResult {
  path: string
  /** folder projects: plan.json changed on disk since it was read; nothing was written */
  externalChange?: boolean
  /** folder projects: new commit sha, null when nothing changed or git is unavailable */
  commit?: string | null
  /** folder projects: the commit failed (the files were written) */
  commitError?: string
}

export interface ProjectInfo {
  root: string | null
  /** git executable found */
  gitAvailable: boolean
  /** the open folder is a git repository */
  repo: boolean
  /** false when the folder's repository is not trusted yet (history, tags and commits are off) */
  trusted: boolean
  /** .git in the folder is a file (submodule, worktree): doplan keeps no version history there */
  gitFile: boolean
  /**
   * the folder itself is trusted (doplan created it or the user confirmed it): the AI agent runs inside
   * it. Otherwise the agent runs in a separate work folder and gets AGENTS.md as quoted text.
   */
  folderTrusted: boolean
  gitVersion: string
  /** the repository config has keys outside the allowlist: history, tags and commits are off (see UnsafeGitConfig) */
  unsafeGit: UnsafeGitConfig | null
}

export interface ProjectVersion {
  sha: string
  short: string
  /** ISO 8601 */
  date: string
  author: string
  message: string
  tags: { name: string; message: string }[]
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
  // project folders + git versions
  | 'openFolder'
  | 'exportDoplan'
  | 'history'
  | 'instructions'

export interface DoplanApi {
  platform: string
  version: string

  project: {
    /** shows an open dialog when `path` is omitted. Returns parsed doc.json (unvalidated). */
    open(path?: string): Promise<ProjectOpenResult | null>
    /** `path` null → save dialog. Writes the .doplan zip atomically, embedding project assets. */
    save(doc: unknown, path: string | null, opts?: ProjectSaveOptions): Promise<ProjectSaveResult | null>
    /** crash-recovery snapshot in userData/recovery */
    autosave(doc: unknown, path: string | null): Promise<void>
    /** returns a recovery snapshot left by a crashed session, if any */
    recover(): Promise<{ path: string | null; doc: unknown } | null>
    clearRecovery(): Promise<void>
    /** resets the project asset dir (new project) */
    reset(): Promise<void>
    /** copies bytes into the project asset dir; returns a doplan-asset://project/… URL */
    addAsset(data: ArrayBuffer, ext: string): Promise<string>

    // ── project folders + git versions ──────────────────────────────────────────────
    // A project is a folder: plan.json (stable pretty JSON), manifest.json, assets/, AGENTS.md
    // (AI instructions), CLAUDE.md (`@AGENTS.md`), .gitignore; versioned with the system git.
    // `open(path)` also accepts a project folder or its plan.json and then resolves with
    // `kind: 'folder'` and `path` = the folder. `save(doc, folder, opts)` writes the folder and
    // commits (`opts.message`); a `.doplan` path still writes the single-file zip.

    /**
     * Folder of the currently open project, or null (unsaved document, .doplan / .json file).
     * For the AI chat: CLI agents run with this folder as cwd and read AGENTS.md / plan.json there.
     */
    root(): Promise<string | null>
    /** text of AGENTS.md of the open project folder; null when no folder project is open */
    instructions(): Promise<string | null>
    /** overwrites AGENTS.md of the open project folder and commits it; resolves with the commit sha (null: no git / no change) */
    setInstructions(text: string): Promise<string | null>
    /** root, git availability and the git version string ('' when git is not installed) */
    info(): Promise<ProjectInfo>
    /** default parent directory for new projects: the folder from Settings, else Documents/doplan */
    defaultLocation(): Promise<string>
    /** folder picker → stores the default projects folder in Settings (reset: settings.set({ projectsDir: null })) */
    pickProjectsDir(): Promise<AppSettings | null>
    /** folder picker for the parent directory of a new project; the chosen folder may then be passed to create() */
    pickLocation(defaultPath?: string): Promise<string | null>
    /** creates `<parent>/<name>/` (parent null → defaultLocation()), writes `doc`, runs `git init` + the first commit */
    create(doc: unknown, name: string, parent: string | null): Promise<ProjectOpenResult>
    /** folder picker → open a project folder */
    openFolder(): Promise<ProjectOpenResult | null>
    /** save dialog → single-file .doplan zip (export / sharing); does not change the open project */
    exportZip(doc: unknown): Promise<string | null>
    /**
     * Makes `path` the open project; resolves true when it is a project folder. Call it with the path of
     * open()/openFolder() after the document passed validation: only then are its assets loaded and the
     * folder becomes project.root(). Any other path (a recovery snapshot of a folder) only sets the root;
     * null detaches the folder.
     */
    attach(path: string | null): Promise<boolean>
    /** trusts the open project folder: the git repository that came with it (see ProjectOpenResult.untrustedGit) and the AI agent in it */
    trustFolder(): Promise<boolean>
    /**
     * rewrites the trusted folder's git config with only the allowed keys (UnsafeGitConfig); the old one
     * stays as .git/config.doplan-backup. Resolves with the backup path.
     */
    resetGitConfig(): Promise<string>
    /** git log of the open project folder, newest first */
    history(): Promise<ProjectVersion[]>
    /** plan.json of an old version (unvalidated); its assets become available under doplan-asset://project/ */
    versionDoc(sha: string): Promise<unknown>
    /** creates an annotated git tag on a version; `label` is free text (the tag name is derived from it) */
    tagVersion(sha: string, label: string): Promise<void>
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
    /** projectsDir can only be reset to the default here (null); a custom folder is chosen with project.pickProjectsDir() */
    set(patch: Partial<Omit<AppSettings, 'anthropicApiKeySet' | 'recent' | 'projectsDir'>> & { projectsDir?: null }): Promise<AppSettings>
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
