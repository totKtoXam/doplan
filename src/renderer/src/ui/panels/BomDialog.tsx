import { useMemo, useState } from 'react'
import { ExternalLink, FileDown, FileSpreadsheet, FileUp } from 'lucide-react'
import type { BomRow, Catalog } from '@core'
import { bomToCsv, bomTotals, computeBom, CURRENCIES, currencySymbol, formatMoney, mergeCatalog, parsePriceListCsv, priceListToCsv } from '@core'
import type { PriceUnit, ProductRef } from '@core/types'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { addTranslations, useT } from '@/i18n'
import { Button, Dialog, NumberInput, SearchInput, Select, fmtNum } from '@/ui/kit'
import { builtins, errorText, tx, useLang } from './common/catalog'

addTranslations('en', {
  'Ведомость материалов и смета': 'Bill of materials & estimate',
  'Валюта': 'Currency',
  '— без валюты —': '— no currency —',
  'Цена': 'Price',
  'Сумма': 'Amount',
  'Итого': 'Total',
  'Цена за': 'Price per',
  'Открыть ссылку на товар': 'Open the product link',
  'Прайс-лист CSV': 'Price list CSV',
  'Загрузить прайс-лист': 'Import price list',
  'Цена позиции': 'Item price',
  'Валюта проекта': 'Project currency',
  'Импорт прайс-листа': 'Import price list',
  'без цены': 'without price',
  'позиций с ценой': 'priced items',
  'Цены из прайс-листа проекта; правьте прямо в таблице или выгрузите прайс-лист, заполните и загрузите обратно.':
    'Prices come from the project price list: edit them in the table, or export the price list, fill it in and import it back.',
  'Загружено цен': 'Prices imported',
  'пропущено строк': 'lines skipped',
  'Количества с запасом на подрезку; проверьте перед закупкой.': 'Quantities include cutting waste; check before ordering.',
})

export interface DialogPropsBase {
  open: boolean
  onClose(): void
}

const PRICE_UNITS: readonly PriceUnit[] = ['м²', 'м', 'шт', 'л', 'рул.', 'уп.']
const asPriceUnit = (u: string | undefined): PriceUnit | undefined => PRICE_UNITS.find((x) => x === u)

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_')

/**
 * Which row of each priceable thing (refId within a group) carries the price input: the row that
 * already has a price, else the purchase row, else the first row.
 */
function priceRows(rows: BomRow[]): Set<BomRow> {
  const out = new Set<BomRow>()
  const by = new Map<string, BomRow[]>()
  for (const r of rows) {
    if (!r.refId) continue
    const k = `${r.group}|${r.refId}`
    const l = by.get(k) ?? []
    l.push(r)
    by.set(k, l)
  }
  for (const l of by.values()) out.add(l.find((r) => r.price !== undefined) ?? l.find((r) => r.purchase) ?? l[0])
  return out
}

/** bill of materials / estimate: grouped table with prices, currency, CSV export, price list CSV in/out */
export function BomDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const lang = useLang()
  const locale = lang === 'en' ? 'en-US' : 'ru-RU'
  const doc = useDoc((s) => s.doc)
  const catalog = useUi((s) => s.catalog)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const currency = doc.design?.currency

  const { rows, cat, error } = useMemo(() => {
    if (!open) return { rows: [] as BomRow[], cat: undefined as Catalog | undefined, error: '' }
    try {
      const c = mergeCatalog(builtins(), catalog)
      return { rows: computeBom(doc, c), cat: c, error: '' }
    } catch (e) {
      return { rows: [] as BomRow[], cat: undefined, error: errorText(e) }
    }
  }, [open, doc, catalog])

  const editable = useMemo(() => priceRows(rows), [rows])
  const totals = useMemo(() => bomTotals(rows), [rows])
  const money = (v: number) => formatMoney(v, currency, locale)

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const m = new Map<string, BomRow[]>()
    for (const r of rows) {
      if (needle && ![r.group, r.name, r.note ?? '', r.vendor ?? '', r.sku ?? ''].some((s) => s.toLowerCase().includes(needle))) continue
      const list = m.get(r.group) ?? []
      list.push(r)
      m.set(r.group, list)
    }
    return [...m.entries()]
  }, [rows, q])

  const setPrice = (r: BomRow, v: number, g: string) => {
    if (!r.refId) return
    const refId = r.refId
    tx(
      'Цена позиции',
      (d) => {
        const design = (d.design ??= {})
        const list = (design.priceList ??= {})
        const prev = list[refId]
        const unit = prev?.priceUnit ?? r.priceUnit ?? asPriceUnit(r.unit)
        const next: ProductRef = { ...(prev ?? {}), price: v, source: 'manual', updatedAt: new Date().toISOString().slice(0, 10) }
        if (unit) next.priceUnit = unit
        list[refId] = next
      },
      `bom.price.${refId}.${g}`,
    )
  }

  const setCurrency = (c: string) =>
    tx('Валюта проекта', (d) => {
      const design = (d.design ??= {})
      if (c === 'none') delete design.currency
      else design.currency = c
    })

  const exportCsv = async () => {
    const name = `${safeName(doc.meta.name || 'doplan')} — ${t('смета')}.csv`
    const path = await window.doplan.files.saveText(name, [{ name: 'CSV', extensions: ['csv'] }], `﻿${bomToCsv(rows, currency).replace(/\n/g, '\r\n')}\r\n`)
    if (path) setStatus(path)
  }

  const exportPriceList = async () => {
    const name = `${safeName(doc.meta.name || 'doplan')} — ${t('прайс-лист')}.csv`
    const path = await window.doplan.files.saveText(name, [{ name: 'CSV', extensions: ['csv'] }], `﻿${priceListToCsv(rows, doc, cat).replace(/\n/g, '\r\n')}\r\n`)
    if (path) setStatus(path)
  }

  const importPriceList = async () => {
    try {
      const [f] = await window.doplan.files.pick([{ name: 'CSV', extensions: ['csv', 'txt'] }], false)
      if (!f) return
      const res = parsePriceListCsv(await window.doplan.files.readText(f.path))
      const n = Object.keys(res.entries).length
      if (n > 0)
        tx('Импорт прайс-листа', (d) => {
          const design = (d.design ??= {})
          const list = (design.priceList ??= {})
          for (const [id, p] of Object.entries(res.entries)) list[id] = { ...(list[id] ?? {}), ...p }
        })
      setStatus(`${t('Загружено цен')}: ${n}${res.skipped.length ? `, ${t('пропущено строк')}: ${res.skipped.length}` : ''}`)
    } catch (e) {
      setStatus(errorText(e))
    }
  }

  const currencyOptions = useMemo(() => {
    const codes: string[] = [...CURRENCIES]
    if (currency && !codes.includes(currency)) codes.unshift(currency)
    return [
      { value: 'none', label: t('— без валюты —') },
      ...codes.map((c) => {
        const s = currencySymbol(c, locale)
        return { value: c, label: s === c ? c : `${s}  ${c}` }
      }),
    ]
  }, [currency, locale, t])

  const sym = currency ? currencySymbol(currency, locale) : ''

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Ведомость материалов и смета')}
      width="max-w-5xl"
      footer={
        <>
          {status && <span className="mr-auto truncate text-[10px] text-[var(--muted)]">{status}</span>}
          <Button variant="ghost" icon={<FileUp className="size-3.5" />} onClick={() => void importPriceList()}>
            {t('Загрузить прайс-лист')}
          </Button>
          <Button variant="ghost" icon={<FileDown className="size-3.5" />} disabled={rows.length === 0} onClick={() => void exportPriceList()}>
            {t('Прайс-лист CSV')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('Закрыть')}
          </Button>
          <Button variant="primary" icon={<FileSpreadsheet className="size-3.5" />} disabled={rows.length === 0} onClick={() => void exportCsv()}>
            {t('Экспорт CSV')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder={t('Фильтр')} className="max-w-xs flex-1" />
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
            {t('Валюта')}
            <Select value={currency ?? 'none'} options={currencyOptions} onChange={setCurrency} aria-label={t('Валюта проекта')} className="w-36" />
          </label>
          <span className="text-[10px] text-[var(--muted)]">{t('Количества с запасом на подрезку; проверьте перед закупкой.')}</span>
        </div>
        {error && <p className="text-[#ff8589]">{error}</p>}
        {!error && rows.length === 0 && <p className="py-6 text-center text-[var(--muted)]">{t('Пока нечего считать — нарисуйте помещения и задайте отделку.')}</p>}
        {groups.length > 0 && (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1.5 pr-2 font-medium">{t('Наименование')}</th>
                <th className="w-20 py-1.5 pr-2 text-right font-medium">{t('Количество')}</th>
                <th className="w-12 py-1.5 pr-2 font-medium">{t('Ед.')}</th>
                <th className="w-32 py-1.5 pr-2 text-right font-medium">
                  {t('Цена')}
                  {sym ? `, ${sym}` : ''}
                </th>
                <th className="w-24 py-1.5 pr-2 text-right font-medium">{t('Сумма')}</th>
                <th className="py-1.5 font-medium">{t('Примечание')}</th>
              </tr>
            </thead>
            {groups.map(([g, list]) => (
              <tbody key={g}>
                <tr>
                  <th colSpan={4} scope="colgroup" className="bg-[var(--bg)] px-1.5 py-1 text-left text-[11px] font-semibold">
                    {t(g)} <span className="font-normal text-[var(--muted)]">({list.length})</span>
                  </th>
                  <th className="bg-[var(--bg)] py-1 pr-2 text-right text-[11px] font-semibold tabular-nums">
                    {totals.byGroup[g as BomRow['group']] ? money(totals.byGroup[g as BomRow['group']]!) : ''}
                  </th>
                  <th className="bg-[var(--bg)]" />
                </tr>
                {list.map((r, i) => (
                  <tr key={i} className="border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] align-top">
                    <td className="py-1 pr-2">
                      <span className="inline-flex items-center gap-1">
                        {r.name || '—'}
                        {r.url && (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={t('Открыть ссылку на товар')}
                            aria-label={t('Открыть ссылку на товар')}
                            className="text-[var(--muted)] hover:text-[var(--fg)]"
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </span>
                      {(r.vendor || r.sku) && (
                        <div className="text-[10px] text-[var(--muted)]">{[r.vendor, r.sku].filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtNum(r.quantity, r.quantity >= 100 ? 0 : 2)}</td>
                    <td className="py-1 pr-2 text-[var(--muted)]">{r.unit}</td>
                    <td className="py-0.5 pr-2 text-right">
                      {editable.has(r) ? (
                        <NumberInput
                          value={r.price ?? null}
                          min={0}
                          step={1}
                          decimals={2}
                          placeholder="—"
                          suffix={r.priceUnit && r.priceUnit !== r.unit ? `/${r.priceUnit}` : ''}
                          title={r.priceUnit ? `${t('Цена за')} ${r.priceUnit}` : undefined}
                          aria-label={`${t('Цена')}: ${r.name}`}
                          onChange={(v, gst) => setPrice(r, v, gst)}
                        />
                      ) : null}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.total !== undefined ? money(r.total) : ''}</td>
                    <td className="py-1 text-[var(--muted)]">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t border-[var(--border)]">
                <th colSpan={4} scope="row" className="py-1.5 pr-2 text-right text-[11px] font-semibold">
                  {t('Итого')}
                </th>
                <td className="py-1.5 pr-2 text-right text-[12px] font-semibold tabular-nums">{money(totals.total)}</td>
                <td className="py-1.5 text-[10px] text-[var(--muted)]">
                  {totals.priced} {t('позиций с ценой')}
                  {totals.unpriced ? `, ${totals.unpriced} ${t('без цены')}` : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        <p className="text-[10px] text-[var(--muted)]">
          {t('Цены из прайс-листа проекта; правьте прямо в таблице или выгрузите прайс-лист, заполните и загрузите обратно.')}
        </p>
      </div>
    </Dialog>
  )
}
