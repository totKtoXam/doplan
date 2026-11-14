import { useState } from 'react'
import { CircleDot, Image, Ruler, Scan, Type } from 'lucide-react'
import type { Id, Label, Underlay } from '@core/types'
import { moveNode } from '@core'
import { useDoc } from '@/store/document'
import { uiStore } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, Input, NumberInput, Row, Section, Slider, Toggle, formatLength } from '@/ui/kit'
import { tx } from '../common/catalog'
import { NodeAngleField } from './NodeAngleField'
import { PerspectiveDialog } from '../PerspectiveDialog'
import { Hint, InspectorHeader, Pair, Stat } from './shared'

export function NodeInspector({ id }: { id: Id }) {
  const t = useT()
  const n = useDoc((s) => s.doc.nodes[id])
  const degree = useDoc((s) => Object.values(s.doc.walls).filter((w) => w.a === id || w.b === id).length)
  if (!n) return null
  return (
    <div>
      <InspectorHeader icon={<CircleDot />} title={t('Узел')} canDuplicate={false} />
      <Section title={t('Положение')} id="insp.node">
        <Pair>
          <NumberInput kind="length" label="X" value={n.x} round={1} onChange={(v, g) => tx('Переместить узел', (d) => moveNode(d, id, v, d.nodes[id]?.y ?? n.y), `node.${id}.x.${g}`)} />
          <NumberInput kind="length" label="Y" value={n.y} round={1} onChange={(v, g) => tx('Переместить узел', (d) => moveNode(d, id, d.nodes[id]?.x ?? n.x, v), `node.${id}.y.${g}`)} />
        </Pair>
        <Stat label={t('Стен в узле')} value={degree} />
        <NodeAngleField id={id} />
      </Section>
    </div>
  )
}

export function DimensionInspector({ id }: { id: Id }) {
  const t = useT()
  const dim = useDoc((s) => s.doc.dimensions[id])
  const units = useDoc((s) => s.doc.settings.units)
  if (!dim) return null
  const len = Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y)
  return (
    <div>
      <InspectorHeader icon={<Ruler />} title={t('Размерная линия')} subtitle={formatLength(len, units)} />
      <Section title={t('Размер')} id="insp.dim">
        <Stat label={t('Длина')} value={formatLength(len, units)} />
        <Row label={t('Отступ линии')}>
          <NumberInput
            kind="length"
            value={dim.offset}
            round={1}
            onChange={(v, g) =>
              tx('Отступ размера', (d) => {
                const x = d.dimensions[id]
                if (x) x.offset = v
              }, `dim.${id}.off.${g}`)
            }
          />
        </Row>
      </Section>
    </div>
  )
}

export function LabelInspector({ id }: { id: Id }) {
  const t = useT()
  const l = useDoc((s) => s.doc.labels[id])
  if (!l) return null
  const set = (label: string, fn: (x: Label) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.labels[id]
      if (x) fn(x)
    }, merge)
  return (
    <div>
      <InspectorHeader icon={<Type />} title={t('Подпись')} subtitle={l.text} />
      <Section title={t('Текст')} id="insp.label">
        <Input value={l.text} onChange={(v) => set('Текст подписи', (x) => (x.text = v), `label.${id}.text`)} onKeyDown={(e) => e.stopPropagation()} />
        <Row label={t('Размер шрифта')}>
          <NumberInput kind="length" value={l.size} min={20} max={2000} round={1} onChange={(v, g) => set('Размер подписи', (x) => (x.size = v), `label.${id}.size.${g}`)} />
        </Row>
        <Pair>
          <NumberInput kind="length" label="X" value={l.x} round={1} onChange={(v, g) => set('Переместить подпись', (x) => (x.x = v), `label.${id}.x.${g}`)} />
          <NumberInput kind="length" label="Y" value={l.y} round={1} onChange={(v, g) => set('Переместить подпись', (x) => (x.y = v), `label.${id}.y.${g}`)} />
        </Pair>
      </Section>
    </div>
  )
}

export function UnderlayInspector({ id }: { id: Id }) {
  const t = useT()
  const u = useDoc((s) => s.doc.underlays[id])
  const [perspectiveOpen, setPerspectiveOpen] = useState(false)
  if (!u) return null
  const set = (label: string, fn: (x: Underlay) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.underlays[id]
      if (x) fn(x)
    }, merge)
  const m = (f: string, g: string) => `underlay.${id}.${f}.${g}`
  return (
    <div>
      <InspectorHeader icon={<Image />} title={t('Подложка')} subtitle={`${u.widthPx}×${u.heightPx} px`} canDuplicate={false} />
      <Section title={t('Подложка')} id="insp.underlay">
        <Toggle checked={u.visible} onChange={(v) => set('Видимость подложки', (x) => (x.visible = v))} label={t('Показывать')} />
        <Toggle checked={u.locked} onChange={(v) => set('Блокировка подложки', (x) => (x.locked = v))} label={t('Заблокировать')} />
        <Row label={t('Прозрачность')}>
          <Slider value={u.opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, g) => set('Прозрачность подложки', (x) => (x.opacity = v), m('op', g))} />
        </Row>
        <Row label={t('Масштаб, мм/пикс')}>
          <NumberInput value={u.scale} min={0.001} step={0.01} decimals={4} disabled={u.locked} onChange={(v, g) => set('Масштаб подложки', (x) => (x.scale = v), m('sc', g))} />
        </Row>
        <Row label={t('Поворот')}>
          <NumberInput kind="angle" value={u.rotation} disabled={u.locked} onChange={(v, g) => set('Поворот подложки', (x) => (x.rotation = v), m('rot', g))} />
        </Row>
        <Pair>
          <NumberInput kind="length" label="X" value={u.x} round={1} disabled={u.locked} onChange={(v, g) => set('Сдвиг подложки', (x) => (x.x = v), m('x', g))} />
          <NumberInput kind="length" label="Y" value={u.y} round={1} disabled={u.locked} onChange={(v, g) => set('Сдвиг подложки', (x) => (x.y = v), m('y', g))} />
        </Pair>
        <Button size="sm" onClick={() => uiStore.getState().setTool('calibrate')} disabled={u.locked}>
          {t('Калибровать по двум точкам')}
        </Button>
        <Button size="sm" icon={<Scan className="size-3.5" />} onClick={() => setPerspectiveOpen(true)} disabled={u.locked}>
          {t('Выровнять перспективу')}
        </Button>
        <Hint>{t('Калибровка: щёлкните две точки известного размера на подложке и введите расстояние в мм.')}</Hint>
        <Hint>{t('Фото снято под углом? «Выровнять перспективу»: отметьте 4 угла прямоугольника известного размера.')}</Hint>
      </Section>
      {perspectiveOpen && <PerspectiveDialog open onClose={() => setPerspectiveOpen(false)} underlayId={id} />}
    </div>
  )
}
