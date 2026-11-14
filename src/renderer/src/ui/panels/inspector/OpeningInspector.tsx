import { ArrowLeftRight, DoorOpen, FlipVertical2 } from 'lucide-react'
import type { CurtainKind, CurtainSpec, DoorLeafStyle, DoorSlide, Id, Opening, OpeningKind } from '@core/types'
import { defaultCurtain, DOOR_LEAF_STYLES, DOOR_SLIDES, OPENING_DEFAULTS } from '@core'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { Button, NumberInput, Row, Section, Segmented, Select, Slider, Toggle, fmtNum } from '@/ui/kit'
import { MaterialPicker } from '../common/MaterialPicker'
import {
  CURTAIN_KIND_RU,
  DOOR_LEAF_STYLE_RU,
  DOOR_LOOK_KINDS,
  DOOR_SLIDE_RU,
  FABRIC_CATEGORIES,
  FRAME_CATEGORIES,
  hasLeaf,
  isWindowKind,
  OPENING_KIND_RU,
  optionsOf,
} from '../common/labels'
import { tx } from '../common/catalog'
import { Hint, InspectorHeader, Pair } from './shared'

export function OpeningInspector({ id }: { id: Id }) {
  const t = useT()
  const o = useDoc((s) => s.doc.openings[id])
  const wall = useDoc((s) => (o ? s.doc.walls[o.wallId] : undefined))
  const na = useDoc((s) => (wall ? s.doc.nodes[wall.a] : undefined))
  const nb = useDoc((s) => (wall ? s.doc.nodes[wall.b] : undefined))
  if (!o || !wall) return null
  const wallLen = na && nb ? Math.hypot(nb.x - na.x, nb.y - na.y) : undefined
  const isWin = isWindowKind(o.kind)
  const set = (label: string, fn: (x: Opening) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.openings[id]
      if (x) fn(x)
    }, merge)
  const m = (field: string, g: string) => `opening.${id}.${field}.${g}`

  const changeKind = (k: OpeningKind) =>
    set('Тип проёма', (x) => {
      const prev = OPENING_DEFAULTS[x.kind]
      const next = OPENING_DEFAULTS[k]
      // dimensions still at the previous kind's defaults follow the new kind
      if (prev && next) {
        if (x.width === prev.width) x.width = next.width
        if (x.height === prev.height) x.height = next.height
        if (x.sill === prev.sill) x.sill = next.sill
      }
      x.kind = k
      if (isWindowKind(k) && x.sashes === undefined) x.sashes = 2
    })

  return (
    <div>
      <InspectorHeader
        icon={<DoorOpen />}
        title={t(OPENING_KIND_RU[o.kind])}
        subtitle={`${fmtNum(o.width, 0)} × ${fmtNum(o.height, 0)} ${t('мм')}`}
      />
      <Section title={t('Проём')} id="insp.opening.dims">
        <Row label={t('Тип')}>
          <Select<OpeningKind> value={o.kind} options={optionsOf(OPENING_KIND_RU)} onChange={changeKind} />
        </Row>
        <Pair>
          <NumberInput kind="length" label={t('Ш')} value={o.width} min={100} max={wallLen} round={1} onChange={(v, g) => set('Ширина проёма', (x) => (x.width = v), m('w', g))} />
          <NumberInput kind="length" label={t('В')} value={o.height} min={100} max={Math.max(wall.height - o.sill, 100)} round={1} onChange={(v, g) => set('Высота проёма', (x) => (x.height = v), m('h', g))} />
        </Pair>
        <Row label={t('Высота подоконника')}>
          <NumberInput kind="length" value={o.sill} min={0} max={Math.max(wall.height - 100, 0)} round={1} onChange={(v, g) => set('Подоконник', (x) => (x.sill = v), m('sill', g))} />
        </Row>
        <Row label={t('Смещение от начала')}>
          <NumberInput kind="length" value={o.offset} min={o.width / 2} max={wallLen !== undefined ? wallLen - o.width / 2 : undefined} round={1} onChange={(v, g) => set('Сдвиг проёма', (x) => (x.offset = v), m('off', g))} />
        </Row>
        {hasLeaf(o.kind) && (
          <div className="flex gap-1.5">
            <Button size="sm" className="flex-1" icon={<ArrowLeftRight className="size-3" />} onClick={() => set('Сторона петель', (x) => (x.hinge = x.hinge === 'a' ? 'b' : 'a'))}>
              {t('Петли')}
            </Button>
            <Button size="sm" className="flex-1" icon={<FlipVertical2 className="size-3" />} onClick={() => set('Направление открывания', (x) => (x.swing = x.swing === 'left' ? 'right' : 'left'))}>
              {t('Открывание')}
            </Button>
          </div>
        )}
        {DOOR_LOOK_KINDS.has(o.kind) && (
          <>
            <Row label={t('Полотно')}>
              <Select<DoorLeafStyle | 'auto'>
                value={o.style ?? 'auto'}
                options={[{ value: 'auto', label: t('По материалу') }, ...optionsOf(DOOR_LEAF_STYLE_RU, DOOR_LEAF_STYLES)]}
                onChange={(v) => set('Вид полотна', (x) => (v === 'auto' ? delete x.style : (x.style = v)))}
              />
            </Row>
            {o.kind === 'slidingDoor' && (
              <Row label={t('Раздвижение')}>
                <Select<DoorSlide> value={o.slide ?? 'surface'} options={optionsOf(DOOR_SLIDE_RU, DOOR_SLIDES)} onChange={(v) => set('Тип раздвижной двери', (x) => (v === 'surface' ? delete x.slide : (x.slide = v)))} />
              </Row>
            )}
            <Row label={t('Ширина полотна')}>
              <Segmented<string>
                value={String(o.width)}
                onChange={(v) => set('Ширина проёма', (x) => (x.width = Number(v)))}
                options={(o.kind === 'doubleDoor' ? [1200, 1300, 1400, 1600] : o.kind === 'entranceDoor' ? [860, 900, 960, 1000] : [600, 700, 800, 900]).map((v) => ({ value: String(v), label: String(v) }))}
              />
            </Row>
            <Row label={t('Высота')}>
              <Segmented<string>
                value={String(o.height)}
                onChange={(v) => set('Высота проёма', (x) => (x.height = Math.min(Number(v), Math.max(100, wall.height - x.sill))))}
                options={[2000, 2100, 2300].map((v) => ({ value: String(v), label: String(v) }))}
              />
            </Row>
          </>
        )}
      </Section>

      <Section title={t('Материалы и детали')} id="insp.opening.mat">
        <Row label={t('Рама / коробка')}>
          <MaterialPicker value={o.frameMaterialId} noneLabel={t('По умолчанию')} categories={FRAME_CATEGORIES} onChange={(v) => set('Материал рамы', (x) => (x.frameMaterialId = v))} />
        </Row>
        {hasLeaf(o.kind) && (
          <Row label={isWin ? t('Створки') : t('Полотно')}>
            <MaterialPicker value={o.leafMaterialId} noneLabel={t('По умолчанию')} categories={FRAME_CATEGORIES} onChange={(v) => set('Материал полотна', (x) => (x.leafMaterialId = v))} />
          </Row>
        )}
        {isWin && (
          <>
            <Row label={t('Число створок')}>
              <NumberInput value={o.sashes ?? 2} min={1} max={8} step={1} round={1} onChange={(v, g) => set('Створки', (x) => (x.sashes = v), m('sash', g))} />
            </Row>
            <Row label={t('Подоконная доска')}>
              <NumberInput kind="length" value={o.sillBoard ?? 0} min={0} max={800} round={1} onChange={(v, g) => set('Подоконная доска', (x) => (x.sillBoard = v), m('sb', g))} />
            </Row>
          </>
        )}
      </Section>

      {(isWin || o.kind === 'balconyDoor') && <CurtainEditor opening={o} />}
    </div>
  )
}

function CurtainEditor({ opening }: { opening: Opening }) {
  const t = useT()
  const c = opening.curtain
  const kind: CurtainKind = c?.kind ?? 'none'
  const setC = (label: string, fn: (c: CurtainSpec) => void, merge?: string) =>
    tx(label, (d) => {
      const x = d.openings[opening.id]
      if (!x) return
      if (!x.curtain) x.curtain = defaultCurtain()
      fn(x.curtain)
    }, merge)
  const m = (f: string, g: string) => `curtain.${opening.id}.${f}.${g}`
  const hasDrape = kind === 'drapes' || kind === 'drapesAndSheer' || kind === 'roman' || kind === 'roller' || kind === 'blinds'
  const hasSheer = kind === 'sheer' || kind === 'drapesAndSheer'
  const sideways = kind === 'drapes' || kind === 'sheer' || kind === 'drapesAndSheer'

  return (
    <Section title={t('Шторы и жалюзи')} id="insp.opening.curtain">
      <Row label={t('Вид')}>
        <Select<CurtainKind>
          value={kind}
          options={optionsOf(CURTAIN_KIND_RU)}
          onChange={(k) =>
            tx('Шторы', (d) => {
              const x = d.openings[opening.id]
              if (!x) return
              if (k === 'none') {
                if (x.curtain) x.curtain.kind = 'none'
                return
              }
              x.curtain = { ...(x.curtain ?? defaultCurtain()), kind: k }
            })
          }
        />
      </Row>
      {kind !== 'none' && c && (
        <>
          {hasDrape && (
            <Row label={kind === 'blinds' ? t('Ламели') : t('Ткань')}>
              <MaterialPicker value={c.materialId} noneLabel={t('По умолчанию')} categories={kind === 'blinds' ? ['metal', 'wood', 'plastic'] : FABRIC_CATEGORIES} onChange={(v) => setC('Ткань штор', (x) => (x.materialId = v))} />
            </Row>
          )}
          {hasSheer && (
            <Row label={t('Тюль')}>
              <MaterialPicker value={c.sheerMaterialId} noneLabel={t('По умолчанию')} categories={FABRIC_CATEGORIES} onChange={(v) => setC('Тюль', (x) => (x.sheerMaterialId = v))} />
            </Row>
          )}
          <Row label={sideways ? t('Задёрнуты') : t('Опущены')}>
            <Slider value={c.closed} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, g) => setC('Положение штор', (x) => (x.closed = v), m('closed', g))} />
          </Row>
          <Row label={t('Сторона')}>
            <Segmented
              value={c.side}
              onChange={(v) => setC('Сторона штор', (x) => (x.side = v))}
              options={[
                { value: 'left', label: t('Левая') },
                { value: 'right', label: t('Правая') },
              ]}
            />
          </Row>
          {sideways && (
            <Row label={t('Выпуск за проём')}>
              <NumberInput kind="length" value={c.overhang} min={0} max={1500} round={1} onChange={(v, g) => setC('Выпуск штор', (x) => (x.overhang = v), m('oh', g))} />
            </Row>
          )}
          <Toggle checked={c.fullHeight} onChange={(v) => setC('Высота штор', (x) => (x.fullHeight = v))} label={t('От потолка до пола')} />
          <Hint>{t('Сторона — с какой стороны стены висят шторы (внутрь помещения).')}</Hint>
        </>
      )}
    </Section>
  )
}
