import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/** directory of the bundled main script (out/main) */
export const mainDir = dirname(fileURLToPath(import.meta.url))

let catalogRootCache: string | null = null

export const paths = {
  get userData(): string {
    return app.getPath('userData')
  },
  /** user library root: imports and downloaded entries */
  get library(): string {
    return join(app.getPath('userData'), 'library')
  },
  get recovery(): string {
    return join(app.getPath('userData'), 'recovery')
  },
  get settingsFile(): string {
    return join(app.getPath('userData'), 'settings.json')
  },
  /** files embedded in the currently open project (served as doplan-asset://project/…) */
  get projectAssets(): string {
    return join(app.getPath('userData'), 'cache', 'project')
  },
  get v8Cache(): string {
    return join(app.getPath('userData'), 'cache', 'v8')
  },
  /** bundled asset pack: <resources>/assets */
  get catalogRoot(): string {
    if (catalogRootCache) return catalogRootCache
    if (app.isPackaged) {
      catalogRootCache = join(process.resourcesPath, 'assets')
    } else {
      const candidates = [
        join(app.getAppPath(), 'resources', 'assets'),
        join(mainDir, '..', '..', 'resources', 'assets'),
        join(process.cwd(), 'resources', 'assets'),
      ]
      catalogRootCache = candidates.find((c) => existsSync(c)) ?? candidates[0]
    }
    return catalogRootCache
  },
  /** built renderer (production) */
  get rendererDir(): string {
    return join(mainDir, '..', 'renderer')
  },
  get preload(): string {
    return join(mainDir, '..', 'preload', 'index.cjs')
  },
}
