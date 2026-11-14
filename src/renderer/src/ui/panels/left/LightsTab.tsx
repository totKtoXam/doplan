import { useMemo, useState, type ReactNode } from 'react'
import { Lamp, LampCeiling, LampWallDown, Lightbulb, Minus, RectangleHorizontal, Settings2, Sun } from 'lucide-react'
import type { LightKind } from '@core/types'
import type { UiState } from '@/contracts'
import { uiStore, useUi } from '@/store/ui'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { Button, cn, focusRing, kelvinToHex, Row, Section, Slider, Toggle, fmtNum } from '@/ui/kit'
import { LIGHT_DEFAULTS, LIGHT_KIND_RU } from '../common/labels'
import { tx } from '../common/catalog'
import { formatTime, setRender } from '../common/render'
import { CardGrid, ToolCard } from './ToolCard'
import { RenderPanel } from '../RenderPanel'

export const LIGHT_ICONS: Record<LightKind, ReactNode> = {
  ceiling: <LampCeiling className="size-6" />,
  spot: <Lightbulb className="size-6" />,
  pendant: <Lamp className="size-6" />,
  point: <LampWallDown className="size-6" />,
  strip: <Minus className="size-6" />,
  area: <RectangleHorizontal className="size-6" />,
}

const KINDS: LightKind[] = ['ceiling', 'spot', 'pendant', 'point', 'strip', 'area']

/**
 * UiState has no field for the light kind being placed; we store it as an extension key `lightKind`
 * (read by the editor's light tool) — see the integration report.
 */
export type UiLightExt = { lightKind?: LightKind }

export function LightsTab() {
  const t = useT()
  const tool = useUi((s) => s.tool)
  const lightKind = useUi((s) => (s as unknown as UiLightExt).lightKind)
  const levelId = useUi((s) => s.activeLevelId)
  const selection = useUi((s) => s.selection)
  const render = useDoc((s) => s.doc.render)
  const lightsRec = useDoc((s) => s.doc.lights)
  const lights = useMemo(() => Object.values(lightsRec).filter((l) => l.levelId === levelId), [lightsRec, levelId])
  const [renderOpen, setRenderOpen] = useState(false)

  const place = (k: LightKind) => {
    uiStore.getState().set({ tool: 'light', lightKind: k } as Partial<UiState>)
  }

  return (
    <div className="flex flex-col">
      <Section title={t('Светильники')} id="left.lights">
        <CardGrid>
          {KINDS.map((k) => (
            <ToolCard
              key={k}
              icon={LIGHT_ICONS[k]}
              label={t(LIGHT_KIND_RU[k])}
              sub={`${LIGHT_DEFAULTS[k].lumens} лм · ${LIGHT_DEFAULTS[k].temperature} K`}
              active={tool === 'light' && (lightKind ?? 'ceiling') === k}
              onClick={() => place(k)}
            />
          ))}
        </CardGrid>
      </Section>

      <Section title={t('Солнце и время суток')} id="left.sun">
        <Toggle checked={render.sunAuto} onChange={(v) => setRender('Солнце по времени', { sunAuto: v })} label={t('Солнце по времени суток')} />
        <Slider
          label={<Sun className="size-3.5" />}
          aria-label={t('Время суток')}
          value={render.timeOfDay}
          min={0}
          max={24}
          step={0.25}
          disabled={!render.sunAuto}
          format={formatTime}
          trackStyle="linear-gradient(90deg,#0b1026,#3a4a8a 22%,#f5b46b 28%,#bfe0ff 40%,#e8f4ff 50%,#bfe0ff 60%,#f59e5b 74%,#3a4a8a 80%,#0b1026)"
          onChange={(v, g) => setRender('Время суток', { timeOfDay: v }, `render.time.${g}`)}
        />
        <Row label={t('Яркость солнца')}>
          <Slider value={render.sunIntensity} min={0} max={5} step={0.05} onChange={(v, g) => setRender('Яркость солнца', { sunIntensity: v }, `render.sunI.${g}`)} />
        </Row>
        <Row label={t('Экспозиция')}>
          <Slider value={render.exposure} min={-3} max={3} step={0.05} format={(v) => `${v > 0 ? '+' : ''}${fmtNum(v, 2)}`} onChange={(v, g) => setRender('Экспозиция', { exposure: v }, `render.exp.${g}`)} />
        </Row>
        <Toggle checked={render.lightsOn} onChange={(v) => setRender(v ? 'Включить свет' : 'Выключить свет', { lightsOn: v })} label={t('Искусственный свет включён')} />
        <Button size="sm" icon={<Settings2 className="size-3.5" />} onClick={() => setRenderOpen(true)}>
          {t('Настройки рендера…')}
        </Button>
      </Section>

      <Section title={`${t('На этаже')} (${lights.length})`} id="left.lightlist">
        {lights.length === 0 && <p className="text-[11px] text-[var(--muted)]">{t('Светильников пока нет')}</p>}
        <ul className="flex flex-col gap-0.5">
          {lights.map((l) => {
            const sel = selection.some((r) => r.kind === 'light' && r.id === l.id)
            return (
              <li key={l.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => uiStore.getState().select([{ kind: 'light', id: l.id }])}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] [&_svg]:size-3.5',
                    focusRing,
                    sel ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]',
                  )}
                >
                  <span className="text-[var(--muted)] [&>svg]:!size-3.5">{LIGHT_ICONS[l.kind]}</span>
                  <span className="min-w-0 flex-1 truncate">{t(LIGHT_KIND_RU[l.kind])}</span>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: kelvinToHex(l.temperature) }} />
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">{l.lumens} лм</span>
                </button>
                <Toggle
                  size="sm"
                  checked={l.on}
                  title={l.on ? t('Выключить') : t('Включить')}
                  onChange={(v) =>
                    tx(v ? 'Включить светильник' : 'Выключить светильник', (d) => {
                      const x = d.lights[l.id]
                      if (x) x.on = v
                    })
                  }
                />
              </li>
            )
          })}
        </ul>
      </Section>
      <RenderPanel open={renderOpen} onClose={() => setRenderOpen(false)} />
    </div>
  )
}
