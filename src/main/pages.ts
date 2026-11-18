/**
 * "Publish for viewing": a read-only copy of the plan on GitHub Pages.
 *
 * The site (the viewer build + plan.json / catalog.json / site.json + the asset files the plan uses,
 * see shared/pagesSite) is built in userData/pages/<id>/site and pushed as the only commit of the
 * orphan `gh-pages` branch of the project's GitHub repository (force-push: the branch never keeps old
 * versions, the project history is untouched); Pages is turned on for that branch. A private project
 * repository on GitHub Free cannot have Pages: the user chooses to make it public or to publish into a
 * separate public repository `<name>-view` (never decided silently). Without a project repository the
 * separate one is the only way.
 *
 * Published plans are remembered in userData/pages.json by document id: the address, the repository
 * and the content hash, so the dialog can say "published / outdated".
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  hashString,
  originUrlFromGitConfig,
  PAGES_BRANCH,
  PAGES_LIMITS,
  parseGithubRemote,
  planSlug,
  viewRepoName,
  type AssetHost,
  type PagesProgress,
  type PagesPublishRequest,
  type PagesPublishResult,
  type PagesRecord,
  type PagesStatus,
  type PagesStatusQuery,
  type PagesTarget,
  type RepoRef,
} from '@shared/pagesSite'
import { CH } from './channels'
import { atomicWrite, readJson } from './fsutil'
import { findGit } from './git'
import { handleIpc } from './ipc'
import { buildSite } from './pagesBuild'
import { createPublicRepo, disablePages, enablePages, ghLoginText, ghMissingText, ghStatus, gitCredentialArgs, makePublic, openPagesUrl, repoState, userPlan } from './pagesGh'
import { deleteRemoteBranch, pushSite, type GitRunner } from './pagesGit'
import { mainDir, paths } from './paths'
import { getProjectRoot } from './projectFolder'
import { msg } from './settings'
import { sendToRenderer } from './window'

const recordsFile = () => join(paths.userData, 'pages.json')
const workDir = (docId: string) => join(paths.userData, 'pages', hashString(docId))

type Records = Record<string, PagesRecord>

async function loadRecords(): Promise<Records> {
  const r = await readJson<unknown>(recordsFile(), {})
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Records) : {}
}

async function saveRecords(r: Records): Promise<void> {
  await atomicWrite(recordsFile(), JSON.stringify(r, null, 2))
}

/** owner/repo of the open project folder's "origin" remote on github.com, or null */
async function projectRepo(): Promise<RepoRef | null> {
  const root = getProjectRoot()
  if (!root) return null
  try {
    const st = await fsp.lstat(join(root, '.git'))
    if (!st.isDirectory()) return null
    const url = originUrlFromGitConfig(await fsp.readFile(join(root, '.git', 'config'), 'utf8'))
    return url ? parseGithubRemote(url) : null
  } catch {
    return null
  }
}

/** out/viewer of this build (packaged into the app) */
function viewerDir(): string {
  return join(mainDir, '..', 'viewer')
}

function hooksDir(): string {
  return join(app.getPath('userData'), 'git-no-hooks')
}

async function gitRunner(): Promise<GitRunner> {
  const git = await findGit()
  if (!git) throw new Error(msg('Git не найден. Установите Git (https://git-scm.com), чтобы публиковать планы.', 'Git not found. Install Git (https://git-scm.com) to publish plans.'))
  await fsp.mkdir(hooksDir(), { recursive: true })
  return { git, hooksDir: hooksDir(), config: await gitCredentialArgs() }
}

const remoteOf = (ref: RepoRef) => `https://github.com/${ref.owner}/${ref.repo}.git`

const separateBase = (project: RepoRef | null, name: string, docId: string) => project?.repo ?? planSlug(name, docId)

// ───────────── status ─────────────

export async function pagesStatus(q: PagesStatusQuery): Promise<PagesStatus> {
  const docId = String(q?.docId ?? '')
  const gh = await ghStatus(!!q?.fresh).catch(() => ({ installed: false, loggedIn: false }))
  const git = !!(await findGit())
  const record = (await loadRecords())[docId] ?? null
  const ref = await projectRepo()
  let project: PagesTarget | null = null
  let plan: string | undefined
  if (ref) {
    if (gh.loggedIn) {
      const [st, p] = await Promise.all([repoState(ref).catch(() => null), userPlan().catch(() => undefined)])
      plan = p
      const isPrivate = st?.isPrivate ?? false
      project = { kind: 'project', ref, exists: st?.exists ?? false, isPrivate, needsChoice: isPrivate && (plan ?? 'free') === 'free' }
    } else {
      project = { kind: 'project', ref, exists: true, isPrivate: false, needsChoice: false }
    }
  }
  return {
    gh,
    git,
    record,
    outdated: !!record && record.contentHash !== q?.contentHash,
    project,
    separateName: record?.separate ? record.repo : viewRepoName(separateBase(ref, String(q?.name ?? ''), docId)),
    ...(plan ? { plan } : {}),
  }
}

// ───────────── publish ─────────────

let busy = false

const HOSTS: readonly AssetHost[] = ['catalog', 'library', 'project']

function checkRequest(req: PagesPublishRequest): void {
  const ok =
    req &&
    typeof req.docId === 'string' &&
    req.docId.length > 0 &&
    req.docId.length <= 200 &&
    req.content &&
    typeof req.content === 'object' &&
    Array.isArray(req.content.files) &&
    req.content.files.length <= 100_000 &&
    req.content.files.every((f) => f && HOSTS.includes(f.host) && typeof f.rel === 'string' && typeof f.path === 'string' && f.path.startsWith('assets/')) &&
    req.info &&
    typeof req.info.title === 'string' &&
    (req.target === 'project' || req.target === 'separate') &&
    (req.privateChoice === undefined || req.privateChoice === 'makePublic' || req.privateChoice === 'separate')
  if (!ok) throw new Error('pages: bad publish request')
}

const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`

export async function publishPlan(req: PagesPublishRequest, emit: (p: PagesProgress) => void = () => undefined): Promise<PagesPublishResult> {
  checkRequest(req)
  if (busy) throw new Error(msg('Публикация уже идёт', 'Publishing is already running'))
  busy = true
  const work = workDir(req.docId)
  try {
    const gh = await ghStatus(true)
    if (!gh.installed) throw new Error(ghMissingText())
    if (!gh.loggedIn || !gh.user) throw new Error(ghLoginText())
    const runner = await gitRunner()
    const records = await loadRecords()
    const prev = records[req.docId] ?? null

    // ── the site ──
    emit({ step: 'build' })
    try {
      await fsp.access(join(viewerDir(), 'viewer.html'))
    } catch {
      throw new Error(msg('Просмотрщик не собран (out/viewer). Соберите его: pnpm build:viewer.', 'The viewer is not built (out/viewer). Build it: pnpm build:viewer.'))
    }
    const siteDir = join(work, 'site')
    const built = await buildSite({
      outDir: siteDir,
      viewerDir: viewerDir(),
      content: req.content,
      info: req.info,
      roots: { catalog: paths.catalogRoot, library: paths.library, project: paths.projectAssets },
    })
    if (built.tooLarge.length)
      throw new Error(
        msg(
          `Файлы больше 100 МБ не помещаются на GitHub: ${built.tooLarge.join(', ')}. Замените эти модели или текстуры более лёгкими.`,
          `Files over 100 MB do not fit on GitHub: ${built.tooLarge.join(', ')}. Replace these models or textures with lighter ones.`,
        ),
      )
    if (built.bytes > PAGES_LIMITS.siteBytes)
      throw new Error(msg(`Сайт плана весит ${mb(built.bytes)}, а GitHub Pages принимает до 1 ГБ.`, `The plan site is ${mb(built.bytes)}; GitHub Pages takes up to 1 GB.`))

    // ── the repository ──
    emit({ step: 'repo' })
    const project = await projectRepo()
    let ref: RepoRef
    let separate: boolean
    if (prev?.separate || req.target === 'separate' || req.privateChoice === 'separate') {
      separate = true
      ref = prev?.separate ? { owner: prev.owner, repo: prev.repo } : { owner: gh.user, repo: viewRepoName(separateBase(project, req.info.title, req.docId)) }
      const st = await repoState(ref)
      if (!st.exists) ref = await createPublicRepo(ref.repo, msg(`Просмотр плана «${req.info.title}» (doplan)`, `Viewing the plan “${req.info.title}” (doplan)`))
      else if (st.isPrivate)
        throw new Error(msg(`Репозиторий ${ref.owner}/${ref.repo} уже есть и он приватный. Сделайте его публичным или удалите.`, `Repository ${ref.owner}/${ref.repo} exists and is private. Make it public or delete it.`))
    } else {
      separate = false
      if (!project)
        throw new Error(msg('У проекта нет репозитория на GitHub. Опубликуйте план в отдельный публичный репозиторий.', 'The project has no GitHub repository. Publish the plan into a separate public repository.'))
      ref = project
      const st = await repoState(ref)
      if (!st.exists)
        throw new Error(msg(`Репозиторий ${ref.owner}/${ref.repo} не найден на GitHub. Отправьте проект на GitHub или опубликуйте в отдельный репозиторий.`, `Repository ${ref.owner}/${ref.repo} was not found on GitHub. Push the project to GitHub or publish into a separate repository.`))
      if (st.isPrivate && ((await userPlan()) ?? 'free') === 'free') {
        if (req.privateChoice !== 'makePublic')
          throw new Error(msg('Репозиторий проекта приватный: выберите, сделать его публичным или публиковать отдельно.', 'The project repository is private: choose to make it public or to publish separately.'))
        await makePublic(ref)
      }
    }

    // ── push + Pages ──
    emit({ step: 'push' })
    await pushSite(runner, siteDir, remoteOf(ref), PAGES_BRANCH, msg('Опубликованный план (doplan)', 'Published plan (doplan)'))
    emit({ step: 'pages' })
    const url = await enablePages(ref)

    const record: PagesRecord = { owner: ref.owner, repo: ref.repo, url, contentHash: req.info.contentHash, publishedAt: req.info.publishedAt, separate }
    const latest = await loadRecords()
    latest[req.docId] = record
    await saveRecords(latest)
    emit({ step: 'done' })
    return { record, bytes: built.bytes, files: built.files, missing: built.missing }
  } finally {
    busy = false
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ───────────── unpublish ─────────────

/** turns Pages off and deletes the gh-pages branch; a separate `…-view` repository itself stays */
export async function unpublishPlan(docId: string): Promise<void> {
  if (typeof docId !== 'string' || !docId) throw new Error('pages: bad document id')
  if (busy) throw new Error(msg('Публикация уже идёт', 'Publishing is already running'))
  const records = await loadRecords()
  const rec = records[docId]
  if (!rec) return
  busy = true
  try {
    const gh = await ghStatus(true)
    if (!gh.installed) throw new Error(ghMissingText())
    if (!gh.loggedIn) throw new Error(ghLoginText())
    const ref = { owner: rec.owner, repo: rec.repo }
    await disablePages(ref)
    const st = await repoState(ref)
    if (st.exists) await deleteRemoteBranch(await gitRunner(), join(workDir(docId), 'unpublish'), remoteOf(ref), PAGES_BRANCH)
    const latest = await loadRecords()
    delete latest[docId]
    await saveRecords(latest)
  } finally {
    busy = false
    await fsp.rm(workDir(docId), { recursive: true, force: true }).catch(() => undefined)
  }
}

export function registerPages(): void {
  handleIpc(CH.pagesStatus, (q: PagesStatusQuery) => pagesStatus(q))
  handleIpc(CH.pagesPublish, (req: PagesPublishRequest) => publishPlan(req, (p) => sendToRenderer(CH.evPagesProgress, p)))
  handleIpc(CH.pagesUnpublish, (docId: string) => unpublishPlan(docId))
  handleIpc(CH.pagesOpenUrl, (url: unknown) => openPagesUrl(String(url)))
}
