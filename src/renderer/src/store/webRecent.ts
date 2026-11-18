/**
 * Recent projects of the web build (no Electron, no file system): the documents opened or saved in this
 * browser are kept in localStorage, so the welcome screen can open them again. A document too large to
 * keep is listed without its copy (shown as unavailable).
 *
 * localStorage is shared by the whole origin (about 5M characters), and the crash-recovery copy and the
 * settings matter more than these copies: the list stays within a budget of its own, and a write of
 * those (setItemMakingRoom) drops the oldest copies when the storage is full.
 */
import type { RecentEntry } from '@shared/recent'
import { validThumb } from '@shared/recent'

export const WEB_RECENT_KEY = 'doplan.recentDocs'
export const WEB_RECENT_PREFIX = 'web:'
const MAX_ENTRIES = 8
/** largest document copy kept, characters of JSON */
export const MAX_DOC_CHARS = 1_000_000
/** the whole list with its copies; the rest of the storage is left to recovery, settings and the like */
export const WEB_RECENT_BUDGET = 2_000_000

interface Stored {
  path: string
  name: string
  modifiedAt: string
  doc?: string
  thumb?: string
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** the oldest entry that still has a copy, or -1 */
const lastWithDoc = (list: Stored[]) => list.map((e) => !!e.doc).lastIndexOf(true)

export function createWebRecent(storage: Storage | null = defaultStorage(), now: () => Date = () => new Date()) {
  const read = (): Stored[] => {
    try {
      const raw = storage?.getItem(WEB_RECENT_KEY)
      const list = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(list) ? list.filter((x): x is Stored => !!x && typeof x.path === 'string' && typeof x.name === 'string') : []
    } catch {
      return []
    }
  }
  /**
   * writes the list within its budget; when the storage is full anyway, drops the oldest document
   * copies until it fits. Returns whether a copy was dropped.
   */
  const write = (list: Stored[]): boolean => {
    if (!storage) return false
    const next = list.slice(0, MAX_ENTRIES)
    let dropped = false
    const drop = (): boolean => {
      const i = lastWithDoc(next)
      if (i < 0) return false
      next[i] = { ...next[i], doc: undefined }
      dropped = true
      return true
    }
    while (JSON.stringify(next).length > WEB_RECENT_BUDGET && drop()) {
      /* over budget */
    }
    for (;;) {
      try {
        storage.setItem(WEB_RECENT_KEY, JSON.stringify(next))
        return dropped
      } catch {
        if (!drop()) return dropped
      }
    }
  }

  return {
    /** key of a document in the list (its project id), or null for a document without one */
    keyOf(doc: { meta: { id?: string; name: string } }): string | null {
      return doc.meta.id ? WEB_RECENT_PREFIX + doc.meta.id : null
    },
    /**
     * keeps a copy of the document. A document without a project id is not listed: its first save gives
     * it one (and the list entry), and two such plans of the same name would replace each other.
     * `thumb`: the new picture, null to clear it (empty plan, too large), undefined to keep the old one.
     */
    remember(doc: { meta: { id?: string; name: string } }, thumb: string | null | undefined): void {
      const path = this.keyOf(doc)
      if (!path) return
      const json = JSON.stringify(doc)
      const list = read()
      const prev = list.find((e) => e.path === path)
      const entry: Stored = {
        path,
        name: doc.meta.name,
        modifiedAt: now().toISOString(),
        doc: json.length <= MAX_DOC_CHARS ? json : undefined,
        thumb: thumb === undefined ? prev?.thumb : validThumb(thumb) ? thumb : undefined,
      }
      write([entry, ...list.filter((e) => e.path !== path)])
    },
    /** the stored document of a list entry (JSON text), or null */
    doc(path: string): string | null {
      return read().find((e) => e.path === path)?.doc ?? null
    },
    list(): RecentEntry[] {
      return read().map((e) => ({
        path: e.path,
        name: e.name,
        modifiedAt: e.modifiedAt,
        exists: !!e.doc,
        kind: 'web',
        thumb: validThumb(e.thumb) ? e.thumb : null,
      }))
    },
    remove(path: string): void {
      write(read().filter((e) => e.path !== path))
    },
    /** drops the oldest document copy to free storage; false when none is left */
    shed(): boolean {
      const list = read()
      const i = lastWithDoc(list)
      if (i < 0) return false
      list[i] = { ...list[i], doc: undefined }
      write(list)
      return true
    },
  }
}

export type WebRecent = ReturnType<typeof createWebRecent>

export const webRecent: WebRecent = createWebRecent()

/**
 * setItem for what matters more than the recent copies (the crash-recovery copy, the settings): when the
 * storage is full, the oldest copies go first. Throws when it still does not fit.
 */
export function setItemMakingRoom(key: string, value: string, storage: Storage | null = defaultStorage(), recent: WebRecent = webRecent): void {
  if (!storage) return
  for (;;) {
    try {
      storage.setItem(key, value)
      return
    } catch (err) {
      if (!recent.shed()) throw err
    }
  }
}
