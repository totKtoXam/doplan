import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardPaste, FileUp, FolderOpen, ImageUp, Save, Sparkles, TriangleExclamationPoint } from 'lucide-react'
import { parsePlanSpec, validatePlanSpec } from '@core'
import { actions } from '@/actions'
import { dialogStore } from '@/store/dialogs'
import { useT } from '@/i18n'
import { Button, Dialog, Input, Row, Spinner, Tabs, cn } from '@/ui/kit'
import { errorText, extOf, mimeOf } from './common/catalog'
import type { DialogPropsBase } from './BomDialog'

type Issue = ReturnType<typeof validatePlanSpec>[number]
type Photo = { name: string; data: ArrayBuffer; mime: string; url: string; w: number; h: number }
type Tab = 'app' | 'skill'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
/** the Anthropic API accepts ≤ 5 MB per image and downsamples anything above ~1600 px anyway */
const MAX_EDGE = 2400
const MAX_BYTES = 4.5 * 1024 * 1024
const API_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось открыть изображение'))
    img.src = url
  })
}

/** shrinks/re-encodes the image when the API would reject it (size, dimensions or format) */
async function prepareForApi(p: Photo): Promise<{ data: ArrayBuffer; mime: string }> {
  const tooBig = p.data.byteLength > MAX_BYTES || Math.max(p.w, p.h) > MAX_EDGE
  if (!tooBig && API_MIME.has(p.mime)) return { data: p.data, mime: p.mime }
  const img = await loadImage(p.url)
  const k = Math.min(1, MAX_EDGE / Math.max(p.w, p.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(p.w * k))
  canvas.height = Math.max(1, Math.round(p.h * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) return { data: p.data, mime: p.mime }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
  if (!blob) return { data: p.data, mime: p.mime }
  return { data: await blob.arrayBuffer(), mime: 'image/jpeg' }
}

/** pulls the JSON object out of a model answer that may be wrapped in prose or ``` fences */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  const json = a >= 0 && b > a ? body.slice(a, b + 1) : body.trim()
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

interface Check {
  state: 'empty' | 'error' | 'ok'
  message: string
  issues: Issue[]
}

function check(text: string): Check {
  if (!text.trim()) return { state: 'empty', message: '', issues: [] }
  try {
    const spec = parsePlanSpec(JSON.parse(text))
    const issues = validatePlanSpec(spec)
    const hasError = issues.some((i) => i.severity === 'error')
    return { state: hasError ? 'error' : 'ok', message: '', issues }
  } catch (e) {
    return { state: 'error', message: errorText(e), issues: [] }
  }
}

const SEVERITY_CLS: Record<string, string> = {
  error: 'text-[#ff8589]',
  warning: 'text-[#f0b75a]',
  info: 'text-[var(--muted)]',
}

/** photo / scan of a floor plan → PlanSpec JSON (in-app via the Anthropic API or via the Claude Code skill) → plan */
export function PhotoPlanDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('app')
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [hint, setHint] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'recognise' | 'build' | null>(null)
  const [error, setError] = useState('')
  const [keySet, setKeySet] = useState<boolean | null>(null)

  const result = useMemo(() => check(text), [text])

  const loadPhoto = async (p: { name: string; data: ArrayBuffer; mime: string }) => {
    const url = URL.createObjectURL(new Blob([p.data], { type: p.mime }))
    try {
      const img = await loadImage(url)
      setPhoto((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return { ...p, url, w: img.naturalWidth, h: img.naturalHeight }
      })
    } catch (e) {
      URL.revokeObjectURL(url)
      setError(errorText(e))
    }
  }

  useEffect(() => {
    if (!open) return
    setError('')
    let alive = true
    window.doplan.settings
      .get()
      .then((s) => alive && setKeySet(s.anthropicApiKeySet))
      .catch(() => alive && setKeySet(false))
    const pending = dialogStore.getState().pendingPhoto
    if (pending) {
      dialogStore.getState().set({ pendingPhoto: null })
      void loadPhoto(pending)
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // revoke the preview URL of the current photo on unmount
  const photoUrl = useRef<string | null>(null)
  photoUrl.current = photo?.url ?? null
  useEffect(() => () => {
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current)
  }, [])

  const pickPhoto = async () => {
    setError('')
    try {
      const [f] = await window.doplan.files.pick([{ name: t('Изображения'), extensions: IMAGE_EXT }], false)
      if (!f) return
      const data = await window.doplan.files.read(f.path)
      await loadPhoto({ name: f.name, data, mime: mimeOf(extOf(f.name)) })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const recognise = async () => {
    if (!photo) return
    setBusy('recognise')
    setError('')
    try {
      const img = await prepareForApi(photo)
      const answer = await window.doplan.ai.planFromImage(img.data, img.mime, hint.trim() || undefined)
      setText(extractJson(answer))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const openSpec = async () => {
    setError('')
    try {
      const [f] = await window.doplan.files.pick([{ name: 'PlanSpec JSON', extensions: ['json'] }], false)
      if (f) setText(extractJson(await window.doplan.files.readText(f.path)))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const paste = async () => {
    setError('')
    try {
      const clip = await navigator.clipboard.readText()
      if (clip.trim()) setText(extractJson(clip))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const saveSpec = async () => {
    try {
      const base = photo ? photo.name.replace(/\.[^.]+$/, '') : 'plan'
      await window.doplan.files.saveText(`${base}.planspec.json`, [{ name: 'PlanSpec JSON', extensions: ['json'] }], text)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const build = async () => {
    setBusy('build')
    setError('')
    try {
      const ok = await actions.importPlanSpec(text)
      if (ok) onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const errors = result.issues.filter((i) => i.severity === 'error').length
  const warnings = result.issues.filter((i) => i.severity === 'warning').length

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('План по фото')}
      width="max-w-4xl"
      resizeKey="dialog.photoPlan"
      resizeLabel={t('Размер окна')}
      modalLock={busy !== null}
      footer={
        <>
          <span className="mr-auto text-[10px] text-[var(--muted)]">
            {result.state === 'ok' && t('PlanSpec корректен') + (warnings ? ` · ${t('предупреждений')}: ${warnings}` : '')}
            {result.state === 'error' && (result.message ? t('Ошибка в PlanSpec') : `${t('Ошибок')}: ${errors}`)}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t('Отмена')}
          </Button>
          <Button variant="primary" disabled={result.state !== 'ok'} loading={busy === 'build'} onClick={() => void build()}>
            {t('Построить план')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs<Tab>
          idBase="photo-plan"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'app', label: t('В приложении') },
            { id: 'skill', label: t('Через Claude Code') },
          ]}
        />
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-4">
          {/* left: source */}
          <div className="flex min-w-0 flex-col gap-2">
            {tab === 'app' ? (
              <>
                <button
                  type="button"
                  onClick={() => void pickPhoto()}
                  className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border border-dashed border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)]"
                  aria-label={photo ? t('Заменить изображение') : t('Выбрать изображение плана')}
                >
                  {photo ? (
                    <img src={photo.url} alt={photo.name} className="size-full object-contain" />
                  ) : (
                    <span className="flex flex-col items-center gap-2 text-[var(--muted)]">
                      <ImageUp className="size-8" />
                      {t('Выбрать фото или скан плана…')}
                    </span>
                  )}
                </button>
                {photo && (
                  <div className="truncate text-[10px] text-[var(--muted)]">
                    {photo.name} · {photo.w}×{photo.h}
                  </div>
                )}
                <Row label={t('Подсказка')} stacked>
                  <Input
                    value={hint}
                    onChange={setHint}
                    placeholder={t('например: потолки 2,7 м, вход снизу')}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </Row>
                {keySet === false && (
                  <div className="flex items-start gap-1.5 rounded-md border border-[var(--border)] p-2 text-[11px]">
                    <TriangleExclamationPoint className="mt-0.5 size-3.5 shrink-0 text-[#f0b75a]" aria-hidden />
                    <div className="flex flex-col gap-1">
                      <span>{t('Не задан API-ключ Anthropic. Добавьте его в настройках или воспользуйтесь Claude Code.')}</span>
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => dialogStore.getState().open('settings')}>
                          {t('Настройки')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setTab('skill')}>
                          {t('Через Claude Code')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                <Button
                  variant="primary"
                  icon={<Sparkles className="size-3.5" />}
                  disabled={!photo || keySet === false || busy !== null}
                  loading={busy === 'recognise'}
                  onClick={() => void recognise()}
                >
                  {busy === 'recognise' ? t('Распознаю… (до минуты)') : t('Распознать план')}
                </Button>
                <p className="text-[10px] leading-snug text-[var(--muted)]">
                  {t('Результат — черновик: проверьте размеры комнат и проёмы в JSON справа или уже на плане.')}
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-2 text-[11px] leading-relaxed">
                <p>{t('Точнее всего план распознаёт Claude Code с навыком photo-to-plan: он читает размеры с чертежа, проверяет площади и сверяет результат с исходником.')}</p>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>{t('Откройте папку проекта doplan в Claude Code.')}</li>
                  <li>
                    {t('Положите изображение плана в папку')} <code className="rounded bg-[var(--bg)] px-1">inbox/</code> {t('или просто вставьте его в чат.')}
                  </li>
                  <li>
                    {t('Попросите:')} <code className="rounded bg-[var(--bg)] px-1">/photo-to-plan inbox/plan.jpg</code> {t('или «нарисуй планировку по фото».')}
                  </li>
                  <li>
                    {t('Claude пишет PlanSpec и проверяет его командами')} <code className="rounded bg-[var(--bg)] px-1">pnpm dp</code>
                    {t(', затем собирает файл .doplan.')}
                  </li>
                  <li>{t('Откройте готовый .doplan или вставьте/откройте PlanSpec JSON справа и нажмите «Построить план».')}</li>
                </ol>
                <p className="text-[var(--muted)]">
                  {t('Подробности:')} <code className="rounded bg-[var(--bg)] px-1">.claude/skills/photo-to-plan/SKILL.md</code>,{' '}
                  <code className="rounded bg-[var(--bg)] px-1">docs/research/photo-to-plan.md</code>
                </p>
              </div>
            )}
          </div>

          {/* right: PlanSpec */}
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-1">
              <span className="mr-auto text-[11px] font-semibold">PlanSpec JSON</span>
              <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void openSpec()}>
                {t('Открыть…')}
              </Button>
              <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void paste()}>
                {t('Вставить')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Save className="size-3.5" />} disabled={!text.trim()} onClick={() => void saveSpec()}>
                {t('Сохранить…')}
              </Button>
            </div>
            <div className="relative">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                spellCheck={false}
                aria-label="PlanSpec JSON"
                placeholder={'{\n  "version": 1,\n  "units": "mm",\n  "rooms": [ … ],\n  "openings": [ … ]\n}'}
                className={cn(
                  'h-72 w-full resize-y rounded-md border bg-[var(--bg)] p-2 font-mono text-[11px] leading-snug text-[var(--text)] outline-none focus:border-[var(--accent)]',
                  result.state === 'error' ? 'border-[#ff8589]/60' : 'border-[var(--border)]',
                )}
              />
              {busy === 'recognise' && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/30">
                  <Spinner className="size-6" />
                </div>
              )}
            </div>
            {result.message && <p className="text-[11px] text-[#ff8589]">{result.message}</p>}
            {result.issues.length > 0 && (
              <ul className="max-h-32 overflow-auto rounded-md border border-[var(--border)] p-1.5 text-[10px]" aria-label={t('Замечания')}>
                {result.issues.map((i, n) => (
                  <li key={n} className={cn('flex gap-1.5 py-0.5', SEVERITY_CLS[i.severity] ?? '')}>
                    <span className="shrink-0 font-mono">{i.code}</span>
                    <span className="min-w-0 flex-1">
                      {i.message}
                      {i.path && <span className="text-[var(--muted)]"> · {i.path}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {result.state === 'empty' && (
              <p className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
                <FileUp className="size-3.5" aria-hidden />
                {t('Распознайте фото, откройте файл PlanSpec или вставьте JSON из буфера обмена.')}
              </p>
            )}
            {error && <p className="text-[11px] text-[#ff8589]">{error}</p>}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
