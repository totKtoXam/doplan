import { useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Box, Link2, Link2Off, Lock, LockOpen, Eye, EyeOff, Replace, RotateCcw, RotateCw, Undo2 } from 'lucide-react'
import { beforeItemAssetChange, resizedParams, sizedCatalogName } from '@core'
import type { Asset, Id, Item, MountKind } from '@core/types'
import { useDoc } from '@/store/document'
import { uiStore } from '@/store/ui'
import { resizePrefs, useResizePrefs } from '@/store/resizePrefs'
import { useT } from '@/i18n'
import '@/ui/catalogI18n'
import { Button, ColorInput, IconButton, Input, NumberInput, Popover, Row, SearchInput, Section, Select, Thumb, Toggle, cn, fmtNum } from '@/ui/kit'
import { assetIcon } from '../common/assetIcons'
import { MaterialPicker } from '../common/MaterialPicker'
import { ASSET_CATEGORY_RU, MOUNT_RU, optionsOf } from '../common/labels'
import { paramChoices, paramValueLabel } from '../common/paramOptions'
import { displayName, downloadEntry, tx, useAllAssets, useAssetMap, useLang } from '../common/catalog'
import { useAssetThumb, useInView } from '../common/thumbs'
import { Hint, InspectorHeader, Pair, Triple } from './shared'

const SLOT_RU: Record<string, string> = {
  body: 'Корпус',
  front: 'Фасады',
  fronts: 'Фасады',
  worktop: 'Столешница',
  fabric: 'Обивка',
  legs: 'Ножки',
  metal: 'Металл',
  glass: 'Стекло',
  screen: 'Экран',
  frame: 'Каркас',
  handle: 'Ручки',
  handles: 'Ручки',
  top: 'Столешница',
  seat: 'Сиденье',
  cushion: 'Подушки',
  pillow: 'Подушки',
  blanket: 'Покрывало',
  mattress: 'Матрас',
  headboard: 'Изголовье',
  plinth: 'Цоколь',
  inner: 'Внутри',
  ceramic: 'Керамика',
  pot: 'Кашпо',
  leaves: 'Листья',
  plant: 'Растение',
  rug: 'Ворс',
  picture: 'Изображение',
  mirror: 'Зеркало',
  shelf: 'Полки',
  door: 'Двери',
}

const PARAM_RU: Record<string, string> = {
  doors: 'Дверцы',
  drawers: 'Ящики',
  shelves: 'Полки',
  sections: 'Секции',
  handle: 'Ручка',
  handles: 'Ручки',
  legs: 'Ножки',
  legHeight: 'Высота ножек',
  plinth: 'Цоколь',
  plinthHeight: 'Высота цоколя',
  thickness: 'Толщина',
  depth: 'Глубина',
  overhang: 'Свес',
  seats: 'Мест',
  armrests: 'Подлокотники',
  corner: 'Угловой',
  cornerSide: 'Сторона угла',
  headboard: 'Изголовье',
  sink: 'Мойка',
  hob: 'Варочная панель',
  worktop: 'Столешница',
  island: 'Остров',
  shape: 'Форма',
  type: 'Тип',
  railing: 'Перила',
  horizontal: 'Подъёмные дверцы',
  oven: 'Духовка',
  microwave: 'Микроволновка',
  fridge: 'Холодильник',
  sliding: 'Раздвижные двери',
  mirror: 'Зеркало',
  back: 'Спинка',
  mattress: 'Матрас',
  arms: 'Подлокотники',
  chaise: 'Оттоманка',
  seatHeight: 'Высота сиденья',
  sideBySide: 'Двухдверный (side-by-side)',
  burners: 'Конфорки',
  builtIn: 'Встроенный',
  dryer: 'С сушкой',
  outdoor: 'Уличный',
  stand: 'Подставка',
  bowls: 'Чаш',
  faucet: 'Смеситель',
  bowlDepth: 'Глубина чаши',
  tank: 'Бачок',
  freestanding: 'Отдельностоящая',
  tray: 'Поддон',
  vanity: 'Тумба',
  pedestal: 'Пьедестал',
  frame: 'Рама',
  passepartout: 'Паспарту',
  plant: 'Растение',
  layout: 'Фасады',
  cutout: 'Вырез в столешнице',
  steps: 'Ступени',
  glass: 'Стекло',
  open: 'Открыто',
  round: 'Круглый',
  style: 'Стиль',
  pillows: 'Подушки',
  rows: 'Ряды',
  cols: 'Колонки',
  sections_: 'Секции',
  radius: 'Радиус',
  gap: 'Зазор',
  frontStyle: 'Стиль фасадов',
  cornerType: 'Тип угла',
  legDepth: 'Глубина крыла',
  cornerDoorWidth: 'Ширина дверцы угла',
  variant: 'Вариант',
  standStyle: 'Подставка',
  doorType: 'Двери',
  hinge: 'Петли',
  underLight: 'Подсветка снизу',
  count: 'Количество',
  frontThickness: 'Толщина фасада',
  backOverhang: 'Свес со стороны сидений',
}

const LENGTH_PARAM = /(height|width|depth|thick|size|gap|offset|radius|length|overhang|elev|plinth)/i

export function ItemInspector({ id }: { id: Id }) {
  const t = useT()
  const lang = useLang()
  const item = useDoc((s) => s.doc.items[id])
  const assets = useAssetMap()
  const lockRatio = useResizePrefs((s) => s.lockRatio)
  const setLockRatio = resizePrefs.getState().setLockRatio
  if (!item) return null
  const asset = assets.get(item.assetId)
  const set = (label: string, fn: (x: Item) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.items[id]
      if (x) fn(x)
    }, merge)
  const m = (f: string, g: string) => `item.${id}.${f}.${g}`
  const assetName = asset ? sizedCatalogName(displayName(asset, lang), asset.size.w, item.size.w) : item.assetId

  const setSize = (axis: 'w' | 'd' | 'h', v: number, g: string) =>
    set('Размер', (x) => {
      const old = x.size[axis]
      const from = { ...x.size }
      if (lockRatio && old > 0) {
        const k = v / old
        x.size = { w: Math.round(x.size.w * k), d: Math.round(x.size.d * k), h: Math.round(x.size.h * k) }
        x.size[axis] = v
      } else x.size = { ...x.size, [axis]: v }
      // doors / drawers / shelves keep their module size
      const params = resizedParams(asset, x.params, from, x.size)
      if (params) x.params = params
    }, m(`size${axis}`, g))

  const raised = item.mount === 'wall' || item.mount === 'free' || item.mount === 'surface' || item.elevation > 0
  const elevationRow = (
    <Row label={t('Высота над полом')}>
      <NumberInput
        kind="length"
        value={item.elevation}
        min={0}
        round={1}
        disabled={item.locked}
        onChange={(v, g) =>
          set('Высота установки', (x) => {
            x.elevation = v
            if (x.mount === 'floor' && v > 0) x.mount = 'free'
          }, m('elev', g))
        }
      />
    </Row>
  )

  const slots = Object.entries(asset?.slots ?? {})
  // kitchen base units: H = floor → top of the worktop (with the plinth), D = with the worktop overhang;
  // the worktop and its sink / hob cut-out are sized like a store lists them
  const isKitchenBase = asset?.procedural === 'kitchenBase'
  const pv = (k: string) => item.params?.[k] ?? asset?.defaultParams?.[k]
  const on = (v: unknown) => v === true || v === 'true' || v === 1
  const hasTop = isKitchenBase && pv('worktop') !== false && pv('worktop') !== 'false'
  const cutRaw = pv('cutout')
  const cutKind: 'none' | 'sink' | 'hob' = !hasTop
    ? 'none'
    : cutRaw === 'sink' || cutRaw === 'hob' || cutRaw === 'none'
      ? cutRaw
      : on(pv('sink'))
        ? 'sink'
        : on(pv('hob'))
          ? 'hob'
          : 'none'
  const pnum = (k: string, def: number) => {
    const v = Number(pv(k))
    return Number.isFinite(v) && pv(k) !== undefined && pv(k) !== '' ? v : def
  }
  const W = item.size.w
  const D = item.size.d
  const bowls = Math.min(2, Math.max(1, Math.round(pnum('bowls', 1))))
  const cutMaxW = Math.max(160, W - 60)
  const cutMaxD = Math.max(160, D - 80)
  const cutW = Math.min(cutMaxW, Math.max(150, pnum('cutoutWidth', cutKind === 'hob' ? Math.min(580, W - 80) : bowls === 2 ? Math.min(760, W - 100) : Math.min(500, W - 100))))
  const cutD = Math.min(cutMaxD, Math.max(150, pnum('cutoutDepth', Math.min(440, D - 140))))
  const cutXMax = Math.max(0, W / 2 - cutW / 2 - 30)
  const TOP_KEYS = new Set(['worktopThickness', 'overhang', 'cutoutWidth', 'cutoutDepth', 'cutoutX', 'bowls', 'faucet'])
  const setP = (k: string, v: number | string | boolean, g?: string) =>
    set('Параметр', (x) => {
      x.params = { ...(x.params ?? {}), [k]: v }
    }, g ? m(`p.${k}`, g) : undefined)
  const params = Object.entries(asset?.defaultParams ?? {}).filter(([k]) => !(hasTop && TOP_KEYS.has(k)))

  return (
    <div>
      <InspectorHeader
        icon={<Box />}
        title={item.name || assetName}
        subtitle={asset ? t(ASSET_CATEGORY_RU[asset.category]) : undefined}
        extra={
          <>
            <IconButton icon={item.locked ? <Lock /> : <LockOpen />} active={!!item.locked} label={item.locked ? t('Разблокировать') : t('Заблокировать')} onClick={() => set(item.locked ? 'Разблокировать' : 'Заблокировать', (x) => (x.locked = !x.locked))} />
            <IconButton icon={item.hidden ? <EyeOff /> : <Eye />} active={!!item.hidden} label={item.hidden ? t('Показать') : t('Скрыть')} onClick={() => set(item.hidden ? 'Показать' : 'Скрыть', (x) => (x.hidden = !x.hidden))} />
          </>
        }
      />
      <Section title={t('Объект')} id="insp.item.main">
        <Row label={t('Название')}>
          <Input value={item.name ?? ''} placeholder={assetName} onChange={(v) => set('Название', (x) => (v ? (x.name = v) : delete x.name), `item.${id}.name`)} onKeyDown={(e) => e.stopPropagation()} />
        </Row>
        <Row label={t('Модель')}>
          <ReplaceAsset item={item} current={asset} />
        </Row>
      </Section>

      {/* raised items (on a wall, on a surface, free in the air) get their own section memory: a
          «Положение» collapsed for floor furniture must not hide «Высота над полом» from them */}
      <Section title={t('Положение')} id={raised ? 'insp.item.pos.raised' : 'insp.item.pos'}>
        {raised && elevationRow}
        <Pair>
          <NumberInput kind="length" label="X" value={item.x} round={1} disabled={item.locked} onChange={(v, g) => set('Переместить', (x) => (x.x = v), m('x', g))} />
          <NumberInput kind="length" label="Y" value={item.y} round={1} disabled={item.locked} onChange={(v, g) => set('Переместить', (x) => (x.y = v), m('y', g))} />
        </Pair>
        <Row label={t('Поворот')}>
          <NumberInput kind="angle" value={item.rotation} step={1} disabled={item.locked} onChange={(v, g) => set('Повернуть', (x) => (x.rotation = ((v % 360) + 360) % 360), m('rot', g))} />
          <IconButton size="sm" icon={<RotateCcw />} label={t('−90°')} disabled={item.locked} onClick={() => set('Повернуть', (x) => (x.rotation = (((x.rotation - 90) % 360) + 360) % 360))} />
          <IconButton size="sm" icon={<RotateCw />} label={t('+90°')} disabled={item.locked} onClick={() => set('Повернуть', (x) => (x.rotation = (x.rotation + 90) % 360))} />
        </Row>
        {!raised && elevationRow}
        <Row label={t('Крепление')}>
          <Select<MountKind>
            value={item.mount}
            options={optionsOf(MOUNT_RU)}
            onChange={(k) =>
              set('Крепление', (x) => {
                x.mount = k
                // «На полу» puts the item down on the floor
                if (k === 'floor') x.elevation = 0
              })
            }
          />
        </Row>
        {raised && <Hint>{t('Высоту можно менять и в 3D: тяните вертикальную стрелку над объектом')}</Hint>}
      </Section>

      <Section
        title={t('Размеры')}
        id="insp.item.size"
        actions={
          <>
            <IconButton size="sm" icon={lockRatio ? <Link2 /> : <Link2Off />} active={lockRatio} label={t('Сохранять пропорции')} onClick={() => setLockRatio(!lockRatio)} />
            {asset && (
              <IconButton size="sm" icon={<Undo2 />} label={t('Исходный размер')} onClick={() => set('Исходный размер', (x) => (x.size = { ...asset.size }))} />
            )}
          </>
        }
      >
        <Triple>
          <NumberInput kind="length" label={t('Ш')} value={item.size.w} min={1} round={1} onChange={(v, g) => setSize('w', v, g)} />
          <NumberInput kind="length" label={t('Г')} value={item.size.d} min={1} round={1} onChange={(v, g) => setSize('d', v, g)} />
          <NumberInput kind="length" label={t('В')} value={item.size.h} min={1} round={1} onChange={(v, g) => setSize('h', v, g)} />
        </Triple>
        {isKitchenBase && (
          <Hint>
            {hasTop ? t('В — от пола до верха столешницы (с цоколем)') : t('В — от пола, с цоколем')}
            {hasTop && <><br />{t('Г — со свесом столешницы')}</>}
          </Hint>
        )}
        <Toggle checked={!!item.mirrored} onChange={(v) => set('Отразить', (x) => (x.mirrored = v))} label={<span className="inline-flex items-center gap-1"><ArrowLeftRight className="size-3" />{t('Зеркально')}</span>} />
      </Section>

      <Section title={t('Материалы')} id="insp.item.mat">
        {slots.map(([slot, def]) => (
          <Row key={slot} label={t(SLOT_RU[slot] ?? slot)}>
            <MaterialPicker
              value={item.overrides?.[slot] ?? (def || undefined)}
              noneLabel={def ? undefined : t('Как в модели')}
              onChange={(v) =>
                set('Материал предмета', (x) => {
                  const o = { ...(x.overrides ?? {}) }
                  if (v && v !== def) o[slot] = v
                  else delete o[slot]
                  if (Object.keys(o).length) x.overrides = o
                  else delete x.overrides
                })
              }
            />
          </Row>
        ))}
        {slots.length === 0 && <Hint>{t('У модели нет настраиваемых слотов материалов.')}</Hint>}
        {item.overrides && Object.keys(item.overrides).length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => set('Сбросить материалы', (x) => delete x.overrides)}>
            {t('Сбросить материалы')}
          </Button>
        )}
        <Row label={t('Оттенок')}>
          <ColorInput value={item.tint} onChange={(v, g) => set('Оттенок', (x) => (x.tint = v), m('tint', g))} onClear={() => set('Оттенок', (x) => delete x.tint)} />
        </Row>
      </Section>

      {params.length > 0 && (
        <Section title={t('Параметры')} id="insp.item.params">
          {params.map(([key, def]) => {
            const value = item.params?.[key] ?? def
            const label = t(PARAM_RU[key] ?? key)
            const setParam = (v: number | string | boolean, g?: string) =>
              set('Параметр', (x) => {
                x.params = { ...(x.params ?? {}), [key]: v }
              }, g ? m(`p.${key}`, g) : undefined)
            if (typeof def === 'boolean')
              return <Toggle key={key} checked={Boolean(value)} onChange={(v) => setParam(v)} label={label} />
            if (typeof def === 'number')
              return (
                <Row key={key} label={label}>
                  <NumberInput
                    kind={LENGTH_PARAM.test(key) ? 'length' : 'number'}
                    value={typeof value === 'number' ? value : Number(value)}
                    step={LENGTH_PARAM.test(key) ? 10 : Number.isInteger(def) ? 1 : 0.1}
                    round={!LENGTH_PARAM.test(key) && Number.isInteger(def) ? 1 : undefined}
                    min={0}
                    onChange={(v, g) => setParam(v, g)}
                  />
                </Row>
              )
            const s = String(value)
            const choices = paramChoices(asset?.procedural, key)
            if (choices)
              return (
                <Row key={key} label={label}>
                  <Select
                    value={choices.includes(s) ? s : choices[0]}
                    options={choices.map((v) => ({ value: v, label: t(paramValueLabel(asset?.procedural, key, v)) }))}
                    onChange={(v) => setParam(v)}
                  />
                </Row>
              )
            if (s.startsWith('mat_') || /material/i.test(key))
              return (
                <Row key={key} label={label}>
                  <MaterialPicker value={s || undefined} onChange={(v) => v && setParam(v)} />
                </Row>
              )
            return (
              <Row key={key} label={label}>
                <Input value={s} onChange={(v) => setParam(v, 'text')} onKeyDown={(e) => e.stopPropagation()} />
              </Row>
            )
          })}
          {hasTop && (
            <>
              <Row label={t('Толщина столешницы')}>
                <NumberInput kind="length" value={pnum('worktopThickness', 38)} min={10} max={80} round={1} onChange={(v, g) => setP('worktopThickness', v, g)} />
              </Row>
              <Row label={t('Свес')}>
                <NumberInput kind="length" value={pnum('overhang', 20)} min={0} max={100} round={1} onChange={(v, g) => setP('overhang', v, g)} />
              </Row>
            </>
          )}
          {cutKind !== 'none' && (
            <>
              <Row label={cutKind === 'sink' ? t('Мойка: Ш × Г') : t('Варочная: Ш × Г')}>
                <NumberInput kind="length" value={cutW} min={150} max={cutMaxW} round={1} onChange={(v, g) => setP('cutoutWidth', v, g)} />
                <span className="text-[var(--muted)]">×</span>
                <NumberInput kind="length" value={cutD} min={150} max={cutMaxD} round={1} onChange={(v, g) => setP('cutoutDepth', v, g)} />
              </Row>
              <Row label={cutKind === 'sink' ? t('Смещение мойки') : t('Смещение панели')}>
                <NumberInput kind="length" value={Math.max(-cutXMax, Math.min(cutXMax, pnum('cutoutX', 0)))} min={-cutXMax} max={cutXMax} round={1} onChange={(v, g) => setP('cutoutX', v, g)} />
              </Row>
              {cutKind === 'sink' && (
                <>
                  <Row label={t('Чаш')}>
                    <NumberInput kind="number" value={bowls} min={1} max={2} step={1} round={1} onChange={(v) => setP('bowls', v)} />
                  </Row>
                  <Toggle checked={pv('faucet') === undefined ? true : on(pv('faucet'))} onChange={(v) => setP('faucet', v)} label={t('Смеситель')} />
                </>
              )}
              <Hint>
                {t('Размер выреза ограничен шириной тумбы минус 6 см и глубиной минус 8 см')}: {fmtNum(cutMaxW / 10, 1)} × {fmtNum(cutMaxD / 10, 1)} {t('см')}
              </Hint>
            </>
          )}
          {item.params && (
            <Button size="sm" variant="ghost" onClick={() => set('Сбросить параметры', (x) => delete x.params)}>
              {t('Сбросить параметры')}
            </Button>
          )}
        </Section>
      )}

      {asset && (asset.licence || asset.source || asset.author) && (
        <Section title={t('Источник')} id="insp.item.src" defaultOpen={false}>
          <Hint>
            {[asset.author, asset.source, asset.licence].filter(Boolean).join(' · ')}
            <br />
            {t('Размер по умолчанию')}: {fmtNum(asset.size.w, 0)}×{fmtNum(asset.size.d, 0)}×{fmtNum(asset.size.h, 0)} {t('мм')}
          </Hint>
        </Section>
      )}
    </div>
  )
}

function ReplaceAsset({ item, current }: { item: Item; current: Asset | undefined }) {
  const t = useT()
  const lang = useLang()
  const all = useAllAssets()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const btn = useRef<HTMLButtonElement>(null)
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((a) =>
      needle ? [a.name, a.nameRu ?? '', ...(a.tags ?? [])].some((s) => s.toLowerCase().includes(needle)) : !current || a.category === current.category,
    )
  }, [all, q, current])

  const replace = async (a: Asset) => {
    let asset = a
    if (a.remote) {
      const local = await downloadEntry('asset', a.id)
      if (!local) return
      asset = local as Asset
    }
    tx('Заменить модель', (d) => {
      const x = d.items[item.id]
      if (!x) return
      // a shared column turned into furniture: the other furnishing variants keep the column
      beforeItemAssetChange(d, item.id, asset.category, uiStore.getState().catalog)
      x.assetId = asset.id
      x.size = { ...asset.size }
      x.mount = asset.mount
      if (asset.elevation !== undefined && asset.mount !== 'floor') x.elevation = asset.elevation
      delete x.params
      delete x.overrides
    })
    setOpen(false)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-left text-xs hover:border-[var(--accent)]"
      >
        <span className="min-w-0 flex-1 truncate">{current ? displayName(current, lang) : item.assetId}</span>
        <Replace className="size-3.5 shrink-0 text-[var(--muted)]" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={btn} width={300} aria-label={t('Заменить модель')}>
        <div className="flex flex-col gap-2 p-2">
          <SearchInput value={q} onChange={setQ} placeholder={t('Поиск по каталогу')} autoFocus />
          <div className="grid max-h-80 grid-cols-3 gap-1.5 overflow-y-auto [scrollbar-width:thin]">
            {list.map((a) => (
              <ReplaceTile key={a.id} asset={a} selected={a.id === item.assetId} onPick={() => void replace(a)} lang={lang} />
            ))}
            {list.length === 0 && <div className="col-span-3 py-4 text-center text-[11px] text-[var(--muted)]">{t('Ничего не найдено')}</div>}
          </div>
        </div>
      </Popover>
    </>
  )
}

function ReplaceTile({ asset, selected, onPick, lang }: { asset: Asset; selected: boolean; onPick(): void; lang: 'ru' | 'en' }) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref)
  const thumb = useAssetThumb(asset, visible)
  return (
    <div ref={ref} className={cn(asset.remote && 'opacity-80')}>
      <Thumb src={thumb} fallback={assetIcon(asset.category)} label={displayName(asset, lang)} selected={selected} onClick={onPick} />
    </div>
  )
}
