import { useEffect, useRef, useState } from 'react'
import { Bookmark, Camera, Check, Download, Pencil, Play, Square, Trash, X } from 'lucide-react'
import type { CameraBookmark, Hdri, QualityPreset, RenderSettings } from '@core/types'
import { newId } from '@core'
import { useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { handles } from '@/store/handles'
import { usePanelSize } from '@/store/layout'
import { useT } from '@/i18n'
import {
  Button,
  cn,
  Dialog,
  focusRing,
  IconButton,
  Input,
  NumberInput,
  Row,
  Section,
  Segmented,
  Select,
  Slider,
  Spinner,
  Toggle,
  fmtNum,
} from '@/ui/kit'
import { QUALITY_RU } from './common/labels'
import { downloadEntry, errorText, progressFraction, tx, useAllHdris, useDownloads } from './common/catalog'
import { formatTime, setRender } from './common/render'

const RESOLUTIONS: { id: string; label: string; w: number; h: number }[] = [
  { id: 'hd', label: 'HD 1280×720', w: 1280, h: 720 },
  { id: 'fhd', label: 'Full HD 1920×1080', w: 1920, h: 1080 },
  { id: 'qhd', label: 'QHD 2560×1440', w: 2560, h: 1440 },
  { id: '4k', label: '4K 3840×2160', w: 3840, h: 2160 },
  { id: 'sq', label: '2048×2048', w: 2048, h: 2048 },
  { id: 'portrait', label: '1440×1800 (4:5)', w: 1440, h: 1800 },
  { id: 'a4', label: 'A4 300 dpi 3508×2480', w: 3508, h: 2480 },
]

export interface RenderPanelProps {
  open: boolean
  onClose(): void
}

/** render settings drawer: quality, sun, HDRI, effects, camera bookmarks and still rendering */
export function RenderPanel({ open, onClose }: RenderPanelProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const renderSize = usePanelSize('render')
  return (
    <Dialog open={open} onClose={onClose} title={t('Рендер и освещение')} drawer drawerSize={{ ...renderSize, label: t('Ширина панели') }} modalLock={busy}>
      <div className="-m-4 flex flex-col">
        <EngineStatus />
        <QualitySection />
        <SunSection />
        <HdriSection />
        <EffectsSection />
        <BookmarksSection />
        <StillSection onBusy={setBusy} />
      </div>
    </Dialog>
  )
}

function useEngineReady(): boolean {
  // the engine is created lazily by the shell; poll the handle while the panel is open
  const [ready, setReady] = useState(() => !!handles.engine3d)
  useEffect(() => {
    if (ready) return
    const id = window.setInterval(() => {
      if (handles.engine3d) setReady(true)
    }, 500)
    return () => window.clearInterval(id)
  }, [ready])
  return ready
}

function EngineStatus() {
  const t = useT()
  const ready = useEngineReady()
  const mode = useUi((s) => s.mode)
  if (ready && mode !== '2d')
    return (
      <div className="border-b border-[var(--border)] px-3 py-2 text-[10px] text-[var(--muted)]">
        {t('Графика')}: {handles.engine3d?.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'}
      </div>
    )
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-3 py-2 text-[11px]">
      <span className="flex-1">{ready ? t('3D-вид скрыт — изменения будут видны в 3D.') : t('3D-вид ещё не открыт.')}</span>
      <Button size="sm" variant="primary" onClick={() => uiStore.getState().setMode('split')}>
        {t('Открыть 3D')}
      </Button>
    </div>
  )
}

function QualitySection() {
  const t = useT()
  const r = useDoc((s) => s.doc.render)
  return (
    <Section title={t('Качество и цвет')} id="render.quality">
      <Segmented<QualityPreset>
        value={r.quality}
        aria-label={t('Качество')}
        onChange={(q) => {
          setRender('Качество рендера', { quality: q })
          handles.engine3d?.setQuality(q)
        }}
        options={(['low', 'medium', 'high', 'ultra'] as QualityPreset[]).map((q) => ({ value: q, label: t(QUALITY_RU[q]) }))}
      />
      <Row label={t('Тональная кривая')}>
        <Select<RenderSettings['toneMapping']>
          value={r.toneMapping}
          onChange={(v) => setRender('Тональная кривая', { toneMapping: v })}
          options={[
            { value: 'agx', label: 'AgX' },
            { value: 'aces', label: 'ACES Filmic' },
            { value: 'neutral', label: 'Khronos Neutral' },
          ]}
        />
      </Row>
      <Row label={t('Экспозиция')}>
        <Slider value={r.exposure} min={-3} max={3} step={0.05} format={(v) => `${v > 0 ? '+' : ''}${fmtNum(v, 2)}`} onChange={(v, g) => setRender('Экспозиция', { exposure: v }, `render.exp.${g}`)} />
      </Row>
    </Section>
  )
}

function SunSection() {
  const t = useT()
  const r = useDoc((s) => s.doc.render)
  return (
    <Section title={t('Солнце')} id="render.sun">
      <Toggle checked={r.sunAuto} onChange={(v) => setRender('Солнце по времени', { sunAuto: v })} label={t('Положение по времени суток')} />
      <Row label={t('Время')}>
        <Slider value={r.timeOfDay} min={0} max={24} step={0.25} disabled={!r.sunAuto} format={formatTime} onChange={(v, g) => setRender('Время суток', { timeOfDay: v }, `render.time.${g}`)} />
      </Row>
      <Row label={t('Азимут')}>
        <Slider value={r.sunAzimuth} min={0} max={360} step={1} disabled={r.sunAuto} format={(v) => `${Math.round(v)}°`} onChange={(v, g) => setRender('Азимут солнца', { sunAzimuth: v }, `render.az.${g}`)} />
      </Row>
      <Row label={t('Высота')}>
        <Slider value={r.sunElevation} min={-10} max={90} step={1} disabled={r.sunAuto} format={(v) => `${Math.round(v)}°`} onChange={(v, g) => setRender('Высота солнца', { sunElevation: v }, `render.el.${g}`)} />
      </Row>
      <Row label={t('Яркость')}>
        <Slider value={r.sunIntensity} min={0} max={5} step={0.05} onChange={(v, g) => setRender('Яркость солнца', { sunIntensity: v }, `render.sunI.${g}`)} />
      </Row>
      <Row label={t('Север на плане')}>
        <NumberInput kind="angle" value={r.north} min={-360} max={360} onChange={(v, g) => setRender('Север', { north: v }, `render.north.${g}`)} />
        <NorthArrow deg={r.north} />
      </Row>
    </Section>
  )
}

function NorthArrow({ deg }: { deg: number }) {
  return (
    <svg viewBox="-12 -12 24 24" className="size-7 shrink-0" aria-hidden>
      <circle r={11} fill="none" stroke="var(--border)" />
      <g transform={`rotate(${deg})`}>
        <path d="M0 -9 L4 4 L0 1 L-4 4 Z" fill="var(--accent)" />
        <text y={-3} fontSize={5} textAnchor="middle" fill="white" dy={9}>
          N
        </text>
      </g>
    </svg>
  )
}

function HdriSection() {
  const t = useT()
  const r = useDoc((s) => s.doc.render)
  const hdris = useAllHdris()
  const progress = useDownloads((s) => s.progress)
  const pick = async (h: Hdri | null) => {
    if (!h) return setRender('Окружение', { hdriId: undefined })
    let id = h.id
    if ((h as Hdri & { remote?: boolean }).remote) {
      const local = await downloadEntry('hdri', h.id)
      if (!local) return
      id = local.id
    }
    setRender('Окружение', { hdriId: id })
  }
  return (
    <Section title={t('Окружение (HDRI)')} id="render.hdri">
      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          aria-pressed={!r.hdriId}
          onClick={() => void pick(null)}
          className={cn(
            'flex aspect-[2/1] items-center justify-center rounded-md border text-[10px] text-[var(--muted)]',
            focusRing,
            !r.hdriId ? 'border-[var(--accent)] text-[var(--text)]' : 'border-dashed border-[var(--border)]',
          )}
        >
          {t('Небо по солнцу')}
        </button>
        {hdris.map((h) => {
          const p = progressFraction(progress[h.id])
          const remote = (h as Hdri & { remote?: boolean }).remote
          return (
            <button
              key={h.id}
              type="button"
              aria-pressed={r.hdriId === h.id}
              title={`${h.name}${h.licence ? ` · ${h.licence}` : ''}${h.source ? ` · ${h.source}` : ''}`}
              onClick={() => void pick(h)}
              className={cn(
                'relative aspect-[2/1] overflow-hidden rounded-md border bg-[var(--bg)] bg-cover bg-center',
                focusRing,
                r.hdriId === h.id ? 'border-2 border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--accent)]',
              )}
              style={h.thumb ? { backgroundImage: `url("${h.thumb}")` } : undefined}
            >
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 text-[9px] text-white">{h.name}</span>
              {remote && (
                <span className="absolute right-1 top-1 rounded bg-black/50 p-0.5 text-white">
                  {p !== null ? <Spinner /> : <Download className="size-3" />}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <Row label={t('Интенсивность')}>
        <Slider value={r.hdriIntensity} min={0} max={4} step={0.05} onChange={(v, g) => setRender('Яркость окружения', { hdriIntensity: v }, `render.hdrI.${g}`)} />
      </Row>
      <Row label={t('Поворот')}>
        <Slider value={r.hdriRotation} min={0} max={360} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v, g) => setRender('Поворот окружения', { hdriRotation: v }, `render.hdrR.${g}`)} />
      </Row>
      <p className="text-[10px] leading-snug text-[var(--muted)]">{t('HDRI виден в окнах и даёт отражения; основной свет в интерьере — солнце и светильники.')}</p>
    </Section>
  )
}

function EffectsSection() {
  const t = useT()
  const r = useDoc((s) => s.doc.render)
  const flag = (key: 'ao' | 'ssgi' | 'ssr' | 'bloom' | 'wallCutaway' | 'ceilingVisible' | 'lightsOn', label: string) => (
    <Toggle checked={r[key]} onChange={(v) => setRender(label, { [key]: v } as Partial<RenderSettings>)} label={t(label)} />
  )
  return (
    <Section title={t('Эффекты и вид')} id="render.fx">
      {flag('ao', 'Затенение углов (AO)')}
      {flag('ssgi', 'Отражённый свет (SSGI)')}
      {flag('ssr', 'Отражения (SSR)')}
      {flag('bloom', 'Свечение (bloom)')}
      {flag('lightsOn', 'Искусственный свет')}
      {flag('wallCutaway', 'Прятать стены перед камерой')}
      {flag('ceilingVisible', 'Показывать потолок')}
    </Section>
  )
}

function BookmarksSection() {
  const t = useT()
  const cameras = useDoc((s) => s.doc.cameras)
  const ready = useEngineReady()
  const [editing, setEditing] = useState<string | null>(null)
  const list = Object.values(cameras)

  const save = () => {
    const e = handles.engine3d
    if (!e) return
    const c = e.getCamera()
    const mode = uiStore.getState().cameraMode === 'walk' ? 'walk' : 'orbit'
    const cam: CameraBookmark = { id: newId('c'), name: `${t('Вид')} ${list.length + 1}`, position: c.position, target: c.target, fov: c.fov, mode }
    tx('Сохранить вид', (d) => {
      d.cameras[cam.id] = cam
    })
  }
  const apply = (c: CameraBookmark) => {
    const e = handles.engine3d
    if (!e) return
    if (uiStore.getState().cameraMode !== c.mode) {
      e.setCameraMode(c.mode)
      uiStore.getState().set({ cameraMode: c.mode })
    }
    e.setCamera({ position: c.position, target: c.target, fov: c.fov })
  }

  return (
    <Section title={t('Виды камеры')} id="render.cams" actions={<IconButton size="sm" icon={<Bookmark />} label={t('Сохранить текущий вид')} disabled={!ready} onClick={save} />}>
      {list.length === 0 && <p className="text-[10px] text-[var(--muted)]">{t('Сохраните удачный ракурс, чтобы вернуться к нему и рендерить его.')}</p>}
      <ul className="flex flex-col gap-1">
        {list.map((c) => (
          <li key={c.id} className="flex items-center gap-1">
            {editing === c.id ? (
              <Input
                autoFocus
                value={c.name}
                className="h-6"
                onChange={(v) =>
                  tx('Название вида', (d) => {
                    const x = d.cameras[c.id]
                    if (x) x.name = v
                  }, `cam.${c.id}.name`)
                }
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <button
                type="button"
                disabled={!ready}
                onClick={() => apply(c)}
                className={cn('flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-[11px] hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] disabled:opacity-50', focusRing)}
              >
                <Camera className="size-3 shrink-0 text-[var(--muted)]" />
                <span className="truncate">{c.name}</span>
                <span className="ml-auto text-[9px] text-[var(--muted)]">{c.mode === 'walk' ? t('от первого лица') : ''}</span>
              </button>
            )}
            <IconButton size="sm" icon={editing === c.id ? <Check /> : <Pencil />} label={t('Переименовать')} onClick={() => setEditing(editing === c.id ? null : c.id)} />
            <IconButton
              size="sm"
              icon={<Camera />}
              label={t('Перезаписать текущим видом')}
              disabled={!ready}
              onClick={() => {
                const e = handles.engine3d
                if (!e) return
                const v = e.getCamera()
                tx('Обновить вид', (d) => {
                  const x = d.cameras[c.id]
                  if (x) Object.assign(x, { position: v.position, target: v.target, fov: v.fov })
                })
              }}
            />
            <IconButton
              size="sm"
              variant="danger"
              icon={<Trash />}
              label={t('Удалить вид')}
              onClick={() =>
                tx('Удалить вид', (d) => {
                  delete d.cameras[c.id]
                })
              }
            />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function StillSection({ onBusy }: { onBusy(b: boolean): void }) {
  const t = useT()
  const ready = useEngineReady()
  const pt = useUi((s) => s.pathTracing)
  const [res, setRes] = useState('fhd')
  const [custom, setCustom] = useState({ w: 1920, h: 1080 })
  const [mode, setMode] = useState<'realtime' | 'pathtraced'>('pathtraced')
  const [samples, setSamples] = useState(256)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [progress, setProgress] = useState<{ s: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ url: string; blob: Blob; w: number; h: number } | null>(null)
  const [savedTo, setSavedTo] = useState('')
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => {
    abort.current?.abort()
  }, [])
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url)
    }
  }, [result])

  const preset = RESOLUTIONS.find((r) => r.id === res)
  const w = preset ? preset.w : custom.w
  const h = preset ? preset.h : custom.h

  const run = async () => {
    const e = handles.engine3d
    if (!e) return
    setError('')
    setSavedTo('')
    setResult(null)
    const ac = new AbortController()
    abort.current = ac
    setProgress({ s: 0, total: mode === 'pathtraced' ? samples : 1 })
    onBusy(true)
    try {
      const blob = await e.renderStill({
        width: w,
        height: h,
        mode,
        samples: mode === 'pathtraced' ? samples : undefined,
        format,
        signal: ac.signal,
        onProgress: (s, total) => setProgress({ s, total }),
      })
      if (!ac.signal.aborted) setResult({ url: URL.createObjectURL(blob), blob, w, h })
    } catch (err) {
      if (!ac.signal.aborted) setError(errorText(err))
    } finally {
      abort.current = null
      setProgress(null)
      onBusy(false)
    }
  }

  const save = async () => {
    if (!result) return
    const ext = format === 'png' ? 'png' : 'jpg'
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const path = await window.doplan.files.saveBinary(
      `render-${stamp}-${result.w}x${result.h}.${ext}`,
      [{ name: format === 'png' ? 'PNG' : 'JPEG', extensions: [ext] }],
      await result.blob.arrayBuffer(),
    )
    if (path) setSavedTo(path)
  }

  return (
    <Section title={t('Изображение')} id="render.still">
      <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg)] p-1.5">
        <span className="flex-1 text-[11px]">
          {t('Прогрессивная трассировка в окне')}
          {pt.active && (
            <span className="ml-1 tabular-nums text-[var(--muted)]">
              {pt.samples}/{pt.target}
            </span>
          )}
        </span>
        {pt.active ? (
          <Button size="sm" icon={<Square className="size-3" />} onClick={() => handles.engine3d?.stopPathTracing()}>
            {t('Стоп')}
          </Button>
        ) : (
          <Button size="sm" icon={<Play className="size-3" />} disabled={!ready} onClick={() => handles.engine3d?.startPathTracing(samples)}>
            {t('Старт')}
          </Button>
        )}
      </div>
      <Row label={t('Разрешение')}>
        <Select value={res} onChange={setRes} options={[...RESOLUTIONS.map((r) => ({ value: r.id, label: r.label })), { value: 'custom', label: t('Своё…') }]} />
      </Row>
      {res === 'custom' && (
        <div className="grid grid-cols-2 gap-1.5">
          <NumberInput label="W" value={custom.w} min={64} max={8192} step={16} round={1} suffix="px" onChange={(v) => setCustom((c) => ({ ...c, w: v }))} />
          <NumberInput label="H" value={custom.h} min={64} max={8192} step={16} round={1} suffix="px" onChange={(v) => setCustom((c) => ({ ...c, h: v }))} />
        </div>
      )}
      <Row label={t('Метод')}>
        <Segmented<typeof mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'realtime', label: t('Быстрый'), title: t('Текущая картинка 3D со сглаживанием') },
            { value: 'pathtraced', label: t('Фотореализм'), title: t('Трассировка путей: точный свет и отражения, дольше') },
          ]}
        />
      </Row>
      {mode === 'pathtraced' && (
        <Row label={t('Сэмплы')}>
          <NumberInput value={samples} min={16} max={8192} step={16} round={1} onChange={(v) => setSamples(v)} />
        </Row>
      )}
      <Row label={t('Формат')}>
        <Segmented<typeof format>
          value={format}
          onChange={setFormat}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
          ]}
        />
      </Row>
      {progress ? (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 overflow-hidden rounded bg-[var(--bg)]" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.s}>
            <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${(progress.total ? progress.s / progress.total : 0) * 100}%` }} />
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <Spinner />
            <span className="flex-1 tabular-nums">
              {t('Рендер')} {w}×{h}: {progress.s}/{progress.total}
            </span>
            <Button size="sm" variant="danger" icon={<X className="size-3" />} onClick={() => abort.current?.abort()}>
              {t('Отмена')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" icon={<Camera className="size-3.5" />} disabled={!ready} onClick={() => void run()}>
          {t('Рендерить')} {w}×{h}
        </Button>
      )}
      {error && <p className="text-[11px] text-[#ff8589]">{error}</p>}
      {result && (
        <div className="flex flex-col gap-1.5">
          <img src={result.url} alt={t('Результат рендера')} className="w-full rounded-md border border-[var(--border)]" />
          <Button icon={<Download className="size-3.5" />} onClick={() => void save()}>
            {t('Сохранить изображение…')}
          </Button>
          {savedTo && (
            <button type="button" className="truncate text-left text-[10px] text-[var(--accent)] underline" onClick={() => void window.doplan.files.reveal(savedTo)}>
              {savedTo}
            </button>
          )}
        </div>
      )}
    </Section>
  )
}
