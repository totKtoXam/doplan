/**
 * The publication record of a file without an id is keyed by its file (publicationKeys). Its first
 * plain save gives it an id, often at another path (Ctrl+S on a .json makes a project folder), so the
 * old key is written down here at that moment, the way the AI chat moves its chats, and the publish
 * dialog passes it on as an alias. Save As is a copy: nothing moves.
 */
import { publicationKeys } from '@shared/pagesSite'
import { docStore } from './document'
import { addProjectHook } from './projectHooks'

const STORE = 'doplan.pages.movedKeys'
const KEEP = 200

type KV = Pick<Storage, 'getItem' | 'setItem'>

function storage(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readMoved(s: KV | null): Record<string, string> {
  try {
    const v = JSON.parse(s?.getItem(STORE) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** older record keys of the document with this id (its file key before its first save) */
export function movedKeys(id: string | undefined, s: KV | null = storage()): string[] {
  const k = id ? readMoved(s)[id] : undefined
  return typeof k === 'string' && k ? [k] : []
}

export function rememberMove(id: string, from: string, s: KV | null = storage()): void {
  if (!s) return
  const m = readMoved(s)
  delete m[id]
  m[id] = from
  const ids = Object.keys(m)
  for (const k of ids.slice(0, Math.max(0, ids.length - KEEP))) delete m[k]
  try {
    s.setItem(STORE, JSON.stringify(m))
  } catch {
    /* storage full or off: the publication then shows as not published, nothing breaks */
  }
}

/** [new id, old key] when a save moves an id-less document's record to the id it now has */
export function keyMove(before: { id?: string; key: string }, afterId: string | undefined, saveAs: boolean): [string, string] | null {
  return !saveAs && !before.id && afterId && afterId !== before.key ? [afterId, before.key] : null
}

let pending: { id?: string; key: string } | null = null

addProjectHook({
  beforeSave() {
    const { doc, filePath } = docStore.getState()
    pending = { id: doc.meta.id, key: publicationKeys(doc.meta, filePath).key }
  },
  saved(saveAs) {
    const move = pending && keyMove(pending, docStore.getState().doc.meta.id, saveAs)
    pending = null
    if (move) rememberMove(move[0], move[1])
  },
})
