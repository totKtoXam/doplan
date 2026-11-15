import {
  addItem,
  checkPresetFit,
  faceOfRun,
  KITCHEN_PRESETS,
  layoutKitchenPreset,
  newId,
  roomEdgeRuns,
  ROOM_TYPE_NAMES,
  type KitchenPreset,
  type PresetFace,
  type PresetFit,
} from '@core'
import type { DerivedRoom, EntityRef, Id, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { alertDialog, choiceDialog } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { fmtNum } from '@/ui/kit'
import '@/ui/catalogI18n'
import { lookupAsset, tx } from './catalog'
import { freeOrigin } from './edits'

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })

interface Target {
  face: PresetFace
  /** room outline the set must stay inside (absent for a wall without rooms or a free spot) */
  room?: DerivedRoom
}

const KITCHEN_TYPES = new Set(['kitchen', 'kitchenLiving'])

function roomLabel(room: DerivedRoom): string {
  const rec = docStore.getState().doc.rooms[room.roomId]
  if (rec?.name) return rec.name
  const names = rec ? ROOM_TYPE_NAMES[rec.type] : undefined
  if (names) return uiStore.getState().lang === 'en' ? names.en : names.ru
  return `${t('Комната')} ${fmtNum(room.area, 1)} ${t('м²')}`
}

/**
 * Where to put a preset.
 * - A selected room (optionally with one of its walls): that room's longest wall run that fits
 *   (or the run of the selected wall).
 * - A selected wall between two rooms: the kitchen side; if neither or both are kitchens, the user
 *   picks the room.
 * - A wall without rooms: its left face. Nothing selected: a free spot right of the plan.
 * Returns null when the user cancels the choice.
 */
export async function presetTarget(levelId: Id, selection: EntityRef[], preset: KitchenPreset): Promise<Target | null> {
  const plan = docStore.getState().derived[levelId]
  const doc = docStore.getState().doc
  const wallIds = new Set(selection.filter((r) => r.kind === 'wall').map((r) => r.id))
  const roomIds = new Set(selection.filter((r) => r.kind === 'room').map((r) => r.id))
  const candidates = new Map<Id, { room: DerivedRoom; faces: PresetFace[] }>()
  for (const room of plan?.rooms ?? []) {
    if (roomIds.size > 0 && !roomIds.has(room.roomId)) continue
    for (const run of roomEdgeRuns(room)) {
      if (wallIds.size > 0 && !run.edges.some((e) => wallIds.has(e.wallId))) continue
      if (wallIds.size === 0 && roomIds.size === 0) continue
      const c = candidates.get(room.roomId) ?? { room, faces: [] }
      c.faces.push(faceOfRun(run))
      candidates.set(room.roomId, c)
    }
  }
  if (candidates.size > 0) {
    let options = [...candidates.values()]
    if (options.length > 1) {
      const kitchens = options.filter((o) => KITCHEN_TYPES.has(doc.rooms[o.room.roomId]?.type ?? ''))
      if (kitchens.length === 1) options = kitchens
    }
    let pick = options[0]
    if (options.length > 1) {
      const id = await choiceDialog(t('С какой стороны стены поставить гарнитур?'), t('Стена разделяет несколько комнат. Выберите комнату — или выделите её вместе со стеной.'), [
        ...options.map((o, i) => ({ id: String(i), label: roomLabel(o.room), variant: i === 0 ? ('primary' as const) : undefined })),
        { id: 'cancel', label: t('Отмена') },
      ])
      const i = Number(id)
      if (!Number.isInteger(i) || !options[i]) return null
      pick = options[i]
    }
    // the longest run where the set fits, else the longest one (the fit check then explains why not)
    const faces = pick.faces.slice().sort((a, b) => b.length - a.length)
    const fitting = faces.find((f) => checkPresetFit(preset, f, lookupAsset, pick.room).ok)
    return { face: fitting ?? faces[0], room: pick.room }
  }
  // a wall without a room: its left face, fronts away from the centreline
  for (const id of wallIds) {
    const g = plan?.wallGeoms[id]
    if (!g) continue
    const [a, b] = g.left
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1) continue
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const out = sub(mid, { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 })
    const ol = Math.hypot(out.x, out.y) || 1
    return { face: faceOfRun({ a, b, n: { x: out.x / ol, y: out.y / ol }, length: len }) }
  }
  const o = freeOrigin(levelId)
  return { face: { p0: o, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: preset.length } }
}

const m = (mm: number): string => `${fmtNum(mm / 1000, 2)} ${t('м')}`

function presetName(p: KitchenPreset): string {
  return uiStore.getState().lang === 'en' ? p.name : p.nameRu
}

function fitMessage(preset: KitchenPreset, fit: Exclude<PresetFit, { ok: true }>): string {
  return fit.reason === 'length'
    ? t('Гарнитур «{name}» длиной {need} не помещается на стене {have}.', { name: presetName(preset), need: m(fit.need), have: m(fit.have) })
    : t('Гарнитур «{name}» выступает в комнату на {need}, а свободно только {have}.', { name: presetName(preset), need: m(fit.need), have: m(fit.have) })
}

/**
 * Place a whole kitchen set as one undo step; the new items are grouped and selected. A set that
 * does not fit the wall or the room is not placed: the user sees why and may pick a set that fits.
 */
export async function placeKitchenPreset(preset: KitchenPreset): Promise<number> {
  const ui = uiStore.getState()
  const levelId = ui.activeLevelId
  const target = await presetTarget(levelId, ui.selection, preset)
  if (!target) return 0
  const fit = checkPresetFit(preset, target.face, lookupAsset, target.room)
  if (!fit.ok) {
    const others = KITCHEN_PRESETS.filter((p) => p.id !== preset.id && checkPresetFit(p, target.face, lookupAsset, target.room).ok)
    const msg = fitMessage(preset, fit)
    if (others.length === 0) {
      await alertDialog(t('Гарнитур не помещается'), `${msg} ${t('Ни один готовый гарнитур сюда не помещается — соберите кухню из отдельных модулей.')}`)
      return 0
    }
    const id = await choiceDialog(t('Гарнитур не помещается'), `${msg} ${t('Сюда помещается:')}`, [
      ...others.map((p, i) => ({ id: p.id, label: presetName(p), variant: i === 0 ? ('primary' as const) : undefined })),
      { id: 'cancel', label: t('Отмена') },
    ])
    const alt = others.find((p) => p.id === id)
    if (!alt) return 0
    return placeOn(alt, levelId, target.face)
  }
  return placeOn(preset, levelId, target.face)
}

function placeOn(preset: KitchenPreset, levelId: Id, face: PresetFace): number {
  const placements = layoutKitchenPreset(preset, face, lookupAsset)
  if (placements.length === 0) return 0
  const groupId = newId('i')
  const created: Id[] = []
  tx(`Кухня: ${preset.nameRu}`, (d) => {
    for (const p of placements) {
      const a = lookupAsset(p.assetId)
      if (!a) continue
      const patch: Parameters<typeof addItem>[5] = { rotation: p.rotation, groupId }
      if (p.size) patch.size = p.size
      if (p.params) patch.params = p.params
      created.push(addItem(d, levelId, a, p.x, p.y, patch))
    }
  })
  uiStore.getState().setTool('select')
  uiStore.getState().select(created.map((id) => ({ kind: 'item' as const, id })))
  return created.length
}
