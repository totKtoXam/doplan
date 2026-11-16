/**
 * Furnishing variants (core/variants): create, switch, rename, reorder, delete — each one undoable
 * edit of the document. Switching is an edit too (the live content is swapped), so Ctrl+Z right
 * after a switch switches back.
 */
import {
  activeVariantId,
  createVariant as coreCreate,
  deleteVariant as coreDelete,
  listVariants,
  moveVariant as coreMove,
  nextVariantName,
  renameVariant as coreRename,
  strayEntities,
  switchVariant as coreSwitch,
  variantCollection,
} from '@core'
import type { Id } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { confirmDialog, promptDialog, toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { currentDoc } from './util'
import '@/ui/variants/i18n'

const catalog = () => uiStore.getState().catalog

/** display name: the stored default "Вариант 1" is a translation key */
function variantName(id: Id): string {
  return t(listVariants(currentDoc()).find((v) => v.id === id)?.name ?? '')
}

/** selection points at entities of the variant being left: drop it before the swap */
function clearSelection(): void {
  if (uiStore.getState().selection.length) uiStore.getState().set({ selection: [] })
}

/**
 * New variant: a copy of `source` (default: the active one), or without furniture and lights. It is
 * placed after the source / active one and becomes active. Cancelling the name prompt changes nothing.
 */
export async function createVariant(from: 'copy' | 'empty', source?: Id): Promise<Id | null> {
  const doc = currentDoc()
  const srcId = from === 'copy' && source && doc.variants?.list[source] ? source : activeVariantId(doc)
  const fallback = nextVariantName(doc, t('Вариант'))
  const suggested = from === 'copy' ? `${variantName(srcId)} (${t('копия')})` : fallback
  const name = await promptDialog(t('Название варианта'), suggested.trim())
  if (name === null) return null
  let id: Id | null = null
  clearSelection()
  docStore.getState().transact(from === 'copy' ? t('Копия варианта') : t('Новый вариант'), (d) => {
    id = coreCreate(d, { from, name: name.trim() || fallback, source: srcId }, catalog())
  })
  return id
}

export function switchVariant(id: Id): void {
  const doc = currentDoc()
  if (id === activeVariantId(doc) || !doc.variants?.list[id]) return
  clearSelection()
  docStore.getState().transact(t('Вариант: {name}', { name: variantName(id) }), (d) => {
    coreSwitch(d, id, catalog())
  })
}

/** next (+1) / previous (−1) variant, wrapping around */
export function cycleVariant(dir: -1 | 1): void {
  const list = listVariants(currentDoc())
  if (list.length < 2) return
  const i = list.findIndex((v) => v.active)
  const next = list[(i + dir + list.length) % list.length]
  switchVariant(next.id)
  toast(t('Вариант: {name}', { name: t(next.name) }), 'info', 1500)
}

export async function renameVariant(id: Id): Promise<void> {
  const old = variantName(id)
  const name = await promptDialog(t('Название варианта'), old)
  if (name === null || !name.trim() || name.trim() === old) return
  docStore.getState().transact(t('Переименовать вариант'), (d) => {
    coreRename(d, id, name)
  })
}

export function moveVariant(id: Id, dir: -1 | 1): void {
  docStore.getState().transact(t('Порядок вариантов'), (d) => {
    coreMove(d, id, dir)
  })
}

export async function deleteVariant(id: Id): Promise<void> {
  const doc = currentDoc()
  if (listVariants(doc).length <= 1) {
    toast(t('Нельзя удалить единственный вариант'), 'warning')
    return
  }
  const items = Object.keys(variantCollection(doc, id, 'items', catalog())).length
  const lights = Object.keys(variantCollection(doc, id, 'lights', catalog())).length
  const ok = await confirmDialog(
    t('Удалить вариант?'),
    t('Вариант «{name}» будет удалён: предметов — {items}, светильников — {lights}, его отделка. Стены и помещения квартиры останутся. Отменить можно через Ctrl+Z.', {
      name: variantName(id),
      items,
      lights,
    }),
    { ok: t('Удалить'), danger: true },
  )
  if (!ok) return
  if (id === activeVariantId(doc)) clearSelection()
  docStore.getState().transact(t('Удалить вариант'), (d) => {
    coreDelete(d, id, catalog())
  })
}

/** furniture / lights of a variant standing outside every room (see core strayEntities) */
export function strayOf(variantId: Id) {
  const { doc, derived } = docStore.getState()
  return strayEntities(doc, derived, variantId, catalog())
}

/** switches to the variant (if needed) and selects its furniture that is outside the rooms */
export function selectStray(variantId: Id): void {
  if (variantId !== activeVariantId(currentDoc())) switchVariant(variantId)
  const refs = strayOf(variantId)
  if (!refs.length) return
  const ui = uiStore.getState()
  const doc = currentDoc()
  const first = refs[0].kind === 'item' ? doc.items[refs[0].id] : doc.lights[refs[0].id]
  ui.set({ selection: refs, ...(first && doc.levels[first.levelId] ? { activeLevelId: first.levelId } : {}) })
}
