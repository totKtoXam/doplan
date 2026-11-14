import { useMemo, useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { computeBom, mergeCatalog } from '@core'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, Dialog, SearchInput, fmtNum } from '@/ui/kit'
import { builtins, errorText } from './common/catalog'

export interface DialogPropsBase {
  open: boolean
  onClose(): void
}

interface NormRow {
  group: string
  name: string
  qty: number | null
  unit: string
  note: string
}

const GROUP_KEYS = ['group', 'section', 'category', 'kind', 'type']
const NAME_KEYS = ['name', 'label', 'title', 'materialName', 'material', 'item', 'description']
const QTY_KEYS = ['quantity', 'qty', 'amount', 'count', 'value', 'total']
const UNIT_KEYS = ['unit', 'units', 'uom']
const NOTE_KEYS = ['note', 'notes', 'details', 'comment', 'info', 'detail']
const HIDDEN = new Set(['id', 'materialId', 'assetId', 'refs', 'ids', 'levelId', 'roomId', 'wallId'])

/**
 * computeBom's row shape belongs to core-output; the dialog reads it defensively: well-known keys become
 * columns, any other scalar fields are appended to the note.
 */
function normalise(raw: unknown): NormRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const used = new Set<string>()
  const pickStr = (keys: string[]) => {
    for (const k of keys) {
      const v = r[k]
      if (typeof v === 'string' && v.trim()) {
        used.add(k)
        return v
      }
    }
    return ''
  }
  const pickNum = (keys: string[]) => {
    for (const k of keys) {
      const v = r[k]
      if (typeof v === 'number' && Number.isFinite(v)) {
        used.add(k)
        return v
      }
    }
    return null
  }
  const group = pickStr(GROUP_KEYS)
  const name = pickStr(NAME_KEYS)
  const qty = pickNum(QTY_KEYS)
  const unit = pickStr(UNIT_KEYS)
  const notes = [pickStr(NOTE_KEYS)].filter(Boolean)
  for (const [k, v] of Object.entries(r)) {
    if (used.has(k) || HIDDEN.has(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) notes.push(`${k}: ${fmtNum(v, 2)}`)
    else if (typeof v === 'string' && v) notes.push(`${k}: ${v}`)
    else if (typeof v === 'boolean') notes.push(`${k}: ${v ? 'да' : 'нет'}`)
  }
  return { group: group || 'Прочее', name, qty, unit, note: notes.join('; ') }
}

function csvCell(s: string): string {
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** bill of materials / estimate: grouped table + CSV export (semicolon separated, UTF-8 BOM for Excel) */
export function BomDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const doc = useDoc((s) => s.doc)
  const catalog = useUi((s) => s.catalog)
  const [q, setQ] = useState('')
  const [saved, setSaved] = useState('')

  const { rows, error } = useMemo(() => {
    if (!open) return { rows: [] as NormRow[], error: '' }
    try {
      const bom = computeBom(doc, mergeCatalog(builtins(), catalog)) as unknown[]
      return { rows: bom.map(normalise), error: '' }
    } catch (e) {
      return { rows: [] as NormRow[], error: errorText(e) }
    }
  }, [open, doc, catalog])

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const m = new Map<string, NormRow[]>()
    for (const r of rows) {
      if (needle && ![r.group, r.name, r.note].some((s) => s.toLowerCase().includes(needle))) continue
      const list = m.get(r.group) ?? []
      list.push(r)
      m.set(r.group, list)
    }
    return [...m.entries()]
  }, [rows, q])

  const exportCsv = async () => {
    const head = [t('Раздел'), t('Наименование'), t('Количество'), t('Ед.'), t('Примечание')]
    const lines = [head.map(csvCell).join(';')]
    for (const r of rows) lines.push([r.group, r.name, r.qty === null ? '' : fmtNum(r.qty, 3).replace('.', ','), r.unit, r.note].map(csvCell).join(';'))
    const name = `${(doc.meta.name || 'doplan').replace(/[\\/:*?"<>|]+/g, '_')} — ${t('смета')}.csv`
    const path = await window.doplan.files.saveText(name, [{ name: 'CSV', extensions: ['csv'] }], `﻿${lines.join('\r\n')}\r\n`)
    if (path) setSaved(path)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('Ведомость материалов')}
      width="max-w-3xl"
      footer={
        <>
          {saved && <span className="mr-auto truncate text-[10px] text-[var(--muted)]">{saved}</span>}
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
        <div className="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder={t('Фильтр')} className="max-w-xs flex-1" />
          <span className="text-[10px] text-[var(--muted)]">{t('Количества с запасом на подрезку; проверьте перед закупкой.')}</span>
        </div>
        {error && <p className="text-[#ff8589]">{error}</p>}
        {!error && rows.length === 0 && <p className="py-6 text-center text-[var(--muted)]">{t('Пока нечего считать — нарисуйте помещения и задайте отделку.')}</p>}
        {groups.length > 0 && (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1.5 pr-2 font-medium">{t('Наименование')}</th>
                <th className="w-24 py-1.5 pr-2 text-right font-medium">{t('Количество')}</th>
                <th className="w-14 py-1.5 pr-2 font-medium">{t('Ед.')}</th>
                <th className="py-1.5 font-medium">{t('Примечание')}</th>
              </tr>
            </thead>
            {groups.map(([g, list]) => (
              <tbody key={g}>
                <tr>
                  <th colSpan={4} scope="colgroup" className="bg-[var(--bg)] px-1.5 py-1 text-left text-[11px] font-semibold">
                    {t(g)} <span className="font-normal text-[var(--muted)]">({list.length})</span>
                  </th>
                </tr>
                {list.map((r, i) => (
                  <tr key={i} className="border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] align-top">
                    <td className="py-1 pr-2">{r.name || '—'}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.qty === null ? '' : fmtNum(r.qty, r.qty >= 100 ? 0 : 2)}</td>
                    <td className="py-1 pr-2 text-[var(--muted)]">{r.unit}</td>
                    <td className="py-1 text-[var(--muted)]">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </Dialog>
  )
}
