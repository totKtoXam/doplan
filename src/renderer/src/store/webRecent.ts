/**
 * Recent projects of the web build (no Electron, no file system): the documents opened or saved in this
 * browser are kept in localStorage, so the welcome screen can open them again. A document too large to
 * keep is listed without its copy (shown as unavailable).
 */
import type { RecentEntry } from '@shared/recent'
import { validThumb } from '@shared/recent'

export const WEB_RECENT_KEY = 'doplan.recentDocs'
export const WEB_RECENT_PREFIX = 'web:'
const MAX_ENTRIES = 8
/** largest document copy kept, characters of JSON */
const MAX_DOC_CHARS = 1_500_000

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
  /** writes the list; when storage is full, drops the oldest document copies until it fits */
  const write = (list: Stored[]): void => {
    if (!storage) return
    const next = list.slice(0, MAX_ENTRIES)
    for (;;) {
      try {
        storage.setItem(WEB_RECENT_KEY, JSON.stringify(next))
        return
      } catch {
        const i = next.map((e) => !!e.doc).lastIndexOf(true)
        if (i < 0) return
        next[i] = { ...next[i], doc: undefined }
      }
    }
  }

  return {
    /** key of a document in the list: its project id, else its name */
    keyOf(doc: { meta: { id?: string; name: string } }): string {
      return WEB_RECENT_PREFIX + (doc.meta.id || doc.meta.name)
    },
    remember(doc: { meta: { id?: string; name: string } }, thumb: string | null): void {
      const path = this.keyOf(doc)
      const json = JSON.stringify(doc)
      const prev = read().find((e) => e.path === path)
      const entry: Stored = {
        path,
        name: doc.meta.name,
        modifiedAt: now().toISOString(),
        doc: json.length <= MAX_DOC_CHARS ? json : undefined,
        thumb: validThumb(thumb) ? thumb : prev?.thumb,
      }
      write([entry, ...read().filter((e) => e.path !== path)])
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
  }
}

export type WebRecent = ReturnType<typeof createWebRecent>

export const webRecent: WebRecent = createWebRecent()
