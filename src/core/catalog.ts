import { BUILTIN_ASSETS, BUILTIN_MATERIALS } from './defaults'
import type { Asset, Catalog, Doc, Hdri, Id, Material } from './types'

export const CATALOG_VERSION = 1

function mergeById<T extends { id: Id }>(base: readonly T[], extra: readonly T[] | undefined): T[] {
  if (!extra || extra.length === 0) return base.slice()
  const out = base.slice()
  const index = new Map<Id, number>()
  out.forEach((e, i) => index.set(e.id, i))
  for (const e of extra) {
    if (!e || typeof e.id !== 'string') continue
    const i = index.get(e.id)
    if (i === undefined) {
      index.set(e.id, out.length)
      out.push(e)
    } else {
      out[i] = e
    }
  }
  return out
}

/** Returns a new catalogue: entries of `extra` are appended, entries with an existing id replace the base ones. */
export function mergeCatalog(base: Catalog, extra: Partial<Catalog>): Catalog {
  return {
    version: Math.max(base.version ?? CATALOG_VERSION, extra.version ?? 0),
    materials: mergeById<Material>(base.materials ?? [], extra.materials),
    assets: mergeById<Asset>(base.assets ?? [], extra.assets),
    hdris: mergeById<Hdri>(base.hdris ?? [], extra.hdris),
  }
}

/** The zero-download catalogue: colour-only materials and procedural assets. */
export function builtinCatalog(): Catalog {
  return {
    version: CATALOG_VERSION,
    materials: BUILTIN_MATERIALS.slice(),
    assets: BUILTIN_ASSETS.slice(),
    hdris: [],
  }
}

interface CatalogIndex {
  materials: Map<Id, Material>
  assets: Map<Id, Asset>
  /** array identities the index was built from (the catalogue may be replaced or mutated) */
  materialsRef: readonly Material[]
  assetsRef: readonly Asset[]
  materialCount: number
  assetCount: number
}

const indexCache = new WeakMap<Catalog, CatalogIndex>()

function indexOf(catalog: Catalog): CatalogIndex {
  let idx = indexCache.get(catalog)
  if (
    !idx ||
    idx.materialsRef !== catalog.materials ||
    idx.assetsRef !== catalog.assets ||
    idx.materialCount !== catalog.materials.length ||
    idx.assetCount !== catalog.assets.length
  ) {
    idx = {
      materials: new Map(catalog.materials.map((m) => [m.id, m])),
      assets: new Map(catalog.assets.map((a) => [a.id, a])),
      materialsRef: catalog.materials,
      assetsRef: catalog.assets,
      materialCount: catalog.materials.length,
      assetCount: catalog.assets.length,
    }
    indexCache.set(catalog, idx)
  }
  return idx
}

const builtinMaterials = new Map<Id, Material>(BUILTIN_MATERIALS.map((m) => [m.id, m]))
const builtinAssets = new Map<Id, Asset>(BUILTIN_ASSETS.map((a) => [a.id, a]))

/** Project-local material first, then the catalogue, then the built-in set. */
export function findMaterial(doc: Doc | null | undefined, catalog: Catalog | null | undefined, id: Id): Material | undefined {
  return doc?.materials?.[id] ?? (catalog ? indexOf(catalog).materials.get(id) : undefined) ?? builtinMaterials.get(id)
}

/** Project-local asset first, then the catalogue, then the built-in set. */
export function findAsset(doc: Doc | null | undefined, catalog: Catalog | null | undefined, id: Id): Asset | undefined {
  return doc?.assets?.[id] ?? (catalog ? indexOf(catalog).assets.get(id) : undefined) ?? builtinAssets.get(id)
}
