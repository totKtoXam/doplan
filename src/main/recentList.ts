/**
 * Recent projects for the welcome screen, without Electron: the list itself lives in the settings
 * (settings.recent, see settings.addRecent); here each entry is checked on disk and paired with the
 * plan thumbnail stored in <userData>/recent-thumbs/<hash>.svg.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { RecentProject } from '../shared/ipc'
import { PLAN_FILE } from '../shared/projectFormat'
import { kindOfRecent, type RecentEntry, validThumb } from '../shared/recent'
import { atomicWrite, exists } from './fsutil'

/** thumbnails are keyed by the path as the recent list compares it (case-insensitively) */
export function thumbFile(dir: string, path: string): string {
  const key = createHash('sha1').update(path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 24)
  return join(dir, `${key}.svg`)
}

/** a project folder still has its plan.json; a .doplan file is still there */
export async function projectExists(path: string): Promise<boolean> {
  return kindOfRecent(path) === 'folder' ? exists(join(path, PLAN_FILE)) : exists(path)
}

async function readThumb(dir: string, path: string): Promise<string | null> {
  try {
    const svg = await fsp.readFile(thumbFile(dir, path), 'utf8')
    return validThumb(svg) ? svg : null
  } catch {
    return null
  }
}

export async function listEntries(recent: RecentProject[], thumbsDir: string): Promise<RecentEntry[]> {
  return Promise.all(
    recent.map(async (r) => ({
      path: r.path,
      name: r.name,
      modifiedAt: r.modifiedAt,
      exists: await projectExists(r.path),
      kind: kindOfRecent(r.path),
      thumb: await readThumb(thumbsDir, r.path),
    })),
  )
}

/** resolves false when the SVG is not a thumbnail (wrong type, too large) */
export async function writeThumb(thumbsDir: string, path: string, svg: unknown): Promise<boolean> {
  if (!validThumb(svg)) return false
  await atomicWrite(thumbFile(thumbsDir, path), svg)
  return true
}

export async function dropThumb(thumbsDir: string, path: string): Promise<void> {
  await fsp.rm(thumbFile(thumbsDir, path), { force: true }).catch(() => undefined)
}

/** removes thumbnails of projects that dropped out of the list */
export async function pruneThumbs(thumbsDir: string, recent: RecentProject[]): Promise<void> {
  let names: string[]
  try {
    names = await fsp.readdir(thumbsDir)
  } catch {
    return
  }
  const keep = new Set(recent.map((r) => thumbFile(thumbsDir, r.path)))
  await Promise.all(
    names
      .map((n) => join(thumbsDir, n))
      .filter((f) => f.endsWith('.svg') && !keep.has(f))
      .map((f) => fsp.rm(f, { force: true }).catch(() => undefined)),
  )
}
