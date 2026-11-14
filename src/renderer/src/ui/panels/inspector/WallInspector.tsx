import { useMemo, useState } from 'react'
import { ArrowLeftRight, BrickWall, Plus, Trash } from 'lucide-react'
import type { FinishZone, Id, Wall, WallKind } from '@core/types'
import { setWallLength } from '@core'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, IconButton, NumberInput, Row, Section, Segmented, Select, formatLength } from '@/ui/kit'
import { MaterialPicker } from '../common/MaterialPicker'
import { optionsOf, PATTERN_RU, WALL_CATEGORIES, WALL_KIND_RU } from '../common/labels'
import { TilePatternEditor } from './TilePatternEditor'
import { tx, useAllMaterials } from '../common/catalog'
import { roomWallSides } from '../common/edits'
import { Hint, InspectorHeader, Pair } from './shared'

type Side = 'left' | 'right'

export function WallInspector({ id }: { id: Id }) {
  const t = useT()
  const wall = useDoc((s) => s.doc.walls[id])
  const na = useDoc((s) => (wall ? s.doc.nodes[wall.a] : undefined))
  const nb = useDoc((s) => (wall ? s.doc.nodes[wall.b] : undefined))
  const derived = useDoc((s) => (wall ? s.derived[wall.levelId] : undefined))
  const rooms = useDoc((s) => s.doc.rooms)
  const units = useDoc((s) => s.doc.settings.units)
  const [anchor, setAnchor] = useState<'a' | 'b' | 'center'>('a')

  const sideRooms = useMemo(() => {
    const res: Record<Side, { id: Id; name: string } | null> = { left: null, right: null }
    for (const r of derived?.rooms ?? []) {
      for (const e of r.edges) {
        if (e.wallId !== id || res[e.side]) continue
        res[e.side] = { id: r.roomId, name: rooms[r.roomId]?.name ?? '' }
      }
    }
    return res
  }, [derived, id, rooms])

  if (!wall || !na || !nb) return null
  const length = Math.hypot(nb.x - na.x, nb.y - na.y)
  const set = (label: string, fn: (w: Wall) => void, merge?: string) =>
    tx(label, (d) => {
      const w = d.walls[id]
      if (w) fn(w)
    }, merge)

  return (
    <div>
      <InspectorHeader icon={<BrickWall />} title={t(WALL_KIND_RU[wall.kind])} subtitle={formatLength(length, units)} />
      <Section title={t('Геометрия')} id="insp.wall.geom">
        <Row label={t('Длина')}>
          <NumberInput
            kind="length"
            value={length}
            min={10}
            round={1}
            onChange={(v, g) => tx('Длина стены', (d) => setWallLength(d, id, v, anchor), `wall.${id}.len.${g}`)}
          />
        </Row>
        <Row label={t('Неподвижный конец')}>
          <Segmented<typeof anchor>
            value={anchor}
            onChange={setAnchor}
            aria-label={t('Неподвижный конец')}
            options={[
              { value: 'a', label: t('Начало') },
              { value: 'center', label: t('Центр') },
              { value: 'b', label: t('Конец') },
            ]}
          />
        </Row>
        <Row label={t('Толщина')}>
          <NumberInput
            kind="length"
            value={wall.thickness}
            min={0}
            max={2000}
            round={1}
            disabled={wall.kind === 'virtual'}
            onChange={(v, g) => set('Толщина стены', (w) => (w.thickness = v), `wall.${id}.t.${g}`)}
          />
        </Row>
        <Row label={t('Высота')}>
          <NumberInput
            kind="length"
            value={wall.height}
            min={50}
            max={20000}
            round={1}
            onChange={(v, g) => set('Высота стены', (w) => (w.height = v), `wall.${id}.h.${g}`)}
          />
        </Row>
        <Row label={t('Тип')}>
          <Select<WallKind> value={wall.kind} options={optionsOf(WALL_KIND_RU)} onChange={(k) => set('Тип стены', (w) => (w.kind = k))} />
        </Row>
      </Section>
      {wall.kind !== 'virtual' &&
        (['left', 'right'] as Side[]).map((side) => (
          <WallSideEditor key={side} wall={wall} side={side} room={sideRooms[side]} />
        ))}
    </div>
  )
}

function WallSideEditor({ wall, side, room }: { wall: Wall; side: Side; room: { id: Id; name: string } | null }) {
  const t = useT()
  const ws = wall[side]
  const other: Side = side === 'left' ? 'right' : 'left'
  const zones = ws.zones ?? []
  const materials = useAllMaterials()
  const levelId = useUi((s) => s.activeLevelId)
  const colorOf = (id: Id) => materials.find((m) => m.id === id)?.color ?? '#bbbbbb'
  const title = `${side === 'left' ? t('Левая сторона') : t('Правая сторона')}${room ? ` — ${room.name || t('помещение')}` : ` — ${t('снаружи')}`}`

  const setSide = (label: string, fn: (s: Wall['left']) => void, merge?: string) =>
    tx(label, (d) => {
      const w = d.walls[wall.id]
      if (w) fn(w[side])
    }, merge)

  const addZone = (preset: 'apron' | 'band' | 'custom') => {
    const tile = materials.find((m) => m.category === 'tile' && !m.remote)
    const zone: FinishZone =
      preset === 'apron'
        ? { from: 0, to: 1200, materialId: tile?.id ?? ws.materialId }
        : preset === 'band'
          ? { from: 850, to: 1450, materialId: tile?.id ?? ws.materialId }
          : { from: 0, to: Math.min(1000, wall.height), materialId: ws.materialId }
    setSide('Добавить зону отделки', (s) => {
      s.zones = [...(s.zones ?? []), zone]
    })
  }

  return (
    <Section title={title} id={`insp.wall.${side}`}>
      <Row label={t('Отделка')}>
        <MaterialPicker
          value={ws.materialId}
          categories={WALL_CATEGORIES}
          aria-label={title}
          onChange={(m) => m && setSide('Материал стены', (s) => (s.materialId = m))}
        />
      </Row>
      <TilePatternEditor
        pattern={ws.pattern}
        color={colorOf(ws.materialId)}
        onChange={(p, g) =>
          setSide('Раскладка стены', (s) => {
            if (p) s.pattern = p
            else delete s.pattern
          }, g ? `wall.${wall.id}.${side}.pattern.${g}` : undefined)
        }
      />
      {zones.map((z, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-md border border-[var(--border)] p-1.5">
          <div className="flex items-center gap-1">
            <span className="flex-1 text-[10px] text-[var(--muted)]">
              {t('Зона')} {i + 1}
            </span>
            <IconButton
              size="sm"
              icon={<Trash />}
              variant="danger"
              label={t('Удалить зону')}
              onClick={() => setSide('Удалить зону отделки', (s) => (s.zones = (s.zones ?? []).filter((_, j) => j !== i)))}
            />
          </div>
          <Pair>
            <NumberInput
              kind="length"
              label={t('от')}
              value={z.from}
              min={0}
              max={wall.height}
              round={1}
              onChange={(v, g) =>
                setSide('Зона отделки', (s) => {
                  const zz = s.zones?.[i]
                  if (zz) zz.from = Math.min(v, zz.to - 1)
                }, `wall.${wall.id}.${side}.z${i}.from.${g}`)
              }
            />
            <NumberInput
              kind="length"
              label={t('до')}
              value={z.to}
              min={0}
              max={wall.height}
              round={1}
              onChange={(v, g) =>
                setSide('Зона отделки', (s) => {
                  const zz = s.zones?.[i]
                  if (zz) zz.to = Math.max(v, zz.from + 1)
                }, `wall.${wall.id}.${side}.z${i}.to.${g}`)
              }
            />
          </Pair>
          <MaterialPicker
            value={z.materialId}
            categories={['tile', ...WALL_CATEGORIES]}
            onChange={(m) =>
              m &&
              setSide('Материал зоны', (s) => {
                const zz = s.zones?.[i]
                if (zz) zz.materialId = m
              })
            }
          />
          <details className="text-[11px]">
            <summary className="cursor-pointer text-[var(--muted)]">
              {t('Раскладка зоны')}
              {z.pattern ? ` · ${t(PATTERN_RU[z.pattern.type])}` : ''}
            </summary>
            <div className="pt-1">
              <TilePatternEditor
                pattern={z.pattern}
                color={colorOf(z.materialId)}
                onChange={(p, g) =>
                  setSide('Раскладка зоны', (s) => {
                    const zz = s.zones?.[i]
                    if (!zz) return
                    if (p) zz.pattern = p
                    else delete zz.pattern
                  }, g ? `wall.${wall.id}.${side}.z${i}.pattern.${g}` : undefined)
                }
              />
            </div>
          </details>
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => addZone('apron')} title={t('Плиточный фартук 0–1200 мм')}>
          {t('Фартук')}
        </Button>
        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => addZone('band')} title={t('Полоса 850–1450 мм (кухонный фартук)')}>
          {t('Полоса')}
        </Button>
        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => addZone('custom')}>
          {t('Зона')}
        </Button>
        <IconButton
          size="sm"
          icon={<ArrowLeftRight />}
          label={t('Скопировать отделку с другой стороны')}
          onClick={() =>
            tx('Копировать отделку стороны', (d) => {
              const w = d.walls[wall.id]
              if (!w) return
              w[side] = JSON.parse(JSON.stringify(w[other])) as Wall['left']
            })
          }
        />
      </div>
      {room && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const faces = roomWallSides(levelId, room.id)
            const src = JSON.parse(JSON.stringify(ws)) as Wall['left']
            tx('Отделка на все стены помещения', (d) => {
              for (const f of faces) {
                const w = d.walls[f.wallId]
                if (!w) continue
                const zonesFit = (src.zones ?? []).filter((z) => z.from < w.height).map((z) => ({ ...z, to: Math.min(z.to, w.height) }))
                w[f.side] = {
                  materialId: src.materialId,
                  ...(src.pattern ? { pattern: src.pattern } : {}),
                  ...(zonesFit.length ? { zones: zonesFit } : {}),
                }
              }
            })
          }}
        >
          {t('Применить ко всем стенам помещения')}
        </Button>
      )}
      {zones.length > 0 && <Hint>{t('Зоны перекрывают основную отделку между указанными высотами от пола.')}</Hint>}
    </Section>
  )
}
