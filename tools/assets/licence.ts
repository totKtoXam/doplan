/**
 * Licence strings of manifest.json models, e.g. `CC-BY-4.0 (Wayfair / Eric Chadwick)` or, for models whose parts
 * have different licences, `CC-BY-4.0 (DGG / Eric Chadwick) + CC0 (Fran Calvente)`.
 */

const norm = (l: string): string => (/^CC0/i.test(l) ? 'CC0' : l)

/** licences from most to least restrictive: the entry as a whole carries the first one any part has */
const STRICTNESS = ['CC-BY-4.0', 'CC0']

/**
 * The entry's licence and author for the catalog. With several parts the licence is the most restrictive one, and
 * the authors of parts under another licence are marked with it: `DGG / Eric Chadwick; Fran Calvente (CC0)`.
 */
export function parseLicence(l: string): { licence: string; author?: string } {
  const parts: { licence: string; author?: string }[] = []
  for (const raw of l.split(/\s+\+\s+/)) {
    const m = /^([A-Za-z0-9.-]+)\s*(?:\((.*)\))?\s*$/.exec(raw.trim())
    if (!m) return { licence: norm(l.trim()) }
    parts.push({ licence: norm(m[1]), author: m[2]?.trim() || undefined })
  }
  const rank = (x: string) => {
    const i = STRICTNESS.indexOf(x)
    return i < 0 ? -1 : i
  }
  const licence = parts.map((p) => p.licence).sort((a, b) => rank(a) - rank(b))[0]
  const authors = parts.filter((p) => p.author).map((p) => (p.licence === licence ? p.author! : `${p.author} (${p.licence})`))
  return authors.length ? { licence, author: authors.join('; ') } : { licence }
}

interface CreditEntry {
  name: string
  nameRu?: string
  source?: string
  licence?: string
  author?: string
  download?: { files?: { url: string }[]; zip?: { url: string } }
}

/** the Khronos glTF-Sample-Assets models under CC-BY-4.0 as LICENSES.md lines: name, author, source page, licence */
export function khronosCredits(assets: CreditEntry[]): string[] {
  return assets
    .filter((a) => a.source === 'khronos-gltf-sample-assets' && a.licence === 'CC-BY-4.0')
    .map((a) => {
      const url = a.download?.files?.[0]?.url ?? a.download?.zip?.url ?? ''
      const dir = /\/Models\/([^/]+)\//.exec(url)?.[1]
      const page = dir ? `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/${dir}` : 'https://github.com/KhronosGroup/glTF-Sample-Assets'
      return `- ${a.nameRu ?? a.name}: "${a.name}" by ${a.author ?? 'unknown'}, ${page}, ${a.licence}`
    })
    .sort((a, b) => a.localeCompare(b, 'ru'))
}
