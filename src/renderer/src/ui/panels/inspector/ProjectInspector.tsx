import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, FolderCog, Plus, Trash } from 'lucide-react'
import type { Doc, DocSettings, Id, Level } from '@core/types'
import { newId, removeEntities } from '@core'
import { useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { cn, focusRing, IconButton, Input, NumberInput, Row, Section, Segmented, Toggle } from '@/ui/kit'
import { tx } from '../common/catalog'
import { refsOnLevel } from '../common/edits'
import { ProjectFolderSection } from '../ProjectFolderDialogs'
import { Hint, InspectorHeader } from './shared'

function setSettings(label: string, patch: Partial<DocSettings>, merge?: string) {
  tx(label, (d) => Object.assign(d.settings, patch), merge)
}

/** copies walls, nodes, openings and rooms of one level onto another (new ids) */
function copyStructure(d: Doc, from: Id, to: Id) {
  const nodeMap = new Map<Id, Id>()
  for (const n of Object.values(d.nodes)) {
    if (n.levelId !== from) continue
    const id = newId('n')
    nodeMap.set(n.id, id)
    d.nodes[id] = { ...n, id, levelId: to }
  }
  const wallMap = new Map<Id, Id>()
  for (const w of Object.values(d.walls)) {
    if (w.levelId !== from) continue
    const a = nodeMap.get(w.a)
    const b = nodeMap.get(w.b)
    if (!a || !b) continue
    const id = newId('w')
    wallMap.set(w.id, id)
    d.walls[id] = { ...JSON.parse(JSON.stringify(w)), id, levelId: to, a, b }
  }
  for (const o of Object.values(d.openings)) {
    const wallId = wallMap.get(o.wallId)
    if (!wallId) continue
    const id = newId('o')
    d.openings[id] = { ...JSON.parse(JSON.stringify(o)), id, wallId }
  }
  for (const r of Object.values(d.rooms)) {
    if (r.levelId !== from) continue
    const id = newId('r')
    d.rooms[id] = { ...JSON.parse(JSON.stringify(r)), id, levelId: to }
  }
}

export function ProjectInspector() {
  const t = useT()
  const meta = useDoc((s) => s.doc.meta)
  const settings = useDoc((s) => s.doc.settings)
  const levels = useDoc((s) => s.doc.levels)
  const order = useDoc((s) => s.doc.levelOrder)
  const active = useUi((s) => s.activeLevelId)

  const addLevel = (copyFrom?: Id) => {
    const last = levels[order[order.length - 1]]
    const id = newId('lv')
    const level: Level = {
      id,
      name: `${t('Этаж')} ${order.length + 1}`,
      elevation: last ? last.elevation + last.height + 300 : 0,
      height: last?.height ?? settings.wallHeight,
      visible: true,
    }
    tx(copyFrom ? 'Копировать этаж' : 'Добавить этаж', (d) => {
      d.levels[id] = level
      d.levelOrder.push(id)
      if (copyFrom) copyStructure(d, copyFrom, id)
    })
    uiStore.getState().set({ activeLevelId: id, selection: [] })
  }

  const removeLevel = (id: Id) => {
    if (order.length <= 1) return
    const lv = levels[id]
    if (!window.confirm(`${t('Удалить этаж')} «${lv?.name ?? ''}» ${t('со всем содержимым?')}`)) return
    tx('Удалить этаж', (d) => {
      removeEntities(d, refsOnLevel(d, id))
      delete d.levels[id]
      d.levelOrder = d.levelOrder.filter((x) => x !== id)
    })
    if (active === id) uiStore.getState().set({ activeLevelId: order.find((x) => x !== id) ?? order[0], selection: [] })
  }

  const move = (id: Id, dir: -1 | 1) =>
    tx('Порядок этажей', (d) => {
      const i = d.levelOrder.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.levelOrder.length) return
      const tmp = d.levelOrder[i]
      d.levelOrder[i] = d.levelOrder[j]
      d.levelOrder[j] = tmp
    })

  const setLevel = (id: Id, label: string, fn: (l: Level) => void, merge?: string) =>
    tx(label, (d) => {
      const l = d.levels[id]
      if (l) fn(l)
    }, merge)

  return (
    <div>
      <InspectorHeader icon={<FolderCog />} title={meta.name || t('Проект')} subtitle={t('Ничего не выделено — настройки проекта')} canDuplicate={false} canDelete={false} />
      <Section title={t('Проект')} id="insp.proj.main">
        <Row label={t('Название')}>
          <Input value={meta.name} onChange={(v) => tx('Название проекта', (d) => (d.meta.name = v), 'project.name')} onKeyDown={(e) => e.stopPropagation()} />
        </Row>
        <Row label={t('Единицы')}>
          <Segmented
            value={settings.units}
            onChange={(u) => setSettings('Единицы измерения', { units: u })}
            options={[
              { value: 'mm', label: t('мм') },
              { value: 'cm', label: t('см') },
              { value: 'm', label: t('м') },
            ]}
          />
        </Row>
      </Section>

      <ProjectFolderSection />

      <Section title={t('Новые стены')} id="insp.proj.walls">
        <Row label={t('Толщина')}>
          <NumberInput kind="length" value={settings.wallThickness} min={10} max={2000} round={1} onChange={(v, g) => setSettings('Толщина по умолчанию', { wallThickness: v }, `set.wt.${g}`)} />
        </Row>
        <Row label={t('Высота')}>
          <NumberInput kind="length" value={settings.wallHeight} min={500} max={20000} round={1} onChange={(v, g) => setSettings('Высота по умолчанию', { wallHeight: v }, `set.wh.${g}`)} />
        </Row>
      </Section>

      <Section title={t('Сетка и привязки')} id="insp.proj.grid">
        <Row label={t('Шаг сетки')}>
          <NumberInput kind="length" value={settings.gridMm} min={1} max={5000} round={1} onChange={(v, g) => setSettings('Шаг сетки', { gridMm: v }, `set.grid.${g}`)} />
        </Row>
        <Toggle checked={settings.snapGrid} onChange={(v) => setSettings('Привязка к сетке', { snapGrid: v })} label={t('Привязка к сетке')} />
        <Toggle checked={settings.snapObjects} onChange={(v) => setSettings('Привязка к объектам', { snapObjects: v })} label={t('Привязка к объектам')} />
        <Toggle checked={settings.snapAngle} onChange={(v) => setSettings('Привязка углов', { snapAngle: v })} label={t('Привязка углов (15°)')} />
      </Section>

      <Section title={t('Отображение на плане')} id="insp.proj.show">
        <Toggle checked={settings.showDimensions} onChange={(v) => setSettings('Показ размеров', { showDimensions: v })} label={t('Размеры стен')} />
        <Toggle checked={settings.showItemSizes} onChange={(v) => setSettings('Показ размеров мебели', { showItemSizes: v })} label={t('Размеры мебели')} />
        <Toggle checked={settings.showAreas} onChange={(v) => setSettings('Показ площадей', { showAreas: v })} label={t('Площади помещений')} />
        <Toggle checked={settings.showFurniture2d} onChange={(v) => setSettings('Показ мебели', { showFurniture2d: v })} label={t('Мебель на плане')} />
      </Section>

      <Section
        title={t('Этажи')}
        id="insp.proj.levels"
        actions={
          <>
            <IconButton size="sm" icon={<Copy />} label={t('Копировать текущий этаж (стены, проёмы, помещения)')} onClick={() => addLevel(active)} />
            <IconButton size="sm" icon={<Plus />} label={t('Добавить этаж')} onClick={() => addLevel()} />
          </>
        }
      >
        <ul className="flex flex-col gap-1.5">
          {[...order].reverse().map((id) => {
            const lv = levels[id]
            if (!lv) return null
            const isActive = id === active
            const idx = order.indexOf(id)
            return (
              <li
                key={id}
                className={cn('flex flex-col gap-1 rounded-md border p-1.5', isActive ? 'border-[var(--accent)]' : 'border-[var(--border)]')}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={t('Сделать активным')}
                    title={t('Сделать активным')}
                    onClick={() => uiStore.getState().set({ activeLevelId: id, selection: [] })}
                    className={cn('size-3.5 shrink-0 rounded-full border-2', isActive ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--muted)]', focusRing)}
                  />
                  <Input
                    value={lv.name}
                    onChange={(v) => setLevel(id, 'Название этажа', (l) => (l.name = v), `level.${id}.name`)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="h-6"
                  />
                  <IconButton size="sm" icon={lv.visible ? <Eye /> : <EyeOff />} label={lv.visible ? t('Скрыть') : t('Показать')} onClick={() => setLevel(id, 'Видимость этажа', (l) => (l.visible = !l.visible))} />
                  <IconButton size="sm" icon={<ArrowUp />} label={t('Выше')} disabled={idx === order.length - 1} onClick={() => move(id, 1)} />
                  <IconButton size="sm" icon={<ArrowDown />} label={t('Ниже')} disabled={idx === 0} onClick={() => move(id, -1)} />
                  <IconButton size="sm" variant="danger" icon={<Trash />} label={t('Удалить этаж')} disabled={order.length <= 1} onClick={() => removeLevel(id)} />
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <NumberInput kind="length" label={t('Отм.')} title={t('Отметка пола над нулём')} value={lv.elevation} round={1} onChange={(v, g) => setLevel(id, 'Отметка этажа', (l) => (l.elevation = v), `level.${id}.el.${g}`)} />
                  <NumberInput kind="length" label={t('Выс.')} title={t('Высота этажа')} value={lv.height} min={500} round={1} onChange={(v, g) => setLevel(id, 'Высота этажа', (l) => (l.height = v), `level.${id}.h.${g}`)} />
                </div>
              </li>
            )
          })}
        </ul>
        <Hint>{t('Нижний этаж показывается полупрозрачно под активным.')}</Hint>
      </Section>
    </div>
  )
}
