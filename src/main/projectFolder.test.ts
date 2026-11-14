import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// main-process modules read app paths lazily; point userData at a temp folder
const base = mkdtempSync(join(tmpdir(), 'doplan-pf-test-'))
mkdirSync(join(base, 'userData'), { recursive: true })
vi.mock('electron', () => ({
  app: { getPath: () => join(base, 'userData'), getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const { gitCandidates, findGit } = await import('./git')
const { commitFolder, createFolderProject, folderRootOf, gitTrust, isProjectFolder } = await import('./projectFolder')
const { trustRepo } = await import('./settings')

function folder(name: string, files: Record<string, string>): string {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  return dir
}

const MANIFEST = JSON.stringify({ format: 'doplan-folder', version: 1, app: 'doplan', assets: [] })

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('project folder detection', () => {
  it('needs plan.json and a doplan-folder manifest', async () => {
    const ok = folder('ok', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    const stray = folder('stray', { 'plan.json': '{}' })
    const webApp = folder('web', { 'plan.json': '{}', 'manifest.json': JSON.stringify({ name: 'pwa', icons: [] }) })
    expect(await isProjectFolder(ok)).toBe(true)
    expect(await isProjectFolder(stray)).toBe(false)
    expect(await isProjectFolder(webApp)).toBe(false)
    expect(await folderRootOf(join(ok, 'plan.json'))).toBe(ok)
    expect(await folderRootOf(ok)).toBe(ok)
    expect(await folderRootOf(join(stray, 'plan.json'))).toBeNull()
    expect(await folderRootOf(webApp)).toBeNull()
    expect(await folderRootOf(join(base, 'missing'))).toBeNull()
  })
})

describe('git executable', () => {
  it('is only ever an absolute path, even with relative PATH entries', () => {
    const key = process.platform === 'win32' ? 'Path' : 'PATH'
    const saved = process.env[key]
    process.env[key] = ['.', 'bin', '', saved ?? ''].join(process.platform === 'win32' ? ';' : ':')
    try {
      const list = gitCandidates()
      expect(list.length).toBeGreaterThan(0)
      for (const p of list) expect(isAbsolute(p)).toBe(true)
    } finally {
      process.env[key] = saved
    }
  })
})

describe('git trust', { timeout: 30_000 }, async () => {
  const git = await findGit()

  it('a folder without .git needs no trust; a .git that came with the folder is untrusted', async () => {
    const plain = folder('plain', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    expect(await gitTrust(plain)).toBe('none')
    const foreign = folder('foreign', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await gitTrust(foreign)).toBe('untrusted')
    await expect(commitFolder(foreign, 'x')).rejects.toThrow()
  })

  it.skipIf(!git)('doplan repositories are trusted and repository hooks never run', async () => {
    const parent = join(base, 'projects')
    mkdirSync(parent, { recursive: true })
    const res = await createFolderProject(parent, 'Дом', { version: 1, meta: { name: 'Дом' } })
    expect(res.git).toBe(true)
    expect(await gitTrust(res.root)).toBe('trusted')
    // a hook planted later (e.g. by a copied folder or a tool) must not run on save
    const marker = join(base, 'hook-ran')
    const hook = join(res.root, '.git', 'hooks', 'post-commit')
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    writeFileSync(join(res.root, 'note.txt'), 'changed')
    expect(await commitFolder(res.root, 'Изменение')).toBeTruthy()
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!git)('the user can trust a foreign repository', async () => {
    const foreign = folder('foreign2', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await gitTrust(foreign)).toBe('untrusted')
    await trustRepo(foreign)
    expect(await gitTrust(foreign)).toBe('trusted')
  })
})
