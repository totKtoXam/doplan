import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

const { gitCandidates, findGit, filterOffArgs, gitLog, gitShowFile, UnsafeGitConfigError } = await import('./git')
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
    const foreign = folder('foreign2', { 'plan.json': '{}', 'manifest.json': MANIFEST, '.git/HEAD': 'ref: refs/heads/main\n' })
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
      expect((await folderTrust(dir)).unsafeGit).toEqual({ keys: ['.git/commondir'], resettable: false })
      await expect(resetFolderGitConfig(dir)).rejects.toThrow()
    }),
  )
})
