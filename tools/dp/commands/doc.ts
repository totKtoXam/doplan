/** `dp doc …` — inspect / render / decompile existing .doplan projects. */
import { writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Args } from '../lib/args'
import { derivePlan, docToPlanSpec, isTechnicalRoom, listVariants, summarizeLevelRooms } from '../lib/core'
import { ensureDirFor } from '../lib/image'
import { type CommandResult, DpError, r2 } from '../lib/output'
import { firstLevel, readDoplan, renderDoc } from '../lib/plan'

export async function docInfo(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<project.doplan>'))
  const { manifest, doc, entries } = readDoplan(file)
  const levels = doc.levelOrder
    .filter((id) => doc.levels[id])
    .map((id) => {
      const lv = doc.levels[id]
      const plan = derivePlan(doc, id)
      const rooms = plan.rooms
        .map((f) => {
          const rec = doc.rooms[f.roomId]
          const room = { id: f.roomId, name: rec?.name ?? '(без названия)', type: rec?.type ?? 'other', area: r2(f.area), perimeter: r2(f.perimeter) }
          // shafts / risers: listed, but not counted in the totals (same rule as the app status bar)
          return isTechnicalRoom(rec?.type, f.area, rec?.technical) ? { ...room, technical: true } : room
        })
        .sort((x, y) => y.area - x.area)
      // BTI totals: balcony ×0.3, loggia ×0.5, technical areas excluded
      const area = summarizeLevelRooms(doc, plan.rooms)
      const walls = Object.values(doc.walls).filter((w) => w.levelId === id)
      const wallLen = Object.values(plan.wallGeoms).reduce((s, g) => s + g.length, 0)
      const byKind: Record<string, number> = {}
      for (const w of walls) byKind[w.kind] = (byKind[w.kind] ?? 0) + 1
      const thick: Record<string, number> = {}
      for (const w of walls) thick[String(w.thickness)] = (thick[String(w.thickness)] ?? 0) + 1
      const wallIds = new Set(walls.map((w) => w.id))
      const openings: Record<string, number> = {}
      for (const o of Object.values(doc.openings)) if (wallIds.has(o.wallId)) openings[o.kind] = (openings[o.kind] ?? 0) + 1
      const items = Object.values(doc.items).filter((i) => i.levelId === id).length
      const b = plan.bounds
      return {
        id,
        name: lv.name,
        height: lv.height,
        rooms,
        area,
        totalArea: area.total,
        // plain Σ of every closed area, no coefficients / exclusions
        grossArea: r2(rooms.reduce((s, r) => s + r.area, 0)),
        walls: { count: walls.length, lengthM: r2(wallLen / 1000), byKind, byThickness: thick },
        openings,
        items,
        lights: Object.values(doc.lights).filter((l) => l.levelId === id).length,
        underlays: Object.values(doc.underlays).filter((u) => u.levelId === id).length,
        sizeM: [r2((b.maxX - b.minX) / 1000), r2((b.maxY - b.minY) / 1000)],
      }
    })
  const text = [`${basename(file)}: "${doc.meta.name}" (format ${String(manifest.format ?? '?')}, ${entries.length} entries)`]
  // furnishing variants: items / lights above are the active one's; walls and rooms are shared
  const variants = listVariants(doc)
  if (variants.length > 1) text.push(`variants: ${variants.map((v) => (v.active ? `*${v.name}` : v.name)).join(', ')} (* = active; items/lights are of the active one)`)
  for (const l of levels) {
    text.push(
      `level ${l.name}: ${l.sizeM[0]}×${l.sizeM[1]} m, ${l.area.count} rooms ${l.totalArea} m², walls ${l.walls.count} (${l.walls.lengthM} m; ` +
        `${Object.entries(l.walls.byThickness)
          .map(([t, n]) => `${t}mm×${n}`)
          .join(', ')}), items ${l.items}`,
    )
    text.push(
      `  total ${l.area.total} m² (balcony ×0.3, loggia ×0.5), living ${l.area.living} m², balconies/loggias ${l.area.outdoor} m² actual` +
        (l.area.technicalCount ? `, ${l.area.technicalCount} technical area(s) (shafts, voids) excluded` : ''),
    )
    for (const r of l.rooms)
      text.push(`  ${r.name.padEnd(18)} ${r.type.padEnd(13)} ${r.area.toFixed(2).padStart(7)} m²${'technical' in r ? '  (technical, excluded)' : ''}`)
    const ops = Object.entries(l.openings)
    text.push(`  openings: ${ops.length ? ops.map(([k, n]) => `${k}×${n}`).join(', ') : 'none'}`)
  }
  return { data: { ok: true, file, manifest, name: doc.meta.name, levels, variants }, text }
}

export async function docRender(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<project.doplan>'))
  const out = resolve(a.req('out'))
  const { doc } = readDoplan(file)
  const lvArg = a.str('level')
  let lvl = firstLevel(doc)
  if (lvArg) {
    const found = doc.levelOrder.find((id, i) => id === lvArg || doc.levels[id]?.name === lvArg || String(i + 1) === lvArg)
    if (!found) throw new DpError(`level "${lvArg}" not found (levels: ${doc.levelOrder.map((id) => doc.levels[id]?.name).join(', ')})`)
    lvl = found
  }
  const r = renderDoc(doc, lvl, {
    pxPerMm: a.num('px-per-m', 100) / 1000,
    dimensions: a.bool('dims', true),
    furniture: a.bool('furniture', true),
    theme: a.str('theme') === 'blueprint' ? 'blueprint' : 'light',
  })
  ensureDirFor(out)
  writeFileSync(out, r.png)
  return { data: { ok: true, out, size: [r.width, r.height], level: lvl }, text: [`render: ${out} (${r.width}x${r.height})`] }
}

export async function docSpec(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<project.doplan>'))
  const out = resolve(a.req('out'))
  const { doc } = readDoplan(file)
  const spec = docToPlanSpec(doc, a.str('level') ?? firstLevel(doc))
  ensureDirFor(out)
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  return { data: { ok: true, out }, text: [`walls-mode PlanSpec written to ${out}`] }
}
