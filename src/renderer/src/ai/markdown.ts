/**
 * The block markdown chat messages use: GFM tables, fenced code, headings; everything else stays text
 * with its line breaks (lists read fine as they are). Inline `code` / **bold** are done by the renderer.
 * Safe on half-streamed text: a table without its delimiter row yet is text, an open fence runs to the end.
 */

export type MdAlign = 'left' | 'center' | 'right' | null

export type MdBlock =
  | { type: 'text'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; head: string[]; align: MdAlign[]; rows: string[][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const DELIM_CELL = /^\s*:?-+:?\s*$/

/** cells of a table row: outer pipes dropped, `\|` kept as a pipe */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

function delimiter(line: string, cols: number): MdAlign[] | null {
  if (!line.includes('-')) return null
  const cells = splitRow(line)
  if (cells.length !== cols || !cells.every((c) => DELIM_CELL.test(c))) return null
  return cells.map((c) => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null
  })
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let text: string[] = []
  const flush = () => {
    // blank lines around blocks are spacing the renderer already gives
    while (text.length && !text[0].trim()) text.shift()
    while (text.length && !text[text.length - 1].trim()) text.pop()
    if (text.length) out.push({ type: 'text', text: text.join('\n') })
    text = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const mark = fence[1]
      const closes = (l: string) => {
        const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l)
        return !!m && m[1][0] === mark[0] && m[1].length >= mark.length
      }
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !closes(lines[j])) body.push(lines[j++])
      out.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      i = j
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      flush()
      out.push({ type: 'heading', level: h[1].length, text: h[2] })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const head = splitRow(line)
      const align = delimiter(lines[i + 1], head.length)
      if (align) {
        flush()
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
          const cells = splitRow(lines[j++])
          rows.push(head.map((_, k) => cells[k] ?? ''))
        }
        out.push({ type: 'table', head, align, rows })
        i = j - 1
        continue
      }
    }

    text.push(line)
  }
  flush()
  return out
}
