/**
 * Release notes for a `vX.Y.Z` tag, printed as Markdown on stdout.
 *
 *   pnpm release:notes vX.Y.Z [--repo=owner/name]
 *
 * - An annotated tag whose message has a body (anything after the first line) → that message is the notes,
 *   with its first line as the heading. `git tag -a v1.2.3 -F notes.md` is the way to hand-write them.
 * - Otherwise (lightweight tag, or just "doplan X.Y.Z") → the commit subjects since the previous `v*` tag,
 *   first-parent only (one line per merged change, not every commit inside a merge), version-bump commits
 *   ("doplan X.Y.Z") left out, plus a compare link.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).replace(/\r\n/g, '\n').trimEnd()

const BUMP_RE = /^doplan \d+\.\d+\.\d+\S*$/

/** "Merge AI chat: foo" → "AI chat: foo"; "Merge branch 'x'" stays (no better subject) */
export function cleanSubject(s: string): string {
  const m = /^Merge (?!branch |remote-tracking branch |pull request )(.+)$/.exec(s)
  return (m ? m[1] : s).trim()
}

export function notesFromSubjects(version: string, subjects: string[], compareUrl: string | null): string {
  const lines = subjects.map(cleanSubject).filter((s) => s && !BUMP_RE.test(s))
  const uniq = [...new Set(lines)]
  const out = [`## doplan ${version}`, '', '### Изменения']
  out.push(...(uniq.length ? uniq.map((s) => `- ${s}`) : ['- Исправления и улучшения']))
  if (compareUrl) out.push('', `**Full Changelog**: ${compareUrl}`)
  return `${out.join('\n')}\n`
}

/** annotated-tag message → notes, or null when it has no body worth publishing */
export function notesFromTagMessage(message: string): string | null {
  const text = message.replace(/\r\n/g, '\n').replace(/-----BEGIN (PGP|SSH) SIGNATURE-----[\s\S]*$/, '').trim()
  const [first, ...rest] = text.split('\n')
  const body = rest.join('\n').trim()
  if (!body) return null
  return `## ${first.trim()}\n\n${body}\n`
}

function main(): void {
  const argv = process.argv.slice(2)
  const tag = argv.find((a) => !a.startsWith('--'))
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
    console.error('usage: pnpm release:notes vX.Y.Z [--repo=owner/name]')
    process.exit(1)
  }
  const repo = argv.find((a) => a.startsWith('--repo='))?.slice(7) ?? 'totKtoXam/doplan'

  if (git('cat-file', '-t', tag) === 'tag') {
    const fromTag = notesFromTagMessage(git('tag', '-l', '--format=%(contents)', tag))
    if (fromTag) {
      process.stdout.write(fromTag)
      return
    }
  }

  let prev: string | null = null
  try {
    prev = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`)
  } catch {
    prev = null // first release: whole history
  }
  const range = prev ? `${prev}..${tag}` : tag
  const subjects = git('log', '--first-parent', '--format=%s', range).split('\n').filter(Boolean)
  const compare = prev ? `https://github.com/${repo}/compare/${prev}...${tag}` : null
  process.stdout.write(notesFromSubjects(tag.replace(/^v/, ''), subjects, compare))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
