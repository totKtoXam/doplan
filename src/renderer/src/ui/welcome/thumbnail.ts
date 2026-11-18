/**
 * Plan thumbnails of the welcome screen's recent projects. Whenever a project is opened or saved, a
 * small SVG of its first level (walls, rooms, furniture outlines; no dimensions or labels) goes to main,
 * which keeps it next to the recent list. The web build keeps it with its copy of the document.
 * The picture has no colours of its own: light lines on a transparent ground, shown as a mask painted
 * with the current theme's text colour, so it fits every light and dark theme.
 */
import { buildDisplayList, toSvg } from '@core'
import type { Catalog, DerivedPlan, Doc } from '@core/types'
import { MAX_THUMB_BYTES } from '@shared/recent'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { projectStore } from '@/store/project'
import { uiStore } from '@/store/ui'
import { webRecent } from '@/store/webRecent'

/** SVG of the plan's first level, or null when it has nothing drawn (or is too large to keep) */
export function planThumbSvg(doc: Doc, catalog?: Catalog, derived?: DerivedPlan): string | null {
  const levelId = doc.levelOrder[0]
  if (!levelId) return null
  const onLevel = (o: Record<string, { levelId?: string }>) => Object.values(o).some((e) => e.levelId === levelId)
  if (!onLevel(doc.walls) && !onLevel(doc.rooms)) return null
  const svgOf = (furniture: boolean) => {
    const dl = buildDisplayList(doc, levelId, {
      dimensions: false,
      areas: false,
      furniture,
      labels: false,
      grid: false,
      titleBlock: false,
      // light lines on dark fills: the card uses the picture as a luminance mask in the theme's colours
      theme: 'blueprint',
      lights: false,
      electrical: false,
      northArrow: false,
      scaleBar: false,
      manualDimensions: false,
      catalog,
      derived,
    })
    return toSvg(dl, { scale: 100, marginMm: 4, background: false }).svg
  }
  // a furnished plan may be too detailed to keep: then walls and rooms only
  for (const furniture of [true, false]) {
    const svg = svgOf(furniture)
    if (svg.length <= MAX_THUMB_BYTES) return svg
  }
  return null
}

function rememberCurrent(): void {
  const { doc, filePath, derived } = docStore.getState()
  // an old version shown from the history is not what the project looks like now
  if (!filePath || projectStore.getState().viewing) return
  let svg: string | null = null
  try {
    svg = planThumbSvg(doc, uiStore.getState().catalog, derived[doc.levelOrder[0] ?? ''])
  } catch (err) {
    console.warn('[doplan] plan thumbnail failed', err)
  }
  if (api.platform === 'browser') webRecent.remember(doc, svg)
  else if (svg) void api.recent.setThumb(filePath, svg).catch(() => {})
}

let installed = false

/** follows the document: after an open or a save, the thumbnail of that project is updated (off the hot path) */
export function installRecentThumbs(): void {
  if (installed) return
  installed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  docStore.subscribe((s, prev) => {
    const opened = s.loadId !== prev.loadId || s.filePath !== prev.filePath
    const saved = prev.dirty && !s.dirty
    if (!s.filePath || (!opened && !saved)) return
    clearTimeout(timer)
    timer = setTimeout(rememberCurrent, 600)
  })
}
