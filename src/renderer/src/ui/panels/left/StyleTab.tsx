import { useMemo, useState } from 'react'
import { Check, Home, SquareDashedMousePointer } from 'lucide-react'
import type { Id } from '@core/types'
import { ALL_STYLE_PARTS, BUILTIN_STYLES, stylePalette, type ApplyStyleParts, type StylePreset } from '@core'
import { useUi } from '@/store/ui'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { Button, cn, focusRing, Section, Toggle } from '@/ui/kit'
import { MaterialSwatch } from '../common/MaterialPicker'
import { displayName, useLang, useMaterialMap } from '../common/catalog'
import { applyStyleTo, extraCodeText, FINISH_LABELS, STYLE_PART_LABELS, SWATCH_LABELS } from '../common/style'
import { startPainting } from './MaterialsTab'

const PARTS = Object.keys(ALL_STYLE_PARTS) as (keyof ApplyStyleParts)[]

/** palette strip of a style; a click on a swatch starts the paint tool with that material */
export function StylePaletteStrip({ style, size = 22 }: { style: StylePreset; size?: number }) {
  const t = useT()
  const lang = useLang()
  const map = useMaterialMap()
  return (
    <div className="flex gap-1">
      {stylePalette(style).map((sw) => {
        const m = map.get(sw.materialId)
        const code = extraCodeText(m, displayName(m, lang))
        return (
          <button
            key={sw.role}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              startPainting(sw.materialId)
            }}
            title={`${t(SWATCH_LABELS[sw.role])}: ${displayName(m, lang)}${code ? ` · ${code}` : ''}`}
            className={cn('rounded', focusRing)}
          >
            <MaterialSwatch material={m} size={size} />
          </button>
        )
      })}
    </div>
  )
}

export function StyleTab() {
  const t = useT()
  const lang = useLang()
  const map = useMaterialMap()
  const docStyle = useDoc((s) => s.doc.design?.styleId)
  const rooms = useDoc((s) => s.doc.rooms)
  const selection = useUi((s) => s.selection)
  const [styleId, setStyleId] = useState<Id>(docStyle ?? BUILTIN_STYLES[0].id)
  const [parts, setParts] = useState<ApplyStyleParts>(ALL_STYLE_PARTS)
  const [message, setMessage] = useState<string>('')
  const style = BUILTIN_STYLES.find((s) => s.id === styleId) ?? BUILTIN_STYLES[0]
  const selectedRooms = useMemo(() => selection.filter((r) => r.kind === 'room' && rooms[r.id]).map((r) => r.id), [selection, rooms])

  const apply = (target: Id[] | 'all') => {
    const rep = applyStyleTo(style.id, target, parts)
    if (!rep) return
    setMessage(rep.rooms === 0 ? t('Нет замкнутых помещений') : t('Применено: помещений {rooms}, стен {faces}, проёмов {openings}, предметов {items}, светильников {lights}', { ...rep }))
  }

  const materialRows = useMemo(
    () => [...Object.entries(style.finishes), ...Object.entries(style.furnishing)].filter((e): e is [string, Id] => !!e[1]),
    [style],
  )

  return (
    <div className="flex flex-col">
      <Section title={t('Стили интерьера')} id="left.styles">
        <p className="text-[10px] text-[var(--muted)]">{t('Клик по образцу — кисть этим материалом')}</p>
        <ul className="flex flex-col gap-1">
          {BUILTIN_STYLES.map((s) => {
            const active = s.id === style.id
            return (
              <li key={s.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => setStyleId(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setStyleId(s.id)
                    }
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1 rounded border px-2 py-1.5 text-left',
                    focusRing,
                    active
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                      : 'border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="min-w-0 flex-1 truncate">{lang === 'ru' ? s.nameRu : s.name}</span>
                    {docStyle === s.id && <Check className="size-3.5 text-[var(--accent)]" aria-label={t('Ко всей квартире')} />}
                  </div>
                  <StylePaletteStrip style={s} />
                  {active && <p className="text-[10px] leading-snug text-[var(--muted)]">{lang === 'ru' ? s.descriptionRu : s.description}</p>}
                </div>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title={t('Что менять')} id="left.styleParts">
        {PARTS.map((p) => (
          <Toggle key={p} checked={parts[p]} onChange={(v) => setParts({ ...parts, [p]: v })} label={t(STYLE_PART_LABELS[p])} />
        ))}
        <div className="mt-1 flex flex-col gap-1">
          <Button
            size="sm"
            icon={<SquareDashedMousePointer className="size-3.5" />}
            disabled={selectedRooms.length === 0}
            onClick={() => apply(selectedRooms)}
            title={selectedRooms.length === 0 ? t('Выберите помещения на плане или примените ко всей квартире') : undefined}
          >
            {t('К выбранным помещениям')}
            {selectedRooms.length > 0 ? ` (${selectedRooms.length})` : ''}
          </Button>
          <Button size="sm" variant="primary" icon={<Home className="size-3.5" />} onClick={() => apply('all')}>
            {t('Ко всей квартире')}
          </Button>
        </div>
        {message && <p className="text-[10px] text-[var(--muted)]" role="status">{message}</p>}
      </Section>

      <Section title={t('Материалы стиля')} id="left.styleMaterials" defaultOpen={false}>
        <ul className="flex flex-col gap-0.5">
          {materialRows.map(([role, id]) => {
            const m = map.get(id)
            const code = extraCodeText(m, displayName(m, lang))
            return (
              <li key={role}>
                <button
                  type="button"
                  onClick={() => startPainting(id)}
                  className={cn('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]', focusRing)}
                >
                  <MaterialSwatch material={m} size={16} />
                  <span className="w-24 shrink-0 truncate text-[var(--muted)]">{t(FINISH_LABELS[role] ?? role)}</span>
                  <span className="min-w-0 flex-1 truncate">{displayName(m, lang)}</span>
                  {code && <span className="shrink-0 tabular-nums text-[10px] text-[var(--muted)]">{code}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}
