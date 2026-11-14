import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, Clock, Download, Star } from 'lucide-react'
import type { Id, Material, MaterialCategory } from '@core/types'
import { cn, focusRing, Popover, SearchInput, Spinner } from '@/ui/kit'
import { useT } from '@/i18n'
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY_RU } from './labels'
import {
  displayName,
  downloadEntry,
  progressFraction,
  useAllMaterials,
  useDownloads,
  useLang,
  useMaterialMap,
  usePrefs,
} from './catalog'

/** CSS background that previews a material: thumb, else colour map tinted by colour, else flat colour */
export function materialSwatchStyle(m: Material | undefined): CSSProperties {
  if (!m) return { background: 'repeating-conic-gradient(#555 0 25%, #777 0 50%) 0 0 / 8px 8px' }
  if (m.thumb) return { backgroundImage: `url("${m.thumb}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
  if (m.maps?.color)
    return {
      backgroundColor: m.color,
      backgroundImage: `url("${m.maps.color}")`,
      backgroundBlendMode: 'multiply',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  const extra: CSSProperties = {}
  if (m.metalness > 0.5) extra.backgroundImage = 'linear-gradient(135deg, rgba(255,255,255,.35), rgba(0,0,0,.25))'
  else if ((m.transmission ?? 0) > 0.3 || (m.opacity ?? 1) < 0.6)
    extra.backgroundImage = 'linear-gradient(135deg, rgba(255,255,255,.45), rgba(255,255,255,0) 60%)'
  return { backgroundColor: m.color, ...extra }
}

export function MaterialSwatch({ material, className, size = 20 }: { material: Material | undefined; className?: string; size?: number }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded border border-[var(--border)]', className)}
      style={{ width: size, height: size, ...materialSwatchStyle(material) }}
    />
  )
}

type Filter = 'all' | 'recent' | 'favorite' | MaterialCategory

export interface MaterialPickerProps {
  value: Id | undefined
  onChange(id: Id | undefined): void
  /** categories listed first and selected as the initial filter's neighbourhood */
  categories?: MaterialCategory[]
  /** label of an explicit "none / default" option; omit to disallow */
  noneLabel?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
  /** shows "mixed" when several selected entities differ */
  mixed?: boolean
}

/** reusable material picker: swatch button → popover with categories, search, recents and favourites */
export function MaterialPicker({ value, onChange, categories, noneLabel, className, disabled, mixed, ...aria }: MaterialPickerProps) {
  const t = useT()
  const lang = useLang()
  const map = useMaterialMap()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const current = value ? map.get(value) : undefined
  const label = mixed ? t('Разные') : value ? (current ? displayName(current, lang) : value) : (noneLabel ?? '—')

  return (
    <>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={aria['aria-label']}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] pl-1 pr-1.5 text-left text-xs text-[var(--text)]',
          'hover:border-[color-mix(in_srgb,var(--accent)_60%,var(--border))] disabled:opacity-50',
          focusRing,
          className,
        )}
      >
        <MaterialSwatch material={mixed ? undefined : current} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-[var(--muted)]" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={btn} width={320} aria-label={t('Выбор материала')}>
        <MaterialBrowser
          value={value}
          categories={categories}
          noneLabel={noneLabel}
          onPick={(id) => {
            onChange(id)
            setOpen(false)
          }}
        />
      </Popover>
    </>
  )
}

export interface MaterialBrowserProps {
  value?: Id
  onPick(id: Id | undefined): void
  categories?: MaterialCategory[]
  noneLabel?: string
  columns?: number
  /** grow with the parent instead of a fixed-height scrolling grid */
  fill?: boolean
  initialFilter?: Filter
}

/** grid browser used by the picker popover and the materials tab */
export function MaterialBrowser({ value, onPick, categories, noneLabel, columns = 5, fill, initialFilter }: MaterialBrowserProps) {
  const t = useT()
  const lang = useLang()
  const all = useAllMaterials()
  const favorites = usePrefs((s) => s.favorites.material)
  const recents = usePrefs((s) => s.recents.material)
  const pushRecent = usePrefs((s) => s.pushRecent)
  const toggleFav = usePrefs((s) => s.toggleFavorite)
  const progress = useDownloads((s) => s.progress)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>(initialFilter ?? (recents.length > 0 ? 'recent' : 'all'))

  const present = useMemo(() => new Set(all.map((m) => m.category)), [all])
  const cats = useMemo(() => {
    const first = (categories ?? []).filter((c) => present.has(c))
    const rest = MATERIAL_CATEGORIES.filter((c) => present.has(c) && !first.includes(c))
    return [...first, ...rest]
  }, [categories, present])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let src: Material[]
    if (needle) {
      src = all.filter((m) =>
        [m.name, m.nameRu ?? '', ...(m.tags ?? []), t(MATERIAL_CATEGORY_RU[m.category] ?? '')].some((s) => s.toLowerCase().includes(needle)),
      )
    } else if (filter === 'recent') {
      const byId = new Map(all.map((m) => [m.id, m]))
      src = recents.map((id) => byId.get(id)).filter((m): m is Material => !!m)
    } else if (filter === 'favorite') {
      const byId = new Map(all.map((m) => [m.id, m]))
      src = favorites.map((id) => byId.get(id)).filter((m): m is Material => !!m)
    } else if (filter === 'all') {
      const pref = new Set(categories ?? [])
      src = [...all].sort((a, b) => Number(pref.has(b.category)) - Number(pref.has(a.category)))
    } else {
      src = all.filter((m) => m.category === filter)
    }
    return src
  }, [all, q, filter, recents, favorites, categories, t])

  const pick = async (m: Material) => {
    if (m.remote) {
      const local = await downloadEntry('material', m.id)
      if (!local) return
      pushRecent('material', local.id)
      onPick(local.id)
      return
    }
    pushRecent('material', m.id)
    onPick(m.id)
  }

  const chip = (id: Filter, text: string, icon?: ReactNode) => (
    <button
      key={id}
      type="button"
      aria-pressed={filter === id && !q}
      onClick={() => {
        setFilter(id)
        setQ('')
      }}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] [&_svg]:size-3',
        focusRing,
        filter === id && !q
          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[var(--text)]'
          : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]',
      )}
    >
      {icon}
      {text}
    </button>
  )

  return (
    <div className="flex flex-col gap-2 p-2">
      <SearchInput value={q} onChange={setQ} placeholder={t('Поиск материала')} autoFocus={!fill} />
      <div className="flex flex-wrap gap-1">
        {chip('recent', t('Недавние'), <Clock />)}
        {chip('favorite', t('Избранное'), <Star />)}
        {chip('all', t('Все'))}
        {cats.map((c) => chip(c, t(MATERIAL_CATEGORY_RU[c])))}
      </div>
      <div
        className={cn('grid gap-1.5 pr-0.5', !fill && 'max-h-72 overflow-y-auto [scrollbar-width:thin]')}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        role="listbox"
        aria-label={t('Материалы')}
      >
        {noneLabel && !q && (
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => onPick(undefined)}
            className={cn(
              'flex aspect-square items-center justify-center rounded-md border text-center text-[10px] leading-tight text-[var(--muted)]',
              focusRing,
              !value ? 'border-[var(--accent)]' : 'border-dashed border-[var(--border)] hover:text-[var(--text)]',
            )}
          >
            {noneLabel}
          </button>
        )}
        {list.map((m) => {
          const fav = favorites.includes(m.id)
          const p = progressFraction(progress[m.id])
          return (
            <div key={m.id} className="group relative">
              <button
                type="button"
                role="option"
                aria-selected={m.id === value}
                title={`${displayName(m, lang)}${m.remote ? ` — ${t('загрузить')}` : ''}`}
                onClick={() => void pick(m)}
                className={cn(
                  'relative block aspect-square w-full overflow-hidden rounded-md border',
                  focusRing,
                  m.id === value ? 'border-2 border-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--accent)]',
                )}
                style={materialSwatchStyle(m)}
              >
                {m.remote && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                    {p !== null ? <Spinner /> : <Download className="size-3.5" />}
                  </span>
                )}
                {p !== null && p > 0 && (
                  <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                    <span className="block h-full bg-[var(--accent)]" style={{ width: `${p * 100}%` }} />
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={fav ? t('Убрать из избранного') : t('В избранное')}
                aria-pressed={fav}
                onClick={() => toggleFav('material', m.id)}
                className={cn(
                  'absolute right-0.5 top-0.5 rounded p-0.5 text-white drop-shadow',
                  fav ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
                  focusRing,
                )}
              >
                <Star className={cn('size-3', fav && 'fill-yellow-400 text-yellow-400')} />
              </button>
              <div className="mt-0.5 truncate text-[9px] leading-tight text-[var(--muted)]">{displayName(m, lang)}</div>
            </div>
          )
        })}
        {list.length === 0 && (
          <div className="col-span-full py-6 text-center text-[11px] text-[var(--muted)]">
            {filter === 'recent' && !q ? t('Недавних материалов пока нет') : filter === 'favorite' && !q ? t('Избранных материалов пока нет') : t('Ничего не найдено')}
          </div>
        )}
      </div>
    </div>
  )
}
