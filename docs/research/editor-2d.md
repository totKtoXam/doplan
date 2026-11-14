# doplan — 2D Plan Editor Engine: Design Research & Decisions

Status: decision record (research, 2026-11-12). Scope: the 2D floor-plan editor (rendering, data model, geometry kernel, interaction, export). The 3D conversion, asset pipeline and photo→plan AI are covered by other reports; interfaces to them are noted where relevant.

All npm versions/licences below were read from the npm registry on 2026-11-12 (`npm view <pkg> version license time`).

---

## 0. TL;DR decisions

| Area | Decision |
|---|---|
| Renderer | **PixiJS 8.23.0 (MIT), WebGL backend** (`preference: 'webgl'`, WebGPU as opt-in flag), imperative scene driven from the store; render-on-demand. No `@pixi/react`, no `pixi-viewport` — own camera (~150 LOC). |
| Hit-testing | Own, in world coords via **rbush 4.0.1 (MIT)**; Pixi `eventMode = 'none'` everywhere except the canvas root. |
| Coordinates | Model in **millimetres, float64, Y-down** (same as screen/SVG); 3D mapping `(x, y) → three (x, 0, y)`; DXF export flips Y. |
| Data model | Normalized wall graph: `Node` + `Wall(a,b, thickness, justification, height(s), arc?, materials per side)` + `Opening(wallId, offset, width, …)` + derived `Room` (identity kept by anchor point). |
| Planar invariant | Graph is kept planar on every commit (auto-split at crossings & T-touches, merge nodes < 1 mm). All downstream algorithms rely on this. |
| Wall joins | N-way angular-sort miter (algorithm §3) producing per-wall quads + per-node "hub" polygon that tile exactly; miter limit 4× on reflex corners, step/bevel for collinear different thickness. |
| Rooms | Half-edge face traversal on the centerline graph (§4), hole assignment by containment, inner room ring built from wall-side corner points → exact finished-face area. **Clipper2** (`clipper2-ts` 2.0.1-19, BSL-1.0) for union/difference/offset. |
| Curved walls | **In the data model from v1** (`arc: {sagitta}`), UI tool in milestone 2. Joins use end tangents + offset-circle intersection. |
| Undo/redo | Immer 11.2.10 `produceWithPatches` transactions, coalescing; derived geometry never in history; drag = preview doc, single commit on pointer-up. |
| Export | One renderer-independent **display list → backends**: SVG (own builder), PDF via **Electron `webContents.printToPDF`** of the SVG sheet (vector, Cyrillic fonts for free), PNG via SVG→OffscreenCanvas at DPI, DXF via **@tarikjabiri/dxf 2.10.0 (MIT)**. jsPDF 4.2.1 + svg2pdf.js 2.9.0 only as fallback. |
| Tracing | Background image/PDF page per level, 2-point scale calibration + rotation, optional 4-point perspective rectification. |

---

## 1. Analogs (what to copy, what to avoid)

| Product | 2D tech | Notes relevant to us |
|---|---|---|
| Sweet Home 3D (GPL, Java2D) | Retained Java2D painting | Walls carry `wallAtStart/wallAtEnd` references → joins are **pairwise only**; T-junctions are not mitered (overlap). Has arc walls (`arcExtent`), rooms as separate user-drawn/auto-detected polygons, per-side wall materials, background image calibration with 2 points + length. Good feature checklist; join model is the thing to beat. |
| react-planner (MIT, React + SVG) | SVG DOM | Model "lines / vertices / holes / areas": holes (openings) parametrised along a line — same idea as ours. SVG + React re-render becomes sluggish with many elements; no proper miters. |
| blueprint3d (MIT, Canvas2D + three.js) | Canvas2D immediate | Corners + walls graph, rooms from graph cycles, 2D→3D extrusion. Simple, aged; proves the pipeline. |
| Arcada (React + PixiJS + Zustand) | PixiJS | Closest stack to ours; validates Pixi + Zustand for a floor planner. |
| Planner 5D / Floorplanner / RoomSketcher / Archilogic (commercial) | WebGL/Canvas | UX benchmarks: draw-by-room rectangles, live dimensions while drawing, typed lengths, auto exterior dimension chains, room area labels, symbol libraries, multi-floor with ghosted level below, photo/plan tracing. |
| AutoCAD / ArchiCAD / Revit | native | Snapping model to copy: object snaps + "object tracking" alignment guides + polar angle; typed relative input; associative dimensions; 3-row exterior dimension chains (also GOST 21.501 practice). |

Take-aways: (1) N-way joins and exact inner-face room areas are a real differentiator vs open-source floor planners; (2) the snapping/typed-input UX of CAD is what makes drawing a real apartment fast; (3) never bind the scene to a DOM/React tree.

---

## 2. Rendering technology

### 2.1 Options evaluated

| Option | Pan/zoom cost with 5k walls | Editing cost | Text | Verdict |
|---|---|---|---|---|
| **Canvas2D (custom)** | Full redraw of all paths every frame (Path2D cached). OK to ~5k simple polygons on discrete GPU; hatch patterns + strokes + labels on Intel iGPU drop below 60 fps. | Trivial | Excellent (native) | Viable fallback, but no headroom. |
| **PixiJS v8 (WebGL)** — `pixi.js@8.23.0`, MIT | Geometry tessellated once into GPU buffers; pan/zoom = one uniform change. | Re-tessellate only dirty entities. | `Text` (canvas-rasterized) / `BitmapText` (dynamic bitmap fonts incl. Cyrillic). | **Chosen.** |
| Konva 10.9.1 (MIT) | Canvas2D scene graph; redraws whole layer + maintains a hit canvas (≈2× draw cost). | Convenient (drag, transformer) | Native | Rejected: hit-graph overhead, known slow beyond a few thousand shapes; we want our own hit-testing anyway. |
| Fabric 7.4.0 (MIT) | Canvas2D object model, same issues as Konva | Strong object editing UI | Native | Rejected (designed for graphic editing, not CAD graphs). |
| SVG DOM | Browser re-rasterizes on zoom; 10k+ nodes → style/layout cost, GC churn | Easy hit-testing | Excellent | Rejected for the editor; **used for export**. |
| three.js orthographic | GPU retained like Pixi | Thick lines need `Line2`, text needs troika/SDF, 2D picking awkward | Weak | Rejected: shares an engine with 3D but 2D CAD primitives (dashes, hatches, pixel lines, text) are much more work. |

### 2.2 Why Pixi v8 specifically
- Retained, batched GPU geometry; v8 `Graphics` builds a `GraphicsContext` that can be shared/re-used (door symbol context shared by all doors of the same type).
- `stroke({ pixelLine: true })` gives exact 1-px hairlines independent of zoom (grid, selection outlines, guides, snapping glyphs) without re-tessellation.
- Texture/pattern fills (`FillPattern`) for hatches; `cullable` + Culler for furniture sprites.
- Both WebGL and WebGPU renderers; default to WebGL on the Intel Arc iGPU (most mature driver path in Chromium/ANGLE-D3D11), expose a settings toggle for WebGPU.
- Context-loss resilience: the whole scene is derived from the store, so on `webglcontextlost` we can destroy and rebuild display objects.

### 2.3 Scene structure (all imperative)

```
app.stage
 ├─ world            (Container; camera transform: position + uniform scale; Y-down, no flips)
 │   ├─ underlay     Sprite per background image (current level), ghost of level below (alpha .25)
 │   ├─ grid         Graphics (visible lines only, pixelLine, rebuilt on camera change, ≤ 400 lines)
 │   ├─ roomFills    Graphics per room (fill colour/pattern by room type)
 │   ├─ wallFills    Graphics per wall + per hub (fill/hatch by wall category)
 │   ├─ wallOutline  Graphics per level: Clipper union outline of all wall polys (stroke, world width)
 │   ├─ openings     Graphics per opening (shared GraphicsContext per opening type + transform)
 │   ├─ furniture    Sprite (top-view render of the 3D asset, generated at import) + outline Graphics
 │   └─ annotations  dimension lines, leaders (Graphics)
 └─ screen           (Container; identity transform = CSS px × devicePixelRatio)
     ├─ labels       BitmapText: dimension values, room name/area (repositioned on camera change)
     ├─ guides       snap/alignment guides, angle arcs (pixelLine)
     └─ handles      selection handles, rubber band, cursor glyph
```

Rules:
- `app.ticker` stopped; `requestRender()` schedules one `rAF → app.render()` when anything is dirty. Idle CPU/GPU ≈ 0 (laptop battery, Electron "optimized").
- One display object per entity, keyed by entity id; rebuild only when the entity's derived geometry version changes.
- Labels in screen space so text is always crisp and never mirrored/scaled; `BitmapFont.install` with ranges `[' ','~'], ['А','я'], 'ЁёІі²³°×±⌀'`, resolution = devicePixelRatio.
- Camera: zoom-to-cursor on wheel; `ctrlKey + wheel` = precision trackpad pinch on Windows; middle-drag / space-drag pan; zoom range 1 px = 0.05 mm … 1 px = 500 mm.
- Pointer: `pointerdown/move/up` on the canvas, `setPointerCapture`; snapping evaluated once per rAF (latest pointer position), not per event.
- Heavy work (face detection > 10k walls, exports, image rectification, DXF) in a Web Worker (Vite `?worker`); geometry kernel is pure TS with no DOM so it runs in both.

### 2.4 Performance budget (Intel Arc iGPU, 4k display, 5 000 walls, 300 openings, 500 furniture items)
| Operation | Budget |
|---|---|
| Pan/zoom frame | < 2 ms CPU (uniform change + label reposition ≤ 1 000 labels) |
| Dragging a node (degree 4) | joins of ≤ 6 nodes + 4–8 wall re-tessellations + face detection (≤ 3 ms for 5k walls) |
| Commit transaction | normalize + faces + rooms ≤ 10 ms |
| Cold open of 5k-wall project | < 300 ms to first frame |

---

## 3. Data model

### 3.1 Conventions
- Units: **millimetres** (float64) everywhere in the model. Angles in radians internally, degrees in UI.
- Axes: x → right, **y → down** (screen/SVG convention). `perp(d) = (-d.y, d.x)` is called "Left" (L) in all formulas — a purely algebraic name; in a Y-down view L appears on the viewer's right. UI shows sides as "side A / side B" with a highlight, never as left/right text.
- Signed area = standard shoelace `½Σ(x_i·y_{i+1} − x_{i+1}·y_i)`; all "CCW"/"positive" statements below are algebraic and hold regardless of display orientation.
- IDs: `nanoid` 6.0.2 (MIT), 12 chars.

### 3.2 Entities (persisted)

```ts
interface Level   { id; name; elevation: number; height: number; floorThickness: number; order: number }
interface Node    { id; levelId; x: number; y: number; pinned?: boolean }      // pinned = user split, never auto-merged
interface Wall {
  id; levelId; a: NodeId; b: NodeId;
  kind: 'wall' | 'partition' | 'parapet' | 'separator';   // separator = zero-thickness room divider (not built in 3D)
  thickness: number;                                      // mm
  justification: 'center' | 'faceL' | 'faceR';            // which line the a→b reference line represents
  height: number; heightEnd?: number;                     // sloped top if heightEnd set
  baseOffset?: number;                                    // from level floor
  arc?: { sagitta: number } | null;                       // signed, +ve bulges to L side; |sagitta| < len/2
  material: { L: MaterialRef; R: MaterialRef; top?: MaterialRef; core?: 'brick'|'concrete'|'gas-block'|'gypsum'|'wood' };
  layers?: WallLayer[];                                   // optional build-up (finish/insulation) for later
}
interface Opening {
  id; wallId; type: 'door'|'doubleDoor'|'slidingDoor'|'pocketDoor'|'foldingDoor'|'window'|'balconyDoor'
                   |'balconyBlock'|'arch'|'passage'|'niche';
  offset: number;          // distance from wall node a to opening CENTER, along centerline (arc length for arcs)
  width: number; height: number; sill: number;           // mm
  hinge: 'start' | 'end';  swing: 'L' | 'R';             // swing side relative to a→b
  depthPos: number;        // 0..1 position of frame within thickness (0 = L face)
  archRise?: number; frame?: {width; depth}; assetId?: string; params?: Record<string, unknown>;
}
interface RoomRec { id; levelId; anchor: {x,y}; name; type: 'living'|'kitchen'|'bath'|'balcony'|'corridor'|...;
                    floor: MaterialRef; ceiling: {height?: number; material: MaterialRef; kind: 'flat'|'stretch'|'multilevel'};
                    skirting?: ProfileRef; cornice?: ProfileRef; labelPos?: {x,y} }
interface Dimension { id; levelId; a: Anchor; b: Anchor; offset: number; textOverride?: string; style: 'linear'|'aligned' }
type Anchor = {kind:'node', id} | {kind:'wallFace', wallId, side:'L'|'R', end:'a'|'b'}
            | {kind:'opening', id, edge:'start'|'end'} | {kind:'free', x, y};
interface Label    { id; levelId; x; y; text; size; rotation }
interface Furniture{ id; levelId; assetId; x; y; rotation; elevation; scale:[number,number,number]; mirror?: boolean; wallId?: string }
interface Underlay { id; levelId; assetId; transform: {scale, rotation, tx, ty}; opacity; locked; visible }
interface UserLayer{ id; name; visible; locked; color? }   // annotation/furniture grouping; semantic layers are fixed
```

Derived (never persisted, never in history): wall half-widths, join corners, wall polygons, hub polygons, union outline, faces, room polygons/areas/perimeters, auto-dimensions.

Half-widths from justification (relative to a→b):

```
center: hL = t/2, hR = t/2
faceL : hL = 0,   hR = t        // the drawn line is the L face; body extends to R
faceR : hL = t,   hR = 0
```

### 3.3 Store
- Zustand 5.1.0 vanilla store holds `{ doc, view, selection, tool }`; `doc` is immutable (Immer 11.2.10). React subscribes only for panels; the Pixi scene subscribes to **patch streams** (see §9), not to React.
- Spatial indices (rbush 4.0.1) for nodes, walls (AABB incl. thickness), openings, furniture, dimensions — updated incrementally from patches.
- Project file `.doplan` = zip { `doc.json` (versioned schema), `assets/`, `thumbs/` }; autosave to a sidecar every 60 s.

---

## 4. Wall join (miter) algorithm

### 4.1 Constants

```ts
const EPS          = 1e-9;                        // pure numeric zero (unit vectors)
const LEN_EPS      = 0.01;                        // mm, point equality
const NODE_TOL     = 1.0;                         // mm, node merge / T-touch tolerance
const PARALLEL_SIN = Math.sin(0.25 * Math.PI/180);// |cross(dA,dB)| below this ⇒ treat as parallel/collinear
const MITER_LIMIT  = 4;                           // × max(half-width) for reflex (outer) corners
const MIN_HALF     = 1;                           // mm, used in limits when a half-width is 0
```

### 4.2 Per-node join

For every node `v` with incident walls `W(v)`:

```ts
type End = { wall: Wall; atA: boolean; d: Vec; hl: number; hr: number; ang: number;
             left?: Vec; right?: Vec };          // corners in OUTWARD-from-node frame

function computeJoin(v: Node): { ends: End[]; hub: Vec[] | null } {
  const ends = incident(v).map(w => {
    const atA = w.a === v.id;
    const d = outwardTangent(w, atA);            // unit; straight: normalize(other - v); arc: tangent of arc at v
    const {hL, hR} = halfWidths(w);
    // sides swap when looking outward from node b
    return { wall: w, atA, d, hl: atA ? hL : hR, hr: atA ? hR : hL, ang: Math.atan2(d.y, d.x) };
  });
  const k = ends.length;
  if (k === 0) return { ends, hub: null };

  if (k === 1) {                                  // free end: square cap
    const e = ends[0], n = perp(e.d);
    e.left  = add(v, mul(n,  e.hl));
    e.right = add(v, mul(n, -e.hr));
    return { ends, hub: null };
  }

  ends.sort((p, q) => p.ang - q.ang || curvatureTieBreak(p, q));   // CCW (increasing atan2)
  const hub: Vec[] = [];

  for (let i = 0; i < k; i++) {
    const A = ends[i], B = ends[(i + 1) % k];   // B is next CCW; the gap A→B is on A's L and B's R side
    const pA = add(v, mul(perp(A.d),  A.hl));   // point on A's L line at s = 0
    const pB = add(v, mul(perp(B.d), -B.hr));   // point on B's R line at s = 0
    const cr = cross(A.d, B.d);
    const gap = normAngle(B.ang - A.ang);        // (0, 2π]; for k=2 one gap is > π

    let cA: Vec, cB: Vec;                        // corner assigned to A.left and to B.right
    if (Math.abs(cr) < PARALLEL_SIN) {
      // collinear continuation (dot<0) → straight joint / thickness step;
      // same direction (dot>0) → overlapping walls (should not exist after normalize) → square ends
      cA = pA; cB = pB;
    } else {
      // pA + s·A.d = pB + u·B.d
      const w = sub(pB, pA);
      const s = cross(w, B.d) / cr;
      const c = add(pA, mul(A.d, s));
      const reflex = gap > Math.PI + EPS;        // outer corner
      const lim = MITER_LIMIT * Math.max(A.hl, B.hr, MIN_HALF);
      if (reflex && dist(c, v) > lim) { cA = pA; cB = pB; }   // bevel through the s=0 points
      else { cA = c; cB = c; }
    }
    if (A.hl === 0 && B.hr === 0) { cA = v; cB = v; }        // zero-thickness separators
    A.left = cA; B.right = cB;
    pushUnique(hub, cA); pushUnique(hub, cB);               // ordered: CCW around v
  }
  // hub only matters for k ≥ 3 or when a bevel/step produced extra points
  const useHub = (k >= 3 || hub.length >= 3) && Math.abs(signedArea(hub)) > 1;  // > 1 mm²
  return { ends, hub: useHub ? hub : null };
}
```

Why it tiles: wall `A`'s cut edge at node `v` is the segment `A.right → A.left`; the hub polygon visits all corners in CCW order, so its edge `A.right → A.left` coincides exactly with that cut. Hub ∪ wall quads cover the junction with no overlap or gap — for L, T, X, Y and any N-way junction with different thicknesses.

Worked T example (all `h = 100`, y-down coords irrelevant to algebra): ends sorted at 0° (east), 90°, 180°. Corners: east∩branch = (100,100); branch∩west = (−100,100); west∩east is parallel → (0,−100) on both. Hub = triangle — correct T fill.

### 4.3 Wall polygon assembly

```ts
function wallPolygon(w): Vec[] {
  const js = endOf(w, w.a), je = endOf(w, w.b);   // End records from the two node joins
  // translate outward-frame corners into a→b frame:
  let sL = js.left,  sR = js.right;               // at a: outward == a→b
  let eL = je.right, eR = je.left;                // at b: outward == b→a ⇒ sides swap
  // bow-tie guard (wall shorter than its joins)
  const d = unit(w.b - w.a);
  if (dot(sub(sL, A), d) > dot(sub(eL, A), d) - LEN_EPS) [sL, eL] = bothTo(midOn('L'));
  if (dot(sub(sR, A), d) > dot(sub(eR, A), d) - LEN_EPS) [sR, eR] = bothTo(midOn('R'));
  //  ^ set both to the L (resp. R) side-line point at s = (s_start + s_end)/2; flag w as "degenerate" (UI warning)
  return w.arc ? arcBand(w, sL, eL, sR, eR) : [sR, eR, eL, sL];   // CCW
}
```

- Arc walls: L/R side lines are concentric arcs `r ± h`; tessellate with chord error ≤ 0.5 mm and ≤ 5° per segment: `n = max(ceil(θ / (2·acos(1 − 0.5/r))), ceil(θ / 5°))`. Corner points come from the join (see §4.4).
- Openings are cut out for display: `display = Clipper.difference([wallPolygon], openingRects)` where each opening rect spans `s ∈ [offset − width/2, offset + width/2]` across `[−hR − 1, +hL + 1]` (1 mm overshoot to avoid slivers). Arches/passages cut fully; niches cut nothing in plan (dashed outline).
- Outline: per level, `Clipper.union(allWallPolys ∪ hubs, NonZero)` grouped by wall category (load-bearing vs partition get different hatches); the union outline is stroked once, so no internal seams at joins. Cached; recomputed only for the connected component touched by a change.

### 4.4 Arc walls in joins
- Sorting uses the end tangent; ties between a straight and an arc with the same tangent are broken by curvature (signed `1/r`, larger turning toward CCW first).
- Corner = intersection of the two side curves (line/line, line/circle, circle/circle). Choose the intersection closest to the tangent-line corner computed by the straight algorithm; if none exists (no intersection) fall back to the tangent-line corner. Miter-limit rule unchanged.

### 4.5 Edge cases checklist
| Case | Behaviour |
|---|---|
| Degree 1 | square cap at s = 0 |
| Collinear, equal thickness | cA = cB, straight joint, no hub |
| Collinear, different thickness / justification | step: cA ≠ cB, hub = 4-point quad filling the step |
| Reflex corner, very acute (e.g. 5°) | bevel at s=0 points (miter limit 4×) |
| Inner corner, very acute | exact intersection (geometrically correct overlap region); bow-tie guard clamps short walls |
| Zero-thickness separator | joins at node point; contributes nothing to fill |
| Wall shorter than its joins | bow-tie guard, `degenerate` flag → orange outline + tooltip |
| Same-direction overlap | prevented by normalize; fallback square ends |

---

## 5. Planar-graph normalization (runs inside every commit)

```ts
function normalize(d: Draft<Doc>, touchedWalls: Set<WallId>, touchedNodes: Set<NodeId>) {
  // 1. merge nodes closer than NODE_TOL (rbush query); keep the older id; rewire walls; drop walls with a==b
  // 2. for each touched wall w (and walls whose AABB overlaps it):
  //      for each candidate o ≠ w (rbush, AABB inflated by NODE_TOL):
  //        if shareNode(w,o) continue-unless-collinear-overlap
  //        o1=orient2d(w.a,w.b,o.a) o2=orient2d(w.a,w.b,o.b) o3=orient2d(o.a,o.b,w.a) o4=orient2d(o.a,o.b,w.b)
  //            (robust-predicates 3.0.3, Unlicense)
  //        a) proper crossing (o1·o2 < 0 && o3·o4 < 0): P = intersection; split w and o at P with one new node
  //        b) T-touch: an endpoint E of w lies within NODE_TOL of o's interior (projection s ∈ (NODE_TOL, len−NODE_TOL)):
  //              move E exactly onto o (projection) and split o at E   (and symmetrically for o's endpoints)
  //        c) collinear overlap (all |orient|/len < 0.5 mm and intervals overlap > NODE_TOL):
  //              keep the existing wall o for the overlapped interval; trim w to the non-overlapping remainder(s)
  // 3. drop walls with length < NODE_TOL (re-home their openings if any → delete opening + warning)
  // 4. delete orphan nodes (degree 0)
  // 5. auto-merge at degree-2 nodes only if: !node.pinned && collinear within 0.05° && walls have identical
  //    kind/thickness/justification/heights/materials && no opening straddles → one wall, openings re-offset
}
```

Splitting a wall at distance `s` (from a): new node N; wall1 = (a,N), wall2 = (N,b) clone props; openings with `offset < s` stay on wall1, others move to wall2 with `offset -= s`; an opening straddling `s` blocks an interactive split (split point snaps to the nearest opening edge) and in automatic splits is kept on the piece holding its center and clamped (warning).

Arc walls in normalize: segment–arc and arc–arc intersection via circle formulas, filtered to the arc's angular span; T-touch uses distance to circle and span test.

---

## 6. Room detection (faces of the planar graph)

### 6.1 Half-edge construction & traversal

```ts
interface HE { id: number; from: NodeId; to: NodeId; wall: Wall; ab: boolean; twin: number; ang: number; pos: number }

function detectFaces(level): Face[] {
  const hes: HE[] = [];
  for (const w of walls(level)) {
    const i = hes.length;
    hes.push({ id: i,   from: w.a, to: w.b, wall: w, ab: true,  twin: i+1, ang: angleOut(w, w.a) });
    hes.push({ id: i+1, from: w.b, to: w.a, wall: w, ab: false, twin: i,   ang: angleOut(w, w.b) });
  }
  // outgoing lists sorted CCW (increasing atan2 of outward tangent; curvature tie-break for arcs)
  const out = groupBy(hes, h => h.from); for (const L of out.values()) { L.sort(byAng); L.forEach((h,k)=>h.pos=k); }

  // next half-edge keeping the face on the algebraic LEFT:  CW neighbour of twin at the arrival node
  const next = (h: HE) => { const t = hes[h.twin]; const L = out.get(t.from)!; return L[(t.pos - 1 + L.length) % L.length]; };

  const seen = new Uint8Array(hes.length), cycles: HE[][] = [];
  for (const h0 of hes) if (!seen[h0.id]) {
    const cyc: HE[] = []; let h = h0, guard = 0;
    do { seen[h.id] = 1; cyc.push(h); h = next(h);
         if (++guard > hes.length) throw new Error('face walk did not close (graph not normalized)'); }
    while (h !== h0);
    cycles.push(cyc);
  }
  return classify(cycles);
}
```

Properties: every half-edge is in exactly one cycle; a dangling wall appears as `h, …, twin(h)` inside one cycle (walk goes out and back), a bridge wall between two rooms likewise.

### 6.2 Classification and holes

```ts
const AREA_EPS = 1e3;       // mm² (0.001 m²) — below: degenerate cycle (tree component, slit)
const MIN_ROOM = 1e5;       // mm² (0.1 m²)  — below: face kept as "void", no RoomRec auto-created

function classify(cycles) {
  const comp = unionFind(walls);                               // connected components by shared nodes
  const items = cycles.map(c => ({ c, A: centerlineSignedArea(c), comp: comp.find(c[0].wall.id) }));
  const bounded = items.filter(x => x.A >  AREA_EPS);          // CCW → interior faces
  const outers  = items.filter(x => x.A <= AREA_EPS);          // CW outer boundary of each component, or ≈0 for trees
  const faces = bounded.map(b => ({ ...b, poly: centerlinePolygon(b.c), holes: [] as typeof outers }));
  for (const o of outers) {
    const p = nodePos(o.c[0].from);                             // any vertex of that component
    let best = null;
    for (const f of faces) if (f.comp !== o.comp && Math.abs(f.A) < (best?.A ?? Infinity)
                              && pointInPolygon(p, f.poly)) best = f;   // innermost containing face
    if (best) best.holes.push(o);                               // island: column box, free-standing wall, inner block
    // else: building exterior → ignored
  }
  return faces;
}
```

`centerlineSignedArea` uses node positions plus, for arc walls, the circular-segment area `±(r²/2)(θ − sin θ)` signed by bulge side relative to the traversal direction. Point-in-polygon on the centerline polygon (arcs tessellated). Different components never touch (planar invariant), so a vertex test is unambiguous.

### 6.3 Exact room polygon (finished inner faces)

```ts
function sideRing(cycle: HE[]): Vec[] {          // the wall faces seen from the face on the left
  const pts: Vec[] = [];
  for (const h of cycle) {
    const w = h.wall, g = derived.wall(w.id);     // corners from §4.3 (a→b frame)
    const seq = h.ab ? g.sideL(/*from a to b*/) : g.sideR(/*from b to a*/);   // [corner, ...arcPts, corner]
    for (const p of seq) pushUnique(pts, p, LEN_EPS);
  }
  return dedupeClosing(pts);
}

function roomGeometry(face) {
  const outer = sideRing(face.c);                                  // CCW
  const holes = face.holes.map(o => reverse(sideRing(o.c)));       // island outer footprint, made CCW
  // NonZero union cleans the slits produced by dangling walls and zero-width spikes
  const S = 100;                                                   // Clipper scale: 1 unit = 0.01 mm
  const solid = union([toInt(outer, S)], NonZero);
  const poly  = holes.length ? difference(solid, union(holes.map(h => toInt(h, S)), NonZero), NonZero) : solid;
  const paths = fromInt(poly, S).filter(p => Math.abs(area(p)) > AREA_EPS);
  return {
    paths,                                                         // outer (+) and hole (−) rings
    area:      sum(paths.map(area)) / 1e6,                         // m²
    perimeter: sum(paths.map(perimeterOf)) / 1e3,                  // m (all wall faces)
    skirtingLength: perimeter − Σ door/passage widths on this face's walls / 1e3,
    labelPos:  polylabel(paths, 1.0),                              // polylabel 2.1.0 (ISC), precision 1 mm
  };
}
```

Area semantics: the room area is measured to the finished inner wall faces (the BTI/SP 54 convention users expect in RU), door reveals excluded. If later the wall build-up (`layers`) includes a finish layer, offset the ring inward by the finish thickness with `inflatePaths(…, −finish, JoinType.Miter)`.

Sanity invariant (property test): `Σ room areas + Σ wall/hub footprint inside the outer boundary = area(outer boundary of building)` within 1 mm²·E; Euler `V − E + F = 1 + C`.

### 6.4 Persisting room identity across edits

Faces are recomputed on every commit; `RoomRec` (name, floor material, ceiling…) must survive. Inside the same transaction (so undo is atomic):

```ts
function syncRooms(d, oldFaces, newFaces) {
  // 1. assign by anchor: each RoomRec goes to the new face whose polygon contains its anchor
  // 2. if two RoomRecs land in the same face (merge): keep the one whose OLD face area was larger; delete the other
  // 3. faces without a RoomRec (split / newly closed): if area < MIN_ROOM → void; else create RoomRec copying props
  //    from the old face with the largest overlap area (Clipper intersection), default props if none
  // 4. RoomRec whose anchor is in no face (room opened up): delete
  // 5. re-anchor every RoomRec to polylabel(newFace) unless the user placed labelPos manually and it is still inside
}
```

---

## 7. Openings

- Parametrised by `wallId + offset (center, mm from node a) + width`; valid range `offset ∈ [width/2 + m, len − width/2 − m]`, `m = 50 mm` (frame clearance; arcs use arc length). Openings on one wall may not overlap (min gap 0); dragging an opening clamps and pushes nothing (simple, predictable).
- On wall length change the offset is kept absolute from node `a`; if node `a` itself moved, keep the ratio `offset/len` (user intuition: window stays "in the middle-ish"); then clamp.
- On wall flip (a↔b swap) `offset ← len − offset`, `swing` and `hinge` swap.
- Drag-and-drop from the library: hit-test walls under cursor (rbush + distance to centerline ≤ thickness/2 + 10 px), snap the center to wall midpoint, room-center projection, 50-mm steps and "distance from nearest corner" typed input.
- 2D symbols (GOST 21.201 / ISO 4157 style) as shared `GraphicsContext`s per type: door leaf + 90° swing arc (thin), double door, sliding (parallel leaves + arrow), window = 3 lines across thickness + sill line, balcony block = window + door composite, arch = dashed lines across cut, niche = dashed outline.
- 3D: the opening record carries everything the 3D builder needs (sill, height, depthPos, frame, assetId); the 2D cut and 3D CSG/extrusion holes come from the same rectangle in wall-local `(s, z)` space.

---

## 8. Interaction design

### 8.1 Tools
Select · Wall (polyline chain) · Room rectangle (4 walls) · Room polygon · Separator · Arc wall (M2) · Opening placement · Furniture placement · Dimension · Label · Underlay calibrate · Measure (temporary).

Wall drawing: click-click chaining, Backspace removes last segment, Esc/double-click ends, closing on the start node auto-ends. Drawing reference can be center / face L / face R (toggle with `Tab` while drawing) — essential for "drawing by inner dimensions" from a BTI plan.

### 8.2 Snapping

Tolerance is in screen pixels: `tolW = 10 px / zoom`. Candidates are gathered once per frame from rbush (`search(bbox(cursor ± tolW))`) and scored; first by priority class, then by screen distance.

| Prio | Snap | Notes |
|---|---|---|
| 1 | Node / wall end | |
| 2 | Wall-face corner, opening edge, wall–wall face intersection | |
| 3 | Midpoint of wall (centerline & faces) | |
| 4 | Perpendicular foot from the drawing start onto a wall/face | only while drawing |
| 5 | Nearest point on centerline / face | |
| 6 | Alignment ("object tracking"): horizontal/vertical through tracked points; extension of wall directions; intersection of two guides | tracked points = last 8 hovered nodes + drawing start + nodes in viewport via x/y-sorted arrays (binary search ±tolW) |
| 7 | Polar angle from drawing start: 15° steps (Shift = lock to 0/45/90) | combines with typed length |
| 8 | Grid (adaptive: 10/50/100/500/1000 mm by zoom) | lowest priority, can be disabled |

Composite: angle constraint (7) is applied first as a ray; then candidates 1–6 that lie within `tolW` of the ray win; otherwise the projection of the cursor onto the ray, rounded to the length step (10 mm default). `Alt` held = snapping off. Visual feedback: glyph per snap type + dashed guide lines (pixelLine) + live length/angle labels.

Typed input (no modal): typing a digit while a tool is active opens an inline field at the cursor. Grammar:
```
input   := length [ ("," | "<") angle ] | "@" dx "," dy
length  := number [ "mm" | "cm" | "m" ]          // default mm; "3.5m", "350cm", "3500"
angle   := number [ "°" ]                        // degrees, math-positive = CCW algebraic
number  := tiny expression with + − * / ( )      // own 60-line parser; no mathjs
```
`Tab` switches length/angle fields; `Enter` commits the point.

### 8.3 Selection & editing operations
- Click pick: rbush candidates → exact distance (point-in-polygon for rooms/walls, distance for lines) → priority handles > openings > furniture > walls > dimensions > rooms. Cycling with repeated clicks at the same spot.
- Box: left→right = window (fully inside), right→left = crossing (intersects), like CAD.
- Node drag: all incident walls follow; snapping applies to the node.
- Wall drag (perpendicular move, ArchiCAD-like): for each end node, if it has exactly one other incident wall `o`, slide the node along `o`'s line (line–line intersection of the moved wall line with `o`); else translate the node. Keeps neighbours straight.
- Thickness change keeps the justification face fixed (center/faceL/faceR).
- Split (click on wall), merge (select degree-2 node → "remove node"), delete (with cleanup), rotate/mirror/copy-paste (Ctrl+D duplicate with offset), offset wall chain, align furniture to wall (snap back to face, rotate to wall direction).
- Multi-select property editing: thickness, height, materials per side for N walls in one transaction.

### 8.4 Dimensions, labels, layers, levels
- Live dimensions while drawing/dragging (temporary, screen-space).
- Auto dimensions (toggle per level): (a) per-room inner face lengths along each wall face; (b) exterior chains computed from the union outline: row 1 openings & piers, row 2 wall segments between corners/axes, row 3 overall — the standard 3-chain layout; (c) room label = name + area (m², 2 decimals) at `labelPos`.
- Manual dimensions are associative via `Anchor`; if an anchor's target is deleted the anchor degrades to `free` at its last position (no dangling refs).
- Semantic layers (fixed): underlay, rooms, walls, openings, furniture, dimensions, annotations, guides — each with visible/locked per level; plus user layers for annotations/furniture grouping.
- Multi-floor: `Level` list; the level below is rendered as ghost (alpha 0.25, non-interactive) for tracing; "copy walls to level", balcony = room `type: 'balcony'` with `parapet` walls (default height 1000 mm) and `balconyBlock`/glazing openings. Stairs: simple parametric stair object in M2.

### 8.5 Background tracing & calibration
- Import PNG/JPG/WebP/PDF page (PDF rasterized with `pdfjs-dist` 6.5.438, Apache-2.0, at 200 dpi in a worker). Downscale to ≤ 8192 px long side (iGPU memory) with mipmaps.
- Calibration: user clicks P1, P2 on the image and types the real length L → `scale = L / |P2 − P1|_px`; optional "make this line horizontal/vertical" sets rotation; translation by dragging. Stored as `transform {scale, rotation, tx, ty}`.
- Perspective rectification (photos of paper plans): 4-point homography (DLT, 8×8 solve) → resample in a worker into a new rectified image asset; then normal calibration.
- Contract with the photo→plan AI tool (other report): it outputs the same `doc.json` subset (nodes, walls, openings with mm units) plus the calibrated underlay, and goes through `normalize()` like any paste.

---

## 9. Undo / redo & change propagation

```ts
import { enablePatches, produceWithPatches, applyPatches, Patch } from 'immer';  // immer 11.2.10
enablePatches();

interface Entry { label: string; redo: Patch[]; undo: Patch[]; sel0: Sel; sel1: Sel; key?: string; t: number }

function transact(label: string, recipe: (d: Draft<Doc>) => void, opts?: { coalesceKey?: string }) {
  const [next, redo, undo] = produceWithPatches(store.doc, d => {
    recipe(d);
    const touched = touchedFrom(d);          // ids collected by recipe helpers
    normalize(d, touched.walls, touched.nodes);
    syncRooms(d, derived.faces(store.doc), detectFacesFor(d));   // room identity changes are part of the same entry
  });
  if (!redo.length) return;
  const top = undoStack.at(-1);
  if (opts?.coalesceKey && top?.key === opts.coalesceKey && now() - top.t < 600) {
    top.redo = [...top.redo, ...redo]; top.undo = [...undo, ...top.undo]; top.t = now(); top.sel1 = sel();
  } else {
    undoStack.push({ label, redo, undo, sel0: prevSel, sel1: sel(), key: opts?.coalesceKey, t: now() });
    if (undoStack.length > 500) undoStack.shift();
  }
  redoStack.length = 0;
  commit(next, redo);                         // → dirty propagation
}
undo(): e = undoStack.pop(); commit(applyPatches(doc, e.undo), e.undo); setSel(e.sel0); redoStack.push(e);
redo(): symmetric with e.redo / sel1.
```

- Drags: on every pointermove compute `preview = produce(baseDoc, d => applyDrag(d, delta))` (cheap thanks to structural sharing) and render the preview; on pointer-up run `transact('Move', d => applyDrag(d, delta))` once. Esc restores `baseDoc`.
- Slider/colour edits use `coalesceKey = 'prop:' + ids + field`.
- Dirty propagation from patch paths: `['nodes', id, …]` → node dirty → incident walls dirty → joins of both end nodes recomputed → walls whose corners changed re-tessellate → faces recomputed per affected level (cheap global pass) → rooms whose ring hash changed redraw → labels/auto-dims of affected rooms. Every derived cache is keyed by id + a version counter.
- Selection, camera, tool state are not in `doc` (not undoable), but selection is restored with entries.
- Not chosen: `zundo` 2.3.0 (snapshot-based, last release 2024) — patches are smaller and give us dirty sets for free; `mutative` 2.0.2 (MIT) is an API-compatible faster alternative if Immer ever shows in profiles. Yjs 13.6.33 only if real-time collaboration is ever added.

---

## 10. Export

### 10.1 Architecture
`Sheet compositor` (pure TS, worker-safe) → **display list** of primitives in paper millimetres (coordinates pre-transformed by scale; stroke widths in paper mm, so nothing is scaled twice):

```ts
type Prim =
 | { t:'poly'; pts: Vec[]; closed: boolean; stroke?: Pen; fill?: Fill; layer: string }
 | { t:'arc'; c: Vec; r: number; a0: number; a1: number; stroke: Pen; layer }
 | { t:'text'; p: Vec; s: string; size: number; rot: number; anchor: 'start'|'middle'|'end'; layer }
 | { t:'dim'; a: Vec; b: Vec; offset: number; text: string; layer }       // DXF keeps it as a real DIMENSION
 | { t:'image'; assetId; transform; layer }                              // underlay (optional in export)
 | { t:'insert'; block: string; p: Vec; rot: number; sx: number; sy: number; layer };  // doors/furniture as blocks
```

Backends consume the same list: SVG, PDF (via SVG), PNG (via SVG), DXF (world-mm variant of the list, scale 1:1, Y flipped).

Pens (ISO 128 / GOST 2.303 line weights): cut walls 0.5 mm (0.7 at 1:50), openings/windows 0.25, furniture 0.18, dimensions/hatch 0.13–0.18. Hatches per wall core: brick = 45° lines 1.5 mm pitch, concrete = dots+triangles pattern, gas-block, gypsum = solid light grey.

Sheet: A4–A1 (portrait/landscape) or custom, scale picker {1:20, 1:25, 1:50, 1:75, 1:100, 1:200, 1:500} with "fit" = largest standard scale that fits; title block templates: simple (project, address, sheet title, scale, date, author) and **GOST 21.101 form 3 main title block 185×55 mm** for RU users; north arrow, graphic scale bar, legend of room areas (table: № / name / area, total). Fonts: **PT Sans / PT Sans Narrow** (OFL, full Cyrillic) embedded.

### 10.2 Backends & libraries

| Format | Library (version, licence) | How |
|---|---|---|
| SVG | own builder (no lib) | `width="420mm" height="297mm" viewBox="0 0 420 297"`; `<pattern>` hatches; fonts embedded as `@font-face` data URIs (subset). |
| **PDF (to scale, vector)** | **Electron `webContents.printToPDF`** (built in) | Load the sheet SVG into a hidden `BrowserWindow({show:false})`, CSS `@page { size: 420mm 297mm; margin: 0 }`, call `printToPDF({ pageSize: { width: 420/25.4, height: 297/25.4 }, margins: {top:0,bottom:0,left:0,right:0}, printBackground: true, preferCSSPageSize: true })` (custom sizes are in **inches**). Chromium/Skia PDF: vector, embedded subset fonts, Cyrillic works out of the box, multi-page = multiple `.sheet` divs with page breaks. Verify scale with a 100 mm calibration bar in tests. |
| PDF fallback (in-renderer, no window) | `jspdf` 4.2.1 (MIT) + `svg2pdf.js` 2.9.0 (MIT, peer jspdf ^2‖^3‖^4) | Requires `addFont()` of a TTF for Cyrillic; use only if printToPDF is unavailable (e.g. CLI/worker export). |
| PDF post-processing | `pdf-lib` 1.17.1 (MIT) — last release 2021, unmaintained; maintained fork `@cantoo/pdf-lib` 2.11.1 (MIT) | Only for metadata/merging; prefer the fork. Not needed for v1. |
| PNG (hi-dpi) | browser built-ins | SVG → `Image` → `OffscreenCanvas(w·dpi/25.4)` → `convertToBlob('image/png')`; 150/300/600 dpi; tile when > 16384 px. Quick "export current view" = `renderer.extract.canvas({ target: world, resolution: 2..4, frame })`. |
| **DXF** | **`@tarikjabiri/dxf` 2.10.0 (MIT, github dxfjs/writer)**, writes AC1021 (R2007) | `new DxfWriter()`, `setUnits(Units.Millimeters)`, `addLayer('A-WALL', color, 'CONTINUOUS')`, `addLWPolyline` (wall outlines, closed), `addHatch` (wall patterns, room fills), `addMText`/`addText` (labels), `addAlignedDim`/`addLinearDim` (dimensions), `addBlock` + `addInsert` (door/window/furniture symbols), `addArc` (swings). AIA layer names: A-WALL, A-WALL-PATT, A-DOOR, A-GLAZ, A-AREA-IDEN, A-ANNO-DIMS, A-FURN, A-ANNO-TTLB. Y flipped (`y → −y`). Validate by opening in LibreCAD / ODA viewer in CI fixtures. `dxf-writer` 1.18.4 (MIT, last release 2023) rejected — no hatches/dims. 3.0 alpha exists — stay on 2.x latest. |
| DXF import (underlay) | `dxf-parser` 1.1.2 (MIT) | M2: import CAD plans as a vector underlay layer. |

### 10.3 Geometry libraries (final picks)

| Need | Pick | Version / licence | Why / alternatives |
|---|---|---|---|
| Boolean ops, offsets (wall union, opening cut, room minus holes, finish insets) | **clipper2-ts** | 2.0.1-19 (`latest` tag, pin exact), BSL-1.0 | Faithful TS port of Clipper2 (union/difference/inflatePaths/triangulate), validated against Clipper2 reference tests, active (Nov 2026); integer-robust with scale 100 (0.01 mm) → 1 km building = 1e8 ≪ 2^53. Alternatives: `clipper2-wasm` 0.4.0 (BSL-1.0, faster, WASM loading), `polyclip-ts` 0.16.8 (MIT, float, last release 2024), `polygon-clipping` 0.15.7 (superseded), `@velipso/polybool` 2.0.11 (0BSD), `clipper2-js` 1.2.4 (Boost, last release 2024). |
| Robust orientation tests | robust-predicates | 3.0.3, Unlicense | Shewchuk `orient2d` for crossing tests in normalize. |
| Spatial index (dynamic) | rbush (+ rbush-knn 4.0.0 ISC) | 4.0.1, MIT | Insert/remove per edit. `flatbush` 4.7.0 (ISC) only for static bulk queries (export, AI import). |
| Triangulation (fills for Pixi / 3D floors) | earcut | 3.2.4, ISC | Pixi uses it internally; also for 3D floor/ceiling caps with holes. |
| Label placement | polylabel | 2.1.0, ISC | Pole of inaccessibility for room labels. |
| Arcs/circles helpers | own code (~200 LOC) | — | `@flatten-js/core` 1.6.15 (MIT) acceptable if we want ready arc/segment intersections, but adds weight. |
| Rejected | mathjs 15.2.0 (too heavy for the length parser), @turf/turf 7.4.0 (geodesic, lon/lat oriented) | | |

---

## 11. Module layout (suggested)

```
packages/plan-core/        pure TS, no DOM — runs in renderer & workers
  model/        schema, ids, migrations
  geom/         vec, arc, intersections, polygon utils, clipper adapter
  graph/        normalize(), split/merge ops, rbush indices
  joins/        computeJoin(), wallPolygon(), hubs, union outline
  faces/        detectFaces(), classify(), roomGeometry(), syncRooms()
  openings/     placement, clamping, symbols (as display-list prims)
  dims/         auto-dims, associative anchors
  export/       sheet compositor → display list; svg.ts; dxf.ts; png.ts
  history/      transact/undo/redo, dirty propagation
apps/desktop/renderer/editor2d/
  scene/        Pixi layers, entity→display-object sync, camera, labels
  tools/        select, wall, room, opening, furniture, dimension, calibrate
  snapping/     candidate gathering, scoring, guides, typed input parser
apps/desktop/main/export-pdf.ts   hidden BrowserWindow + printToPDF
```

## 12. Testing strategy (geometry kernel)
- `vitest` 5.1.0 + `fast-check` 4.10.2 (both MIT) property tests on random planar graphs: every half-edge in exactly one cycle; Euler `V − E + F = 1 + C`; area invariant (§6.3); hub+quads tile (union area == Σ areas within 1 mm²); normalize is idempotent; undo∘redo == identity on doc.
- Golden fixtures: L, T, X, Y, star-6, collinear-step, acute 5°, dangling wall in room, island column, room-in-room, arc corridor, BTI-style 2-room apartment with balcony; snapshot SVG exports.
- Benchmarks in CI: 5k-wall synthetic grid → faces < 5 ms, full commit < 10 ms (Node 23).

## 13. Milestones
- **M1**: model, normalize, joins, faces/rooms, wall/room/opening tools, snapping (1–5, 7, 8), typed input, undo/redo, underlay calibration, SVG/PNG/PDF export with title block.
- **M2**: alignment tracking guides, arc walls UI, auto exterior dimension chains, DXF export (+ import underlay), multi-level ghosting, stairs, perspective rectification.
- **M3**: wall build-up layers/finishes, GOST sheet sets (multi-sheet PDF: plan, furniture plan, flooring plan, ceiling plan, electrical), WebGPU toggle.

## Sources
- npm registry metadata (versions/licences/dates) via `npm view`, 2026-11-12.
- PixiJS blog/releases: https://pixijs.com/blog/june-2026 ; Graphics pixel line guide: https://pixijs.com/8.x/guides/components/scene-objects/graphics/graphics-pixel-line
- Electron `webContents.printToPDF` options: https://www.electronjs.org/docs/latest/api/web-contents
- clipper2-ts README: https://cdn.jsdelivr.net/npm/clipper2-ts@2.0.1-19/README.md (repo github.com/countertype/clipper2-ts)
- @tarikjabiri/dxf: https://dxf.vercel.app , github.com/dxfjs/writer (API names read from the 2.10.0 type definitions)
- Arcada (React + Pixi floor planner): https://github.com/mehanix/arcada
