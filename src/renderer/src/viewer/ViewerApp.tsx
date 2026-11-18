import clsx from 'clsx'
import {
  Box,
  Check,
  Footprints,
  Info,
  LampCeiling,
  Link2,
  LoaderCircle,
  Map as MapIcon,
  Orbit,
  Pause,
  RotateCcw,
  Scan,
  Sparkles,
  SquareDashed,
  TriangleExclamationPoint,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { builtinCatalog, mergeCatalog, parseDoc } from '@core'
import type { Catalog, QualityPreset } from '@core/types'
import type { Editor2DHandle, Engine3DHandle } from '@/contracts'
import { createEditor2D } from '@/editor2d'
import { addTranslations, useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { setHandle } from '@/store/handles'
import { uiStore, useUi } from '@/store/ui'
import { AppLogo } from '@/ui/shell/AppLogo'
import { MiniSelect, Segmented } from '@/ui/shell/primitives'
import { WalkLockHint } from '@/ui/shell/WalkLockHint'
import { useStatus3d } from '@/view3d/status'
import { parseViewerParams, viewerQuery, type SiteInfo, type ViewerCam, type ViewerParams, type ViewerView } from '@shared/pagesSite'
import { installEditGuard, viewerEdit } from './guard'
import { loadSite } from './load'
import { WalkStick } from './WalkStick'

addTranslations('en', {
  'Загрузка плана…': 'Loading the plan…',
  'Не удалось открыть план': 'Could not open the plan',
  Ракурс: 'Orbit',
  Прогулка: 'Walk',
  Сверху: 'Top',
  'Вращение вокруг квартиры': 'Rotate around the apartment',
  'От первого лица: WASD / стрелки, мышь — осмотреться': 'First person: WASD / arrows, mouse to look around',
  'Вид сверху': 'Top view',
  'Срез стен': 'Wall cut-away',
  Потолок: 'Ceiling',
  'Сбросить камеру': 'Reset camera',
  Качество: 'Quality',
  Низкое: 'Low',
  Среднее: 'Medium',
  Высокое: 'High',
  Ультра: 'Ultra',
  Трассировка: 'Path tracing',
  'Фотореалистичный кадр (трассировка путей)': 'Photoreal frame (path tracing)',
  'Остановить трассировку': 'Stop path tracing',
  'Скопировать ссылку на этот вид': 'Copy a link to this view',
  'Ссылка скопирована': 'Link copied',
  'О плане': 'About the plan',
  'Опубликовано': 'Published',
  'Сделано в doplan — только просмотр': 'Made with doplan — view only',
  'Модели и материалы': 'Models and materials',
  'Загрузка 3D…': 'Loading 3D…',
  'Не удалось запустить 3D-вид': 'Could not start the 3D view',
  'Запустить через WebGL': 'Start with WebGL',
  Повторить: 'Retry',
  'Не удалось запустить 2D-план': 'Could not start the 2D plan',
  'Загрузка моделей': 'Loading models',
  Этаж: 'Level',
  'Перетаскивайте, чтобы осмотреться': 'Drag to look around',
})

const QUALITY: QualityPreset[] = ['low', 'medium', 'high', 'ultra']
const QUALITY_NAMES: Record<QualityPreset, string> = { low: 'Низкое', medium: 'Среднее', high: 'Высокое', ultra: 'Ультра' }
const PT_TARGET = 256

const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** viewers get a lighter preset on phones; the author's own choice is the ceiling elsewhere */
function autoQuality(author: QualityPreset | undefined): QualityPreset {
  const small = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 600
  if (coarsePointer() || small) return 'low'
  return author === 'low' ? 'low' : 'medium'
}

interface Booted {
  info: SiteInfo | null
  credits: { name: string; author?: string; licence?: string; source?: string }[]
}

async function boot(params: ViewerParams): Promise<Booted> {
  const lang = (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en'
  const theme = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  uiStore.setState({ lang, theme })
  const site = await loadSite(location.href)
  const doc = parseDoc(site.doc)
  installEditGuard()
  docStore.getState().load(doc, null)
  const d = docStore.getState().doc
  uiStore.getState().setCatalog(mergeCatalog(builtinCatalog(), site.catalog as Partial<Catalog>))
  uiStore.getState().set({
    activeLevelId: params.level && d.levels[params.level] ? params.level : (d.levelOrder[0] ?? ''),
    tool: 'pan',
    selection: [],
    cameraMode: params.cam,
  })
  viewerEdit(() => uiStore.getState().setQuality(autoQuality(d.render.quality)))
  document.title = `${site.info?.title || d.meta.name || 'doplan'} — doplan`
  const cat = site.catalog
  const credits = [...(cat.assets ?? []), ...(cat.materials ?? []), ...(cat.hdris ?? [])]
    .filter((e) => e && (e.source || e.licence || ('author' in e && e.author)))
    .map((e) => ({ name: e.name, author: 'author' in e ? e.author : undefined, licence: e.licence, source: e.source }))
  return { info: site.info, credits }
}

export function ViewerApp() {
  const t = useT()
  const [params, setParams] = useState<ViewerParams>(() => parseViewerParams(location.search))
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; booted: Booted }>({ kind: 'loading' })

  useEffect(() => {
    boot(params)
      .then((booted) => setState({ kind: 'ready', booted }))
      .catch((err: unknown) => {
        console.error('[doplan viewer] boot failed', err)
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    // boot once with the URL the page was opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep the address bar in step with what is shown, so a copied URL opens the same view
  useEffect(() => {
    if (state.kind !== 'ready') return
    const url = `${location.pathname}${viewerQuery(params)}${location.hash}`
    if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url)
  }, [params, state.kind])

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-muted">
        <AppLogo size={40} />
        <div className="flex items-center gap-2 text-xs">
          <LoaderCircle size={14} className="dp-spin text-accent" />
          {t('Загрузка плана…')}
        </div>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        <TriangleExclamationPoint size={28} className="text-warning" />
        <div className="text-sm font-medium text-text">{t('Не удалось открыть план')}</div>
        <div className="max-w-md font-mono text-[11px] break-words text-muted">{state.message}</div>
      </div>
    )
  }
  return <Viewer params={params} setParams={setParams} booted={state.booted} />
}

function Viewer({ params, setParams, booted }: { params: ViewerParams; setParams(p: ViewerParams): void; booted: Booted }) {
  const t = useT()
  const [used3d, setUsed3d] = useState(params.view === '3d')
  const [infoOpen, setInfoOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const name = useDoc((s) => s.doc.meta.name)
  const levelOrder = useDoc((s) => s.doc.levelOrder)
  const levelMap = useDoc((s) => s.doc.levels)
  const levels = useMemo(() => levelOrder.map((id) => ({ id, name: levelMap[id]?.name ?? id })), [levelOrder, levelMap])
  const activeLevel = useUi((s) => s.activeLevelId)

  useEffect(() => {
    if (params.view === '3d') setUsed3d(true)
  }, [params.view])

  const setView = (view: ViewerView) => setParams({ ...params, view })
  const setLevel = (level: string) => {
    uiStore.getState().set({ activeLevelId: level, selection: [] })
    setParams({ ...params, level: level === levels[0]?.id ? undefined : level })
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard refused: the address bar has the same link */
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 pt-[env(safe-area-inset-top)]">
        <AppLogo size={20} className="shrink-0" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={booted.info?.title || name}>
          {booted.info?.title || name}
        </div>
        {levels.length > 1 && (
          <MiniSelect title={t('Этаж')} value={activeLevel} options={levels.map((l) => ({ value: l.id, label: l.name }))} onChange={setLevel} />
        )}
        <Segmented
          value={params.view}
          onChange={setView}
          options={[
            { value: '2d', label: <><MapIcon size={13} />2D</> },
            { value: '3d', label: <><Box size={13} />3D</> },
          ]}
        />
        <HeaderBtn label={copied ? t('Ссылка скопирована') : t('Скопировать ссылку на этот вид')} onClick={() => void copyLink()}>
          {copied ? <Check size={16} className="text-success" /> : <Link2 size={16} />}
        </HeaderBtn>
        <HeaderBtn label={t('О плане')} active={infoOpen} onClick={() => setInfoOpen((v) => !v)}>
          <Info size={16} />
        </HeaderBtn>
      </header>
      <main className="relative min-h-0 flex-1">
        <Plan2D hidden={params.view !== '2d'} />
        {used3d && <Scene3D hidden={params.view !== '3d'} cam={params.cam} onCam={(cam) => setParams({ ...params, cam })} />}
        {infoOpen && <InfoPanel booted={booted} onClose={() => setInfoOpen(false)} />}
      </main>
    </div>
  )
}

function HeaderBtn({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

function InfoPanel({ booted, onClose }: { booted: Booted; onClose(): void }) {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const when = booted.info?.publishedAt ? new Date(booted.info.publishedAt) : null
  return (
    <div className="absolute top-2 right-2 z-20 flex max-h-[calc(100%-1rem)] w-[min(22rem,calc(100%-1rem))] flex-col gap-2 overflow-auto rounded-lg border border-border bg-panel/95 p-3 text-xs shadow-pop backdrop-blur">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 font-medium">{t('Сделано в doplan — только просмотр')}</div>
        <button type="button" aria-label="×" className="text-muted hover:text-text" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {when && !Number.isNaN(when.getTime()) && (
        <div className="text-muted">
          {t('Опубликовано')}: {when.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
        </div>
      )}
      {booted.credits.length > 0 && (
        <>
          <div className="mt-1 font-medium">{t('Модели и материалы')}</div>
          <ul className="flex flex-col gap-1 text-muted">
            {booted.credits.map((c, i) => (
              <li key={`${c.name}-${i}`} className="break-words">
                {c.name}
                {c.author ? ` — ${c.author}` : ''}
                {c.licence ? ` · ${c.licence}` : ''}
                {c.source ? ` · ${c.source}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// ───────────── 2D ─────────────

function Plan2D({ hidden }: { hidden: boolean }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let handle: Editor2DHandle | null = null
    let ro: ResizeObserver | null = null
    let fitted = false
    setError(null)
    createEditor2D(el)
      .then((h) => {
        if (disposed) {
          h.destroy()
          return
        }
        handle = h
        setHandle('editor2d', h)
        ro = new ResizeObserver((entries) => {
          const r = entries[0]?.contentRect
          if (!r || r.width <= 0 || r.height <= 0) return
          h.resize()
          // first time the (possibly hidden) plan gets a size: frame the whole plan
          if (!fitted) {
            fitted = true
            requestAnimationFrame(() => !disposed && h.zoomToFit())
          }
        })
        ro.observe(el)
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
      ro?.disconnect()
      if (handle) {
        setHandle('editor2d', null)
        handle.destroy()
      }
    }
  }, [attempt])

  return (
    <div className={hidden ? 'hidden' : 'absolute inset-0 overflow-hidden bg-viewport'}>
      <div ref={host} className="absolute inset-0" />
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <TriangleExclamationPoint size={28} className="text-warning" />
          <div className="text-sm font-medium">{t('Не удалось запустить 2D-план')}</div>
          <div className="max-w-md font-mono text-[11px] break-words text-muted">{error}</div>
          <button type="button" className="text-accent hover:underline" onClick={() => setAttempt((n) => n + 1)}>
            {t('Повторить')}
          </button>
        </div>
      )}
    </div>
  )
}

// ───────────── 3D ─────────────

function publishBackend(pref: 'webgpu' | 'webgl'): void {
  ;(globalThis as unknown as { __DOPLAN_BACKEND__?: string }).__DOPLAN_BACKEND__ = pref
}

function Scene3D({ hidden, cam, onCam }: { hidden: boolean; cam: ViewerCam; onCam(c: ViewerCam): void }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<Engine3DHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backend, setBackend] = useState<'webgpu' | 'webgl'>('webgpu')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let handle: Engine3DHandle | null = null
    let ro: ResizeObserver | null = null
    setError(null)
    setEngine(null)
    publishBackend(backend)
    import('@/view3d')
      .then((mod) => mod.createEngine3D(el))
      .then((h) => {
        if (disposed) {
          h.destroy()
          return
        }
        handle = h
        setHandle('engine3d', h)
        uiStore.setState({ backend: h.backend })
        h.setCameraMode(uiStore.getState().cameraMode)
        ro = new ResizeObserver((entries) => {
          const r = entries[0]?.contentRect
          if (r && r.width > 0 && r.height > 0) h.resize()
        })
        ro.observe(el)
        setEngine(h)
      })
      .catch((err: unknown) => {
        if (disposed) return
        console.error('[doplan viewer] 3D failed to start', err)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
      ro?.disconnect()
      if (handle) {
        setHandle('engine3d', null)
        uiStore.setState({ backend: null })
        handle.destroy()
      }
    }
  }, [attempt, backend])

  // the URL decides the camera mode (back/forward, edited links)
  useEffect(() => {
    if (!engine || uiStore.getState().cameraMode === cam) return
    uiStore.getState().set({ cameraMode: cam })
    engine.setCameraMode(cam)
  }, [cam, engine])

  return (
    <div className={hidden ? 'hidden' : 'absolute inset-0 overflow-hidden bg-viewport'}>
      <div ref={host} className="absolute inset-0" />
      {!engine && !error && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted">
          <LoaderCircle size={22} className="dp-spin text-accent" />
          {t('Загрузка 3D…')}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <TriangleExclamationPoint size={28} className="text-warning" />
          <div className="text-sm font-medium">{t('Не удалось запустить 3D-вид')}</div>
          <div className="max-w-md font-mono text-[11px] break-words text-muted">{error}</div>
          <div className="flex gap-3">
            <button type="button" className="text-accent hover:underline" onClick={() => setAttempt((n) => n + 1)}>
              {t('Повторить')}
            </button>
            {backend !== 'webgl' && (
              <button type="button" className="text-accent hover:underline" onClick={() => setBackend('webgl')}>
                {t('Запустить через WebGL')}
              </button>
            )}
          </div>
        </div>
      )}
      {engine && <Toolbar3D engine={engine} cam={cam} onCam={onCam} />}
      {engine && !hidden && <Busy />}
      {engine && !hidden && <WalkLockHint host={host} active={cam === 'walk'} />}
      {engine && !hidden && cam === 'walk' && <WalkStick />}
    </div>
  )
}

function Toolbar3D({ engine, cam, onCam }: { engine: Engine3DHandle; cam: ViewerCam; onCam(c: ViewerCam): void }) {
  const t = useT()
  const quality = useDoc((s) => s.doc.render.quality)
  const cutaway = useDoc((s) => s.doc.render.wallCutaway)
  const ceiling = useDoc((s) => s.doc.render.ceilingVisible)
  const pt = useUi((s) => s.pathTracing)
  const canTrace = engine.backend === 'webgpu'

  const toggle = (key: 'wallCutaway' | 'ceilingVisible') =>
    viewerEdit(() =>
      docStore.getState().transact(key, (d) => {
        d.render[key] = !d.render[key]
      }),
    )
  const setQuality = (q: QualityPreset) => {
    viewerEdit(() => uiStore.getState().setQuality(q))
    engine.setQuality(q)
  }
  const startPt = () => {
    uiStore.getState().set({ pathTracing: { active: true, samples: 0, target: PT_TARGET } })
    engine.startPathTracing(PT_TARGET)
  }
  const stopPt = () => {
    engine.stopPathTracing()
    uiStore.getState().set({ pathTracing: { ...uiStore.getState().pathTracing, active: false } })
  }

  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-2">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-panel/90 p-1 shadow-pop backdrop-blur">
        <Segmented
          size="sm"
          value={cam}
          onChange={onCam}
          options={[
            { value: 'orbit', label: <><Orbit size={12} />{t('Ракурс')}</>, title: t('Вращение вокруг квартиры') },
            { value: 'walk', label: <><Footprints size={12} />{t('Прогулка')}</>, title: t('От первого лица: WASD / стрелки, мышь — осмотреться') },
            { value: 'top', label: <><Scan size={12} />{t('Сверху')}</>, title: t('Вид сверху') },
          ]}
        />
        <ToolBtn label={t('Срез стен')} active={cutaway} onClick={() => toggle('wallCutaway')}>
          <SquareDashed size={14} />
        </ToolBtn>
        <ToolBtn label={t('Потолок')} active={ceiling} onClick={() => toggle('ceilingVisible')}>
          <LampCeiling size={14} />
        </ToolBtn>
        <ToolBtn label={t('Сбросить камеру')} onClick={() => engine.resetCamera()}>
          <RotateCcw size={14} />
        </ToolBtn>
      </div>
      <div className="pointer-events-auto ml-auto flex items-center gap-1 rounded-lg border border-border bg-panel/90 p-1 shadow-pop backdrop-blur">
        <MiniSelect title={t('Качество')} value={quality} options={QUALITY.map((q) => ({ value: q, label: t(QUALITY_NAMES[q]) }))} onChange={setQuality} />
        {canTrace &&
          (pt.active ? (
            <button
              type="button"
              title={t('Остановить трассировку')}
              onClick={stopPt}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-panel-2 px-2 text-[11px] hover:bg-panel-3"
            >
              {pt.samples >= pt.target ? <Check size={12} className="text-accent" /> : <Pause size={12} />}
              <span className="font-mono">
                {Math.min(pt.samples, pt.target)}/{pt.target}
              </span>
            </button>
          ) : (
            <button
              type="button"
              title={t('Фотореалистичный кадр (трассировка путей)')}
              onClick={startPt}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-panel-2 px-2 text-[11px] hover:bg-panel-3"
            >
              <Sparkles size={12} />
              {t('Трассировка')}
            </button>
          ))}
      </div>
    </div>
  )
}

function ToolBtn({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

function Busy() {
  const t = useT()
  const pending = useStatus3d((s) => s.modelsPending)
  const total = useStatus3d((s) => s.modelsTotal)
  if (pending <= 0) return null
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-panel/90 px-3 py-1.5 text-xs shadow-pop backdrop-blur" role="status">
      <LoaderCircle size={14} className="dp-spin text-accent" />
      {t('Загрузка моделей')} {total - pending}/{total}
    </div>
  )
}
