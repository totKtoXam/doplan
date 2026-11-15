import { useEffect, useState } from 'react'
import { ImagePlus, Link2, Link2Off, Wallpaper, X } from 'lucide-react'
import type { Material, MaterialCategory, PriceUnit, ProductRef } from '@core/types'
import { localDate, newId, productUrl } from '@core'
import { docStore } from '@/store/document'
import { useT } from '@/i18n'
import { Button, ColorInput, Dialog, IconButton, Input, NumberInput, Row, Select, Slider, Toggle, fmtNum } from '@/ui/kit'
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY_RU, optionsOf } from './common/labels'
import { errorText, extOf, lookupMaterial, mimeOf, refreshCatalog, tx } from './common/catalog'

type MapKey = 'color' | 'normal' | 'roughness'
const MAP_KEYS: MapKey[] = ['color', 'normal', 'roughness']
const MAP_LABEL: Record<MapKey, string> = { color: 'Текстура цвета', normal: 'Карта нормалей', roughness: 'Карта шероховатости' }
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp']
const WALLPAPER_WIDTH_MM = 530

/** a map slot is either an existing URL or a freshly picked file not yet copied into the project */
interface MapSlot {
  url: string
  data?: ArrayBuffer
  ext?: string
  fileName?: string
}

interface Draft {
  name: string
  category: MaterialCategory
  color: string
  roughness: number
  metalness: number
  maps: Partial<Record<MapKey, MapSlot>>
  sizeMm: [number, number]
  /** colour-system code (paints); system 'none' = no code */
  codeSystem: string
  code: string
  /** product card: where to buy and for how much (price in the project currency) */
  vendor: string
  sku: string
  url: string
  price: number | null
  priceUnit: PriceUnit | 'none'
  pack: number | null
  /** wallpaper roll (mm) and pattern repeat; paint coverage (m²/l per coat) */
  rollW: number | null
  rollL: number | null
  repeat: number | null
  coverage: number | null
}

const CODE_SYSTEMS = ['none', 'NCS', 'RAL', 'custom']
const PRICE_UNITS: PriceUnit[] = ['м²', 'м', 'шт', 'л', 'рул.', 'уп.']
const EMPTY_PRODUCT = {
  vendor: '',
  sku: '',
  url: '',
  price: null,
  priceUnit: 'none',
  pack: null,
  rollW: null,
  rollL: null,
  repeat: null,
  coverage: null,
} satisfies Partial<Draft>

/** paint settings the editor does not show (coats) survive an edit */
const prevPaint = (id: string | null | undefined) => (id ? lookupMaterial(id)?.paint : undefined)

/** product fields the editor shows; the rest of a card (note…) is kept as it was */
const EDITED_PRODUCT_KEYS = ['vendor', 'sku', 'url', 'price', 'priceUnit', 'pack', 'source', 'updatedAt'] as const

/**
 * Product / wallpaper / paint fields of the draft as material fields (undefined = not set). Fields the
 * editor does not show (wallpaper match, product note, a feed source when nothing changed) survive.
 */
function productOf(d: Draft, prev?: Material): Pick<Material, 'product' | 'wallpaper' | 'paint'> {
  const shown: ProductRef = {}
  if (d.vendor.trim()) shown.vendor = d.vendor.trim()
  if (d.sku.trim()) shown.sku = d.sku.trim()
  const url = productUrl(d.url)
  if (url) shown.url = url
  if (d.price !== null) shown.price = d.price
  if (d.priceUnit !== 'none') shown.priceUnit = d.priceUnit
  if (d.pack !== null && d.pack > 0) shown.pack = d.pack
  const old = prev?.product
  const kept: ProductRef = { ...(old ?? {}) }
  for (const k of EDITED_PRODUCT_KEYS) delete kept[k]
  const product: ProductRef = { ...kept, ...shown }
  const changed = !old || (['vendor', 'sku', 'url', 'price', 'priceUnit', 'pack'] as const).some((k) => old[k] !== shown[k])
  if (Object.keys(shown).length > 0 || Object.keys(kept).length > 0) {
    product.source = changed ? (shown.url ? 'link' : 'manual') : (old?.source ?? 'manual')
    product.updatedAt = changed ? localDate() : (old?.updatedAt ?? localDate())
  }
  const hasProduct = Object.keys(product).length > 0

  let wallpaper: Material['wallpaper']
  if (d.category === 'wallpaper' && (d.rollW || d.rollL || d.repeat || prev?.wallpaper)) {
    const pw = prev?.wallpaper
    // unset roll sizes fall back to the standard 0.53 × 10.05 m roll the placeholders show
    wallpaper = { ...(pw ?? {}), rollW: d.rollW ?? pw?.rollW ?? 530, rollL: d.rollL ?? pw?.rollL ?? 10050 }
    if (d.repeat) wallpaper.repeat = d.repeat
    else delete wallpaper.repeat
  }
  const paint = d.category === 'paint' && d.coverage ? { coverage: d.coverage } : undefined
  return { product: hasProduct ? product : undefined, wallpaper, paint }
}

export interface MaterialEditorDialogProps {
  open: boolean
  onClose(): void
  /** edit this material: project materials are edited in place, catalog ones are copied */
  materialId?: string
  onSaved?(id: string): void
}

function emptyDraft(): Draft {
  return { name: 'Мой материал', category: 'paint', color: '#d8d4cc', roughness: 0.8, metalness: 0, maps: {}, sizeMm: [1000, 1000], codeSystem: 'none', code: '', ...EMPTY_PRODUCT }
}

function draftFrom(m: Material, copy: boolean): Draft {
  const maps: Draft['maps'] = {}
  for (const k of MAP_KEYS) {
    const url = m.maps?.[k]
    if (url) maps[k] = { url }
  }
  return {
    name: (m.nameRu || m.name) + (copy ? ' (копия)' : ''),
    category: m.category,
    color: m.color,
    roughness: m.roughness,
    metalness: m.metalness,
    maps,
    sizeMm: m.sizeMm ? [m.sizeMm[0], m.sizeMm[1]] : [1000, 1000],
    codeSystem: m.colorCode?.system ?? 'none',
    code: m.colorCode?.code ?? '',
    vendor: m.product?.vendor ?? '',
    sku: m.product?.sku ?? '',
    url: m.product?.url ?? '',
    price: m.product?.price ?? null,
    priceUnit: m.product?.priceUnit ?? 'none',
    pack: m.product?.pack ?? null,
    rollW: m.wallpaper?.rollW ?? null,
    rollL: m.wallpaper?.rollL ?? null,
    repeat: m.wallpaper?.repeat ?? null,
    coverage: m.paint?.coverage ?? null,
  }
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'))
    img.src = url
  })
}

async function pickImage(title: string) {
  const [f] = await window.doplan.files.pick([{ name: title, extensions: IMAGE_EXT }], false)
  if (!f) return null
  const data = await window.doplan.files.read(f.path)
  const ext = extOf(f.name) || 'png'
  const url = URL.createObjectURL(new Blob([data], { type: mimeOf(ext) }))
  return { name: f.name, data, ext, url }
}

function revokeDraft(d: Draft) {
  for (const k of MAP_KEYS) {
    const s = d.maps[k]
    if (s?.data && s.url.startsWith('blob:')) URL.revokeObjectURL(s.url)
  }
}

/** custom material editor: colour, PBR params, texture maps, real-world texture size, wallpaper-from-image shortcut */
export function MaterialEditorDialog({ open, onClose, materialId, onSaved }: MaterialEditorDialogProps) {
  const t = useT()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editId, setEditId] = useState<string | null>(null)
  const [lockAspect, setLockAspect] = useState(true)
  const [toLibrary, setToLibrary] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setBusy(false)
    setToLibrary(false)
    const local = materialId ? docStore.getState().doc.materials[materialId] : undefined
    const src = materialId ? local ?? lookupMaterial(materialId) : undefined
    setEditId(local ? local.id : null)
    setDraft(src ? draftFrom(src, !local) : emptyDraft())
  }, [open, materialId])

  // release blob URLs of picked files when the dialog closes
  useEffect(() => {
    if (open) return
    revokeDraft(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))
  const setMap = (k: MapKey, slot: MapSlot | undefined) =>
    setDraft((d) => {
      const old = d.maps[k]
      if (old?.data && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url)
      const maps = { ...d.maps }
      if (slot) maps[k] = slot
      else delete maps[k]
      return { ...d, maps }
    })

  const pickMap = async (k: MapKey) => {
    setError('')
    try {
      const img = await pickImage(t(MAP_LABEL[k]))
      if (img) setMap(k, { url: img.url, data: img.data, ext: img.ext, fileName: img.name })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const wallpaperFromImage = async () => {
    setError('')
    try {
      const img = await pickImage(t('Изображение обоев'))
      if (!img) return
      const { w, h } = await imageSize(img.url)
      const height = w > 0 ? Math.round((WALLPAPER_WIDTH_MM * h) / w) : WALLPAPER_WIDTH_MM
      setDraft((d) => {
        revokeDraft(d)
        return {
          ...d,
          name: img.name.replace(/\.[^.]+$/, ''),
          category: 'wallpaper',
          color: '#ffffff',
          roughness: 0.85,
          metalness: 0,
          maps: { color: { url: img.url, data: img.data, ext: img.ext, fileName: img.name } },
          sizeMm: [WALLPAPER_WIDTH_MM, height],
        }
      })
      setLockAspect(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const setSize = (axis: 0 | 1, v: number) =>
    setDraft((d) => {
      const s: [number, number] = [d.sizeMm[0], d.sizeMm[1]]
      if (lockAspect && s[axis] > 0) {
        const k = v / s[axis]
        s[1 - axis] = Math.max(1, Math.round(s[1 - axis] * k))
      }
      s[axis] = v
      return { ...d, sizeMm: s }
    })

  const hasMaps = MAP_KEYS.some((k) => draft.maps[k])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      // copy picked files into the project so the .doplan file is self-contained
      const maps: Material['maps'] = {}
      for (const k of MAP_KEYS) {
        const s = draft.maps[k]
        if (!s) continue
        maps[k] = s.data ? await window.doplan.project.addAsset(s.data, s.ext || 'png') : s.url
      }
      const name = draft.name.trim() || t('Мой материал')
      const code = draft.code.trim()
      const colorCode = draft.codeSystem !== 'none' && code ? { system: draft.codeSystem, code } : undefined
      // the material edited in place, or the library / catalog one a copy is made of: fields the
      // editor does not show (wallpaper match, product note, price source) come from it
      const sourceId = editId ?? materialId ?? null
      const extra = productOf(draft, sourceId ? lookupMaterial(sourceId) : undefined)
      const base: Omit<Material, 'id'> = {
        name,
        nameRu: name,
        category: draft.category,
        color: draft.color,
        roughness: draft.roughness,
        metalness: draft.metalness,
        ...(hasMaps ? { maps, sizeMm: [draft.sizeMm[0], draft.sizeMm[1]] as [number, number] } : {}),
        ...(colorCode ? { colorCode } : {}),
        ...(extra.product ? { product: extra.product } : {}),
        ...(extra.wallpaper ? { wallpaper: extra.wallpaper } : {}),
        ...(extra.paint ? { paint: { ...(prevPaint(sourceId) ?? {}), ...extra.paint } } : {}),
        custom: true,
      }
      const id = editId ?? newId('m')
      tx(editId ? t('Изменить материал') : t('Новый материал'), (d) => {
        const prev = d.materials[id]
        const next: Material = { ...(prev ?? {}), ...base, id }
        if (!hasMaps) {
          delete next.maps
          delete next.sizeMm
        }
        if (!colorCode) delete next.colorCode
        if (!extra.product) delete next.product
        if (!extra.wallpaper) delete next.wallpaper
        if (!extra.paint) delete next.paint
        d.materials[id] = next
        // a price typed on the card is used again even if it was erased in the estimate before
        const own = d.design?.priceList?.[id]
        if (own?.noPrice && extra.product?.price !== undefined) delete own.noPrice
      })

      if (toLibrary) {
        const bytes: Parameters<typeof window.doplan.catalog.importMaterial>[1] = {}
        for (const k of MAP_KEYS) {
          const s = draft.maps[k]
          if (!s) continue
          if (s.data) bytes[k] = { data: s.data, ext: s.ext || 'png' }
          else {
            try {
              const res = await fetch(s.url)
              if (res.ok) bytes[k] = { data: await res.arrayBuffer(), ext: extOf(new URL(s.url).pathname) || 'png' }
            } catch {
              /* texture not reachable — library copy goes without it */
            }
          }
        }
        const { maps: _maps, ...meta } = base
        void _maps
        await window.doplan.catalog.importMaterial(meta, bytes)
        await refreshCatalog()
      }
      onSaved?.(id)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const colourMap = draft.maps.color?.url
  const preview = {
    backgroundColor: draft.color,
    ...(colourMap
      ? {
          backgroundImage: `url("${colourMap}")`,
          backgroundBlendMode: 'multiply' as const,
          backgroundSize: `${Math.max(8, Math.min(160, (draft.sizeMm[0] / 3000) * 160))}px auto`,
        }
      : {}),
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editId ? t('Редактировать материал') : t('Новый материал')}
      width="max-w-lg"
      modalLock={busy}
      footer={
        <>
          <Toggle size="sm" checked={toLibrary} onChange={setToLibrary} label={t('Сохранить в библиотеку')} className="mr-auto" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('Отмена')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('Сохранить')}
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <div className="flex w-32 shrink-0 flex-col gap-2">
          <div
            className="aspect-square rounded-md border border-[var(--border)]"
            style={preview}
            role="img"
            aria-label={t('Предпросмотр материала')}
          />
          <Button size="sm" icon={<Wallpaper className="size-3.5" />} onClick={() => void wallpaperFromImage()} title={t('Обои из картинки: ширина рулона 530 мм, высота раппорта по пропорциям изображения')}>
            {t('Обои из картинки')}
          </Button>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Row label={t('Название')}>
            <Input value={draft.name} onChange={(v) => patch({ name: v })} onKeyDown={(e) => e.stopPropagation()} data-autofocus />
          </Row>
          <Row label={t('Категория')}>
            <Select<MaterialCategory> value={draft.category} onChange={(v) => patch({ category: v })} options={optionsOf(MATERIAL_CATEGORY_RU, MATERIAL_CATEGORIES)} />
          </Row>
          <Row label={t('Цвет')}>
            <ColorInput value={draft.color} onChange={(v) => patch({ color: v })} aria-label={t('Цвет')} />
          </Row>
          <Row label={t('Код цвета')} hint={t('NCS / RAL / код производителя; цвет на экране — приближённый')}>
            <Select<string>
              value={draft.codeSystem}
              onChange={(v) => patch({ codeSystem: v })}
              options={CODE_SYSTEMS.map((v) => ({ value: v, label: v === 'none' ? '—' : v === 'custom' ? t('Другая') : v }))}
              className="w-20 shrink-0"
              aria-label={t('Система цвета')}
            />
            <Input
              value={draft.code}
              onChange={(v) => patch({ code: v })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={draft.codeSystem === 'RAL' ? '9010' : 'S 1002-Y'}
              disabled={draft.codeSystem === 'none'}
              aria-label={t('Код цвета')}
            />
          </Row>
          <Row label={t('Шероховатость')}>
            <Slider value={draft.roughness} min={0} max={1} step={0.01} onChange={(v) => patch({ roughness: v })} format={(v) => fmtNum(v, 2)} />
          </Row>
          <Row label={t('Металличность')}>
            <Slider value={draft.metalness} min={0} max={1} step={0.01} onChange={(v) => patch({ metalness: v })} format={(v) => fmtNum(v, 2)} />
          </Row>

          {draft.category === 'wallpaper' && (
            <Row label={t('Рулон')} hint={t('ширина × длина рулона и раппорт рисунка, мм')}>
              <NumberInput kind="length" unit="mm" label={t('Ш')} value={draft.rollW} min={100} max={3000} round={1} placeholder="530" onChange={(v) => patch({ rollW: v })} onClear={() => patch({ rollW: null })} />
              <NumberInput kind="length" unit="mm" label={t('Д')} value={draft.rollL} min={1000} max={50000} round={10} placeholder="10050" onChange={(v) => patch({ rollL: v })} onClear={() => patch({ rollL: null })} />
              <NumberInput kind="length" unit="mm" label={t('Р')} value={draft.repeat} min={0} max={2000} round={1} placeholder="0" onChange={(v) => patch({ repeat: v })} onClear={() => patch({ repeat: null })} />
            </Row>
          )}
          {draft.category === 'paint' && (
            <Row label={t('Расход')} hint={t('м² на литр за один слой')}>
              <NumberInput value={draft.coverage} min={1} max={30} step={0.5} decimals={1} suffix={t('м²/л')} placeholder="8" onChange={(v) => patch({ coverage: v })} onClear={() => patch({ coverage: null })} />
            </Row>
          )}

          <div className="mt-1 text-[11px] font-semibold">{t('Товар')}</div>
          <Row label={t('Цена')} hint={t('в валюте проекта; цена в смете проекта важнее')}>
            <NumberInput value={draft.price} min={0} step={1} decimals={2} placeholder="—" onChange={(v) => patch({ price: v })} onClear={() => patch({ price: null })} aria-label={t('Цена')} />
            <Select<PriceUnit | 'none'>
              value={draft.priceUnit}
              onChange={(v) => patch({ priceUnit: v })}
              options={[{ value: 'none', label: t('за ед. сметы') }, ...PRICE_UNITS.map((u) => ({ value: u, label: `/${t(u)}` }))]}
              className="w-28 shrink-0"
              aria-label={t('Единица цены')}
            />
          </Row>
          <Row label={t('Упаковка')} hint={t('м² в упаковке, литров в банке, штук в коробке')}>
            <NumberInput value={draft.pack} min={0} step={0.1} decimals={2} placeholder="—" onChange={(v) => patch({ pack: v })} onClear={() => patch({ pack: null })} aria-label={t('Упаковка')} />
          </Row>
          <Row label={t('Поставщик')}>
            <Input value={draft.vendor} onChange={(v) => patch({ vendor: v })} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Поставщик')} />
            <Input value={draft.sku} onChange={(v) => patch({ sku: v })} onKeyDown={(e) => e.stopPropagation()} placeholder={t('Артикул')} aria-label={t('Артикул')} className="w-28 shrink-0" />
          </Row>
          <Row label={t('Ссылка')}>
            <Input value={draft.url} onChange={(v) => patch({ url: v })} onKeyDown={(e) => e.stopPropagation()} placeholder="https://" aria-label={t('Ссылка на товар')} />
          </Row>

          <div className="mt-1 text-[11px] font-semibold">{t('Текстуры')}</div>
          {MAP_KEYS.map((k) => {
            const s = draft.maps[k]
            return (
              <Row key={k} label={t(MAP_LABEL[k])}>
                {s ? (
                  <>
                    <span
                      className="size-6 shrink-0 rounded border border-[var(--border)] bg-cover bg-center"
                      style={{ backgroundImage: `url("${s.url}")` }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]" title={s.fileName ?? s.url}>
                      {s.fileName ?? s.url.split('/').pop()}
                    </span>
                    <IconButton size="sm" icon={<ImagePlus />} label={t('Заменить')} onClick={() => void pickMap(k)} />
                    <IconButton size="sm" icon={<X />} label={t('Убрать')} onClick={() => setMap(k, undefined)} />
                  </>
                ) : (
                  <Button size="sm" icon={<ImagePlus className="size-3.5" />} onClick={() => void pickMap(k)}>
                    {t('Выбрать файл…')}
                  </Button>
                )}
              </Row>
            )
          })}
          {hasMaps && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--muted)]">{t('Размер текстуры в натуре, мм')}</span>
                <IconButton size="sm" icon={lockAspect ? <Link2 /> : <Link2Off />} active={lockAspect} label={t('Сохранять пропорции')} onClick={() => setLockAspect(!lockAspect)} />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <NumberInput kind="length" unit="mm" label={t('Ш')} value={draft.sizeMm[0]} min={1} round={1} onChange={(v) => setSize(0, v)} />
                <NumberInput kind="length" unit="mm" label={t('В')} value={draft.sizeMm[1]} min={1} round={1} onChange={(v) => setSize(1, v)} />
              </div>
              <p className="text-[10px] leading-snug text-[var(--muted)]">
                {t('Какой участок стены или пола покрывает одно изображение: плитка 600×600, рулон обоев 530 мм, доска 1200×200.')}
              </p>
            </>
          )}
          {error && <p className="text-[#ff8589]">{error}</p>}
        </div>
      </div>
    </Dialog>
  )
}
