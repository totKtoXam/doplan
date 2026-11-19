/**
 * «Опубликовать для просмотра»: a read-only copy of the plan on GitHub Pages (2D plan + 3D with
 * orbit / walk / top), a link to share, its state (published / outdated → update) and «Снять с
 * публикации». The work is done in main (src/main/pages.ts); the site content is taken from the
 * document and the catalogue here: only what the viewer shows (shared/pagesSite.viewDoc), the
 * underlays only when the user ticks them in.
 */
import { Check, Copy, Download, ExternalLink, Globe, RefreshCw, TriangleExclamationPoint } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { builtinCatalog } from '@core'
import {
  docContentHash,
  planSite,
  publicationKeys,
  viewDoc,
  visibleUnderlayCount,
  type PagesPrivateChoice,
  type PagesProgress,
  type PagesPublishResult,
  type PagesStatus,
  type SiteContent,
} from '@shared/pagesSite'
import type { Catalog } from '@core/types'
import { addTranslations, useT } from '@/i18n'
import { api } from '@/store/api'
import { useDoc } from '@/store/document'
import { generation, isCurrentGeneration } from '@/store/github'
import { movedKeys } from '@/store/pagesKeys'
import { confirmDialog, toast } from '@/store/notify'
import { uiStore, useUi } from '@/store/ui'
import { Button, Dialog, Spinner } from '@/ui/kit'
import type { DialogPropsBase } from './BomDialog'
import { displayName, downloadEntry, useDownloads, useLang } from './common/catalog'

addTranslations('en', {
  'Опубликовать для просмотра': 'Publish for viewing',
  'Опубликовать для просмотра…': 'Publish for viewing…',
  'Проверяю GitHub…': 'Checking GitHub…',
  'Проверить снова': 'Check again',
  'Нужна программа GitHub CLI (gh): установите её (https://cli.github.com) и войдите командой «gh auth login».':
    'GitHub CLI (gh) is needed: install it (https://cli.github.com) and sign in with “gh auth login”.',
  'Войдите в GitHub: выполните в терминале «gh auth login».': 'Sign in to GitHub: run “gh auth login” in a terminal.',
  'Нужен Git (https://git-scm.com).': 'Git is needed (https://git-scm.com).',
  'Опубликовано {d}': 'Published {d}',
  'Устарело: план изменился после публикации': 'Outdated: the plan changed after publishing',
  'Ссылка на просмотр': 'Viewing link',
  Скопировать: 'Copy',
  'Ссылка скопирована': 'Link copied',
  Открыть: 'Open',
  Обновить: 'Update',
  'Снять с публикации': 'Unpublish',
  Опубликовать: 'Publish',
  Закрыть: 'Close',
  'Где будет сайт': 'Where the site goes',
  'Ветка gh-pages репозитория {r} (одним коммитом, история проекта не меняется).': 'The gh-pages branch of {r} (one commit; the project history stays as it is).',
  'Отдельный публичный репозиторий {r} — только сайт, без файлов проекта.': 'A separate public repository {r}: only the site, no project files.',
  'У проекта нет репозитория на GitHub, поэтому сайт пойдёт в отдельный публичный репозиторий {r}.':
    'The project has no GitHub repository, so the site goes into a separate public repository {r}.',
  'Репозиторий проекта {r} приватный, а на бесплатном тарифе GitHub Pages работает только у публичных. Как поступить?':
    'The project repository {r} is private, and on the free GitHub plan Pages works only for public ones. What to do?',
  'Отдельный публичный репозиторий': 'Separate public repository',
  'Будет создан {r}: в нём только сайт для просмотра, сам проект останется приватным.': '{r} will be created: it holds only the viewing site, the project itself stays private.',
  'Сделать репозиторий проекта публичным': 'Make the project repository public',
  'Все файлы проекта и вся его история станут видны всем.': 'All project files and their whole history become visible to everyone.',
  'Сайт будет открыт всем, у кого есть ссылка, и может попасть в поисковики. Не публикуйте личные данные (адрес, имена, фото жильцов).':
    'The site is open to anyone with the link and may show up in search engines. Do not publish personal data (address, names, photos of residents).',
  'В плане {n} файлов моделей и текстур.': 'The plan has {n} model and texture files.',
  'Не скачаны из каталога, поэтому на сайте вместо них будут пустые места: {list}.': 'Not downloaded from the catalogue, so the site shows empty spots instead: {list}.',
  '{list} и ещё {n}': '{list} and {n} more',
  'Скачать и обновить': 'Download and update',
  'Скачать и опубликовать': 'Download and publish',
  'Скачиваю недостающее…': 'Downloading what is missing…',
  'Не удалось скачать: {list}.': 'Could not download: {list}.',
  'Собираю сайт…': 'Building the site…',
  'Готовлю репозиторий…': 'Preparing the repository…',
  'Отправляю на GitHub…': 'Uploading to GitHub…',
  'Включаю GitHub Pages…': 'Turning on GitHub Pages…',
  'Готово': 'Done',
  'Опубликовано: {size}, {n} файлов. Сайт откроется через 1–2 минуты.': 'Published: {size}, {n} files. The site opens in 1–2 minutes.',
  'Файлы не найдены и пропущены: {list}': 'Files not found and skipped: {list}',
  'Сделать {r} публичным?': 'Make {r} public?',
  'Все файлы проекта и вся история его версий станут видны всем в интернете. Вернуть приватность можно в настройках репозитория на GitHub, но копии могут остаться у других.':
    'All project files and the whole version history become visible to everyone on the internet. You can make it private again in the repository settings on GitHub, but others may keep copies.',
  'Сделать публичным': 'Make public',
  'Снять план с публикации?': 'Unpublish the plan?',
  'Сайт перестанет открываться по ссылке. Ветка gh-pages, созданная doplan, будет удалена.': 'The link stops working. The gh-pages branch doplan made is deleted.',
  'Сайт перестанет открываться по ссылке, а файлы плана будут убраны из репозитория {r}.': 'The link stops working, and the plan files are removed from repository {r}.',
  'В ветке gh-pages репозитория {r} уже опубликован план doplan (другой документ или чужая публикация). Её не тронем: сайт пойдёт в отдельный публичный репозиторий {s}.':
    'The gh-pages branch of {r} already holds a doplan plan (another document, or someone else’s publication). It stays as it is: the site goes into a separate public repository {s}.',
  'В репозитории {r} уже есть ветка gh-pages, которую сделал не doplan. Её не тронем: сайт пойдёт в отдельный публичный репозиторий {s}.':
    'Repository {r} already has a gh-pages branch doplan did not make. It stays as it is: the site goes into a separate public repository {s}.',
  'У репозитория {r} уже есть свой сайт GitHub Pages. Его не тронем: план пойдёт в отдельный публичный репозиторий {s}.':
    'Repository {r} already has a GitHub Pages site of its own. It stays as it is: the plan goes into a separate public repository {s}.',
  'Репозиторий {r} стал приватным, а на бесплатном тарифе GitHub Pages работает только у публичных. Как поступить?':
    'Repository {r} became private, and on the free GitHub plan Pages works only for public ones. What to do?',
  'Репозиторий {r} не найден на GitHub. План можно опубликовать в отдельный публичный репозиторий {s}.':
    'Repository {r} was not found on GitHub. The plan can be published into a separate public repository {s}.',
  'Показать подложку': 'Include the underlay',
  'Кнопка «Скачать план (.doplan)» на сайте': 'A “Download the plan (.doplan)” button on the site',
  'Посетитель скачает план одной кнопкой и откроет его в doplan.': 'A visitor downloads the plan with one click and opens it in doplan.',
  'Сам план (стены, размеры, мебель, материалы и скрытые объекты) в любом случае лежит на сайте открытым файлом, его можно сохранить и без кнопки. Цен и заметок в нём нет.':
    'The plan itself (walls, sizes, furniture, materials and hidden objects) is on the site as an open file either way and can be saved without the button. It has no prices or notes.',
  'Подложка — это скан или фото исходного плана. На планах БТИ часто есть адрес, кадастровый номер и имена: всё это увидят все, у кого есть ссылка.':
    'The underlay is a scan or photo of the source plan. BTI plans often show the address, the cadastral number and names: everyone with the link sees all of it.',
  'Скрытые подложки, карандашные пометки, цены и заметки не публикуются.': 'Hidden underlays, pencil marks, prices and notes are not published.',
  'Репозиторий {r} останется — удалить его можно на GitHub.': 'Repository {r} stays; you can delete it on GitHub.',
  Снять: 'Unpublish',
  'Снято с публикации': 'Unpublished',
  'Публикация доступна в настольном приложении.': 'Publishing works in the desktop app.',
})

/** catalogue entries every viewer has as they are (not overridden by a pack or the library) */
function builtinIds(): Set<string> {
  const cat = uiStore.getState().catalog
  const ids = new Set<string>()
  const b = builtinCatalog()
  const same = (list: { id: string }[], e: { id: string }) => {
    const cur = list.find((x) => x.id === e.id)
    return !!cur && (cur === e || JSON.stringify(cur) === JSON.stringify(e))
  }
  for (const e of b.materials) if (same(cat.materials, e)) ids.add(e.id)
  for (const e of b.assets) if (same(cat.assets, e)) ids.add(e.id)
  return ids
}

type CatalogKind = 'asset' | 'material' | 'hdri'

/** not-downloaded entries by their catalogue kind and the name the user sees there */
function remoteEntries(ids: string[], catalog: Catalog, lang: 'ru' | 'en'): { id: string; kind: CatalogKind; name: string }[] {
  return ids.map((id) => {
    const a = catalog.assets.find((e) => e.id === id)
    if (a) return { id, kind: 'asset', name: displayName(a, lang) }
    const m = catalog.materials.find((e) => e.id === id)
    if (m) return { id, kind: 'material', name: displayName(m, lang) }
    return { id, kind: 'hdri', name: displayName(catalog.hdris.find((e) => e.id === id), lang) }
  })
}

const mb = (b: number) => (b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

function Note({ kind = 'info', children }: { kind?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={
        kind === 'warn'
          ? 'flex gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 leading-relaxed'
          : 'flex gap-2 rounded-md border border-[var(--border)] bg-[var(--input)] p-2.5 leading-relaxed'
      }
    >
      {kind === 'warn' && <TriangleExclamationPoint size={14} className="mt-px shrink-0 text-[var(--warning)]" />}
      <div className="min-w-0 break-words">{children}</div>
    </div>
  )
}

function Choice({ checked, onSelect, title, children }: { checked: boolean; onSelect(): void; title: string; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] p-2.5 hover:bg-[var(--hover)]">
      <input type="radio" className="mt-0.5" checked={checked} onChange={onSelect} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-[var(--muted)]">{children}</span>
      </span>
    </label>
  )
}

export function PublishDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const doc = useDoc((s) => s.doc)
  const filePath = useDoc((s) => s.filePath)
  // a new load (another project, a reload, a version) asks main again
  const loadId = useDoc((s) => s.loadId)
  const [status, setStatus] = useState<PagesStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<PagesProgress['step'] | 'unpublish' | 'download' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PagesPublishResult | null>(null)
  const [choice, setChoice] = useState<PagesPrivateChoice>('separate')
  const [underlays, setUnderlays] = useState(false)
  const [download, setDownload] = useState(false)

  const keys = publicationKeys(doc.meta, filePath)
  const key = keys.key
  // older keys: the file key before the first save, also when that save moved the file (store/pagesKeys)
  const aliasKey = [...keys.aliases, ...(open ? movedKeys(doc.meta.id) : [])].filter((a, i, all) => a !== key && all.indexOf(a) === i).join('|')
  const aliases = useMemo(() => (aliasKey ? aliasKey.split('|') : []), [aliasKey])
  const fileRef = useMemo(() => (filePath ? { path: filePath, created: keys.created } : undefined), [filePath, keys.created])
  const underlayCount = visibleUnderlayCount(doc)
  const withUnderlays = underlays && underlayCount > 0
  const shown = useMemo(() => viewDoc(doc, { underlays: withUnderlays }), [doc, withUnderlays])
  const hash = useMemo(() => docContentHash(shown), [shown])
  // a model downloaded meanwhile (here or in the catalogue) goes on the site at once
  const catalog = useUi((s) => s.catalog)
  const lang = useLang()
  const content = useMemo(() => (open ? planSite(shown, catalog, builtinIds()) : null), [open, shown, catalog])
  const remote = useMemo(() => (content ? remoteEntries(content.notDownloaded, catalog, lang) : []), [content, catalog, lang])
  const names = (list: { name: string }[]) =>
    list.length > 8 ? t('{list} и ещё {n}', { list: list.slice(0, 8).map((e) => e.name).join(', '), n: list.length - 8 }) : list.map((e) => e.name).join(', ')

  const refresh = useCallback(
    async (fresh = false) => {
      // the project generation the answer is for: one about a project no longer open is dropped
      const gen = generation()
      setLoading(true)
      setError(null)
      try {
        const st = await api.pages.status({ docId: key, aliases, contentHash: hash, name: doc.meta.name, fresh, root: gen.root, ...(fileRef ? { file: fileRef } : {}) })
        if (isCurrentGeneration(gen)) setStatus(st)
      } catch (e) {
        if (isCurrentGeneration(gen)) setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    // loadId: a new load is asked about again
    [key, aliases, hash, doc.meta.name, fileRef, loadId],
  )

  useEffect(() => {
    if (open) void refresh()
    else setResult(null)
  }, [open, refresh])

  useEffect(() => (busy ? api.pages.onProgress((p) => setBusy(p.step)) : undefined), [busy])

  const ghReady = !!status && status.gh.installed && status.gh.loggedIn && status.git
  const record = status?.record ?? null
  const project = status?.project ?? null
  const projectUsable = !!project && project.exists && !project.occupied
  const separateRef = `${status?.gh.user ?? '…'}/${status?.separateName ?? ''}`
  const recordTarget = status?.recordTarget ?? null
  // the project repository of a publication turned private on a free plan, or is gone
  const recordStuck = !!record && !record.separate && !!recordTarget && (recordTarget.needsChoice || !recordTarget.exists)
  const choiceRef = recordStuck ? recordTarget?.ref : project?.ref
  const recordUnderlays = record?.underlays ?? false
  const recordDownload = record?.download ?? false

  useEffect(() => {
    if (open) setUnderlays(recordUnderlays)
  }, [open, recordUnderlays])
  useEffect(() => {
    if (open) setDownload(recordDownload)
  }, [open, recordDownload])

  const publish = async (built: SiteContent | null = content) => {
    if (!built || !status) return
    // what main publishes is this project's plan: an answer after another one opened is not shown on it
    const gen = generation()
    const target = record ? (record.separate ? 'separate' : 'project') : projectUsable ? 'project' : 'separate'
    const privateChoice: PagesPrivateChoice | undefined = recordStuck
      ? recordTarget?.exists
        ? choice
        : 'separate'
      : !record && target === 'project' && project?.needsChoice
        ? choice
        : undefined
    if (privateChoice === 'makePublic') {
      const r = `${choiceRef?.owner}/${choiceRef?.repo}`
      const ok = await confirmDialog(
        t('Сделать {r} публичным?', { r }),
        t('Все файлы проекта и вся история его версий станут видны всем в интернете. Вернуть приватность можно в настройках репозитория на GitHub, но копии могут остаться у других.'),
        { ok: t('Сделать публичным'), cancel: t('Отмена'), danger: true },
      )
      if (!ok || !isCurrentGeneration(gen)) return
    }
    setBusy('build')
    setError(null)
    setResult(null)
    try {
      const res = await api.pages.publish({
        docId: key,
        content: built,
        info: { title: doc.meta.name, publishedAt: new Date().toISOString(), contentHash: hash, app: `doplan ${api.version}`, ...(download ? { download: true } : {}) },
        target: privateChoice === 'separate' ? 'separate' : target,
        ...(privateChoice ? { privateChoice } : {}),
        aliases,
        underlays: withUnderlays,
        root: gen.root,
        ...(fileRef ? { file: fileRef } : {}),
      })
      if (!isCurrentGeneration(gen)) return
      setResult(res)
      await refresh()
    } catch (e) {
      if (isCurrentGeneration(gen)) setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** downloads what the plan uses from the catalogue and is not on this computer, then publishes again */
  const downloadAndPublish = async () => {
    if (!remote.length) return
    const gen = generation()
    setBusy('download')
    setError(null)
    try {
      for (const e of remote) await downloadEntry(e.kind, e.id)
    } finally {
      setBusy(null)
    }
    if (!isCurrentGeneration(gen)) return
    const built = planSite(shown, uiStore.getState().catalog, builtinIds())
    if (built.notDownloaded.length) {
      const failed = remoteEntries(built.notDownloaded, uiStore.getState().catalog, lang)
      const why = failed.map((e) => useDownloads.getState().errors[e.id]).find(Boolean)
      setError([t('Не удалось скачать: {list}.', { list: names(failed) }), why].filter(Boolean).join(' '))
      return
    }
    await publish(built)
  }

  const unpublish = async () => {
    if (!record) return
    const r = `${record.owner}/${record.repo}`
    const lines = record.separate
      ? [t('Сайт перестанет открываться по ссылке, а файлы плана будут убраны из репозитория {r}.', { r }), t('Репозиторий {r} останется — удалить его можно на GitHub.', { r })]
      : [t('Сайт перестанет открываться по ссылке. Ветка gh-pages, созданная doplan, будет удалена.')]
    if (!(await confirmDialog(t('Снять план с публикации?'), lines.join('\n'), { ok: t('Снять'), cancel: t('Отмена'), danger: true }))) return
    setBusy('unpublish')
    setError(null)
    try {
      await api.pages.unpublish(key)
      setResult(null)
      toast(t('Снято с публикации'), 'success')
      await refresh()
    } catch (e) {
      // the record may be gone even so (no write access to the repository)
      await refresh()
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast(t('Ссылка скопирована'), 'success', 2000)
    } catch {
      /* clipboard refused */
    }
  }

  const stepText: Record<string, string> = {
    build: t('Собираю сайт…'),
    repo: t('Готовлю репозиторий…'),
    push: t('Отправляю на GitHub…'),
    pages: t('Включаю GitHub Pages…'),
    done: t('Готово'),
    unpublish: t('Снять с публикации'),
    download: t('Скачиваю недостающее…'),
  }

  const desktop = typeof window !== 'undefined' && !!(window as { doplan?: unknown }).doplan

  return (
    <Dialog
      open={open}
      onClose={onClose}
      modalLock={!!busy}
      title={t('Опубликовать для просмотра')}
      width="max-w-lg"
      footer={
        <>
          {record && ghReady && (
            <Button variant="ghost" disabled={!!busy} onClick={() => void unpublish()}>
              {t('Снять с публикации')}
            </Button>
          )}
          <div className="flex-1" />
          <Button disabled={!!busy} onClick={onClose}>
            {t('Закрыть')}
          </Button>
          {ghReady && (
            <Button variant="primary" icon={record ? <RefreshCw size={12} /> : <Globe size={12} />} disabled={!!busy || loading || !content} onClick={() => void publish()}>
              {record ? t('Обновить') : t('Опубликовать')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        {!desktop && <Note kind="warn">{t('Публикация доступна в настольном приложении.')}</Note>}

        {loading && !status && (
          <div className="flex items-center gap-2 text-[var(--muted)]">
            <Spinner /> {t('Проверяю GitHub…')}
          </div>
        )}

        {status && !ghReady && (
          <Note kind="warn">
            <div className="flex flex-col gap-2">
              {!status.gh.installed && <span>{t('Нужна программа GitHub CLI (gh): установите её (https://cli.github.com) и войдите командой «gh auth login».')}</span>}
              {status.gh.installed && !status.gh.loggedIn && <span>{t('Войдите в GitHub: выполните в терминале «gh auth login».')}</span>}
              {!status.git && <span>{t('Нужен Git (https://git-scm.com).')}</span>}
              <div>
                <Button size="sm" icon={<RefreshCw size={12} />} disabled={loading} onClick={() => void refresh(true)}>
                  {t('Проверить снова')}
                </Button>
              </div>
            </div>
          </Note>
        )}

        {record && (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
            <div className="text-[11px] font-semibold tracking-wide text-[var(--muted)] uppercase">{t('Ссылка на просмотр')}</div>
            <div className="flex items-center gap-2">
              <input readOnly value={record.url} className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--input)] px-2 py-1 font-mono text-[11px] select-all" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" icon={<Copy size={12} />} onClick={() => void copy(record.url)}>
                {t('Скопировать')}
              </Button>
              <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => void api.pages.openUrl(record.url)}>
                {t('Открыть')}
              </Button>
            </div>
            {status?.outdated ? (
              <div className="flex items-center gap-1.5 text-[var(--warning)]">
                <TriangleExclamationPoint size={13} /> {t('Устарело: план изменился после публикации')}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[var(--success)]">
                <Check size={13} /> {t('Опубликовано {d}', { d: new Date(record.publishedAt).toLocaleString() })}
              </div>
            )}
            <div className="text-[var(--muted)]">
              {record.separate
                ? t('Отдельный публичный репозиторий {r} — только сайт, без файлов проекта.', { r: `${record.owner}/${record.repo}` })
                : t('Ветка gh-pages репозитория {r} (одним коммитом, история проекта не меняется).', { r: `${record.owner}/${record.repo}` })}
            </div>
          </div>
        )}

        {recordStuck && ghReady && recordTarget && (
          <div className="flex flex-col gap-2">
            {recordTarget.exists ? (
              <>
                <div>{t('Репозиторий {r} стал приватным, а на бесплатном тарифе GitHub Pages работает только у публичных. Как поступить?', { r: `${recordTarget.ref.owner}/${recordTarget.ref.repo}` })}</div>
                <Choice checked={choice === 'separate'} onSelect={() => setChoice('separate')} title={t('Отдельный публичный репозиторий')}>
                  {t('Будет создан {r}: в нём только сайт для просмотра, сам проект останется приватным.', { r: `${status?.gh.user ?? '…'}/${recordTarget.ref.repo}-view` })}
                </Choice>
                <Choice checked={choice === 'makePublic'} onSelect={() => setChoice('makePublic')} title={t('Сделать репозиторий проекта публичным')}>
                  {t('Все файлы проекта и вся его история станут видны всем.')}
                </Choice>
              </>
            ) : (
              <Note kind="warn">
                {t('Репозиторий {r} не найден на GitHub. План можно опубликовать в отдельный публичный репозиторий {s}.', {
                  r: `${recordTarget.ref.owner}/${recordTarget.ref.repo}`,
                  s: `${status?.gh.user ?? '…'}/${recordTarget.ref.repo}-view`,
                })}
              </Note>
            )}
          </div>
        )}

        {!record && ghReady && status && (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold tracking-wide text-[var(--muted)] uppercase">{t('Где будет сайт')}</div>
            {project?.occupied && (
              <Note kind="warn">
                {project.occupied === 'plan'
                  ? t('В ветке gh-pages репозитория {r} уже опубликован план doplan (другой документ или чужая публикация). Её не тронем: сайт пойдёт в отдельный публичный репозиторий {s}.', { r: `${project.ref.owner}/${project.ref.repo}`, s: separateRef })
                  : project.occupied === 'branch'
                  ? t('В репозитории {r} уже есть ветка gh-pages, которую сделал не doplan. Её не тронем: сайт пойдёт в отдельный публичный репозиторий {s}.', { r: `${project.ref.owner}/${project.ref.repo}`, s: separateRef })
                  : t('У репозитория {r} уже есть свой сайт GitHub Pages. Его не тронем: план пойдёт в отдельный публичный репозиторий {s}.', { r: `${project.ref.owner}/${project.ref.repo}`, s: separateRef })}
              </Note>
            )}
            {projectUsable && project && !project.needsChoice && (
              <div>{t('Ветка gh-pages репозитория {r} (одним коммитом, история проекта не меняется).', { r: `${project.ref.owner}/${project.ref.repo}` })}</div>
            )}
            {projectUsable && project?.needsChoice && (
              <>
                <div>{t('Репозиторий проекта {r} приватный, а на бесплатном тарифе GitHub Pages работает только у публичных. Как поступить?', { r: `${project.ref.owner}/${project.ref.repo}` })}</div>
                <Choice checked={choice === 'separate'} onSelect={() => setChoice('separate')} title={t('Отдельный публичный репозиторий')}>
                  {t('Будет создан {r}: в нём только сайт для просмотра, сам проект останется приватным.', { r: separateRef })}
                </Choice>
                <Choice checked={choice === 'makePublic'} onSelect={() => setChoice('makePublic')} title={t('Сделать репозиторий проекта публичным')}>
                  {t('Все файлы проекта и вся его история станут видны всем.')}
                </Choice>
              </>
            )}
            {!projectUsable && !project?.occupied && <div>{t('У проекта нет репозитория на GitHub, поэтому сайт пойдёт в отдельный публичный репозиторий {r}.', { r: separateRef })}</div>}
          </div>
        )}

        {ghReady && content && (
          <>
            <div className="text-[var(--muted)]">{t('В плане {n} файлов моделей и текстур.', { n: content.files.length })}</div>
            {underlayCount > 0 && (
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={underlays} disabled={!!busy} onChange={(e) => setUnderlays(e.currentTarget.checked)} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{t('Показать подложку')}</span>
                  {underlays && <span className="text-[var(--warning)]">{t('Подложка — это скан или фото исходного плана. На планах БТИ часто есть адрес, кадастровый номер и имена: всё это увидят все, у кого есть ссылка.')}</span>}
                </span>
              </label>
            )}
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={download} disabled={!!busy} onChange={(e) => setDownload(e.currentTarget.checked)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{t('Кнопка «Скачать план (.doplan)» на сайте')}</span>
                {download && <span className="text-[var(--muted)]">{t('Посетитель скачает план одной кнопкой и откроет его в doplan.')}</span>}
                {/* the viewer needs the document: unticked hides the button, not the plan */}
                <span className="text-[var(--warning)]">{t('Сам план (стены, размеры, мебель, материалы и скрытые объекты) в любом случае лежит на сайте открытым файлом, его можно сохранить и без кнопки. Цен и заметок в нём нет.')}</span>
              </span>
            </label>
            <div className="text-[var(--muted)]">{t('Скрытые подложки, карандашные пометки, цены и заметки не публикуются.')}</div>
            {remote.length > 0 && (
              <Note kind="warn">
                <div className="flex flex-col items-start gap-2">
                  <span>{t('Не скачаны из каталога, поэтому на сайте вместо них будут пустые места: {list}.', { list: names(remote) })}</span>
                  <Button icon={<Download size={12} />} disabled={!!busy || loading} onClick={() => void downloadAndPublish()}>
                    {record ? t('Скачать и обновить') : t('Скачать и опубликовать')}
                  </Button>
                </div>
              </Note>
            )}
            <Note kind="warn">
              {t('Сайт будет открыт всем, у кого есть ссылка, и может попасть в поисковики. Не публикуйте личные данные (адрес, имена, фото жильцов).')}
            </Note>
          </>
        )}

        {busy && (
          <div className="flex items-center gap-2">
            <Spinner className="text-[var(--accent)]" /> {stepText[busy]}
          </div>
        )}

        {result && !busy && (
          <Note>
            <div className="flex flex-col gap-1">
              <span>{t('Опубликовано: {size}, {n} файлов. Сайт откроется через 1–2 минуты.', { size: mb(result.bytes), n: result.files })}</span>
              {result.missing.length > 0 && <span className="text-[var(--warning)]">{t('Файлы не найдены и пропущены: {list}', { list: result.missing.slice(0, 8).join(', ') })}</span>}
            </div>
          </Note>
        )}

        {error && <Note kind="warn">{error}</Note>}
      </div>
    </Dialog>
  )
}
