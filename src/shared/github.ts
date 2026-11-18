/**
 * GitHub for project folders: types shared by main, preload and renderer, and pure helpers (URL
 * parsing, repository names, `gh` output, error classification). Main side: src/main/github.ts (the
 * `gh` CLI: sign-in, repositories, git credentials; reusable) and src/main/githubSync.ts (a project
 * folder's remote: connect, push, pull, conflicts).
 *
 * doplan never asks for or stores a password or token: GitHub sign-in is `gh auth login --web`
 * (device code shown in the app), and git gets its credentials from `gh auth git-credential` or the
 * user's own git credential manager.
 */

// ───────────── repository addresses ─────────────

export interface GithubRepoRef {
  owner: string
  repo: string
  /** the address was given as ssh (git@github.com:…); push/pull then use ssh keys */
  ssh: boolean
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
// never a leading '-': gh would read such a name as one of its flags
const REPO_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/

export function isValidRepoName(name: string): boolean {
  return REPO_RE.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name)
}

/**
 * A GitHub repository from what a user pastes: https://github.com/owner/repo(.git), the page of a
 * file or branch (…/tree/main/…), github.com/owner/repo without a scheme, git@github.com:owner/repo.git,
 * ssh://git@github.com/owner/repo.git. null for anything else (other hosts, credentials in the URL).
 */
export function parseGithubUrl(input: string): GithubRepoRef | null {
  const s = String(input ?? '').trim()
  if (!s || s.length > 500 || /\s/.test(s)) return null
  let ssh = false
  let path: string
  const scp = /^git@github\.com:(.+)$/i.exec(s)
  if (scp) {
    ssh = true
    path = scp[1]
  } else {
    let url: URL
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
    } catch {
      return null
    }
    if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') return null
    if (url.port) return null
    if (url.protocol === 'ssh:') {
      if (url.username !== 'git' || url.password) return null
      ssh = true
    } else if (url.protocol === 'https:' || url.protocol === 'http:') {
      // a token or password pasted with the address is never kept
      if (url.username || url.password) return null
    } else return null
    path = url.pathname
  }
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = decodeURIComponent(parts[0])
  const repo = decodeURIComponent(parts[1]).replace(/\.git$/i, '')
  // ssh addresses name the repository only; a web address may go on to a branch or file
  if (ssh && parts.length > 2) return null
  if (!OWNER_RE.test(owner) || !isValidRepoName(repo)) return null
  return { owner, repo, ssh }
}

/**
 * A remote address safe to show: a user name or token in an https address (a token clone) is dropped,
 * a password in any other one too. Anything that is not a URL stays as it is.
 */
export function stripUrlCredentials(input: string): string {
  const s = String(input ?? '')
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i.exec(s)
  if (!m) return s
  const keep = /^https?:\/\/$/i.test(m[1]) ? '' : `${m[2].split(':')[0]}@`
  return `${m[1]}${keep}${s.slice(m[0].length)}`
}

/** the address git uses as the remote */
export function remoteUrlOf(ref: GithubRepoRef): string {
  return ref.ssh ? `git@github.com:${ref.owner}/${ref.repo}.git` : `https://github.com/${ref.owner}/${ref.repo}.git`
}

/** the repository's page */
export function webUrlOf(ref: Pick<GithubRepoRef, 'owner' | 'repo'>): string {
  return `https://github.com/${ref.owner}/${ref.repo}`
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
}

/** a GitHub repository name from a project name: transliterated, [a-z0-9._-], at most 100 characters */
export function repoNameFromProject(name: string): string {
  let s = ''
  for (const ch of String(name ?? '').normalize('NFKD').toLowerCase()) {
    if (/[̀-ͯ]/.test(ch)) continue // accents split off by NFKD
    s += TRANSLIT[ch] ?? ch
  }
  s = s
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '')
  if (/\.git$/.test(s)) s = s.slice(0, -4)
  return isValidRepoName(s) ? s : 'doplan-project'
}

// ───────────── gh CLI ─────────────

export interface GhInstallHint {
  /** command that installs gh on this platform, shown to copy */
  command: string
  /** doplan can run the command itself in a console window (Windows with winget) */
  canRun: boolean
  /** official install instructions */
  url: string
}

export interface GhStatus {
  installed: boolean
  version?: string
  loggedIn: boolean
  /** GitHub login of the signed-in account */
  user?: string
  install: GhInstallHint
}

export type GhLoginEvent =
  /** the one-time code to enter on `url` */
  | { type: 'code'; code: string; url: string }
  | { type: 'done'; ok: boolean; user?: string; error?: string }

/** the one-time code `gh auth login --web` prints */
export function parseDeviceCode(text: string): string | null {
  const m = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)
  return m ? m[1].toUpperCase() : null
}

/**
 * `gh auth status --hostname github.com` (stdout and stderr together): the active account's login.
 * gh 2.40+: "Logged in to github.com account NAME (keyring)" with "Active account: true" below;
 * older: "Logged in to github.com as NAME (oauth_token)".
 */
export function parseGhAuthStatus(text: string): { loggedIn: boolean; user?: string } {
  const re = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/g
  const found: { user: string; at: number }[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) found.push({ user: m[1], at: m.index })
  if (!found.length) return { loggedIn: false }
  for (let i = 0; i < found.length; i++) {
    const block = text.slice(found[i].at, i + 1 < found.length ? found[i + 1].at : undefined)
    if (/Active account:\s*true/i.test(block)) return { loggedIn: true, user: found[i].user }
  }
  return { loggedIn: true, user: found[0].user }
}

/** the repository address `gh repo create` prints */
export function parseCreatedRepoUrl(text: string): GithubRepoRef | null {
  const m = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/.exec(text)
  return m ? parseGithubUrl(m[0]) : null
}

export function ghInstallHint(platform: string, wingetFound: boolean): GhInstallHint {
  if (platform === 'win32') return { command: 'winget install --id GitHub.cli -e', canRun: wingetFound, url: 'https://cli.github.com/' }
  if (platform === 'darwin') return { command: 'brew install gh', canRun: false, url: 'https://cli.github.com/' }
  return { command: 'sudo apt install gh', canRun: false, url: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md' }
}

// ───────────── sync state ─────────────

export type SyncState =
  /** not a project folder with versions (unsaved, .doplan file, git missing, untrusted…): see `reason` */
  | 'unavailable'
  /** no GitHub repository connected */
  | 'disconnected'
  /** connected, nothing sent yet */
  | 'notPushed'
  | 'synced'
  /** versions here that GitHub does not have */
  | 'ahead'
  /** versions on GitHub that are not here */
  | 'behind'
  | 'diverged'

export interface GithubSyncStatus {
  state: SyncState
  /** why sync is unavailable (human text) */
  reason?: string
  /** connected repository; owner/repo/webUrl only when it is on GitHub */
  remote?: { url: string; owner?: string; repo?: string; webUrl?: string }
  /** branch on GitHub the project goes to */
  branch?: string
  ahead: number
  behind: number
  /** ms since epoch of the last successful look at GitHub */
  checkedAt?: number
  /** the last look at GitHub failed (human text): ahead/behind are as of checkedAt */
  error?: string
  errorCode?: SyncErrorCode
}

export interface PushResult {
  /** GitHub has versions this copy does not: get them first (pull), then push again */
  needPull?: boolean
  /** non-blocking notes (large files, large repository) */
  warnings: string[]
  status: GithubSyncStatus
}

export interface PullResult {
  result: 'upToDate' | 'updated' | 'merged' | 'conflict'
  /** files changed both here and on GitHub (result 'conflict') */
  conflicts?: string[]
  status: GithubSyncStatus
}

/** what to do when the same parts changed here and on GitHub */
export type ConflictChoice = 'mine' | 'theirs' | 'both'

export interface ResolveResult {
  /** 'both': the GitHub version saved as a separate project folder here */
  copyPath?: string
  status: GithubSyncStatus
}

export interface ConnectResult {
  /** the project went to GitHub */
  pushed: boolean
  /** GitHub already had versions of this project and they were combined (conflict: resolve, then push) */
  pull?: PullResult
  warnings: string[]
  status: GithubSyncStatus
}

/** renderer API (window.doplan.github) */
export interface GithubApi {
  ghStatus(): Promise<GhStatus>
  /** opens a console window running the platform's install command; false where it cannot */
  installGh(): Promise<boolean>
  /** starts `gh auth login --web`; progress arrives through onLogin */
  login(): Promise<void>
  loginCancel(): Promise<void>
  onLogin(cb: (ev: GhLoginEvent) => void): () => void
  /** state of the open project; `fetch` looks at GitHub first (no sign-in windows) */
  status(fetch?: boolean): Promise<GithubSyncStatus>
  /** connects an existing repository by its address and sends the project there */
  connect(url: string): Promise<ConnectResult>
  /** creates a repository on the signed-in account (gh) and connects it */
  create(name: string, isPrivate: boolean): Promise<ConnectResult>
  /** commits what is not committed yet and sends it to GitHub */
  push(): Promise<PushResult>
  /** gets versions from GitHub; on a real conflict nothing changes until resolve() */
  pull(): Promise<PullResult>
  resolve(choice: ConflictChoice): Promise<ResolveResult>
  disconnect(): Promise<GithubSyncStatus>
  /** opens the connected repository's page (or GitHub's device page / install page) in the browser */
  openPage(which: 'repo' | 'device' | 'install'): Promise<void>
}

// ───────────── errors ─────────────

export type SyncErrorCode =
  | 'offline'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'nameTaken'
  | 'rejected'
  | 'protectedBranch'
  | 'emailPrivacy'
  | 'secretFound'
  | 'refused'
  | 'tooLarge'
  | 'timeout'
  | 'unknown'

/**
 * GitHub's push protection block: its own `remote:` lines (a repository, owner or folder name may
 * contain the same words, but never as the server's message) and the link to allow the secret, which
 * has a fixed shape: github.com/<owner>/<repo>/security/secret-scanning/unblock-secret/<id>.
 */
const PUSH_PROTECTION_LINE = /^\s*remote:.*(PUSH PROTECTION|Push cannot contain secrets|secret scanning)/im
const UNBLOCK_SECRET_URL = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/security\/secret-scanning\/unblock-secret\/[A-Za-z0-9]+/i

/** what kind of failure a git or gh message describes */
export function classifyError(text: string): SyncErrorCode {
  const s = String(text ?? '')
  if (/Name already exists|already exists on this account/i.test(s)) return 'nameTaken'
  if (/GH001|exceeds GitHub's file size limit|Large files detected|pack exceeds maximum allowed size|this exceeds GitHub/i.test(s)) return 'tooLarge'
  // GitHub itself refused the versions (rules of the repository): getting changes would not help
  if (/GH007|push would publish a private email|private email address/i.test(s)) return 'emailPrivacy'
  // push protection reports itself as GH013 too: a secret in the versions, not a protected branch
  if (PUSH_PROTECTION_LINE.test(s) || UNBLOCK_SECRET_URL.test(s)) return 'secretFound'
  if (/GH006|GH013|Protected branch|protected branch hook declined|Repository rule violations|rule violations found/i.test(s)) return 'protectedBranch'
  if (/\[remote rejected\]|hook declined/i.test(s)) return 'refused'
  // only "GitHub has versions you do not": a bare "failed to push some refs" says nothing about why
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(s)) return 'rejected'
  if (/timed out|ETIMEDOUT|timeout/i.test(s) && !/Could not resolve/i.test(s)) {
    if (/Connection timed out|Operation timed out|connect.*timed out/i.test(s)) return 'offline'
    return 'timeout'
  }
  if (
    /Could not resolve host|Failed to connect|Network is unreachable|No route to host|Connection refused|Couldn't connect|getaddrinfo|ENOTFOUND|ECONNREFUSED|ENETUNREACH|error connecting to|dial tcp|SSL_connect|unable to access.*(?:Recv failure|Send failure)|Connection reset/i.test(
      s,
    )
  )
    return 'offline'
  if (/Permission to .* denied|returned error: 403|HTTP 403|Resource not accessible|denied to /i.test(s)) return 'forbidden'
  if (
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|Permission denied \(publickey|HTTP 401|Bad credentials|not logged in|gh auth login|Host key verification failed/i.test(
      s,
    )
  )
    return 'auth'
  if (/Repository not found|repository .* not found|HTTP 404|does not appear to be a git repository|Could not resolve to a Repository/i.test(s)) return 'notFound'
  return 'unknown'
}

/** a failure in plain words with what to do; `detail` is the raw first line, kept for 'unknown' */
export function errorText(code: SyncErrorCode, lang: 'ru' | 'en', detail = ''): string {
  const ru: Record<SyncErrorCode, string> = {
    offline: 'Нет связи с GitHub. Проверьте подключение к интернету и попробуйте ещё раз.',
    auth: 'GitHub не узнал вас. Войдите в GitHub (кнопка «Войти в GitHub» в окне GitHub) и повторите.',
    forbidden: 'У вашего аккаунта GitHub нет права записывать в этот репозиторий. Попросите владельца добавить вас в соавторы (Settings → Collaborators) или выберите свой репозиторий.',
    notFound: 'Репозиторий не найден. Проверьте ссылку; если репозиторий приватный — войдите в GitHub под аккаунтом, у которого есть к нему доступ.',
    nameTaken: 'Репозиторий с таким именем у вас уже есть. Придумайте другое имя или подключите существующий по ссылке.',
    rejected: 'На GitHub появились новые версии. Сначала получите изменения, потом отправьте свои.',
    protectedBranch:
      'Ветка на GitHub защищена правилами репозитория, и отправлять в неё напрямую нельзя. Владелец может снять защиту в настройках репозитория (Settings → Branches или Rules).',
    emailPrivacy:
      'GitHub не принял версии: в них указан ваш адрес почты, а в настройках GitHub включено его скрытие. Укажите в Git адрес вида …@users.noreply.github.com (он есть в GitHub → Settings → Emails) либо снимите там «Block command line pushes that expose my email».',
    secretFound:
      'GitHub не принял версии: в них найден секрет (пароль, токен или ключ доступа). Уберите его из файла и смените сам секрет; если он уже попал в сохранённые версии, а вы уверены, что это не настоящий секрет, — разрешите его на GitHub по ссылке.',
    refused: 'GitHub отказался принять версии.',
    tooLarge: 'GitHub не принял слишком большой файл (лимит — 100 МБ на файл). Уменьшите или удалите большую модель либо подложку.',
    timeout: 'GitHub слишком долго не отвечает. Попробуйте ещё раз чуть позже.',
    unknown: 'Не удалось связаться с GitHub.',
  }
  const en: Record<SyncErrorCode, string> = {
    offline: 'No connection to GitHub. Check your internet connection and try again.',
    auth: 'GitHub did not recognise you. Sign in to GitHub (“Sign in to GitHub” in the GitHub window) and try again.',
    forbidden: 'Your GitHub account may not write to this repository. Ask its owner to add you as a collaborator (Settings → Collaborators) or choose your own repository.',
    notFound: 'Repository not found. Check the link; for a private repository, sign in to GitHub with an account that has access to it.',
    nameTaken: 'You already have a repository with this name. Choose another name or connect the existing one by its link.',
    rejected: 'GitHub has new versions. Get the changes first, then send yours.',
    protectedBranch:
      'The branch on GitHub is protected by the repository rules and cannot be pushed to directly. Its owner can lift the protection in the repository settings (Settings → Branches or Rules).',
    emailPrivacy:
      'GitHub refused the versions: they carry your email address, and your GitHub settings keep it private. Set an …@users.noreply.github.com address in Git (see GitHub → Settings → Emails) or untick “Block command line pushes that expose my email” there.',
    secretFound:
      'GitHub refused the versions: a secret (password, token or access key) was found in them. Remove it from the file and change the secret itself; if it is already in the saved versions and you are sure it is not a real secret, allow it on GitHub through the link.',
    refused: 'GitHub refused the versions.',
    tooLarge: 'GitHub refused a file that is too large (the limit is 100 MB per file). Make the large model or underlay smaller, or remove it.',
    timeout: 'GitHub takes too long to answer. Try again a little later.',
    unknown: 'Could not reach GitHub.',
  }
  const text = (lang === 'en' ? en : ru)[code]
  return (code === 'unknown' || code === 'refused' || code === 'secretFound') && detail ? `${text} ${detail}` : text
}

/** where push protection found secrets (file:line) and its link to allow one, from git's output */
export function secretScanDetail(text: string): string {
  const s = String(text ?? '')
  // only the server's own lines: a path elsewhere (a folder name in a local error) is not a finding
  const paths = [...new Set([...s.matchAll(/^\s*remote:\s*path:\s*(\S+)/gim)].map((m) => m[1]))].slice(0, 5)
  const link = UNBLOCK_SECRET_URL.exec(s)?.[0]
  return [paths.length ? paths.join(', ') : '', link ?? ''].filter(Boolean).join(' — ')
}

/** the most telling line of a git/gh error output (fatal:/error:/remote: lines first) */
export function firstErrorLine(text: string): string {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  // the server's own reason (remote: error: …) says more than git's closing "failed to push some refs"
  const telling = (re: RegExp) => lines.find((l) => re.test(l) && !/^error: failed to push some refs/i.test(l))
  const line = telling(/^remote: error/i) ?? telling(/^(fatal|error|GraphQL|HTTP \d)/i) ?? telling(/\[remote rejected\]/i) ?? lines[0] ?? ''
  return line.slice(0, 300)
}

// ───────────── size limits ─────────────

/** GitHub refuses a file over 100 MiB */
export const GITHUB_FILE_LIMIT = 100 * 1024 * 1024
/** GitHub warns about files over 50 MiB */
export const GITHUB_FILE_WARN = 50 * 1024 * 1024
/** GitHub recommends repositories under 1 GB (5 GB strongly) */
export const GITHUB_REPO_WARN = 1024 * 1024 * 1024

export interface SizedFile {
  path: string
  size: number
}

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}`
}

/** files that stop a push (over the limit) and that are worth a warning, largest first */
export function sizeCheck(files: SizedFile[]): { blocked: SizedFile[]; large: SizedFile[] } {
  const sorted = [...files].sort((a, b) => b.size - a.size)
  return {
    blocked: sorted.filter((f) => f.size > GITHUB_FILE_LIMIT),
    large: sorted.filter((f) => f.size > GITHUB_FILE_WARN && f.size <= GITHUB_FILE_LIMIT),
  }
}
