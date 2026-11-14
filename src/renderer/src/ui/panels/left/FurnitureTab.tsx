import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock, Download, Star, Trash, Upload } from 'lucide-react'
import type { Asset, AssetCategory } from '@core/types'
import { uiStore, useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, cn, focusRing, SearchInput, Spinner, Thumb, fmtNum } from '@/ui/kit'
import { assetIcon } from '../common/assetIcons'
import { ASSET_CATEGORIES, ASSET_CATEGORY_RU } from '../common/labels'
import { displayName, downloadEntry, errorText, progressFraction, refreshCatalog, useAllAssets, useDownloads, useLang, usePrefs } from '../common/catalog'
import { useAssetThumb, useInView } from '../common/thumbs'
import { ImportModelDialog } from '../ImportModelDialog'
import { KITCHEN_PRESETS } from '@core'
import { placeKitchenPreset } from '../common/kitchenPresets'

export { ASSET_ICONS } from '../common/assetIcons'

type Filter = 'all' | 'favorite' | 'recent' | AssetCategory

/** begin placing an asset with the `item` tool (downloads remote entries first) */
export async function startPlacing(asset: Asset): Promise<void> {
  let id = asset.id
  if (asset.remote) {
    const local = await downloadEntry('asset', asset.id)
    if (!local) return
    id = local.id
  }
  usePrefs.getState().pushRecent('asset', id)
  uiStore.getState().set({ tool: 'item', placingAssetId: id })
}

export function FurnitureTab() {
  const t = useT()
  const all = useAllAssets()
  const favorites = usePrefs((s) => s.favorites.asset)
  const recents = usePrefs((s) => s.recents.asset)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [importOpen, setImportOpen] = useState(false)
  const lang = useLang()

  const present = useMemo(() => {
    const counts = new Map<AssetCategory, number>()
    for (const a of all) counts.set(a.category, (counts.get(a.category) ?? 0) + 1)
    return counts
  }, [all])

  const groups = useMemo((): { title: string | null; items: Asset[] }[] => {
    const needle = q.trim().toLowerCase()
    const byId = new Map(all.map((a) => [a.id, a]))
    if (needle) {
      const hits = all.filter((a) =>
        [a.name, a.nameRu ?? '', ...(a.tags ?? []), t(ASSET_CATEGORY_RU[a.category] ?? '')].some((s) => s.toLowerCase().includes(needle)),
      )
      return [{ title: null, items: hits }]
    }
    if (filter === 'favorite') return [{ title: null, items: favorites.map((id) => byId.get(id)).filter((a): a is Asset => !!a) }]
    if (filter === 'recent') return [{ title: null, items: recents.map((id) => byId.get(id)).filter((a): a is Asset => !!a) }]
    if (filter !== 'all') return [{ title: null, items: all.filter((a) => a.category === filter) }]
    return ASSET_CATEGORIES.filter((c) => present.has(c)).map((c) => ({
      title: t(ASSET_CATEGORY_RU[c]),
      items: all.filter((a) => a.category === c),
    }))
  }, [all, q, filter, favorites, recents, present, t])

  const chip = (id: Filter, text: string, icon?: ReactNode, count?: number) => (
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
      {count !== undefined && <span className="opacity-60">{count}</span>}
    </button>
  )

  const empty = groups.every((g) => g.items.length === 0)

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex gap-1.5">
        <SearchInput value={q} onChange={setQ} placeholder={t('Поиск мебели')} className="flex-1" />
        <Button icon={<Upload className="size-3.5" />} onClick={() => setImportOpen(true)} title={t('Импорт 3D-модели (GLB, glTF, OBJ, FBX)')}>
          {t('Импорт')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {chip('all', t('Все'))}
        {chip('favorite', t('Избранное'), <Star />)}
        {chip('recent', t('Недавние'), <Clock />)}
        {ASSET_CATEGORIES.filter((c) => present.has(c)).map((c) => chip(c, t(ASSET_CATEGORY_RU[c]), undefined, present.get(c)))}
      </div>
      {!q && (filter === 'all' || filter === 'kitchen') && <KitchenPresets />}
      {groups.map((g, gi) =>
        g.items.length === 0 ? null : (
          <div key={g.title ?? gi} className="flex flex-col gap-1.5">
            {g.title && <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{g.title}</div>}
            <div className="grid grid-cols-3 gap-1.5">
              {g.items.map((a) => (
                <AssetTile key={a.id} asset={a} lang={lang} />
              ))}
            </div>
          </div>
        ),
      )}
      {empty && (
        <div className="py-8 text-center text-[11px] text-[var(--muted)]">
          {filter === 'favorite' && !q
            ? t('Отмечайте звёздочкой то, чем пользуетесь часто')
            : filter === 'recent' && !q
              ? t('Здесь появятся недавно размещённые предметы')
              : t('Ничего не найдено')}
        </div>
      )}
      <p className="pt-1 text-[10px] leading-snug text-[var(--muted)]">
        {t('Щёлкните предмет и укажите место на плане. Модели из открытых библиотек (CC0 / CC-BY) — лицензия видна во всплывающей подсказке.')}
      </p>
      <ImportModelDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

/** one-click kitchen sets: along the selected wall, or next to the plan */
function KitchenPresets() {
  const t = useT()
  const lang = useLang()
  return (
    <div className="flex flex-col gap-1.5" data-testid="kitchen-presets">
      <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{t('Готовые кухни')}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {KITCHEN_PRESETS.map((p) => (
          <Button key={p.id} onClick={() => placeKitchenPreset(p)} title={t('Выделите стену — гарнитур встанет вдоль неё')}>
            {lang === 'en' ? p.name : p.nameRu}
          </Button>
        ))}
      </div>
      <p className="text-[10px] leading-snug text-[var(--muted)]">{t('Выделите стену — гарнитур встанет вдоль неё; без выделения — рядом с планом. Модули можно менять по одному.')}</p>
    </div>
  )
}

function AssetTile({ asset, lang }: { asset: Asset; lang: 'ru' | 'en' }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref)
  const thumb = useAssetThumb(asset, visible)
  const tool = useUi((s) => s.tool)
  const placing = useUi((s) => s.placingAssetId)
  const fav = usePrefs((s) => s.favorites.asset.includes(asset.id))
  const toggleFav = usePrefs((s) => s.toggleFavorite)
  const progress = useDownloads((s) => s.progress[asset.id])
  const error = useDownloads((s) => s.errors[asset.id])
  const p = progressFraction(progress)
  const name = displayName(asset, lang)
  const size = `${fmtNum(asset.size.w / 10, 0)}×${fmtNum(asset.size.d / 10, 0)}×${fmtNum(asset.size.h / 10, 0)}`
  const credits = [asset.author, asset.source, asset.licence].filter(Boolean).join(' · ')

  const remove = async () => {
    if (!window.confirm(t('Удалить модель из библиотеки?'))) return
    try {
      await window.doplan.catalog.remove('asset', asset.id)
      await refreshCatalog()
    } catch (e) {
      window.alert(errorText(e))
    }
  }

  return (
    <div ref={ref}>
      <Thumb
        src={thumb}
        fallback={assetIcon(asset.category)}
        label={name}
        sublabel={size}
        title={`${name}\n${size} ${t('см')}${credits ? `\n${credits}` : ''}${error ? `\n${t('Ошибка')}: ${error}` : ''}`}
        selected={tool === 'item' && placing === asset.id}
        onClick={() => void startPlacing(asset)}
        draggable={!asset.remote}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-doplan-asset', asset.id)
          e.dataTransfer.setData('text/plain', asset.id)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        overlay={
          asset.remote ? (
            <span className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/60 to-transparent pb-1.5 text-white">
              {p !== null ? (
                <span className="flex w-4/5 flex-col items-center gap-1">
                  <Spinner />
                  <span className="h-1 w-full overflow-hidden rounded bg-white/25">
                    <span className="block h-full bg-[var(--accent)]" style={{ width: `${(p || 0.02) * 100}%` }} />
                  </span>
                </span>
              ) : (
                <span className={cn('inline-flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px]', error && 'text-[#ff8589]')}>
                  <Download className="size-3" />
                  {error ? t('Повторить') : t('Скачать')}
                </span>
              )}
            </span>
          ) : undefined
        }
        corner={
          <>
            {asset.custom && (
              <button
                type="button"
                aria-label={t('Удалить из библиотеки')}
                title={t('Удалить из библиотеки')}
                onClick={(e) => {
                  e.stopPropagation()
                  void remove()
                }}
                className={cn('rounded bg-black/40 p-0.5 text-white opacity-0 hover:text-[#ff8589] focus:opacity-100 group-hover:opacity-100', focusRing)}
              >
                <Trash className="size-3" />
              </button>
            )}
            <button
              type="button"
              aria-label={fav ? t('Убрать из избранного') : t('В избранное')}
              aria-pressed={fav}
              onClick={(e) => {
                e.stopPropagation()
                toggleFav('asset', asset.id)
              }}
              className={cn(
                'rounded bg-black/40 p-0.5 text-white',
                fav ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
                focusRing,
              )}
            >
              <Star className={cn('size-3', fav && 'fill-yellow-400 text-yellow-400')} />
            </button>
          </>
        }
      />
    </div>
  )
}
