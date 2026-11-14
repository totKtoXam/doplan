import type { DoorSlide, Opening, OpeningKind } from './types'

/**
 * Opening size minus leaf size, mm, for the door models built in view3d/build/openings.ts
 * (frame / lining, gaps, threshold). Negative values: the leaf is larger than the opening
 * (surface sliding and barn doors hang over it). Two-leaf doors: the sum of both leaves.
 * null: the kind has no door leaf.
 */
export function leafAllowance(kind: OpeningKind, slide?: DoorSlide): { w: number; h: number } | null {
  switch (kind) {
    case 'door':
      // 32 lining + 2 gap on each side; 32 head + 3 gap on top, 6 under the leaf
      return { w: 68, h: 41 }
    case 'doubleDoor':
      // as a door plus a 4 mm meeting gap between the two leaves
      return { w: 76, h: 41 }
    case 'entranceDoor':
      // 50 steel frame + 2 gap on each side; 50 head + 3 gap; 12 threshold + 6 gap
      return { w: 104, h: 71 }
    case 'slidingDoor':
      switch (slide ?? 'surface') {
        case 'pocket':
          return { w: 40, h: 32 }
        case 'barn':
          return { w: -100, h: -40 }
        case 'folding':
          return { w: 64, h: 77 }
        default:
          return { w: -60, h: -27 }
      }
    default:
      return null
  }
}

/** leaf width × height of a door opening, mm (null for kinds without a door leaf) */
export function doorLeafSize(o: Pick<Opening, 'kind' | 'slide' | 'width' | 'height'>): { w: number; h: number } | null {
  const a = leafAllowance(o.kind, o.slide)
  return a ? { w: o.width - a.w, h: o.height - a.h } : null
}

/** opening size that gives a leaf of exactly leafW × leafH, mm */
export function openingForLeaf(kind: OpeningKind, slide: DoorSlide | undefined, leafW: number, leafH: number): { width: number; height: number } {
  const a = leafAllowance(kind, slide) ?? { w: 0, h: 0 }
  return { width: leafW + a.w, height: leafH + a.h }
}

/** standard leaf widths offered in the inspector, mm (two-leaf doors: both leaves together) */
export function standardLeafWidths(kind: OpeningKind): number[] {
  if (kind === 'doubleDoor') return [1200, 1400, 1600]
  if (kind === 'entranceDoor') return [800, 860, 900, 960]
  return [600, 700, 800, 900]
}

export const STANDARD_LEAF_HEIGHTS: readonly number[] = [2000, 2100, 2300]
