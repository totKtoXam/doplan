/**
 * "Continue a wall from this node": a one-shot request the select tool / context menu leave for
 * the wall tool before switching to it. The wall tool consumes it in `activate()` and starts its
 * chain exactly on the node (so `addWall` joins it instead of creating a duplicate node) with the
 * thickness, kind and height of the wall it continues.
 */
import type { Doc, Id, Vec2, WallKind } from '@core/types'
import { uiStore } from '@/store/ui'
import type { EditorCtx } from '../context'

export interface WallStartRequest {
  nodeId: Id
  /**
   * screen position (CSS px) of the press that started a drag from the node or its "+" handle;
   * releasing the button away from it places the first segment. Null for a click-to-continue start.
   */
  pressScreen: Vec2 | null
  /** go back to the select tool when the chain ends (it was started from the select tool) */
  returnToSelect: boolean
}

const pending = new WeakMap<EditorCtx, WallStartRequest>()

/** returns and clears the pending request of this editor */
export function takeWallStart(ctx: EditorCtx): WallStartRequest | null {
  const r = pending.get(ctx) ?? null
  pending.delete(ctx)
  return r
}

/** switches to the wall tool anchored at `nodeId` */
export function requestWallFrom(ctx: EditorCtx, nodeId: Id, opts: { pressScreen?: Vec2 | null; returnToSelect?: boolean } = {}): void {
  const ui = uiStore.getState()
  pending.set(ctx, { nodeId, pressScreen: opts.pressScreen ?? null, returnToSelect: !!opts.returnToSelect })
  if (ui.tool === 'wall') {
    // already drawing walls: re-activate so the request is picked up
    ui.setTool('select')
  }
  uiStore.getState().setTool('wall')
}

/**
 * Wall properties a new wall continuing from `nodeId` inherits: those of the thickest solid wall at
 * the node (any wall when all of them are virtual). Null for a node without walls.
 */
export function inheritedWallProps(doc: Doc, nodeId: Id): { thickness: number; kind: WallKind; height: number } | null {
  let best: Doc['walls'][string] | null = null
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a !== nodeId && w.b !== nodeId) continue
    if (!best) best = w
    else {
      const solid = w.kind !== 'virtual'
      const bestSolid = best.kind !== 'virtual'
      if ((solid && !bestSolid) || (solid === bestSolid && w.thickness > best.thickness)) best = w
    }
  }
  return best ? { thickness: best.thickness, kind: best.kind, height: best.height } : null
}
