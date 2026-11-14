import clsx from 'clsx'
import {
  Camera,
  Check,
  Focus,
  Footprints,
  LampCeiling,
  LoaderCircle,
  Orbit,
  Pause,
  RefreshCw,
  RotateCcw,
  Scan,
  Sparkles,
  SquareDashed,
  TriangleExclamationPoint,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { QualityPreset } from '@core/types'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { docStore, useDoc } from '@/store/document'
import { handles, setHandle } from '@/store/handles'
import { pathTracingDone, uiStore, useUi } from '@/store/ui'
import type { Engine3DHandle } from '@/contracts'
import { IconBtn, MiniSelect, Segmented, TextBtn } from './primitives'

const QUALITY: QualityPreset[] = ['low', 'medium', 'high', 'ultra']
const QUALITY_NAMES: Record<QualityPreset, string> = { low: 'Низкое', medium: 'Среднее', high: 'Высокое', ultra: 'Ультра' }
const PT_TARGETS = [64, 256, 1024, 4096]

/** Global flag read by the 3D engine when it picks a backend ('webgpu' | 'webgl'). */
function publishBackendPref(pref: 'webgpu' | 'webgl'): void {
  ;(globalThis as unknown as { __DOPLAN_BACKEND__?: string }).__DOPLAN_BACKEND__ = pref
}

function Overlay({ engine }: { engine: Engine3DHandle }) {
  const t = useT()
  const cameraMode = useUi((s) => s.cameraMode)
  const pt = useUi((s) => s.pathTracing)
  const hasSel = useUi((s) => s.selection.length > 0)
  const quality = useDoc((s) => s.doc.render.quality)
  const cutaway = useDoc((s) => s.doc.render.wallCutaway)
  const ceiling = useDoc((s) => s.doc.render.ceilingVisible)
  const [target, setTarget] = useState(256)
  const ptDone = pathTracingDone(pt)

  const setCam = (m: 'orbit' | 'walk' | 'top') => {
    uiStore.getState().set({ cameraMode: m })
    engine.setCameraMode(m)
  }
  const toggleRender = (key: 'wallCutaway' | 'ceilingVisible', label: string) => {
    docStore.getState().transact(label, (d) => {
      d.render[key] = !d.render[key]
    })
  }
  const startPt = () => {
    uiStore.getState().set({ pathTracing: { active: true, samples: 0, target } })
    engine.startPathTracing(target)
  }
  const stopPt = () => {
    engine.stopPathTracing()
    uiStore.getState().set({ pathTracing: { ...uiStore.getState().pathTracing, active: false } })
  }

  return (
    <>
      {/* both bars share one wrapping row so they stack instead of overlapping in a narrow (split) viewport */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-2">
      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-panel/90 p-1 shadow-pop backdrop-blur">
        <Segmented
          size="sm"
          value={cameraMode}
          onChange={setCam}
          options={[
            { value: 'orbit', label: <><Orbit size={12} />{t('Орбита')}</>, title: t('Вращение вокруг плана') },
            { value: 'walk', label: <><Footprints size={12} />{t('Прогулка')}</>, title: t('От первого лица: WASD + мышь') },
            { value: 'top', label: <><Scan size={12} />{t('Сверху')}</>, title: t('Вид сверху') },
          ]}
        />
        <IconBtn icon={SquareDashed} size="sm" label={t('Срез стен')} active={cutaway} onClick={() => toggleRender('wallCutaway', 'Срез стен')} />
        <IconBtn icon={LampCeiling} size="sm" label={t('Потолок')} active={ceiling} onClick={() => toggleRender('ceilingVisible', 'Потолок')} />
        <IconBtn icon={Focus} size="sm" label={t('К выбранному')} disabled={!hasSel} onClick={() => engine.focusSelection()} />
        <IconBtn icon={RotateCcw} size="sm" label={t('Сбросить камеру')} onClick={() => engine.resetCamera()} />
      </div>

      <div className="pointer-events-auto ml-auto flex items-center gap-1 rounded-lg border border-border bg-panel/90 p-1 shadow-pop backdrop-blur">
        <MiniSelect
          title={t('Качество')}
          value={quality}
          options={QUALITY.map((q) => ({ value: q, label: t(QUALITY_NAMES[q]) }))}
          onChange={(q) => {
            uiStore.getState().setQuality(q)
            engine.setQuality(q)
          }}
        />
        {ptDone ? (
          <>
            {/* converged: the same target starts over, a higher one keeps accumulating */}
            <MiniSelect title={t('Сэмплов')} value={target} options={PT_TARGETS.map((n) => ({ value: n, label: String(n) }))} onChange={(v) => setTarget(Number(v))} />
            <IconBtn
              icon={RotateCcw}
              size="sm"
              label={target > pt.target ? `${t('Досчитать до')} ${target}` : t('Перезапустить трассировку')}
              onClick={startPt}
            />
            <TextBtn variant="default" className="h-6 px-2 text-accent" onClick={stopPt} title={t('Трассировка завершена — выключить')}>
              <Check size={12} />
              {t('Готово')}
              <span className="font-mono">{pt.target}</span>
            </TextBtn>
          </>
        ) : pt.active ? (
          <TextBtn variant="default" className="h-6 px-2" onClick={stopPt}>
            <Pause size={12} />
            <span className="font-mono">
              {pt.samples}/{pt.target}
            </span>
          </TextBtn>
        ) : (
          <>
            <MiniSelect title={t('Сэмплов')} value={target} options={PT_TARGETS.map((n) => ({ value: n, label: String(n) }))} onChange={(v) => setTarget(Number(v))} />
            <TextBtn variant="default" className="h-6 px-2" onClick={startPt} title={t('Трассировка путей в окне')}>
              <Sparkles size={12} />
              {t('Трассировка')}
            </TextBtn>
          </>
        )}
        <IconBtn icon={Camera} size="sm" label={t('Снимок')} onClick={() => void actions.snapshot3d()} />
      </div>
      </div>

      {pt.active && !ptDone && (
        <div className="pointer-events-none absolute right-2 bottom-2 left-2 h-1 overflow-hidden rounded bg-black/30">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (pt.samples / Math.max(1, pt.target)) * 100)}%` }} />
        </div>
      )}
    </>
  )
}

/** Lazily loads the 3D engine chunk and mounts it. */
export function Viewport3D({ hidden }: { hidden?: boolean }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<Engine3DHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const backendPref = useUi((s) => s.backendPref)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let handle: Engine3DHandle | null = null
    let ro: ResizeObserver | null = null
    setError(null)
    setEngine(null)
    publishBackendPref(uiStore.getState().backendPref)
    import('@/view3d')
      .then((mod) => mod.createEngine3D(el))
      .then((h) => {
        if (disposed) {
          h.destroy()
          return
        }
        handle = h
        setHandle('engine3d', h)
        setEngine(h)
        uiStore.setState({ backend: h.backend })
        h.setCameraMode(uiStore.getState().cameraMode)
        ro = new ResizeObserver((entries) => {
          const r = entries[0]?.contentRect
          if (r && r.width > 0 && r.height > 0) h.resize()
        })
        ro.observe(el)
      })
      .catch((err: unknown) => {
        if (disposed) return
        console.error('[doplan] 3D engine failed to start', err)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
      ro?.disconnect()
      if (handle) {
        if (uiStore.getState().pathTracing.active) uiStore.getState().set({ pathTracing: { ...uiStore.getState().pathTracing, active: false } })
        if (handles.engine3d === handle) setHandle('engine3d', null)
        uiStore.setState({ backend: null })
        try {
          handle.destroy()
        } catch (err) {
          console.warn('[doplan] engine destroy failed', err)
        }
      }
    }
  }, [attempt])

  const retryWebGl = async () => {
    uiStore.getState().setBackendPref('webgl')
    publishBackendPref('webgl')
    // the engine reads the backend from persisted settings: make sure the save landed first
    try {
      const s = await api.settings.set({ backend: 'webgl' })
      uiStore.setState({ appSettings: s })
    } catch {
      /* the global flag above still applies */
    }
    setAttempt((n) => n + 1)
  }

  return (
    <div className={clsx(hidden ? 'hidden' : 'relative min-h-0 min-w-0 flex-1 overflow-hidden bg-viewport')} data-viewport="3d">
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
          <div className="flex gap-2">
            <TextBtn onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw size={13} />
              {t('Повторить')}
            </TextBtn>
            {backendPref !== 'webgl' && (
              <TextBtn variant="primary" onClick={() => void retryWebGl()}>
                {t('Запустить через WebGL')}
              </TextBtn>
            )}
          </div>
          <div className="max-w-sm text-[11px] text-faint">{t('WebGL работает на большинстве видеокарт, но медленнее и без некоторых эффектов.')}</div>
        </div>
      )}
      {engine && <Overlay engine={engine} />}
    </div>
  )
}
