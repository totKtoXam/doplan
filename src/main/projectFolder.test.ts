import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
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

const { gitCandidates, findGit, filterOffArgs, gitLog, gitShowFile, UnsafeGitConfigError, scanLimit, gitDirProblems } = await import('./git')
const { commitFolder, createFolderProject, folderRootOf, folderTrust, isProjectFolder, readVersion, resetFolderGitConfig, trustFolder } = await import('./projectFolder')
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

/**
 * readdir as Windows lists a synced folder (OneDrive, Dropbox Files On-Demand): libuv reports every
 * reparse point, cloud placeholders too, as a link, while lstat still says file or folder.
 */
function asPlaceholders() {
  const real = fsp.readdir.bind(fsp) as (p: unknown, o: unknown) => Promise<unknown[]>
  return vi.spyOn(fsp, 'readdir').mockImplementation((async (p: unknown, o?: { withFileTypes?: boolean }) => {
    const list = await real(p, o)
    if (!o?.withFileTypes) return list
    return (list as { name: string; parentPath: string }[]).map((e) => ({
      name: e.name,
      parentPath: e.parentPath,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }))
  }) as never)
}

/** readdir failing with `code` for the folders whose path matches `which` */
function failingReaddir(which: RegExp, code: () => string) {
  const real = fsp.readdir.bind(fsp) as (p: unknown, o: unknown) => Promise<unknown[]>
  return vi.spyOn(fsp, 'readdir').mockImplementation((async (p: unknown, o?: unknown) => {
    if (which.test(String(p))) throw Object.assign(new Error(code()), { code: code() })
    return real(p, o)
  }) as never)
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

  it('a received folder without .git is unknown; a .git that came with the folder is untrusted', async () => {
    const plain = folder('plain', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    expect(await folderTrust(plain)).toEqual({ git: 'unknown', folder: false })
    const foreign = folder('foreign', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
    // (a .git with HEAD only is no complete repository either: unsafeGit lists what is missing)
    expect(await folderTrust(foreign)).toMatchObject({ git: 'untrusted', folder: false })
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
    mkdirSync(join(res.root, '.git', 'hooks'), { recursive: true })
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

  it.skipIf(!git)('saving a received folder without .git runs no git until the user trusts it', async () => {
    const plain = folder('plain2', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    expect(await commitFolder(plain, 'Первая')).toBeNull()
    expect(existsSync(join(plain, '.git'))).toBe(false)
    expect(await folderTrust(plain)).toEqual({ git: 'unknown', folder: false })
    await trustFolder(plain)
    expect(await folderTrust(plain)).toEqual({ git: 'none', folder: true })
    expect(await commitFolder(plain, 'Первая')).toBeTruthy()
    expect(await folderTrust(plain)).toEqual({ git: 'trusted', folder: true })
  })

  it.skipIf(!git)('a folder doplan created without git gets its repository on a later save', async () => {
    // trusted with no .git (git was missing when it was created): `trustFolder(root, false)` as the old first save did
    const own = folder('own-nogit', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    await trustFolder(own, false)
    expect(await folderTrust(own)).toEqual({ git: 'none', folder: false })
    expect(await commitFolder(own, 'Первая')).toBeTruthy()
    expect(await folderTrust(own)).toEqual({ git: 'trusted', folder: false })
  })

  it.skipIf(!git)('filter drivers from the repository config never run on save', async () => {
    const foreign = folder('filters', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.gitattributes': '*.json filter=evil\n' })
    gitIn(foreign, 'init', '-q')
    const marker = join(base, 'filter-ran').replace(/\\/g, '/')
    gitIn(foreign, 'config', 'filter.evil.clean', `sh -c "echo ran > '${marker}'; cat"`)
    gitIn(foreign, 'config', 'filter.evil.required', 'true')
    await trustFolder(foreign)
    expect((await folderTrust(foreign)).git).toBe('trusted')
    expect((await folderTrust(foreign)).unsafeGit?.keys).toEqual(expect.arrayContaining(['filter.evil.clean']))
    expect(await commitFolder(foreign, 'x')).toBeNull()
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
    expect(await commitFolder(foreign, 'x')).toBeNull()
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
    expect(await commitFolder(foreign, 'x')).toBeNull()
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

  it.skipIf(!git)('a filter driver that cannot be switched off is refused', async () => {
    const foreign = folder('filters-eq', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(foreign, 'init', '-q')
    gitIn(foreign, 'config', 'filter.x=y.clean', 'cat')
    await expect(filterOffArgs(foreign)).rejects.toThrow()
    await trustFolder(foreign)
    expect(await commitFolder(foreign, 'x')).toBeNull()
  })

  it.skipIf(!git)('the user can trust a foreign repository', async () => {
    const foreign = folder('foreign2', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    gitIn(foreign, 'init', '-q', '--template=')
    expect((await folderTrust(foreign)).git).toBe('untrusted')
    await trustFolder(foreign)
    expect(await folderTrust(foreign)).toEqual({ git: 'trusted', folder: true })
  })
})

// Git and the programs it starts (git-lfs, gpg) take commands from many keys of a repository's own
// config, so doplan runs git only in a repository whose config holds nothing but a short list of plain keys.
describe('repository config allowlist', { timeout: 60_000 }, async () => {
  const git = await findGit()
  const lfs =
    !!git &&
    (() => {
      try {
        execFileSync(git, ['lfs', 'version'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()
  const slash = (p: string) => p.replace(/\\/g, '/')
  /** git as the user's own client or an agent would run it: none of doplan's flags */
  const plainGit = (dir: string, ...args: string[]) => execFileSync(git!, args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 })

  /** runs `fn` with a fresh HOME (no ~/.gitconfig of the machine's user) */
  async function inHome(name: string, fn: (home: string) => Promise<void>): Promise<void> {
    const home = folder(name, { '.gitconfig': '[user]\n\tname = t\n\temail = t@example.com\n' })
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    delete process.env['XDG_CONFIG_HOME']
    try {
      await fn(home)
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  /** a received project folder with a repository and one commit, made by plain git */
  function received(name: string, files: Record<string, string> = {}): string {
    const dir = folder(name, { 'plan.json': '{"a":1}', 'manifest.json': MANIFEST, ...files })
    plainGit(dir, 'init', '-q')
    plainGit(dir, 'add', '-A')
    plainGit(dir, 'commit', '-qm', 'one')
    return dir
  }

  it.skipIf(!git)('a partial clone missing an object never fetches it (remote.*.uploadpack, core.gitProxy)', () =>
    inHome('home-lazy', async () => {
      const dir = received('lazy')
      const marker = slash(join(base, 'lazy-ran'))
      const sha = plainGit(dir, 'rev-parse', 'HEAD').trim()
      const blob = plainGit(dir, 'rev-parse', 'HEAD:plan.json').trim()
      plainGit(dir, 'config', 'core.repositoryformatversion', '1')
      plainGit(dir, 'config', 'extensions.partialClone', 'origin')
      plainGit(dir, 'config', 'remote.origin.url', slash(dir))
      plainGit(dir, 'config', 'remote.origin.promisor', 'true')
      plainGit(dir, 'config', 'remote.origin.uploadpack', `echo ran > '${marker}'; git-upload-pack`)
      unlinkSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
      // plain git fetches the missing blob, and the fetch runs the command
      try {
        plainGit(dir, 'show', `${sha}:plan.json`)
      } catch {
        /* the fetch fails afterwards */
      }
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      // a git:// remote is reached through core.gitProxy
      plainGit(dir, 'config', 'core.gitProxy', 'sh ./proxy.sh')
      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit?.keys).toEqual(
        expect.arrayContaining(['extensions.partialclone', 'remote.origin.promisor', 'remote.origin.uploadpack', 'core.gitproxy']),
      )
      await expect(readVersion(dir, sha)).rejects.toBeInstanceOf(UnsafeGitConfigError)
      await expect(gitShowFile(dir, sha, 'plan.json')).rejects.toBeInstanceOf(UnsafeGitConfigError)
      writeFileSync(join(dir, 'plan.json'), '{"a":2}')
      expect(await commitFolder(dir, 'x')).toBeNull()
      expect(existsSync(marker)).toBe(false)
    }),
  )

  it.skipIf(!git)('the version history never verifies signatures with programs from the repository config (log.showSignature)', () =>
    inHome('home-gpg', async (home) => {
      const dir = received('gpg')
      const marker = slash(join(base, 'gpg-ran'))
      const script = join(base, 'gpg-fake.sh')
      writeFileSync(script, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 })
      // HEAD becomes a commit with a signature
      const raw = plainGit(dir, 'cat-file', 'commit', 'HEAD')
      const signed = raw.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\n')
      const sha = execFileSync(git!, ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, input: signed, encoding: 'utf8' }).trim()
      plainGit(dir, 'update-ref', 'HEAD', sha)
      plainGit(dir, 'config', 'log.showSignature', 'true')
      plainGit(dir, 'config', 'gpg.program', slash(script))
      plainGit(dir, 'log', '--format=%H')
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit?.keys).toEqual(expect.arrayContaining(['log.showsignature', 'gpg.program']))
      await expect(gitLog(dir)).rejects.toBeInstanceOf(UnsafeGitConfigError)
      expect(existsSync(marker)).toBe(false)

      // the same keys in the user's own config (theirs to set): doplan's log still verifies nothing
      writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = t\n\temail = t@example.com\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${slash(script)}\n`)
      await resetFolderGitConfig(dir)
      expect((await folderTrust(dir)).unsafeGit).toBeUndefined()
      expect((await gitLog(dir)).map((v) => v.sha)).toEqual([sha])
      expect(existsSync(marker)).toBe(false)
    }),
  )

  it.skipIf(!lfs)('git-lfs never runs lfs.extension commands from the repository config', () =>
    inHome('home-lfs', async () => {
      const marker = slash(join(base, 'lfs-ran'))
      const dir = received('lfs', { '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n', 'evil.sh': `echo "$@" >> '${marker}'\ncat\n` })
      plainGit(dir, 'config', 'lfs.extension.foo.clean', 'sh evil.sh clean %f')
      plainGit(dir, 'config', 'lfs.extension.foo.smudge', 'sh evil.sh smudge %f')
      plainGit(dir, 'config', 'lfs.extension.foo.priority', '0')
      // git-lfs, switched on by the system config, runs the extension on plain `git add`
      writeFileSync(join(dir, 'a.png'), 'png')
      plainGit(dir, 'add', 'a.png')
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
      plainGit(dir, 'reset', '-q')

      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit?.keys).toEqual(expect.arrayContaining(['lfs.extension.foo.clean']))
      writeFileSync(join(dir, 'b.png'), 'png')
      expect(await commitFolder(dir, 'x')).toBeNull()
      expect(existsSync(marker)).toBe(false)
    }),
  )

  it.skipIf(!git)('any other key, an include or a worktree config: doplan runs no git command in the folder', () =>
    inHome('home-unknown', async () => {
      const dir = folder('unknown', { 'plan.json': '{}', 'manifest.json': MANIFEST })
      plainGit(dir, 'init', '-q')
      plainGit(dir, 'config', 'foo.bar', '1')
      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit).toEqual({ keys: ['foo.bar'], resettable: true })
      expect(await commitFolder(dir, 'x')).toBeNull()
      await expect(gitLog(dir)).rejects.toBeInstanceOf(UnsafeGitConfigError)
      // `git add` never ran: there is no index
      expect(existsSync(join(dir, '.git', 'index'))).toBe(false)

      // an include is refused, not followed, even of a file with plain keys only
      plainGit(dir, 'config', '--unset', 'foo.bar')
      writeFileSync(join(base, 'plain.inc'), '[user]\n\tname = x\n')
      plainGit(dir, 'config', 'include.path', slash(join(base, 'plain.inc')))
      expect((await folderTrust(dir)).unsafeGit?.keys).toEqual(['include.path'])
      plainGit(dir, 'config', '--unset', 'include.path')
      expect((await folderTrust(dir)).unsafeGit).toBeUndefined()
      // config.worktree counts whether or not extensions.worktreeConfig is set
      writeFileSync(join(dir, '.git', 'config.worktree'), '[core]\n\tfsmonitor = sh ./x.sh\n')
      expect((await folderTrust(dir)).unsafeGit?.keys).toEqual(['core.fsmonitor'])
      rmSync(join(dir, '.git', 'config.worktree'))
      expect(await commitFolder(dir, 'x')).toBeTruthy()

      // without a repository only `git init` runs: git does not go looking for one above the folder
      const noRepo = folder('no-repo', { 'plan.json': '{}' })
      await expect(gitLog(noRepo)).rejects.toThrow()
    }),
  )

  it.skipIf(!git)('resetting the config keeps the allowed keys, backs up the old files, and versions work again', () =>
    inHome('home-reset', async () => {
      const marker = slash(join(base, 'reset-ran'))
      const dir = received('reset', { '.gitattributes': '*.json filter=evil\n' })
      plainGit(dir, 'config', 'user.name', 'Автор')
      plainGit(dir, 'config', 'remote.origin.url', 'https://example.com/team/plan.git')
      plainGit(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      plainGit(dir, 'config', 'filter.evil.clean', `sh -c "echo ran > '${marker}'; cat"`)
      plainGit(dir, 'config', 'include.path', '../missing.inc')
      plainGit(dir, 'config', 'core.repositoryformatversion', '1')
      plainGit(dir, 'config', 'extensions.worktreeConfig', 'true')
      writeFileSync(join(dir, '.git', 'config.worktree'), '[core]\n\tsshCommand = sh ./evil.sh\n[user]\n\temail = a@example.com\n')
      const before = readFileSync(join(dir, '.git', 'config'), 'utf8')
      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit).toEqual({ keys: expect.arrayContaining(['filter.evil.clean', 'include.path', 'core.sshcommand']), resettable: true })

      const backup = await resetFolderGitConfig(dir)
      expect(backup).toBe(join(dir, '.git', 'config.doplan-backup'))
      expect(readFileSync(backup, 'utf8')).toBe(before)
      expect(existsSync(join(dir, '.git', 'config.worktree'))).toBe(false)
      expect(existsSync(join(dir, '.git', 'config.worktree.doplan-backup'))).toBe(true)
      const list = plainGit(dir, 'config', '--file', '.git/config', '--list').trim().split('\n')
      expect(list).toEqual(
        expect.arrayContaining(['core.repositoryformatversion=0', 'user.name=Автор', 'user.email=a@example.com', 'remote.origin.url=https://example.com/team/plan.git']),
      )
      expect(list.filter((l) => /^(filter|include|extensions|core\.sshcommand)/.test(l))).toEqual([])
      expect(await folderTrust(dir)).toEqual({ git: 'trusted', folder: true })
      writeFileSync(join(dir, 'plan.json'), '{"a":2}')
      expect(await commitFolder(dir, 'после сброса')).toBeTruthy()
      expect(existsSync(marker)).toBe(false)

      // a second reset keeps the first backup
      plainGit(dir, 'config', 'foo.bar', '1')
      expect(await resetFolderGitConfig(dir)).toBe(join(dir, '.git', 'config.doplan-backup-1'))
      expect(readFileSync(backup, 'utf8')).toBe(before)

      // a gitdir that takes its config from another repository cannot be reset
      writeFileSync(join(dir, '.git', 'commondir'), '../other\n')
      expect((await folderTrust(dir)).unsafeGit).toEqual({ keys: [], resettable: false, layout: ['.git/commondir'] })
      await expect(resetFolderGitConfig(dir)).rejects.toThrow()
    }),
  )
})

// A repository is more than its config: git finds its gitdir by walking the folder (and its parents),
// and follows alternates, linked worktrees and nested repositories it meets. doplan names the gitdir
// itself and refuses layouts that would take git elsewhere.
describe('repository layout', { timeout: 60_000 }, async () => {
  const git = await findGit()
  const lfs =
    !!git &&
    (() => {
      try {
        execFileSync(git, ['lfs', 'version'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()
  const canLink = (() => {
    const probe = join(base, 'link-probe')
    try {
      symlinkSync(join(base, 'link-probe-target'), probe, 'file')
      unlinkSync(probe)
      return true
    } catch {
      return false
    }
  })()
  const slash = (p: string) => p.replace(/\\/g, '/')
  const plainGit = (dir: string, ...args: string[]) => execFileSync(git!, args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 })

  async function inHome(name: string, fn: (home: string) => Promise<void>, gitconfig = ''): Promise<void> {
    const home = folder(name, { '.gitconfig': `[user]\n\tname = t\n\temail = t@example.com\n${gitconfig}` })
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    delete process.env['XDG_CONFIG_HOME']
    try {
      await fn(home)
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  function received(name: string, files: Record<string, string> = {}): string {
    const dir = folder(name, { 'plan.json': '{"a":1}', 'manifest.json': MANIFEST, ...files })
    plainGit(dir, 'init', '-q')
    plainGit(dir, 'add', '-A')
    plainGit(dir, 'commit', '-qm', 'one')
    return dir
  }

  async function created(name: string): Promise<string> {
    const parent = join(base, `created-${name}`)
    mkdirSync(parent, { recursive: true })
    const res = await createFolderProject(parent, name, { version: 1, meta: { name } })
    expect(res.commit).toBeTruthy()
    return res.root
  }

  /** a folder that looks like a bare repository itself (HEAD, objects, refs, config) next to an empty .git */
  function bareLookalike(dir: string, config: string): void {
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'objects'), { recursive: true })
    mkdirSync(join(dir, 'refs', 'heads'), { recursive: true })
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dir, 'config'), config)
  }

  it.skipIf(!git)('an empty or broken .git is no repository: git never takes the folder or a parent for one', async () => {
    const dir = folder('empty-git', { 'plan.json': '{}', 'manifest.json': MANIFEST })
    bareLookalike(dir, '[core]\n\tbare = true\n')
    await trustFolder(dir)
    const trust = await folderTrust(dir)
    expect(trust.git).toBe('trusted')
    expect(trust.unsafeGit).toEqual({ keys: [], resettable: false, layout: expect.arrayContaining(['.git/HEAD', '.git/objects', '.git/refs']) })
    expect(await commitFolder(dir, 'x')).toBeNull()
    await expect(gitLog(dir)).rejects.toBeInstanceOf(UnsafeGitConfigError)
    await expect(resetFolderGitConfig(dir)).rejects.toThrow()
    expect(existsSync(join(dir, 'index'))).toBe(false)
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false)

    // a project folder inside someone else's repository, with an empty .git of its own
    const outer = received('outer-repo')
    const inner = folder(join('outer-repo', 'inner'), { 'plan.json': '{}', 'manifest.json': MANIFEST })
    mkdirSync(join(inner, '.git'))
    await trustFolder(inner)
    expect(await commitFolder(inner, 'x')).toBeNull()
    expect(plainGit(outer, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(plainGit(outer, 'status', '--porcelain')).toContain('inner/')
  })

  it.skipIf(!lfs)('the lfs.extension of a bare-looking folder or of a parent repository never runs', () =>
    inHome('home-bare-lfs', async () => {
      const marker = slash(join(base, 'bare-lfs-ran'))
      const evil = slash(join(base, 'bare-lfs-evil.sh'))
      writeFileSync(evil, `echo "$@" >> '${marker}'\ncat\n`)
      const ext = `[lfs "extension.foo"]\n\tclean = sh '${evil}' clean %f\n\tsmudge = sh '${evil}' smudge %f\n\tpriority = 0\n`
      const files = { 'plan.json': '{}', 'manifest.json': MANIFEST, '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n', 'a.png': 'png' }

      const dir = folder('bare-lfs', files)
      bareLookalike(dir, `[core]\n\tbare = true\n${ext}`)
      // plain git takes the folder itself for the repository and runs the extension
      try {
        plainGit(dir, '--work-tree=.', 'add', 'a.png')
      } catch {
        /* whatever git makes of it afterwards */
      }
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
      rmSync(join(dir, 'index'), { force: true })
      await trustFolder(dir)
      expect(await commitFolder(dir, 'x')).toBeNull()
      expect(existsSync(marker)).toBe(false)

      // the parent is a repository with the extension; the project folder has an empty .git
      const outer = received('outer-lfs')
      plainGit(outer, 'config', 'lfs.extension.foo.clean', `sh '${evil}' clean %f`)
      plainGit(outer, 'config', 'lfs.extension.foo.smudge', `sh '${evil}' smudge %f`)
      plainGit(outer, 'config', 'lfs.extension.foo.priority', '0')
      const inner = folder(join('outer-lfs', 'inner'), files)
      mkdirSync(join(inner, '.git'))
      await trustFolder(inner)
      expect(await commitFolder(inner, 'x')).toBeNull()
      expect(existsSync(marker)).toBe(false)
      // without .git the trusted folder gets a repository of its own: still nothing of the parent runs
      rmSync(join(inner, '.git'), { recursive: true })
      await trustFolder(inner)
      expect(await commitFolder(inner, 'x')).toBeTruthy()
      expect(existsSync(marker)).toBe(false)
      expect(plainGit(outer, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    }),
  )

  it.skipIf(!lfs)('a repository set up for git-lfs keeps its version history', () =>
    inHome('home-lfs-ok', async () => {
      const root = await created('LFS')
      // `git lfs track` writes lfs.repositoryformatversion = 0 into .git/config
      plainGit(root, 'lfs', 'track', '*.bin')
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toMatch(/\[lfs\][\s\S]*repositoryformatversion = 0/)
      writeFileSync(join(root, 'a.bin'), 'one')
      expect(await commitFolder(root, 'lfs 1')).toBeTruthy()
      writeFileSync(join(root, 'a.bin'), 'two')
      expect(await commitFolder(root, 'lfs 2')).toBeTruthy()
      expect((await folderTrust(root)).unsafeGit).toBeUndefined()
      expect((await gitLog(root)).length).toBe(3)
      expect(plainGit(root, 'lfs', 'ls-files', '--name-only').trim()).toBe('a.bin')

      // what git-lfs records for a remote is allowed with its own values only
      plainGit(root, 'config', 'lfs.https://example.com/team/plan.git/info/lfs.access', 'basic')
      plainGit(root, 'config', 'lfs.https://example.com/team/plan.git/info/lfs.locksverify', 'false')
      expect((await folderTrust(root)).unsafeGit).toBeUndefined()
      plainGit(root, 'config', 'lfs.repositoryformatversion', '1')
      expect((await folderTrust(root)).unsafeGit?.keys).toEqual(['lfs.repositoryformatversion'])
      plainGit(root, 'config', 'lfs.repositoryformatversion', '0')
      plainGit(root, 'config', 'lfs.https://example.com/team/plan.git/info/lfs.access', 'sh ./x.sh')
      expect((await folderTrust(root)).unsafeGit?.keys).toEqual(['lfs.https://example.com/team/plan.git/info/lfs.access'])
    }),
  )

  it.skipIf(!git)('a nested repository (a .git file or folder below the top) stops the commit', async () => {
    const root = await created('Nested')
    folder(join('created-Nested', 'Nested', 'models', 'sub'), { '.git': `gitdir: ${slash(join(base, 'elsewhere', '.git'))}\n`, 'a.txt': 'a' })
    await expect(commitFolder(root, 'x')).rejects.toThrow(/вложенный репозиторий|nested git repository/)
    rmSync(join(root, 'models', 'sub', '.git'))
    mkdirSync(join(root, 'models', 'sub', '.GIT'))
    await expect(commitFolder(root, 'x')).rejects.toThrow(/models\/sub\/\.GIT/)
    rmSync(join(root, 'models', 'sub', '.GIT'), { recursive: true })
    expect(await commitFolder(root, 'x')).toBeTruthy()
  })

  const layoutOf = async (root: string) => (await folderTrust(root)).unsafeGit?.layout

  it.skipIf(!git)('any other object store (alternates, http-alternates) makes the repository unsupported, local or not', async () => {
    const root = await created('Network')
    const info = join(root, '.git', 'objects', 'info')
    mkdirSync(info, { recursive: true })
    const alternates = join(info, 'alternates')
    const other = join(base, 'other-objects')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(root, 'plan.json'), '{"n":0}')
    for (const line of [
      '//192.0.2.1/share/objects',
      '\\\\192.0.2.1\\share\\objects',
      '\\\\?\\UNC\\192.0.2.1\\share\\objects',
      // quoted (git unquotes it), relative (chained through another store), and plain local
      '"\\\\\\\\192.0.2.1\\\\share\\\\objects"',
      '../../../other-objects',
      slash(other),
      '',
    ]) {
      writeFileSync(alternates, `# shared objects\n${line}\n`)
      expect(await folderTrust(root)).toMatchObject({ git: 'trusted', unsafeGit: { keys: [], resettable: false, layout: ['.git/objects/info/alternates'] } })
      expect(await commitFolder(root, 'x')).toBeNull()
      await expect(gitLog(root)).rejects.toBeInstanceOf(UnsafeGitConfigError)
      await expect(resetFolderGitConfig(root)).rejects.toThrow()
    }
    rmSync(alternates)
    expect(await layoutOf(root)).toBeUndefined()
    writeFileSync(join(info, 'http-alternates'), 'https://example.com/objects\n')
    expect(await layoutOf(root)).toEqual(['.git/objects/info/http-alternates'])
    rmSync(join(info, 'http-alternates'))
    writeFileSync(join(root, 'plan.json'), '{"n":1}')
    expect(await commitFolder(root, 'x')).toBeTruthy()
  })

  it.skipIf(!git)('a linked worktree whose commondir leaves .git, or whose path is on another machine, makes the repository unsupported', async () => {
    const root = await created('Worktrees')
    const wt = join(root, '.git', 'worktrees', 'w1')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, 'gitdir'), '\\\\192.0.2.1\\share\\wt\\.git\n')
    expect(await layoutOf(root)).toEqual(['.git/worktrees/w1/gitdir'])
    writeFileSync(join(wt, 'gitdir'), '"C:/quoted/.git"\n')
    expect(await layoutOf(root)).toEqual(['.git/worktrees/w1/gitdir'])
    writeFileSync(join(wt, 'gitdir'), `${join(base, 'wt', '.git')}\n`)
    expect(await layoutOf(root)).toBeUndefined()
    // commondir as `git worktree add` writes it is fine; one that leaves .git is not
    writeFileSync(join(wt, 'commondir'), '../..\n')
    expect(await layoutOf(root)).toBeUndefined()
    writeFileSync(join(root, 'plan.json'), '{"w":0}')
    for (const out of ['../../..', '../../../elsewhere/.git', '//192.0.2.1/share/repo.git', slash(join(base, 'elsewhere'))]) {
      writeFileSync(join(wt, 'commondir'), `${out}\n`)
      expect(await layoutOf(root)).toEqual(['.git/worktrees/w1/commondir'])
      expect(await commitFolder(root, 'x')).toBeNull()
    }
    rmSync(join(root, '.git', 'worktrees'), { recursive: true })

    // a real linked worktree made by git is a plain local path: the repository keeps working
    const linked = join(base, 'created-Worktrees', 'linked')
    plainGit(root, 'worktree', 'add', '-q', '-b', 'side', linked)
    expect(await folderTrust(root)).toEqual({ git: 'trusted', folder: true })
    writeFileSync(join(root, 'plan.json'), '{"w":1}')
    expect(await commitFolder(root, 'с рабочей копией')).toBeTruthy()
  })

  /** a junction on Windows (no privilege needed), a directory symlink elsewhere */
  const junction = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  const countEntries = (dir: string) => readdirSync(dir, { recursive: true }).length

  it.skipIf(!git)('a junction anywhere in .git: doplan runs no git in the folder and writes nothing through it', async () => {
    const root = await created('GitJunction')
    const logs = join(root, '.git', 'logs')
    const outside = join(base, 'git-junction-outside')
    renameSync(logs, outside)
    junction(outside, logs)
    // plain git writes its reflog through the junction
    const head = readFileSync(join(outside, 'HEAD'), 'utf8')
    expect(await folderTrust(root)).toMatchObject({ git: 'trusted', unsafeGit: { keys: [], resettable: false, layout: ['.git/logs'] } })
    writeFileSync(join(root, 'plan.json'), '{"j":1}')
    expect(await commitFolder(root, 'x')).toBeNull()
    await expect(gitLog(root)).rejects.toBeInstanceOf(UnsafeGitConfigError)
    await expect(resetFolderGitConfig(root)).rejects.toThrow()
    expect(readFileSync(join(outside, 'HEAD'), 'utf8')).toBe(head)
    unlinkSync(logs)
    renameSync(outside, logs)
    expect(await layoutOf(root)).toBeUndefined()

    // deeper down it counts the same, and so does the whole .git being one
    const store = folder('git-junction-store', {})
    junction(store, join(root, '.git', 'objects', 'ab'))
    expect(await layoutOf(root)).toEqual(['.git/objects/ab'])
    expect(await commitFolder(root, 'x')).toBeNull()
    expect(readdirSync(store)).toEqual([])
    unlinkSync(join(root, '.git', 'objects', 'ab'))
    expect(await commitFolder(root, 'без ссылок')).toBeTruthy()
  })

  it.skipIf(!git || !canLink)('a symbolic link in .git is never followed, not even to look at the file it names', async () => {
    const root = await created('GitSymlink')
    // COMMIT_EDITMSG pointing outside: the commit would write its message there
    const outside = join(base, 'git-symlink-outside.txt')
    writeFileSync(outside, 'keep')
    rmSync(join(root, '.git', 'COMMIT_EDITMSG'), { force: true })
    symlinkSync(outside, join(root, '.git', 'COMMIT_EDITMSG'), 'file')
    expect(await layoutOf(root)).toEqual(['.git/COMMIT_EDITMSG'])
    writeFileSync(join(root, 'plan.json'), '{"s":1}')
    expect(await commitFolder(root, 'x')).toBeNull()
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    unlinkSync(join(root, '.git', 'COMMIT_EDITMSG'))

    // .git/config naming a share on a machine that never answers: opening the folder does not wait for it
    const config = join(root, '.git', 'config')
    renameSync(config, `${config}.real`)
    symlinkSync('\\\\192.0.2.7\\share\\config', config, 'file')
    const t0 = Date.now()
    expect(await folderTrust(root)).toMatchObject({ git: 'trusted', unsafeGit: { keys: [], resettable: false, layout: ['.git/config'] } })
    expect(await commitFolder(root, 'x')).toBeNull()
    await expect(resetFolderGitConfig(root)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
    unlinkSync(config)
    renameSync(`${config}.real`, config)
    expect(await commitFolder(root, 'без ссылок')).toBeTruthy()
  })

  it.skipIf(!git)('a junction or link in the work tree stops the commit: git add never follows it', async () => {
    const root = await created('TreeLinks')
    const outside = folder('tree-links-outside', { 'secret.txt': 'secret' })
    // Git for Windows' plain `git add` follows a junction and stages what is outside the folder
    const demo = folder('tree-links-demo', {})
    plainGit(demo, 'init', '-q')
    junction(outside, join(demo, 'extra'))
    try {
      plainGit(demo, 'add', '-A')
    } catch {
      /* git elsewhere refuses or adds the link itself */
    }
    if (process.platform === 'win32') expect(plainGit(demo, 'ls-files')).toContain('extra/secret.txt')

    junction(outside, join(root, 'extra'))
    writeFileSync(join(root, 'plan.json'), '{"t":1}')
    await expect(commitFolder(root, 'x')).rejects.toThrow(/ссылка[^]*extra|link[^]*extra/)
    expect(plainGit(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(plainGit(root, 'ls-files')).not.toContain('secret')
    unlinkSync(join(root, 'extra'))
    if (canLink) {
      mkdirSync(join(root, 'deep', 'er'), { recursive: true })
      symlinkSync(join(outside, 'secret.txt'), join(root, 'deep', 'er', 's.txt'), 'file')
      await expect(commitFolder(root, 'x')).rejects.toThrow(/deep\/er\/s\.txt/)
      unlinkSync(join(root, 'deep', 'er', 's.txt'))
    }
    expect(await commitFolder(root, 'без ссылок')).toBeTruthy()
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it.skipIf(!git)('a scan that reaches its limit refuses (fails closed) instead of finding nothing', async () => {
    const root = await created('Limit')
    const saved = scanLimit.entries
    try {
      // .git over the limit: no repository doplan may use
      scanLimit.entries = 3
      expect(await layoutOf(root)).toEqual(expect.arrayContaining([expect.stringMatching(/^\.git \((больше|over) 3 /)]))
      writeFileSync(join(root, 'plan.json'), '{"m":1}')
      expect(await commitFolder(root, 'x')).toBeNull()

      // .git within it, the work tree over it (a nested .git past the limit would go unseen)
      folder(join('created-Limit', 'Limit', 'many'), Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.txt`, `${i}`])))
      mkdirSync(join(root, 'many', 'zz', '.git'), { recursive: true })
      scanLimit.entries = countEntries(join(root, '.git')) + 5
      expect(await layoutOf(root)).toBeUndefined()
      await expect(commitFolder(root, 'x')).rejects.toThrow(new RegExp(`(больше|more than) ${scanLimit.entries} `))
      expect(plainGit(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    } finally {
      scanLimit.entries = saved
    }
    await expect(commitFolder(root, 'x')).rejects.toThrow(/вложенный репозиторий|nested git repository/)
    rmSync(join(root, 'many', 'zz'), { recursive: true })
    expect(await commitFolder(root, 'x')).toBeTruthy()
  })

  it.skipIf(!git || process.platform === 'win32' || process.getuid?.() === 0)('a folder the scan cannot list refuses (fails closed)', async () => {
    const root = await created('Unreadable')
    mkdirSync(join(root, 'locked'))
    writeFileSync(join(root, 'plan.json'), '{"u":1}')
    chmodSync(join(root, 'locked'), 0)
    try {
      await expect(commitFolder(root, 'x')).rejects.toThrow(/locked/)
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
    }
    chmodSync(join(root, '.git', 'refs'), 0)
    try {
      expect(await layoutOf(root)).toEqual(expect.arrayContaining(['.git/refs']))
    } finally {
      chmodSync(join(root, '.git', 'refs'), 0o755)
    }
    expect(await commitFolder(root, 'x')).toBeTruthy()
  })

  it.skipIf(!git)('a cloud placeholder (OneDrive, Dropbox) is the file or folder it stands for, not a link', async () => {
    const root = await created('Placeholders')
    const outside = folder('placeholders-outside', { 'secret.txt': 'secret' })
    writeFileSync(join(root, 'plan.json'), '{"p":1}')
    const spy = asPlaceholders()
    try {
      expect(await gitDirProblems(root)).toEqual([])
      expect(await layoutOf(root)).toBeUndefined()
      expect(await commitFolder(root, 'синхронизировано')).toBeTruthy()
      expect(spy).toHaveBeenCalled()
      // real links still are links
      junction(outside, join(root, 'extra'))
      writeFileSync(join(root, 'plan.json'), '{"p":2}')
      await expect(commitFolder(root, 'x')).rejects.toThrow(/ссылка[^]*extra|link[^]*extra/)
      unlinkSync(join(root, 'extra'))
      junction(outside, join(root, '.git', 'objects', 'ab'))
      expect(await gitDirProblems(root)).toEqual(['.git/objects/ab'])
      unlinkSync(join(root, '.git', 'objects', 'ab'))
      expect(await commitFolder(root, 'без ссылок')).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it.skipIf(!git)('the .git check stops at the first link: no path below it is looked at, so a link to a share is never followed', async () => {
    const root = await created('EarlyStop')
    const objects = join(root, '.git', 'objects')
    const store = join(base, 'early-stop-objects')
    renameSync(objects, store)
    mkdirSync(join(store, 'info'), { recursive: true })
    writeFileSync(join(store, 'info', 'alternates'), 'C:/elsewhere/objects\n')
    junction(store, objects)
    // the alternates check would lstat .git/objects/info/alternates through the junction
    expect(await gitDirProblems(root)).toEqual(['.git/objects'])
    unlinkSync(objects)
    if (canLink && process.platform === 'win32') {
      // a directory symlink to a machine that never answers: the check returns at once, connecting nowhere
      symlinkSync('\\\\192.0.2.86\\s\\objects', objects, 'dir')
      const t0 = Date.now()
      expect(await gitDirProblems(root)).toEqual(['.git/objects'])
      expect(Date.now() - t0).toBeLessThan(5000)
      unlinkSync(objects)
    }
    renameSync(store, objects)
    rmSync(join(objects, 'info', 'alternates'))
    expect(await gitDirProblems(root)).toEqual([])
  })

  it.skipIf(!git)('a folder that vanishes during the scan (git gc, a deleted branch) is gone; one that cannot be listed still refuses', async () => {
    const root = await created('Vanish')
    mkdirSync(join(root, '.git', 'objects', 'zz'))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'a')
    writeFileSync(join(root, 'plan.json'), '{"v":1}')
    let code = 'ENOENT'
    const spy = failingReaddir(/[\\/](zz|sub)$/, () => code)
    try {
      expect(await gitDirProblems(root)).toEqual([])
      expect(await commitFolder(root, 'исчезла')).toBeTruthy()
      code = 'ENOTDIR'
      expect(await gitDirProblems(root)).toEqual([])
      // anything else fails closed
      code = 'EACCES'
      expect(await gitDirProblems(root)).toEqual(['.git/objects/zz'])
      writeFileSync(join(root, 'plan.json'), '{"v":2}')
      expect(await commitFolder(root, 'x')).toBeNull()
      rmSync(join(root, '.git', 'objects', 'zz'), { recursive: true })
      await expect(commitFolder(root, 'x')).rejects.toThrow(/«sub»|“sub”/)
    } finally {
      spy.mockRestore()
    }
    expect(await commitFolder(root, 'x')).toBeTruthy()
  })

  it.skipIf(!git)('a repository only doplan writes still gets packed: doplan runs git gc --auto itself', async () => {
    const root = await created('Gc')
    const { createHash } = await import('node:crypto')
    // more loose objects in objects/17 than git's gc.auto (6700) / 256: git's own sign that gc is due
    const files: Record<string, string> = {}
    for (let i = 0, made = 0; made < 30; i++) {
      const text = `gc ${i}\n`
      if (createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex').startsWith('17')) files[`gc/${made++}.txt`] = text
    }
    const objects = join(root, '.git', 'objects')
    const packs = () => (existsSync(join(objects, 'pack')) ? readdirSync(join(objects, 'pack')).filter((n) => n.endsWith('.pack')) : [])
    expect(packs()).toEqual([])
    // below the threshold nothing is packed
    folder(join('created-Gc', 'Gc'), Object.fromEntries(Object.entries(files).slice(0, 10)))
    expect(await commitFolder(root, 'десять')).toBeTruthy()
    expect(packs()).toEqual([])
    folder(join('created-Gc', 'Gc'), files)
    expect(await commitFolder(root, 'тридцать')).toBeTruthy()
    expect(packs().length).toBe(1)
    expect(existsSync(join(objects, '17')) ? readdirSync(join(objects, '17')) : []).toEqual([])
    expect((await gitLog(root)).length).toBe(3)
    expect(plainGit(root, 'fsck', '--no-progress')).toBe('')
    expect(await folderTrust(root)).toEqual({ git: 'trusted', folder: true })
  })

  it.skipIf(!lfs)("the user's own repository keeps working: a clone with git-lfs, remotes and branches", () =>
    inHome('home-user-repo', async () => {
      // the team's repository, cloned by the user with plain git
      const team = received('user-repo-team', { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' })
      writeFileSync(join(team, 'model.bin'), 'binary one')
      plainGit(team, 'add', '-A')
      plainGit(team, 'commit', '-qm', 'lfs model')
      plainGit(team, 'branch', '-M', 'main')
      plainGit(team, 'branch', 'feature')
      const dir = join(base, 'user-repo-clone')
      plainGit(base, 'clone', '-q', slash(team), dir)
      plainGit(dir, 'checkout', '-q', '-b', 'mine', '--track', 'origin/feature')
      expect(readFileSync(join(dir, 'model.bin'), 'utf8')).toBe('binary one')

      expect((await folderTrust(dir)).git).toBe('untrusted')
      await trustFolder(dir)
      expect(await folderTrust(dir)).toEqual({ git: 'trusted', folder: true })
      writeFileSync(join(dir, 'plan.json'), '{"a":2}')
      writeFileSync(join(dir, 'model.bin'), 'binary two')
      const sha = await commitFolder(dir, 'из doplan')
      expect(sha).toBeTruthy()
      expect((await gitLog(dir)).map((v) => v.message)).toEqual(['из doplan', 'lfs model', 'one'])
      // still an lfs pointer in the commit, the branch and its upstream as they were; plain git pushes it
      expect(plainGit(dir, 'show', 'HEAD:model.bin')).toMatch(/^version https:\/\/git-lfs/)
      expect(plainGit(dir, 'lfs', 'ls-files', '--name-only').trim()).toBe('model.bin')
      expect(plainGit(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('mine')
      expect(plainGit(dir, 'rev-parse', '--abbrev-ref', 'mine@{upstream}').trim()).toBe('origin/feature')
      expect(plainGit(dir, 'branch', '-a', '--format=%(refname:short)').trim().split('\n')).toEqual(expect.arrayContaining(['main', 'mine', 'origin/feature', 'origin/main']))
      plainGit(dir, 'push', '-q', 'origin', 'mine:feature')
      expect(plainGit(team, 'rev-parse', 'feature').trim()).toBe(sha)
      expect(await folderTrust(dir)).toEqual({ git: 'trusted', folder: true })
    }),
  )

  it.skipIf(!git || !canLink)('the reset never writes through links planted in .git', () =>
    inHome('home-reset-link', async () => {
      const dir = received('reset-link')
      const outside = join(base, 'outside.config')
      writeFileSync(outside, readFileSync(join(dir, '.git', 'config'), 'utf8') + '[foo]\n\tbar = 1\n')
      rmSync(join(dir, '.git', 'config'))
      symlinkSync(outside, join(dir, '.git', 'config'), 'file')
      const before = readFileSync(outside, 'utf8')
      await trustFolder(dir)
      expect((await folderTrust(dir)).unsafeGit).toEqual({ keys: [], resettable: false, layout: ['.git/config'] })
      await expect(resetFolderGitConfig(dir)).rejects.toThrow()
      expect(readFileSync(outside, 'utf8')).toBe(before)
      expect(lstatSync(join(dir, '.git', 'config')).isSymbolicLink()).toBe(true)

      // a dangling link where the backup would go is a link in .git too: no reset, its target never created
      const dir2 = received('reset-dangling')
      plainGit(dir2, 'config', 'foo.bar', '1')
      const target = join(base, 'dangling-target')
      symlinkSync(target, join(dir2, '.git', 'config.doplan-backup'), 'file')
      await trustFolder(dir2)
      expect(await layoutOf(dir2)).toEqual(['.git/config.doplan-backup'])
      await expect(resetFolderGitConfig(dir2)).rejects.toThrow()
      expect(existsSync(target)).toBe(false)
      unlinkSync(join(dir2, '.git', 'config.doplan-backup'))
      expect(await resetFolderGitConfig(dir2)).toBe(join(dir2, '.git', 'config.doplan-backup'))
      expect((await folderTrust(dir2)).unsafeGit).toBeUndefined()
    }),
  )

  it.skipIf(!git)("the user's init.templateDir never reaches a repository doplan creates", async () => {
    const tpl = folder('git-template', { config: '[core]\n\tfsmonitor = sh ./evil.sh\n[foo]\n\tbar = 1\n', 'hooks/post-commit': '#!/bin/sh\nexit 0\n' })
    await inHome(
      'home-template',
      async () => {
        // plain git copies the template config
        const plain = folder('template-plain', {})
        plainGit(plain, 'init', '-q')
        expect(readFileSync(join(plain, '.git', 'config'), 'utf8')).toContain('bar = 1')

        const root = await created('Template')
        expect(await folderTrust(root)).toEqual({ git: 'trusted', folder: true })
        expect(readFileSync(join(root, '.git', 'config'), 'utf8')).not.toMatch(/\[foo\]|fsmonitor/)
        expect(existsSync(join(root, '.git', 'hooks'))).toBe(false)
        expect(plainGit(root, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main')
      },
      `[init]\n\ttemplateDir = ${slash(tpl)}\n`,
    )
  })
})

// A received folder may hold links (symlinks, junctions) where plan.json, manifest.json, AGENTS.md or
// assets are: to files elsewhere, or to another machine (opening one there would reach out to it).
// doplan reads project files with lstat first and never opens or stats anything through a link.
describe('project files through links', { timeout: 60_000 }, async () => {
  const { folderAssetLinks, loadFolderAssets, planChangedOnDisk, readFolderPlan, readInstructions, rememberPlanOnDisk, writeFolderProject } = await import('./projectFolder')
  const { paths } = await import('./paths')
  const canLink = (() => {
    const probe = join(base, 'link-probe-2')
    try {
      symlinkSync(join(base, 'link-probe-target'), probe, 'file')
      unlinkSync(probe)
      return true
    } catch {
      return false
    }
  })()
  const junction = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  const HASHED = `${'a'.repeat(64)}.png`
  const project = (name: string, files: Record<string, string> = {}) => folder(name, { 'plan.json': '{"version":1,"meta":{"name":"L"}}', 'manifest.json': MANIFEST, ...files })
  const assetUrl = (n: string) => `doplan-asset://project/${n}`

  it('plan.json or manifest.json as a link: the folder is no project, or opening it says what is wrong', async () => {
    const elsewhere = folder('links-elsewhere', { 'plan.json': '{"stolen":true}' })
    const dir = project('links-plan')
    rmSync(join(dir, 'plan.json'))
    junction(elsewhere, join(dir, 'plan.json'))
    expect(await folderRootOf(dir)).toBe(dir)
    await expect(readFolderPlan(dir)).rejects.toThrow(/plan\.json[^]*(ссылка|link)/)
    expect(await folderRootOf(join(dir, 'plan.json'))).toBe(dir)
    unlinkSync(join(dir, 'plan.json'))
    writeFileSync(join(dir, 'plan.json'), '{"a":1}')
    expect(await readFolderPlan(dir)).toEqual({ a: 1 })

    rmSync(join(dir, 'manifest.json'))
    junction(elsewhere, join(dir, 'manifest.json'))
    expect(await isProjectFolder(dir)).toBe(false)
    expect(await folderRootOf(dir)).toBeNull()
    await expect(readFolderPlan(dir)).rejects.toThrow(/manifest\.json/)
  })

  it.skipIf(!canLink)('links to another machine are never opened: plan.json, manifest.json, AGENTS.md', async () => {
    const dir = project('links-unc')
    await rememberPlanOnDisk(dir)
    for (const f of ['plan.json', 'AGENTS.md']) {
      rmSync(join(dir, f), { force: true })
      symlinkSync(`\\\\192.0.2.9\\share\\${f}`, join(dir, f), 'file')
    }
    const t0 = Date.now()
    expect(await folderRootOf(dir)).toBe(dir)
    expect(await folderRootOf(join(dir, 'plan.json'))).toBe(dir)
    await expect(readFolderPlan(dir)).rejects.toThrow(/plan\.json/)
    expect(await planChangedOnDisk(dir)).toBe(false)
    expect(await readInstructions(dir)).toBe('')
    rmSync(join(dir, 'manifest.json'))
    symlinkSync('\\\\192.0.2.9\\share\\manifest.json', join(dir, 'manifest.json'), 'file')
    expect(await isProjectFolder(dir)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('assets/ as a junction: nothing is opened through it, and saving never writes or deletes there', async () => {
    const outside = folder('links-assets-outside', { [HASHED]: 'theirs', 'b.png': 'b' })
    const dir = project('links-assets')
    junction(outside, join(dir, 'assets'))
    expect(await folderAssetLinks(dir)).toEqual(['assets'])
    await loadFolderAssets(dir)
    expect(readdirSync(paths.projectAssets)).toEqual([])
    // a plain save would drop the unreferenced content-addressed file and write the new ones
    writeFileSync(join(paths.projectAssets, 'c.png'), 'c')
    await expect(writeFolderProject(dir, { version: 1, meta: { name: 'L' }, img: assetUrl('c.png') })).rejects.toThrow(/assets[^]*(ссылка|link)/)
    expect(readdirSync(outside).sort()).toEqual([HASHED, 'b.png'].sort())
    expect(readFileSync(join(outside, HASHED), 'utf8')).toBe('theirs')
    expect(readFileSync(join(dir, 'plan.json'), 'utf8')).toBe('{"version":1,"meta":{"name":"L"}}')
    unlinkSync(join(dir, 'assets'))
    await writeFolderProject(dir, { version: 1, meta: { name: 'L' }, img: assetUrl('c.png') })
    expect(readFileSync(join(dir, 'assets', 'c.png'), 'utf8')).toBe('c')
  })

  it('a link among the assets is skipped and replaced by the real file on save; plain assets open as before', async () => {
    const outside = folder('links-asset-files', { 'secret.png': 'secret' })
    const dir = project('links-asset-file', { 'assets/plain.png': 'plain' })
    junction(outside, join(dir, 'assets', 'dir.png'))
    if (canLink) symlinkSync(join(outside, 'secret.png'), join(dir, 'assets', 'link.png'), 'file')
    expect(await folderAssetLinks(dir)).toEqual(canLink ? ['assets/dir.png', 'assets/link.png'] : ['assets/dir.png'])
    await loadFolderAssets(dir)
    expect(readdirSync(paths.projectAssets)).toEqual(['plain.png'])
    expect(readFileSync(join(paths.projectAssets, 'plain.png'), 'utf8')).toBe('plain')
    if (!canLink) return
    // the document refers to link.png: its own copy (added in the editor) replaces the link, the target stays
    writeFileSync(join(paths.projectAssets, 'link.png'), 'mine')
    await writeFolderProject(dir, { version: 1, meta: { name: 'L' }, a: assetUrl('plain.png'), b: assetUrl('link.png') })
    expect(lstatSync(join(dir, 'assets', 'link.png')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'assets', 'link.png'), 'utf8')).toBe('mine')
    expect(readFileSync(join(outside, 'secret.png'), 'utf8')).toBe('secret')
    // without its own copy the link is not read for the manifest either
    symlinkSync(join(outside, 'secret.png'), join(dir, 'assets', 'link2.png'), 'file')
    await writeFolderProject(dir, { version: 1, meta: { name: 'L' }, b: assetUrl('link2.png') })
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).not.toContain('link2.png')
  })

  it('synced assets (cloud placeholders) open and are no links; real links still are', async () => {
    const outside = folder('placeholder-assets-outside', { 'x.png': 'x' })
    const dir = project('placeholder-assets', { [`assets/${HASHED}`]: 'img', 'assets/b.png': 'b' })
    junction(outside, join(dir, 'assets', 'dir.png'))
    const spy = asPlaceholders()
    try {
      expect(await folderAssetLinks(dir)).toEqual(['assets/dir.png'])
      await loadFolderAssets(dir)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    expect(readdirSync(paths.projectAssets).sort()).toEqual([HASHED, 'b.png'].sort())
    expect(readFileSync(join(paths.projectAssets, HASHED), 'utf8')).toBe('img')
  })

  it.skipIf(!canLink)('a plan.json, .json or .doplan the user picks that is a link is refused before anything reads through it', async () => {
    const { openProject } = await import('./project')
    const { grantPath } = await import('./access')
    const outside = folder('picked-outside', { 'x.json': '{"version":1,"meta":{"name":"stolen"}}' })
    // no doplan manifest: opening plan.json takes the path of any .json file
    const dir = folder('picked', { 'manifest.json': '{"name":"pwa"}' })
    const open = (p: string) => {
      grantPath(p)
      return openProject(p)
    }
    const t0 = Date.now()
    for (const [name, target] of [
      ['plan.json', join(outside, 'x.json')],
      ['x.json', join(outside, 'x.json')],
      ['x.doplan', join(outside, 'x.json')],
      ['unc.json', '\\\\192.0.2.9\\share\\x.json'],
      ['other', join(outside, 'x.json')],
    ]) {
      symlinkSync(target, join(dir, name), 'file')
      await expect(open(join(dir, name))).rejects.toThrow(/ссылка|link/)
    }
    expect(Date.now() - t0).toBeLessThan(5000)
    // a plain file opens as before
    writeFileSync(join(dir, 'plain.json'), '{"version":1,"meta":{"name":"ok"}}')
    expect((await open(join(dir, 'plain.json')))?.doc).toMatchObject({ meta: { name: 'ok' } })
  })

  it('AGENTS.md as a junction is no instructions; a link where a scaffold file goes is left alone', async () => {
    const outside = folder('links-agents', { 'AGENTS.md': 'not yours' })
    const dir = project('links-agents-dir')
    junction(outside, join(dir, 'AGENTS.md'))
    expect(await readInstructions(dir)).toBe('')
    await writeFolderProject(dir, { version: 1, meta: { name: 'L' } })
    expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readdirSync(outside)).toEqual(['AGENTS.md'])
  })
})
