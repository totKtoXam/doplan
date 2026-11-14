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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

function candidates(): string[] {
  const list = ['git']
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    for (const p of pf) list.push(join(p, 'Git', 'cmd', 'git.exe'))
    if (process.env['LOCALAPPDATA']) list.push(join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'cmd', 'git.exe'))
  } else {
    list.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }
  return list
}

function probe(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (exe !== 'git' && !existsSync(exe)) return resolve(null)
    execFile(exe, ['--version'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim())
    })
  })
}

/** path of a working git executable, or null. Cached after the first successful probe. */
export async function findGit(): Promise<string | null> {
  if (gitExe) return gitExe
  for (const c of candidates()) {
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
  input?: string
  binary?: boolean
  /** do not throw on a non-zero exit code */
  allowFail?: boolean
}

async function run(root: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; out: Buffer; err: string }> {
  const exe = await findGit()
  if (!exe) throw new Error('Git не найден. Установите Git (https://git-scm.com), чтобы вести историю версий.')
  const fullArgs = ['-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=utf-8', '-c', 'i18n.commitEncoding=utf-8', ...args]
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      fullArgs,
      {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
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

/** true when `root` itself is the top of a git work tree (not merely inside some parent repository) */
export async function isRepo(root: string): Promise<boolean> {
  if (!existsSync(join(root, '.git'))) return false
  const r = await run(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })
  return r.code === 0 && r.out.toString('utf8').trim() === 'true'
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
  const msg = message.trim() || 'Сохранение'
  if (paths?.length) await run(root, ['add', '--', ...paths])
  else await run(root, ['add', '-A'])
  const diffArgs = ['diff', '--cached', '--quiet']
  // an unborn branch has nothing to diff against: always commit
  const hasHead = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0
  if (hasHead) {
    const d = await run(root, paths?.length ? [...diffArgs, '--', ...paths] : diffArgs, { allowFail: true })
    if (d.code === 0) return null
  }
  const id = await identityArgs(root)
  const args = [...id, 'commit', '--quiet', '--no-verify', '-F', '-']
  if (paths?.length) args.push('--', ...paths)
  await run(root, args, { input: `${msg}\n` })
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
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('Некорректная версия')
  const check = await run(root, ['check-ref-format', `refs/tags/${name}`], { allowFail: true })
  if (check.code !== 0 || !name) throw new Error('Недопустимое имя метки')
  const exists = await run(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { allowFail: true })
  if (exists.code === 0) throw new Error(`Метка «${name}» уже есть`)
  const id = await identityArgs(root)
  await run(root, [...id, 'tag', '-a', '-F', '-', name, sha], { input: `${message.trim() || name}\n` })
}

/** a file's content at a commit; null when the file did not exist there */
export async function gitShowFile(root: string, sha: string, path: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('Некорректная версия')
  const r = await run(root, ['show', `${sha}:${path}`], { allowFail: true, binary: true })
  return r.code === 0 ? r.out : null
}

/** file names directly inside `dir` at a commit */
export async function gitListDir(root: string, sha: string, dir: string): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('Некорректная версия')
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
