/**
 * Project versions through the system `git` executable.
 *
 * Why system git and not isomorphic-git: the AI agents the chat panel runs in the project folder
 * (Claude Code, Codex…) use the system git themselves, so one implementation keeps the repository
 * format identical for both (no index-version or packfile mismatches), adds no dependency, and is
 * fast on large binary assets. When git is missing the project still works; only the version
 * history is unavailable (the UI says how to install git).
 */
import { execFile } from 'node:child_process'
import { constants as fsConstants, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import type { UnsafeGitConfig } from '../shared/ipc'
import { msg } from './settings'
import { entryKind, lstatNoFollowSync, redirectsSync, type EntryKind } from './fsutil'

export interface GitVersion {
  sha: string
  short: string
  /** ISO 8601 author date */
  date: string
  author: string
  message: string
  tags: { name: string; message: string }[]
}

let gitExe: string | null | undefined
let gitVersionText = ''

/**
 * Absolute paths only. The bare name `git` is never spawned: on Windows the process search looks in
 * the spawn cwd (the project folder) before PATH, so a git.exe planted in a project folder would run.
 * PATH is therefore resolved here, skipping relative entries.
 */
export function gitCandidates(): string[] {
  const list: string[] = []
  const win = process.platform === 'win32'
  const pathVar = process.env[win ? 'Path' : 'PATH'] ?? process.env['PATH'] ?? ''
  for (const raw of pathVar.split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !isAbsolute(dir)) continue
    list.push(join(dir, win ? 'git.exe' : 'git'))
  }
  if (win) {
    const pf = [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    for (const p of pf) list.push(join(p, 'Git', 'cmd', 'git.exe'))
    if (process.env['LOCALAPPDATA']) list.push(join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'cmd', 'git.exe'))
  } else {
    list.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }
  return [...new Set(list)].filter((p) => isAbsolute(p))
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function probe(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!isAbsolute(exe) || !isFile(exe)) return resolve(null)
    execFile(exe, ['--version'], { windowsHide: true, timeout: 10000, cwd: app.getPath('userData') }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim())
    })
  })
}

/** an always-empty hooks directory: repository hooks (post-commit, reference-transaction…) never run */
function emptyHooksDir(): string {
  const dir = join(app.getPath('userData'), 'git-no-hooks')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* exists */
  }
  return dir
}

/**
 * `-c` flags on every call: no hooks, no fsmonitor command, no signing programs, stable UTF-8 output.
 * Command-line config wins over the repository's own .git/config. Commands that could still run
 * programs from a repository's config (clean/smudge filters, textconv) are avoided or switched off
 * per call (see filterOffArgs); repositories not created by doplan additionally need the user's
 * trust (see projectFolder.folderTrust). All of this is the second layer: the first is that no git
 * command runs at all in a repository whose own config has keys outside SAFE_REPO_KEYS.
 */
function hardeningArgs(): string[] {
  return [
    '-c', `core.hooksPath=${emptyHooksDir()}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.sshCommand=',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'tag.forceSignAnnotated=false',
    // verifying signatures runs gpg.program / gpg.ssh.program / gpg.x509.program; doplan never fetches
    '-c', 'log.showSignature=false',
    '-c', 'protocol.allow=never',
    // a folder that only looks like a bare repository is never one (doplan names the gitdir itself)
    '-c', 'safe.bareRepository=explicit',
    // no automatic gc / maintenance inside other commands: gitCommit runs `gc --auto` itself (autoGc),
    // in a repository that has just passed gitDirProblems
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'core.quotepath=off',
    '-c', 'i18n.logOutputEncoding=utf-8',
    '-c', 'i18n.commitEncoding=utf-8',
  ]
}

/** process environment without GIT_* variables that could point git at another repository or config */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  // GIT_NO_LAZY_FETCH (git 2.45+): a partial clone missing an object does not fetch it, which would
  // run remote.*.uploadpack or core.gitProxy
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C', GIT_NO_LAZY_FETCH: '1' }
}

/** path of a working git executable, or null. Cached after the first successful probe. */
export async function findGit(): Promise<string | null> {
  if (gitExe) return gitExe
  for (const c of gitCandidates()) {
    const v = await probe(c)
    if (v) {
      gitExe = c
      gitVersionText = v
      return c
    }
  }
  gitExe = undefined // probe again next time: the user may install git while the app runs
  return null
}

export function gitVersion(): string {
  return gitVersionText
}

/** `--no-lazy-fetch` where git knows it (2.45+), besides GIT_NO_LAZY_FETCH */
function noLazyFetchArgs(): string[] {
  const m = /(\d+)\.(\d+)/.exec(gitVersionText)
  const major = m ? Number(m[1]) : 0
  const minor = m ? Number(m[2]) : 0
  return major > 2 || (major === 2 && minor >= 45) ? ['--no-lazy-fetch'] : []
}

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
  }
}

interface RunOpts {
  /** extra `-c` flags placed before the command */
  config?: string[]
  input?: string
  binary?: boolean
  /** do not throw on a non-zero exit code */
  allowFail?: boolean
}

interface SpawnOpts extends RunOpts {
  /** added to the (GIT_*-free) environment */
  env?: Record<string, string>
}

type RunResult = { code: number; out: Buffer; err: string }

/**
 * A git command in a project folder. Its repository is checked first (assertRepoSafe): with a config
 * key outside the allowlist, or a `.git` that is not a plain repository, no git command runs there
 * at all.
 */
async function run(root: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const init = args[0] === 'init'
  await assertRepoSafe(root, init)
  return spawnGit(root, init ? args : [...repoArgs(root), ...args], { ...opts, env: ceilingEnv(root) })
}

/**
 * The repository is `<root>/.git` and the work tree `<root>`, named explicitly: git never takes the
 * folder itself for a bare repository (an empty or broken .git) nor walks up to a parent repository.
 */
function repoArgs(root: string): string[] {
  const abs = resolve(root)
  return [`--git-dir=${join(abs, '.git')}`, `--work-tree=${abs}`]
}

/** git looks for no repository above the folder (`git init`, and a second line of defence for the rest) */
function ceilingEnv(root: string): Record<string, string> {
  return { GIT_CEILING_DIRECTORIES: dirname(resolve(root)) }
}

/** git reads no repository here: an always-empty folder of doplan's own, and no looking above it */
function runOutside(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const outside = emptyHooksDir()
  return spawnGit(outside, args, { ...opts, env: { GIT_CEILING_DIRECTORIES: dirname(outside) } })
}

async function spawnGit(cwd: string, args: string[], opts: SpawnOpts = {}): Promise<RunResult> {
  const exe = await findGit()
  if (!exe) throw new Error(msg('Git не найден. Установите Git (https://git-scm.com), чтобы вести историю версий.', 'Git not found. Install Git (https://git-scm.com) to keep the version history.'))
  const fullArgs = [...noLazyFetchArgs(), ...hardeningArgs(), ...(opts.config ?? []), ...args]
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      fullArgs,
      {
        cwd,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
        timeout: 120000,
        env: { ...gitEnv(), ...opts.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : 1) : 0
        const err = Buffer.from(stderr ?? '').toString('utf8').trim()
        if (error && !opts.allowFail) {
          const first = err.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? err.split('\n')[0] ?? error.message
          reject(new GitError(`git ${args[0]}: ${first || error.message}`, code, err))
          return
        }
        resolve({ code, out: Buffer.from(stdout ?? ''), err })
      },
    )
    if (opts.input !== undefined) {
      child.stdin?.end(Buffer.from(opts.input, 'utf8'))
    } else {
      child.stdin?.end()
    }
  })
}

const text = async (root: string, args: string[], opts?: RunOpts) => (await run(root, args, opts)).out.toString('utf8')

// ───────────── repository config: allowlist ─────────────

/**
 * The only keys a repository's own config (.git/config, .git/config.worktree) may hold for doplan to
 * run git in it. Git and the programs it starts take commands from many keys there: a partial clone's
 * lazy fetch runs remote.*.uploadpack or core.gitProxy, `log` with log.showSignature runs gpg.program,
 * git-lfs runs lfs.extension.*.clean… So instead of chasing such keys one by one, any other key —
 * include.path and includeIf.* too — stops all of doplan's git use in the folder until the user resets
 * the config (resetRepoConfig) or works without versions. Keys as `git config --list` prints them:
 * section and variable lower-case, a subsection as written.
 */
const SAFE_REPO_KEYS: RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|autocrlf|eol|safecrlf)$/,
  /^user\.(name|email)$/,
  /^branch\..+\.(remote|merge)$/,
  /^remote\..+\.(url|fetch)$/,
  /^init\.defaultbranch$/,
  // format extensions that only say how the repository is stored
  /^extensions\.(objectformat|refstorage|worktreeconfig)$/,
  // markers git-lfs writes itself (the format version on `git lfs track` and on every add of a tracked
  // file, the auth mode and lock check of a server after a push); checked by value below
  /^lfs\.repositoryformatversion$/,
  /^lfs\..+\.(access|locksverify)$/,
]

interface ConfigEntry {
  key: string
  value: string
}

function safeRepoEntry(e: ConfigEntry): boolean {
  if (e.key === 'core.repositoryformatversion') return /^\s*[01]\s*$/.test(e.value)
  if (e.key === 'lfs.repositoryformatversion') return /^\s*0\s*$/.test(e.value)
  if (/^lfs\..+\.access$/.test(e.key)) return /^\s*(basic|none|negotiate|ntlm|private)\s*$/i.test(e.value)
  if (/^lfs\..+\.locksverify$/.test(e.key)) return /^\s*(true|false)\s*$/i.test(e.value)
  return SAFE_REPO_KEYS.some((re) => re.test(e.key))
}

/** `--list -z` records: "key\nvalue\0", or "key\0" for a key without a value */
function configRecords(out: Buffer): ConfigEntry[] {
  const recs: ConfigEntry[] = []
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue
    const nl = rec.indexOf('\n')
    recs.push({ key: nl < 0 ? rec : rec.slice(0, nl), value: nl < 0 ? '' : rec.slice(nl + 1) })
  }
  return recs
}

/**
 * One config file as git parses it, without its includes and outside any repository: [] when it is
 * missing, null when it cannot be read or is no plain file. Looked at with lstat only: a link (to a
 * network share, say) is never followed, not even to stat it.
 */
async function readConfigFile(file: string): Promise<ConfigEntry[] | null> {
  let st
  try {
    st = lstatSync(file)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  if (!st.isFile()) return null
  const r = await runOutside(['config', '--file', file, '--no-includes', '-z', '--list'], { allowFail: true })
  return r.code === 0 ? configRecords(r.out) : null
}

interface RepoConfigFiles {
  main: ConfigEntry[] | null
  worktree: ConfigEntry[] | null
}

async function repoConfigFiles(root: string): Promise<RepoConfigFiles> {
  const dir = join(root, '.git')
  return {
    main: await readConfigFile(join(dir, 'config')),
    // read whenever it is there: git reads it with extensions.worktreeConfig, which may come and go
    worktree: await readConfigFile(join(dir, 'config.worktree')),
  }
}

/** the config keys outside the allowlist; a config file that cannot be read is a layout problem */
async function checkRepoConfig(root: string): Promise<UnsafeGitConfig | null> {
  const { main, worktree } = await repoConfigFiles(root)
  const layout: string[] = []
  if (!main) layout.push('.git/config')
  if (!worktree) layout.push('.git/config.worktree')
  const keys: string[] = []
  for (const e of [...(main ?? []), ...(worktree ?? [])]) if (!safeRepoEntry(e) && !keys.includes(e.key)) keys.push(e.key)
  if (layout.length) return { keys, resettable: false, layout }
  return keys.length ? { keys, resettable: true } : null
}

const pathKey = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

/** the config files as they are on disk now (lstat: links are not followed): any change means checking again */
function configSignature(root: string): string {
  return ['config', 'config.worktree']
    .map((f) => {
      try {
        const st = lstatSync(join(root, '.git', f), { bigint: true })
        return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
      } catch {
        return '-'
      }
    })
    .join('|')
}

const configChecks = new Map<string, { sig: string; result: UnsafeGitConfig | null }>()

/**
 * The repository of a folder (`<root>/.git` a directory) against doplan's rules: null when doplan may
 * run git there. The whole of .git is walked first, every time (gitDirProblems); its config files are
 * read only when nothing in .git is a link, so opening a folder never follows one. Read by doplan
 * itself, nothing of the repository runs; the config check is cached while the files stay as they are.
 */
export async function unsafeRepoConfig(root: string): Promise<UnsafeGitConfig | null> {
  const layout = await gitDirProblems(root)
  if (layout.length) return { keys: [], resettable: false, layout }
  const key = pathKey(root)
  const sig = configSignature(root)
  const hit = configChecks.get(key)
  if (hit && hit.sig === sig) return hit.result
  const result = await checkRepoConfig(root)
  configChecks.set(key, { sig, result })
  return result
}

/** what is at `p` itself, any junction counting as a link (see lstatNoFollow), or null */
const lstatOrNull = (p: string) => {
  try {
    return lstatNoFollowSync(p)
  } catch {
    return null
  }
}

/** a small regular file's text (not through a link), or null */
function readSmall(p: string): string | null {
  const st = lstatOrNull(p)
  if (!st?.isFile() || st.size > 1024 * 1024) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** a path that reaches another machine (Windows UNC: \\host\share, //host/share, \\?\UNC\…) */
const networkPath = (p: string) => /^[\\/]{2}/.test(p)

/** `host/share` of a UNC path (lower-case), or null */
function shareOf(p: string): string | null {
  const m = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)/.exec(p)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

/** the most entries a scan of `.git` or of the work tree looks at; at the limit it refuses (fails closed). Tests lower it. */
export const scanLimit = { entries: 200_000 }

interface WalkEnd {
  /** stopped at the limit: nothing can be said about the rest */
  limit: boolean
  /** a folder that could not be listed (relative path) */
  unreadable: string | null
}

const gone = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Walks a tree without following links (a junction or symlink is an entry, never a folder to enter).
 * `visit` gets each entry with its kind as lstat sees it (see entryKind: a cloud placeholder is the
 * file or folder it stands for): 'skip' does not enter a folder, 'stop' ends the walk. A folder or entry
 * that vanished while walking (git gc, a deleted branch) is gone, not unreadable; one that cannot be
 * listed or examined ends the walk as unreadable (fail closed).
 */
async function walkTree(base: string, visit: (rel: string, name: string, kind: EntryKind) => 'skip' | 'stop' | void, limit = scanLimit.entries): Promise<WalkEnd> {
  const stack = ['']
  let seen = 0
  while (stack.length) {
    const rel = stack.pop()!
    const dir = rel ? join(base, rel) : base
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (rel && gone(err)) continue
      return { limit: false, unreadable: rel || '.' }
    }
    for (const e of entries) {
      if (++seen > limit) return { limit: true, unreadable: null }
      const path = rel ? `${rel}/${e.name}` : e.name
      let kind: EntryKind | null
      try {
        kind = await entryKind(join(dir, e.name), e)
      } catch {
        return { limit: false, unreadable: path }
      }
      if (!kind) continue
      const r = visit(path, e.name, kind)
      if (r === 'stop') return { limit: false, unreadable: null }
      if (r !== 'skip' && kind === 'dir') stack.push(path)
    }
  }
  return { limit: false, unreadable: null }
}

/** a linked worktree's path as .git/worktrees/<w>/gitdir names it: a plain path on a local drive, or on the share the folder itself is on */
function plainWorktreePath(p: string, root: string): boolean {
  if (!p || /["\0\r\n]/.test(p)) return false
  if (networkPath(p)) {
    const share = shareOf(p)
    return !!share && share === shareOf(resolve(root))
  }
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')
}

/** `p` is `dir` or inside it */
const within = (p: string, dir: string) => {
  const a = pathKey(p)
  const b = pathKey(dir)
  return a === b || a.startsWith(b.endsWith('\\') || b.endsWith('/') ? b : `${b}${process.platform === 'win32' ? '\\' : '/'}`)
}

/**
 * Everything in `<root>/.git` that makes it no plain repository of this folder (one rule, fail closed):
 * - any link (symlink, junction) or entry that is neither a file nor a folder, anywhere in .git: git
 *   reads and writes through them (refs, logs, packed-refs, objects…), out of the folder or to another machine;
 * - missing HEAD/objects/refs (git would take the folder itself, or a parent, for the repository);
 * - objects/info/alternates or http-alternates (other object stores, followed recursively; doplan never makes them);
 * - a commondir, or a linked worktree whose commondir leaves .git or whose path is not a plain local one;
 * - more entries than scanLimit, or a folder that cannot be listed: nothing could be said about the rest.
 * Paths are relative to the folder (`.git/logs`…).
 */
export async function gitDirProblems(root: string): Promise<string[]> {
  const dir = join(root, '.git')
  const out: string[] = []
  const add = (p: string) => {
    if (out.length < 50 && !out.includes(p)) out.push(p)
  }
  // .git itself must be the folder it names (a junction to a volume path lstat follows is none)
  if (redirectsSync(dir)) return ['.git']
  const end = await walkTree(dir, (rel, _name, kind) => {
    if (kind === 'link' || kind === 'other') add(`.git/${rel}`)
  })
  if (end.limit) add(msg(`.git (больше ${scanLimit.entries} файлов)`, `.git (over ${scanLimit.entries} entries)`))
  if (end.unreadable) add(end.unreadable === '.' ? '.git' : `.git/${end.unreadable}`)
  // stop here: the checks below lstat nested paths, and Windows follows a link anywhere above the last part (to a share too)
  if (out.length) return out
  if (!lstatOrNull(join(dir, 'HEAD'))?.isFile()) add('.git/HEAD')
  if (!lstatOrNull(join(dir, 'objects'))?.isDirectory()) add('.git/objects')
  if (!lstatOrNull(join(dir, 'refs'))?.isDirectory()) add('.git/refs')
  for (const f of ['objects/info/alternates', 'objects/info/http-alternates', 'commondir']) if (lstatOrNull(join(dir, f))) add(`.git/${f}`)
  let worktrees: string[] = []
  if (lstatOrNull(join(dir, 'worktrees'))?.isDirectory()) {
    try {
      worktrees = readdirSync(join(dir, 'worktrees'))
    } catch {
      add('.git/worktrees')
    }
  }
  for (const w of worktrees) {
    const wdir = join(dir, 'worktrees', w)
    if (!lstatOrNull(wdir)?.isDirectory()) continue
    const commondir = lstatOrNull(join(wdir, 'commondir')) ? readSmall(join(wdir, 'commondir'))?.trim() : ''
    if (commondir === undefined || (commondir && !within(resolve(wdir, commondir), dir))) add(`.git/worktrees/${w}/commondir`)
    const gitdir = lstatOrNull(join(wdir, 'gitdir')) ? readSmall(join(wdir, 'gitdir'))?.trim() : ''
    if (gitdir === undefined || (gitdir && !plainWorktreePath(gitdir, root))) add(`.git/worktrees/${w}/gitdir`)
  }
  return out
}

/** `name` is the folder's own `.git` (case-insensitive where the file system is) */
const isDotGit = (name: string) => (process.platform === 'linux' ? name === '.git' : name.toLowerCase() === '.git')

/**
 * What in the work tree stops `git add`, as a message for the user, or null. `git add` enters every
 * nested repository (a `.git` file or folder below the top), and Git for Windows follows junctions:
 * either can take git out of the folder or to another machine. So a nested `.git`, any link (symlink,
 * junction) or special file refuses the commit, and so does a tree too large to check or a folder
 * that cannot be listed (fail closed).
 */
async function workTreeProblem(root: string): Promise<string | null> {
  let found: string | null = null
  const end = await walkTree(root, (rel, name, kind) => {
    if (!rel.includes('/') && isDotGit(name) && kind === 'dir') return 'skip' // the repository itself, checked by gitDirProblems
    if (isDotGit(name)) {
      found = msg(
        `В папке проекта есть вложенный репозиторий git (${rel}). doplan не сохраняет версии, пока он там: удалите или перенесите его.`,
        `The project folder has a nested git repository (${rel}). doplan saves no versions while it is there: delete or move it.`,
      )
      return 'stop'
    }
    if (kind === 'link') {
      found = msg(
        `В папке проекта есть ссылка (символическая ссылка или точка соединения): ${rel}. git может пройти по ней за пределы папки, поэтому doplan не сохраняет версии, пока она там: замените её обычной папкой или файлом.`,
        `The project folder has a link (a symbolic link or junction): ${rel}. git could follow it out of the folder, so doplan saves no versions while it is there: replace it with a plain folder or file.`,
      )
      return 'stop'
    }
    if (kind === 'other') {
      found = msg(`В папке проекта есть файл особого типа (${rel}). doplan не сохраняет версии, пока он там.`, `The project folder has a special file (${rel}). doplan saves no versions while it is there.`)
      return 'stop'
    }
  })
  if (found) return found
  if (end.limit)
    return msg(
      `В папке проекта больше ${scanLimit.entries} файлов и папок: doplan не может её проверить и не сохраняет версии. Уберите из папки проекта лишнее.`,
      `The project folder has more than ${scanLimit.entries} files and folders: doplan cannot check it and saves no versions. Move what does not belong to the project out of the folder.`,
    )
  if (end.unreadable)
    return msg(
      `doplan не может прочитать папку «${end.unreadable}» в папке проекта и не сохраняет версии, пока не сможет её проверить.`,
      `doplan cannot read the folder “${end.unreadable}” in the project folder and saves no versions until it can check it.`,
    )
  return null
}

export class UnsafeGitConfigError extends Error {
  constructor(
    readonly keys: string[],
    readonly layout: string[] = [],
  ) {
    const list = (l: string[]) => l.slice(0, 5).join(', ') + (l.length > 5 ? ', …' : '')
    super(
      layout.length
        ? msg(
            `В папке репозитория (.git) есть ссылки или файлы, которые doplan не поддерживает (${list(layout)}). doplan не запускает здесь git: работайте без версий.`,
            `The repository folder (.git) has links or files doplan does not support (${list(layout)}). doplan runs no git here: work without versions.`,
          )
        : msg(
            `В настройках git этой папки есть параметры, через которые git может запускать программы (${list(keys)}). doplan не запускает здесь git: сбросьте настройки git папки («История версий») или работайте без версий.`,
            `The folder's git config has settings through which git can run programs (${list(keys)}). doplan runs no git here: reset the folder's git config (Version history) or work without versions.`,
          ),
    )
  }
}

/** before any git command in a folder: its repository config holds allowed keys only */
async function assertRepoSafe(root: string, init: boolean): Promise<void> {
  let isDir: boolean
  try {
    isDir = lstatNoFollowSync(join(root, '.git')).isDirectory()
  } catch {
    // no repository: only `git init`, which writes a fresh config; nothing may go looking for one above the folder
    if (init) return
    throw new Error(msg('В папке нет репозитория git', 'The folder has no git repository'))
  }
  if (!isDir) throw new Error(msg('.git в папке — это файл: doplan не ведёт там историю версий', '.git in the folder is a file: doplan keeps no version history there'))
  const unsafe = await unsafeRepoConfig(root)
  if (unsafe) throw new UnsafeGitConfigError(unsafe.keys, unsafe.layout)
}

/** `base`, or `base-1`, `base-2`… : the first name with nothing at all there (a dangling link counts) */
function freePath(base: string): string {
  for (let n = 0; ; n++) {
    const p = n ? `${base}-${n}` : base
    if (!lstatOrNull(p)) return p
  }
}

/**
 * Rewrites the repository config with only the allowed keys of .git/config and .git/config.worktree.
 * The old files stay next to it: .git/config.doplan-backup (config.worktree.doplan-backup), `-1`, `-2`…
 * when such a backup is there already. Returns the backup of .git/config.
 * Nothing is written through a link the folder may have planted: the new config is made in a folder
 * of doplan's own, every file in .git is created exclusively under a name nothing has, and a .git or
 * .git/config that is a link (or junction) is refused.
 */
export async function resetRepoConfig(root: string): Promise<string> {
  const cannot = () =>
    new Error(msg('Настройки git этой папки нельзя сбросить: репозиторий устроен иначе. Работайте без версий.', 'The git config of this folder cannot be reset: the repository is set up differently. Work without versions.'))
  const dir = join(root, '.git')
  if (!lstatOrNull(dir)?.isDirectory()) throw cannot()
  const configPath = join(dir, 'config')
  const configStat = lstatOrNull(configPath)
  const worktreeStat = lstatOrNull(join(dir, 'config.worktree'))
  if ((configStat && !configStat.isFile()) || (worktreeStat && !worktreeStat.isFile()) || (await gitDirProblems(root)).length) throw cannot()
  const { main, worktree } = await repoConfigFiles(root)
  if (!main || !worktree) throw cannot()
  // config.worktree goes away, and extensions.worktreeConfig with it: what it allowed moves into config
  const kept = [...main, ...worktree].filter((e) => safeRepoEntry(e) && e.key !== 'core.repositoryformatversion' && e.key !== 'extensions.worktreeconfig')
  const version = kept.some((e) => e.key.startsWith('extensions.')) ? '1' : '0'
  const scratchRoot = join(app.getPath('userData'), 'git-tmp')
  await fsp.mkdir(scratchRoot, { recursive: true })
  const scratch = await fsp.mkdtemp(join(scratchRoot, 'config-'))
  let fresh: string | null = null
  try {
    const draft = join(scratch, 'config')
    await fsp.writeFile(draft, '', { flag: 'wx' })
    for (const e of [{ key: 'core.repositoryformatversion', value: version }, ...kept]) {
      // a value git does not take back is left out (the backup keeps it)
      await runOutside(['config', '--file', draft, '--add', e.key, e.value], { allowFail: true })
    }
    // the result is checked like any repository config before it replaces the old one
    const check = await readConfigFile(draft)
    if (!check || !check.every(safeRepoEntry)) throw new Error(msg('Не удалось записать настройки git', 'Could not write the git config'))
    const text = await fsp.readFile(draft)
    fresh = freePath(join(dir, 'config.doplan-new'))
    await fsp.writeFile(fresh, text, { flag: 'wx' })
    const backup = freePath(join(dir, 'config.doplan-backup'))
    if (configStat) await fsp.copyFile(configPath, backup, fsConstants.COPYFILE_EXCL)
    else await fsp.writeFile(backup, '', { flag: 'wx' })
    if (worktreeStat) await fsp.rename(join(dir, 'config.worktree'), freePath(join(dir, 'config.worktree.doplan-backup')))
    // rename replaces the entry .git/config itself (checked above to be a plain file, or none)
    await fsp.rename(fresh, configPath)
    fresh = null
    return backup
  } finally {
    if (fresh) await fsp.rm(fresh, { force: true }).catch(() => {})
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
    configChecks.delete(pathKey(root))
  }
}

/** `-z` records of `git config --show-origin`: "origin\0key\nvalue\0" */
function originRecords(out: Buffer): { origin: string; key: string; value: string }[] {
  const parts = out.toString('utf8').split('\0')
  const recs: { origin: string; key: string; value: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1]
    const nl = kv.indexOf('\n')
    recs.push({ origin: parts[i], key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? '' : kv.slice(nl + 1) })
  }
  return recs
}

/** a config file path as git printed it (relative ones are relative to where git ran), comparable */
function configFileKey(origin: string, cwd: string): string | null {
  if (!origin.startsWith('file:')) return null
  const p = resolve(cwd, origin.slice('file:'.length))
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * The user's own config files: everything git reads outside any repository (system, Git for Windows'
 * ProgramData config, ~/.gitconfig, ~/.config/git/config) and every file they include, directly or
 * through other files, whatever the condition of an `includeIf` (gitdir:, onbranch:, hasconfig:…):
 * which of them apply to the repository is up to git, but whatever they say is the user's.
 */
async function userConfigFiles(): Promise<Set<string>> {
  const outside = emptyHooksDir()
  const r = await runOutside(['config', '--show-origin', '-z', '--list'], { allowFail: true })
  const files = new Set<string>()
  const queue: string[] = []
  const add = (p: string | null) => {
    if (p && !files.has(p)) {
      files.add(p)
      queue.push(p)
    }
  }
  if (r.code === 0) for (const rec of originRecords(r.out)) add(configFileKey(rec.origin, outside))
  // include.path / includeIf.<condition>.path: relative to the including file, `~/` expanded by --path
  for (let n = 0; n < queue.length && n < 64; n++) {
    const file = queue[n]
    const inc = await runOutside(['config', '--file', file, '--path', '-z', '--get-regexp', '^include(if\..*)?\.path$'], { allowFail: true })
    if (inc.code !== 0) continue
    for (const rec of inc.out.toString('utf8').split('\0')) {
      const nl = rec.indexOf('\n')
      const p = nl < 0 ? '' : rec.slice(nl + 1)
      if (p) add(configFileKey(`file:${isAbsolute(p) ? p : join(dirname(file), p)}`, outside))
    }
  }
  return files
}

/**
 * `-c` flags that switch off every clean/smudge/process filter driver the repository has a say in:
 * `git add` would otherwise run those programs. Every `filter.*` key of the effective config is
 * traced to the file it comes from (`--show-origin`, git 2.8+): a driver whose keys all come from the
 * user's own files (see userConfigFiles; git-lfs…) stays, one the repository defines or overrides
 * (.git/config, the files it includes) is switched off.
 * Throws when the drivers cannot be told apart: doplan then does not commit at all.
 */
export async function filterOffArgs(root: string): Promise<string[]> {
  // only reads the config (nothing runs), so it lists the drivers of any repository, safe or not
  const r = await spawnGit(root, [...repoArgs(root), 'config', '--show-origin', '-z', '--get-regexp', '^filter\.'], { allowFail: true, env: ceilingEnv(root) })
  // exit 1 only means "no such keys"
  if (r.code !== 0 && r.code !== 1) throw new GitError(msg('Не удалось прочитать настройки git репозитория', 'Could not read the repository git config'), -1, '')
  // the last value of a key wins, as in git
  const all = new Map<string, string | null>()
  for (const rec of originRecords(r.out)) all.set(rec.key, configFileKey(rec.origin, root))
  if (!all.size) return []
  const own = await userConfigFiles()
  const names = new Set<string>()
  for (const [key, file] of all) {
    if (file && own.has(file)) continue
    // filter.<subsection>.<variable>: the subsection is everything between the first and the last dot.
    // It may be empty: [filter ""] is the driver of the paths .gitattributes marks `filter=`
    const last = key.lastIndexOf('.')
    if (!key.toLowerCase().startsWith('filter.') || last < 'filter.'.length) continue
    names.add(key.slice('filter.'.length, last))
  }
  const out: string[] = []
  for (const n of names) {
    // `-c name=value` splits at the first '=': such a name could not be switched off reliably
    if (/[=\n\r\0]/.test(n)) throw new GitError(msg('В настройках git репозитория есть фильтр, который doplan не может отключить', 'The repository git config has a filter doplan cannot switch off'), -1, '')
    out.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`)
  }
  return out
}

/** identity used when the user has none configured (commits must never fail because of it) */
async function identityArgs(root: string): Promise<string[]> {
  const name = (await run(root, ['config', 'user.name'], { allowFail: true })).out.toString('utf8').trim()
  const email = (await run(root, ['config', 'user.email'], { allowFail: true })).out.toString('utf8').trim()
  const out: string[] = []
  if (!name) out.push('-c', 'user.name=doplan')
  if (!email) out.push('-c', 'user.email=doplan@localhost')
  return out
}

export async function gitInit(root: string): Promise<void> {
  // --template= : no template directory of the user's (init.templateDir), whose config or hooks would come along
  await run(root, ['init', '--quiet', '--template='])
  // a fresh repository: name the unborn branch `main` regardless of the user's init.defaultBranch
  await run(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true })
}

/**
 * Stages everything (respecting .gitignore) and commits. Resolves with the new commit sha, or null
 * when nothing changed since the last commit. `paths` limits the commit to those files.
 */
export async function gitCommit(root: string, message: string, paths?: string[]): Promise<string | null> {
  const subject = message.trim() || msg('Сохранение', 'Save')
  // `git add` enters nested repositories and (Git for Windows) junctions: neither may be in the work tree
  const problem = await workTreeProblem(root)
  if (problem) throw new Error(problem)
  const config = await filterOffArgs(root)
  if (paths?.length) await run(root, ['add', '--', ...paths], { config })
  else await run(root, ['add', '-A'], { config })
  const diffArgs = ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv']
  // an unborn branch has nothing to diff against: always commit
  const hasHead = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0
  if (hasHead) {
    const d = await run(root, paths?.length ? [...diffArgs, '--', ...paths] : diffArgs, { allowFail: true, config })
    if (d.code === 0) return null
  }
  const id = await identityArgs(root)
  const args = [...id, 'commit', '--quiet', '--no-verify', '-F', '-']
  if (paths?.length) args.push('--', ...paths)
  await run(root, args, { input: `${subject}\n`, config })
  const sha = (await text(root, ['rev-parse', 'HEAD'])).trim()
  await autoGc(root)
  return sha
}

/**
 * Git's own automatic gc, which the commit no longer starts by itself (gc.auto=0 in hardeningArgs):
 * run explicitly, in a repository that has just passed the checks, when git's own heuristic says it
 * is due (more than gc.auto/256 loose objects in objects/17, or more than gc.autoPackLimit packs).
 * Without it a repository only doplan writes would never be packed. A failure changes nothing.
 */
async function autoGc(root: string): Promise<void> {
  const objects = join(root, '.git', 'objects')
  const loose = await fsp.readdir(join(objects, '17')).catch(() => [] as string[])
  const packs = (await fsp.readdir(join(objects, 'pack')).catch(() => [] as string[])).filter((n) => n.endsWith('.pack'))
  if (loose.length <= Math.ceil(GC_AUTO / 256) && packs.length <= GC_AUTO_PACK_LIMIT) return
  try {
    await run(root, ['gc', '--auto', '--quiet'], {
      allowFail: true,
      config: ['-c', `gc.auto=${GC_AUTO}`, '-c', `gc.autoPackLimit=${GC_AUTO_PACK_LIMIT}`, '-c', 'gc.autoDetach=false'],
    })
  } catch (err) {
    console.warn('[doplan] git gc failed', err)
  }
}

/** git's defaults */
const GC_AUTO = 6700
const GC_AUTO_PACK_LIMIT = 50

const FS = '\u001f'
const RS = '\u001e'

export async function gitLog(root: string, limit = 500): Promise<GitVersion[]> {
  const hasHead = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0
  if (!hasHead) return []
  const out = await text(root, ['log', '--no-show-signature', `--max-count=${limit}`, `--format=%H${FS}%h${FS}%aI${FS}%an${FS}%s${RS}`, 'HEAD'])
  const tags = await gitTags(root)
  const bySha = new Map<string, { name: string; message: string }[]>()
  for (const t of tags) {
    const list = bySha.get(t.sha) ?? []
    list.push({ name: t.name, message: t.message })
    bySha.set(t.sha, list)
  }
  return out
    .split(RS)
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, short, date, author, message] = r.split(FS)
      return { sha, short, date, author, message: message ?? '', tags: bySha.get(sha) ?? [] }
    })
}

export async function gitTags(root: string): Promise<{ name: string; sha: string; message: string }[]> {
  const out = await text(root, ['for-each-ref', 'refs/tags', `--format=%(refname:short)${FS}%(objectname)${FS}%(*objectname)${FS}%(contents:subject)${RS}`])
  return out
    .split(RS)
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [name, obj, deref, subject] = r.split(FS)
      return { name, sha: deref || obj, message: subject || name }
    })
}

export async function gitTag(root: string, sha: string, name: string, message: string): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(msg('Некорректная версия', 'Invalid version'))
  const check = await run(root, ['check-ref-format', `refs/tags/${name}`], { allowFail: true })
  if (check.code !== 0 || !name) throw new Error(msg('Недопустимое имя метки', 'Invalid tag name'))
  const exists = await run(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { allowFail: true })
  if (exists.code === 0) throw new Error(msg(`Метка «${name}» уже есть`, `Tag “${name}” already exists`))
  const id = await identityArgs(root)
  await run(root, [...id, 'tag', '-a', '-F', '-', name, sha], { input: `${message.trim() || name}\n` })
}

/** a file's content at a commit; null when the file did not exist there */
export async function gitShowFile(root: string, sha: string, path: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(msg('Некорректная версия', 'Invalid version'))
  const r = await run(root, ['show', `${sha}:${path}`], { allowFail: true, binary: true })
  return r.code === 0 ? r.out : null
}

/** file names directly inside `dir` at a commit */
export async function gitListDir(root: string, sha: string, dir: string): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(msg('Некорректная версия', 'Invalid version'))
  const r = await run(root, ['ls-tree', '--name-only', '-z', sha, `${dir}/`], { allowFail: true })
  if (r.code !== 0) return []
  return r.out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1))
}

export async function gitHead(root: string): Promise<string | null> {
  const r = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })
  return r.code === 0 ? r.out.toString('utf8').trim() : null
}
