/**
 * «Технический проект»: the album of working drawings (титул, общие данные, обмер, демонтаж / монтаж,
 * мебель, полы, потолки, электрика, сантехника, тёплый пол, развёртки, спецификации, ведомость отделки).
 * Settings are kept in the project (`doc.techProject.album`); export is a multi-page PDF or one DXF per sheet.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, FileDown, FileText, Ruler } from 'lucide-react'
import {
  ALBUM_STAGES,
  type AlbumSettings,
  albumRooms,
  captureBaseline,
  composeAlbum,
  listVariants,
  mergeCatalog,
  pageDxf,
  pageFileName,
  pageSvg,
  readAlbumSettings,
  sheetInfo,
  stageName,
} from '@core'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { api } from '@/store/api'
import { confirmDialog, setProgress, toast } from '@/store/notify'
import { addTranslations, useT } from '@/i18n'
import { Button, Dialog, Input, Segmented, Select } from '@/ui/kit'
import { projectBaseName } from '@/actions/util'
import type { DialogPropsBase } from './BomDialog'
import { builtins, errorText, tx } from './common/catalog'

addTranslations('en', {
  'Технический проект': 'Technical project',
  'Технический проект…': 'Technical project…',
  'Технический проект (альбом рабочих чертежей)': 'Technical project (working drawing set)',
  'Формат': 'Format',
  'Ориентация': 'Orientation',
  'Альбомная': 'Landscape',
  'Книжная': 'Portrait',
  'Стадия': 'Stage',
  'Шифр': 'Code',
  'Объект': 'Object',
  'Дата': 'Date',
  'Организация': 'Organisation',
  'Разработал': 'Drawn by',
  'Проверил': 'Checked by',
  'Подписи в штампе': 'Title block signatures',
  'По умолчанию штамп без личных данных; заполните, если они нужны на листах.':
    'By default the title block carries no personal data; fill these in if the sheets need them.',
  'Листы': 'Sheets',
  'Этажи': 'Levels',
  'Развёртки помещений': 'Room elevations',
  'Обмер': 'Survey',
  'Обмер зафиксирован {date}': 'Survey fixed on {date}',
  'Обмер не зафиксирован: планы демонтажа и монтажа строятся относительно зафиксированного обмера.':
    'No survey fixed: the demolition and construction plans compare the plan with a fixed survey.',
  'Зафиксировать обмер': 'Fix the survey',
  'Обновить обмер': 'Re-fix the survey',
  'Снять фиксацию': 'Remove the survey',
  'Зафиксировать текущий план как обмер?': 'Fix the current plan as the survey?',
  'Стены и проёмы плана сейчас станут исходным состоянием «до ремонта»; демонтаж и монтаж считаются относительно него.':
    'The current walls and openings become the «before renovation» state; demolition and construction are measured against it.',
  'Зафиксированный обмер будет заменён текущим планом.': 'The fixed survey will be replaced by the current plan.',
  'Снять фиксацию обмера?': 'Remove the fixed survey?',
  'Планы демонтажа и монтажа станут пустыми.': 'The demolition and construction plans will be empty.',
  'Настройки техпроекта': 'Technical project settings',
  'Фиксация обмера': 'Fix survey',
  'авто': 'auto',
  'Масштаб листа': 'Sheet scale',
  'Выше': 'Up',
  'Ниже': 'Down',
  'нет данных': 'no data',
  'Лист {n} из {total}': 'Sheet {n} of {total}',
  'Нет выбранных листов': 'No sheets selected',
  'DXF по листам': 'DXF per sheet',
  'Папка для DXF-файлов листов': 'Folder for the sheet DXF files',
  'Сохранено листов: {n}': 'Sheets saved: {n}',
  'Сборка PDF…': 'Building the PDF…',
  'Вариант обстановки': 'Furnishing variant',
  'Эскизный проект': 'Sketch design',
  'Проект': 'Design',
  'Рабочий проект': 'Working design',
  'Рабочая документация': 'Working drawings',
  // sheet names (the sheets themselves are drawn in Russian)
  'Титульный лист': 'Title page',
  'Общие данные': 'General data',
  'Обмерный план': 'Survey plan',
  'План демонтажа': 'Demolition plan',
  'План монтажа перегородок': 'Partition construction plan',
  'План расстановки мебели': 'Furniture layout',
  'План полов': 'Floor plan',
  'План потолков': 'Ceiling plan',
  'План освещения и выключателей': 'Lighting and switches',
  'План розеток и выводов': 'Sockets and outlets',
  'План сантехники': 'Plumbing plan',
  'План тёплого пола': 'Underfloor heating plan',
  'Развёртки стен': 'Wall elevations',
  'Спецификация дверей и окон': 'Door and window schedule',
  'Спецификация сантехники': 'Plumbing schedule',
  'Спецификация светильников': 'Lighting schedule',
  'Ведомость отделки помещений': 'Room finish schedule',
})

const todayIso = () => new Date().toISOString().slice(0, 10)

/** a text field that writes to the project on Enter / blur, not on every keystroke */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit(v: string): void; placeholder?: string; type?: string; 'aria-label'?: string; className?: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <Input value={v} onChange={setV} onCommit={(x) => x !== value && onCommit(x)} {...rest} />
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-[var(--muted)]">
      {label}
      {children}
    </label>
  )
}

/** the page as an image (blob URL: every page's SVG keeps its own hatch ids) */
function PagePreview({ svg, alt }: { svg: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [svg])
  if (!url) return null
  return <img src={url} alt={alt} className="h-full w-full object-contain" draggable={false} />
}

export function TechProjectDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const doc = useDoc((s) => s.doc)
  const userCatalog = useUi((s) => s.catalog)
  const cat = useMemo(() => mergeCatalog(builtins(), userCatalog), [userCatalog])
  const raw = doc.techProject?.album
  const settings = useMemo(() => readAlbumSettings(doc, raw, { catalog: cat }), [doc, raw, cat])
  const [pick, setPick] = useState(0)
  const [status, setStatus] = useState('')

  const { album, error } = useMemo(() => {
    try {
      return { album: composeAlbum(doc, settings, { catalog: cat }), error: '' }
    } catch (e) {
      return { album: null, error: errorText(e) }
    }
  }, [doc, settings, cat])
  const pages = album?.pages ?? []
  const page = pages[Math.min(pick, pages.length - 1)]
  const preview = useMemo(() => (album && page ? pageSvg(album, page).svg : ''), [album, page])
  const rooms = useMemo(() => albumRooms(doc, settings, cat), [doc, settings, cat])
  const variants = useMemo(() => listVariants(doc), [doc])
  const baseline = doc.techProject?.baseline

  /** saves the settings in the project; the date and the object stay «live» until edited */
  const update = (patch: Partial<AlbumSettings>) => {
    const next: Partial<AlbumSettings> = { ...settings, ...patch }
    const prev = (raw ?? {}) as Partial<AlbumSettings>
    if (!('date' in patch) && prev.date === undefined && next.date === todayIso()) delete next.date
    if (!('object' in patch) && prev.object === undefined && next.object === doc.meta.name) delete next.object
    tx(
      'Настройки техпроекта',
      (d) => {
        ;(d.techProject ??= {}).album = JSON.parse(JSON.stringify(next)) as Record<string, unknown>
      },
      'techproject.album',
    )
  }

  const setSheet = (i: number, patch: Partial<AlbumSettings['sheets'][number]>) =>
    update({ sheets: settings.sheets.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const moveSheet = (i: number, dir: -1 | 1) => {
    const list = [...settings.sheets]
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    update({ sheets: list })
  }

  const fixBaseline = async () => {
    const ok = await confirmDialog(
      t('Зафиксировать текущий план как обмер?'),
      baseline
        ? t('Зафиксированный обмер будет заменён текущим планом.')
        : t('Стены и проёмы плана сейчас станут исходным состоянием «до ремонта»; демонтаж и монтаж считаются относительно него.'),
    )
    if (!ok) return
    tx('Фиксация обмера', (d) => {
      ;(d.techProject ??= {}).baseline = captureBaseline(d)
    })
  }
  const dropBaseline = async () => {
    if (!(await confirmDialog(t('Снять фиксацию обмера?'), t('Планы демонтажа и монтажа станут пустыми.')))) return
    tx('Фиксация обмера', (d) => {
      if (!d.techProject) return
      delete d.techProject.baseline
      if (!Object.keys(d.techProject).length) delete d.techProject
    })
  }

  const baseName = `${projectBaseName()} — ${t('Технический проект').toLowerCase()}`

  const exportPdf = async () => {
    if (!album || !pages.length) return
    setProgress({ label: t('Сборка PDF…'), value: null })
    try {
      const saved = await api.files.exportPdf(
        pages.map((p) => pageSvg(album, p).svg),
        { widthMm: album.paper.width, heightMm: album.paper.height, defaultName: `${baseName}.pdf` },
      )
      if (saved) {
        setStatus(saved)
        toast(t('Экспортировано: {file}', { file: saved.split(/[\\/]/).pop() ?? saved }), 'success')
      }
    } catch (e) {
      setStatus(errorText(e))
    } finally {
      setProgress(null)
    }
  }

  const exportDxf = async () => {
    if (!album || !pages.length) return
    try {
      const files = pages.map((p) => ({ name: `${pageFileName(p, pages.length)}.dxf`, content: pageDxf(album, p) }))
      const dir = await api.files.saveTextFiles(t('Папка для DXF-файлов листов'), files)
      if (dir) setStatus(`${t('Сохранено листов: {n}', { n: files.length })} — ${dir}`)
    } catch (e) {
      setStatus(errorText(e))
    }
  }

  const elevationsOn = settings.sheets.some((s) => s.kind === 'elevations' && s.on)
  const stageOptions = ALBUM_STAGES.map((s) => ({ value: s, label: `${s} — ${t(stageName(s))}` }))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Технический проект (альбом рабочих чертежей)')}
      width="max-w-6xl"
      resizeKey="dialog.techProject"
      resizeLabel={t('Размер окна')}
      footer={
        <>
          {status && <span className="mr-auto truncate text-[10px] text-[var(--muted)]">{status}</span>}
          <Button variant="ghost" onClick={onClose}>
            {t('Закрыть')}
          </Button>
          <Button variant="ghost" icon={<FileDown className="size-3.5" />} disabled={!pages.length} onClick={() => void exportDxf()}>
            {t('DXF по листам')}
          </Button>
          <Button variant="primary" icon={<FileText className="size-3.5" />} disabled={!pages.length} onClick={() => void exportPdf()}>
            PDF
          </Button>
        </>
      }
    >
      <div className="flex min-h-[520px] gap-3">
        {/* settings */}
        <div className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto pr-1 text-[11px]">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('Формат')}>
              <Segmented
                value={settings.format}
                options={(['A4', 'A3', 'A2'] as const).map((f) => ({ value: f, label: f.replace('A', 'А') }))}
                onChange={(format) => update({ format })}
                aria-label={t('Формат')}
              />
            </Field>
            <Field label={t('Ориентация')}>
              <Select
                value={settings.orientation}
                options={[
                  { value: 'landscape', label: t('Альбомная') },
                  { value: 'portrait', label: t('Книжная') },
                ]}
                onChange={(orientation) => update({ orientation })}
                aria-label={t('Ориентация')}
              />
            </Field>
            <Field label={t('Стадия')}>
              <Select value={settings.stage} options={stageOptions} onChange={(stage) => update({ stage })} aria-label={t('Стадия')} />
            </Field>
            <Field label={t('Шифр')}>
              <CommitInput value={settings.code} onCommit={(code) => update({ code })} aria-label={t('Шифр')} />
            </Field>
          </div>
          <Field label={t('Объект')}>
            <CommitInput value={settings.object ?? ''} onCommit={(object) => update({ object })} placeholder={doc.meta.name} aria-label={t('Объект')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('Дата')}>
              <CommitInput type="date" value={settings.date ?? ''} onCommit={(date) => update({ date })} aria-label={t('Дата')} />
            </Field>
            {variants.length > 1 && (
              <Field label={t('Вариант обстановки')}>
                <Select
                  value={settings.variantId ?? variants.find((v) => v.active)!.id}
                  options={variants.map((v) => ({ value: v.id, label: t(v.name) }))}
                  onChange={(variantId) => update({ variantId })}
                  aria-label={t('Вариант обстановки')}
                />
              </Field>
            )}
          </div>
          <details className="rounded border border-[var(--border)] px-2 py-1">
            <summary className="cursor-pointer select-none">{t('Подписи в штампе')}</summary>
            <div className="mt-1.5 flex flex-col gap-1.5">
              <p className="text-[10px] text-[var(--muted)]">{t('По умолчанию штамп без личных данных; заполните, если они нужны на листах.')}</p>
              <Field label={t('Организация')}>
                <CommitInput value={settings.organization ?? ''} onCommit={(organization) => update({ organization })} aria-label={t('Организация')} />
              </Field>
              <Field label={t('Разработал')}>
                <CommitInput value={settings.author ?? ''} onCommit={(author) => update({ author })} aria-label={t('Разработал')} />
              </Field>
              <Field label={t('Проверил')}>
                <CommitInput value={settings.checker ?? ''} onCommit={(checker) => update({ checker })} aria-label={t('Проверил')} />
              </Field>
            </div>
          </details>

          <section className="flex flex-col gap-1 rounded border border-[var(--border)] p-2">
            <div className="flex items-center gap-1.5 font-semibold">
              <Ruler className="size-3.5" />
              {t('Обмер')}
            </div>
            <p className="text-[10px] text-[var(--muted)]">
              {baseline
                ? t('Обмер зафиксирован {date}', { date: baseline.takenAt.slice(0, 10) })
                : t('Обмер не зафиксирован: планы демонтажа и монтажа строятся относительно зафиксированного обмера.')}
            </p>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void fixBaseline()}>
                {baseline ? t('Обновить обмер') : t('Зафиксировать обмер')}
              </Button>
              {baseline && (
                <Button size="sm" variant="ghost" onClick={() => void dropBaseline()}>
                  {t('Снять фиксацию')}
                </Button>
              )}
            </div>
          </section>

          {doc.levelOrder.length > 1 && (
            <section className="flex flex-col gap-0.5">
              <div className="font-semibold">{t('Этажи')}</div>
              {doc.levelOrder.map((id) => {
                const on = !settings.levels?.length || settings.levels.includes(id)
                return (
                  <label key={id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const cur = settings.levels?.length ? settings.levels : doc.levelOrder
                        const next = e.currentTarget.checked ? doc.levelOrder.filter((x) => x === id || cur.includes(x)) : cur.filter((x) => x !== id)
                        if (next.length) update({ levels: next.length === doc.levelOrder.length ? undefined : next })
                      }}
                    />
                    {doc.levels[id]?.name}
                  </label>
                )
              })}
            </section>
          )}

          <section className="flex flex-col gap-0.5">
            <div className="font-semibold">{t('Листы')}</div>
            {settings.sheets.map((s, i) => {
              const info = sheetInfo(s.kind)
              return (
                <div key={s.kind} className="group flex items-center gap-1" title={t(info.description)}>
                  <label className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input type="checkbox" checked={s.on} onChange={(e) => setSheet(i, { on: e.currentTarget.checked })} />
                    <span className={s.on ? 'truncate' : 'truncate text-[var(--muted)]'}>{t(info.title)}</span>
                  </label>
                  {info.scales.length > 0 && s.on && (
                    <select
                      className="h-5 rounded border border-[var(--border)] bg-transparent px-0.5 text-[10px]"
                      value={s.scale ?? ''}
                      aria-label={`${t('Масштаб листа')}: ${t(info.title)}`}
                      onChange={(e) => setSheet(i, { scale: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })}
                    >
                      <option value="">{t('авто')}</option>
                      {info.scales.map((sc) => (
                        <option key={sc} value={sc}>
                          1:{sc}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="opacity-40 hover:opacity-100 disabled:invisible" disabled={i === 0} onClick={() => moveSheet(i, -1)} aria-label={t('Выше')}>
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="opacity-40 hover:opacity-100 disabled:invisible"
                    disabled={i === settings.sheets.length - 1}
                    onClick={() => moveSheet(i, 1)}
                    aria-label={t('Ниже')}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </div>
              )
            })}
          </section>

          {elevationsOn && rooms.length > 0 && (
            <section className="flex flex-col gap-0.5">
              <div className="font-semibold">{t('Развёртки помещений')}</div>
              {rooms.map((r) => (
                <label key={r.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={r.elevations}
                    onChange={(e) => {
                      const cur = rooms.filter((x) => x.elevations).map((x) => x.id)
                      update({ elevationRooms: e.currentTarget.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id) })
                    }}
                  />
                  {r.name}
                  {doc.levelOrder.length > 1 && <span className="text-[var(--muted)]">· {doc.levels[r.levelId]?.name}</span>}
                </label>
              ))}
            </section>
          )}
        </div>

        {/* sheet list */}
        <div className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-x border-[var(--border)] px-2 text-[11px]">
          {error && <p className="text-[#ff8589]">{error}</p>}
          {!error && !pages.length && <p className="py-4 text-center text-[var(--muted)]">{t('Нет выбранных листов')}</p>}
          {pages.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPick(i)}
              className={`flex items-baseline gap-1.5 rounded px-1.5 py-1 text-left ${p === page ? 'bg-[var(--active,rgba(127,127,127,.18))]' : 'hover:bg-[var(--hover,rgba(127,127,127,.1))]'}`}
            >
              <span className="w-5 shrink-0 text-right tabular-nums text-[var(--muted)]">{p.no}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.title}</span>
                {(p.scale > 1 || p.empty) && (
                  <span className="block text-[10px] text-[var(--muted)]">
                    {p.scale > 1 ? `М 1:${p.scale}` : ''}
                    {p.empty ? `${p.scale > 1 ? ' · ' : ''}${t('нет данных')}` : ''}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {/* preview */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="min-h-0 flex-1 rounded border border-[var(--border)] bg-white p-1">
            {preview && page && <PagePreview svg={preview} alt={`${page.no}. ${page.title}`} />}
          </div>
          {page && (
            <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
              <span className="truncate">{page.empty ?? ''}</span>
              <span>{t('Лист {n} из {total}', { n: page.no, total: pages.length })}</span>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
