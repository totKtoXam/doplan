import { describe, expect, it } from 'vitest'
import { parseMarkdown, splitRow } from './markdown'

describe('chat markdown blocks', () => {
  it('a GFM table between text: header, alignment, rows padded to the header', () => {
    const md = [
      'Вот помещения:',
      '',
      '| № | Помещение | На плане |',
      '|---|:---|---:|',
      '| 1 | Кухня | да |',
      '| 2 | Спальня `r_2` |',
      '',
      'Готово.',
    ].join('\n')
    expect(parseMarkdown(md)).toEqual([
      { type: 'text', text: 'Вот помещения:' },
      {
        type: 'table',
        head: ['№', 'Помещение', 'На плане'],
        align: [null, 'left', 'right'],
        rows: [
          ['1', 'Кухня', 'да'],
          ['2', 'Спальня `r_2`', ''],
        ],
      },
      { type: 'text', text: 'Готово.' },
    ])
  })

  it('rows without outer pipes, escaped pipes, a table running to the end', () => {
    expect(splitRow('a | b \\| c | d')).toEqual(['a', 'b | c', 'd'])
    expect(parseMarkdown('x | y\n--|--\n1 | 2')).toEqual([{ type: 'table', head: ['x', 'y'], align: [null, null], rows: [['1', '2']] }])
  })

  it('half-streamed: a header row without its delimiter yet is text; column counts must match', () => {
    expect(parseMarkdown('| № | Помещение |')).toEqual([{ type: 'text', text: '| № | Помещение |' }])
    expect(parseMarkdown('a | b\n---')).toEqual([{ type: 'text', text: 'a | b\n---' }])
  })

  it('fenced code keeps its text as is (pipes, #, blank lines); an open fence runs to the end', () => {
    const md = 'До\n```json\n{ "a": "| x |" }\n\n# not a heading\n```\nПосле'
    expect(parseMarkdown(md)).toEqual([
      { type: 'text', text: 'До' },
      { type: 'code', lang: 'json', text: '{ "a": "| x |" }\n\n# not a heading' },
      { type: 'text', text: 'После' },
    ])
    expect(parseMarkdown('~~~\nline 1\nline 2')).toEqual([{ type: 'code', lang: '', text: 'line 1\nline 2' }])
  })

  it('headings; lists and line breaks stay text', () => {
    expect(parseMarkdown('### Итог\n- кухня 12 м²\n- спальня')).toEqual([
      { type: 'heading', level: 3, text: 'Итог' },
      { type: 'text', text: '- кухня 12 м²\n- спальня' },
    ])
    expect(parseMarkdown('#хэштег')).toEqual([{ type: 'text', text: '#хэштег' }])
  })
})
