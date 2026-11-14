# doplan research: completeness critique and binding resolutions

Date: 2026-11-12. Reviewed: `competitors-consumer.md`, `competitors-opensource.md`, `editor-2d.md`, `render-3d.md`, `electron-optimization.md`, `photo-to-plan.md`, `open-assets.md`.
Where reports disagree, the decision in this file wins. Checks marked **[checked]** were run today (`npm view`, jsDelivr file probes, vendor pages).

---

## 1. Contradictions and the single decision for each

| # | Topic | Who says what | Decision | Reason |
|---|---|---|---|---|
| C1 | 3D renderer | render-3d: `WebGPURenderer` only. electron-optimization: classic `THREE.WebGLRenderer`, "pathtracer is built on WebGL targets [T]". competitors-opensource: "WebGL2 first". | **`WebGPURenderer` from `three/webgpu`**, WebGPU backend by default, automatic and user-selectable `forceWebGL` fallback. No classic `WebGLRenderer` anywhere. | The electron-optimization assumption is false **[checked]**: in three-gpu-pathtracer 0.0.28 `WebGLPathTracer` logs "deprecated and will be removed", the README says "The project requires WebGPU", peer is `three >=0.187.0`. `LightMapper` is documented as WebGPURenderer-only. The "WebGL2 first" caution is met by the renderer's own WebGL2 backend, with one material code path. |
| C2 | R3F vs vanilla | electron-optimization: R3F canvas, `frameloop="demand"`, drei, three-stdlib in deps. render-3d: vanilla `Engine`. | **Vanilla engine.** Remove `@react-three/fiber`, `@react-three/drei`, `three-stdlib` from the dependency list. Lazy chunk stays (`import('./view3d')` returns the engine). `FrameScheduler` replaces `frameloop="demand"`. | R3F 9.8.2 has WebGPU only via the async `gl` factory; v10 is `10.0.0-alpha.6` **[checked]**. The scene is generated from the document, not authored in JSX. |
| C3 | 2D renderer | editor-2d: PixiJS 8 (WebGL). electron-optimization: "plain Canvas2D/SVG/PixiJS-free". photo-to-plan: `drawPlan2D(ctx: Canvas2DLike)` "used for CLI renders and the app's exports". editor-2d: exports come from a display list → SVG. | **PixiJS 8.23.0 (`preference: 'webgl'`) for the interactive editor only. One display list (editor-2d §10) is the single source for every non-interactive output**, with three backends: SVG (PDF/PNG export), DXF, and Canvas2D (CLI renders and overlays through `@napi-rs/canvas`). `drawPlan2D` is that Canvas2D backend, not a third drawing implementation. | Otherwise the plan is drawn by three independent code paths that will drift. |
| C4 | Units and axes | editor-2d and photo-to-plan: float mm, Y-down. competitors-opensource: float metres, plan `(x, y)` → 3D `(x, -z)`. electron-optimization: "integer mm, Y-up". | **Document: float64 millimetres, x right, y down.** 3D: metres, Y-up, one function `toWorld(x, y, elev) = (x/1000, elev/1000, y/1000)` in the core; nothing else converts. Asset files stay in metres (glTF). | Two of the three detailed reports already use it, PlanSpec matches image coordinates, and `(x, 0, y)` needs no mirroring. |
| C5 | Patch library | editor-2d: Immer 11.2.10. electron-optimization: mutative 2.0.2 "benchmark first, Immer is the fallback". | **Immer 11.2.10**, hidden behind `transact()`. Switch to mutative only if a profile shows it. | All history code in editor-2d is written against Immer; patch format is identical; apartment-scale documents are small. |
| C6 | Store layout | editor-2d: one vanilla store `{doc, view, selection, tool}`. electron-optimization: `documentStore` / `uiStore` / `viewportStore`, `entities: Record<Id, …>` bag. | **Three stores (electron-optimization), document shape from editor-2d** (typed maps `nodes`, `walls`, `openings`, `rooms`, …), because dirty propagation reads patch paths like `['nodes', id]`. | |
| C7 | Entity schema | Node vs Vertex; nanoid(12) vs prefixed ULID; room identity by anchor point vs by wall-id set; opening = centre offset in mm vs `u` in metres vs ratio; `Furniture{x, y, rotation, wallId?}` vs `Item{host, overrides, params}`. | **editor-2d §3.2 is canonical for geometry** (Node, Wall, Opening with centre offset in mm, `RoomRec` with anchor). **IDs: type prefix + nanoid** (`w_…`). **Replace `Furniture` with the `Item` from competitors-opensource §4** (`host {kind: floor\|wall\|ceiling\|item, id, u, v, side}`, `overrides {slot → materialId}`, `params`). **Add the missing entities**: `Material`, `Asset`, `Light`, `Camera` (bookmarks), `RenderSettings` (sun, location, exposure), per-face finish zones (see G4). | Planar auto-splitting changes wall ids, so a wall-id set is a fragile room key; the anchor survives. The editor-2d `Furniture` cannot express material overrides, parametric objects, ceiling or wall mounting, all of which requirement 3 needs. |
| C8 | Repo layout | editor-2d and photo-to-plan: pnpm monorepo `packages/plan-core`, `plan-vision`, `plan-tools`, `plan-mcp`. electron-optimization: single package. | **Single package.** `src/core` (= plan-core), `src/vision`, `tools/dp` (CLI), `tools/mcp`. Purity enforced by Biome `noRestrictedImports` and a separate tsconfig project. Skill and `.mcp.json` paths change accordingly (`tsx tools/dp/cli.ts`). | Nothing is published separately; everything is bundled; workspaces add electron-builder + pnpm hoisting risk on Windows (issue #9580). CLI-only native deps (`sharp`, `@napi-rs/canvas`) stay devDependencies and never ship. |
| C9 | Project file | `doc.json` / `project.json` / `manifest.json + scene.json`; autosave "sidecar every 60 s" vs "debounced 20–30 s to `userData/recovery`"; bakes "in the project folder" although the project is one ZIP. | **`.doplan` = ZIP { `manifest.json`, `doc.json`, `assets/<sha256>.<ext>`, `thumbs/`, optional `bake/` }.** Autosave and atomic save per electron-optimization §9. Bake cache lives in `userData/cache/bake/<hash>` and is embedded only on "save with baked lighting". | |
| C10 | Where the geometry kernel runs | electron-optimization: room detection and mitring in a Comlink worker. editor-2d: synchronously inside the transaction. | **Synchronous on the renderer main thread** for normalize / joins / faces (must be atomic with the commit; under 10 ms). Workers for 3D mesh building, exports, CV, asset decode. | |
| C11 | Asset ingest, KTX2, native code | render-3d: `@gltf-transform` in a Node worker plus a bundled `ktx` binary. open-assets: `toktx` at build time only, `sharp` at runtime. electron-optimization: no native modules. | **Build time (core pack): KTX-Software CLI and `sharp` are allowed (dev only). Runtime (user imports, on-demand downloads): no native binary and no `sharp`.** Run `@gltf-transform` with `WebIO` in a renderer Web Worker (sandboxed; textures resized and re-encoded to WebP and ARM-packed through `OffscreenCanvas`); the utility process does only download, hash, zip and file IO. Runtime KTX2 is phase 2 through a WASM encoder (`ktx2-encoder` 0.6.0, MIT, exists **[checked]**), after a spike. | Keeps the sandbox rule "never parse untrusted models in Node" and the "no native modules" rule. |
| C12 | Import formats | competitors-consumer: GLB, OBJ, FBX, USDZ. render-3d: glTF plus FBX/OBJ through three loaders. open-assets: `obj2gltf` or headless Blender. | **v1: GLB/glTF, OBJ+MTL, FBX** via three loaders → `GLTFExporter` in a worker. No USDZ, SKP, 3DS. The Quaternius pack is converted at build time by the same converter, not by Blender. | |
| C13 | Interior lighting | competitors-consumer: "PBR with SSAO/IBL". open-assets: `hotel_room` HDRI as "interior IBL". render-3d: HDRI never as the main interior light. | **render-3d D4 wins.** HDRIs are for the view through windows, probe bakes and thumbnails. | |
| C14 | Clipper | render-3d: `clipper2-js`. editor-2d: `clipper2-ts`. | **`clipper2-ts` 2.0.1-19 (BSL-1.0 [checked])**, pinned exactly and wrapped in one adapter. 3D consumes the join corners computed by the core; it never re-mitres. | `clipper2-js` 1.2.4 has had no release since 2024. |
| C15 | Node and pnpm | photo-to-plan and open-assets assume Node 23.3. electron-optimization: Node 24. | **Node 24 LTS**, pinned in `.nvmrc` and `engines`. pnpm stays on the installed 10.x, pinned through `packageManager`. | Vitest 5.1.0 engines are `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` **[checked]**; Node 23 is excluded. |
| C16 | In-app AI call vs "main stays thin" | photo-to-plan runs normalize, validate and overlay rendering in main. | Key handling and the HTTPS call stay in main; all raster work runs in a renderer worker. | |
| C17 | Thumbnails | electron-optimization: optional second renderer on an `OffscreenCanvas`. render-3d: the engine renders them. | **The engine renders thumbnails**; one GPU device. | |
| C18 | Texture budget | 1.5 GB flat vs 1 GB Low / 2.5 GB High. | Per-preset budgets from render-3d. | |

Minor: open-assets says both "about 151 models on demand" and "about 125". The manifest totals are 151 / 168 / 21; with 26 + 24 models, 37 materials and 4 HDRIs bundled, on-demand is about 101 models, 131 materials, 17 HDRIs.

Build rule that follows from C1 and C3: import three only as `three/webgpu`, `three/tsl` and `three/addons/*`, and alias bare `three` to `three/webgpu` in Vite so that addons do not pull in a second copy of the library. Use only the `three-gpu-pathtracer/webgpu` entry.

---

## 2. Requirements not covered by any report

| # | Gap | What is needed |
|---|---|---|
| G1 | **3D interaction** (render-3d covers rendering only) | Picking, selection outline, move/rotate gizmos, drag furniture in 3D with snapping to floor, walls, ceiling and other surfaces, collision hints, undo through the same `transact()`. |
| G2 | **Wall cut-away in 3D** | Auto-hide or lower walls that face the camera in orbit view, dollhouse view, first-person walk with collision, camera bookmarks. Without it an apartment cannot be edited in 3D. |
| G3 | **3D export** (listed as table stakes, designed nowhere) | GLB and OBJ through `GLTFExporter`; baked pattern textures (render-3d D8) make this straightforward. |
| G4 | **Per-face finish schema** | render-3d splits a wall face into zones (tile apron to 1.2 m, accent strip); the document has only `material: {L, R}`. Add `finish: {L: Zone[], R: Zone[]}` and define how auto-split and auto-merge of walls carry zones. |
| G5 | **Parametric kitchen and wardrobe configurator** | open-assets calls it mandatory; no report designs modules, worktops with cut-outs, plinths, handles or fronts. Needs its own design task. |
| G6 | **Ceilings** | One paragraph in render-3d. Needs a schema for stretch, multi-level, coffered and cove ceilings as sub-polygons with heights, plus downlight arrays. |
| G7 | **Balcony interior** | Only parapet walls and the balcony block exist. Needs glazing systems, parapet cladding, decking, threshold, and an exterior backdrop. |
| G8 | **Photoreal bathroom fixtures and modern appliances** | Confirmed CC0 gap: only low-poly placeholders exist. The "doplan-core Blender pack" has no owner or plan. The user must be told that the downloaded open assets cover furniture, materials and HDRIs well, but sanitary ware and appliances will be placeholders or parametric until that pack exists. The Sweet Home 3D free model library (Free Art License / CC-BY, from memory, unverified) was not evaluated and should be. |
| G9 | **Wall elevations** (развёртки стен) | Needed for tile layout and kitchens; Live Home 3D has it. |
| G10 | **Bill of materials and estimate** | Named as a differentiator, designed nowhere. Because tiles are baked textures, tile counts with waste must be computed analytically from the pattern spec and the room polygon; also paint litres, wallpaper rolls, laminate packs, skirting metres. |
| G11 | **Material editor and user textures** | Import a user photo or PBR set as a material, wallpaper from a user image, eyedropper, "apply to room / to all alike", favourites and recents. |
| G12 | **Asset import wizard and library management** | Unit and up-axis fix, pivot, mount type, slot mapping; tags, search, favourites, licence display, relink missing assets. |
| G13 | **Lights as document entities** | Symbols in 2D, IES profile, colour temperature, grouping; time-of-day control. |
| G14 | **Photo of a real room** | photo-to-plan covers images of plans only. State this limit to the user. HEIC (the iPhone default) is rejected; add a decode path in the CLI. |
| G15 | **Render outputs** | Queue over camera bookmarks, resolution presets, PNG/JPEG/EXR, 360° panorama; video later. |
| G16 | **Licence compliance** | Generated third-party licence file and a credits screen (CC-BY Khronos assets, Poly Haven credit for the live API). |

The request to use different models and thinking depth is a process instruction for the build workflow, not a product feature; no report is needed.

---

## 3. Spot-checks of risky claims

| Claim | Result |
|---|---|
| three-gpu-pathtracer 0.0.28 is WebGL-based (electron-optimization, [T]) | **Wrong.** Exports `./webgpu`; peers `three >=0.187.0`, `three-mesh-bvh >=0.9.17`, `xatlas-web`; `WebGLPathTracer` prints a deprecation warning; README: "requires WebGPU". render-3d is right. |
| three 0.187.0 ships the features render-3d relies on | **Confirmed** on jsDelivr: `lighting/LightMapper.js` (JSDoc: WebGPURenderer only), `lighting/LightProbeGrid.js`, `lighting/ClusteredLighting.js`, `tsl/display/SSGINode.js`, `TRAANode.js`, `SSRNode.js`, `utils/unwrapUVs.js`, `lights/SunLight.js`, `loaders/HDRLoader.js`; `getParallaxCorrectNormal` is exported from `TSL.js`. `IESSpotLight` is not under `examples/jsm/lights` (404); it must come from the `three/webgpu` build (not checked further). `RGBELoader` still ships; use `HDRLoader`. |
| Electron 45 facts | **Confirmed**: Chromium 156, Node 24.22, sandboxed preloads lose `Buffer`/`setImmediate`/`events`/`timers`/`url` and `require` resolves only `electron*`. `electron@45.3.1` has no `postinstall` script (41.x had `node install.js`). **Correction: the synchronous `safeStorage` methods are deprecated in 45 and removed in 46.** photo-to-plan D7 must use `encryptStringAsync` / `decryptStringAsync` (the latter resolves to `{ result, shouldReEncrypt }`) and `isAsyncEncryptionAvailable`. |
| Tooling versions and peers | **Confirmed**: vitest 5.1.0 engines exclude Node 23; typescript 7.0.2 with typescript-eslint 8.72.2 peer `<6.1.0`; pnpm latest 12.18.0; electron-vite 6.0.0 peer `vite ^6 \|\| ^7 \|\| ^8`; electron-builder latest 26.18.0; postprocessing 6.39.6 peer `three <0.188`; R3F 9.8.2 peer `react >=19 <19.4`; pixi.js 8.23.0 MIT; `@tarikjabiri/dxf` 2.10.0 MIT; immer 11.2.10; mutative 2.0.2; oidn-webgpu 0.6.0; `@pmndrs/upscaler` 0.5.0; three-mesh-bvh 0.9.18; three-bvh-csg 0.0.18. |
| Licences and API terms | **Confirmed**: clipper2-ts BSL-1.0; `@img/sharp-win32-x64` is "Apache-2.0 AND LGPL-3.0-or-later" (dev only, so no obligation in the shipped app); Khronos SheenChair is CC0-1.0; Poly Haven API is free for any purpose, needs a unique User-Agent and a visible credit when the live API is used in-app. `claude-opus-5-5` ($4 / $20 per MTok, default effort medium) and `claude-sonnet-5-5` exist; `@anthropic-ai/sdk` 1.8.0; `@modelcontextprotocol/server` 2.4.0 (Apache-2.0). |

**Still unverified; each needs a spike before code depends on it:**

1. WebGPU stability and speed on the Intel Arc iGPU. Every frame-rate and render-time figure in render-3d is an estimate. This is the day-1 spike: adapter request, a `LightProbeGrid` bake, a 64-sample path trace, forced device loss.
2. `@gltf-transform` `textureCompress` in a browser worker without `sharp` (C11 depends on it).
3. Reading back the path tracer's output target for a 4K export.
4. Which KTX-Software binary `@gltf-transform/cli` 4.5.1 calls (`ktx` or `toktx`).
5. electron-builder issue #9580 status with pnpm hoisted mode.
6. Pixi `BitmapFont` with Cyrillic ranges; `printToPDF` scale accuracy (100 mm calibration bar).
7. ambientCG, Quaternius and Kenney CC0 status and the research-model licences in photo-to-plan were not re-checked here.
8. Running Pixi (WebGL context) and three (WebGPU device) in the same renderer in split view: memory and frame pacing.

---

## 4. Competitor features that must not be forgotten

- Split 2D/3D view with live sync, shared selection, and a camera gizmo on the plan.
- Wall cut-away, dollhouse, first-person walk, camera bookmarks (G2).
- Draw-room-by-dimensions wizard, room templates, sample projects.
- Typed numeric input, auto dimension chains, room area labels, underlay tracing with calibration (all in editor-2d; keep them in milestone 1).
- Wall elevations and bill of materials (G9, G10).
- Catalogue search, favourites, recents; replace an item in place; groups, lock, hide, align and distribute, arrays; copy and paste between projects.
- Furniture snapping to walls and surfaces in both views.
- Material "apply to room / to all alike"; eyedropper.
- Light editor and time-of-day slider; render quality presets with progressive preview.
- Exports with no watermark: PNG, PDF, SVG, DXF, GLB, OBJ, rendered stills; later 360° panoramas and video.
- Multi-floor with ghost of the level below, stairs, columns, sloped ceilings (milestone 2).
- Autosave, crash recovery, local-first files, no account.
- Measure tool in 3D; north arrow and sun orientation.

---

## 5. Order of work implied by the above

1. Day-1 spike on the Arc iGPU (unverified item 1) before any 3D code is written.
2. Scaffold: Node 24, single package, electron-vite, protocols, three stores.
3. `src/core` with the unified schema (C4, C7, G4), then the Pixi editor and the display-list exports.
4. Photo-to-plan CLI and skill (phases P0 and P1) right after the core: this is the user's stated requirement. MCP bridge and the in-app API path are optional later phases.
5. 3D engine R1 to R3, then 3D interaction and cut-away (G1, G2), then finishes, ceilings, curtains and the configurators (G5 to G7).
6. Asset pipeline and core pack, High preset, path-traced stills, 3D export, bill of materials.
