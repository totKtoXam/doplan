# Photo → Plan: turning plan images into doplan plans

Research date: 2026-11-12. Scope: how Claude Code (vision LLM agent with shell access) and, optionally, the app itself turn a **photo / scan / PDF / screenshot of a floor plan** (developer brochure, BTI/БТИ technical-inventory plan, hand sketch) into an editable doplan plan.

Versions and facts below were checked today against npm, the vendors' pages or a local install on the dev machine (Windows 11, Node 23.3.0), unless marked *estimate* or *unverified*.

---

## 0. Decisions (TL;DR)

| # | Decision |
|---|---|
| D1 | **No pretrained raster-vectorisation model ships with doplan.** None of the strong open models can be used commercially, and none runs in Node without a rewrite. CubiCasa5k data is CC BY-NC 4.0, Raster2Seq weights are CC BY-NC 4.0, Raster-to-Graph is GPL-3.0 on restricted LIFULL data, RoomFormer takes point-cloud density maps, and FloorplanTransformation is Torch7 on LIFULL data. All of them need custom CUDA ops and Python. Russian BTI and brochure plans are also out of their training distribution. |
| D2 | **The vision LLM handles meaning; deterministic code handles geometry.** The LLM (Claude in Claude Code, or the API from inside the app) reads labels, room names, dimension strings, door and window positions and the topology. It writes a compact **PlanSpec** JSON file. A pure-TS **compiler** turns that file into the wall graph: it snaps to orthogonal, rounds to 10 mm, infers walls from the gaps between rooms and resolves junctions. A **validator** and a **render/overlay/diff** loop let the agent correct itself. |
| D3 | **Light CV assist in pure TypeScript, without OpenCV.** We write a ~400-line axis-aligned "wall-band extractor": Otsu binarisation, opening by run lengths, rectangle extraction and a thickness histogram. It also covers deskew (projection profile) and perspective unwarp (4-point homography). It works on raw grey buffers, so the same code runs in the CLI and in an app worker. It produces *candidates* that the LLM accepts or rejects; it never decides on its own. OpenCV.js (`@techstark/opencv-js` 5.0.0-release.1, 13.3 MB single JS file, has `HoughLinesP`, **no LSD**; verified locally) is not bundled. We can revisit it only for non-Manhattan plans. |
| D4 | **Agent tooling is a CLI first, `pnpm dp …`** (TS run with `tsx` 4.23.15, as devDependencies only). It covers image prep, labelled coordinate grids, zoom crops in global coordinates, calibration, normalisation, validation, compile, render and overlay/diff. Each command prints one JSON object to stdout and writes images to files that fit Claude's high-resolution tier. |
| D5 | **Ship a project skill `.claude/skills/photo-to-plan/`.** It holds a SKILL.md with the procedure, plus reference files (PlanSpec reference, how to read BTI, brochure and sketch plans) and examples. The user drops images into `inbox/`, because images pasted into Claude Code are often **not** on disk for tools ([issue reports](https://claudeissues.com/issue/39572-pasted-images-visible-to-vision-but-not-saveable-to-filesystem)). |
| D6 | **MCP server: yes, but as phase 2.** It is a stdio bridge built on `@modelcontextprotocol/server` **2.4.0** (the v2 stable line; v1 `@modelcontextprotocol/sdk` 1.32.2 is in maintenance). It talks to the running app over a named pipe. It exposes five tools: status, get plan, apply spec, validate, and capture 2D/3D view. The CLI and skill alone cover the photo-to-plan path. MCP adds "drive the live app and look at the 3D result". |
| D7 | **In-app path for users without Claude Code: a user-supplied Anthropic API key**, stored with Electron `safeStorage` and used only in the main process. The call is `@anthropic-ai/sdk` 1.8.0 `messages.parse` with `zodOutputFormat(PlanSpec)` on `claude-opus-5-5`, effort `high`. The main process runs the same normalise, validate and overlay steps, then makes one refinement round. The user lands in an **Import review** screen with the source image as an underlay. Manual underlay tracing with 2-point calibration is always available and costs nothing. |
| D8 | **Image libraries for the CLI: `sharp` 0.35.5 plus `@napi-rs/canvas` 1.1.1.** Both use prebuilt N-API binaries with no install scripts (no pnpm-10 build approval needed). Both installed and ran **in the same process** on this machine. Inside the app: **no native image dependencies.** Electron's `nativeImage` plus `OffscreenCanvas`/`createImageBitmap` in a worker are enough. `jimp` (1.6.1) and `pureimage` (0.4.20) are rejected as primaries: they are slow, render text poorly and do not handle EXIF orientation well. PDF goes through `pdfjs-dist` 6.5.438, which already depends on `@napi-rs/canvas`. |

---

## 1. Inputs and what makes each one hard

| Input | Typical features | Main difficulty | Primary signal |
|---|---|---|---|
| **Developer brochure** (планировка ЖК, PNG/JPG/PDF) | Clean vector-like render. Solid black or grey walls. Furniture and fixtures drawn. Room areas in m² (e.g. "17,94"). Sometimes overall dimensions in mm. Compass, balcony hatching. | Furniture clutter. **Often not to scale** (marketing). Walls drawn as thick fill or as hollow double lines. | Room areas and printed dimensions, more than pixels. |
| **BTI / техплан** (scan or photo of paper) | Black-and-white line art. Hatched or filled walls (load-bearing thicker). Rooms numbered in circles; areas in the room or in an экспликация table. Interior dimensions in metres ("3,25"). Scale 1:100 or 1:200. Stamps and handwritten edits. | Scan noise, skew, faint lines. Numbers must be cross-referenced with the table. Old plans have non-orthogonal drafting errors. | Dimensions in metres plus the area table. Geometry is reliable. |
| **Hand sketch** | Rough topology. Dimensions written by the user. Lines not straight, not to scale. | Pixels are **meaningless for scale**. Dimensions conflict. | Only the written dimensions and the topology. |
| **Phone photo of any of the above** | Perspective, curvature, shadows, glare, EXIF rotation, sometimes HEIC. | Must be unwarped before any pixel geometry is trusted. | Same as the underlying plan, after unwarp. |
| **Screenshot from a website or CAD viewer** | Clean, often to scale, sometimes with a scale bar. | Low resolution, UI chrome around the plan. | Pixels plus scale bar or dimensions. |

The rule follows from this table and should be written into the skill: **printed dimensions beat labelled areas, and labelled areas beat pixel measurements.** Pixels supply topology, relative placement and anything that has no printed value.

---

## 2. State of the art: what exists and why we don't embed it

### 2.1 Research models

| Method | Input | Code licence | Weights / data licence | Runtime needs | Verdict for doplan |
|---|---|---|---|---|---|
| **Raster2Seq** (Phung & Averbuch-Elor, SIGGRAPH 2026, [arXiv 2602.09016](https://arxiv.org/abs/2602.09016)) | Raster floor-plan image → labelled polygon sequences (rooms, doors, windows) | MIT ([repo](https://github.com/Cornell-VAILab/Raster2Seq)) | **Weights CC BY-NC 4.0**. The README says commercial use, "including inference in a commercial SaaS product", is not authorised. HF: `haopt/Raster2Seq` | PyTorch 2.3.1 + CUDA 11.8. Custom deformable-attention and differentiable-rasterisation CUDA ops. ~0.5 s per image on an A6000. | Current SOTA (CubiCasa5K room F1 88.7, Raster2Graph 97.0). **Not usable**: NC weights, CUDA ops make ONNX export impractical, out of domain for RU plans. Good reading for ideas only (polygon-sequence output is close to our PlanSpec). |
| **FloorplanVLM** ([arXiv 2602.06507](https://arxiv.org/abs/2602.06507), Feb 2026) | Image → structured JSON via a fine-tuned VLM (SFT + GRPO) | No code or weights release found | Only the FPBench-2K benchmark is said to be open | Large VLM | Confirms the **"pixels → JSON sequence"** approach we take with Claude. Not usable directly. |
| **RoomFormer** (CVPR 2023, [repo](https://github.com/ywyue/RoomFormer)) | **Point-cloud density maps**, not drawings | MIT | Checkpoints downloadable | Deformable-attention CUDA ops | Wrong input modality. Not usable. |
| **Raster-to-Graph** ([repo](https://github.com/SizheHu/Raster-to-Graph), CGF 2024) | 512×512 centred floor-plan JPG (LIFULL style) | **GPL-3.0** | LIFULL HOME'S images are restricted (apply via NII); the authors cannot share them | Deformable-attention CUDA ops | GPL plus restricted data. Not usable. |
| **CubiCasa5k** ([repo](https://github.com/CubiCasa/CubiCasa5k)) | Raster plans (Finnish), multi-task segmentation | **CC BY-NC 4.0** (repo LICENSE) | Dataset and weights in the same NC context | PyTorch 1.0 era | NC. Any model trained on CubiCasa5k inherits the problem. Not usable. |
| **FloorplanTransformation** (Liu et al. 2017, [repo](https://github.com/art-programmer/FloorplanTransformation)) | Raster plan → junctions → integer programming → vector | MIT | Weights on Google Drive; trained on restricted LIFULL data | Torch7 (Lua). Experimental PyTorch port. IP solver. | Historically important (junction + IP idea). Obsolete stack. Not usable. |

### 2.2 Commercial / hosted

| Service | What it does | Fit |
|---|---|---|
| **Planner 5D floor-plan recognition API** ([page](https://tool.planner5d.com/b2b-floor-plan-recognition), [API ref](https://planner5d.com/reference/public-api)) | REST: submit JPG/PNG/PDF/DWG/DXF, poll, receive a Planner 5D project. Needs a PRO/commercial account; pricing by sales scoping. | It returns *their* project format, adds vendor lock-in and sends user plans to a third party. Not for doplan. |
| **RoomSketcher AI Convert** ([page](https://www.roomsketcher.com/features/ai-convert/)) plus a human redraw service (~USD 38 per floor for free users) | Image → editable plan inside RoomSketcher | UX benchmark only. The human-in-the-loop fallback shows that pure AI is not yet reliable. |
| **RasterScan** ([HF Space](https://huggingface.co/spaces/RasterScan/Automated-Floor-Plan-Digitalization), [Docker](https://hub.docker.com/r/rasterscan/floor-plan-recognition)) | Docker API, "lifetime licence" via machine activation | Proprietary, licence terms unpublished. Not for doplan. |
| **magicplan** ([help](https://help.magicplan.app/import-and-digitalize-an-existing-floor-plan)) | Import an image and **trace manually** | Shows that "underlay + calibrate + trace" is the industry baseline. We must have it anyway. |

### 2.3 How good are general VLMs at this?

No public benchmark scores frontier VLMs on **wall-level** vectorisation. The closest is **AECV-Bench** (Jan 2026; [summary](https://www.emergentmind.com/topics/aecv-bench)). Its finding: frontier models are good at drawing QA (Gemini 3 Pro 0.854, GPT-5.2 0.792, Claude 4.5 0.719) but weak at **counting line-art symbols** (Gemini 3 Pro window-count exact-match 0.34). Anthropic's own docs say Claude's coordinates are "approximate" and recommend explicit pixel coordinates, pre-resizing, and cropping for fine targets ([vision-coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)).

Design consequences:

1. Never ask the model for normalised coordinates. Ask for **absolute pixels** and give it **labelled grids**, so it reads numbers instead of estimating positions.
2. Give it **zoomed crops** for doors and windows, and an **overlay/diff** to find what it missed. Opening recall is the weak spot, so the validator checks every room for a door and every living room and kitchen for a window.
3. Make the model's job **semantic and topological**, and let the compiler make the geometry exact.

### 2.4 Decision on CV assist

| Option | Size / cost | Gain | Decision |
|---|---|---|---|
| None (LLM only) | 0 | Baseline. Works for clean brochures. | Always available. |
| **Pure-TS wall-band extractor + deskew + unwarp** | ~0 KB of dependencies, ~400–600 LOC, O(N) | Exact wall **positions and thicknesses** in pixels for orthogonal walls (90%+ of RU apartments). The LLM picks candidates by id. | **Adopt (phase 2).** |
| OpenCV.js (`@techstark/opencv-js` 5.0.0-release.1, Apache-2.0) | 13.3 MB JS with embedded wasm, ~200 ms init in Node (measured) | Hough, contours, morphology, distanceTransform. `createLineSegmentDetector` is **absent** in the official build (verified). | Don't bundle. Maybe later, CLI-only, for diagonal walls. |
| ONNX segmentation model (onnxruntime-node/web 1.31.1) | 20–100 MB model plus runtime | Only with a permissively licensed model trained on legal data. **No such model exists today.** We would have to train our own on self-made RU data. | Out of scope. Revisit if a permissive model appears. |

---

## 3. Architecture

```
inbox/plan.jpg ──► dp img prep ──► .doplan-work/<slug>/src.png (+prep.json: crop/rotate/unwarp log)
                         │
        ┌────────────────┼──────────────────────────┐
        ▼                ▼                          ▼
   dp img grid      dp img zoom/tiles          dp cv walls (optional)
   (labelled px)    (global px labels)         (candidate wall bands c1..cN)
        └──────────► Claude reads images ◄──────────┘
                         │ writes
                         ▼
                spec.px.json  (PlanSpec, units:"px")  ── dp calibrate (dim | area)
                         │ dp spec normalize  (px→mm, ortho snap, 10 mm grid)
                         ▼
                   spec.json (units:"mm")
                         │ dp check = validate + render + overlay/diff
                         ▼
         validate.json + overlay-NN.png + diff-NN.png + wallIoU
                         │  (loop ≤ 4×: zoom on red boxes, fix spec)
                         ▼
             dp spec compile ──► plan.doplan ──► dp open (running app, single-instance)
                                                    │ (phase 2) MCP: view_capture 3D for a sanity look
```

**Packages** (monorepo, pnpm workspaces):

- `packages/plan-core`: **pure TS, no Node or DOM APIs.** Shared by the renderer, the main process, the CLI and the MCP server. It contains:
  - the zod PlanSpec schema (the single source of truth), plus `z.toJSONSchema()` export
  - `normalize`, `compile` (PlanSpec → doc entities from `editor-2d.md` §3.2), `decompile` (doc → PlanSpec in walls-mode), `validate`
  - geometry helpers: polygon area, point-in-polygon, segment projection
  - `drawPlan2D(ctx: Canvas2DLike, doc, view)`: the **same** drawing code used for the CLI renders and the app's exports. `@napi-rs/canvas` implements the Canvas2D API, so the CLI renders look exactly like the app.
- `packages/plan-vision`: pure TS raster algorithms on `{width, height, data: Uint8Array}`: Otsu, run-length morphology, wall-band extraction, skew estimate, homography warp, mask diff/IoU, `resizedSize()` (the Claude image-fit helper copied from Anthropic docs).
- `packages/plan-tools`: the CLI (`dp`). Node adapters for IO: `sharp` for decode, EXIF, resize, rotate and encode; `@napi-rs/canvas` for drawing grids, labels and overlays; `pdfjs-dist` for PDFs. Only devDependencies, **never in the shipped app**.
- `packages/plan-mcp` (phase 2): stdio MCP server bridging to the app.
- App side: `src/main/ai/planRecognition.ts` (API path), `src/renderer/import/` (import wizard, underlay calibration, review screen). Image IO there uses `nativeImage` and `OffscreenCanvas`.

---

## 4. PlanSpec v1

### 4.1 Principles

- **Human- and LLM-writable.** It is short, uses room names as printed, and allows rooms as plain rectangles.
- **Two authoring modes, which can be mixed:**
  - **rooms-mode**: rooms are given as *clear interior* rectangles or polygons. These are exactly what plans label: areas and internal dimensions. The compiler infers walls from the **gaps** between rooms (gap width = wall thickness), and puts exterior walls outside unmatched edges.
  - **walls-mode**: wall centre-line polylines with thickness. These are more precise and are produced by CV candidates or by `decompile`. Rooms are then given only by a label point `at`, and their geometry comes from faces of the wall graph.
  - If `walls` is present, it is authoritative, and room rects/polygons are used only for matching and validation.
- **Coordinates: x → right, y → down** (the image convention, and the same Y-down convention as the doplan model in `editor-2d.md`). Units are `"mm"` (canonical) or `"px"` (the first draft read straight off the image; `normalize` converts it).
- **All px values refer to the prepped image `source.image`** (after crop, deskew and unwarp), never the original photo.
- **Openings are placed by `at`** (centre point on or near the wall; the compiler projects it onto the nearest wall), **or** by `wall` + `offset` (distance from the wall path start to the opening centre). `between` records which rooms a door connects, so the validator can check it.
- Uncertainty is explicit: optional `confidence` per item, and a top-level `notes[]` list of things the human should confirm.
- **Structured-output friendly** for the in-app API path: no recursion, no tuples (points are `number[]` with length checked by the validator), no `min`/`max` constraints in the schema (the SDK strips them anyway). Range checks live in `validate`.

### 4.2 Schema (zod 4.6.7, source of truth in `plan-core/src/planspec.ts`)

```ts
import { z } from "zod";

/** [x, y]. Length 2 is enforced by validate(), not the schema (structured-output limits). */
const Pt = z.array(z.number()).describe("[x, y]; x to the right, y DOWN; units per spec.units");

export const WallKind = z.enum([
  "exterior", "loadBearing", "partition", "parapet", "railing", "glass", "separator",
]); // separator = zero-thickness room divider (open-plan kitchen/living), not built in 3D

export const RoomType = z.enum([
  "living", "bedroom", "kids", "study", "kitchen", "kitchenLiving", "dining",
  "hall", "corridor", "bathroom", "toilet", "combinedBathroom", "laundry",
  "wardrobe", "storage", "balcony", "loggia", "terrace", "utility", "other",
]);

export const OpeningType = z.enum([
  "door", "doubleDoor", "slidingDoor", "pocketDoor", "foldingDoor", "entranceDoor",
  "balconyDoor", "balconyBlock", "arch", "passage", "window", "panoramicWindow",
]);

export const FixtureType = z.enum([
  "column", "riser", "ventShaft", "chimney",            // structural → compiled to solid blocks
  "radiator", "bathtub", "shower", "toilet", "washbasin", "kitchenSink",
  "stove", "fridge", "washer", "boiler", "electricPanel",
]);

const WallSpec = z.object({
  id: z.string(),
  path: z.array(Pt).describe(">= 2 points; polyline of wall CENTRE-LINE unless align says otherwise"),
  closed: z.boolean().optional(),
  align: z.enum(["center", "inner", "outer"]).optional()
    .describe("inner/outer only for closed paths: path is the inner/outer FACE of the loop"),
  thickness: z.number().optional().describe("mm; default from defaults by kind"),
  kind: WallKind.optional(),
  height: z.number().optional().describe("mm; parapet/railing ~1000-1100"),
  confidence: z.number().optional(),
});

const RoomSpec = z.object({
  id: z.string().describe("short slug, referenced by openings: 'kitchen', 'bed1'"),
  name: z.string().describe("as printed on the plan, e.g. 'Кухня-гостиная'"),
  type: RoomType,
  number: z.string().optional().describe("BTI/brochure room number, e.g. '3'"),
  rect: z.array(z.number()).optional().describe("[x, y, w, h] CLEAR interior rectangle"),
  polygon: z.array(Pt).optional().describe("clear interior outline (any winding)"),
  at: Pt.optional().describe("label point inside the room (walls-mode)"),
  labelledArea: z.number().optional().describe("m2 as printed (17,94 -> 17.94)"),
  ceilingHeight: z.number().optional(),
  edgeWall: z.object({
    kind: WallKind, thickness: z.number().optional(), height: z.number().optional(),
  }).optional().describe("wall for room edges NOT facing another room (balcony railing, glazed loggia)"),
  confidence: z.number().optional(),
});

const OpeningSpec = z.object({
  id: z.string().optional(),
  type: OpeningType,
  at: Pt.optional().describe("centre of the opening on the wall"),
  wall: z.string().optional(),
  offset: z.number().optional().describe("from wall path start to opening CENTRE, along the wall"),
  width: z.number().describe("clear width in spec units"),
  height: z.number().optional(),
  sill: z.number().optional().describe("windows: floor to sill"),
  between: z.array(z.string()).optional().describe("[roomId, roomId|'outside']"),
  opensInto: z.string().optional().describe("roomId or 'outside' (swing side)"),
  hinge: z.enum(["left", "right"]).optional()
    .describe("hinge side seen from the room the door opens INTO, facing the door"),
  confidence: z.number().optional(),
});

const FixtureSpec = z.object({
  type: FixtureType,
  rect: z.array(z.number()).optional().describe("[x, y, w, h]"),
  at: Pt.optional(),
  rotation: z.number().optional().describe("degrees, clockwise (Y-down)"),
});

const Calib = z.object({ p1: Pt, p2: Pt, mm: z.number(), label: z.string().optional() });

export const PlanSpec = z.object({
  version: z.literal(1),
  units: z.enum(["mm", "px"]),
  name: z.string().optional(),
  source: z.object({
    image: z.string().describe("prepped image the px coordinates refer to"),
    size: z.array(z.number()).describe("[w, h] px of source.image"),
    kind: z.enum(["brochure", "bti", "sketch", "photo", "screenshot", "cad", "other"]),
    mmPerPx: z.number().optional(),
    mmPerPxY: z.number().optional().describe("only if anisotropic after unwarp"),
    originPx: Pt.optional().describe("px position of mm (0,0); default [0,0]"),
    calibration: z.array(Calib).optional(),
    labelledTotalArea: z.number().optional(),
    labelledLivingArea: z.number().optional(),
    toScale: z.boolean().optional().describe("false for sketches / marketing plans"),
  }).optional(),
  defaults: z.object({
    ceilingHeight: z.number().optional(),        // 2700
    exteriorThickness: z.number().optional(),    // 300 (panel/monolith) – brick 510/640
    loadBearingThickness: z.number().optional(), // 200
    partitionThickness: z.number().optional(),   // 100
    doorHeight: z.number().optional(),           // 2100
    windowSill: z.number().optional(),           // 850
    windowHeight: z.number().optional(),         // 1500
  }).optional(),
  snap: z.object({
    orthogonal: z.boolean().optional(),          // true
    orthoToleranceDeg: z.number().optional(),    // 3
    angleStepDeg: z.number().optional(),         // 45 for non-ortho edges beyond tolerance
    gridMm: z.number().optional(),               // 10
    mergeMm: z.number().optional(),              // default max(thickness)/2 + 50
  }).optional(),
  walls: z.array(WallSpec).optional(),
  rooms: z.array(RoomSpec),
  openings: z.array(OpeningSpec),
  fixtures: z.array(FixtureSpec).optional(),
  notes: z.array(z.string()).optional().describe("uncertainties for the human to confirm"),
});
export type PlanSpec = z.infer<typeof PlanSpec>;
```

`dp spec schema` prints `z.toJSONSchema(PlanSpec)`, so the agent can read the canonical form once.

### 4.3 Example A: two-room apartment with balcony, rooms-mode (mm)

The layout is a 56 m² "двушка". The entrance side is at the top. Bathroom and wardrobe are on the left, then the hall, then the kitchen with a window in the end wall. A 200 mm load-bearing wall runs across. Below it are the bedroom and the living room (200 mm load-bearing wall between them), with façade windows. The balcony is in front of the living room.

```json
{
  "version": 1,
  "units": "mm",
  "name": "ЖК Пример, корп. 3, кв. 41 — 2-комн. 57,4 м²",
  "source": {
    "image": ".doplan-work/kv41/src.png", "size": [1652, 2212], "kind": "brochure",
    "mmPerPx": 6.0, "originPx": [160, 150],
    "labelledTotalArea": 57.4, "labelledLivingArea": 33.1
  },
  "defaults": { "ceilingHeight": 2700, "exteriorThickness": 300, "loadBearingThickness": 200, "partitionThickness": 100 },
  "snap": { "orthogonal": true, "gridMm": 10 },
  "rooms": [
    { "id": "bath",    "name": "С/у",       "type": "combinedBathroom", "rect": [0, 0, 1700, 2200],     "labelledArea": 3.7 },
    { "id": "ward",    "name": "Гардероб",  "type": "wardrobe",         "rect": [0, 2300, 1700, 900],   "labelledArea": 1.5 },
    { "id": "hall",    "name": "Прихожая",  "type": "hall",             "rect": [1800, 0, 3000, 3200],  "labelledArea": 9.6 },
    { "id": "kitchen", "name": "Кухня",     "type": "kitchen",          "rect": [4900, 0, 2500, 3200],  "labelledArea": 8.0 },
    { "id": "bed",     "name": "Спальня",   "type": "bedroom",          "rect": [0, 3400, 3300, 4600],  "labelledArea": 15.2 },
    { "id": "living",  "name": "Гостиная",  "type": "living",           "rect": [3500, 3400, 3900, 4600], "labelledArea": 17.9 },
    { "id": "balc",    "name": "Балкон",    "type": "balcony",          "rect": [3500, 8300, 3900, 1200], "labelledArea": 4.7,
      "edgeWall": { "kind": "railing", "thickness": 100, "height": 1100 } }
  ],
  "openings": [
    { "id": "d-entr", "type": "entranceDoor", "at": [3050, -150], "width": 900, "between": ["hall", "outside"], "opensInto": "outside", "hinge": "left" },
    { "id": "d-bath", "type": "door",         "at": [1750, 1000], "width": 700, "between": ["bath", "hall"],    "opensInto": "hall",    "hinge": "right" },
    { "id": "d-ward", "type": "slidingDoor",  "at": [1750, 2750], "width": 700, "between": ["ward", "hall"] },
    { "id": "d-kit",  "type": "door",         "at": [4850, 2400], "width": 800, "between": ["hall", "kitchen"], "opensInto": "kitchen", "hinge": "left" },
    { "id": "d-bed",  "type": "door",         "at": [2500, 3300], "width": 800, "between": ["hall", "bed"],     "opensInto": "bed",     "hinge": "right" },
    { "id": "d-liv",  "type": "door",         "at": [4100, 3300], "width": 800, "between": ["hall", "living"],  "opensInto": "living",  "hinge": "left" },
    { "id": "d-balc", "type": "balconyDoor",  "at": [4300, 8150], "width": 800, "between": ["living", "balc"],  "opensInto": "living",  "hinge": "left" },
    { "id": "w-kit",  "type": "window", "at": [7550, 1600], "width": 1200, "sill": 850, "height": 1500 },
    { "id": "w-bed",  "type": "window", "at": [1650, 8150], "width": 1500, "sill": 850, "height": 1500 },
    { "id": "w-liv",  "type": "window", "at": [5800, 8150], "width": 1800, "sill": 850, "height": 1500 }
  ],
  "fixtures": [
    { "type": "riser",   "rect": [1450, 1950, 250, 250] },
    { "type": "bathtub", "rect": [0, 0, 1700, 700] },
    { "type": "toilet",  "at": [300, 1500], "rotation": 90 },
    { "type": "stove",   "rect": [6800, 300, 600, 600] }
  ],
  "notes": [
    "Толщина наружной стены не подписана — принято 300 мм по пропорции к перегородкам",
    "Ширина входной двери оценена по чертежу (≈900 мм)"
  ]
}
```

What the compiler infers here (gap → wall):

- Gaps between bath, ward and hall are 100 → partitions. Hall/kitchen is 100 → partition.
- The top band to the bottom band is 200, and bed/living is 200 → load-bearing.
- Living/balcony is 300. One side is an outdoor room type, so the wall is **exterior**, and the balcony door and window are placed on it.
- Unmatched edges get exterior walls of 300 placed outside. The balcony's unmatched edges get a 100 mm railing, 1100 high.
- Collinear exterior pieces separated by a partition end (gap ≤ that partition's thickness) are bridged into one wall.

Area check: computed areas are 3.74, 1.53, 9.60, 8.00, 15.18, 17.94 (sum 55.99 m²). With the balcony at 4.68 × 0.3 = 1.40, the total is **57.39 ≈ 57.4** ✓. Living area 33.12 ≈ 33.1 ✓.

### 4.4 Example B: the same apartment in walls-mode

This is what `decompile` produces, or what the agent writes after accepting CV candidates.

```json
{
  "version": 1, "units": "mm",
  "defaults": { "ceilingHeight": 2700 },
  "walls": [
    { "id": "ext",  "kind": "exterior",    "path": [[0,0],[7400,0],[7400,8000],[0,8000]], "closed": true, "align": "inner", "thickness": 300 },
    { "id": "lb1",  "kind": "loadBearing", "path": [[0,3300],[7400,3300]], "thickness": 200 },
    { "id": "lb2",  "kind": "loadBearing", "path": [[3400,3300],[3400,8000]], "thickness": 200 },
    { "id": "p1",   "kind": "partition",   "path": [[1750,0],[1750,3200]], "thickness": 100 },
    { "id": "p2",   "kind": "partition",   "path": [[0,2250],[1700,2250]], "thickness": 100 },
    { "id": "p3",   "kind": "partition",   "path": [[4850,0],[4850,3200]], "thickness": 100 },
    { "id": "rail", "kind": "railing",     "path": [[3450,8300],[3450,9550],[7450,9550],[7450,8300]], "thickness": 100, "height": 1100 }
  ],
  "rooms": [
    { "id": "bath",    "name": "С/у",      "type": "combinedBathroom", "at": [850, 1100],  "labelledArea": 3.7 },
    { "id": "ward",    "name": "Гардероб", "type": "wardrobe",         "at": [850, 2750],  "labelledArea": 1.5 },
    { "id": "hall",    "name": "Прихожая", "type": "hall",             "at": [3300, 1600], "labelledArea": 9.6 },
    { "id": "kitchen", "name": "Кухня",    "type": "kitchen",          "at": [6150, 1600], "labelledArea": 8.0 },
    { "id": "bed",     "name": "Спальня",  "type": "bedroom",          "at": [1650, 5700], "labelledArea": 15.2 },
    { "id": "living",  "name": "Гостиная", "type": "living",           "at": [5450, 5700], "labelledArea": 17.9 },
    { "id": "balc",    "name": "Балкон",   "type": "balcony",          "at": [5450, 8900], "labelledArea": 4.7 }
  ],
  "openings": [
    { "type": "door", "wall": "p3", "offset": 2400, "width": 800, "between": ["hall", "kitchen"], "opensInto": "kitchen", "hinge": "left" }
  ]
}
```

(Openings are shortened in this example. `wall`+`offset` and `at` can be mixed.) Wall ends such as `p1` starting at the exterior *face* `y=0` are within `mergeMm` of the exterior centre-line (`y=-150`), so the compiler extends them into a proper T-junction. The agent does not have to compute centre-line intersections.

### 4.5 Example C: first draft in px

```json
{ "version": 1, "units": "px",
  "source": { "image": ".doplan-work/kv41/src.png", "size": [1652, 2212], "kind": "brochure",
              "calibration": [ { "p1": [160, 1478], "p2": [710, 1478], "mm": 3300, "label": "спальня по ширине" } ] },
  "rooms": [ { "id": "kitchen", "name": "Кухня", "type": "kitchen", "rect": [977, 150, 417, 533], "labelledArea": 8.0 } ],
  "openings": [] }
```

`dp spec normalize` computes `mmPerPx` from the calibration (or from labelled areas if there are no dimensions). It then converts, snaps and writes `units:"mm"`. All edits after that are made in mm.

### 4.6 Compiler (`plan-core/compile.ts`): deterministic steps

1. **Normalise.** px → mm with `(p − originPx) · mmPerPx`. Snap edges within `orthoToleranceDeg` to 0° or 90°, and other edges to `angleStepDeg`. Round to `gridMm`. Snap wall thicknesses within ±15 mm to the standard set {80, 100, 120, 150, 160, 180, 200, 250, 300, 380, 400, 510, 640}.
2. **Walls.** If `walls[]` is present, expand polylines and closed loops (`align` inner/outer → offset by t/2) into segments. In rooms-mode:
   - For every pair of anti-parallel room edges (A, B) at distance `0 < d ≤ 700` mm with overlapping projections, emit a wall over the overlap. The centre-line is the mid-line and the thickness is `d`. The kind is `exterior` if either room is balcony, loggia or terrace; otherwise `loadBearing` if d ≥ 160, else `partition`.
   - Edge parts with no partner get `room.edgeWall`, or an exterior wall offset outward by t/2.
   - `d < 40` → `TINY_GAP` warning, and the compiler inserts a `separator`.
3. **Bridge and merge.** Collinear segments of the same kind and thickness whose gap ≤ max(thickness of a wall ending in the gap, `mergeMm`) are joined. Endpoints within `mergeMm` of another centre-line are extended or trimmed to it (T/L joins).
4. **Hand over to the editor's `normalize()`** (planar graph, split at T-touches, merge nodes < 1 mm). The compiler emits `Node`/`Wall`, and the editor's invariant does the rest. This avoids two implementations of the same rules.
5. **Openings.** Project `at` onto the nearest wall centre-line within max(t, 300 mm). Compute `offset`. Map `opensInto`/`hinge` to the doc's `hinge: 'start'|'end'` and `swing: 'L'|'R'` using the wall direction. Set the default `height` and `sill` by type.
6. **Rooms.** Detect faces (editor algorithm). Match each face to a RoomSpec by `at`, or by the centroid of its `rect`/`polygon`, and emit a `RoomRec` with `anchor`, `name` and `type`. Faces with no match become `type:"other"` and produce a warning.
7. **Fixtures.** Structural types become solid blocks (wall-kind obstacles). The rest become `Furniture` with generic `assetId`s from the default asset pack.
8. **Underlay.** If `source` is present, create an `Underlay` with transform `scale = mmPerPx` and `tx/ty = −originPx·mmPerPx`. The user sees the plan over the original image straight away.

---

## 5. Validator (`dp spec validate`, same code as the in-app check)

Output: `{ ok, errors:[{code, msg, ids, bbox?}], warnings:[…], metrics:{ totalArea, livingArea, perRoom:[{id, computed, labelled, delta, pct}], wallIoU? } }`. The `bbox` is in **source px** when `source` is set, so the agent can `dp img zoom` straight onto the problem.

| Code | Level | Rule |
|---|---|---|
| `SCHEMA` | error | zod parse failure, a point that is not length 2, negative sizes |
| `ROOM_OPEN` | error | room polygon not closed or self-intersecting; walls-mode label point not inside any face |
| `ROOM_OVERLAP` | error | two room interiors overlap by more than 0.05 m² |
| `AREA_MISMATCH` | warn > max(0.15 m², 2 %); error > max(0.4 m², 5 %) | computed vs `labelledArea` |
| `TOTAL_AREA_MISMATCH` | warn/error, same thresholds | Σ rooms (balcony ×0.3, loggia ×0.5, terrace ×0.3; coefficients configurable) vs `labelledTotalArea`; living area vs `labelledLivingArea` |
| `SCALE_INCONSISTENT` | warn | calibration references disagree by more than 2 %, or the area fit disagrees with the dimension calibration by more than 3 % (typical of not-to-scale marketing plans) |
| `OPENING_OFF_WALL` | error | `at` more than max(t, 300) from any wall, or `wall`/`offset` outside the wall |
| `OPENING_OVERLAP` / `OPENING_NEAR_CORNER` | error / warn | openings overlap on the same wall; an edge closer than 50 mm to a junction face |
| `DOOR_BETWEEN_MISMATCH` | error | rooms on the two sides of the wall at the door ≠ `between` |
| `ROOM_UNREACHABLE` | error | room-adjacency graph through doors and passages: every room except shafts must be reachable from the room with the `entranceDoor` |
| `NO_WINDOW` | warn | living, bedroom, kids or kitchen room without a window or balcony door (catches missed windows, the known VLM weak spot) |
| `WALL_THICKNESS_ODD` | warn | thickness outside 60–700 mm, or interior walls thicker than the exterior |
| `DIMENSION_PRIOR` | info | interior door width outside 600–1000, entrance door outside 800–1100, ceiling outside 2400–3500 |
| `DANGLING_WALL` / `DUPLICATE_WALL` | warn | a wall end that touches nothing (except railings and parapets), or overlapping collinear walls |
| `NON_ORTHO` | info | an edge kept at a non-orthogonal angle |

---

## 6. CLI `dp` (agent and developer tool)

Run it as `pnpm dp <group> <cmd> …` (root script `"dp": "tsx packages/plan-tools/src/cli.ts"`; Node 23.3 on this machine predates unflagged type-stripping, so we use `tsx`). Parse arguments with `citty` 0.2.2 or `commander` 15.1.0.

**Conventions**

- Stdout is **one JSON object**. Images are written to files and their paths appear in the JSON. `--human` gives readable output. Non-zero exit on errors.
- The working directory is `.doplan-work/<slug>/` (gitignored). File names are numbered for iterations (`overlay-02.png`).
- **Every output image is pre-sized for Claude's high-resolution tier** (Claude 4.7+: long edge ≤ 2576 px **and** ⌈w/28⌉·⌈h/28⌉ ≤ 4784 visual tokens; standard tier is 1568/1568). Use `resizedSize()` from the [vision-coordinates guide](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), so the image the model sees is the image on disk and pixel coordinates map 1:1. A 4:3 plan comes out at about 2212×1652 (≈ 4.7 k tokens ≈ $0.019 at Opus 5.5 input pricing). The JSON always reports `size` and `tokens`.
- **Grid labels show global `src.png` px**, including on zooms and tiles. Even if a client downsamples an image, the agent reads coordinates from the printed numbers rather than inferring them from pixel position. This is the main accuracy measure.

| Command | Arguments | Output |
|---|---|---|
| `dp img info <file>` | | `{size, format, exifOrientation, dpi, pages?, fitsHi, tokensHi}` |
| `dp img paste` | `[--out inbox/]` | Saves the Windows clipboard image to a file (PowerShell `[Windows.Forms.Clipboard]::GetImage()`). Covers pasted screenshots. |
| `dp img prep <file>` | `--slug <name>` `[--page N] [--dpi 200]` `[--crop auto\|x,y,w,h]` `[--deskew auto\|<deg>\|off]` `[--unwarp x1,y1,…,x4,y4 [--aspect W:H]]` `[--enhance]` `[--fit hi\|std]` | `src.png` plus `prep.json` (ordered transforms original→src and their inverse). `auto` crop takes the ink bbox plus a margin. `auto` deskew uses the projection-profile max over ±5° in 0.1° steps. `--enhance` does a CLAHE-like contrast stretch and background flattening for photos. Small images are upscaled ×2 (Lanczos) to ≥ 1600 px long edge. PDF pages go through pdfjs-dist. HEIC is rejected with a "convert to JPEG" message (sharp prebuilds have no HEVC). |
| `dp img grid <file>` | `[--step 50] [--major 250] [--out]` | Copy with a thin grid, major lines labelled with px values on all four margins (labels in an added margin; coordinates remain `src.png` px). |
| `dp img zoom <file>` | `--rect x,y,w,h [--scale auto\|N] [--step 10]` | Crop upscaled to fit the tier, with a fine grid labelled in **global** px. This is the workhorse for doors, windows, dimension text and wall faces. |
| `dp img tiles <file>` | `--grid 2x2 [--overlap 0.12] [--step 50]` | N tiles with global-px grids, for dense BTI sheets. |
| `dp img mark <file>` | `--points "x,y;x,y" [--labels a,b] [--rects …]` | Draws numbered markers. It is a cheap check of "is this really the corner I think it is?". |
| `dp calibrate dim` | `--ref x1,y1,x2,y2,mm` (repeatable) `[--spec f]` | `{mmPerPx, mmPerPxY?, residualsPct[]}`; writes into `spec.source` when `--spec` is given |
| `dp calibrate area <spec.px.json>` | | Least-squares `s` from `labelledArea_i ≈ s²·pxArea_i`: `s = sqrt(Σ A_i·P_i / Σ P_i²)`. Reports per-room residuals; outliers usually mean a misread polygon. |
| `dp cv walls <src.png>` | `[--min-thick px] [--max-thick px] [--style auto\|solid\|outline\|hatched]` | `cv-walls.json` (candidates `c1..cN`: centre-line, thickness px, orientation, score), `cv-walls.png` (coloured by thickness cluster, ids drawn), thickness histogram (hints at exterior, load-bearing and partition clusters, which gives a scale sanity check) |
| `dp spec schema` | | JSON Schema of PlanSpec |
| `dp spec init <src.png>` | `--kind bti\|brochure\|sketch\|… [--out spec.px.json]` | Skeleton with `source` filled in |
| `dp spec normalize <in>` | `[--out spec.json] [--grid 10] [--ortho-tol 3]` | Converts px→mm, snaps and rounds; writes the mm spec plus a diff summary |
| `dp spec validate <spec>` | `[--strict]` | Validator report (§5) |
| `dp spec compile <spec>` | `[--out plan.doplan] [--into existing.doplan --level <id>]` | doplan document |
| `dp spec decompile <plan.doplan>` | `[--out spec.json]` | Walls-mode PlanSpec. Used for round-trips and for the MCP `plan_get`. |
| `dp render <spec\|plan>` | `[--px-per-m 100] [--labels] [--dims] [--areas] [--out]` | Clean 2D render through `plan-core/drawPlan2D` plus `@napi-rs/canvas` (bundled OFL Cyrillic font registered via `GlobalFonts`) |
| `dp overlay <spec>` | `[--mode outline\|diff\|both] [--rect x,y,w,h] [--out]` | **outline**: compiled walls (translucent), openings and room labels with computed areas, drawn over `src.png` in source px. **diff**: source wall mask (from `cv` or a thick-ink mask) XOR rendered wall mask; green = match, red = in source but missing in the plan, blue = in the plan but not in the source. Output `{wallIoU, missing:[bbox px], extra:[bbox px]}`. |
| `dp check <spec>` | `[--iter N]` | normalize + validate + compile + overlay(both) in one call, so the loop costs one round-trip and returns everything above |
| `dp open <plan\|spec>` | | Sends the file to the running app (single-instance `second-instance` event or the MCP bridge pipe), or launches `pnpm dev`/the installed app |

**Algorithms in `plan-vision` (pure TS)**

- *Otsu* on a grey histogram. For photos, first divide by a large-radius blurred background (flat-field) to remove shadows.
- *Thick-ink mask = opening with a k×k square.* Implemented separably with run lengths (erode = runs ≥ k shrunk by k/2; dilate symmetric). O(N), ~20–40 ms on 4 MP (*estimate*). It removes text, dimension lines, furniture strokes and hatching lines, which are all thinner than walls. `k` comes from `--min-thick` or from 0.4 × the mode of the vertical-run histogram.
- *Outline-style walls* (two thin parallel lines): first close with k = expected thickness to fill the band, then open. Detect this style by ink fill ratio inside candidate bands, and report `style` and lower `score`.
- *Bands → candidates.* Find connected components of the thick mask, then decompose each component into maximal axis-aligned rectangles (sweep over row runs). A rectangle with aspect ≥ 2 becomes a wall candidate (centre-line plus thickness). Also report junction blocks.
- *Deskew.* Variance of horizontal and vertical projection profiles of the binarised image over angles. Pick the argmax.
- *Unwarp.* Solve the 8-DOF homography from 4 corner points (Gaussian elimination, 8×8), inverse-map with bilinear sampling. Output size comes from `--aspect` or from the mean edge lengths. Calibrating with both a horizontal and a vertical dimension catches residual anisotropy (`mmPerPxY`).
- *Diff/IoU.* Rasterise compiled wall polygons into source px through the inverse `source` transform, then compare with the thick-ink mask. Report bboxes of connected components of XOR larger than (2·thickness)².

---

## 7. Image libraries (CLI side)

Facts verified on this machine (npm + local install + a smoke test that loads `sharp`, `@napi-rs/canvas` and OpenCV.js in one Node process).

| Library | Version | Licence | Native? | Windows install | Verdict |
|---|---|---|---|---|---|
| **sharp** | 0.35.5 | Apache-2.0; prebuilt `@img/sharp-win32-x64` is Apache-2.0 AND LGPL-3.0-or-later (libvips, dynamically linked) | N-API prebuilt (≈20 MB) | Prebuilt via optionalDependencies, **no install script** (`npm view sharp scripts.install` is empty), so no pnpm-10 build approval needed | **Use it** for decode, EXIF auto-orient (`.rotate()`), Lanczos resize, rotate by any angle, crop, raw buffers and PNG encode. No HEIC (HEVC). |
| **@napi-rs/canvas** | 1.1.1 | MIT | N-API Skia prebuilt (≈38 MB incl. win32-x64-msvc) | Prebuilt, no scripts | **Use it** for Canvas2D drawing: grids, labels with Cyrillic font, overlays, `drawPlan2D` renders. It also backs `pdfjs-dist` (which depends on `@napi-rs/canvas ^1.0.13`). sharp's docs warn about a Windows conflict with the *Automattic* `canvas`, not this one. Both coexisted fine in the test. |
| pdfjs-dist | 6.5.438 | Apache-2.0 | no | | PDF pages → raster at the chosen DPI (BTI PDFs are common) |
| @techstark/opencv-js | 5.0.0-release.1 | Apache-2.0 | wasm in a 13.3 MB JS file | trivial | Not adopted (§2.4). `HoughLinesP` yes, LSD no. |
| jimp | 1.6.1 | MIT | pure JS (~11 MB installed) | trivial | Rejected: ~10× slower, no decent text rendering |
| pureimage | 0.4.20 | MIT | pure JS | trivial | Rejected: slow, limited text; last-resort fallback only |
| exifr | 7.1.3 | MIT | pure JS | | Only if sharp is dropped |

**In the shipped app** no native image dependency is needed:

- `nativeImage.createFromPath()` / `.resize({quality:'best'})` / `.crop()` / `.toBitmap()` in main.
- `createImageBitmap` + `OffscreenCanvas` in a renderer worker for rotation, unwarp output and overlays.
- pdf.js renders PDFs in the renderer.

`plan-vision` runs in that worker unchanged. If sharp is ever needed in main, `asarUnpack` `**/node_modules/{sharp,@img}/**/*` (from the sharp install docs).

---

## 8. Claude Code project skill

### 8.1 How skills work (current docs, [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills))

- Location: `.claude/skills/<name>/SKILL.md`. Commit it, and it is active for anyone opening the repo in Claude Code.
- YAML frontmatter must start on line 1. Useful fields:
  - `name` (becomes `/name`), `description` (with `when_to_use`, **truncated at 1,536 chars** in the listing, so put triggers first)
  - `argument-hint`, `arguments`
  - `allowed-tools` (no permission prompt during the turn), `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context: fork`
- Progressive disclosure: only the description sits in context. The body loads when invoked. Keep SKILL.md under 500 lines and link sibling files that are read on demand. Scripts are referenced with `${CLAUDE_SKILL_DIR}`. After compaction, the first 5 k tokens of an invoked skill are re-attached.
- Invocation: automatic when the description matches, or `/photo-to-plan inbox/kv41.jpg` (`$ARGUMENTS`).

### 8.2 Layout

```
.claude/skills/photo-to-plan/
  SKILL.md                 procedure (below), ≤ 200 lines
  planspec.md              field-by-field reference + compile rules (from §4)
  reading-plans.md         BTI / brochure / sketch / photo specifics, RU abbreviations, priors
  examples/2room-rooms.json, examples/2room-walls.json, examples/bti-px-draft.json
inbox/                     user drops images here (gitignored)
.doplan-work/              per-plan working dirs (gitignored)
```

The scripts stay in `packages/plan-tools`, not in the skill, so the app, CI and the skill share one code path.

### 8.3 SKILL.md draft

```markdown
---
name: photo-to-plan
description: Build a doplan floor plan from a photo, scan, PDF or screenshot of a plan (developer brochure, BTI/БТИ техплан, hand sketch). Use when the user sends or points to a планировка image and wants it drawn/imported in doplan ("нарисуй планировку по фото", "перенеси план БТИ", "import this floor plan").
argument-hint: [image-path]
allowed-tools: Bash(pnpm dp *) Read Write Edit
---

# Photo → doplan plan

Goal: a PlanSpec (`.doplan-work/<slug>/spec.json`) that passes `pnpm dp check` with no errors, then `pnpm dp open`.
Read [planspec.md](planspec.md) once per session, and [reading-plans.md](reading-plans.md) for the plan kind at hand.

## 0. Get the file
- Image path = $ARGUMENTS, or the newest file in `inbox/`. If the user only pasted an image into chat,
  run `pnpm dp img paste` (it saves the clipboard image), or ask them to drop the file into `inbox/`.
  Tools need a file on disk.
## 1. Prepare
- `pnpm dp img info <file>` → `pnpm dp img prep <file> --slug <slug>` (add `--page N` for PDF).
- Phone photo with perspective: Read src.png, find the 4 sheet/plan corners on `dp img grid`, re-run prep with `--unwarp`.
- Read `src.png` and `grid.png`. Identify: plan kind, which unit dimensions are in (mm vs m), the area table, scale bar, entrance, façade side.
## 2. Read text before geometry
- Zoom (`dp img zoom --rect …`) on every room label, area and dimension string. Write down: room name, number, area, dimensions.
- BTI: match circled room numbers to the экспликация table. Brochure: areas like "17,94" are m².
## 3. Calibrate
- Pick 2–3 long printed dimensions (one horizontal, one vertical): `pnpm dp calibrate dim --ref x1,y1,x2,y2,mm …`.
- No dimensions: draft rooms first, then `pnpm dp calibrate area spec.px.json`.
- Sketch (`toScale:false`): ignore pixels for size. Build coordinates in mm from the written dimensions (cumulative sums).
## 4. Draft
- Optional: `pnpm dp cv walls src.png` → look at cv-walls.png. Use candidate ids that match real walls.
- Write `spec.px.json` in **rooms-mode** (clear interior rectangles read off the grid labels; px).
  Use walls-mode only for irregular shapes or when CV candidates are good.
- Add every door/window with `at` at its centre (zoom to each!), `width`, `between`, `opensInto`, `hinge`.
- Unsure? Add `confidence` < 0.7 and a line in `notes`, and don't guess silently.
## 5. Normalize, check, iterate (max 4 rounds)
- `pnpm dp spec normalize spec.px.json --out spec.json`, then `pnpm dp check spec.json`.
- Fix all errors. For each warning, either fix it or justify it in `notes`.
- Read overlay-NN.png and diff-NN.png. For each red/blue bbox: `dp img zoom` there, then fix.
- Stop when: 0 errors, every labelled area within tolerance, wallIoU ≥ 0.85 (to-scale plans), no NO_WINDOW you can't explain.
## 6. Deliver
- `pnpm dp spec compile spec.json --out plan.doplan` → `pnpm dp open plan.doplan`.
- Report to the user (in Russian): rooms with computed vs labelled areas, assumptions (`notes`), what to verify by eye.

## Rules
- Pixel coordinates only from grid labels or zoom labels (global px). Never estimate normalized coordinates.
- Printed dimensions > labelled areas > measured pixels. Marketing plans can be out of scale; trust numbers.
- Orthogonal unless clearly angled. Round to 10 mm. Typical thicknesses: partitions 80–120, load-bearing 160–250,
  exterior 300 (monolith/panel) or 380/510/640 (brick). Doors: 600–700 bath/WC, 800 rooms, 860–960 entrance.
- Never edit spec.json by regex. Rewrite the JSON (it is small).
```

### 8.4 `reading-plans.md` content (bullets the implementer should include)

- **RU abbreviations:**
  - room types: С/у, Ванн., Туал., Кух., Кух.-гост., Прих./Хол, Кор., Гард./Кл. (кладовая), Ж.к./Жил., Лодж., Балк.
  - fixtures and structure: в/ш (вентшахта), ст. (стояк)
  - dimension notes: "h=2,70" = ceiling height
  - BTI: "Ж" living / "П" auxiliary in the table; "общ./жил./подсобн." area columns
- **BTI:** walls are hatched or filled. Load-bearing walls are often thicker or double-hatched. Dimensions inside rooms are in metres with a comma. Doors are drawn as a gap with a thin arc, or just a gap. Windows are three thin parallel lines in the wall. Area excludes balconies; the loggia is listed separately, sometimes with ×0.5.
- **Brochure:** furniture hides walls, so use the CV thick-ink mask. Balcony/loggia area may be included at ×0.3/×0.5 in "общая". Bathrooms show fixtures (useful for `fixtures`). Plans are not always to scale; check `SCALE_INCONSISTENT`.
- **Sketch:** dimensions are law. If they conflict (the sum of parts ≠ the whole), keep the total and note it.
- **Photos:** unwarp first. Glare hides thin lines, so zoom with `--enhance`.

---

## 9. MCP server: worthwhile, phase 2

**Why.** The CLI covers file-to-file conversion. MCP adds three things:

1. **live state**: the agent edits the plan the user has open, so the conversation continues while the user watches;
2. **visual verification of the app's own 2D and 3D renders** (`view_capture`), which catches compile bugs the CLI render shares;
3. a reusable automation surface for later features (furnishing, materials, by-voice edits).

It is a small addition because every tool calls `plan-core` functions.

**Design**

- SDK: `@modelcontextprotocol/server` **2.4.0** (v2 stable line, implements the 2026-07-28 spec, `zod ^4.2` matches our zod 4.6.7). v1 `@modelcontextprotocol/sdk` 1.32.2 gets fixes for at least six months after the v2 release (2026-07-27). Start new work on v2. ([repo](https://github.com/modelcontextprotocol/typescript-sdk))
- **Transport: stdio bridge**, not an HTTP server inside the app. Claude Code launches `node packages/plan-mcp/dist/server.mjs`. The bridge connects to the running app over a **Windows named pipe** `\\.\pipe\doplan-control-<user>`. The pipe speaks newline-delimited JSON-RPC and is authenticated with a random token the app writes to `%APPDATA%/doplan/control.json` at startup.
  - If the app is not running, the file-only tools (`spec_validate`, `spec_render`) still work headless. The live tools return "doplan is not running; start it with `pnpm dev`".
  - The control endpoint sits behind a setting, "Allow local agent control": **on in dev builds, off by default in release**.
- `.mcp.json` (project scope; Claude Code asks for approval once, [docs](https://code.claude.com/docs/en/mcp)):

```json
{ "mcpServers": { "doplan": { "command": "node", "args": ["packages/plan-mcp/dist/server.mjs"] } } }
```

- **Tools (keep the surface small):**

| Tool | Input | Output |
|---|---|---|
| `doplan_status` | – | `{running, document, levels, dirty}` |
| `plan_get` | `{format: "planspec" \| "summary"}` | Decompiled walls-mode PlanSpec (mm), or rooms with areas |
| `plan_apply_spec` | `{spec, mode: "replace" \| "mergeLevel", underlay?: path}` | Validator report. The change is one undoable transaction. |
| `spec_validate` | `{spec}` | Validator report (works without the app) |
| `view_capture` | `{view: "2d" \| "3d", preset?: "top" \| "iso" \| "room:<id>", width?: number}` | **image** content (`{type:"image", data, mimeType:"image/png"}`) sized to the tier |

Image results stay under Claude Code's MCP output warning threshold (10 k tokens) because a tier-sized PNG is ≈4.8 k visual tokens.

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "doplan", version: "0.1.0" });
server.registerTool("view_capture",
  { description: "Capture the current doplan 2D or 3D view as PNG",
    inputSchema: z.object({ view: z.enum(["2d", "3d"]), width: z.number().optional() }) },
  async ({ view, width }) => {
    const png: Buffer = await bridge.call("capture", { view, width });   // named-pipe JSON-RPC to the app
    return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  });
await server.connect(new StdioServerTransport());
```

---

## 10. In-app path: users without Claude Code

**UX: an Import wizard** (File → Import plan image…, plus drag-and-drop, plus Ctrl+V of a clipboard image):

1. **Source:** image or PDF page picker. HEIC → message "export as JPEG".
2. **Straighten:** auto-deskew preview; optional 4-corner perspective handles; crop.
3. **Scale** (optional when using AI): draw a line over a dimension and type its mm value.
4. **Choose: "Recognise with AI"** (only if an API key is set) **or "Trace manually"**. Manual tracing puts the underlay in the editor at 40 % opacity, calibrated and locked. This is the baseline every competitor offers, and it is always free.
5. **Review screen:**
   - overlay of the result on the source;
   - room table: labelled vs computed area with ✓/⚠;
   - list of `notes` and low-confidence items, each clickable to zoom;
   - buttons "Fix and re-check" (one more AI round with the user's comment) and "Accept".
6. On accept, the plan is created and the underlay is kept (toggle in the Layers panel).

**Settings → AI:**

- API key field. Stored with `safeStorage.encryptString` (DPAPI on Windows) in `userData`, and **only main** decrypts it. The renderer calls `ipc.invoke('ai:recognizePlan', {imageId, hints})`.
- Model dropdown: default `claude-opus-5-5`; `claude-sonnet-5-5` as the cheaper option.
- "Test key" button.
- A clear note that the image is sent to Anthropic.

**Request** (main process, `@anthropic-ai/sdk` 1.8.0):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PlanSpec } from "@doplan/plan-core";

const client = new Anthropic({ apiKey: getDecryptedKey() });
const res = await client.messages.parse({
  model: settings.ai.model ?? "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: "high", format: zodOutputFormat(PlanSpec) },
  system: PLAN_EXTRACTION_SYSTEM,   // condensed SKILL.md rules + planspec.md + reading-plans.md (stable → cacheable)
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: srcB64 },
      transformations: { oversized_image: "error" } },          // we pre-size with resizedSize(); fail loudly on drift
    { type: "image", source: { type: "base64", media_type: "image/png", data: gridB64 } },
    { type: "text", text: `Plan kind hint: ${hints.kind}. Calibration: ${JSON.stringify(calib)}.
CV wall candidates (px): ${cvSummary}. Return PlanSpec with units "px" for image ${w}x${h}.` },
  ]}],
});
if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens" || !res.parsed_output) { /* surface to UI, offer manual trace */ }
```

Then, in main, using the same code as the CLI:

- `normalize` → `validate` → render the overlay.
- **One refinement call**: send the overlay and diff images plus the validator JSON plus the previous spec, and ask for a corrected full spec.
- Then go to the review screen.

Notes:

- Opus 5.5 thinking is adaptive by default and cannot be disabled. Effort is the control knob; its default on this model is `medium`, so set `high` explicitly.
- Prefill is not allowed. Structured outputs guarantee the JSON shape. `parsed_output` is validated client-side; the length-2 points and ranges are checked by our validator.
- Refusal fallback: per Anthropic guidance, enable server-side fallbacks (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). Check that `messages.parse` accepts these in SDK 1.8.0 (it may need `client.beta.messages`). If not, handle `stop_reason === "refusal"` by retrying on `claude-sonnet-5-5`.
- Put the long, stable system prompt first so prompt caching applies on the refinement call.
- Cost (*estimate*): input ≈ 2 images × ≤4.8 k + ≈4 k prompt ≈ 14 k tokens ($0.06 at $4/MTok). Output including thinking ≈ 8–20 k tokens ($0.16–0.40 at $20/MTok). That is **≈ $0.25–0.5 per pass, ≈ $0.5–1 per import** with one refinement. Show the estimate in the UI.

---

## 11. Accuracy playbook (goes into the skill and the in-app system prompt)

1. **Coordinates from labels, not estimation.** Use grid and zoom images with printed global px. Absolute pixel coordinates only (Anthropic guidance). No 0–1000 normalised coordinates.
2. **Pre-size every image** to the model tier with `resizedSize()`. The image on disk is then the image the model sees. Mark API images with `oversized_image: "error"`.
3. **Read text first, geometry second.** Room names, areas and dimensions go into a table before any coordinates are written. Most errors come from misreading "3,25" (m) as px or mm.
4. **Rooms-mode first.** A clear interior rectangle per room is easy for the model and exactly what plans label. The compiler gets wall thickness from gaps. Switch to walls-mode only for irregular geometry.
5. **Orthogonal, 10 mm grid, standard thicknesses.** Snapping removes most of the model's ±1–2 % coordinate noise. Keep diagonals only when clearly drawn, and snap them to 45°.
6. **Calibrate with ≥ 2 long dimensions in both axes.** Check against labelled areas (least squares). Disagreement over 3 % means the plan is not to scale: use the numbers, not the pixels.
7. **Zoom on every opening.** Door arcs and window triple-lines are small. Visual counting of line-art symbols is a known VLM weakness (AECV-Bench). The `NO_WINDOW` and `ROOM_UNREACHABLE` checks catch most misses.
8. **Self-check with overlay/diff,** not by re-reading the original. The red and blue bboxes tell the agent exactly where to zoom.
9. **Priors as sanity checks, not defaults:**
   - ceiling 2.5–3.0 m
   - partitions 80–120 mm, load-bearing 160–250 mm, exterior 300+ mm
   - doors: WC/bath 600–700, rooms 800, entrance 860–960
   - window sill 800–900
   - balcony depth 900–1500; loggia ×0.5 and balcony ×0.3 in the total
10. **Make uncertainty explicit** in `notes` and `confidence`, and show it to the user. Don't fabricate unseen dimensions.
11. **Stop after 4 iterations** and hand over to the user with the open questions. Diminishing returns are real, and every image read costs ~1.3–4.8 k tokens.

---

## 12. Phasing, effort, risks

| Phase | Scope | Effort (*estimate*) |
|---|---|---|
| P0 (with the 2D editor) | `plan-core`: PlanSpec schema, normalize, compile, decompile, validate (golden-fixture tests incl. §4.3/4.4). Underlay import plus 2-point calibration in the editor. | 4–6 days |
| P1 | `plan-tools` CLI (img info/prep/grid/zoom/tiles/mark/paste, calibrate, spec *, render, overlay outline, check, open). Skill `photo-to-plan` plus reference files. `inbox/` and `.doplan-work/` gitignored. | 4–5 days |
| P2 | `plan-vision`: thick-ink mask, wall candidates, deskew, unwarp, diff/IoU. `dp cv walls`, overlay diff. | 4 days |
| P3 | MCP bridge (named-pipe control endpoint in the app plus `plan-mcp`). `view_capture` for 2D/3D. | 3 days |
| P4 | In-app AI import (settings, safeStorage, main-process call, refinement, review screen) | 4–5 days |

**Evaluation corpus.** Build 20–30 real plans: brochures, BTI scans, phone photos, sketches. Each gets a hand-made ground-truth PlanSpec.

- Metrics: wall IoU, per-room area error, opening recall/precision, iterations used.
- Run the corpus after any prompt, skill or compiler change.
- **Do not commit third-party brochures to a public repo.** Keep them in a private fixtures directory.

**Risks**

- Hollow (double-line) walls and heavy furniture defeat the CV assist. Mitigation: the LLM stays primary, and the `style` detection lowers candidate scores.
- Marketing plans are out of scale. Mitigation: area and dimension consistency checks; numbers win.
- Non-Manhattan and curved walls. Mitigation: 45° snap, `polygon` rooms, walls-mode; arcs are deferred.
- Pasted images are not on disk. Mitigation: `dp img paste` and `inbox/`.
- MCP pipe security. Mitigation: per-launch token, user-only pipe, disabled by default in release.
- API cost and privacy. Mitigation: opt-in, a cost estimate in the UI, and the manual trace path.

---

## Sources

- Raster2Seq: [arXiv 2602.09016](https://arxiv.org/abs/2602.09016), [project](https://cornell-vailab.github.io/Raster2Seq/), [GitHub (licences)](https://github.com/Cornell-VAILab/Raster2Seq)
- FloorplanVLM: [arXiv 2602.06507](https://arxiv.org/abs/2602.06507)
- CubiCasa5k: [GitHub](https://github.com/CubiCasa/CubiCasa5k), [LICENSE (CC BY-NC 4.0)](https://raw.githubusercontent.com/CubiCasa/CubiCasa5k/master/LICENSE)
- RoomFormer: [GitHub](https://github.com/ywyue/RoomFormer)
- Raster-to-Graph: [GitHub](https://github.com/SizheHu/Raster-to-Graph)
- FloorplanTransformation: [GitHub](https://github.com/art-programmer/FloorplanTransformation)
- RasterScan: [HF Space](https://huggingface.co/spaces/RasterScan/Automated-Floor-Plan-Digitalization), [Docker Hub](https://hub.docker.com/r/rasterscan/floor-plan-recognition)
- Planner 5D recognition: [B2B page](https://tool.planner5d.com/b2b-floor-plan-recognition), [public API docs](https://planner5d.com/reference/public-api)
- RoomSketcher: [AI Convert](https://www.roomsketcher.com/features/ai-convert/), [Order floor plans](https://help.roomsketcher.com/hc/en-us/articles/202273701)
- magicplan: [Import and digitalize](https://help.magicplan.app/import-and-digitalize-an-existing-floor-plan)
- AECV-Bench: [summary](https://www.emergentmind.com/topics/aecv-bench), [arXiv 2601.04819](https://arxiv.org/abs/2601.04819v1)
- Claude vision: [Vision (limits, tiers, tokens)](https://platform.claude.com/docs/en/build-with-claude/vision), [Coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)
- Claude Code: [Skills](https://code.claude.com/docs/en/skills), [MCP](https://code.claude.com/docs/en/mcp), pasted-image path issues: [#39572](https://claudeissues.com/issue/39572-pasted-images-visible-to-vision-but-not-saveable-to-filesystem), [#57623](https://claudeissues.com/issue/57623-bug-pasted-dropped-images-no-longer-expose-a-filesystem-path-claude-can-only-see)
- MCP TypeScript SDK: [GitHub](https://github.com/modelcontextprotocol/typescript-sdk); npm: `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/sdk` 1.32.2 (published 2026-10-23)
- sharp: [installation (Electron, Windows, pnpm)](https://sharp.pixelplumbing.com/install)
- npm versions checked 2026-11-12: sharp 0.35.5, @napi-rs/canvas 1.1.1, jimp 1.6.1, pureimage 0.4.20, @techstark/opencv-js 5.0.0-release.1, onnxruntime-node/web 1.31.1, pdfjs-dist 6.5.438, @anthropic-ai/sdk 1.8.0, zod 4.6.7, tsx 4.23.15, citty 0.2.2, commander 15.1.0, exifr 7.1.3, image-js 1.7.1
