/**
 * Recent projects for the welcome screen: the list kept in main (userData/settings.json, filled when a
 * project is opened or saved), whether each entry still exists on disk, a small plan thumbnail per
 * entry, and whether the app was launched to open a file (then the welcome screen is not shown).
 */

export const RECENT_CH = {
  list: 'recent:list',
  remove: 'recent:remove',
  setThumb: 'recent:setThumb',
  launch: 'recent:launch',
} as const

export interface RecentEntry {
  /** project folder or .doplan file (in the web build: the key the document is stored under) */
  path: string
  name: string
  /** when the project was last opened or saved here (ISO) */
  modifiedAt: string
  /** false: the file or folder is gone (moved, deleted, drive not connected) */
  exists: boolean
  /** 'folder' = project folder; 'zip' = single-file .doplan; 'web' = a copy kept by the web build */
  kind: 'folder' | 'zip' | 'web'
  /** SVG text of the plan as last opened or saved, or null */
  thumb: string | null
}

export interface RecentApi {
  /** recent projects, newest first, each checked on disk */
  list(): Promise<RecentEntry[]>
  /** drops a project from the list (the project itself is not touched) */
  remove(path: string): Promise<void>
  /** stores the plan thumbnail of a project that is in the list (ignored otherwise) */
  setThumb(path: string, svg: string): Promise<void>
  /** true once if the app was started to open a file (double click, command line); false afterwards */
  launch(): Promise<{ file: boolean }>
}

/** largest thumbnail kept, bytes of SVG text */
export const MAX_THUMB_BYTES = 400 * 1024

/** a thumbnail is plain SVG markup of reasonable size (shown through <img>, where scripts never run) */
export function validThumb(svg: unknown): svg is string {
  return typeof svg === 'string' && svg.length <= MAX_THUMB_BYTES && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)
}

/** paths compare case-insensitively except on Linux */
export function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string) => {
    const q = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'linux' ? q : q.toLowerCase()
  }
  return norm(a) === norm(b)
}

export function kindOfRecent(path: string): RecentEntry['kind'] {
  return /\.doplan$/i.test(path) ? 'zip' : 'folder'
}

/**
 * What the app shows once it has started:
 * - 'file': it was launched to open a file → that file opens, no welcome screen;
 * - 'welcome': otherwise. A crash-recovery prompt still comes up over it (restoring loads the
 *   document, which closes the welcome screen).
 */
export function startupView(launch: { file: boolean } | null): 'file' | 'welcome' {
  return launch?.file ? 'file' : 'welcome'
}
