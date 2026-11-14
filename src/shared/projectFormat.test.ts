import { describe, expect, it } from 'vitest'
import { addOpening, addRectRoom, createEmptyDoc, parseDoc, serializeDoc } from '@core'
import { agentsTemplate, AGENTS_USER_SECTION, buildCommitMessage, stableStringify, tagNameFrom } from './projectFormat'

function sampleDoc() {
  const doc = createEmptyDoc('Квартира')
  const level = doc.levelOrder[0]
  const walls = addRectRoom(doc, level, 0, 0, 4200, 3600)
  addOpening(doc, walls[0], 'door', 900)
  addOpening(doc, walls[1], 'window', 1500)
  return doc
}

/** same object with keys inserted in reverse order, recursively */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).reverse()) out[k] = reverseKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

describe('stableStringify (plan.json)', () => {
  it('round-trips a document exactly', () => {
    const doc = sampleDoc()
    const text = stableStringify(doc)
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(doc)))
    // and the document passes the app's own validation with all entities intact
    const reparsed = parseDoc(JSON.parse(text))
    expect(Object.keys(reparsed.walls).sort()).toEqual(Object.keys(doc.walls).sort())
    expect(Object.keys(reparsed.openings).sort()).toEqual(Object.keys(doc.openings).sort())
  })

  it('does not depend on key insertion order', () => {
    const doc = sampleDoc()
    expect(stableStringify(reverseKeys(doc))).toBe(stableStringify(doc))
  })

  it('is pretty-printed for line-based diffs, small objects inline', () => {
    const text = stableStringify({ b: 1, a: { y: 2, x: 1 }, list: Array.from({ length: 30 }, (_, i) => ({ x: i, y: i * 2, z: 0, w: 1, q: 'aaaa' })) })
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').length).toBeGreaterThan(10)
    expect(text).toContain('"a": { "x": 1, "y": 2 }')
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'))
  })

  it('puts priority keys first and drops undefined like JSON.stringify', () => {
    const text = stableStringify({ zeta: 1, id: 'w_1', version: 3, meta: { name: 'x' }, gone: undefined, arr: [undefined, Number.NaN] })
    const keys = Object.keys(JSON.parse(text))
    expect(keys.slice(0, 3)).toEqual(['version', 'meta', 'id'])
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ zeta: 1, id: 'w_1', version: 3, meta: { name: 'x' }, arr: [undefined, Number.NaN] })))
  })

  it('a one-field change touches one line', () => {
    const doc = sampleDoc()
    const before = stableStringify(doc).split('\n')
    const wallId = Object.keys(doc.walls)[0]
    doc.walls[wallId].height = 2999
    const after = stableStringify(doc).split('\n')
    expect(after.length).toBe(before.length)
    expect(after.filter((l, i) => l !== before[i]).length).toBe(1)
  })
})

describe('buildCommitMessage', () => {
  it('counts repeated labels in order of first appearance', () => {
    expect(buildCommitMessage(['Стена', 'Дверь', 'Дверь'])).toBe('Стена, Дверь ×2')
    expect(buildCommitMessage(['Дверь', 'Стена', 'Дверь', 'Стена', 'Стена'])).toBe('Дверь ×2, Стена ×3')
  })

  it('falls back for an empty list and ignores blank labels', () => {
    expect(buildCommitMessage([])).toBe('Сохранение')
    expect(buildCommitMessage(['  ', ''], { empty: 'Save' })).toBe('Save')
    expect(buildCommitMessage([' Стена  длинная '])).toBe('Стена длинная')
  })

  it('caps the length with "и ещё N"', () => {
    const labels = Array.from({ length: 20 }, (_, i) => `Действие номер ${i + 1}`)
    const msg = buildCommitMessage(labels, { maxLength: 60 })
    expect(msg.length).toBeLessThanOrEqual(60)
    expect(msg).toMatch(/^Действие номер 1, .*и ещё \d+$/)
    const shown = msg.split(', ').length - 1
    expect(Number(/и ещё (\d+)$/.exec(msg)![1]) + shown).toBe(20)
  })

  it('truncates a single overlong label', () => {
    const msg = buildCommitMessage(['x'.repeat(200)], { maxLength: 40 })
    expect(msg.length).toBe(40)
    expect(msg.endsWith('…')).toBe(true)
  })
})

describe('tagNameFrom', () => {
  it('makes git-safe tag names and keeps Cyrillic', () => {
    expect(tagNameFrom('Согласовано с заказчиком')).toBe('Согласовано-с-заказчиком')
    expect(tagNameFrom('  v1.0: final? [ok] ')).toBe('v1.0-final-ok')
    expect(tagNameFrom('a..b/c')).toBe('a.b-c')
    expect(tagNameFrom('...')).toBe('')
    expect(tagNameFrom('x.lock')).toBe('x')
  })
})

describe('agentsTemplate', () => {
  it('names the project and leaves a section for the user', () => {
    const t = agentsTemplate('Дом у озера')
    expect(t.startsWith('# Дом у озера')).toBe(true)
    expect(t).toContain('миллиметрах')
    expect(t).toContain(AGENTS_USER_SECTION)
  })
})
