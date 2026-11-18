import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyError,
  errorText,
  GITHUB_FILE_LIMIT,
  GITHUB_FILE_WARN,
  ghInstallHint,
  isValidRepoName,
  parseCreatedRepoUrl,
  parseDeviceCode,
  parseGhAuthStatus,
  parseGithubUrl,
  remoteUrlOf,
  repoNameFromProject,
  sizeCheck,
  secretScanDetail,
  stripUrlCredentials,
  webUrlOf,
  firstErrorLine,
} from '../shared/github'

// ───────────── pure helpers ─────────────

describe('GitHub addresses', () => {
  it('parses what users paste', () => {
    const r = { owner: 'anna', repo: 'flat', ssh: false }
    expect(parseGithubUrl('https://github.com/anna/flat')).toEqual(r)
    expect(parseGithubUrl('https://github.com/anna/flat.git')).toEqual(r)
    expect(parseGithubUrl('  https://github.com/anna/flat/  ')).toEqual(r)
    expect(parseGithubUrl('https://github.com/anna/flat/tree/main/assets')).toEqual(r)
    expect(parseGithubUrl('github.com/anna/flat')).toEqual(r)
    expect(parseGithubUrl('https://www.github.com/anna/flat')).toEqual(r)
    expect(parseGithubUrl('git@github.com:anna/flat.git')).toEqual({ ...r, ssh: true })
    expect(parseGithubUrl('ssh://git@github.com/anna/flat.git')).toEqual({ ...r, ssh: true })
    expect(parseGithubUrl('https://github.com/my-org/my.project_1')).toEqual({ owner: 'my-org', repo: 'my.project_1', ssh: false })
  })

  it('refuses other hosts, credentials, schemes and odd names', () => {
    for (const bad of [
      '',
      'flat',
      'https://gitlab.com/anna/flat',
      'https://github.com.evil.io/anna/flat',
      'https://github.com/anna',
      'https://token@github.com/anna/flat',
      'https://anna:secret@github.com/anna/flat',
      'file:///C:/repo',
      'ext::sh -c calc',
      'https://github.com:8443/anna/flat',
      'https://github.com/-anna/flat',
      'https://github.com/anna/..',
      'git@github.com:anna/flat/extra',
      'ssh://root@github.com/anna/flat',
      'https://github.com/anna/fl at',
    ])
      expect(parseGithubUrl(bad), bad).toBeNull()
  })

  it('refuses repository names gh would read as its own flags', () => {
    for (const bad of ['-p', '--web', '--clone', '--internal', '--public']) expect(isValidRepoName(bad), bad).toBe(false)
    expect(isValidRepoName('a-b')).toBe(true)
    expect(isValidRepoName('.dotfiles')).toBe(true)
    expect(parseGithubUrl('https://github.com/anna/-flat')).toBeNull()
  })

  it('drops a token or password from an address before it is shown', () => {
    expect(stripUrlCredentials('https://user:ghp_SECRET@github.com/anna/flat.git')).toBe('https://github.com/anna/flat.git')
    expect(stripUrlCredentials('https://ghp_SECRET@github.com/anna/flat.git')).toBe('https://github.com/anna/flat.git')
    expect(stripUrlCredentials('http://u:p@host.example/x')).toBe('http://host.example/x')
    expect(stripUrlCredentials('ssh://git:secret@github.com/anna/flat.git')).toBe('ssh://git@github.com/anna/flat.git')
    expect(stripUrlCredentials('ssh://git@github.com/anna/flat.git')).toBe('ssh://git@github.com/anna/flat.git')
    expect(stripUrlCredentials('git@github.com:anna/flat.git')).toBe('git@github.com:anna/flat.git')
    expect(stripUrlCredentials('C:/repos/flat')).toBe('C:/repos/flat')
  })

  it('builds remote and page addresses', () => {
    expect(remoteUrlOf({ owner: 'a', repo: 'b', ssh: false })).toBe('https://github.com/a/b.git')
    expect(remoteUrlOf({ owner: 'a', repo: 'b', ssh: true })).toBe('git@github.com:a/b.git')
    expect(webUrlOf({ owner: 'a', repo: 'b' })).toBe('https://github.com/a/b')
  })

  it('makes repository names from project names', () => {
    expect(repoNameFromProject('Квартира на Ленина, 12')).toBe('kvartira-na-lenina-12')
    expect(repoNameFromProject('Дом №2 (эскиз)')).toBe('dom-no2-eskiz')
    expect(repoNameFromProject('Café Été')).toBe('cafe-ete')
    expect(repoNameFromProject('...')).toBe('doplan-project')
    expect(repoNameFromProject('')).toBe('doplan-project')
    expect(repoNameFromProject('a'.repeat(150))).toHaveLength(100)
    expect(repoNameFromProject('plan.git')).toBe('plan')
    for (const n of ['Квартира', 'x y z', '😀 дом']) expect(isValidRepoName(repoNameFromProject(n))).toBe(true)
    expect(isValidRepoName('ok-name_1.2')).toBe(true)
    expect(isValidRepoName('bad name')).toBe(false)
    expect(isValidRepoName('x.git')).toBe(false)
  })
})

describe('gh output', () => {
  it('finds the one-time code', () => {
    expect(parseDeviceCode('! First copy your one-time code: D0A3-540F\nOpen this URL…')).toBe('D0A3-540F')
    expect(parseDeviceCode('nothing yet')).toBeNull()
  })

  it('reads auth status (new and old format, several accounts)', () => {
    const multi = `github.com
  ✓ Logged in to github.com account first (keyring)
  - Active account: false
  ✓ Logged in to github.com account second (keyring)
  - Active account: true`
    expect(parseGhAuthStatus(multi)).toEqual({ loggedIn: true, user: 'second' })
    expect(parseGhAuthStatus('✓ Logged in to github.com as anna (oauth_token)')).toEqual({ loggedIn: true, user: 'anna' })
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual({ loggedIn: false })
  })

  it('reads the address of a created repository', () => {
    expect(parseCreatedRepoUrl('✓ Created repository anna/flat on github.com\n  https://github.com/anna/flat\n')).toEqual({ owner: 'anna', repo: 'flat', ssh: false })
  })

  it('gives an install hint per platform', () => {
    expect(ghInstallHint('win32', true)).toMatchObject({ command: 'winget install --id GitHub.cli -e', canRun: true })
    expect(ghInstallHint('win32', false).canRun).toBe(false)
    expect(ghInstallHint('darwin', false).command).toBe('brew install gh')
    expect(ghInstallHint('linux', false).url).toContain('install_linux')
  })
})

const PUSH_PROTECTION = [
  'remote: error: GH013: Repository rule violations found for refs/heads/main.',
  'remote: - GITHUB PUSH PROTECTION',
  'remote:   Resolve the following violations before pushing again',
  'remote:   - Push cannot contain secrets',
  'remote:     —— GitHub Personal Access Token ——',
  'remote:      locations:',
  'remote:        - commit: 0123abcd',
  'remote:          path: AGENTS.md:3',
  'remote:      (?) To push, remove secret from commit(s) or follow this URL to allow the secret.',
  'remote:      https://github.com/me/flat/security/secret-scanning/unblock-secret/2abcDEF',
  ' ! [remote rejected] main -> main (push declined due to repository rule violations)',
  "error: failed to push some refs to 'https://github.com/me/flat.git'",
].join('\n')

describe('errors in plain words', () => {
  it('names the file with a secret and the link to allow it (push protection)', () => {
    const detail = secretScanDetail(PUSH_PROTECTION)
    expect(detail).toBe('AGENTS.md:3 — https://github.com/me/flat/security/secret-scanning/unblock-secret/2abcDEF')
    const text = errorText('secretFound', 'ru', detail)
    expect(text).toMatch(/секрет/)
    expect(text).toContain('unblock-secret')
    expect(text).not.toMatch(/защищена/)
  })

  it.each([
    ['fatal: unable to access \'https://github.com/a/b.git/\': Could not resolve host: github.com', 'offline'],
    ['fatal: unable to access \'https://github.com/a/b.git/\': Failed to connect to github.com port 443 after 21 ms: Couldn\'t connect to server', 'offline'],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'auth'],
    ['remote: Invalid username or password.\nfatal: Authentication failed for', 'auth'],
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ['remote: Permission to anna/flat.git denied to bob.\nfatal: unable to access … The requested URL returned error: 403', 'forbidden'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/a/b.git/\' not found', 'notFound'],
    ['GraphQL: Name already exists on this account (createRepository)', 'nameTaken'],
    [' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    [' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs', 'rejected'],
    // GitHub's own refusals: getting changes would not help, so they are never 'rejected'
    [
      'remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to \'https://github.com/a/b.git\'',
      'protectedBranch',
    ],
    [
      'remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] main -> main (push declined due to repository rule violations)\nerror: failed to push some refs',
      'protectedBranch',
    ],
    [
      'remote: error: GH007: Your push would publish a private email address.\n ! [remote rejected] main -> main (push declined due to email privacy restrictions)\nerror: failed to push some refs',
      'emailPrivacy',
    ],
    [' ! [remote rejected] main -> main (failed to update ref)\nerror: failed to push some refs to \'file:///x\'', 'refused'],
    ['error: failed to push some refs to \'https://github.com/a/b.git\'', 'unknown'],
    ['git fetch: timeout, no answer within 90 s', 'timeout'],
    [PUSH_PROTECTION, 'secretFound'],
    ['remote: error: GH001: Large files detected. You may want to try Git Large File Storage', 'tooLarge'],
    ['something else entirely', 'unknown'],
  ])('%s → %s', (text, code) => {
    expect(classifyError(text)).toBe(code)
  })

  it('says what to do, in both languages', () => {
    expect(errorText('offline', 'ru')).toMatch(/интернет/)
    expect(errorText('offline', 'en')).toMatch(/internet/)
    expect(errorText('unknown', 'ru', 'fatal: boom')).toMatch(/fatal: boom/)
    expect(errorText('emailPrivacy', 'ru')).toMatch(/noreply/)
    expect(errorText('protectedBranch', 'en')).toMatch(/protected/)
    expect(errorText('timeout', 'ru')).toMatch(/не отвечает/)
  })

  it('quotes the server reason, not git closing line', () => {
    const out = ' ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs\nremote: error: custom rule says no'
    expect(firstErrorLine(out)).toBe('remote: error: custom rule says no')
    expect(firstErrorLine(' ! [remote rejected] main -> main (failed to update ref)\nerror: failed to push some refs')).toMatch(/remote rejected/)
  })
})

describe('size limits', () => {
  it('blocks files over 100 MB and warns over 50 MB', () => {
    const r = sizeCheck([
      { path: 'small', size: 1000 },
      { path: 'warn', size: GITHUB_FILE_WARN + 1 },
      { path: 'block', size: GITHUB_FILE_LIMIT + 1 },
      { path: 'edge', size: GITHUB_FILE_LIMIT },
    ])
    expect(r.blocked.map((f) => f.path)).toEqual(['block'])
    expect(r.large.map((f) => f.path)).toEqual(['edge', 'warn'])
  })
})

// ───────────── sync with real git; a local bare repository stands in for GitHub ─────────────

const base = mkdtempSync(join(tmpdir(), 'doplan-gh-test-'))
mkdirSync(join(base, 'userData'), { recursive: true })
vi.mock('electron', () => ({
  app: { getPath: () => join(base, 'userData'), getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}))
vi.mock('./ipc', () => ({ handleIpc: vi.fn() }))
vi.mock('./window', () => ({ sendToRenderer: vi.fn(), getMainWindow: () => null }))
const created: string[] = []
vi.mock('./github', async (orig) => {
  const real = (await orig()) as typeof import('./github')
  return {
    ...real,
    // gh is not used: the test "GitHub" needs no credentials
    gitCredentialArgs: async () => [],
    ghStatus: async () => ({ installed: true, loggedIn: true, user: 'me', install: ghInstallHint('win32', false) }),
    createRepo: async (name: string) => {
      created.push(name)
      git(join(base, 'remote', 'me'), 'init', '--bare', '--quiet', '--initial-branch=main', `${name}.git`)
      return { owner: 'me', repo: name, ssh: false }
    },
  }
})

const { netTestConfig, findGit, gitFetch, gitRemoteUrl, gitLog, gitOrphanCommit, gitPushRef, isSafeBranchName } = await import('./git')
const { createRepoArgs } = await import('./github')
const { withSyncLock } = await import('./syncLock')
const { saveProject } = await import('./project')
const { grantPath } = await import('./access')
const { createFolderProject, getProjectRoot, setProjectRoot, trustFolder, writeFolderProject } = await import('./projectFolder')
const sync = await import('./githubSync')

const remotes = join(base, 'remote')
mkdirSync(join(remotes, 'me'), { recursive: true })
// https://github.com/<owner>/<repo> → the bare repository base/remote/<owner>/<repo>
netTestConfig.push('-c', 'protocol.file.allow=always', '-c', `url.${pathToFileURL(remotes).href}/.insteadOf=https://github.com/`)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', windowsHide: true })
}

function bare(name: string): string {
  git(join(remotes, 'me'), 'init', '--bare', '--quiet', '--initial-branch=main', `${name}.git`)
  return `https://github.com/me/${name}`
}

let n = 0
async function project(name: string): Promise<string> {
  const res = await createFolderProject(base, `${name}-${++n}`, { version: 1, meta: { name }, notes: 'a' })
  return res.root
}

/** a second computer: a clone of the repository, trusted, with the same project */
async function cloneOf(repo: string): Promise<string> {
  const dir = join(base, `clone-${++n}`)
  git(base, 'clone', '--quiet', join(remotes, 'me', `${repo}.git`), dir)
  await trustFolder(dir, false)
  return dir
}

const plan = (root: string) => JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8'))
const useRoot = (root: string) => setProjectRoot(root)

const hasGit = !!(await findGit())

describe.skipIf(!hasGit)('project sync', { timeout: 180_000 }, () => {
  it('is unavailable without a project folder, disconnected before connecting', async () => {
    setProjectRoot(null)
    expect((await sync.syncStatus()).state).toBe('unavailable')
    useRoot(await project('A'))
    expect((await sync.syncStatus()).state).toBe('disconnected')
  })

  it('connects an empty repository and sends the project; a second computer gets changes', async () => {
    const url = bare('first')
    const a = await project('Дом')
    useRoot(a)
    const res = await sync.connect(url)
    expect(res.pushed).toBe(true)
    expect(res.status).toMatchObject({ state: 'synced', branch: 'main', ahead: 0, behind: 0, remote: { owner: 'me', repo: 'first', webUrl: 'https://github.com/me/first' } })
    expect(await gitRemoteUrl(a)).toBe('https://github.com/me/first.git')

    // second computer changes the plan and sends it
    const b = await cloneOf('first')
    useRoot(b)
    expect((await sync.syncStatus()).state).toBe('synced')
    await writeFolderProject(b, { ...plan(b), notes: 'from B' })
    const pushed = await sync.push()
    expect(pushed.needPull).toBeFalsy()
    expect(pushed.status.state).toBe('synced')

    // first computer sees it and gets it
    useRoot(a)
    const st = await sync.syncStatus(true)
    expect(st).toMatchObject({ state: 'behind', behind: 1 })
    expect(st.checkedAt).toBeTypeOf('number')
    const got = await sync.pull()
    expect(got.result).toBe('updated')
    expect(plan(a).notes).toBe('from B')
    expect(got.status.state).toBe('synced')
  })

  it('merges changes to different files by itself; asks on a real conflict', async () => {
    const url = bare('second')
    const a = await project('Кв')
    useRoot(a)
    await sync.connect(url)
    const b = await cloneOf('second')

    // different files: merged without a question
    useRoot(b)
    writeFileSync(join(b, 'AGENTS.md'), 'notes from B\n')
    await sync.push()
    useRoot(a)
    await writeFolderProject(a, { ...plan(a), notes: 'A edit' })
    const p1 = await sync.push()
    expect(p1.needPull).toBe(true)
    const m = await sync.pull()
    expect(m.result).toBe('merged')
    expect(readFileSync(join(a, 'AGENTS.md'), 'utf8')).toBe('notes from B\n')
    expect(plan(a).notes).toBe('A edit')
    expect((await sync.push()).status.state).toBe('synced')

    // the same line on both sides: a conflict, the folder untouched until the user chooses
    useRoot(b)
    await sync.pull()
    await writeFolderProject(b, { ...plan(b), notes: 'B wins?' })
    await sync.push()
    useRoot(a)
    await writeFolderProject(a, { ...plan(a), notes: 'A wins?' })
    const c = await sync.pull()
    expect(c.result).toBe('conflict')
    expect(c.conflicts).toContain('plan.json')
    expect(plan(a).notes).toBe('A wins?')
    expect(existsSync(join(a, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(c.status.state).toBe('diverged')

    // keep both: GitHub's version becomes a project folder next to this one, this one stays
    const both = await sync.resolveConflict('both')
    expect(both.copyPath).toBeTruthy()
    expect(plan(both.copyPath!).notes).toBe('B wins?')
    expect(existsSync(join(both.copyPath!, '.git'))).toBe(false)
    expect(plan(a).notes).toBe('A wins?')
    expect(both.status.state).toBe('ahead')
    expect((await sync.push()).status.state).toBe('synced')

    // the other computer now gets A's version
    useRoot(b)
    expect((await sync.pull()).result).toBe('updated')
    expect(plan(b).notes).toBe('A wins?')
  })

  it('takes the GitHub version or keeps this one on request', async () => {
    const url = bare('third')
    const a = await project('T')
    useRoot(a)
    await sync.connect(url)
    const b = await cloneOf('third')
    useRoot(b)
    await writeFolderProject(b, { ...plan(b), notes: 'theirs' })
    await sync.push()
    useRoot(a)
    await writeFolderProject(a, { ...plan(a), notes: 'mine' })
    expect((await sync.pull()).result).toBe('conflict')
    const r = await sync.resolveConflict('theirs')
    expect(plan(a).notes).toBe('theirs')
    expect(r.status.state).toBe('ahead')
    // "mine" stays in the history
    expect((await gitLog(a)).some((v) => /Отправка|Перед получением|Before getting/.test(v.message))).toBe(true)

    useRoot(b)
    await writeFolderProject(b, { ...plan(b), notes: 'theirs 2' })
    await sync.push().then(async (p) => (p.needPull ? (await sync.pull(), sync.push()) : p))
    useRoot(a)
    await writeFolderProject(a, { ...plan(a), notes: 'mine 2' })
    expect((await sync.pull()).result).toBe('conflict')
    await sync.resolveConflict('mine')
    expect(plan(a).notes).toBe('mine 2')
    expect((await sync.push()).status.state).toBe('synced')
  })

  it('combines a repository that only has a README; refuses one holding another project', async () => {
    const url = bare('readme')
    const seed = join(base, `seed-${++n}`)
    git(base, 'clone', '--quiet', join(remotes, 'me', 'readme.git'), seed)
    writeFileSync(join(seed, 'README.md'), '# hello\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '--quiet', '-m', 'init')
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main')
    const a = await project('R')
    useRoot(a)
    const res = await sync.connect(url)
    expect(res.pushed).toBe(true)
    expect(readFileSync(join(a, 'README.md'), 'utf8')).toBe('# hello\n')
    expect(res.status.state).toBe('synced')

    // the repository now holds project R: another project must not be mixed into it
    const other = await project('Other')
    useRoot(other)
    await expect(sync.connect(url)).rejects.toThrow(/другой проект doplan|another doplan project/)
    expect(await gitRemoteUrl(other)).toBeNull()
  })

  it('explains bad links and missing repositories, and keeps nothing connected', async () => {
    const a = await project('E')
    useRoot(a)
    await expect(sync.connect('https://gitlab.com/me/x')).rejects.toThrow(/github/i)
    await expect(sync.connect('https://github.com/me/does-not-exist')).rejects.toThrow(/не найден|not found/i)
    expect(await gitRemoteUrl(a)).toBeNull()
    await expect(sync.push()).rejects.toThrow(/не подключён|not connected/)
  })

  it('creates a repository through gh and disconnects', async () => {
    const a = await project('New')
    useRoot(a)
    const res = await sync.createAndConnect('new-repo', true)
    expect(created).toContain('new-repo')
    expect(res.pushed).toBe(true)
    expect(res.status.remote?.repo).toBe('new-repo')
    const st = await sync.disconnect()
    expect(st.state).toBe('disconnected')
    expect(await gitRemoteUrl(a)).toBeNull()
  })

  it('reports a failed look at GitHub without losing the last known state', async () => {
    const url = bare('offline')
    const a = await project('O')
    useRoot(a)
    await sync.connect(url)
    // the "server" disappears
    const { renameSync } = await import('node:fs')
    renameSync(join(remotes, 'me', 'offline.git'), join(remotes, 'me', 'offline-gone.git'))
    const st = await sync.syncStatus(true)
    expect(st.state).toBe('synced')
    expect(st.error).toBeTruthy()
  })

  it('sends a generated one-commit branch (gh-pages) next to the project, replacing it each time', async () => {
    const url = bare('pages')
    const a = await project('P')
    useRoot(a)
    await sync.connect(url)
    const net = await sync.githubNet(false)
    const first = await gitOrphanCommit(a, [
      { path: 'index.html', data: '<h1>v1</h1>' },
      { path: 'assets/m.bin', data: Buffer.from([0, 1, 2, 255]) },
    ], 'viewer v1')
    await gitPushRef(a, net, first, 'gh-pages', { force: true })
    const second = await gitOrphanCommit(a, [{ path: 'index.html', data: '<h1>v2</h1>' }], 'viewer v2')
    await gitPushRef(a, net, second, 'gh-pages', { force: true })
    const remote = join(remotes, 'me', 'pages.git')
    expect(git(remote, 'rev-list', '--count', 'gh-pages').trim()).toBe('1')
    expect(git(remote, 'show', 'gh-pages:index.html')).toBe('<h1>v2</h1>')
    // the project's own branch and state are untouched
    expect(git(remote, 'show', 'main:plan.json')).toContain('"P"')
    expect((await sync.syncStatus()).state).toBe('synced')
    expect(isSafeBranchName('gh-pages')).toBe(true)
    for (const bad of ['-f', 'a..b', 'x.lock', 'a//b', '@{1}']) expect(isSafeBranchName(bad)).toBe(false)
    await expect(gitPushRef(a, net, first, '--force')).rejects.toThrow()
    await expect(gitOrphanCommit(a, [{ path: '../x', data: '' }], 'm')).rejects.toThrow()

    // unpublish: the branch goes away (twice is fine); the project's own branch cannot be deleted
    await gitPushRef(a, net, null, 'gh-pages')
    expect(git(remote, 'branch', '--list', 'gh-pages').trim()).toBe('')
    await gitPushRef(a, net, null, 'gh-pages')
    await expect(gitPushRef(a, net, null, 'main')).rejects.toThrow()
    expect(git(remote, 'branch', '--list', 'main').trim()).toContain('main')
  })

  it('shows a refusal by GitHub as it is, never as "get the changes first"', async () => {
    const url = bare('locked')
    const a = await project('L')
    useRoot(a)
    await sync.connect(url)
    // the server cannot update its branch (as with a protected branch): nothing new there to get
    writeFileSync(join(remotes, 'me', 'locked.git', 'refs', 'heads', 'main.lock'), '')
    await writeFolderProject(a, { ...plan(a), notes: 'refused' })
    const err = await sync.push().then(
      (r) => r,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/GitHub отказался|GitHub refused/)
    expect((await sync.syncStatus()).state).toBe('ahead')
  })

  it('still asks to get the changes first when GitHub really has newer versions', async () => {
    const url = bare('race')
    const a = await project('R')
    useRoot(a)
    await sync.connect(url)
    const b = await cloneOf('race')
    useRoot(b)
    await writeFolderProject(b, { ...plan(b), notes: 'from B' })
    await sync.push()
    useRoot(a)
    await writeFolderProject(a, { ...plan(a), version: 1, meta: { name: 'R2' } })
    const res = await sync.push()
    expect(res.needPull).toBe(true)
  })

  it('looks only at github.com in the background, never at another host a folder names', async () => {
    const a = await project('H')
    useRoot(a)
    git(join(remotes, 'me'), 'init', '--bare', '--quiet', '--initial-branch=main', 'elsewhere.git')
    // the other host would answer (a local repository) if it were asked
    netTestConfig.push('-c', `url.${pathToFileURL(remotes).href}/.insteadOf=https://elsewhere.example/`)
    git(a, 'remote', 'add', 'origin', 'https://elsewhere.example/me/elsewhere.git')
    const st = await sync.syncStatus(true)
    expect(st.checkedAt).toBeUndefined()
    expect(st.state).toBe('notPushed')
    expect(git(a, 'for-each-ref', 'refs/remotes').trim()).toBe('')
  })

  it('never shows the token of a token clone', async () => {
    const url = bare('token')
    const a = await project('T')
    useRoot(a)
    await sync.connect(url)
    netTestConfig.push('-c', `url.${pathToFileURL(remotes).href}/.insteadOf=https://user:ghp_SECRET@github.com/`)
    git(a, 'remote', 'set-url', 'origin', 'https://user:ghp_SECRET@github.com/me/token.git')
    const st = await sync.syncStatus(true)
    expect(JSON.stringify(st)).not.toContain('ghp_SECRET')
    expect(st.remote).toMatchObject({ url: 'https://github.com/me/token.git', owner: 'me', repo: 'token' })
    expect(st.error).toBeUndefined()
  })

  it('says a server that never answers timed out, in plain words without the command line', async () => {
    const { createServer } = await import('node:net')
    const sockets: import('node:net').Socket[] = []
    const server = createServer((s) => void sockets.push(s))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as import('node:net').AddressInfo).port
    try {
      const a = await project('S')
      useRoot(a)
      git(a, 'remote', 'add', 'origin', 'https://stall.example/me/x.git')
      netTestConfig.push('-c', 'protocol.http.allow=always', '-c', `url.http://127.0.0.1:${port}/.insteadOf=https://stall.example/`)
      const err = (await gitFetch(a, { config: [], interactive: false, timeout: 2000 }).catch((e: unknown) => e)) as Error & { stderr?: string }
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/^git fetch: timeout/)
      expect(err.message).not.toMatch(/Command failed|--git-dir|-c /)
      expect(classifyError(`${err.stderr ?? ''}\n${err.message}`)).toBe('timeout')
      expect(sockets.length).toBeGreaterThan(0)
    } finally {
      for (const s of sockets) s.destroy()
      server.close()
    }
  })

  it('a save that waited does not take over from a project opened meanwhile', async () => {
    const a = await project('Wa')
    const b = await project('Wb')
    grantPath(a)
    useRoot(a)
    let release!: () => void
    const held = withSyncLock(() => new Promise<void>((r) => (release = r)))
    const saving = saveProject({ ...plan(a), notes: 'late' }, a, { overwrite: true })
    await new Promise((r) => setTimeout(r, 300)) // the save is queued behind the lock
    useRoot(b) // the user opened B while A's save waited
    release()
    await held
    await saving
    expect(plan(a).notes).toBe('late')
    expect(getProjectRoot()).toBe(b)
  })

  it('opens the page of a token clone from the address the status shows', async () => {
    const url = bare('tok2')
    const a = await project('T2')
    useRoot(a)
    await sync.connect(url)
    git(a, 'remote', 'set-url', 'origin', 'https://user:ghp_SECRET@github.com/me/tok2.git')
    const { shell } = await import('electron')
    vi.mocked(shell.openExternal).mockClear()
    expect((await sync.syncStatus()).remote?.webUrl).toBe('https://github.com/me/tok2')
    await sync.openPage('repo')
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/me/tok2')
  })

  it('with several origin addresses: no look in the background, no send, the first one shown', async () => {
    const url = bare('multi')
    const a = await project('M')
    useRoot(a)
    await sync.connect(url)
    git(join(remotes, 'me'), 'init', '--bare', '--quiet', '--initial-branch=main', 'evil.git')
    netTestConfig.push('-c', `url.${pathToFileURL(remotes).href}/.insteadOf=https://evil.example/`)
    // git fetches from the first address: here another host, put before the GitHub one
    git(a, 'config', '--replace-all', 'remote.origin.url', 'https://evil.example/me/evil.git')
    git(a, 'config', '--add', 'remote.origin.url', 'https://github.com/me/multi.git')
    const before = (await sync.syncStatus()).checkedAt
    const st = await sync.syncStatus(true)
    expect(st.checkedAt).toBe(before)
    expect(st.remote?.url).toBe('https://evil.example/me/evil.git')
    expect(st.remote?.owner).toBeUndefined()
    await expect(sync.push()).rejects.toThrow(/несколько адресов|several addresses/)
    await expect(sync.pull()).rejects.toThrow(/несколько адресов|several addresses/)
    expect(git(join(remotes, 'me', 'evil.git'), 'for-each-ref').trim()).toBe('')
    // connecting again leaves one address
    await sync.connect(url)
    expect(git(a, 'config', '--get-all', 'remote.origin.url').trim()).toBe('https://github.com/me/multi.git')
  })

  it('makes a save wait while a GitHub action works on the folder', async () => {
    const a = await project('W')
    grantPath(a)
    useRoot(a)
    let release!: () => void
    const held = withSyncLock(() => new Promise<void>((r) => (release = r)))
    const saving = saveProject({ ...plan(a), notes: 'saved after' }, a, { overwrite: true })
    await new Promise((r) => setTimeout(r, 300))
    expect(plan(a).notes).not.toBe('saved after')
    release()
    await held
    await saving
    expect(plan(a).notes).toBe('saved after')
  })

  it('passes the repository name to gh after "--"', () => {
    expect(createRepoArgs('--web', true)).toEqual(['repo', 'create', '--private', '--', '--web'])
    expect(createRepoArgs('flat', false, 'line1\nline2')).toEqual(['repo', 'create', '--public', '--description', 'line1 line2', '--', 'flat'])
  })
})
