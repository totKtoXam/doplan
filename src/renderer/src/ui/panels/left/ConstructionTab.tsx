import { useState } from 'react'
import { FileUp, ImageUp, ScanText } from 'lucide-react'
import type { DocSettings, OpeningKind, RoomType, Vec2, WallKind } from '@core/types'
import { addWall, defaultRoom, OPENING_DEFAULTS, polylabel } from '@core'
import { uiStore, useUi } from '@/store/ui'
import { docStore, useDoc } from '@/store/document'
import { handles } from '@/store/handles'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { Button, Dialog, Input, NumberInput, Row, Section, Segmented, Select, Toggle, fmtNum } from '@/ui/kit'
import { DOOR_KINDS, OPENING_KIND_RU, ROOM_TYPES, roomTypeName, WALL_KIND_RU, WINDOW_KINDS, isWindowKind } from '../common/labels'
import { freeOrigin, offsetPolygon } from '../common/edits'
import { tx, useLang } from '../common/catalog'
import { OpeningKindIcon, RoomShapeIcon, WallKindIcon } from './symbols'
import { CardGrid, ToolCard } from './ToolCard'
import { PhotoPlanDialog } from '../PhotoPlanDialog'

const WALL_KINDS: WallKind[] = ['wall', 'partition', 'parapet', 'glazing', 'virtual']

export function wallDefaults(kind: WallKind, s: DocSettings): { thickness?: number; height?: number } {
  switch (kind) {
    case 'wall':
      return { thickness: s.wallThickness, height: s.wallHeight }
    case 'partition':
      return { thickness: 100, height: s.wallHeight }
    case 'parapet':
      return { thickness: 120, height: 1000 }
    case 'glazing':
      return { thickness: 70, height: s.wallHeight }
    case 'virtual':
      return {}
  }
}

export function ConstructionTab() {
  const t = useT()
  const tool = useUi((s) => s.tool)
  const wallKind = useUi((s) => s.wallKind)
  const wallThickness = useUi((s) => s.wallThickness)
  const wallHeight = useUi((s) => s.wallHeight)
  const openingKind = useUi((s) => s.openingKind)
  const [wizard, setWizard] = useState<null | 'rect' | 'L'>(null)
  const [photo, setPhoto] = useState(false)

  const pickWall = (k: WallKind) => {
    const d = wallDefaults(k, docStore.getState().doc.settings)
    uiStore.getState().set({ tool: 'wall', wallKind: k, ...(d.thickness ? { wallThickness: d.thickness } : {}), ...(d.height ? { wallHeight: d.height } : {}) })
  }
  const pickOpening = (k: OpeningKind) => {
    uiStore.getState().set({ tool: isWindowKind(k) ? 'window' : 'door', openingKind: k })
  }

  return (
    <div className="flex flex-col">
      <Section title={t('Стены')} id="left.walls">
        <CardGrid>
          {WALL_KINDS.map((k) => (
            <ToolCard
              key={k}
              icon={<WallKindIcon kind={k} />}
              label={t(WALL_KIND_RU[k])}
              active={tool === 'wall' && wallKind === k}
              onClick={() => pickWall(k)}
            />
          ))}
        </CardGrid>
        <Row label={t('Толщина')}>
          <NumberInput kind="length" value={wallThickness} min={0} max={2000} round={1} onChange={(v) => uiStore.getState().set({ wallThickness: v })} />
        </Row>
        <Row label={t('Высота')}>
          <NumberInput kind="length" value={wallHeight} min={100} max={20000} round={1} onChange={(v) => uiStore.getState().set({ wallHeight: v })} />
        </Row>
        <p className="text-[10px] leading-snug text-[var(--muted)]">
          {t('Щёлкайте по плану, чтобы ставить узлы; во время рисования введите число — длина сегмента. Esc — закончить.')}
        </p>
      </Section>

      <Section title={t('Помещения')} id="left.rooms">
        <CardGrid>
          <ToolCard
            icon={<RoomShapeIcon shape="rect" />}
            label={t('Прямоугольная')}
            sub={t('мышью')}
            active={tool === 'room'}
            onClick={() => uiStore.getState().setTool('room')}
          />
          <ToolCard icon={<RoomShapeIcon shape="L" />} label={t('Г-образная')} sub={t('по размерам')} onClick={() => setWizard('L')} />
          <ToolCard icon={<RoomShapeIcon shape="dims" />} label={t('По размерам')} sub={t('мастер')} onClick={() => setWizard('rect')} />
        </CardGrid>
      </Section>

      <Section title={t('Двери и проёмы')} id="left.doors">
        <CardGrid>
          {DOOR_KINDS.map((k) => (
            <ToolCard
              key={k}
              icon={<OpeningKindIcon kind={k} />}
              label={t(OPENING_KIND_RU[k])}
              sub={sizeLabel(k)}
              active={(tool === 'door' || tool === 'window') && openingKind === k}
              onClick={() => pickOpening(k)}
            />
          ))}
        </CardGrid>
      </Section>

      <Section title={t('Окна')} id="left.windows">
        <CardGrid>
          {WINDOW_KINDS.map((k) => (
            <ToolCard
              key={k}
              icon={<OpeningKindIcon kind={k} />}
              label={t(OPENING_KIND_RU[k])}
              sub={sizeLabel(k)}
              active={(tool === 'door' || tool === 'window') && openingKind === k}
              onClick={() => pickOpening(k)}
            />
          ))}
        </CardGrid>
      </Section>

      <Section title={t('Импорт плана')} id="left.import" defaultOpen={false}>
        <Button icon={<ImageUp className="size-3.5" />} onClick={() => void actions.importUnderlay()}>
          {t('Подложка для обводки…')}
        </Button>
        <Button icon={<ScanText className="size-3.5" />} onClick={() => setPhoto(true)}>
          {t('План по фото (ИИ)…')}
        </Button>
        <Button icon={<FileUp className="size-3.5" />} onClick={() => void actions.importPlanSpec()}>
          {t('Открыть PlanSpec…')}
        </Button>
      </Section>

      <RoomWizardDialog shape={wizard} onClose={() => setWizard(null)} />
      <PhotoPlanDialog open={photo} onClose={() => setPhoto(false)} />
    </div>
  )
}

function sizeLabel(k: OpeningKind): string {
  const d = OPENING_DEFAULTS[k]
  if (!d) return ''
  return `${fmtNum(d.width / 10, 0)}×${fmtNum(d.height / 10, 0)}`
}

// ───────────────────────────── room by dimensions wizard ─────────────────────────────

function RoomWizardDialog({ shape, onClose }: { shape: null | 'rect' | 'L'; onClose(): void }) {
  const t = useT()
  const lang = useLang()
  const settings = useDoc((s) => s.doc.settings)
  const [kind, setKind] = useState<'rect' | 'L'>('rect')
  const [w, setW] = useState(4000)
  const [h, setH] = useState(3000)
  const [cw, setCw] = useState(1500)
  const [ch, setCh] = useState(1200)
  const [inner, setInner] = useState(true)
  const [thick, setThick] = useState<number | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<RoomType>('living')
  const [lastShape, setLastShape] = useState<typeof shape>(null)

  if (shape !== lastShape) {
    setLastShape(shape)
    if (shape) setKind(shape)
  }

  const thickness = thick ?? settings.wallThickness
  const wallH = height ?? settings.wallHeight
  const lCut = kind === 'L'
  const valid = w > 300 && h > 300 && (!lCut || (cw > 100 && ch > 100 && cw < w - 300 && ch < h - 300))

  const create = () => {
    if (!valid) return
    const levelId = uiStore.getState().activeLevelId
    const o = freeOrigin(levelId)
    const innerPoly: Vec2[] = lCut
      ? [
          { x: 0, y: 0 },
          { x: w - cw, y: 0 },
          { x: w - cw, y: ch },
          { x: w, y: ch },
          { x: w, y: h },
          { x: 0, y: h },
        ]
      : [
          { x: 0, y: 0 },
          { x: w, y: 0 },
          { x: w, y: h },
          { x: 0, y: h },
        ]
    const centre = inner ? offsetPolygon(innerPoly, thickness / 2) : innerPoly
    const shift = (p: Vec2): Vec2 => ({ x: Math.round(p.x + o.x), y: Math.round(p.y + o.y) })
    const pts = centre.map(shift)
    const anchor = shift(polylabel(innerPoly))
    const created: string[] = []
    tx(lCut ? 'Г-образная комната' : 'Комната по размерам', (d) => {
      for (let i = 0; i < pts.length; i++) {
        const ids = addWall(d, levelId, pts[i], pts[(i + 1) % pts.length], { thickness, height: wallH, kind: 'wall' })
        created.push(...ids)
      }
      const room = defaultRoom(levelId, anchor)
      room.type = type
      room.name = name.trim() || roomTypeName(type, lang)
      d.rooms[room.id] = room
    })
    const walls = created.filter((id) => docStore.getState().doc.walls[id])
    if (walls.length) uiStore.getState().select(walls.map((id) => ({ kind: 'wall' as const, id })))
    handles.editor2d?.zoomToFit()
    onClose()
  }

  return (
    <Dialog
      open={shape !== null}
      onClose={onClose}
      title={t('Комната по размерам')}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Отмена')}
          </Button>
          <Button variant="primary" disabled={!valid} onClick={create}>
            {t('Создать')}
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <WizardPreview w={w} h={h} cw={lCut ? cw : 0} ch={lCut ? ch : 0} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Segmented<typeof kind>
            value={kind}
            onChange={setKind}
            aria-label={t('Форма')}
            options={[
              { value: 'rect', label: t('Прямоугольник') },
              { value: 'L', label: t('Г-образная') },
            ]}
          />
          <Row label={t('Ширина')}>
            <NumberInput kind="length" value={w} min={300} round={1} onChange={setW} />
          </Row>
          <Row label={t('Глубина')}>
            <NumberInput kind="length" value={h} min={300} round={1} onChange={setH} />
          </Row>
          {lCut && (
            <>
              <Row label={t('Вырез: ширина')}>
                <NumberInput kind="length" value={cw} min={100} round={1} onChange={setCw} />
              </Row>
              <Row label={t('Вырез: глубина')}>
                <NumberInput kind="length" value={ch} min={100} round={1} onChange={setCh} />
              </Row>
            </>
          )}
          <Toggle checked={inner} onChange={setInner} label={t('Размеры в чистоте (внутренние)')} />
          <Row label={t('Толщина стен')}>
            <NumberInput kind="length" value={thickness} min={20} round={1} onChange={(v) => setThick(v)} />
          </Row>
          <Row label={t('Высота стен')}>
            <NumberInput kind="length" value={wallH} min={500} round={1} onChange={(v) => setHeight(v)} />
          </Row>
          <Row label={t('Тип')}>
            <Select<RoomType> value={type} onChange={setType} options={ROOM_TYPES.map((r) => ({ value: r, label: roomTypeName(r, lang) }))} />
          </Row>
          <Row label={t('Название')}>
            <Input value={name} onChange={setName} placeholder={roomTypeName(type, lang)} />
          </Row>
          {!valid && <p className="text-[11px] text-[#ff8589]">{t('Проверьте размеры: вырез должен быть меньше комнаты.')}</p>}
        </div>
      </div>
    </Dialog>
  )
}

function WizardPreview({ w, h, cw, ch }: { w: number; h: number; cw: number; ch: number }) {
  const S = 120
  const k = (S - 20) / Math.max(w, h, 1)
  const W = w * k
  const H = h * k
  const x0 = (S - W) / 2
  const y0 = (S - H) / 2
  const d =
    cw > 0 && ch > 0 && cw < w && ch < h
      ? `M${x0} ${y0} H${x0 + W - cw * k} V${y0 + ch * k} H${x0 + W} V${y0 + H} H${x0} Z`
      : `M${x0} ${y0} H${x0 + W} V${y0 + H} H${x0} Z`
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="size-32 shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg)]" aria-hidden>
      <path d={d} fill="color-mix(in srgb, var(--accent) 18%, transparent)" stroke="var(--text)" strokeWidth={3} strokeLinejoin="miter" />
      <text x={S / 2} y={y0 + H + 9} fontSize={8} textAnchor="middle" fill="var(--muted)">
        {fmtNum(w / 1000, 2)} м
      </text>
      <text x={x0 - 4} y={y0 + H / 2} fontSize={8} textAnchor="middle" fill="var(--muted)" transform={`rotate(-90 ${x0 - 4} ${y0 + H / 2})`}>
        {fmtNum(h / 1000, 2)} м
      </text>
    </svg>
  )
}
