/** Builds the entries of the right-click menu for whatever is under the cursor. */
import { duplicateEntities, removeEntities, splitWall } from '@core'
import type { EntityRef, Id, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import type { ContextMenuItem, EditorCtx } from './context'
import { normDeg } from './geom'

const DUPLICABLE = new Set(['wall', 'opening', 'item', 'light', 'label', 'dimension'])

export function buildContextMenu(ctx: EditorCtx, plan: Vec2, zoomToFit: () => void): ContextMenuItem[] {
  const ui = uiStore.getState()
  const transact = docStore.getState().transact
  const hit = ctx.hit.hit(plan, ctx.mm(8))
  if (hit && !ctx.isSelected(hit)) ui.select([hit])
  const sel = uiStore.getState().selection
  const doc = ctx.doc()
  const items: ContextMenuItem[] = []

  if (!hit) {
    const levelId = ctx.levelId()
    items.push({ label: t('Показать весь план'), run: zoomToFit })
    items.push({
      label: t('Выделить всё'),
      run: () => {
        const refs: EntityRef[] = []
        for (const id in doc.walls) if (doc.walls[id].levelId === levelId) refs.push({ kind: 'wall', id })
        for (const id in doc.openings) {
          const w = doc.walls[doc.openings[id].wallId]
          if (w && w.levelId === levelId) refs.push({ kind: 'opening', id })
        }
        for (const id in doc.items) if (doc.items[id].levelId === levelId && !doc.items[id].hidden) refs.push({ kind: 'item', id })
        for (const id in doc.lights) if (doc.lights[id].levelId === levelId) refs.push({ kind: 'light', id })
        for (const id in doc.labels) if (doc.labels[id].levelId === levelId) refs.push({ kind: 'label', id })
        for (const id in doc.dimensions) if (doc.dimensions[id].levelId === levelId) refs.push({ kind: 'dimension', id })
        uiStore.getState().select(refs)
      },
    })
    const hidden = Object.values(doc.items).filter((it) => it.levelId === levelId && it.hidden)
    if (hidden.length) {
      items.push({
        label: t('Показать скрытые предметы'),
        run: () =>
          transact(t('Показать скрытые предметы'), (d) => {
            for (const it of hidden) {
              const x = d.items[it.id]
              if (x) x.hidden = false
            }
          }),
      })
    }
    return items
  }

  switch (hit.kind) {
    case 'opening': {
      const id = hit.id
      items.push({
        label: t('Отразить (петли с другой стороны)'),
        run: () =>
          transact(t('Отражение проёма'), (d) => {
            const o = d.openings[id]
            if (o) o.hinge = o.hinge === 'a' ? 'b' : 'a'
          }),
      })
      items.push({
        label: t('Открывать в другую сторону'),
        run: () =>
          transact(t('Отражение проёма'), (d) => {
            const o = d.openings[id]
            if (o) o.swing = o.swing === 'left' ? 'right' : 'left'
          }),
      })
      break
    }
    case 'wall': {
      const id = hit.id
      items.push({
        label: t('Разделить стену здесь'),
        run: () =>
          transact(t('Разделение стены'), (d) => {
            if (d.walls[id]) splitWall(d, id, plan)
          }),
      })
      break
    }
    case 'room': {
      const room = ctx.derived().rooms.find((r) => r.roomId === hit.id)
      if (room) {
        items.push({
          label: t('Выделить стены комнаты'),
          run: () => {
            const ids = new Set<Id>()
            for (const e of room.edges) ids.add(e.wallId)
            uiStore.getState().select([...ids].map((id) => ({ kind: 'wall' as const, id })))
          },
        })
        const rec = doc.rooms[hit.id]
        if (rec) {
          items.push({
            label: t('Переименовать…'),
            run: () => {
              const s = ctx.camera.toScreen(room.labelPoint)
              ctx.html.prompt({
                x: s.x,
                y: s.y,
                value: rec.name,
                key: `room:${hit.id}`,
                title: t('Название комнаты'),
                onCommit: (text) =>
                  docStore.getState().transact(t('Переименование комнаты'), (d) => {
                    const x = d.rooms[hit.id]
                    if (x) x.name = text
                  }),
              })
            },
          })
        }
      }
      break
    }
    case 'item': {
      const ids = sel.filter((r) => r.kind === 'item').map((r) => r.id)
      const it = doc.items[hit.id]
      items.push({
        label: t('Повернуть на 90°'),
        run: () =>
          transact(t('Поворот'), (d) => {
            for (const id of ids) {
              const x = d.items[id]
              if (x && !x.locked) x.rotation = normDeg(x.rotation + 90)
            }
          }),
      })
      items.push({
        label: t('Отразить'),
        run: () =>
          transact(t('Отражение'), (d) => {
            for (const id of ids) {
              const x = d.items[id]
              if (x && !x.locked) x.mirrored = !x.mirrored
            }
          }),
      })
      items.push({
        label: it?.locked ? t('Разблокировать') : t('Заблокировать'),
        run: () =>
          transact(it?.locked ? t('Разблокировать') : t('Заблокировать'), (d) => {
            for (const id of ids) {
              const x = d.items[id]
              if (x) x.locked = !it?.locked
            }
          }),
      })
      items.push({
        label: it?.hidden ? t('Показать') : t('Скрыть'),
        run: () =>
          transact(it?.hidden ? t('Показать') : t('Скрыть'), (d) => {
            for (const id of ids) {
              const x = d.items[id]
              if (x) x.hidden = !it?.hidden
            }
          }),
      })
      break
    }
    case 'light': {
      const id = hit.id
      const l = doc.lights[id]
      items.push({
        label: l?.on ? t('Выключить') : t('Включить'),
        run: () =>
          transact(t('Светильник'), (d) => {
            const x = d.lights[id]
            if (x) x.on = !x.on
          }),
      })
      break
    }
    case 'underlay': {
      const id = hit.id
      items.push({
        label: t('Заблокировать'),
        run: () => {
          transact(t('Заблокировать'), (d) => {
            const x = d.underlays[id]
            if (x) x.locked = true
          })
          uiStore.getState().clearSelection()
        },
      })
      break
    }
    case 'label': {
      const id = hit.id
      const l = doc.labels[id]
      if (l) {
        items.push({
          label: t('Изменить текст…'),
          run: () => {
            const s = ctx.camera.toScreen(l)
            ctx.html.prompt({
              x: s.x,
              y: s.y,
              value: l.text,
              key: `label:${id}`,
              width: 220,
              onCommit: (text) =>
                docStore.getState().transact(t('Текст'), (d) => {
                  const x = d.labels[id]
                  if (x) x.text = text
                }),
            })
          },
        })
      }
      break
    }
    default:
      break
  }

  const dup = sel.filter((r) => DUPLICABLE.has(r.kind))
  const removable = sel.filter((r) => r.kind !== 'room')
  if (items.length && (dup.length || removable.length)) items.push({ label: '', separator: true })
  if (dup.length) {
    items.push({
      label: t('Дублировать'),
      run: () => {
        let created: EntityRef[] = []
        docStore.getState().transact(t('Дублирование'), (d) => {
          created = duplicateEntities(d, dup, 300, 300)
        })
        const now = docStore.getState().doc
        const alive = (created as EntityRef[]).filter((r) => {
          switch (r.kind) {
            case 'wall':
              return !!now.walls[r.id]
            case 'opening':
              return !!now.openings[r.id]
            case 'item':
              return !!now.items[r.id]
            case 'light':
              return !!now.lights[r.id]
            case 'label':
              return !!now.labels[r.id]
            case 'dimension':
              return !!now.dimensions[r.id]
            default:
              return false
          }
        })
        if (alive.length) uiStore.getState().select(alive)
      },
    })
  }
  if (removable.length) {
    items.push({
      label: t('Удалить'),
      danger: true,
      run: () => {
        docStore.getState().transact(t('Удаление'), (d) => removeEntities(d, removable))
        uiStore.getState().clearSelection()
      },
    })
  }
  return items
}
