/**
 * Access to `window.doplan` with a browser fallback, so the renderer also works in a plain
 * browser tab (no Electron): settings live in localStorage, saves become downloads,
 * everything else resolves to a harmless "nothing happened" value.
 */
import type { AppSettings, DoplanApi, FileFilter, MenuCommand } from '@shared/ipc'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'
import { releasePageUrl } from '@shared/updater'

/** version shown by the web build (no Electron); keep in step with package.json */
const WEB_VERSION = '0.7.1-web'

const SETTINGS_KEY = 'doplan.settings'

const DEFAULT_SETTINGS: AppSettings = {
  lang: 'ru',
  theme: 'dark',
  backend: 'webgpu',
  autosaveSec: 30,
  anthropicApiKeySet: false,
  recent: [],
}

function readLocalSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS }
}

function writeLocalSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable */
  }
}

function download(name: string, data: BlobPart, type: string): string {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return name
}

function mimeFor(filters: FileFilter[]): string {
  const ext = filters[0]?.extensions[0]?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    json: 'application/json',
    dxf: 'application/dxf',
    glb: 'model/gltf-binary',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

/** Files picked in the browser fallback are kept here so `files.read(path)` can return them. */
const pickedFiles = new Map<string, File>()

function pickInBrowser(filters: FileFilter[], multi?: boolean): Promise<{ path: string; name: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = !!multi
    const exts = filters.flatMap((f) => f.extensions).filter((e) => e !== '*')
    if (exts.length) input.accept = exts.map((e) => `.${e}`).join(',')
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(
        files.map((f) => {
          const path = `browser:${f.name}:${f.size}:${f.lastModified}`
          pickedFiles.set(path, f)
          return { path, name: f.name }
        }),
      )
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}


function createFallbackApi(): DoplanApi {
  let settings = readLocalSettings()
  const noopUnsub = () => () => {}
  return {
    platform: 'browser',
    version: WEB_VERSION,
    project: {
      async open(path?: string) {
        let file: File | undefined = path ? pickedFiles.get(path) : undefined
        if (!file) {
          const picked = await pickInBrowser([{ name: 'doplan JSON', extensions: ['json'] }])
          if (!picked.length) return null
          file = pickedFiles.get(picked[0].path)
          path = picked[0].path
        }
        if (!file) return null
        const text = await file.text()
        return { path: path ?? file.name, doc: JSON.parse(text) }
      },
      async save(doc: unknown, path: string | null) {
        const name = path && !path.startsWith('browser:') ? path : 'project.doplan.json'
        download(name.split(/[\\/]/).pop() ?? name, JSON.stringify(doc), 'application/json')
        return { path: name }
      },
      async autosave(doc: unknown) {
        try {
          localStorage.setItem('doplan.recovery', JSON.stringify(doc))
        } catch {
          /* quota */
        }
      },
      async recover() {
        try {
          const raw = localStorage.getItem('doplan.recovery')
          if (raw) return { path: null, doc: JSON.parse(raw) }
        } catch {
          /* ignore */
        }
        return null
      },
      async clearRecovery() {
        try {
          localStorage.removeItem('doplan.recovery')
        } catch {
          /* ignore */
        }
      },
      async reset() {},
      async addAsset(data: ArrayBuffer, ext: string) {
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg'
        // data URL so it survives being stored in the document
        const bytes = new Uint8Array(data)
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return `data:${mime};base64,${btoa(bin)}`
      },
    },
    files: {
      pick: pickInBrowser,
      async read(path: string) {
        const f = pickedFiles.get(path)
        if (!f) throw new Error(`File not available: ${path}`)
        return f.arrayBuffer()
      },
      async readText(path: string) {
        const f = pickedFiles.get(path)
        if (!f) throw new Error(`File not available: ${path}`)
        return f.text()
      },
      async saveText(defaultName: string, filters: FileFilter[], content: string) {
        return download(defaultName, content, mimeFor(filters))
      },
      async saveBinary(defaultName: string, filters: FileFilter[], data: ArrayBuffer) {
        return download(defaultName, data, mimeFor(filters))
      },
      async exportPdf(svg: string, opts: { widthMm: number; heightMm: number; defaultName: string }) {
        // no printToPDF in a browser: hand out the to-scale SVG instead
        return download(opts.defaultName.replace(/\.pdf$/i, '.svg'), svg, 'image/svg+xml')
      },
      async reveal() {},
    },
    catalog: {
      async load() {
        return { version: 1, materials: [], assets: [], hdris: [] }
      },
      async importModel() {
        throw new Error('Импорт моделей доступен только в настольном приложении')
      },
      async importMaterial() {
        throw new Error('Импорт материалов доступен только в настольном приложении')
      },
      async download() {
        throw new Error('Загрузка ресурсов доступна только в настольном приложении')
      },
      async remove() {},
      async saveThumb() {
        return ''
      },
      onProgress: noopUnsub,
    },
    settings: {
      async get() {
        return { ...settings }
      },
      async set(patch) {
        settings = { ...settings, ...patch }
        writeLocalSettings(settings)
        return { ...settings }
      },
      async setApiKey(key: string | null) {
        settings = { ...settings, anthropicApiKeySet: !!key }
        writeLocalSettings(settings)
      },
    },
    ai: {
      async planFromImage() {
        throw new Error('Распознавание плана по фото доступно только в настольном приложении')
      },
    },
    // ── ai-chat block ──
    aiChat: {
      async providers() {
        return []
      },
      async run() {
        throw new Error('ИИ-чат доступен только в настольном приложении')
      },
      async stop() {},
      onEvent: noopUnsub,
      onToolCall: noopUnsub,
      toolResult() {},
      async listChats() {
        return []
      },
      async loadChat() {
        return null
      },
      async saveChat() {},
      async deleteChat() {},
      async getSettings() {
        return { ...DEFAULT_AI_SETTINGS, models: {} }
      },
      async setSettings() {},
      async login() {},
      async loginInput() {},
      async loginCancel() {},
      onLogin: noopUnsub,
    },
    // ── end ai-chat block ──
    updates: {
      async get() {
        return { mode: 'disabled', current: WEB_VERSION, status: { kind: 'idle' } }
      },
      async check() {
        return { mode: 'disabled', current: WEB_VERSION, status: { kind: 'idle' } }
      },
      async install() {},
      async openReleasePage(version?: string) {
        window.open(releasePageUrl(version), '_blank', 'noopener')
      },
      onState: noopUnsub,
    },
    window: {
      setTitle(title: string, dirty: boolean) {
        document.title = `${dirty ? '• ' : ''}${title} — doplan`
      },
      onMenu: noopUnsub as (cb: (cmd: MenuCommand) => void) => () => void,
      onCloseRequest: noopUnsub,
      confirmClose() {},
      onOpenFile: noopUnsub,
    },
  }
}

export const isElectron: boolean = typeof window !== 'undefined' && !!(window as Partial<Window>).doplan

/** The preload API, or a browser fallback when running outside Electron. */
export const api: DoplanApi = isElectron ? window.doplan : createFallbackApi()

export { DEFAULT_SETTINGS }

// other modules may call window.doplan directly: give them the fallback too
if (!isElectron && typeof window !== 'undefined') {
  ;(window as unknown as { doplan: DoplanApi }).doplan = api
}
