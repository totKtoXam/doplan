# doplan architecture & module contracts (binding)

Decisions come from `docs/research/_critic.md` (overrides individual reports). Detailed designs:
`docs/research/editor-2d.md`, `render-3d.md`, `electron-optimization.md`, `photo-to-plan.md`, `open-assets.md`.

Stack: Electron 45 · electron-vite 6 · Vite 8 · TypeScript 7 · React 19 · zustand 5 + immer 11 · PixiJS 8 (2D editor)
· three 0.187 `WebGPURenderer` (`three/webgpu`, TSL; WebGL2 fallback via `forceWebGL`) · three-gpu-pathtracer 0.0.28 (`/webgpu`)
· Tailwind 4 · single package, pnpm (hoisted). ALL dependencies are already installed — do NOT run `pnpm add/install`.
If you truly need another package, list it in your final report instead.

Aliases (tsconfig + vite): `@core/*` → `src/core/*`, `@core` → `src/core/index.ts`, `@shared/*` → `src/shared/*`, `@/*` → `src/renderer/src/*`.

## Contract files (read-only for everybody)
- `src/core/types.ts` — document schema, units/axes, derived geometry types.
- `src/shared/ipc.ts` — `window.doplan` preload API.
- `src/renderer/src/contracts.ts` — stores, Editor2D, Engine3D, view3d sub-contracts.
If a contract is insufficient, do NOT edit it: add your own extension type in your module and report the gap.

## Ownership map (write ONLY inside your area)
| Area | Paths |
|---|---|
| core-geometry | `src/core/{ids,geom,defaults,joins,rooms,derive,ops,io,catalog,index}.ts`, `src/core/__tests__/geometry*.test.ts` |
| core-output | `src/core/{planspec,display,bom}.ts`, `src/core/export/{svg,dxf,canvas}.ts`, `src/core/__tests__/output*.test.ts` |
| main | `src/main/**`, `src/preload/**`, `electron.vite.config.ts`, `electron-builder.yml`, `src/renderer/index.html`, `resources/icon*` |
| ui-shell | `src/renderer/src/{main.tsx,App.tsx,styles.css,i18n.ts}`, `src/renderer/src/store/**`, `src/renderer/src/ui/shell/**`, `src/renderer/src/actions/**` |
| ui-panels | `src/renderer/src/ui/panels/**`, `src/renderer/src/ui/kit/**` |
| editor2d | `src/renderer/src/editor2d/**` |
| 3d-architecture | `src/renderer/src/view3d/{index,engine,materials,textures,patterns,items,export}.ts`, `src/renderer/src/view3d/build/**` |
| 3d-procedural | `src/renderer/src/view3d/procedural/**` |
| 3d-rendering | `src/renderer/src/view3d/{lighting,post,controls,interaction,pathtracer,quality}.ts` |
| assets | `tools/assets/**`, `resources/assets/**` |
| photo-to-plan | `tools/dp/**`, `.claude/skills/photo-to-plan/**`, `docs/PHOTO_TO_PLAN.md` |

## Core API (exported from `src/core/index.ts`; pure TS, no DOM/Node/three imports)
```ts
// ids.ts
newId(prefix: 'n'|'w'|'o'|'r'|'i'|'l'|'d'|'t'|'u'|'c'|'m'|'a'|'lv'): Id          // `${prefix}_${nanoid(10)}`
// geom.ts
toWorld(x: number, y: number, elev?: number): [number, number, number]            // mm → metres, Y-up
fromWorld(wx: number, wz: number): Vec2
dist, add, sub, scale, dot, cross, len, norm, lerp, rotate(deg), angleDeg, polygonArea (signed), polygonCentroid,
pointInPolygon, segIntersect, projectOnSegment(p, a, b): {point, t, dist}, polylabel(polygon, holes?): Vec2, bboxOf
EPS = 0.5 /*mm*/
// defaults.ts
createEmptyDoc(name?: string): Doc                    // one level 'Этаж 1', defaults, default render settings
DEFAULT_MATERIALS: { wall, floor, ceiling, skirting, door, frame, glass, curtain, sheer }: Record<string, Id>
BUILTIN_MATERIALS: Material[]                         // ≥60 colour-only materials (paints palette, plain tiles, woods as colours, metals, glass, fabrics) ids `mat_*`
BUILTIN_ASSETS: Asset[]                               // one per ProceduralKind (+ useful variants), ids `asset_*`, Russian names
OPENING_DEFAULTS: Record<OpeningKind, {width,height,sill}>
ROOM_TYPE_NAMES: Record<RoomType, {ru: string, en: string}>
defaultCurtain(): CurtainSpec ; defaultRoom(levelId, anchor): Room
// joins.ts / rooms.ts / derive.ts
computeWallGeoms(doc, levelId): Record<Id, WallGeom>   // mitred wall outlines (virtual walls: zero-thickness)
detectRooms(doc, levelId, wallGeoms): DerivedRoom[]   // planar faces, matched to Room records by anchor
derivePlan(doc, levelId): DerivedPlan
// ops.ts — mutate the passed Doc in place (called on an Immer draft); return created ids
addWall(doc, levelId, p1: Vec2, p2: Vec2, opts?: Partial<Pick<Wall,'thickness'|'height'|'kind'>>): Id[]  // snaps to existing nodes (EPS), splits crossed walls, inserts nodes on walls
addRectRoom(doc, levelId, x, y, w, h, opts?): Id[]     // four walls (centreline rect)
moveNode(doc, nodeId, x, y): void
moveWall(doc, wallId, dx, dy): void
splitWall(doc, wallId, at: Vec2): Id                   // new node id; openings redistributed
setWallLength(doc, wallId, lengthMm, anchor: 'a'|'b'|'center'): void
addOpening(doc, wallId, kind: OpeningKind, offset: number, patch?: Partial<Opening>): Id
moveOpening(doc, openingId, wallId, offset): void
addItem(doc, levelId, asset: Asset, x, y, patch?: Partial<Item>): Id
addLight(doc, levelId, kind, x, y, patch?): Id
removeEntities(doc, refs: EntityRef[]): void           // cascades (wall → openings; orphan nodes)
duplicateEntities(doc, refs, dx, dy): EntityRef[]
normalize(doc): void                                   // merge coincident nodes, drop degenerate/duplicate walls, merge collinear degree-2 nodes only when walls are identical in props, clamp openings to wall
syncRooms(doc): void                                   // create Room records for unmatched faces, delete records whose anchor is in no face, move anchors to labelPoint
wallLength(doc, wall): number
applyFinishToWallSide(doc, wallId, side, materialId, zone?: {from,to}): void
// io.ts
serializeDoc(doc): string ; parseDoc(json: unknown): Doc   // validates + fills defaults + migrates; throws Error with readable message
// catalog.ts
mergeCatalog(base: Catalog, extra: Partial<Catalog>): Catalog ; builtinCatalog(): Catalog
findMaterial(doc, catalog, id): Material | undefined ; findAsset(doc, catalog, id): Asset | undefined

// planspec.ts (core-output) — compact human/LLM-writable plan description, see docs/research/photo-to-plan.md §4
type PlanSpec ; parsePlanSpec(json: unknown): PlanSpec ; validatePlanSpec(spec): PlanIssue[] ; compilePlanSpec(spec): Doc
docToPlanSpec(doc, levelId?): PlanSpec
// display.ts — the single source of every non-interactive drawing of the plan
type DisplayList = { bounds, items: DisplayItem[] }   // polygons/lines/arcs/texts with layer + style, mm coords
buildDisplayList(doc, levelId, opts?: {dimensions?, areas?, furniture?, labels?, grid?, titleBlock?, theme?: "light" | "blueprint"}): DisplayList
// export/svg.ts, export/dxf.ts, export/canvas.ts
toSvg(dl, opts?: {scale?: number /* 1:scale, default 100 */, marginMm?, title?}): {svg: string, widthMm: number, heightMm: number}
toDxf(doc, levelId): string
drawToCanvas(ctx /* CanvasRenderingContext2D-like */, dl, opts: {pxPerMm: number, offsetX?, offsetY?, background?}): void
// bom.ts
computeBom(doc, catalog): BomRow[]   // floor m2 per material, tile count with waste, wall finish m2, paint litres, wallpaper rolls, skirting m, openings, items
```

## Process rules
- Renderer is sandboxed: no Node APIs; everything external goes through `window.doplan`.
- Bare `three` is aliased to `three/webgpu` by Vite; import from `three`, `three/tsl`, `three/addons/...`. Never construct the classic `WebGLRenderer`.
- All document changes go through `docStore.transact()`.
- UI language: Russian by default, English available via `i18n.ts` `t(key)`.
- Verify your own area with `pnpm exec tsc --noEmit -p tsconfig.json` (errors from other areas that are still in progress are expected: fix only yours) and `pnpm exec vitest run <your tests>` where applicable. Do NOT run `pnpm dev` / electron (other agents work in parallel). Do NOT run git commands.
- Write complete, working code. No TODO stubs, no placeholder functions.
