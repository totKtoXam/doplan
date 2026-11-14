import { Lightbulb } from 'lucide-react'
import type { Id, Light, LightKind } from '@core/types'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { Button, NumberInput, Row, Section, Select, Slider, Toggle, kelvinToHex } from '@/ui/kit'
import { LIGHT_KIND_RU, optionsOf } from '../common/labels'
import { tx } from '../common/catalog'
import { Hint, InspectorHeader, Pair } from './shared'

const TEMP_GRADIENT = `linear-gradient(90deg, ${[1800, 2400, 2900, 3500, 4200, 5000, 6000, 7500].map((k) => kelvinToHex(k)).join(',')})`

const TEMP_PRESETS: { k: number; label: string }[] = [
  { k: 2700, label: 'Тёплый' },
  { k: 4000, label: 'Нейтральный' },
  { k: 6000, label: 'Холодный' },
]

export function LightInspector({ id }: { id: Id }) {
  const t = useT()
  const l = useDoc((s) => s.doc.lights[id])
  if (!l) return null
  const set = (label: string, fn: (x: Light) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.lights[id]
      if (x) fn(x)
    }, merge)
  const m = (f: string, g: string) => `light.${id}.${f}.${g}`
  const directional = l.kind === 'spot' || l.kind === 'strip' || l.kind === 'area'
  const sized = l.kind === 'strip' || l.kind === 'area'
  const watts = Math.round(l.lumens / 100) // ≈ LED efficacy 100 lm/W

  return (
    <div>
      <InspectorHeader icon={<Lightbulb />} title={t(LIGHT_KIND_RU[l.kind])} subtitle={`${l.lumens} лм · ${l.temperature} K`} />
      <Section title={t('Светильник')} id="insp.light.main">
        <Row label={t('Тип')}>
          <Select<LightKind>
            value={l.kind}
            options={optionsOf(LIGHT_KIND_RU)}
            onChange={(k) =>
              set('Тип светильника', (x) => {
                x.kind = k
                if ((k === 'strip' || k === 'area') && !x.size) x.size = k === 'strip' ? { w: 2000, d: 10 } : { w: 600, d: 600 }
              })
            }
          />
        </Row>
        <Toggle checked={l.on} onChange={(v) => set(v ? 'Включить светильник' : 'Выключить светильник', (x) => (x.on = v))} label={t('Включён')} />
        <Row label={t('Световой поток')}>
          <NumberInput value={l.lumens} min={0} max={50000} step={50} round={1} suffix="лм" onChange={(v, g) => set('Световой поток', (x) => (x.lumens = v), m('lm', g))} />
        </Row>
        <Hint>
          ≈ {watts} {t('Вт LED')}
        </Hint>
        <Row label={t('Цветовая температура')}>
          <span className="size-5 shrink-0 rounded-full border border-[var(--border)]" style={{ background: kelvinToHex(l.temperature), boxShadow: `0 0 10px ${kelvinToHex(l.temperature)}` }} aria-hidden />
          <NumberInput value={l.temperature} min={1500} max={10000} step={100} round={1} suffix="K" onChange={(v, g) => set('Цветовая температура', (x) => (x.temperature = v), m('k', g))} />
        </Row>
        <Slider
          aria-label={t('Цветовая температура')}
          value={l.temperature}
          min={1800}
          max={7500}
          step={50}
          format={false}
          trackStyle={TEMP_GRADIENT}
          onChange={(v, g) => set('Цветовая температура', (x) => (x.temperature = v), m('k', g))}
        />
        <div className="flex gap-1">
          {TEMP_PRESETS.map((p) => (
            <Button key={p.k} size="sm" className="flex-1" active={l.temperature === p.k} onClick={() => set('Цветовая температура', (x) => (x.temperature = p.k))}>
              <span className="size-2 rounded-full" style={{ background: kelvinToHex(p.k) }} />
              {t(p.label)}
            </Button>
          ))}
        </div>
      </Section>
      <Section title={t('Положение')} id="insp.light.pos">
        <Pair>
          <NumberInput kind="length" label="X" value={l.x} round={1} onChange={(v, g) => set('Переместить светильник', (x) => (x.x = v), m('x', g))} />
          <NumberInput kind="length" label="Y" value={l.y} round={1} onChange={(v, g) => set('Переместить светильник', (x) => (x.y = v), m('y', g))} />
        </Pair>
        <Row label={t('Высота')}>
          <NumberInput kind="length" value={l.elevation} min={0} max={20000} round={1} onChange={(v, g) => set('Высота светильника', (x) => (x.elevation = v), m('el', g))} />
        </Row>
        {directional && (
          <Row label={t('Направление')}>
            <NumberInput kind="angle" value={l.rotation ?? 0} step={1} onChange={(v, g) => set('Поворот светильника', (x) => (x.rotation = ((v % 360) + 360) % 360), m('rot', g))} />
          </Row>
        )}
        {sized && (
          <Pair>
            <NumberInput kind="length" label={t('Д')} value={l.size?.w ?? 1000} min={10} round={1} onChange={(v, g) => set('Размер светильника', (x) => (x.size = { w: v, d: x.size?.d ?? 10 }), m('sw', g))} />
            <NumberInput kind="length" label={t('Ш')} value={l.size?.d ?? 10} min={5} round={1} onChange={(v, g) => set('Размер светильника', (x) => (x.size = { w: x.size?.w ?? 1000, d: v }), m('sd', g))} />
          </Pair>
        )}
      </Section>
    </div>
  )
}
