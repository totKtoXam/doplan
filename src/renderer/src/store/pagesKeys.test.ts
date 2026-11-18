import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import { publicationKeys } from '@shared/pagesSite'
import { docStore } from './document'
import { keyMove, movedKeys, rememberMove } from './pagesKeys'
import { runProjectHooks } from './projectHooks'

function fakeStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

afterEach(() => vi.unstubAllGlobals())

describe('the publication record of an id-less file follows its first save', () => {
  it('a plain save moves the key, Save As (a copy) and a file that had an id do not', () => {
    expect(keyMove({ key: 'file:a' }, 'p_new', false)).toEqual(['p_new', 'file:a'])
    expect(keyMove({ key: 'file:a' }, 'p_new', true)).toBeNull()
    expect(keyMove({ id: 'p_old', key: 'p_old' }, 'p_new', false)).toBeNull()
    expect(keyMove({ key: 'file:a' }, undefined, false)).toBeNull()
  })

  it('remembers the old key per id, a bounded list', () => {
    const s = fakeStorage()
    rememberMove('p1', 'file:a', s)
    expect(movedKeys('p1', s)).toEqual(['file:a'])
    expect(movedKeys('p2', s)).toEqual([])
    expect(movedKeys(undefined, s)).toEqual([])
    for (let i = 0; i < 250; i++) rememberMove(`q${i}`, `file:${i}`, s)
    expect(movedKeys('p1', s)).toEqual([])
    expect(movedKeys('q249', s)).toEqual(['file:249'])
  })

  it('Ctrl+S on a .json (it becomes a project folder at another path) hands the old key to the new id', async () => {
    const s = fakeStorage()
    vi.stubGlobal('localStorage', s)
    const doc = createEmptyDoc('Flat')
    delete (doc.meta as { id?: string }).id
    docStore.getState().load(doc, '/plans/flat.json')
    const before = publicationKeys(docStore.getState().doc.meta, '/plans/flat.json').key
    expect(before).toMatch(/^file:/)
    await runProjectHooks('beforeSave')
    docStore.getState().markSaved('/plans/Flat', 'p_folder')
    await runProjectHooks('saved', false)
    expect(movedKeys('p_folder', s)).toEqual([before])

    // a Save As copy of an id-less file takes nothing over
    const copy = createEmptyDoc('Flat')
    delete (copy.meta as { id?: string }).id
    docStore.getState().load(copy, '/plans/other.json')
    await runProjectHooks('beforeSave')
    docStore.getState().markSaved('/plans/Other copy', 'p_copy')
    await runProjectHooks('saved', true)
    expect(movedKeys('p_copy', s)).toEqual([])
  })
})
