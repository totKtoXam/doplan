import { describe, expect, it } from 'vitest'
import { cleanSubject, notesFromSubjects, notesFromTagMessage } from './release-notes'

describe('release notes', () => {
  it('turns first-parent subjects into a list without version bumps', () => {
    const md = notesFromSubjects(
      '0.11.3',
      ['doplan 0.11.3', 'Merge AI chat: safe reloads', 'Fix wall snapping', 'AI chat: safe reloads'],
      'https://github.com/o/r/compare/v0.11.2...v0.11.3',
    )
    expect(md).toBe(
      '## doplan 0.11.3\n\n### Изменения\n- AI chat: safe reloads\n- Fix wall snapping\n\n' +
        '**Full Changelog**: https://github.com/o/r/compare/v0.11.2...v0.11.3\n',
    )
  })

  it('never publishes an empty list', () => {
    expect(notesFromSubjects('1.0.0', ['doplan 1.0.0'], null)).toBe('## doplan 1.0.0\n\n### Изменения\n- Исправления и улучшения\n')
  })

  it('keeps generic merge subjects as they are', () => {
    expect(cleanSubject("Merge branch 'main' into x")).toBe("Merge branch 'main' into x")
    expect(cleanSubject('Merge Catalog: kitchen modules')).toBe('Catalog: kitchen modules')
  })

  it('uses an annotated tag message only when it has a body', () => {
    expect(notesFromTagMessage('doplan 0.11.3\n')).toBeNull()
    expect(notesFromTagMessage('doplan 0.12.0\r\n\r\n- New: X\r\n- Fix: Y\r\n')).toBe('## doplan 0.12.0\n\n- New: X\n- Fix: Y\n')
    expect(notesFromTagMessage('doplan 1.0.0\n\nBody\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n')).toBe(
      '## doplan 1.0.0\n\nBody\n',
    )
  })
})
