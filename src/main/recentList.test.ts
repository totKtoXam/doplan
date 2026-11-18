import { mkdtempSync, promises as fsp, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { kindOfRecent, startupView, validThumb } from '../shared/recent'
import { dropThumb, listEntries, projectExists, pruneThumbs, thumbFile, writeThumb } from './recentList'

const root = mkdtempSync(join(tmpdir(), 'doplan-recent-'))
const thumbs = join(root, 'recent-thumbs')
const folder = join(root, 'Квартира')
const zip = join(root, 'Дача.doplan')
const gone = join(root, 'Удалённый.doplan')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

vi.mock('electron', () => ({ safeStorage: {}, app: { getPath: () => root } }))
vi.mock('./paths', () => ({ paths: { settingsFile: join(root, 'settings.json'), userData: root } }))

beforeAll(async () => {
  await fsp.mkdir(folder, { recursive: true })
  await fsp.writeFile(join(folder, 'plan.json'), '{}')
  await fsp.writeFile(zip, 'PK')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const at = '2026-11-18T10:00:00.000Z'

describe('recent projects on disk', () => {
  it('marks entries whose folder or file is gone', async () => {
    await fsp.mkdir(join(root, 'empty'), { recursive: true })
    expect(await projectExists(folder)).toBe(true)
    expect(await projectExists(zip)).toBe(true)
    expect(await projectExists(gone)).toBe(false)
    // a folder without plan.json is no longer a project
    expect(await projectExists(join(root, 'empty'))).toBe(false)

    const list = await listEntries(
      [
        { path: folder, name: 'Квартира', modifiedAt: at },
        { path: zip, name: 'Дача', modifiedAt: at },
        { path: gone, name: 'Удалённый', modifiedAt: at },
      ],
      thumbs,
    )
    expect(list.map((e) => [e.name, e.kind, e.exists])).toEqual([
      ['Квартира', 'folder', true],
      ['Дача', 'zip', true],
      ['Удалённый', 'zip', false],
    ])
    expect(list.every((e) => e.thumb === null && e.modifiedAt === at)).toBe(true)
  })

  it('keeps a thumbnail per project, whatever the case of its path', async () => {
    expect(await writeThumb(thumbs, folder, svg)).toBe(true)
    expect(thumbFile(thumbs, folder.toUpperCase())).toBe(thumbFile(thumbs, folder))
    const [e] = await listEntries([{ path: folder.toUpperCase(), name: 'Квартира', modifiedAt: at }], thumbs)
    expect(e.thumb).toBe(svg)
  })

  it('refuses anything that is not SVG markup or is too large', async () => {
    expect(await writeThumb(thumbs, zip, '<script>alert(1)</script>')).toBe(false)
    expect(await writeThumb(thumbs, zip, 42)).toBe(false)
    expect(await writeThumb(thumbs, zip, `<svg>${'x'.repeat(500 * 1024)}</svg>`)).toBe(false)
    const [e] = await listEntries([{ path: zip, name: 'Дача', modifiedAt: at }], thumbs)
    expect(e.thumb).toBeNull()
  })

  it('drops thumbnails of removed projects', async () => {
    await writeThumb(thumbs, zip, svg)
    await writeThumb(thumbs, gone, svg)
    await pruneThumbs(thumbs, [{ path: folder, name: 'Квартира', modifiedAt: at }, { path: zip, name: 'Дача', modifiedAt: at }])
    const names = await fsp.readdir(thumbs)
    expect(names.sort()).toEqual([thumbFile(thumbs, folder), thumbFile(thumbs, zip)].map((f) => f.slice(thumbs.length + 1)).sort())
    await dropThumb(thumbs, zip)
    expect(await fsp.readdir(thumbs)).toHaveLength(1)
  })
})

describe('recent list in the settings', () => {
  it('adds, finds and removes projects (case-insensitively)', async () => {
    const s = await import('./settings')
    await s.addRecent(folder, 'Квартира')
    await s.addRecent(zip)
    expect((await s.getSettings()).recent.map((r) => r.name)).toEqual(['Дача', 'Квартира'])
    expect(await s.isRecentPath(zip.toUpperCase())).toBe(true)
    expect(await s.removeRecent(zip.toUpperCase())).toBe(true)
    expect(await s.removeRecent(zip)).toBe(false)
    expect(await s.isRecentPath(zip)).toBe(false)
    expect((await s.getSettings()).recent.map((r) => r.path)).toEqual([folder])
  })
})

describe('shared helpers', () => {
  it('tells thumbnails from other text', () => {
    expect(validThumb(svg)).toBe(true)
    expect(validThumb(`<?xml version="1.0"?>\n${svg}`)).toBe(true)
    expect(validThumb('<svgx/>')).toBe(false)
    expect(validThumb(null)).toBe(false)
  })

  it('knows a .doplan file from a folder', () => {
    expect(kindOfRecent('C:\\p\\a.DOPLAN')).toBe('zip')
    expect(kindOfRecent('C:\\p\\a')).toBe('folder')
  })

  it('skips the welcome screen only when launched to open a file', () => {
    expect(startupView({ file: true })).toBe('file')
    expect(startupView({ file: false })).toBe('welcome')
    // main not reachable: the welcome screen is the safe default
    expect(startupView(null)).toBe('welcome')
  })
})
