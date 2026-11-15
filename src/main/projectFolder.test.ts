import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

const { gitCandidates, findGit, filterOffArgs } = await import('./git')
const { commitFolder, createFolderProject, folderRootOf, folderTrust, isProjectFolder, trustFolder } = await import('./projectFolder')
const { findOnPath } = await import('./aichat/detect')
const { execFileSync } = await import('node:child_process')

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
  it('agent CLIs are looked up in absolute PATH entries only', () => {
    const name = 'doplan-fake-cli'
    const rel = join(base, 'cwd-bin')
    mkdirSync(rel, { recursive: true })
    writeFileSync(join(rel, process.platform === 'win32' ? `${name}.exe` : name), '')
    const cwd = process.cwd()
    process.chdir(rel)
    try {
      expect(findOnPath(name, { PATH: '.', Path: '.' })).toBeNull()
      expect(findOnPath(name, { PATH: rel, Path: rel })?.path).toBe(join(rel, process.platform === 'win32' ? `${name}.exe` : name))
    } finally {
      process.chdir(cwd)
    }
  })

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

describe('folder trust', { timeout: 30_000 }, async () => {
  const git = await findGit()
  const gitIn = (dir: string, ...args: string[]) => execFileSync(git!, args, { cwd: dir, encoding: 'utf8' })

  it('a folder without .git has no repository yet; a .git that came with the folder is untrusted', async () => {
    const plain = folder('plain', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    expect(await folderTrust(plain)).toEqual({ git: 'none', folder: false })
    const foreign = folder('foreign', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
    expect(await folderTrust(foreign)).toEqual({ git: 'untrusted', folder: false })
    await expect(commitFolder(foreign, 'x')).rejects.toThrow()
  })

  it('a .git file (submodule, worktree) gets no history and no error', async () => {
    const sub = folder('submodule', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git': 'gitdir: ../elsewhere/.git\n' })
    expect((await folderTrust(sub)).git).toBe('gitfile')
    expect(await commitFolder(sub, 'x')).toBeNull()
    await trustFolder(sub)
    expect(await folderTrust(sub)).toEqual({ git: 'gitfile', folder: true })
  })

  it.skipIf(!git)('doplan repositories are trusted and repository hooks never run', async () => {
    const parent = join(base, 'projects')
    mkdirSync(parent, { recursive: true })
    const res = await createFolderProject(parent, 'Дом', { version: 1, meta: { name: 'Дом' } })
    expect(res.git).toBe(true)
    expect(await folderTrust(res.root)).toEqual({ git: 'trusted', folder: true })
    // a hook planted later (e.g. by a copied folder or a tool) must not run on save
    const marker = join(base, 'hook-ran')
    const hook = join(res.root, '.git', 'hooks', 'post-commit')
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    writeFileSync(join(res.root, 'note.txt'), 'changed')
    expect(await commitFolder(res.root, 'Изменение')).toBeTruthy()
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!git)('trust is bound to the folder on disk: a folder replaced at the same path is untrusted again', async () => {
    const parent = join(base, 'projects2')
    mkdirSync(parent, { recursive: true })
    const res = await createFolderProject(parent, 'Проект', { version: 1, meta: { name: 'Проект' } })
    expect(await folderTrust(res.root)).toEqual({ git: 'trusted', folder: true })
    // the trusted folder is moved away and a received copy is unpacked at the same path
    renameSync(res.root, join(parent, 'old'))
    folder(join('projects2', 'Проект'), { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(res.root, 'init', '-q')
    expect(await folderTrust(res.root)).toEqual({ git: 'untrusted', folder: false })
    await expect(commitFolder(res.root, 'x')).rejects.toThrow()
  })

  it.skipIf(!git)('saving a folder without .git creates a repository but does not trust the folder for the AI', async () => {
    const plain = folder('plain2', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    expect(await commitFolder(plain, 'Первая')).toBeTruthy()
    expect(await folderTrust(plain)).toEqual({ git: 'trusted', folder: false })
    await trustFolder(plain)
    expect(await folderTrust(plain)).toEqual({ git: 'trusted', folder: true })
  })

  it.skipIf(!git)('filter drivers from the repository config never run on save', async () => {
    const foreign = folder('filters', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.gitattributes': '*.json filter=evil\n' })
    gitIn(foreign, 'init', '-q')
    const marker = join(base, 'filter-ran').replace(/\\/g, '/')
    gitIn(foreign, 'config', 'filter.evil.clean', `sh -c "echo ran > '${marker}'; cat"`)
    gitIn(foreign, 'config', 'filter.evil.required', 'true')
    await trustFolder(foreign)
    expect((await folderTrust(foreign)).git).toBe('trusted')
    expect(await commitFolder(foreign, 'x')).toBeTruthy()
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!git)('filter drivers whose command or name has dots are switched off too', async () => {
    const marker = join(base, 'dotted-ran').replace(/\\/g, '/')
    const script = `echo ran >> '${marker}'\ncat\n`
    const foreign = folder('filters-dotted', {
      'plan.json': '{}',
      'manifest.json': MANIFEST,
      'note.txt': 'x',
      '.gitattributes': '*.json filter=evil\n*.txt filter=a.b\n',
      'evil.sh': script,
      'proc.sh': script,
    })
    gitIn(foreign, 'init', '-q')
    // only a clean command with a dot in it: no other key names the driver
    gitIn(foreign, 'config', 'filter.evil.clean', 'sh ./evil.sh')
    gitIn(foreign, 'config', 'filter.a.b.process', 'sh ./proc.sh')
    expect(await filterOffArgs(foreign)).toEqual(expect.arrayContaining(['filter.evil.clean=', 'filter.a.b.process=']))
    await trustFolder(foreign)
    expect(await commitFolder(foreign, 'x')).toBeTruthy()
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!git)('the driver with an empty name ([filter ""], `filter=` in .gitattributes) is switched off', async () => {
    const marker = join(base, 'empty-ran').replace(/\\/g, '/')
    const foreign = folder('filters-empty', {
      'plan.json': '{}',
      'manifest.json': MANIFEST,
      '.gitattributes': '* filter=\n',
      'evil.sh': `echo ran >> '${marker}'\ncat\n`,
    })
    gitIn(foreign, 'init', '-q')
    gitIn(foreign, 'config', 'filter..clean', 'sh ./evil.sh')
    expect(await filterOffArgs(foreign)).toEqual(expect.arrayContaining(['filter..clean=']))
    await trustFolder(foreign)
    expect(await commitFolder(foreign, 'x')).toBeTruthy()
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!git)("drivers from files the user's own config includes stay on (git-lfs set up through include.path)", async () => {
    const home = folder('home', {
      '.gitconfig': '[include]\n\tpath = lfs.inc\n',
      'lfs.inc': '[filter "mylfs"]\n\tclean = cat\n\tsmudge = cat\n',
    })
    const repo = folder('filters-include', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(repo, 'init', '-q')
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    delete process.env['XDG_CONFIG_HOME']
    try {
      const args = await filterOffArgs(repo)
      expect(args.some((a) => a.startsWith('filter.mylfs.'))).toBe(false)
      // the same driver defined by the repository itself is switched off
      gitIn(repo, 'config', 'filter.mylfs.clean', 'sh ./other.sh')
      expect(await filterOffArgs(repo)).toEqual(expect.arrayContaining(['filter.mylfs.clean=']))
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it.skipIf(!git)('drivers from ~/.config/git/config stay on while ~/.gitconfig exists too', async () => {
    const home = folder('home-xdg', {
      '.gitconfig': '[user]\n\tname = someone\n',
      '.config/git/config': '[include]\n\tpath = lfs.inc\n[filter "xdglfs"]\n\tclean = cat\n',
      '.config/git/lfs.inc': '[filter "inclfs"]\n\tclean = cat\n',
    })
    const repo = folder('filters-xdg', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(repo, 'init', '-q')
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    delete process.env['XDG_CONFIG_HOME']
    try {
      const args = await filterOffArgs(repo)
      expect(args.some((a) => a.startsWith('filter.xdglfs.') || a.startsWith('filter.inclfs.'))).toBe(false)
      // the repository defining the same driver its own way is still switched off
      gitIn(repo, 'config', 'filter.xdglfs.clean', 'sh ./other.sh')
      expect(await filterOffArgs(repo)).toEqual(expect.arrayContaining(['filter.xdglfs.clean=']))
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it.skipIf(!git)('drivers that ~/.config/git/config includes only for some repositories (includeIf) stay on', async () => {
    const repo = folder('filters-includeif', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(repo, 'init', '-q')
    gitIn(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    gitIn(repo, 'remote', 'add', 'origin', 'https://example.com/team/plan.git')
    const slash = (p: string) => p.replace(/\\/g, '/')
    const home = folder('home-includeif', {
      '.gitconfig': '[user]\n\tname = someone\n',
      '.config/git/config': [
        `[includeIf "gitdir:${slash(repo)}/"]\n\tpath = gitdir.inc`,
        `[includeIf "gitdir/i:${slash(base)}/**"]\n\tpath = wild.inc`,
        '[includeIf "onbranch:main"]\n\tpath = branch.inc',
        '[includeIf "hasconfig:remote.*.url:https://example.com/**"]\n\tpath = remote.inc',
        '',
      ].join('\n'),
      '.config/git/gitdir.inc': '[filter "gd"]\n\tclean = cat\n',
      '.config/git/wild.inc': '[filter "wd"]\n\tclean = cat\n',
      '.config/git/branch.inc': '[filter "br"]\n\tclean = cat\n',
      '.config/git/remote.inc': '[filter "rm"]\n\tclean = cat\n',
    })
    // the repository's own conditional include is still the repository's
    const evil = folder('repo-included', { 'evil.inc': '[filter "ev"]\n\tclean = sh ./evil.sh\n' })
    gitIn(repo, 'config', 'includeIf.hasconfig:remote.*.url:https://example.com/**.path', `${slash(evil)}/evil.inc`)
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    delete process.env['XDG_CONFIG_HOME']
    try {
      // git itself applies all four includes in this repository
      const effective = gitIn(repo, 'config', '--get-regexp', '^filter\\.')
      for (const n of ['gd', 'wd', 'br', 'rm', 'ev']) expect(effective).toContain(`filter.${n}.clean`)
      const args = await filterOffArgs(repo)
      for (const n of ['gd', 'wd', 'br', 'rm']) expect(args.some((a) => a.startsWith(`filter.${n}.`))).toBe(false)
      expect(args).toEqual(expect.arrayContaining(['filter.ev.clean=']))
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it.skipIf(!git)('a filter driver that cannot be switched off stops the commit', async () => {
    const foreign = folder('filters-eq', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(foreign, 'init', '-q')
    gitIn(foreign, 'config', 'filter.x=y.clean', 'cat')
    await trustFolder(foreign)
    await expect(commitFolder(foreign, 'x')).rejects.toThrow()
  })

  it.skipIf(!git)('the user can trust a foreign repository', async () => {
    const foreign = folder('foreign2', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
    expect((await folderTrust(foreign)).git).toBe('untrusted')
    await trustFolder(foreign)
    expect(await folderTrust(foreign)).toEqual({ git: 'trusted', folder: true })
  })
})
