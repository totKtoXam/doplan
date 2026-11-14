import { useMemo } from 'react'
import { SquareDashed } from 'lucide-react'
import type { CeilingKind, CeilingSpec, Id, Room, RoomType, SurfaceFinish } from '@core/types'
import { useDoc } from '@/store/document'
import { useT } from '@/i18n'
import { Button, ColorInput, Input, NumberInput, Row, Section, Select, Toggle, fmtNum } from '@/ui/kit'
import { MaterialPicker } from '../common/MaterialPicker'
import { CEILING_CATEGORIES, CEILING_KIND_RU, FLOOR_CATEGORIES, optionsOf, ROOM_TYPES, roomTypeName, WALL_CATEGORIES } from '../common/labels'
import { lookupMaterial, tx, useLang, useMaterialMap } from '../common/catalog'
import { roomWallSides } from '../common/edits'
import { TilePatternEditor } from './TilePatternEditor'
import { Hint, InspectorHeader, Stat } from './shared'
import { RoomAccuracy } from './RoomAccuracy'

export function RoomInspector({ id }: { id: Id }) {
  const t = useT()
  const lang = useLang()
  const room = useDoc((s) => s.doc.rooms[id])
  const derivedRooms = useDoc((s) => (room ? s.derived[room.levelId]?.rooms : undefined))
  const walls = useDoc((s) => s.doc.walls)
  const levelHeight = useDoc((s) => (room ? s.doc.levels[room.levelId]?.height : undefined))
  const defaultWallH = useDoc((s) => s.doc.settings.wallHeight)
  const sameType = useDoc((s) => (room ? Object.values(s.doc.rooms).filter((r) => r.type === room.type && r.id !== room.id).length : 0))
  const mats = useMaterialMap()
  const dr = useMemo(() => derivedRooms?.find((r) => r.roomId === id), [derivedRooms, id])

  /** representative wall height of the room = max height of its boundary walls */
  const wallHeight = useMemo(() => {
    let h = 0
    for (const e of dr?.edges ?? []) h = Math.max(h, walls[e.wallId]?.height ?? 0)
    return h || levelHeight || defaultWallH
  }, [dr, walls, levelHeight, defaultWallH])

  /** current common material of all wall faces of the room (undefined if mixed) */
  const wallMat = useMemo(() => {
    const ids = new Set((dr?.edges ?? []).map((e) => walls[e.wallId]?.[e.side].materialId))
    return ids.size === 1 ? [...ids][0] : undefined
  }, [dr, walls])

  if (!room) return null
  const set = (label: string, fn: (r: Room) => void, merge?: string) =>
    tx(label, (d) => {
      const r = d.rooms[id]
      if (r) fn(r)
    }, merge)
  const setFloor = (label: string, fn: (f: SurfaceFinish) => void, merge?: string) => set(label, (r) => fn(r.floor), merge)
  const setCeil = (label: string, fn: (c: CeilingSpec) => void, merge?: string) => set(label, (r) => fn(r.ceiling), merge)
  const m = (f: string, g: string) => `room.${id}.${f}.${g}`
  const floorMat = mats.get(room.floor.materialId)
  const ceilH = room.ceiling.height ?? wallHeight

  const changeType = (type: RoomType) =>
    set('Тип помещения', (r) => {
      if (!r.name.trim() || r.name === roomTypeName(r.type, 'ru') || r.name === roomTypeName(r.type, 'en')) r.name = roomTypeName(type, lang)
      r.type = type
    })

  return (
    <div>
      <InspectorHeader icon={<SquareDashed />} title={room.name || roomTypeName(room.type, lang)} subtitle={dr ? `${fmtNum(dr.area, 2)} м²` : undefined} canDuplicate={false} />
      <Section title={t('Помещение')} id="insp.room.main">
        <Row label={t('Название')}>
          <Input value={room.name} onChange={(v) => set('Название помещения', (r) => (r.name = v), `room.${id}.name`)} onKeyDown={(e) => e.stopPropagation()} />
        </Row>
        <Row label={t('Тип')}>
          <Select<RoomType> value={room.type} options={ROOM_TYPES.map((r) => ({ value: r, label: roomTypeName(r, lang) }))} onChange={changeType} />
        </Row>
        {dr ? (
          <div className="flex flex-col gap-0.5 rounded-md bg-[var(--bg)] p-2">
            <Stat label={t('Площадь пола')} value={`${fmtNum(dr.area, 2)} м²`} />
            <Stat label={t('Периметр')} value={`${fmtNum(dr.perimeter, 2)} м`} />
            <Stat label={t('Высота потолка')} value={`${fmtNum(ceilH / 1000, 2)} м`} />
            <Stat label={t('Объём')} value={`${fmtNum((dr.area * ceilH) / 1000, 1)} м³`} />
            <Stat label={t('Площадь стен (без вычета проёмов)')} value={`${fmtNum((dr.perimeter * ceilH) / 1000, 1)} м²`} />
          </div>
        ) : (
          <Hint>{t('Контур не замкнут — площадь недоступна.')}</Hint>
        )}
        {dr && <RoomAccuracy id={id} dr={dr} />}
      </Section>

      <Section title={t('Пол')} id="insp.room.floor">
        <Row label={t('Материал')}>
          <MaterialPicker
            value={room.floor.materialId}
            categories={FLOOR_CATEGORIES}
            onChange={(v) => {
              if (!v) return
              const mat = lookupMaterial(v)
              setFloor('Материал пола', (f) => {
                f.materialId = v
                if (mat?.pattern && (!f.pattern || f.pattern.type === 'none')) f.pattern = { ...mat.pattern }
              })
            }}
          />
        </Row>
        <Row label={t('Оттенок')}>
          <ColorInput value={room.floor.tint} onChange={(v, g) => setFloor('Оттенок пола', (f) => (f.tint = v), m('tint', g))} onClear={() => setFloor('Оттенок пола', (f) => delete f.tint)} />
        </Row>
        <TilePatternEditor
          pattern={room.floor.pattern}
          color={room.floor.tint ?? floorMat?.color ?? '#bbbbbb'}
          onChange={(p, g) =>
            setFloor(
              'Раскладка пола',
              (f) => {
                if (p) f.pattern = p
                else delete f.pattern
              },
              g ? m('pattern', g) : undefined,
            )
          }
        />
        <Button
          size="sm"
          variant="outline"
          disabled={sameType === 0}
          onClick={() => {
            const floor = JSON.parse(JSON.stringify(room.floor)) as SurfaceFinish
            tx('Пол во все помещения типа', (d) => {
              for (const r of Object.values(d.rooms)) if (r.type === room.type) r.floor = JSON.parse(JSON.stringify(floor)) as SurfaceFinish
            })
          }}
        >
          {t('Применить ко всем помещениям этого типа')}
          {sameType > 0 && ` (${sameType})`}
        </Button>
      </Section>

      <Section title={t('Стены помещения')} id="insp.room.walls">
        <Row label={t('Отделка всех стен')}>
          <MaterialPicker
            value={wallMat}
            mixed={!wallMat && (dr?.edges.length ?? 0) > 0}
            categories={WALL_CATEGORIES}
            onChange={(v) => {
              if (!v) return
              const faces = roomWallSides(room.levelId, id)
              tx('Отделка стен помещения', (d) => {
                for (const f of faces) {
                  const w = d.walls[f.wallId]
                  if (w) w[f.side].materialId = v
                }
              })
            }}
          />
        </Row>
        <Hint>{t('Зоны (фартук, полосы) настраиваются у отдельной стены.')}</Hint>
      </Section>

      <Section title={t('Потолок')} id="insp.room.ceiling">
        <Row label={t('Вид')}>
          <Select<CeilingKind> value={room.ceiling.kind} options={optionsOf(CEILING_KIND_RU)} onChange={(k) => setCeil('Вид потолка', (c) => (c.kind = k))} />
        </Row>
        <Row label={t('Высота')}>
          <NumberInput
            kind="length"
            value={room.ceiling.height ?? null}
            placeholder={fmtNum(wallHeight, 0)}
            min={1000}
            max={20000}
            round={1}
            onChange={(v, g) => setCeil('Высота потолка', (c) => (c.height = v), m('ch', g))}
          />
          {room.ceiling.height !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => setCeil('Высота потолка', (c) => delete c.height)} title={t('По высоте стен')}>
              {t('Сброс')}
            </Button>
          )}
        </Row>
        <Row label={t('Материал')}>
          <MaterialPicker value={room.ceiling.materialId} categories={CEILING_CATEGORIES} onChange={(v) => v && setCeil('Материал потолка', (c) => (c.materialId = v))} />
        </Row>
        {(room.ceiling.kind === 'multilevel' || room.ceiling.kind === 'coffered') && (
          <>
            <Row label={t('Ширина короба')}>
              <NumberInput kind="length" value={room.ceiling.borderWidth ?? 600} min={0} max={3000} round={1} onChange={(v, g) => setCeil('Короб потолка', (c) => (c.borderWidth = v), m('bw', g))} />
            </Row>
            <Row label={t('Опуск короба')}>
              <NumberInput kind="length" value={room.ceiling.borderDrop ?? 100} min={0} max={1000} round={1} onChange={(v, g) => setCeil('Короб потолка', (c) => (c.borderDrop = v), m('bd', g))} />
            </Row>
            <Toggle checked={!!room.ceiling.coveLight} onChange={(v) => setCeil('Подсветка короба', (c) => (c.coveLight = v))} label={t('Скрытая LED-подсветка')} />
          </>
        )}
        <Row label={t('Карниз (галтель)')}>
          <NumberInput kind="length" value={room.ceiling.cornice ?? 0} min={0} max={300} round={1} onChange={(v, g) => setCeil('Потолочный карниз', (c) => (c.cornice = v), m('cor', g))} />
        </Row>
      </Section>

      <Section title={t('Плинтус')} id="insp.room.skirting">
        <Row label={t('Высота')}>
          <NumberInput kind="length" value={room.skirting} min={0} max={300} round={1} onChange={(v, g) => set('Высота плинтуса', (r) => (r.skirting = v), m('sk', g))} />
        </Row>
        {room.skirting > 0 && (
          <Row label={t('Материал')}>
            <MaterialPicker value={room.skirtingMaterialId} noneLabel={t('По умолчанию')} categories={['paint', 'wood', 'plastic']} onChange={(v) => set('Материал плинтуса', (r) => (r.skirtingMaterialId = v))} />
          </Row>
        )}
      </Section>
    </div>
  )
}
