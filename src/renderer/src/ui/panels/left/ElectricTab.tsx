import { useMemo } from 'react'
import { ELECTRIC_GROUPS, ELECTRIC_HEIGHT_PRESETS, MAX_GANGS, electricGangs, electricName, electricType, electricTypesOf } from '@core'
import type { ElectricKind, ElectricPoint } from '@core/types'
import type { UiState } from '@/contracts'
import type { ElectricToolState } from '@/editor2d/tools/electric'
import { uiStore, useUi } from '@/store/ui'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { cn, focusRing, Row, Section, Segmented, Select } from '@/ui/kit'
import { ElectricIcon } from '../common/ElectricIcon'
import { CardGrid, ToolCard } from './ToolCard'
import '@/ui/electricI18n'

/** short card captions (the full name is the tooltip) */
const SHORT_RU: Partial<Record<ElectricKind, string>> = {
  socket: 'Одинарная',
  socketDouble: 'Двойная',
  socketGround: 'С заземлением',
  socketIP44: 'IP44',
  socketLid: 'С крышкой',
  socketPower: 'Силовая 32 А',
  socketUsbA: 'С USB-A',
  socketUsbC: 'С USB-C',
  socketUsbAC: 'С USB-A+C',
  usbA: 'USB-A',
  usbC: 'USB-C',
  switch1: '1 клавиша',
  switch2: '2 клавиши',
  switch3: '3 клавиши',
  switchPass: 'Проходной',
  switchCross: 'Перекрёстный',
  dimmer: 'Диммер',
  bell: 'Звонок',
  tv: 'ТВ',
  rj45: 'RJ45',
  phone: 'Телефон',
  hdmi: 'HDMI',
  speaker: 'Акустика',
  outAc: 'Кондиционер',
  outLight: 'Светильник',
  outSconce: 'Бра',
  outHood: 'Вытяжка',
  outBoiler: 'Водонагрев.',
  outWasher: 'Стиралка',
  junction: 'Распаечная',
  panel: 'Щиток',
  sensorLeak: 'Протечка',
  sensorSmoke: 'Дым',
  sensorMotion: 'Движение',
  thermostat: 'Тёплый пол',
}

const KIND_FALLBACK: ElectricKind = 'socket'

function setTool(patch: ElectricToolState): void {
  uiStore.getState().set({ tool: 'electric', ...patch } as Partial<UiState>)
}

export function ElectricTab() {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const tool = useUi((s) => s.tool)
  const uiKind = useUi((s) => (s as unknown as ElectricToolState).electricKind)
  const uiGangs = useUi((s) => (s as unknown as ElectricToolState).electricGangs)
  const uiElevation = useUi((s) => (s as unknown as ElectricToolState).electricElevation)
  const ext: ElectricToolState = { electricKind: uiKind, electricGangs: uiGangs, electricElevation: uiElevation }
  const kind = ext.electricKind ?? KIND_FALLBACK
  const ty = electricType(kind)
  const levelId = useUi((s) => s.activeLevelId)
  const selection = useUi((s) => s.selection)
  const rec = useDoc((s) => s.doc.electrical)
  const points = useMemo(() => Object.values(rec ?? {}).filter((p) => p.levelId === levelId), [rec, levelId])
  const name = (k: ElectricKind) => (lang === 'en' ? electricType(k).en : (SHORT_RU[k] ?? electricType(k).ru))
  const full = (k: ElectricKind) => (lang === 'en' ? electricType(k).en : electricType(k).ru)
  const gangs = Math.min(MAX_GANGS, Math.max(1, ext.electricGangs ?? 1))
  const heightKey = ext.electricElevation === undefined ? 'auto' : String(ext.electricElevation)

  const counts = useMemo(() => {
    const m = new Map<ElectricKind, number>()
    for (const p of points) m.set(p.kind, (m.get(p.kind) ?? 0) + electricGangs(p))
    return m
  }, [points])

  const heightOptions = useMemo(() => {
    const opts = [{ value: 'auto', label: `${t('По типу')} — ${ty.mount === 'wall' ? `${ty.elevation} ${t('мм')}` : ty.mount === 'floor' ? t('пол') : t('потолок')}` }]
    for (const h of ELECTRIC_HEIGHT_PRESETS) opts.push({ value: String(h.h), label: `${h.h} ${t('мм')} — ${lang === 'en' ? h.en : h.ru}` })
    if (ext.electricElevation !== undefined && !ELECTRIC_HEIGHT_PRESETS.some((h) => h.h === ext.electricElevation)) {
      opts.push({ value: String(ext.electricElevation), label: `${ext.electricElevation} ${t('мм')}` })
    }
    return opts
  }, [t, ty, lang, ext.electricElevation])

  return (
    <div className="flex flex-col">
      {ELECTRIC_GROUPS.map((g) => (
        <Section key={g.id} title={lang === 'en' ? g.en : g.ru} id={`left.electric.${g.id}`}>
          <CardGrid>
            {electricTypesOf(g.id).map((x) => (
              <ToolCard
                key={x.kind}
                icon={<ElectricIcon kind={x.kind} mount={x.mount} className="size-7 text-[var(--danger,#c62828)]" />}
                label={name(x.kind)}
                sub={x.mount === 'wall' ? `h ${x.elevation}` : x.mount === 'floor' ? t('пол') : t('потолок')}
                title={`${full(x.kind)}${x.code ? ` (${x.code})` : ''}${x.note ? ` — ${t(x.note)}` : ''}`}
                active={tool === 'electric' && kind === x.kind}
                onClick={() => setTool({ electricKind: x.kind })}
              />
            ))}
          </CardGrid>
        </Section>
      ))}

      <Section title={t('Установка')} id="left.electric.place">
        <p className="text-[11px] text-[var(--muted)]">
          {full(kind)}. {ty.mount === 'wall' ? t('Щёлкните у стены — точка встанет на её грань. Alt — без привязки.') : t('Щёлкните на плане, чтобы поставить.')} {t('В 3D — щелчок по стене, потолку или полу; в прогулке — по прицелу. PgUp/PgDn — высота, [ ] — тип, +/− — посты.')}
        </p>
        {ty.framed && (
          <Row label={t('Постов в рамке')}>
            <Segmented<string>
              aria-label={t('Постов в рамке')}
              value={String(gangs)}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(v) => setTool({ electricKind: kind, electricGangs: Number(v) })}
            />
          </Row>
        )}
        {ty.mount === 'wall' && (
          <Row label={t('Высота от пола')}>
            <Select<string>
              value={heightKey}
              options={heightOptions}
              onChange={(v) => setTool({ electricKind: kind, electricElevation: v === 'auto' ? undefined : Number(v) })}
            />
          </Row>
        )}
      </Section>

      <Section title={`${t('На этаже')} (${points.length})`} id="left.electric.list">
        {points.length === 0 && <p className="text-[11px] text-[var(--muted)]">{t('Электроточек пока нет')}</p>}
        {counts.size > 0 && (
          <p className="pb-1 text-[11px] text-[var(--muted)]">
            {[...counts.entries()].map(([k, n]) => `${name(k)} ×${n}`).join(' · ')}
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {points.map((p: ElectricPoint) => {
            const sel = selection.some((r) => r.kind === 'electric' && r.id === p.id)
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => uiStore.getState().select([{ kind: 'electric', id: p.id }])}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-[11px]',
                    focusRing,
                    sel ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]',
                  )}
                >
                  <ElectricIcon kind={p.kind} gangs={p.gangs} vertical={p.vertical} mount={p.mount} className="size-4 shrink-0 text-[var(--muted)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {electricName(p, lang === 'en' ? 'en' : 'ru')}
                    {p.comment ? <span className="text-[var(--muted)]"> — {p.comment}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">{p.mount === 'wall' ? `h ${Math.round(p.elevation)}` : p.mount === 'floor' ? t('пол') : t('потолок')}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}
