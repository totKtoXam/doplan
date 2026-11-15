import { describe, expect, it } from 'vitest'
import { createEmptyDoc, parseDoc, serializeDoc } from '..'

describe('document id', () => {
  it('a new document has one and it survives saving and loading', () => {
    const doc = createEmptyDoc('a')
    expect(doc.meta.id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(createEmptyDoc('b').meta.id).not.toBe(doc.meta.id)
    expect(parseDoc(serializeDoc(doc)).meta.id).toBe(doc.meta.id)
  })
  it('an older file has none (its chats stay keyed by its path), a broken one is dropped', () => {
    const raw = JSON.parse(serializeDoc(createEmptyDoc('a')))
    delete raw.meta.id
    expect(parseDoc(raw).meta.id).toBeUndefined()
    raw.meta.id = '../../x'
    expect(parseDoc(raw).meta.id).toBeUndefined()
  })
})
