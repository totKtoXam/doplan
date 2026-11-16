/**
 * Layers panel («Объекты»): every object of the active level as a tree — by kind or by user layer —
 * with visibility (eye), lock, selection synced with the plan and 3D both ways, rename, search,
 * a kind filter, deletion and moving objects between user layers (menu or drag & drop).
 * The kinds come from the core registry (@core/layers); see ./kinds.ts for icons and custom selection.
 * Every change goes through `docStore.transact`, so it is undoable.
 */
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderInput, Lock, LockOpen, Pencil, Plus, Trash, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import {
  addLayer,
  assignLayer,
  buildLayerOutline,
  buildOutline,
  deleteLayer,
  entityKind,
  entityKinds,
  isHidden,
  moveLayer,
  nextLayerName,
  orderedLayers,
  outlineMatches,
  refKey,
  renameEntity,
  renameLayer,
  setGroupFlag,
  setHidden,
  setLayerFlag,
  setLocked,
  unlockedRefs,
  type OutlineRow,
} from '@core'
import type { EntityRef, Id, UserLayer } from '@core/types'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { docStore, useDoc } from '@/store/document'
import { deleteMark } from '@/store/marks'
import { uiStore, useUi } from '@/store/ui'
import { SearchInput, Segmented, Select } from '@/ui/kit'
import { ContextMenu, IconBtn, type MenuEntry } from '@/ui/shell/primitives'
import { displayName, lookupAsset } from '../common/catalog'
import { customSelections, customSelectionVersion, kindIcon, kindSelection, subscribeCustomSelection } from './kinds'
import './i18n'

type Mode = 'types' | 'layers'
type Ref = { kind: string; id: Id }

const DND_TYPE = 'application/x-doplan-refs'

interface Section {
  key: string
  title: string
  icon?: LucideIcon
  /** by kind: the kind; by layer: undefined */
  kind?: string
  /** by layer: the layer (null = «no layer») */
  layer?: UserLayer | null
  hidden: boolean
  locked: boolean
  rows: OutlineRow[]
  /** objects before filtering */
  total: number
}

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

const rowKey = (r: { ref: Ref }): string => refKey(r.ref.kind, r.ref.id)

function stdRefs(refs: readonly Ref[]): EntityRef[] {
  return refs.filter((r) => !kindSelection(r.kind)) as EntityRef[]
}

/** replaces (additive = false) or toggles (additive = true) the selection across uiStore and custom selections */
function selectRefs(refs: readonly Ref[], additive: boolean): void {
  const ui = uiStore.getState()
  ui.select(stdRefs(refs), additive)
  for (const [kind, sel] of customSelections()) {
    const ids = refs.filter((r) => r.kind === kind).map((r) => r.id)
    if (additive && !ids.length) continue
    sel.select(ids, additive)
  }
}

/**
 * drops every object that is hidden now (own flag, group, layer or parent wall) from the selection,
 * so a later Delete never removes something the user cannot see
 */
function deselectHidden(): void {
  const doc = docStore.getState().doc
  const ui = uiStore.getState()
  const next = ui.selection.filter((r) => !isHidden(doc, r))
  if (next.length !== ui.selection.length) ui.select(next)
  for (const [kind, sel] of customSelections()) {
    const ids = sel.selected().filter((id) => isHidden(doc, { kind, id }))
    if (ids.length) sel.select(ids, true)
  }
}

function deleteRefs(refs: readonly Ref[]): void {
  const doc = docStore.getState().doc
  const free = unlockedRefs(doc, refs)
  if (!free.length) return
  for (const r of free) if (r.kind === 'annotation') deleteMark(r.id)
  const std = stdRefs(free)
  if (!std.length) return
  uiStore.getState().select(std)
  actions.deleteSelection()
}

export function LayersPanel({ className }: { className?: string }) {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const catalog = useUi((s) => s.catalog)
  const activeLevelId = useUi((s) => s.activeLevelId)
  const selection = useUi((s) => s.selection)
  const doc = useDoc((s) => s.doc)
  const customVersion = useSyncExternalStore(subscribeCustomSelection, customSelectionVersion)
  const levelId = doc.levels[activeLevelId] ? activeLevelId : doc.levelOrder[0]

  const [mode, setModeState] = useState<Mode>(() => readPref<Mode>('doplan.layers.mode', 'types', ['types', 'layers']))
  const setMode = (m: Mode) => {
    setModeState(m)
    writePref('doplan.layers.mode', m)
  }
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuEntry[] } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  /** the row the user just clicked or reached with the arrows: the list keeps it in view */
  const focusKey = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const kindTitle = (kind: string): string => entityKind(kind)?.title[lang] ?? kind

  const sections = useMemo<Section[]>(() => {
    const env = {
      lang,
      assetName: (id: Id) => {
        const a = lookupAsset(id)
        return a ? displayName(a, lang) : undefined
      },
    }
    const title = (kind: string) => entityKind(kind)?.title[lang] ?? kind
    const keep = (r: OutlineRow) => (!kindFilter || r.ref.kind === kindFilter) && outlineMatches(r, title(r.ref.kind), query)
    if (mode === 'types') {
      return buildOutline(doc, levelId, env)
        .map((g) => ({
          key: `k:${g.kind}`,
          title: g.title,
          icon: kindIcon(g.icon),
          kind: g.kind,
          hidden: g.hidden,
          locked: g.locked,
          rows: g.rows.filter(keep),
          total: g.rows.length,
        }))
        .filter((s) => s.rows.length > 0)
    }
    return buildLayerOutline(doc, levelId, env)
      .map((l) => ({
        key: `l:${l.layer?.id ?? ''}`,
        title: l.layer ? l.layer.name : lang === 'ru' ? 'Без слоя' : 'No layer',
        layer: l.layer,
        hidden: l.layer?.hidden === true,
        locked: l.layer?.locked === true,
        rows: l.rows.filter(keep),
        total: l.rows.length,
      }))
      .filter((s) => s.layer || s.total > 0 || !orderedLayers(doc).length)
    // catalog: item names come from the asset catalog
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, levelId, lang, mode, query, kindFilter, catalog])

  const filtering = query.trim() !== '' || kindFilter !== ''
  const isCollapsed = (s: Section) => !filtering && collapsed.has(s.key)
  const flatRows = useMemo(() => sections.flatMap((s) => (isCollapsed(s) ? [] : s.rows)), [sections, collapsed, filtering]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedKeys = useMemo(() => {
    const keys = new Set(selection.map((r) => refKey(r.kind, r.id)))
    for (const [kind, sel] of customSelections()) for (const id of sel.selected()) keys.add(refKey(kind, id))
    return keys
    // customVersion: custom selections changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, customVersion])

  // a selection made on the plan / in 3D: open its group and scroll to it
  useEffect(() => {
    if (!selectedKeys.size) return
    const open = sections.filter((s) => collapsed.has(s.key) && s.rows.some((r) => selectedKeys.has(rowKey(r))))
    if (open.length) {
      setCollapsed((c) => {
        const n = new Set(c)
        for (const s of open) n.delete(s.key)
        return n
      })
    }
    const id = requestAnimationFrame(() => {
      const list = listRef.current
      if (!list) return
      // a selection made in the panel keeps its row in view; one made on the plan / in 3D shows the first selected row
      const key = focusKey.current
      focusKey.current = null
      const el = key
        ? [...list.querySelectorAll<HTMLElement>('[data-key]')].find((e) => e.dataset.key === key)
        : list.querySelector<HTMLElement>('[data-selected="true"]')
      el?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(id)
    // only when the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys])

  const transact = (label: string, fn: (d: typeof doc) => void) => docStore.getState().transact(label, fn)

  /** the rows an action on `row` applies to: the whole selection when the row is part of it */
  const targetsOf = (row: OutlineRow): Ref[] => {
    if (!selectedKeys.has(rowKey(row))) return [row.ref]
    const out: Ref[] = []
    for (const s of sections) for (const r of s.rows) if (selectedKeys.has(rowKey(r))) out.push(r.ref)
    return out.length ? out : [row.ref]
  }

  const toggleHidden = (refs: Ref[], hide: boolean) => {
    transact(hide ? t('Скрыть') : t('Показать'), (d) => {
      setHidden(d, refs, hide)
    })
    if (hide) deselectHidden()
  }
  const toggleLocked = (refs: Ref[], lock: boolean) => {
    transact(lock ? t('Заблокировать') : t('Разблокировать'), (d) => {
      setLocked(d, refs, lock)
    })
  }
  const moveTo = (refs: Ref[], layerId: Id | null) => {
    transact(t('Переместить в слой'), (d) => {
      assignLayer(d, refs, layerId)
    })
    // the target layer may be hidden
    deselectHidden()
  }
  const moveToNew = (refs: Ref[]) => {
    let created: Id | null = null
    transact(t('Новый слой'), (d) => {
      created = addLayer(d, nextLayerName(d, lang))
      assignLayer(d, refs, created)
    })
    if (created) {
      if (mode !== 'layers') setMode('layers')
      setRenaming(`L:${created}`)
    }
  }
  const newLayer = () => {
    let created: Id | null = null
    transact(t('Новый слой'), (d) => {
      created = addLayer(d, nextLayerName(d, lang))
    })
    if (created) {
      if (mode !== 'layers') setMode('layers')
      setRenaming(`L:${created}`)
    }
  }

  const commitRename = (key: string, value: string) => {
    setRenaming(null)
    const name = value.trim()
    if (key.startsWith('L:')) {
      const id = key.slice(2)
      if (!name || doc.layers?.[id]?.name === name) return
      transact(t('Переименовать слой'), (d) => {
        renameLayer(d, id, name)
      })
      return
    }
    const row = flatRows.find((r) => rowKey(r) === key)
    if (!row || name === row.name) return
    transact(t('Переименовать'), (d) => {
      renameEntity(d, row.ref, name)
    })
  }

  const onRowClick = (e: MouseEvent, row: OutlineRow) => {
    const key = rowKey(row)
    focusKey.current = key
    if (e.shiftKey && anchor.current) {
      const a = flatRows.findIndex((r) => rowKey(r) === anchor.current)
      const b = flatRows.findIndex((r) => rowKey(r) === key)
      if (a >= 0 && b >= 0) {
        const range = flatRows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.ref)
        selectRefs(range, false)
        return
      }
    }
    if (e.ctrlKey || e.metaKey) selectRefs([row.ref], true)
    else selectRefs([row.ref], false)
    anchor.current = key
  }

  const sectionRefs = (s: Section): Ref[] => s.rows.map((r) => r.ref)

  const rowMenu = (row: OutlineRow): MenuEntry[] => {
    const refs = targetsOf(row)
    const layers = orderedLayers(doc)
    const allHidden = refs.every((r) => flatRows.find((x) => rowKey(x) === refKey(r.kind, r.id))?.ownHidden ?? false)
    const allLocked = refs.every((r) => flatRows.find((x) => rowKey(x) === refKey(r.kind, r.id))?.ownLocked ?? false)
    const free = unlockedRefs(doc, refs)
    return [
      { label: t('Переименовать'), icon: Pencil, kbd: 'F2', disabled: refs.length !== 1 || !row.renamable, onSelect: () => setRenaming(rowKey(row)) },
      { label: allHidden ? t('Показать') : t('Скрыть'), icon: allHidden ? Eye : EyeOff, onSelect: () => toggleHidden(refs, !allHidden) },
      { label: allLocked ? t('Разблокировать') : t('Заблокировать'), icon: allLocked ? LockOpen : Lock, onSelect: () => toggleLocked(refs, !allLocked) },
      {
        type: 'submenu',
        label: t('Переместить в слой'),
        icon: FolderInput,
        items: [
          { label: t('Без слоя'), checked: refs.length === 1 && !row.layerId, onSelect: () => moveTo(refs, null) },
          ...layers.map((l) => ({ label: l.name, checked: refs.length === 1 && row.layerId === l.id, onSelect: () => moveTo(refs, l.id) })),
          { type: 'separator' },
          { label: t('Новый слой…'), icon: Plus, onSelect: () => moveToNew(refs) },
        ],
      },
      { type: 'separator' },
      { label: t('Удалить'), icon: Trash, kbd: 'Del', danger: true, disabled: !free.length, onSelect: () => deleteRefs(refs) },
    ]
  }

  const sectionMenu = (s: Section): MenuEntry[] => {
    const select: MenuEntry = { label: t('Выделить все'), disabled: !s.rows.length, onSelect: () => selectRefs(sectionRefs(s), false) }
    if (s.kind) {
      return [
        select,
        { type: 'separator' },
        { label: s.hidden ? t('Показать группу') : t('Скрыть группу'), icon: s.hidden ? Eye : EyeOff, onSelect: () => groupFlag(s, 'hidden') },
        { label: s.locked ? t('Разблокировать группу') : t('Заблокировать группу'), icon: s.locked ? LockOpen : Lock, onSelect: () => groupFlag(s, 'locked') },
        { type: 'separator' },
        { label: t('Новый слой из группы'), icon: Plus, disabled: !s.rows.length, onSelect: () => moveToNew(sectionRefs(s)) },
      ]
    }
    const layer = s.layer
    if (!layer) return [select]
    const order = orderedLayers(doc)
    const i = order.findIndex((l) => l.id === layer.id)
    return [
      select,
      { type: 'separator' },
      { label: t('Переименовать слой'), icon: Pencil, onSelect: () => setRenaming(`L:${layer.id}`) },
      { label: s.hidden ? t('Показать слой') : t('Скрыть слой'), icon: s.hidden ? Eye : EyeOff, onSelect: () => groupFlag(s, 'hidden') },
      { label: s.locked ? t('Разблокировать слой') : t('Заблокировать слой'), icon: s.locked ? LockOpen : Lock, onSelect: () => groupFlag(s, 'locked') },
      { type: 'separator' },
      { label: t('Выше'), disabled: i <= 0, onSelect: () => transact(t('Порядок слоёв'), (d) => moveLayer(d, layer.id, i - 1)) },
      { label: t('Ниже'), disabled: i < 0 || i >= order.length - 1, onSelect: () => transact(t('Порядок слоёв'), (d) => moveLayer(d, layer.id, i + 1)) },
      { type: 'separator' },
      {
        label: t('Удалить слой'),
        icon: Trash,
        danger: true,
        onSelect: () =>
          transact(t('Удалить слой'), (d) => {
            deleteLayer(d, layer.id)
          }),
      },
    ]
  }

  const groupFlag = (s: Section, flag: 'hidden' | 'locked') => {
    const value = !(flag === 'hidden' ? s.hidden : s.locked)
    const label =
      flag === 'hidden' ? (value ? t('Скрыть') : t('Показать')) : value ? t('Заблокировать') : t('Разблокировать')
    if (s.kind) {
      const kind = s.kind
      transact(label, (d) => {
        setGroupFlag(d, kind, flag, value)
      })
    } else if (s.layer) {
      const id = s.layer.id
      transact(label, (d) => {
        setLayerFlag(d, id, flag, value)
      })
    } else return
    if (flag === 'hidden' && value) deselectHidden()
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const selected = flatRows.filter((r) => selectedKeys.has(rowKey(r)))
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!selected.length) return
      e.preventDefault()
      deleteRefs(selected.map((r) => r.ref))
    } else if (e.key === 'F2') {
      if (selected.length !== 1 || !selected[0].renamable) return
      e.preventDefault()
      setRenaming(rowKey(selected[0]))
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!flatRows.length) return
      e.preventDefault()
      const cur = anchor.current ? flatRows.findIndex((r) => rowKey(r) === anchor.current) : -1
      const next = Math.max(0, Math.min(flatRows.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      const row = flatRows[next]
      focusKey.current = rowKey(row)
      selectRefs([row.ref], false)
      anchor.current = rowKey(row)
    }
  }

  // drag & drop rows onto layers
  const onDragStart = (e: DragEvent, row: OutlineRow) => {
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(targetsOf(row)))
    e.dataTransfer.effectAllowed = 'move'
  }
  const dropProps = (s: Section) =>
    mode === 'layers'
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DND_TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dropKey !== s.key) setDropKey(s.key)
          },
          onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === s.key ? null : k))
          },
          onDrop: (e: DragEvent) => {
            setDropKey(null)
            const raw = e.dataTransfer.getData(DND_TYPE)
            if (!raw) return
            e.preventDefault()
            try {
              const refs = (JSON.parse(raw) as Ref[]).filter((r) => r && typeof r.kind === 'string' && typeof r.id === 'string')
              if (refs.length) moveTo(refs, s.layer ? s.layer.id : null)
            } catch {
              /* foreign data */
            }
          },
        }
      : {}

  const kindOptions = useMemo(
    () => [{ value: '*', label: t('Все типы') }, ...entityKinds().filter((k) => k.listed !== false).map((k) => ({ value: k.kind, label: k.title[lang] }))],
    [lang, t],
  )
  const objectCount = sections.reduce((n, s) => n + s.total, 0)

  return (
    <div className={clsx('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          aria-label={t('Группировка')}
          className="flex-1"
          options={[
            { value: 'types', label: t('По типам'), title: t('Группы по типу объекта') },
            { value: 'layers', label: t('По слоям'), title: t('Группы по пользовательским слоям') },
          ]}
        />
        <IconBtn icon={Plus} size="sm" label={t('Новый слой')} onClick={newLayer} />
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <SearchInput value={query} onChange={setQuery} placeholder={t('Поиск объектов')} className="min-w-0 flex-1" />
        <div className="w-[108px] shrink-0">
          <Select<string> value={kindFilter || '*'} options={kindOptions} onChange={(v) => setKindFilter(v === '*' ? '' : v)} aria-label={t('Тип объектов')} />
        </div>
      </div>
      <div
        ref={listRef}
        role="tree"
        aria-label={t('Объекты')}
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onListKey}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-1 outline-none"
      >
        {objectCount === 0 && mode === 'types' && <div className="px-2 py-3 text-[11px] text-faint">{t('На этаже пока нет объектов')}</div>}
        {objectCount > 0 && sections.length === 0 && <div className="px-2 py-3 text-[11px] text-faint">{t('Ничего не найдено')}</div>}
        {sections.map((s) => {
          const open = !isCollapsed(s)
          const Icon = s.icon
          const layerKey = s.layer ? `L:${s.layer.id}` : null
          return (
            <div key={s.key} role="group" {...dropProps(s)} className={clsx('rounded', dropKey === s.key && 'bg-accent-soft ring-1 ring-accent')}>
              <div
                className="group flex h-6 items-center gap-1 rounded pr-1 text-[11px] font-medium text-muted hover:bg-hover"
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ at: { x: e.clientX, y: e.clientY }, items: sectionMenu(s) })
                }}
                onDoubleClick={() => layerKey && setRenaming(layerKey)}
              >
                <button
                  type="button"
                  className="flex h-6 w-5 shrink-0 items-center justify-center text-faint hover:text-text"
                  aria-label={open ? t('Свернуть') : t('Развернуть')}
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c)
                      if (n.has(s.key)) n.delete(s.key)
                      else n.add(s.key)
                      return n
                    })
                  }
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {Icon && <Icon size={13} strokeWidth={1.75} className="shrink-0" />}
                {layerKey && renaming === layerKey ? (
                  <RenameInput value={s.title} onDone={(v) => commitRename(layerKey, v)} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className={clsx('min-w-0 flex-1 truncate', s.hidden && 'opacity-60', !s.layer && !s.kind && 'italic')} title={s.title}>
                    {s.title}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-faint">{filtering && s.rows.length !== s.total ? `${s.rows.length}/${s.total}` : s.total}</span>
                {(s.kind || s.layer) && (
                  <>
                    <FlagButton
                      on={s.hidden}
                      inherited={false}
                      onIcon={EyeOff}
                      offIcon={Eye}
                      label={s.hidden ? t('Показать') : t('Скрыть')}
                      onClick={() => groupFlag(s, 'hidden')}
                    />
                    <FlagButton
                      on={s.locked}
                      inherited={false}
                      onIcon={Lock}
                      offIcon={LockOpen}
                      label={s.locked ? t('Разблокировать') : t('Заблокировать')}
                      onClick={() => groupFlag(s, 'locked')}
                    />
                  </>
                )}
              </div>
              {open &&
                s.rows.map((row) => {
                  const key = rowKey(row)
                  const selected = selectedKeys.has(key)
                  const RowIcon = mode === 'layers' ? kindIcon(entityKind(row.ref.kind)?.icon ?? '') : null
                  const layerName = mode === 'types' && row.layerId ? doc.layers?.[row.layerId]?.name : undefined
                  const showSub = row.subtype && !row.name.toLowerCase().includes(row.subtype.toLowerCase())
                  return (
                    <div
                      key={key}
                      role="treeitem"
                      aria-selected={selected}
                      data-key={key}
                      data-selected={selected || undefined}
                      draggable={renaming !== key}
                      onDragStart={(e) => onDragStart(e, row)}
                      onClick={(e) => onRowClick(e, row)}
                      onDoubleClick={() => row.renamable && setRenaming(key)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        if (!selected) {
                          focusKey.current = key
                          selectRefs([row.ref], false)
                          anchor.current = key
                        }
                        setMenu({ at: { x: e.clientX, y: e.clientY }, items: rowMenu(row) })
                      }}
                      onMouseEnter={() => !kindSelection(row.ref.kind) && uiStore.getState().set({ hover: row.ref })}
                      onMouseLeave={() => {
                        const h = uiStore.getState().hover
                        if (h && h.kind === row.ref.kind && h.id === row.ref.id) uiStore.getState().set({ hover: null })
                      }}
                      title={showSub ? `${row.name} · ${row.subtype}` : row.name}
                      className={clsx(
                        'group flex h-6 cursor-default select-none items-center gap-1 rounded pl-6 pr-1 text-[11px]',
                        selected ? 'bg-accent-soft text-accent' : 'text-text hover:bg-hover',
                      )}
                    >
                      {RowIcon && <RowIcon size={12} strokeWidth={1.75} className="shrink-0 text-faint" />}
                      {renaming === key ? (
                        <RenameInput value={row.name} onDone={(v) => commitRename(key, v)} onCancel={() => setRenaming(null)} />
                      ) : (
                        <span className={clsx('min-w-0 flex-1 truncate', row.hidden && 'opacity-45', row.locked && !row.hidden && 'opacity-75')}>
                          {row.name}
                          {showSub && <span className="ml-1 text-faint">{row.subtype}</span>}
                        </span>
                      )}
                      {layerName && (
                        <span className="max-w-[64px] shrink-0 truncate rounded bg-panel-3 px-1 text-[10px] text-muted" title={`${t('Слой')}: ${layerName}`}>
                          {layerName}
                        </span>
                      )}
                      <FlagButton
                        on={row.hidden}
                        inherited={row.hidden && !row.ownHidden}
                        onIcon={EyeOff}
                        offIcon={Eye}
                        label={row.hidden && !row.ownHidden ? t('Скрыто группой, слоем или стеной') : row.ownHidden ? t('Показать') : t('Скрыть')}
                        onClick={() => toggleHidden(targetsOf(row), !row.ownHidden)}
                      />
                      <FlagButton
                        on={row.locked}
                        inherited={row.locked && !row.ownLocked}
                        onIcon={Lock}
                        offIcon={LockOpen}
                        label={row.locked && !row.ownLocked ? t('Заблокировано группой, слоем или стеной') : row.ownLocked ? t('Разблокировать') : t('Заблокировать')}
                        onClick={() => toggleLocked(targetsOf(row), !row.ownLocked)}
                      />
                    </div>
                  )
                })}
              {open && s.layer && s.total === 0 && (
                <div className="flex h-6 items-center pl-6 text-[11px] text-faint">{t('Перетащите сюда объекты')}</div>
              )}
            </div>
          )
        })}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  )
}

/** eye / lock toggle: shown while set (dimmed when inherited) or on row hover */
function FlagButton({
  on,
  inherited,
  onIcon: OnIcon,
  offIcon: OffIcon,
  label,
  onClick,
}: {
  on: boolean
  inherited: boolean
  onIcon: LucideIcon
  offIcon: LucideIcon
  label: string
  onClick(): void
}) {
  const Icon = on ? OnIcon : OffIcon
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={clsx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-text',
        on ? (inherited ? 'opacity-40' : 'opacity-100') : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-70',
      )}
    >
      <Icon size={12} strokeWidth={1.75} />
    </button>
  )
}

function RenameInput({ value, onDone, onCancel }: { value: string; onDone(v: string): void; onCancel(): void }) {
  const [text, setText] = useState(value)
  const done = useRef(false)
  return (
    <input
      autoFocus
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          done.current = true
          onDone(text)
        } else if (e.key === 'Escape') {
          done.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        if (!done.current) onDone(text)
      }}
      className="h-5 min-w-0 flex-1 rounded border border-accent bg-input px-1 text-[11px] text-text outline-none"
    />
  )
}
