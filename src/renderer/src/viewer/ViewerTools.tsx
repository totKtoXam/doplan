/**
 * The viewer's tools over the 2D plan and the 3D view: a click shows the element card (name, sizes,
 * material; the element is outlined), the ruler measures between two points (snapped to corners and
 * edges), «Distance to…» measures between two elements, and elements or whole categories can be
 * hidden (kept in the URL hash). Nothing here edits the plan: hiding is a display filter.
 */
import clsx from 'clsx'
import { Box, Camera, Download, Eye, EyeOff, FileDown, FileText, Image, LoaderCircle, MousePointer2, Ruler, X } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { entityKind, pointInPolygon, visiblePlan } from '@core'
import type { Doc, EntityRef, Id } from '@core/types'
import { addTranslations, t, useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { handles } from '@/store/handles'
import { uiStore, useUi } from '@/store/ui'
import { DropdownMenu, IconBtn, type MenuEntry } from '@/ui/shell/primitives'
import type { ViewerView } from '@shared/pagesSite'
import { gapBetween, pointGap, shapeOf } from './distance'
import { fileName, planFile, planPdf, planPng, saveBlob, sceneGlb, scenePng } from './exporters'
import { ELEMENT_INFO_EN, elementInfo, mmText } from './elementInfo'
import { viewerEdit } from './guard'
import { applyHidden, catOf, EMPTY_HIDE, HIDE_CAT_NAMES, HIDE_CATS, type HideCat, type HideState, hiddenRefs, hideHash, parseHideHash, toggleCat, toggleRef } from './hideState'

addTranslations('en', {
  ...ELEMENT_INFO_EN,
  Выбор: 'Select',
  'Выбрать элемент — карточка с размерами': 'Select an element — a card with its sizes',
  Измерить: 'Measure',
  'Измерить расстояние между двумя точками': 'Measure the distance between two points',
  Скрытое: 'Hidden',
  'Скрыть элементы и категории': 'Hide elements and categories',
  Скрыть: 'Hide',
  Показать: 'Show',
  'Показать всё': 'Show all',
  'Расстояние до…': 'Distance to…',
  'Выберите второй элемент': 'Pick the second element',
  Отмена: 'Cancel',
  'Расстояние до «{name}»': 'Distance to “{name}”',
  Кратчайшее: 'Shortest',
  'По X': 'Along X',
  'По Y': 'Along Y',
  'По высоте': 'In height',
  Измерение: 'Measurement',
  'Кликните первую точку': 'Click the first point',
  'Кликните вторую точку': 'Click the second point',
  Расстояние: 'Distance',
  Заново: 'Again',
  Категории: 'Categories',
  'Скрытые элементы': 'Hidden elements',
  'Ничего не скрыто': 'Nothing is hidden',
  Мебель: 'Furniture',
  'Двери и проёмы': 'Doors and openings',
  Окна: 'Windows',
  Закрыть: 'Close',
  Скачать: 'Download',
  'План, PNG': 'Plan, PNG',
  'План с размерами, PDF': 'Plan with dimensions, PDF',
  '3D-вид, PNG': '3D view, PNG',
  '3D-вид, PNG (откройте 3D)': '3D view, PNG (open 3D)',
  '3D-модель, GLB': '3D model, GLB',
  '3D-модель, GLB (откройте 3D)': '3D model, GLB (open 3D)',
  'Файл плана для doplan (.doplan)': 'Plan file for doplan (.doplan)',
  'Готовлю {what}…': 'Preparing {what}…',
  'Не удалось сохранить {what}': 'Could not save {what}',
})

// ───────────── state ─────────────

/** a measured point: plan mm and height mm */
export interface MeasurePoint {
  x: number
  y: number
  z: number
}

interface ToolsState {
  mode: 'select' | 'measure'
  /** the element of the card (also outlined) */
  selected: EntityRef | null
  /** waiting for the second element of «Distance to…» */
  pairing: boolean
  pair: EntityRef | null
  points: MeasurePoint[]
  /** the view the points were taken in (a 2D point has no height) */
  pointsView: ViewerView
  hide: HideState
  panel: boolean
}

export const toolsStore = createStore<ToolsState>(() => ({
  mode: 'select',
  selected: null,
  pairing: false,
  pair: null,
  points: [],
  pointsView: '2d',
  hide: EMPTY_HIDE,
  panel: false,
}))

const useTools = <T,>(sel: (s: ToolsState) => T): T => useStore(toolsStore, sel)

const sameRef = (a: EntityRef | null, b: EntityRef | null) => !!a && !!b && a.kind === b.kind && a.id === b.id

function setSelected(selected: EntityRef | null, pair: EntityRef | null = null): void {
  toolsStore.setState({ selected, pair, pairing: false })
}

export function resetTools(): void {
  toolsStore.setState({ selected: null, pair: null, pairing: false, points: [] })
}

const assetOf = (doc: Doc) => (id: Id) => doc.assets?.[id] ?? uiStore.getState().catalog.assets.find((a) => a.id === id)

interface Boot {
  /** `kind:id` of what the author published hidden */
  authorHidden: ReadonlySet<string>
  authorCeiling: boolean
}

/**
 * Wires the tools to the page: the hidden state follows the URL hash both ways and is applied to the
 * shown plan; the card's element and the distance pair are outlined in 2D and 3D. Call once.
 */
export function installViewerTools(boot: Boot): void {
  authorCeiling = boot.authorCeiling
  const applyHide = (hide: HideState) =>
    viewerEdit(() =>
      docStore.getState().transact('view', (d) => {
        applyHidden(d, hiddenRefs(hide, d, assetOf(d)), boot.authorHidden)
        const ceiling = hide.ceiling ?? boot.authorCeiling
        if (d.render.ceilingVisible !== ceiling) d.render.ceilingVisible = ceiling
      }),
    )
  const fromHash = () => {
    const hide = parseHideHash(location.hash)
    if (hideHash(hide) !== hideHash(toolsStore.getState().hide)) toolsStore.setState({ hide })
  }
  fromHash()
  applyHide(toolsStore.getState().hide)
  window.addEventListener('hashchange', fromHash)
  toolsStore.subscribe((s, prev) => {
    if (s.hide !== prev.hide) {
      applyHide(s.hide)
      const hash = hideHash(s.hide, location.hash)
      if (hash !== location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`)
      // what got hidden leaves the card
      const doc = docStore.getState().doc
      const gone = hiddenRefs(s.hide, doc, assetOf(doc))
      const isGone = (r: EntityRef | null) => !!r && gone.some((g) => sameRef(g, r))
      if (isGone(s.selected) || isGone(s.pair)) setSelected(isGone(s.selected) ? null : s.selected)
    }
    if (s.selected !== prev.selected || s.pair !== prev.pair) {
      uiStore.getState().set({ selection: [s.selected, s.pair].filter((r): r is EntityRef => !!r) })
    }
  })
}

// ───────────── picking ─────────────

function roomAt(p: { x: number; y: number }): EntityRef | null {
  const s = docStore.getState()
  const plan = s.derived[uiStore.getState().activeLevelId]
  if (!plan) return null
  let best: { id: Id; area: number } | null = null
  for (const r of visiblePlan(s.doc, plan).rooms) {
    if (!pointInPolygon(p, r.polygon) || r.holes.some((h) => pointInPolygon(p, h))) continue
    if (!best || r.area < best.area) best = { id: r.roomId, area: r.area }
  }
  return best ? { kind: 'room', id: best.id } : null
}

function pickAt(view: ViewerView, x: number, y: number): { ref: EntityRef | null; point: MeasurePoint } | null {
  if (view === '2d') {
    const h = handles.editor2d
    if (!h?.pick || !h.snapPoint) return null
    const s = h.snapPoint(x, y)
    return { ref: h.pick(x, y), point: { x: s.p.x, y: s.p.y, z: 0 } }
  }
  const p = handles.engine3d?.pickAt?.(x, y)
  if (!p) return null
  const point = { x: p.point[0] * 1000, y: p.point[2] * 1000, z: p.point[1] * 1000 }
  const ref = p.ref ?? (p.surface === 'floor' || p.surface === 'ceiling' ? roomAt(point) : null)
  return { ref, point }
}

function onPick(view: ViewerView, x: number, y: number): void {
  const s = toolsStore.getState()
  const hit = pickAt(view, x, y)
  if (s.mode === 'measure') {
    if (!hit) return
    const points = s.points.length === 1 && s.pointsView === view ? [s.points[0], hit.point] : [hit.point]
    toolsStore.setState({ points, pointsView: view })
    return
  }
  const ref = hit?.ref ?? null
  if (s.pairing) {
    if (ref && !sameRef(ref, s.selected)) toolsStore.setState({ pair: ref, pairing: false })
    return
  }
  setSelected(ref)
}

/** a click (not a drag) on the view picks; in walk mode with a captured mouse, at the screen centre */
export function usePickClicks(host: RefObject<HTMLElement | null>, view: ViewerView, walk: boolean): void {
  useEffect(() => {
    const el = host.current
    if (!el) return
    let down: { id: number; x: number; y: number; t: number; moved: number; locked: boolean } | null = null
    let pointers = 0
    const fine = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
    const onDown = (e: PointerEvent) => {
      pointers++
      if (e.button !== 0 || pointers > 1) {
        down = null
        return
      }
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, locked: !!document.pointerLockElement }
    }
    const onMove = (e: PointerEvent) => {
      if (down && e.pointerId === down.id) down.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0)
    }
    const onUp = (e: PointerEvent) => {
      pointers = Math.max(0, pointers - 1)
      const d = down
      down = null
      if (!d || e.pointerId !== d.id || performance.now() - d.t > 600) return
      const locked = !!document.pointerLockElement && el.contains(document.pointerLockElement)
      if (locked ? d.moved > 8 : Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return
      // the click that captures the mouse for walking is not a pick
      if (walk && fine() && !d.locked) return
      const r = el.getBoundingClientRect()
      if (locked) onPick(view, r.left + r.width / 2, r.top + r.height / 2)
      else onPick(view, e.clientX, e.clientY)
    }
    const onCancel = () => {
      pointers = Math.max(0, pointers - 1)
      down = null
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
    }
  }, [host, view, walk])
}

/** Esc closes the card / the measurement (when it does not release a captured mouse) */
export function useToolKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.pointerLockElement) return
      const s = toolsStore.getState()
      if (s.panel) toolsStore.setState({ panel: false })
      else if (s.pairing) toolsStore.setState({ pairing: false })
      else if (s.points.length) toolsStore.setState({ points: [] })
      else if (s.selected) setSelected(null)
      else if (s.mode === 'measure') toolsStore.setState({ mode: 'select' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

// ───────────── overlay: measured lines on the plan / in the scene ─────────────

interface Seg {
  a: [number, number]
  b: [number, number] | null
  label: string
}

function project(view: ViewerView, p: MeasurePoint): [number, number] | null {
  if (view === '2d') {
    const s = handles.editor2d?.toScreen({ x: p.x, y: p.y })
    return s ? [s.x, s.y] : null
  }
  return handles.engine3d?.projectPoint?.([p.x / 1000, p.z / 1000, p.y / 1000]) ?? null
}

function segmentsFor(view: ViewerView): { a: MeasurePoint; b: MeasurePoint | null; value: number | null }[] {
  const s = toolsStore.getState()
  const out: { a: MeasurePoint; b: MeasurePoint | null; value: number | null }[] = []
  if (s.mode === 'measure' && s.points.length && s.pointsView === view) {
    const [a, b] = s.points
    out.push({ a, b: b ?? null, value: b ? pointGap(a, b).shortest : null })
  }
  if (s.selected && s.pair) {
    const ds = docStore.getState()
    const plan = ds.derived[uiStore.getState().activeLevelId]
    const A = shapeOf(s.selected, ds.doc, plan)
    const B = shapeOf(s.pair, ds.doc, plan)
    if (A && B) {
      const g = gapBetween(A, B)
      out.push({ a: { ...g.a, z: g.za }, b: { ...g.b, z: g.zb }, value: view === '2d' ? Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) : g.shortest })
    }
  }
  return out
}

export function MeasureOverlay({ view }: { view: ViewerView }) {
  const box = useRef<SVGSVGElement>(null)
  const [segs, setSegs] = useState<Seg[]>([])
  const lang = useUi((s) => s.lang)

  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const local = (p: [number, number] | null): [number, number] | null => (p ? [p[0] - r.left, p[1] - r.top] : null)
      const next: Seg[] = []
      for (const s of segmentsFor(view)) {
        const a = local(project(view, s.a))
        const b = s.b ? local(project(view, s.b)) : null
        if (!a || (s.b && !b)) continue
        next.push({ a, b, label: s.value === null ? '' : mmText(s.value, { lang, t }) })
      }
      const key = JSON.stringify(next.map((s) => [s.a.map(Math.round), s.b?.map(Math.round), s.label]))
      if (key !== last) {
        last = key
        setSegs(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [view, lang])

  return (
    <svg ref={box} className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" aria-hidden>
      {segs.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of at most two lines, redrawn every frame
        <g key={i}>
          {s.b && <line x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />}
          <circle cx={s.a[0]} cy={s.a[1]} r={4} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} />
          {s.b && <circle cx={s.b[0]} cy={s.b[1]} r={4} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} />}
          {s.b && s.label && <Pill x={(s.a[0] + s.b[0]) / 2} y={(s.a[1] + s.b[1]) / 2} text={s.label} />}
        </g>
      ))}
    </svg>
  )
}

function Pill({ x, y, text }: { x: number; y: number; text: string }) {
  const w = text.length * 7 + 14
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-w / 2} y={-11} width={w} height={22} rx={6} fill="var(--panel)" stroke="var(--border-strong)" />
      <text textAnchor="middle" dominantBaseline="central" fontSize={12} fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {text}
      </text>
    </g>
  )
}

// ───────────── the rail of tools ─────────────

export function ToolRail() {
  const tr = useT()
  const mode = useTools((s) => s.mode)
  const panel = useTools((s) => s.panel)
  const hide = useTools((s) => s.hide)
  const count = hide.refs.length + hide.cats.length + (hide.ceiling === false ? 1 : 0)
  return (
    <div className="pointer-events-auto absolute top-1/2 left-2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-0.5 shadow-pop">
      <IconBtn
        icon={MousePointer2}
        label={tr('Выбрать элемент — карточка с размерами')}
        tipSide="right"
        active={mode === 'select'}
        onClick={() => toolsStore.setState({ mode: 'select', points: [] })}
      />
      <IconBtn
        icon={Ruler}
        label={tr('Измерить расстояние между двумя точками')}
        tipSide="right"
        active={mode === 'measure'}
        onClick={() => toolsStore.setState({ mode: mode === 'measure' ? 'select' : 'measure', points: [], pairing: false })}
      />
      <div className="my-0.5 h-px w-5 bg-border" />
      <span className="relative">
        <IconBtn icon={EyeOff} label={tr('Скрыть элементы и категории')} tipSide="right" active={panel} onClick={() => toolsStore.setState({ panel: !panel })} />
        {count > 0 && (
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-[1rem] rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-medium text-accent-fg">
            {count}
          </span>
        )}
      </span>
    </div>
  )
}

// ───────────── panels ─────────────

function Panel({ title, onClose, children, className }: { title: ReactNode; onClose(): void; children: ReactNode; className?: string }) {
  const tr = useT()
  return (
    <div
      className={clsx(
        'dp-fade-in pointer-events-auto absolute z-30 flex max-h-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel text-xs shadow-pop',
        className,
      )}
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">{title}</div>
        <button type="button" aria-label={tr('Закрыть')} title={tr('Закрыть')} className="-mr-1 rounded p-0.5 text-muted hover:bg-hover hover:text-text" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-auto px-3 py-2">{children}</div>
    </div>
  )
}

/** the card sits at the right on a desktop, as a bottom sheet on a phone */
const CARD = 'top-12 right-2 w-[min(20rem,calc(100%-1rem))] max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:max-h-[45%] max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]'

function Rows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted">{r.label}</dt>
          <dd className="text-right break-words text-text" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Btn({ icon, children, onClick, active }: { icon?: ReactNode; children: ReactNode; onClick(): void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 transition-colors',
        active ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-panel-2 text-text hover:bg-hover',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function useInfoEnv() {
  const doc = useDoc((s) => s.doc)
  const derived = useDoc((s) => s.derived)
  const level = useUi((s) => s.activeLevelId)
  const catalog = useUi((s) => s.catalog)
  const lang = useUi((s) => s.lang)
  const plan = derived[level]
  return useMemo(() => ({ doc, plan, catalog, lang, t }), [doc, plan, catalog, lang])
}

export function ElementCard() {
  const tr = useT()
  const mode = useTools((s) => s.mode)
  const selected = useTools((s) => s.selected)
  const pair = useTools((s) => s.pair)
  const pairing = useTools((s) => s.pairing)
  const points = useTools((s) => s.points)
  const pointsView = useTools((s) => s.pointsView)
  const env = useInfoEnv()

  if (mode === 'measure') {
    const g = points.length === 2 ? pointGap(points[0], points[1]) : null
    const fmt = (v: number) => mmText(v, env)
    return (
      <Panel className={CARD} title={<div className="font-medium">{tr('Измерение')}</div>} onClose={() => toolsStore.setState({ mode: 'select', points: [] })}>
        {g ? (
          <div className="flex flex-col gap-2">
            <Rows
              rows={[
                { label: tr('Расстояние'), value: fmt(g.shortest) },
                { label: tr('По X'), value: fmt(g.dx) },
                { label: tr('По Y'), value: fmt(g.dy) },
                ...(pointsView === '3d' ? [{ label: tr('По высоте'), value: fmt(g.dz) }] : []),
              ]}
            />
            <div>
              <Btn onClick={() => toolsStore.setState({ points: [] })}>{tr('Заново')}</Btn>
            </div>
          </div>
        ) : (
          <div className="text-muted">{tr(points.length ? 'Кликните вторую точку' : 'Кликните первую точку')}</div>
        )}
      </Panel>
    )
  }

  if (!selected) return null
  const info = elementInfo(selected, env)
  if (!info) return null
  const hideable = selected.kind !== 'room' || !!env.doc.rooms[selected.id]
  let distance: { label: string; value: string }[] | null = null
  let pairName = ''
  if (pair) {
    const A = shapeOf(selected, env.doc, env.plan)
    const B = shapeOf(pair, env.doc, env.plan)
    if (A && B) {
      const g = gapBetween(A, B)
      const fmt = (v: number) => mmText(v, env)
      distance = [
        { label: tr('Кратчайшее'), value: fmt(g.shortest) },
        { label: tr('По X'), value: fmt(g.dx) },
        { label: tr('По Y'), value: fmt(g.dy) },
        { label: tr('По высоте'), value: fmt(g.dz) },
      ]
      pairName = elementInfo(pair, env)?.name ?? ''
    }
  }
  return (
    <Panel
      className={CARD}
      onClose={() => setSelected(null)}
      title={
        <div className="flex min-w-0 flex-col">
          <span className="text-[11px] text-muted">{info.type}</span>
          <span className="truncate text-[13px] font-medium" title={info.name}>
            {info.name}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Rows rows={info.rows} />
        {pairing && (
          <div className="flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5 text-accent">
            <span className="flex-1">{tr('Выберите второй элемент')}</span>
            <button type="button" className="hover:underline" onClick={() => toolsStore.setState({ pairing: false })}>
              {tr('Отмена')}
            </button>
          </div>
        )}
        {distance && (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <div className="truncate font-medium">{tr('Расстояние до «{name}»', { name: pairName })}</div>
            <Rows rows={distance} />
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {hideable && (
            <Btn icon={<EyeOff size={13} />} onClick={() => toolsStore.setState((s) => ({ hide: toggleRef(s.hide, selected, true) }))}>
              {tr('Скрыть')}
            </Btn>
          )}
          <Btn icon={<Ruler size={13} />} active={pairing} onClick={() => toolsStore.setState({ pairing: !pairing, pair: null })}>
            {tr('Расстояние до…')}
          </Btn>
        </div>
      </div>
    </Panel>
  )
}

export function HiddenPanel({ show3d }: { show3d: boolean }) {
  const tr = useT()
  const open = useTools((s) => s.panel)
  const hide = useTools((s) => s.hide)
  const env = useInfoEnv()
  const ceiling = useDoc((s) => s.doc.render.ceilingVisible)
  // the categories of the level on screen: switching levels counts again
  const lid = useUi((s) => s.activeLevelId)
  const counts = useMemo(() => {
    const out: Record<HideCat, number> = { furniture: 0, lighting: 0, doors: 0, windows: 0, electric: 0 }
    const asset = assetOf(env.doc)
    const tables: [EntityRef['kind'], Record<Id, { levelId?: Id; wallId?: Id }> | undefined][] = [
      ['item', env.doc.items],
      ['light', env.doc.lights],
      ['opening', env.doc.openings],
      ['electric', env.doc.electrical],
    ]
    for (const [kind, table] of tables)
      for (const id in table ?? {}) {
        const o = table?.[id]
        const level = o?.levelId ?? (o?.wallId ? env.doc.walls[o.wallId]?.levelId : undefined)
        if (level !== lid) continue
        const c = catOf({ kind, id }, env.doc, asset)
        if (c) out[c]++
      }
    return out
  }, [env.doc, lid])
  if (!open) return null
  const set = (fn: (h: HideState) => HideState) => toolsStore.setState((s) => ({ hide: fn(s.hide) }))
  const nameOf = (r: EntityRef) => {
    const info = elementInfo(r, env)
    if (info) return info.name
    const def = entityKind(r.kind)
    return def ? def.title[env.lang] : r.id
  }
  const any = hide.refs.length > 0 || hide.cats.length > 0 || hide.ceiling !== undefined
  return (
    <Panel
      className="top-1/2 left-14 w-[min(17rem,calc(100%-4.5rem))] -translate-y-1/2 max-sm:top-auto max-sm:bottom-2 max-sm:translate-y-0"
      title={<div className="font-medium">{tr('Скрытое')}</div>}
      onClose={() => toolsStore.setState({ panel: false })}
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <div className="text-[11px] text-muted">{tr('Категории')}</div>
          {HIDE_CATS.filter((c) => counts[c] > 0).map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
              <input type="checkbox" checked={!hide.cats.includes(c)} onChange={(e) => set((h) => toggleCat(h, c, !e.currentTarget.checked))} />
              <span className="flex-1">{tr(HIDE_CAT_NAMES[c])}</span>
              <span className="text-muted">{counts[c]}</span>
            </label>
          ))}
          {show3d && (
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
              <input type="checkbox" checked={ceiling} onChange={(e) => setCeiling(e.currentTarget.checked)} />
              <span className="flex-1">{tr('Потолок')}</span>
            </label>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-[11px] text-muted">{tr('Скрытые элементы')}</div>
          {hide.refs.length === 0 && <div className="px-1 text-muted">{tr('Ничего не скрыто')}</div>}
          {hide.refs.map((r) => (
            <div key={`${r.kind}:${r.id}`} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
              <span className="min-w-0 flex-1 truncate">{nameOf(r)}</span>
              <button type="button" title={tr('Показать')} aria-label={tr('Показать')} className="rounded p-0.5 text-muted hover:text-text" onClick={() => set((h) => toggleRef(h, r, false))}>
                <Eye size={13} />
              </button>
            </div>
          ))}
        </div>
        {any && (
          <div>
            <Btn icon={<Eye size={13} />} onClick={() => set(() => EMPTY_HIDE)}>
              {tr('Показать всё')}
            </Btn>
          </div>
        )}
      </div>
    </Panel>
  )
}

/** the ceiling toggle (toolbar and the hidden panel): kept in the hash when it differs from the author's */
let authorCeiling = true
export function setCeiling(visible: boolean): void {
  toolsStore.setState((s) => {
    const { ceiling: _, ...rest } = s.hide
    return { hide: visible === authorCeiling ? rest : { ...rest, ceiling: visible } }
  })
}

// ───────────── export ─────────────

let host3d: HTMLElement | null = null
/** the 3D view's element (the PNG is made at its size) */
export function setHost3d(el: HTMLElement | null): void {
  host3d = el
}

export function ExportMenu({ title, pristine, allowFile }: { title: string; pristine: Doc; allowFile: boolean }) {
  const tr = useT()
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const run = async (label: string, make: () => Promise<Blob> | Blob, name: string) => {
    if (timer.current) clearTimeout(timer.current)
    setStatus({ text: tr('Готовлю {what}…', { what: label }) })
    try {
      saveBlob(await make(), name)
      setStatus(null)
    } catch (err) {
      console.error('[doplan viewer] export failed', err)
      setStatus({ text: tr('Не удалось сохранить {what}', { what: label }), error: true })
      timer.current = setTimeout(() => setStatus(null), 5000)
    }
  }
  const items = (): MenuEntry[] => {
    const editor = handles.editor2d
    const engine = handles.engine3d
    const level = uiStore.getState().activeLevelId
    // the 3D view renders only while it is on screen (a hidden canvas gives an empty picture)
    const r3d = host3d?.getBoundingClientRect()
    const no3d = !engine || !r3d || r3d.width < 16 || r3d.height < 16
    const list: MenuEntry[] = [
      { type: 'header', label: tr('Скачать') },
      { label: tr('План, PNG'), icon: Image, disabled: !editor, onSelect: () => editor && void run('PNG', () => planPng(editor), fileName(title, ' — план.png')) },
      { label: tr('План с размерами, PDF'), icon: FileText, onSelect: () => void run('PDF', () => planPdf(docStore.getState().doc, level, title), fileName(title, ' — план.pdf')) },
      { label: no3d ? tr('3D-вид, PNG (откройте 3D)') : tr('3D-вид, PNG'), icon: Camera, disabled: no3d, onSelect: () => engine && host3d && void run('PNG', () => scenePng(engine, host3d as HTMLElement), fileName(title, ' — 3D.png')) },
      { label: engine ? tr('3D-модель, GLB') : tr('3D-модель, GLB (откройте 3D)'), icon: Box, disabled: !engine, onSelect: () => engine && void run('GLB', () => sceneGlb(engine), fileName(title, '.glb')) },
    ]
    if (allowFile) list.push({ type: 'separator' }, { label: tr('Файл плана для doplan (.doplan)'), icon: FileDown, onSelect: () => void run('.doplan', () => planFile(pristine), fileName(title, '.doplan')) })
    return list
  }
  return (
    <>
      <DropdownMenu
        align="right"
        items={items}
        trigger={({ open, toggle }) => <IconBtn icon={Download} label={tr('Скачать')} active={open} onClick={toggle} />}
      />
      {status && (
        <div
          role="status"
          className={clsx(
            'dp-fade-in fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-panel px-3 py-1.5 text-xs shadow-pop',
            status.error ? 'border-danger text-danger' : 'border-border-strong text-text',
          )}
        >
          {!status.error && <LoaderCircle size={14} className="dp-spin text-accent" />}
          {status.text}
        </div>
      )}
    </>
  )
}
