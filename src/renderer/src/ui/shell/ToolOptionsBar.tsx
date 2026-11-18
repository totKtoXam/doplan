import { Armchair, Bug, ChevronDown, Eye, Hash, Info, ListChecks, Maximize, RefreshCw, Ruler, RulerDimensionLine } from 'lucide-react'
import { useEffect } from 'react'
import type { DocSettings, OpeningKind, WallKind } from '@core/types'
import { useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { api } from '@/store/api'
import { uiStore, useUi } from '@/store/ui'
import { accuracyStore, useAccuracy } from '@/store/accuracy'
import { DropdownMenu, IconBtn, MiniNumber, MiniSelect, Sep, type MenuEntry } from './primitives'
import { activateTool, PLAN_ONLY_TOOLS, toolDef, TOOLS } from './tools'
import '@/ui/shellI18n'

const DOOR_KINDS: OpeningKind[] = ['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'arch', 'opening']
const WINDOW_KINDS: OpeningKind[] = ['window', 'frenchWindow', 'balconyDoor', 'balconyBlock']

export const OPENING_NAMES: Record<OpeningKind, string> = {
  door: 'Дверь',
  doubleDoor: 'Двустворчатая дверь',
  slidingDoor: 'Раздвижная дверь',
  entranceDoor: 'Входная дверь',
  arch: 'Арка',
  opening: 'Проём',
  window: 'Окно',
  frenchWindow: 'Французское окно',
  balconyDoor: 'Балконная дверь',
  balconyBlock: 'Балконный блок',
}

export const WALL_KIND_NAMES: Record<WallKind, string> = {
  wall: 'Стена',
  partition: 'Перегородка',
  parapet: 'Парапет',
  glazing: 'Остекление',
  virtual: 'Граница зоны',
}

/** sensible defaults when switching the wall kind */
const WALL_KIND_PRESET: Record<WallKind, { thickness?: number; height?: number }> = {
  wall: { thickness: 200 },
  partition: { thickness: 100 },
  parapet: { thickness: 120, height: 1000 },
  glazing: { thickness: 70 },
  virtual: { thickness: 0 },
}

export function setSetting<K extends keyof DocSettings>(key: K, value: DocSettings[K]) {
  docStore.getState().transact(
    'Настройки плана',
    (d) => {
      d.settings[key] = value
    },
    { merge: `settings.${key}` },
  )
}

/**
 * The tool bar above the plan: the "verb" tools (select, pan, measure, paint, …), the name and
 * options of the active tool, and the «Вид» menu with the display toggles of the plan and the units.
 * Snaps live in the status bar; the tools that place things are started from the left sections.
 */
export function ToolOptionsBar() {
  const t = useT()
  const tool = useUi((s) => s.tool)
  const wallKind = useUi((s) => s.wallKind)
  const wallThickness = useUi((s) => s.wallThickness)
  const wallHeight = useUi((s) => s.wallHeight)
  const openingKind = useUi((s) => s.openingKind)
  const paintFinish = useUi((s) => s.paintFinish)
  const placingAssetId = useUi((s) => s.placingAssetId)
  const getMaterial = useUi((s) => s.getMaterial)
  const getAsset = useUi((s) => s.getAsset)
  const lang = useUi((s) => s.lang)
  const settings = useDoc((s) => s.doc.settings)
  const mode = useUi((s) => s.mode)
  const legend = useAccuracy((s) => s.legend)
  const checklist = useAccuracy((s) => s.checklist)
  // project-local materials/assets may change
  useDoc((s) => s.doc.materials)

  // keep the opening kind consistent with the active tool
  useEffect(() => {
    if (tool === 'door' && !DOOR_KINDS.includes(openingKind)) uiStore.getState().set({ openingKind: 'door' })
    if (tool === 'window' && !WINDOW_KINDS.includes(openingKind)) uiStore.getState().set({ openingKind: 'window' })
  }, [tool, openingKind])

  const def = toolDef(tool)
  const set = uiStore.getState().set

  const paintMat = paintFinish ? getMaterial(paintFinish.materialId) : undefined
  const placing = placingAssetId ? getAsset(placingAssetId) : undefined
  const nameOf = (o: { name: string; nameRu?: string } | undefined) => (o ? (lang === 'ru' ? (o.nameRu ?? o.name) : o.name) : '')

  const planOnly = mode === '3d'
  const viewItems = (): MenuEntry[] => [
    { type: 'header', label: t('На плане') },
    { label: t('Размеры'), icon: Ruler, checked: settings.showDimensions, keepOpen: true, disabled: planOnly, onSelect: () => setSetting('showDimensions', !settings.showDimensions) },
    { label: t('Размеры мебели (Ш×Г)'), icon: RulerDimensionLine, checked: settings.showItemSizes, keepOpen: true, disabled: planOnly, onSelect: () => setSetting('showItemSizes', !settings.showItemSizes) },
    { label: t('Площади комнат'), icon: Hash, checked: settings.showAreas, keepOpen: true, disabled: planOnly, onSelect: () => setSetting('showAreas', !settings.showAreas) },
    { label: t('Мебель на плане'), icon: Armchair, checked: settings.showFurniture2d, keepOpen: true, disabled: planOnly, onSelect: () => setSetting('showFurniture2d', !settings.showFurniture2d) },
    { label: t('Легенда: откуда размеры'), icon: Info, checked: legend, keepOpen: true, disabled: planOnly, onSelect: () => accuracyStore.getState().setLegend(!legend) },
    { label: t('Чек-лист обмера'), icon: ListChecks, checked: checklist, keepOpen: true, onSelect: () => accuracyStore.getState().setChecklist(!checklist) },
    { type: 'separator' },
    { type: 'header', label: t('Единицы') },
    ...(['mm', 'cm', 'm'] as const).map((u): MenuEntry => ({ label: t(u === 'mm' ? 'Миллиметры' : u === 'cm' ? 'Сантиметры' : 'Метры'), checked: settings.units === u, onSelect: () => setSetting('units', u) })),
    { type: 'separator' },
    { type: 'header', label: t('Окно программы') },
    { label: t('Во весь экран'), icon: Maximize, kbd: 'F11', onSelect: () => api.window.command('fullscreen') },
    ...(import.meta.env.DEV
      ? ([
          { label: t('Перезагрузить'), icon: RefreshCw, kbd: 'Ctrl+R', onSelect: () => api.window.command('reload') },
          { label: t('Инструменты разработчика'), icon: Bug, kbd: 'Ctrl+Shift+I', onSelect: () => api.window.command('devtools') },
        ] satisfies MenuEntry[])
      : []),
  ]

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-panel px-1.5 text-[11px]">
      <div className="flex shrink-0 items-center gap-0.5" role="toolbar" aria-label={t('Инструменты')}>
        {TOOLS.map((d, i) =>
          d === 'sep' ? (
            <div key={`sep${i}`} className="mx-1 h-4 w-px bg-border" />
          ) : d.place !== 'bar' ? null : (
            <IconBtn
              key={d.id}
              icon={d.icon}
              size="sm"
              label={t(d.label)}
              kbd={d.key}
              active={tool === d.id}
              disabled={planOnly && PLAN_ONLY_TOOLS.has(d.id)}
              onClick={() => activateTool(d.id, t)}
            />
          ),
        )}
      </div>
      {/* a tool of the bar is already lit up there; name the others (started from a section) */}
      {(def?.place !== 'bar' || tool === 'paint') && (
        <>
          <Sep />
          <span className="shrink-0 px-1 font-semibold text-text">{def ? t(def.label) : tool === 'item' ? t('Расстановка') : t(tool)}</span>
        </>
      )}

      {(tool === 'wall' || tool === 'room') && (
        <>
          <Sep />
          <MiniSelect
            title={t('Тип стены')}
            value={wallKind}
            options={(Object.keys(WALL_KIND_NAMES) as WallKind[]).map((k) => ({ value: k, label: t(WALL_KIND_NAMES[k]) }))}
            onChange={(k) => {
              const p = WALL_KIND_PRESET[k]
              const patch: { wallKind: WallKind; wallThickness?: number; wallHeight?: number } = { wallKind: k }
              if (p.thickness !== undefined) patch.wallThickness = p.thickness
              // leaving the parapet preset restores the full storey height
              if (p.height !== undefined) patch.wallHeight = p.height
              else if (wallHeight <= 1200) patch.wallHeight = settings.wallHeight
              set(patch)
            }}
          />
          <span className="shrink-0 text-muted">{t('Толщина')}</span>
          <MiniNumber value={wallThickness} min={0} max={2000} step={10} suffix={t('мм')} onChange={(v) => set({ wallThickness: v })} />
          <span className="shrink-0 text-muted">{t('Высота')}</span>
          <MiniNumber value={wallHeight} min={100} max={20000} step={50} suffix={t('мм')} onChange={(v) => set({ wallHeight: v })} />
        </>
      )}

      {(tool === 'door' || tool === 'window') && (
        <>
          <Sep />
          <MiniSelect
            title={t('Тип проёма')}
            value={openingKind}
            options={(tool === 'door' ? DOOR_KINDS : WINDOW_KINDS).map((k) => ({ value: k, label: t(OPENING_NAMES[k]) }))}
            onChange={(k) => set({ openingKind: k, openingPreset: null })}
          />
        </>
      )}

      {tool === 'paint' && (
        <>
          {paintMat ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="h-4 w-4 rounded border border-border-strong" style={{ background: paintFinish?.tint ?? paintMat.color }} />
              {nameOf(paintMat)}
            </span>
          ) : (
            <span className="shrink-0 text-muted">{t('Выберите материал в каталоге слева')}</span>
          )}
        </>
      )}

      {tool === 'item' && (
        <>
          <Sep />
          <span className="shrink-0 text-muted">{placing ? nameOf(placing) : t('Выберите предмет в каталоге')}</span>
        </>
      )}

      {tool === 'calibrate' && (
        <>
          <Sep />
          <span className="shrink-0 text-muted">{t('Укажите две точки с известным расстоянием')}</span>
        </>
      )}

      <div className="flex-1" />

      <DropdownMenu
        align="right"
        items={viewItems}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            title={t('Что показывать на плане, единицы, окно')}
            className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-2 ${open ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-text'}`}
          >
            <Eye size={13} strokeWidth={1.75} />
            {t('Вид')}
            <ChevronDown size={12} />
          </button>
        )}
      />
    </div>
  )
}
