/**
 * The open project folder and its GitHub repository: connect (an existing repository by its address,
 * or a new one made with gh), send (commit what is not committed + push), get (fetch + merge, with a
 * plain choice on a real conflict), status, disconnect. Every step is one git command of git.ts, so
 * the repository rules there (allowlisted config, no hooks, no filters, links refused) hold here too.
 *
 * Branches: the project's own branch (main) goes to one branch on GitHub, its upstream
 * (branch.main.merge): the repository's default branch when it had one, else main.
 */
import fsp from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  formatMb,
  GITHUB_REPO_WARN,
  type ConflictChoice,
  type ConnectResult,
  type GithubSyncStatus,
  parseGithubUrl,
  type PullResult,
  type PushResult,
  remoteUrlOf,
  type ResolveResult,
  sizeCheck,
  type SyncErrorCode,
  webUrlOf,
} from '../shared/github'
import { CH } from './channels'
import {
  findGit,
  GitError,
  type GitNet,
  gitAheadBehind,
  gitBlob,
  gitCommitCount,
  gitFastForward,
  gitFetch,
  gitHead,
  gitMergeAbort,
  gitMergeCommit,
  gitMergeKeepOurs,
  gitMergeStart,
  gitMergeTakeTheirs,
  gitRefExists,
  gitRelated,
  gitRemoteHeads,
  gitRemoteUrl,
  gitRemoveRemote,
  gitRepoSize,
  gitSetRemote,
  gitSetUpstream,
  gitTreeFiles,
  gitUnpushedFiles,
  gitUpstreamBranch,
  gitPush,
} from './git'
import {
  cancelGhLogin,
  createRepo,
  ghStatus,
  gitCredentialArgs,
  GithubError,
  humanError,
  installGh,
  openGithubUrl,
  startGhLogin,
} from './github'
import { handleIpc } from './ipc'
import { grantPath } from './access'
import { commitFolder, folderTrust, getProjectRoot, readFolderFile, trustFolder } from './projectFolder'
import { msg } from './settings'
import { sendToRenderer } from './window'

const REMOTE = 'origin'
const remoteRef = (branch: string) => `refs/remotes/${REMOTE}/${branch}`

// one sync action at a time
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => undefined)
  return p
}

/** git and gh failures in plain words; anything else as it is */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GitError) throw humanError(`${err.stderr}\n${err.message}`)
    throw err
  }
}

async function net(interactive: boolean): Promise<GitNet> {
  return { config: await gitCredentialArgs(), interactive }
}

// ───────────── which folder ─────────────

/** the open project folder doplan may sync, or why not (human text) */
async function syncRoot(): Promise<{ root: string; repo: boolean } | { reason: string }> {
  const root = getProjectRoot()
  if (!root)
    return {
      reason: msg(
        'Проект ещё не сохранён как папка. Сохраните его (Файл → Сохранить как…), и тогда его можно будет отправить на GitHub.',
        'The project is not saved as a folder yet. Save it (File → Save As…) and then it can go to GitHub.',
      ),
    }
  if (!(await findGit())) return { reason: msg('Не найден Git. Установите Git (https://git-scm.com) и перезапустите doplan.', 'Git was not found. Install Git (https://git-scm.com) and restart doplan.') }
  const trust = await folderTrust(root)
  if (trust.git === 'untrusted' || trust.git === 'unknown')
    return { reason: msg('Папке проекта не доверяют: история версий выключена. Доверьтесь папке в «Истории версий».', 'The project folder is not trusted: the version history is off. Trust the folder in Version history.') }
  if (trust.git === 'gitfile') return { reason: msg('Папка входит в другой репозиторий git: doplan не синхронизирует её.', 'The folder belongs to another git repository: doplan does not sync it.') }
  if (trust.unsafeGit) return { reason: msg('История версий выключена из-за настроек git папки (см. «История версий»).', 'The version history is off because of the folder’s git settings (see Version history).') }
  return { root, repo: trust.git === 'trusted' }
}

async function requireRoot(): Promise<string> {
  const r = await syncRoot()
  if ('reason' in r) throw new Error(r.reason)
  return r.root
}

/** commits whatever is not committed yet (creating the repository in a new folder); a merge left by a crash is dropped first */
async function commitPending(root: string, message: string): Promise<void> {
  if ((await folderTrust(root)).git === 'trusted') await gitMergeAbort(root)
  await commitFolder(root, message)
}

// ───────────── status ─────────────

let lastCheck: { root: string; at?: number; error?: string; errorCode?: SyncErrorCode } | null = null

function noteCheck(root: string, err?: unknown): void {
  const prev = lastCheck?.root === root ? lastCheck : null
  if (!err) {
    lastCheck = { root, at: Date.now() }
    return
  }
  const e = err instanceof GithubError ? err : err instanceof GitError ? humanError(`${err.stderr}\n${err.message}`) : null
  lastCheck = { root, at: prev?.at, error: e?.message ?? (err as Error).message, errorCode: e && e.kind !== 'ghMissing' && e.kind !== 'ghLogin' ? e.kind : 'unknown' }
}

/** the upstream branch on GitHub; without one, what a fetch brought (main, master), else main */
async function targetBranch(root: string): Promise<string> {
  const up = await gitUpstreamBranch(root)
  if (up) return up
  for (const b of ['main', 'master']) if (await gitRefExists(root, remoteRef(b))) return b
  return 'main'
}

async function computeStatus(root: string): Promise<GithubSyncStatus> {
  const url = await gitRemoteUrl(root, REMOTE)
  if (!url) return { state: 'disconnected', ahead: 0, behind: 0 }
  const ref = parseGithubUrl(url)
  const remote = ref ? { url, owner: ref.owner, repo: ref.repo, webUrl: webUrlOf(ref) } : { url }
  const branch = await targetBranch(root)
  const check = lastCheck?.root === root ? lastCheck : null
  const base = { remote, branch, checkedAt: check?.at, error: check?.error, errorCode: check?.errorCode }
  if (!(await gitRefExists(root, remoteRef(branch)))) return { ...base, state: 'notPushed', ahead: await gitCommitCount(root), behind: 0 }
  const { ahead, behind } = await gitAheadBehind(root, remoteRef(branch))
  const state = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'synced'
  return { ...base, state, ahead, behind }
}

/** the open project's GitHub state; `fetch` looks at GitHub first (never a sign-in window) */
export async function syncStatus(fetch = false): Promise<GithubSyncStatus> {
  const r = await syncRoot()
  if ('reason' in r) return { state: 'unavailable', reason: r.reason, ahead: 0, behind: 0 }
  if (!r.repo) return { state: 'disconnected', ahead: 0, behind: 0 }
  const { root } = r
  if (fetch && (await gitRemoteUrl(root, REMOTE))) {
    try {
      await gitFetch(root, await net(false), REMOTE)
      noteCheck(root)
    } catch (err) {
      noteCheck(root, err)
    }
  }
  return computeStatus(root)
}

// ───────────── size limits ─────────────

/** throws when a version to send has a file GitHub refuses; the warnings for large ones */
async function sizeWarnings(root: string): Promise<string[]> {
  const { blocked, large } = sizeCheck(await gitUnpushedFiles(root, REMOTE))
  if (blocked.length) {
    const list = blocked
      .slice(0, 5)
      .map((f) => `${f.path} (${formatMb(f.size)} ${msg('МБ', 'MB')})`)
      .join(', ')
    throw new GithubError(
      'tooLarge',
      msg(
        `GitHub не принимает файлы больше 100 МБ, а в версиях проекта есть такой: ${list}. Замените модель или подложку облегчённой (меньше 100 МБ) и удалите большую из проекта. Если файл уже удалён, он всё равно остаётся в сохранённых версиях, и отправить их на GitHub нельзя.`,
        `GitHub does not accept files over 100 MB, and the project versions have one: ${list}. Replace the model or underlay with a lighter one (under 100 MB) and remove the large one from the project. A file already removed still stays in the saved versions, and those cannot go to GitHub.`,
      ),
    )
  }
  const warnings = large.slice(0, 5).map((f) =>
    msg(
      `Файл ${f.path} весит ${formatMb(f.size)} МБ: GitHub его примет, но советует файлы меньше 50 МБ.`,
      `File ${f.path} is ${formatMb(f.size)} MB: GitHub accepts it but recommends files under 50 MB.`,
    ),
  )
  const total = await gitRepoSize(root)
  if (total > GITHUB_REPO_WARN)
    warnings.push(
      msg(
        `История проекта занимает ${formatMb(total)} МБ. GitHub рекомендует репозитории до 1 ГБ — крупные модели и подложки лучше облегчать.`,
        `The project history takes ${formatMb(total)} MB. GitHub recommends repositories under 1 GB — keep models and underlays light.`,
      ),
    )
  return warnings
}

// ───────────── push / pull ─────────────

async function pushLocked(root: string, n: GitNet): Promise<PushResult> {
  await gitFetch(root, n, REMOTE)
  noteCheck(root)
  const branch = await targetBranch(root)
  if (await gitRefExists(root, remoteRef(branch))) {
    const { behind } = await gitAheadBehind(root, remoteRef(branch))
    if (behind) return { needPull: true, warnings: [], status: await computeStatus(root) }
  }
  const warnings = await sizeWarnings(root)
  try {
    await gitPush(root, n, branch, REMOTE)
  } catch (err) {
    if (err instanceof GitError && humanError(err.stderr).kind === 'rejected') return { needPull: true, warnings, status: await computeStatus(root) }
    throw err
  }
  await gitFetch(root, n, REMOTE).catch(() => undefined)
  noteCheck(root)
  return { warnings, status: await computeStatus(root) }
}

/** commits what is not committed yet and sends the project to GitHub */
export function push(): Promise<PushResult> {
  return exclusive(() =>
    guard(async () => {
      const root = await requireRoot()
      if (!(await gitRemoteUrl(root, REMOTE).catch(() => null))) throw new Error(msg('Проект не подключён к GitHub', 'The project is not connected to GitHub'))
      await commitPending(root, msg('Отправка на GitHub', 'Sent to GitHub'))
      return pushLocked(root, await net(true))
    }),
  )
}

/** plan.json and manifest.json of a merge are still readable JSON */
async function mergedProjectValid(root: string): Promise<boolean> {
  for (const f of ['plan.json', 'manifest.json']) {
    try {
      const buf = await readFolderFile(root, f, 256 * 1024 * 1024)
      if (buf) JSON.parse(buf.toString('utf8'))
    } catch {
      return false
    }
  }
  return true
}

async function pullLocked(root: string, n: GitNet): Promise<PullResult> {
  await gitFetch(root, n, REMOTE)
  noteCheck(root)
  const branch = await targetBranch(root)
  const ref = remoteRef(branch)
  if (!(await gitRefExists(root, ref))) return { result: 'upToDate', status: await computeStatus(root) }
  await gitSetUpstream(root, branch, REMOTE)
  if (!(await gitHead(root))) {
    await gitFastForward(root, ref)
    return { result: 'updated', status: await computeStatus(root) }
  }
  const { ahead, behind } = await gitAheadBehind(root, ref)
  if (!behind) return { result: 'upToDate', status: await computeStatus(root) }
  if (!ahead) {
    await gitFastForward(root, ref)
    return { result: 'updated', status: await computeStatus(root) }
  }
  const { conflicts } = await gitMergeStart(root, ref, { allowUnrelated: !(await gitRelated(root, ref)) })
  if (conflicts.length) return { result: 'conflict', conflicts, status: await computeStatus(root) }
  if (!(await mergedProjectValid(root))) {
    await gitMergeAbort(root)
    return { result: 'conflict', conflicts: ['plan.json'], status: await computeStatus(root) }
  }
  await gitMergeCommit(root, msg('Объединены изменения с GitHub', 'Merged changes from GitHub'))
  return { result: 'merged', status: await computeStatus(root) }
}

/** gets the versions GitHub has; on a real conflict nothing changes until resolve() */
export function pull(): Promise<PullResult> {
  return exclusive(() =>
    guard(async () => {
      const root = await requireRoot()
      if (!(await gitRemoteUrl(root, REMOTE).catch(() => null))) throw new Error(msg('Проект не подключён к GitHub', 'The project is not connected to GitHub'))
      await commitPending(root, msg('Перед получением изменений с GitHub', 'Before getting changes from GitHub'))
      return pullLocked(root, await net(true))
    }),
  )
}

/** `<root> (GitHub)`, `<root> (GitHub 2)`…: the first name with nothing there */
async function freeSibling(root: string): Promise<string> {
  for (let n = 1; ; n++) {
    const p = `${root} (GitHub${n > 1 ? ` ${n}` : ''})`
    try {
      await fsp.lstat(p)
    } catch {
      return p
    }
  }
}

/** writes the files of `ref` into a new folder next to the project (a project folder of its own) */
async function exportVersion(root: string, ref: string): Promise<string> {
  const dest = await freeSibling(resolve(root))
  await fsp.mkdir(dest)
  for (const f of await gitTreeFiles(root, ref)) {
    const parts = f.path.split('/')
    if (parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[\\:]/.test(p))) continue
    const file = join(dest, ...parts)
    if (!resolve(file).startsWith(resolve(dest) + sep)) continue
    await fsp.mkdir(dirname(file), { recursive: true })
    await fsp.writeFile(file, await gitBlob(root, f.sha), { flag: 'wx' })
  }
  // doplan made it: its git (on the first save) is trusted; the AI agent still asks
  await trustFolder(dest, false)
  grantPath(dest)
  return dest
}

/** settles a conflict reported by pull(): keep this computer's version, take GitHub's, or keep both */
export function resolveConflict(choice: ConflictChoice): Promise<ResolveResult> {
  return exclusive(() =>
    guard(async () => {
      if (choice !== 'mine' && choice !== 'theirs' && choice !== 'both') throw new Error('bad choice')
      const root = await requireRoot()
      await commitPending(root, msg('Перед получением изменений с GitHub', 'Before getting changes from GitHub'))
      const n = await net(true)
      await gitFetch(root, n, REMOTE)
      noteCheck(root)
      const branch = await targetBranch(root)
      const ref = remoteRef(branch)
      if (!(await gitRefExists(root, ref))) return { status: await computeStatus(root) }
      let copyPath: string | undefined
      if (choice === 'theirs') {
        await gitMergeTakeTheirs(root, ref, msg('Получено с GitHub: взята версия с GitHub', 'From GitHub: took the GitHub version'))
      } else {
        if (choice === 'both') copyPath = await exportVersion(root, ref)
        const name = copyPath ? copyPath.split(/[\\/]/).pop() : ''
        await gitMergeKeepOurs(
          root,
          ref,
          copyPath
            ? msg(`Получено с GitHub: оставлена версия с этого компьютера, версия с GitHub сохранена в «${name}»`, `From GitHub: kept this computer’s version, GitHub’s saved in “${name}”`)
            : msg('Получено с GitHub: оставлена версия с этого компьютера', 'From GitHub: kept this computer’s version'),
        )
      }
      await gitSetUpstream(root, branch, REMOTE)
      return { copyPath, status: await computeStatus(root) }
    }),
  )
}

// ───────────── connect / disconnect ─────────────

/** connects the repository at `url` and sends the project there (combining what it already has) */
export function connect(url: string): Promise<ConnectResult> {
  return exclusive(() => guard(() => connectLocked(url)))
}

async function connectLocked(url: unknown): Promise<ConnectResult> {
  const ref = typeof url === 'string' ? parseGithubUrl(url) : null
  if (!ref)
    throw new Error(
      msg(
        'Это не похоже на ссылку на репозиторий GitHub. Скопируйте адрес страницы репозитория, например https://github.com/имя/проект',
        'This does not look like a GitHub repository link. Copy the address of the repository page, e.g. https://github.com/name/project',
      ),
    )
  const root = await requireRoot()
  await commitPending(root, msg('Подготовка к отправке на GitHub', 'Preparing to send to GitHub'))
  if (!(await gitHead(root))) throw new Error(msg('В проекте нет сохранённых версий', 'The project has no saved versions'))
  const previous = await gitRemoteUrl(root, REMOTE)
  await gitSetRemote(root, remoteUrlOf(ref), REMOTE)
  let sent = false
  try {
    const n = await net(true)
    const heads = await gitRemoteHeads(root, n, REMOTE)
    noteCheck(root)
    if (heads.empty || !heads.head) {
      const warnings = await sizeWarnings(root)
      await gitPush(root, n, 'main', REMOTE)
      sent = true
      await gitFetch(root, n, REMOTE).catch(() => undefined)
      return { pushed: true, warnings, status: await computeStatus(root) }
    }
    await gitFetch(root, n, REMOTE)
    const branch = heads.head
    const theirs = remoteRef(branch)
    if (!(await gitRelated(root, theirs))) {
      // GitHub has files of its own (a README, a licence…): they join the project; another project is never mixed in
      const files = await gitTreeFiles(root, theirs)
      if (files.some((f) => f.path === 'plan.json' || f.path === 'manifest.json'))
        throw new GithubError(
          'unknown',
          msg(
            'В этом репозитории уже лежит другой проект doplan. Создайте новый пустой репозиторий для этого проекта или подключите другой.',
            'This repository already holds another doplan project. Create a new empty repository for this project or connect another one.',
          ),
        )
      const { conflicts } = await gitMergeStart(root, theirs, { allowUnrelated: true, favourOurs: true })
      if (conflicts.length) throw new GithubError('unknown', msg('Не удалось объединить проект с файлами репозитория.', 'Could not combine the project with the repository files.'))
      await gitMergeCommit(root, msg('Объединено с файлами репозитория GitHub', 'Combined with the GitHub repository files'))
    }
    await gitSetUpstream(root, branch, REMOTE)
    sent = true // from here the connection stays: what is left is an ordinary pull/push
    const pr = await pullLocked(root, n)
    if (pr.result === 'conflict') return { pushed: false, pull: pr, warnings: [], status: pr.status }
    const res = await pushLocked(root, n)
    return { pushed: !res.needPull, pull: pr.result === 'upToDate' ? undefined : pr, warnings: res.warnings, status: res.status }
  } catch (err) {
    if (!sent) {
      // not connected after all: the previous remote (or none) comes back
      if (previous) await gitSetRemote(root, previous, REMOTE).catch(() => undefined)
      else await gitRemoveRemote(root, REMOTE).catch(() => undefined)
      lastCheck = null
    }
    throw err
  }
}

/** creates a repository on the signed-in GitHub account and connects it */
export async function createAndConnect(name: unknown, isPrivate: unknown): Promise<ConnectResult> {
  if (typeof name !== 'string') throw new Error('name')
  await requireRoot()
  const ref = await createRepo(name.trim(), isPrivate !== false, msg('Проект doplan', 'doplan project'))
  return connect(remoteUrlOf({ ...ref, ssh: false }))
}

/** forgets the GitHub repository (the repository on GitHub stays as it is) */
export function disconnect(): Promise<GithubSyncStatus> {
  return exclusive(() =>
    guard(async () => {
      const root = await requireRoot()
      await gitRemoveRemote(root, REMOTE)
      lastCheck = null
      return computeStatus(root)
    }),
  )
}

async function openPage(which: unknown): Promise<void> {
  if (which === 'device') return openGithubUrl('https://github.com/login/device')
  if (which === 'install') return openGithubUrl((await ghStatus()).install.url)
  const root = await requireRoot()
  const url = await gitRemoteUrl(root, REMOTE)
  const ref = url ? parseGithubUrl(url) : null
  if (!ref) throw new Error(msg('Проект не подключён к GitHub', 'The project is not connected to GitHub'))
  await openGithubUrl(webUrlOf(ref))
}

export function registerGithubIpc(): void {
  handleIpc(CH.githubGhStatus, () => ghStatus(true))
  handleIpc(CH.githubInstallGh, () => installGh())
  handleIpc(CH.githubLogin, () => startGhLogin((ev) => sendToRenderer(CH.evGithubLogin, ev)))
  handleIpc(CH.githubLoginCancel, () => cancelGhLogin())
  handleIpc(CH.githubStatus, (fetch: unknown) => syncStatus(fetch === true))
  handleIpc(CH.githubConnect, (url: unknown) => connect(String(url ?? '')))
  handleIpc(CH.githubCreate, (name: unknown, isPrivate: unknown) => createAndConnect(name, isPrivate))
  handleIpc(CH.githubPush, () => push())
  handleIpc(CH.githubPull, () => pull())
  handleIpc(CH.githubResolve, (choice: unknown) => resolveConflict(choice as ConflictChoice))
  handleIpc(CH.githubDisconnect, () => disconnect())
  handleIpc(CH.githubOpenPage, (which: unknown) => openPage(which))
}

export function shutdownGithub(): void {
  cancelGhLogin()
}

/**
 * Building blocks for other GitHub features (e.g. publishing to GitHub Pages): one sync action at a
 * time, git/gh errors in plain words, and the network settings (gh's credentials, sign-in windows
 * only for actions the user started).
 */
export { exclusive as githubExclusive, guard as githubGuard, net as githubNet }
