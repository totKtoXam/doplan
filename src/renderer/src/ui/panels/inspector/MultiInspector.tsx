import { useMemo, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Layers,
  RotateCcw,
  RotateCw,
} from 'lucide-react'
import type { Doc, EntityKind, EntityRef } from '@core/types'
import { useDoc } from '@/store/document'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { Button, IconButton, NumberInput, Row, Section } from '@/ui/kit'
import { MaterialPicker } from '../common/MaterialPicker'
import { WALL_CATEGORIES } from '../common/labels'
import { applyMaterialToRefs } from '../common/edits'
import { tx } from '../common/catalog'
import { InspectorHeader, Stat } from './shared'

const KIND_RU: Record<EntityKind, string> = {
  node: 'Узлы',
  wall: 'Стены',
  opening: 'Проёмы',
  room: 'Помещения',
  item: 'Предметы',
  light: 'Светильники',
  dimension: 'Размеры',
  label: 'Подписи',
  underlay: 'Подложки',
}

type Box = { ref: EntityRef; cx: number; cy: number; hw: number; hh: number }

/** footprint boxes of movable entities (items, lights, labels) */
function boxesOf(doc: Doc, refs: EntityRef[]): Box[] {
  const out: Box[] = []
  for (const r of refs) {
    if (r.kind === 'item') {
      const it = doc.items[r.id]
      if (!it || it.locked) continue
      const a = (it.rotation * Math.PI) / 180
      const c = Math.abs(Math.cos(a))
      const s = Math.abs(Math.sin(a))
      out.push({ ref: r, cx: it.x, cy: it.y, hw: (c * it.size.w + s * it.size.d) / 2, hh: (s * it.size.w + c * it.size.d) / 2 })
    } else if (r.kind === 'light') {
      const l = doc.lights[r.id]
      if (l) out.push({ ref: r, cx: l.x, cy: l.y, hw: 0, hh: 0 })
    } else if (r.kind === 'label') {
      const l = doc.labels[r.id]
      if (l) out.push({ ref: r, cx: l.x, cy: l.y, hw: 0, hh: 0 })
    }
  }
  return out
}

function moveTo(d: Doc, ref: EntityRef, x: number, y: number) {
  const e = ref.kind === 'item' ? d.items[ref.id] : ref.kind === 'light' ? d.lights[ref.id] : ref.kind === 'label' ? d.labels[ref.id] : undefined
  if (!e) return
  e.x = Math.round(x)
  e.y = Math.round(y)
}

type Align = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export function MultiInspector({ refs }: { refs: EntityRef[] }) {
  const t = useT()
  const doc = useDoc((s) => s.doc)
  const [angle, setAngle] = useState(15)

  const counts = useMemo(() => {
    const c = new Map<EntityKind, number>()
    for (const r of refs) c.set(r.kind, (c.get(r.kind) ?? 0) + 1)
    return [...c.entries()]
  }, [refs])

  const boxes = useMemo(() => boxesOf(doc, refs), [doc, refs])
  const wallRefs = refs.filter((r) => r.kind === 'wall' && doc.walls[r.id])
  const walls = wallRefs.map((r) => doc.walls[r.id])
  const common = <T,>(vals: T[]): T | null => (vals.length > 0 && vals.every((v) => v === vals[0]) ? vals[0] : null)

  const align = (mode: Align) => {
    if (boxes.length < 2) return
    const minX = Math.min(...boxes.map((b) => b.cx - b.hw))
    const maxX = Math.max(...boxes.map((b) => b.cx + b.hw))
    const minY = Math.min(...boxes.map((b) => b.cy - b.hh))
    const maxY = Math.max(...boxes.map((b) => b.cy + b.hh))
    tx('Выровнять', (d) => {
      for (const b of boxes) {
        let x = b.cx
        let y = b.cy
        if (mode === 'left') x = minX + b.hw
        if (mode === 'right') x = maxX - b.hw
        if (mode === 'hcenter') x = (minX + maxX) / 2
        if (mode === 'top') y = minY + b.hh
        if (mode === 'bottom') y = maxY - b.hh
        if (mode === 'vcenter') y = (minY + maxY) / 2
        moveTo(d, b.ref, x, y)
      }
    })
  }

  const distribute = (axis: 'x' | 'y') => {
    if (boxes.length < 3) return
    const sorted = [...boxes].sort((a, b) => (axis === 'x' ? a.cx - b.cx : a.cy - b.cy))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    // equal gaps between footprints
    const total = axis === 'x' ? last.cx + last.hw - (first.cx - first.hw) : last.cy + last.hh - (first.cy - first.hh)
    const sizes = sorted.reduce((s, b) => s + (axis === 'x' ? b.hw * 2 : b.hh * 2), 0)
    const gap = (total - sizes) / (sorted.length - 1)
    tx('Распределить', (d) => {
      let pos = axis === 'x' ? first.cx - first.hw : first.cy - first.hh
      for (const b of sorted) {
        const half = axis === 'x' ? b.hw : b.hh
        const c = pos + half
        if (axis === 'x') moveTo(d, b.ref, c, b.cy)
        else moveTo(d, b.ref, b.cx, c)
        pos += half * 2 + gap
      }
    })
  }

  return (
    <div>
      <InspectorHeader icon={<Layers />} title={`${t('Выделено')}: ${refs.length}`} />
      <Section title={t('Состав')} id="insp.multi.count">
        {counts.map(([k, n]) => (
          <Stat key={k} label={t(KIND_RU[k])} value={n} />
        ))}
      </Section>

      <Section title={t('Выравнивание')} id="insp.multi.align">
        <div className="flex flex-wrap gap-0.5">
          <IconButton icon={<AlignStartVertical />} label={t('По левому краю')} disabled={boxes.length < 2} onClick={() => align('left')} />
          <IconButton icon={<AlignCenterVertical />} label={t('По центру (горизонтально)')} disabled={boxes.length < 2} onClick={() => align('hcenter')} />
          <IconButton icon={<AlignEndVertical />} label={t('По правому краю')} disabled={boxes.length < 2} onClick={() => align('right')} />
          <IconButton icon={<AlignStartHorizontal />} label={t('По верхнему краю')} disabled={boxes.length < 2} onClick={() => align('top')} />
          <IconButton icon={<AlignCenterHorizontal />} label={t('По центру (вертикально)')} disabled={boxes.length < 2} onClick={() => align('vcenter')} />
          <IconButton icon={<AlignEndHorizontal />} label={t('По нижнему краю')} disabled={boxes.length < 2} onClick={() => align('bottom')} />
          <IconButton icon={<AlignHorizontalDistributeCenter />} label={t('Распределить по горизонтали')} disabled={boxes.length < 3} onClick={() => distribute('x')} />
          <IconButton icon={<AlignVerticalDistributeCenter />} label={t('Распределить по вертикали')} disabled={boxes.length < 3} onClick={() => distribute('y')} />
        </div>
        {boxes.length < 2 && <p className="text-[10px] text-[var(--muted)]">{t('Выравниваются предметы, светильники и подписи.')}</p>}
      </Section>

      <Section title={t('Поворот группы')} id="insp.multi.rotate">
        <div className="flex flex-wrap gap-1">
          <Button size="sm" icon={<RotateCcw className="size-3" />} onClick={() => void actions.groupRotate(-90)}>
            −90°
          </Button>
          <Button size="sm" icon={<RotateCw className="size-3" />} onClick={() => void actions.groupRotate(90)}>
            +90°
          </Button>
          <Button size="sm" onClick={() => void actions.groupRotate(180)}>
            180°
          </Button>
        </div>
        <Row label={t('Произвольный угол')}>
          <NumberInput kind="angle" value={angle} onChange={(v) => setAngle(v)} />
          <Button size="sm" onClick={() => void actions.groupRotate(angle)}>
            {t('Повернуть')}
          </Button>
        </Row>
      </Section>

      {walls.length > 0 && (
        <Section title={`${t('Стены')} (${walls.length})`} id="insp.multi.walls">
          <Row label={t('Толщина')}>
            <NumberInput
              kind="length"
              value={common(walls.map((w) => w.thickness))}
              min={0}
              round={1}
              onChange={(v, g) =>
                tx('Толщина стен', (d) => {
                  for (const r of wallRefs) if (d.walls[r.id]) d.walls[r.id].thickness = v
                }, `multi.wt.${g}`)
              }
            />
          </Row>
          <Row label={t('Высота')}>
            <NumberInput
              kind="length"
              value={common(walls.map((w) => w.height))}
              min={50}
              round={1}
              onChange={(v, g) =>
                tx('Высота стен', (d) => {
                  for (const r of wallRefs) if (d.walls[r.id]) d.walls[r.id].height = v
                }, `multi.wh.${g}`)
              }
            />
          </Row>
          <Row label={t('Отделка (обе стороны)')}>
            <MaterialPicker
              value={common(walls.flatMap((w) => [w.left.materialId, w.right.materialId])) ?? undefined}
              mixed={common(walls.flatMap((w) => [w.left.materialId, w.right.materialId])) === null}
              categories={WALL_CATEGORIES}
              onChange={(v) => v && applyMaterialToRefs(v, wallRefs)}
            />
          </Row>
        </Section>
      )}

      <div className="p-3">
        <Button variant="danger" className="w-full" onClick={() => void actions.deleteSelection()}>
          {t('Удалить выделенное')}
        </Button>
      </div>
    </div>
  )
}
