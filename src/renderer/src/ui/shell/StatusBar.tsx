import { Cpu, Crosshair, Maximize2, Minus, MousePointer2, Plus, SquareDashed } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { summarizeLevelRooms } from '@core'
import type { Doc, EntityKind, EntityRef } from '@core/types'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { dialogStore } from '@/store/dialogs'
import { useDoc } from '@/store/document'
import { useUpdates } from '@/store/updates'
import { handles, onHandlesChange } from '@/store/handles'
import { useNotify } from '@/store/notify'
import { useUi } from '@/store/ui'
import { IconBtn } from './primitives'

export function formatLength(mm: number, units: Doc['settings']['units']): string {
  switch (units) {
    case 'm':
      return `${(mm / 1000).toFixed(3)}`
    case 'cm':
      return `${(mm / 10).toFixed(1)}`
    default:
      return `${Math.round(mm)}`
  }
}

const KIND_NAMES: Record<EntityKind, [string, string]> = {
  node: ['узел', 'узлов'],
  wall: ['стена', 'стен'],
  opening: ['проём', 'проёмов'],
  room: ['комната', 'комнат'],
  item: ['предмет', 'предметов'],
  light: ['светильник', 'светильников'],
  electric: ['электроточка', 'электроточек'],
  dimension: ['размер', 'размеров'],
  label: ['надпись', 'надписей'],
  underlay: ['подложка', 'подложек'],
}

function selectionSummary(sel: EntityRef[], doc: Doc, t: (k: string, v?: Record<string, string | number>) => string, nameOfItem: (id: string) => string): string {
  if (!sel.length) return ''
  if (sel.length === 1) {
    const r = sel[0]
    switch (r.kind) {
      case 'room':
        return doc.rooms[r.id]?.name ?? t('комната')
      case 'item':
        return nameOfItem(r.id)
      case 'wall': {
        const w = doc.walls[r.id]
        if (!w) return t('стена')
        const a = doc.nodes[w.a]
        const b = doc.nodes[w.b]
        const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0
        return `${t('стена')} ${Math.round(len)}×${w.thickness} ${t('мм')}`
      }
      case 'opening': {
        const o = doc.openings[r.id]
        return o ? `${t('проём')} ${o.width}×${o.height} ${t('мм')}` : t('проём')
      }
      case 'label':
        return doc.labels[r.id]?.text ?? t('надпись')
      default:
        return t(KIND_NAMES[r.kind][0])
    }
  }
  const counts = new Map<EntityKind, number>()
  for (const r of sel) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  return [...counts.entries()].map(([k, n]) => `${n} ${t(n === 1 ? KIND_NAMES[k][0] : KIND_NAMES[k][1])}`).join(', ')
}

function useZoomLabel(): string {
  const cursor = useUi((s) => s.cursor)
  const revision = useDoc((s) => s.revision)
  const [, force] = useState(0)
  useEffect(() => onHandlesChange(() => force((n) => n + 1)), [])
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  void cursor
  void revision
  const ed = handles.editor2d
  if (!ed) return ''
  try {
    const a = ed.toScreen({ x: 0, y: 0 })
    const b = ed.toScreen({ x: 1000, y: 0 })
    const pxPerM = Math.hypot(b.x - a.x, b.y - a.y)
    if (!Number.isFinite(pxPerM) || pxPerM <= 0) return ''
    // 1:N assuming 96 dpi screen (1 px = 0.2646 mm)
    const ratio = 1000 / (pxPerM * 0.2646)
    return `1:${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`
  } catch {
    return ''
  }
}

/** app version in the right corner; a dot when an update is available or ready. Opens «О программе». */
function VersionLabel() {
  const t = useT()
  const pending = useUpdates((u) => {
    const s = u.state.status
    return s.kind === 'available' || s.kind === 'progress' || s.kind === 'downloaded' ? s.version : null
  })
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 font-mono text-faint hover:text-text"
      title={pending ? t('Доступно обновление {v}', { v: pending }) : t('doplan {v} — о программе и обновления', { v: api.version })}
      onClick={() => dialogStore.getState().open('about')}
    >
      {pending && <span className="size-1.5 rounded-full bg-accent" />}v{api.version}
    </button>
  )
}

export function StatusBar() {
  const t = useT()
  const cursor = useUi((s) => s.cursor)
  const hint = useUi((s) => s.hint)
  const selection = useUi((s) => s.selection)
  const backend = useUi((s) => s.backend)
  const mode = useUi((s) => s.mode)
  const lang = useUi((s) => s.lang)
  const getAsset = useUi((s) => s.getAsset)
  const activeLevelId = useUi((s) => s.activeLevelId)
  const doc = useDoc((s) => s.doc)
  const derived = useDoc((s) => s.derived[activeLevelId])
  const progress = useNotify((s) => s.progress)
  const zoom = useZoomLabel()
  const units = doc.settings.units
  const unitLabel = t(units === 'm' ? 'м' : units === 'cm' ? 'см' : 'мм')

  // BTI-style: shafts excluded, balcony ×0.3, loggia ×0.5 (same rules as the PlanSpec validator)
  const area = useMemo(() => summarizeLevelRooms(doc, derived?.rooms ?? []), [doc, derived])
  const areaTip = [
    t('Общая площадь (балконы ×0,3, лоджии ×0,5): {v} м²', { v: area.total.toFixed(2) }),
    t('Жилая площадь: {v} м²', { v: area.living.toFixed(2) }),
    ...(area.outdoor > 0 ? [t('Балконы и лоджии (фактически): {v} м²', { v: area.outdoor.toFixed(2) })] : []),
    ...(area.technicalCount > 0 ? [t('Не учтено технических помещений (шахты < 1 м²): {n}', { n: area.technicalCount })] : []),
  ].join('\n')

  const nameOfItem = (id: string) => {
    const it = doc.items[id]
    if (!it) return t('предмет')
    if (it.name) return it.name
    const a = getAsset(it.assetId)
    return a ? (lang === 'ru' ? (a.nameRu ?? a.name) : a.name) : t('предмет')
  }
  const selText = selectionSummary(selection, doc, t, nameOfItem)

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-2 text-[11px] text-muted">
      <span className="flex w-[150px] shrink-0 items-center gap-1 font-mono">
        <Crosshair size={11} />
        {cursor ? `${formatLength(cursor.x, units)}, ${formatLength(cursor.y, units)} ${unitLabel}` : '—'}
      </span>
      {progress ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-text">
          <span className="truncate">{progress.label}</span>
          <span className="relative h-1.5 w-40 shrink-0 overflow-hidden rounded bg-panel-3">
            {progress.value === null ? (
              <span className="dp-indeterminate absolute inset-y-0 left-0 w-1/3 rounded bg-accent" />
            ) : (
              <span className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${Math.round(progress.value * 100)}%` }} />
            )}
          </span>
          {progress.cancel && (
            <button type="button" className="text-accent hover:underline" onClick={progress.cancel}>
              {t('Отмена')}
            </button>
          )}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{hint}</span>
      )}
      {selText && (
        <span className="flex max-w-[260px] shrink-0 items-center gap-1 truncate text-text">
          <MousePointer2 size={11} className="text-muted" />
          {selText}
        </span>
      )}
      {area.count > 0 && (
        <span className="flex shrink-0 items-center gap-1" title={areaTip}>
          <SquareDashed size={11} />
          {t('{n} комн.', { n: area.count })} · {area.total.toFixed(1)} {t('м²')}
        </span>
      )}
      {mode !== '3d' && (
        <span className="flex shrink-0 items-center gap-0.5">
          <IconBtn icon={Minus} size="sm" label={t('Уменьшить')} tipSide="top" onClick={() => handles.editor2d?.zoomBy(1 / 1.25)} />
          <span className="w-12 text-center font-mono">{zoom}</span>
          <IconBtn icon={Plus} size="sm" label={t('Увеличить')} tipSide="top" onClick={() => handles.editor2d?.zoomBy(1.25)} />
          <IconBtn icon={Maximize2} size="sm" label={t('Показать весь план')} tipSide="top" onClick={() => handles.editor2d?.zoomToFit()} />
        </span>
      )}
      {backend && (
        <span className="flex shrink-0 items-center gap-1" title={t('Графический бэкенд 3D')}>
          <Cpu size={11} />
          {backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' || backend === 'webgl' ? 'WebGL 2' : backend}
        </span>
      )}
      <VersionLabel />
    </footer>
  )
}
