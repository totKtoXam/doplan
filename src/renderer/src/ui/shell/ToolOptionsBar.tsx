import { Grid3x3, Magnet, Ruler, Armchair, Hash, Info, ListChecks } from 'lucide-react'
import { useEffect } from 'react'
import type { DocSettings, OpeningKind, WallKind } from '@core/types'
import { useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { accuracyStore, useAccuracy } from '@/store/accuracy'
import { MiniNumber, MiniSelect, MiniToggle, Sep } from './primitives'
import { toolDef } from './ToolRail'

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

const GRID_SIZES = [10, 50, 100, 250, 500, 1000]

function setSetting<K extends keyof DocSettings>(key: K, value: DocSettings[K]) {
  docStore.getState().transact(
    'Настройки плана',
    (d) => {
      d.settings[key] = value
    },
    { merge: `settings.${key}` },
  )
}

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

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-panel px-2 text-[11px]">
      <span className="shrink-0 pr-1 font-semibold text-text">{def ? t(def.label) : tool === 'item' ? t('Расстановка') : t(tool)}</span>

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
          <Sep />
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

      <Magnet size={13} className="shrink-0 text-muted" />
      <MiniToggle label={<><Grid3x3 size={12} />{t('Сетка')}</>} title={t('Привязка к сетке')} checked={settings.snapGrid} onChange={(v) => setSetting('snapGrid', v)} />
      <MiniToggle label={t('Объекты')} title={t('Привязка к стенам и узлам')} checked={settings.snapObjects} onChange={(v) => setSetting('snapObjects', v)} />
      <MiniToggle label={t('Углы')} title={t('Привязка к углам 15°')} checked={settings.snapAngle} onChange={(v) => setSetting('snapAngle', v)} />
      <MiniSelect
        title={t('Шаг сетки')}
        value={settings.gridMm}
        options={GRID_SIZES.map((g) => ({ value: g, label: g >= 1000 ? `${g / 1000} ${t('м')}` : g >= 100 ? `${g / 10} ${t('см')}` : `${g} ${t('мм')}` }))}
        onChange={(v) => setSetting('gridMm', v)}
      />
      <Sep />
      <MiniToggle label={<Ruler size={12} />} title={t('Размеры')} checked={settings.showDimensions} onChange={(v) => setSetting('showDimensions', v)} />
      <MiniToggle label={t('W×D')} title={t('Размеры мебели')} checked={settings.showItemSizes} onChange={(v) => setSetting('showItemSizes', v)} />
      <MiniToggle label={<Info size={12} />} title={t('Легенда: откуда размеры')} checked={legend} onChange={(v) => accuracyStore.getState().setLegend(v)} />
      <MiniToggle label={<ListChecks size={12} />} title={t('Чек-лист обмера')} checked={checklist} onChange={(v) => accuracyStore.getState().setChecklist(v)} />
      <MiniToggle label={<Hash size={12} />} title={t('Площади комнат')} checked={settings.showAreas} onChange={(v) => setSetting('showAreas', v)} />
      <MiniToggle label={<Armchair size={12} />} title={t('Мебель на плане')} checked={settings.showFurniture2d} onChange={(v) => setSetting('showFurniture2d', v)} />
      <MiniSelect
        title={t('Единицы')}
        value={settings.units}
        options={[
          { value: 'mm', label: t('мм') },
          { value: 'cm', label: t('см') },
          { value: 'm', label: t('м') },
        ]}
        onChange={(v) => setSetting('units', v)}
      />
    </div>
  )
}
