/**
 * The single bridge from the dp CLI to doplan core.
 *
 * Imported by RELATIVE path on purpose: the CLI runs under `tsx` (pnpm dp …), and core itself only
 * uses relative imports, so nothing depends on the Vite/tsconfig aliases (`@core`) at runtime.
 * Typechecking still goes through the repo tsconfig (tools/ is included).
 */
export {
  buildDisplayList,
  compilePlanSpec,
  derivePlan,
  docToPlanSpec,
  drawToCanvas,
  isTechnicalRoom,
  listVariants,
  parseDoc,
  parsePlanSpec,
  serializeDoc,
  summarizeLevelRooms,
  validatePlanSpec,
} from '../../../src/core/index'
export type { DerivedPlan, DerivedRoom, Doc, Opening, Underlay, Wall, WallGeom } from '../../../src/core/types'
