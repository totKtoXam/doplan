/**
 * Extension point of the album: engineering systems (plumbing outlets, pipes, risers, boxes,
 * underfloor heating…) draw themselves onto the sheets that need them.
 *
 * A contributor draws WORLD-mm items for 1:S onto a level of a sheet and may add rows to the sheet's
 * legend / schedule. The builtin ones (`fixtures` for plumbing: outlets inferred from the sanitary
 * fixtures of the plan; `thermostats` for underfloor heating) step aside when a contributor that
 * `supersedes` them is registered — e.g. the utilities module with real plumbing points and heating
 * zones registers `{ id: 'utilities', sheets: ['plumbing', 'underfloor'], supersedes: ['fixtures', 'thermostats'] }`.
 */
import type { DisplayItem } from '../display'
import type { DerivedPlan, Doc, Id } from '../types'
import type { AlbumCtx, SheetKind } from './model'
import type { TableRow } from './table'

export interface ContributionInput {
  ctx: AlbumCtx
  doc: Doc
  levelId: Id
  plan: DerivedPlan
  /** 1:S */
  S: number
}

export interface Contribution {
  /** world mm for 1:S */
  items: DisplayItem[]
  /** legend rows: [symbol/code, name, note] */
  legend?: TableRow[]
  /** schedule rows of the sheet's table (columns are the sheet's) */
  schedule?: TableRow[]
  /** notes appended to the sheet */
  notes?: string[]
  /** outlets shown on the wall elevations: plan position (mm), height above the floor, code */
  points?: { x: number; y: number; h: number; code: string; color?: string }[]
}

export interface SheetContributor {
  id: string
  sheets: SheetKind[]
  /** builtin contributors this one replaces */
  supersedes?: string[]
  /** true when this contributor has anything to draw for the document */
  has?: (doc: Doc) => boolean
  draw: (sheet: SheetKind, input: ContributionInput) => Contribution | null
}

const registry = new Map<string, SheetContributor>()

export function registerSheetContributor(c: SheetContributor): () => void {
  registry.set(c.id, c)
  return () => {
    if (registry.get(c.id) === c) registry.delete(c.id)
  }
}

/** the contributors active for a sheet, superseded ones left out */
export function contributorsFor(sheet: SheetKind): SheetContributor[] {
  const all = [...registry.values()].filter((c) => c.sheets.includes(sheet))
  const gone = new Set(all.flatMap((c) => c.supersedes ?? []))
  return all.filter((c) => !gone.has(c.id))
}

export function contribute(sheet: SheetKind, input: ContributionInput): Contribution {
  const out: Contribution = { items: [], legend: [], schedule: [], notes: [], points: [] }
  for (const c of contributorsFor(sheet)) {
    const r = c.draw(sheet, input)
    if (!r) continue
    out.items.push(...r.items)
    out.legend!.push(...(r.legend ?? []))
    out.schedule!.push(...(r.schedule ?? []))
    out.notes!.push(...(r.notes ?? []))
    out.points!.push(...(r.points ?? []))
  }
  return out
}

export function hasContribution(sheet: SheetKind, doc: Doc): boolean {
  return contributorsFor(sheet).some((c) => !c.has || c.has(doc))
}
