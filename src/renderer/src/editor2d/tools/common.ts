/** Helpers shared by tools: item ↔ wall snapping, opening placement maths, selection helpers. */
import type { Asset, AssetCategory, EntityRef, Id, Item, Opening, Vec2 } from '@core/types'
import { uiStore } from '@/store/ui'
import type { EditorCtx } from '../context'
import { add, dot, leftOf, mul, norm, normDeg, sub } from '../geom'
import type { WallHit } from '../hit'
import { lengthStep, snapToGrid } from '../snap'

export function selectOnly(ref: EntityRef | null): void {
  const ui = uiStore.getState()
  if (ref) ui.select([ref])
  else ui.clearSelection()
}

export function toggleSelection(ref: EntityRef): void {
  const ui = uiStore.getState()
  const cur = ui.selection
  const has = cur.some((r) => r.kind === ref.kind && r.id === ref.id)
  ui.select(has ? cur.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) : [...cur, ref])
}

export function setHover(ref: EntityRef | null): void {
  const ui = uiStore.getState()
  const cur = ui.hover
  if (cur === ref) return
  if (cur && ref && cur.kind === ref.kind && cur.id === ref.id) return
  ui.set({ hover: ref })
}

// ───────────────────────────── items ─────────────────────────────

/** categories that are normally placed with their back against a wall */
const BACK_TO_WALL: ReadonlySet<AssetCategory> = new Set<AssetCategory>([
  'sofa',
  'armchair',
  'bed',
  'storage',
  'kitchen',
  'appliance',
  'bathroom',
  'electronics',
])

export interface ItemPlacement {
  x: number
  y: number
  rotation: number
  /** wall the item was snapped to */
  wallId?: Id
}

/**
 * Snaps an item footprint to the nearest wall: back against the wall face with the rotation
 * aligned to the wall (wall-mounted items and typical "against the wall" furniture) or flush in
 * the nearest 90° orientation (tables, rugs, plants…). A second, roughly perpendicular wall is
 * used to push the item into the corner. Falls back to grid snapping of the centre.
 */
export function placeItem(
  ctx: EditorCtx,
  item: Pick<Item, 'size' | 'mount' | 'rotation'>,
  asset: Asset | undefined,
  centre: Vec2,
  opts: { alt?: boolean; keepRotation?: boolean } = {},
): ItemPlacement {
  const free = (): ItemPlacement => {
    const p = snapToGrid(ctx, centre, opts.alt)
    return { x: p.x, y: p.y, rotation: item.rotation }
  }
  if (opts.alt || item.mount === 'ceiling' || item.mount === 'surface') return free()
  if (!ctx.doc().settings.snapObjects) return free()

  const backMode = !opts.keepRotation && (item.mount === 'wall' || (!!asset && BACK_TO_WALL.has(asset.category)))
  const reach = Math.max(ctx.mm(14), 90)
  const maxHalf = Math.max(item.size.w, item.size.d) / 2
  const hit = ctx.hit.nearestWall(centre, (backMode ? item.size.d / 2 : maxHalf) + reach)
  if (!hit) return free()

  const wallOf = (h: WallHit): { n: Vec2; half: number } => {
    const u = norm(sub(h.geom.b, h.geom.a))
    const l = leftOf(u)
    const w = ctx.doc().walls[h.wallId]
    return { n: h.side === 'left' ? l : mul(l, -1), half: w && w.kind !== 'virtual' ? w.thickness / 2 : 0 }
  }

  const first = wallOf(hit)
  const n = first.n
  // rotation that turns the item's front (+y at 0°) along the wall normal
  const backRot = normDeg((Math.atan2(-n.x, n.y) * 180) / Math.PI)
  let rotation = backRot
  let depth = item.size.d
  let width = item.size.w
  if (!backMode) {
    // nearest of the four wall-aligned orientations to the current rotation
    let best = 0
    let bestDiff = Infinity
    for (let k = 0; k < 4; k++) {
      const r = normDeg(backRot + k * 90)
      const diff = Math.abs(((r - normDeg(item.rotation) + 540) % 360) - 180)
      if (diff < bestDiff) {
        bestDiff = diff
        best = k
      }
    }
    rotation = normDeg(backRot + best * 90)
    if (best % 2 === 1) {
      depth = item.size.w
      width = item.size.d
    }
    // only snap when the item actually comes close to the wall in this orientation
    if (hit.bodyDist > depth / 2 + reach) return free()
  }

  const face = add(hit.point, mul(n, first.half))
  let c = add(face, mul(n, depth / 2))
  // keep the position along the wall from the cursor, rounded to a comfortable step
  const u = norm(sub(hit.geom.b, hit.geom.a))
  if (ctx.doc().settings.snapGrid) {
    const ls = lengthStep(ctx.camera.scale)
    const s = dot(sub(c, hit.geom.a), u)
    const rounded = Math.round(s / ls) * ls
    c = add(c, mul(u, rounded - s))
  }

  // corner: a second wall next to the side of the item
  const second = ctx.hit.nearestWall(c, width / 2 + reach, { exclude: new Set([hit.wallId]) })
  if (second) {
    const sw = wallOf(second)
    const cosang = Math.abs(dot(sw.n, n))
    if (cosang < 0.5) {
      const gap = second.bodyDist - width / 2
      if (Math.abs(gap) <= reach) {
        // slide along the first wall until the side touches the second wall
        const along = dot(sw.n, u)
        if (Math.abs(along) > 0.3) c = add(c, mul(u, -gap / along))
      }
    }
  }
  return { x: c.x, y: c.y, rotation, wallId: hit.wallId }
}

// ───────────────────────────── openings ─────────────────────────────

export interface OpeningPlacement {
  wallId: Id
  offset: number
  width: number
  /** false when the opening does not fit or overlaps another opening */
  valid: boolean
  centred: boolean
}

/**
 * Position of an opening of `width` on the wall under the cursor: clamped to the wall, snapped to
 * the wall centre and to 50 mm steps from the wall start; flags overlaps with other openings.
 */
export function placeOpeningOnWall(
  ctx: EditorCtx,
  hit: WallHit,
  width: number,
  rawOffset: number,
  opts: { alt?: boolean; ignoreId?: Id } = {},
): OpeningPlacement {
  const doc = ctx.doc()
  const length = hit.geom.length
  let w = width
  let valid = true
  const margin = 50
  if (length < w + margin * 2) {
    if (length >= 500) w = Math.max(300, length - margin * 2)
    else valid = false
  }
  const min = w / 2 + Math.min(margin, Math.max(0, (length - w) / 2))
  const max = length - min
  let offset = Math.min(max, Math.max(min, rawOffset))
  let centred = false
  if (!opts.alt) {
    const tol = ctx.mm(9)
    if (Math.abs(offset - length / 2) <= tol) {
      offset = length / 2
      centred = true
    } else if (doc.settings.snapGrid) {
      const step = ctx.camera.scale >= 0.25 ? 10 : 50
      const edge = Math.round((offset - w / 2) / step) * step
      offset = Math.min(max, Math.max(min, edge + w / 2))
    }
  }
  if (max < min) valid = false
  for (const id in doc.openings) {
    const o: Opening = doc.openings[id]
    if (o.wallId !== hit.wallId || id === opts.ignoreId) continue
    if (Math.abs(o.offset - offset) < (o.width + w) / 2 - 0.5) {
      valid = false
      break
    }
  }
  return { wallId: hit.wallId, offset, width: w, valid, centred }
}
