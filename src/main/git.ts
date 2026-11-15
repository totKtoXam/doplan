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
import { mkdirSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import { msg } from './settings'

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
 * trust (see projectFolder.folderTrust).
 */
function hardeningArgs(): string[] {
  return [
    '-c', `core.hooksPath=${emptyHooksDir()}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.sshCommand=',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'tag.forceSignAnnotated=false',
    '-c', 'core.quotepath=off',
    '-c', 'i18n.logOutputEncoding=utf-8',
    '-c', 'i18n.commitEncoding=utf-8',
  ]
}

/** process environment without GIT_* variables that could point git at another repository or config */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' }
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
  /** git runs here instead of the repository root */
  cwd?: string
  /** added to the (GIT_*-free) environment */
  env?: Record<string, string>
}

async function run(root: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; out: Buffer; err: string }> {
  const exe = await findGit()
  if (!exe) throw new Error(msg('Git не найден. Установите Git (https://git-scm.com), чтобы вести историю версий.', 'Git not found. Install Git (https://git-scm.com) to keep the version history.'))
  const fullArgs = [...hardeningArgs(), ...(opts.config ?? []), ...args]
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      fullArgs,
      {
        cwd: opts.cwd ?? root,
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
async function userConfigFiles(root: string): Promise<Set<string>> {
  // an always-empty folder of doplan's own, and git may not look above it for a repository
  const outside = emptyHooksDir()
  const r = await run(root, ['config', '--show-origin', '-z', '--list'], { allowFail: true, cwd: outside, env: { GIT_CEILING_DIRECTORIES: dirname(outside) } })
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
    const inc = await run(root, ['config', '--file', file, '--path', '-z', '--get-regexp', '^include(if\..*)?\.path$'], { allowFail: true, cwd: outside })
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
  const r = await run(root, ['config', '--show-origin', '-z', '--get-regexp', '^filter\.'], { allowFail: true })
  // exit 1 only means "no such keys"
  if (r.code !== 0 && r.code !== 1) throw new GitError(msg('Не удалось прочитать настройки git репозитория', 'Could not read the repository git config'), -1, '')
  // the last value of a key wins, as in git
  const all = new Map<string, string | null>()
  for (const rec of originRecords(r.out)) all.set(rec.key, configFileKey(rec.origin, root))
  if (!all.size) return []
  const own = await userConfigFiles(root)
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
  await run(root, ['init', '--quiet'])
  // a fresh repository: name the unborn branch `main` regardless of the user's init.defaultBranch
  await run(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true })
}

/**
 * Stages everything (respecting .gitignore) and commits. Resolves with the new commit sha, or null
 * when nothing changed since the last commit. `paths` limits the commit to those files.
 */
export async function gitCommit(root: string, message: string, paths?: string[]): Promise<string | null> {
  const subject = message.trim() || msg('Сохранение', 'Save')
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
  return (await text(root, ['rev-parse', 'HEAD'])).trim()
}

const FS = '\u001f'
const RS = '\u001e'

export async function gitLog(root: string, limit = 500): Promise<GitVersion[]> {
  const hasHead = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0
  if (!hasHead) return []
  const out = await text(root, ['log', `--max-count=${limit}`, `--format=%H${FS}%h${FS}%aI${FS}%an${FS}%s${RS}`, 'HEAD'])
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
