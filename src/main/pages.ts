/**
 * "Publish for viewing": a read-only copy of the plan on GitHub Pages.
 *
 * The site (the viewer build + view-plan.json / view-catalog.json / view-site.json + the asset files the plan uses,
 * see shared/pagesSite) is built in userData/pages/<id>/site and pushed as the only commit of the
 * orphan `gh-pages` branch of the project's GitHub repository; Pages is turned on for that branch.
 * The branch carries a marker file with the publication's id (PAGES_MARKER): doplan replaces or
 * deletes only a branch with its own marker, and changes or turns off only a Pages site that serves
 * that branch. A repository that already has a gh-pages branch or a Pages site of its own is left
 * alone: the plan goes into a separate public repository `<name>-view` instead. A private repository
 * whose owner is on GitHub Free cannot have Pages: the user chooses to make it public or to publish
 * separately (never decided silently).
 *
 * Published plans are remembered in userData/pages.json by document id: the repository, the address,
 * the publication id and the content hash, so the dialog can say "published / outdated". An update
 * always goes to the recorded repository, whatever the project's origin points to now.
 */
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  canPublishInto,
  hashString,
  migrateRecordKey,
  originUrlFromGitConfig,
  PAGES_BRANCH,
  PAGES_LIMITS,
  PAGES_MARKER,
  pagesMarker,
  pagesNeedsChoice,
  pagesOwnership,
  parseGithubRemote,
  planSlug,
  viewRepoCandidate,
  viewRepoName,
  type AssetHost,
  type Ownership,
  type PagesInspection,
  type PagesProgress,
  type PagesPublishRequest,
  type PagesPublishResult,
  type PagesRecord,
  type PagesStatus,
  type PagesStatusQuery,
  type PagesTarget,
  type PagesTargetKind,
  type RepoRef,
} from '@shared/pagesSite'
import { CH } from './channels'
import { atomicWrite, readJson } from './fsutil'
import { findGit } from './git'
import { handleIpc } from './ipc'
import { buildSite } from './pagesBuild'
import {
  createPublicRepo,
  disablePages,
  enablePages,
  ghLoginText,
  ghMissingText,
  ghStatus,
  gitCredentialArgs,
  inspectPages,
  makePublic,
  openPagesUrl,
  ownerPlan,
  repoState,
} from './pagesGh'
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

const cleanAliases = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 4) : [])

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
const refOf = (r: PagesRecord): RepoRef => ({ owner: r.owner, repo: r.repo })
const sameName = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase()

const separateBase = (project: RepoRef | null, name: string, docId: string) => project?.repo ?? planSlug(name, docId)

/** a repository as a place for the site: exists, private, Pages allowed by its owner's plan, already used */
async function targetOf(kind: PagesTargetKind, ref: RepoRef, login: string | undefined, occupancy: boolean): Promise<PagesTarget> {
  const st = await repoState(ref)
  if (!st.exists) return { kind, ref, exists: false, isPrivate: false, needsChoice: false }
  const plan = st.isPrivate ? await ownerPlan(ref.owner, login) : undefined
  const t: PagesTarget = { kind, ref, exists: true, isPrivate: st.isPrivate, needsChoice: pagesNeedsChoice(st.isPrivate, plan) }
  if (occupancy) {
    // before the first publication any gh-pages branch or Pages site there is someone else's
    const own = pagesOwnership(await inspectPages(ref), undefined, false)
    if (own.branch === 'foreign') t.occupied = 'branch'
    else if (own.site === 'foreign') t.occupied = 'site'
  }
  return t
}

/** the first `<base>-view[-n]` name on the user's account no repository has taken */
async function freeViewRepo(login: string, base: string): Promise<RepoRef> {
  for (let n = 1; n <= 20; n++) {
    const ref = { owner: login, repo: viewRepoCandidate(base, n) }
    if (!(await repoState(ref)).exists) return ref
  }
  throw new Error(msg(`Не нашлось свободного имени для репозитория ${viewRepoName(base)}.`, `No free name left for the repository ${viewRepoName(base)}.`))
}

function foreignError(ref: RepoRef, own: { branch: Ownership; site: Ownership }): Error {
  const r = `${ref.owner}/${ref.repo}`
  return new Error(
    own.branch === 'foreign'
      ? msg(
          `В репозитории ${r} есть ветка gh-pages, которую сделал не doplan. doplan её не трогает: снимите план с публикации и опубликуйте его в отдельный репозиторий.`,
          `Repository ${r} has a gh-pages branch doplan did not make. doplan leaves it alone: unpublish the plan and publish it into a separate repository.`,
        )
      : msg(
          `У репозитория ${r} уже есть свой сайт GitHub Pages. doplan его не меняет: опубликуйте план в отдельный репозиторий.`,
          `Repository ${r} already has a GitHub Pages site of its own. doplan does not change it: publish the plan into a separate repository.`,
        ),
  )
}

const chooseError = () =>
  new Error(msg('Репозиторий приватный: выберите, сделать его публичным или публиковать отдельно.', 'The repository is private: choose to make it public or to publish separately.'))

/** turns off doplan's own Pages site and deletes doplan's own gh-pages branch; anything else stays */
async function takeDown(runner: GitRunner, work: string, ref: RepoRef, pubId: string | undefined): Promise<void> {
  if (!(await repoState(ref)).exists) return
  const insp = await inspectPages(ref)
  const own = pagesOwnership(insp, pubId, true)
  if (own.site === 'ours') await disablePages(ref)
  if (own.branch === 'ours' && insp.branchSha) await deleteRemoteBranch(runner, join(work, 'unpublish'), remoteOf(ref), PAGES_BRANCH, insp.branchSha)
}

// ───────────── status ─────────────

export async function pagesStatus(q: PagesStatusQuery): Promise<PagesStatus> {
  const docId = String(q?.docId ?? '')
  const gh = await ghStatus(!!q?.fresh).catch(() => ({ installed: false, loggedIn: false }) as { installed: boolean; loggedIn: boolean; user?: string })
  const git = !!(await findGit())
  const records = await loadRecords()
  if (migrateRecordKey(records, docId, cleanAliases(q?.aliases))) await saveRecords(records)
  const record = records[docId] ?? null
  const ref = await projectRepo()
  const base = separateBase(ref, String(q?.name ?? ''), docId)
  let separateName = record?.separate ? record.repo : viewRepoName(base)
  let project: PagesTarget | null = null
  let recordTarget: PagesTarget | null = null
  if (gh.loggedIn) {
    if (record) {
      recordTarget = await targetOf(record.separate ? 'separate' : 'project', refOf(record), gh.user, false).catch(() => null)
    } else {
      if (ref) project = await targetOf('project', ref, gh.user, true).catch(() => null)
      if ((!project || !project.exists || project.needsChoice || project.occupied) && gh.user)
        separateName = (await freeViewRepo(gh.user, base).catch(() => null))?.repo ?? separateName
    }
  } else if (ref) {
    project = { kind: 'project', ref, exists: true, isPrivate: false, needsChoice: false }
  }
  return {
    gh,
    git,
    record,
    outdated: !!record && record.contentHash !== q?.contentHash,
    project,
    separateName,
    recordTarget,
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
    (req.privateChoice === undefined || req.privateChoice === 'makePublic' || req.privateChoice === 'separate') &&
    (req.aliases === undefined || Array.isArray(req.aliases)) &&
    (req.underlays === undefined || typeof req.underlays === 'boolean')
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
    const aliases = cleanAliases(req.aliases)
    const records = await loadRecords()
    if (migrateRecordKey(records, req.docId, aliases)) await saveRecords(records)
    const prev = records[req.docId] ?? null
    const pubId = prev?.pubId ?? randomBytes(12).toString('base64url')

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
    await fsp.writeFile(join(siteDir, PAGES_MARKER), pagesMarker(pubId))

    // ── the repository: everything is checked before anything is changed ──
    emit({ step: 'repo' })
    const project = await projectRepo()
    const description = msg(`Просмотр плана «${req.info.title}» (doplan)`, `Viewing the plan “${req.info.title}” (doplan)`)
    // a plan published into its project repository that can no longer host it moves to a separate one
    const moveFrom = prev && !prev.separate && req.privateChoice === 'separate' ? refOf(prev) : null
    let ref: RepoRef
    let separate: boolean
    let insp: PagesInspection
    let recorded = false
    if (prev && !moveFrom) {
      // an update: always the recorded repository, never wherever the origin points now
      ref = refOf(prev)
      separate = prev.separate
      recorded = true
      const t = await targetOf(separate ? 'separate' : 'project', ref, gh.user, false)
      let toPublic = false
      if (!t.exists) {
        if (!separate || !sameName(ref.owner, gh.user))
          throw new Error(
            msg(
              `Репозиторий ${ref.owner}/${ref.repo} не найден на GitHub. Снимите план с публикации и опубликуйте заново.`,
              `Repository ${ref.owner}/${ref.repo} was not found on GitHub. Unpublish the plan and publish it again.`,
            ),
          )
        ref = await createPublicRepo(ref.repo, description)
      } else if (t.needsChoice) {
        if (separate)
          throw new Error(msg(`Репозиторий ${ref.owner}/${ref.repo} стал приватным. Сделайте его публичным на GitHub или снимите план с публикации.`, `Repository ${ref.owner}/${ref.repo} became private. Make it public on GitHub or unpublish the plan.`))
        if (req.privateChoice !== 'makePublic') throw chooseError()
        toPublic = true
      }
      insp = await inspectPages(ref)
      const own = pagesOwnership(insp, pubId, true)
      if (!canPublishInto(own)) throw foreignError(ref, own)
      if (toPublic) await makePublic(ref)
    } else if (!moveFrom && req.target === 'project' && req.privateChoice !== 'separate') {
      separate = false
      if (!project)
        throw new Error(msg('У проекта нет репозитория на GitHub. Опубликуйте план в отдельный публичный репозиторий.', 'The project has no GitHub repository. Publish the plan into a separate public repository.'))
      ref = project
      const t = await targetOf('project', ref, gh.user, false)
      if (!t.exists)
        throw new Error(msg(`Репозиторий ${ref.owner}/${ref.repo} не найден на GitHub. Отправьте проект на GitHub или опубликуйте в отдельный репозиторий.`, `Repository ${ref.owner}/${ref.repo} was not found on GitHub. Push the project to GitHub or publish into a separate repository.`))
      insp = await inspectPages(ref)
      const own = pagesOwnership(insp, pubId, false)
      if (!canPublishInto(own)) throw foreignError(ref, own)
      if (t.needsChoice) {
        if (req.privateChoice !== 'makePublic') throw chooseError()
        await makePublic(ref)
      }
    } else {
      // a new repository of the user's own: one doplan did not make is never reused
      separate = true
      const free = await freeViewRepo(gh.user, moveFrom?.repo ?? separateBase(project, req.info.title, req.docId))
      ref = await createPublicRepo(free.repo, description)
      insp = { branchSha: null, marker: null, pages: null }
    }

    // ── push + Pages ──
    emit({ step: 'push' })
    const own = pagesOwnership(insp, pubId, recorded)
    const sha = await pushSite(runner, siteDir, remoteOf(ref), PAGES_BRANCH, msg('Опубликованный план (doplan)', 'Published plan (doplan)'), insp.branchSha)
    emit({ step: 'pages' })
    let url: string
    try {
      url = await enablePages(ref, own.site === 'ours' ? insp.pages : null)
    } catch (e) {
      // Pages refused (an owner plan without Pages for private repositories…): take the new branch back
      if (insp.branchSha === null) await deleteRemoteBranch(runner, join(work, 'cleanup'), remoteOf(ref), PAGES_BRANCH, sha).catch(() => false)
      throw e
    }

    const record: PagesRecord = {
      owner: ref.owner,
      repo: ref.repo,
      url,
      contentHash: req.info.contentHash,
      publishedAt: req.info.publishedAt,
      separate,
      pubId,
      underlays: !!req.underlays,
    }
    const latest = await loadRecords()
    for (const a of aliases) if (a !== req.docId) delete latest[a]
    latest[req.docId] = record
    await saveRecords(latest)
    if (moveFrom && prev) await takeDown(runner, work, moveFrom, prev.pubId).catch(() => undefined)
    emit({ step: 'done' })
    return { record, bytes: built.bytes, files: built.files, missing: built.missing }
  } finally {
    busy = false
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ───────────── unpublish ─────────────

/**
 * Turns doplan's Pages site off and deletes doplan's gh-pages branch of the recorded repository (a
 * branch or site someone else has put there since is left alone); a separate `…-view` repository
 * itself stays.
 */
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
    await takeDown(await gitRunner(), workDir(docId), refOf(rec), rec.pubId)
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
