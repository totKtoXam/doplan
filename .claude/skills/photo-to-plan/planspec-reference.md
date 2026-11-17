# PlanSpec v1 reference

PlanSpec is the JSON an agent writes. The compiler is `src/core/planspec.ts`
(`parsePlanSpec → validatePlanSpec → compilePlanSpec`). The app imports the same JSON through
File → «План из PlanSpec (JSON)…», and the CLI uses it in `pnpm dp spec …`.

## Units
- `units`: `"mm" | "cm" | "m" | "px"`. It applies to **coordinates, rects, polygons, opening `width`
  and `offset`, and fixture `rect`/`at`**.
- **Always mm, whatever `units` says:** wall `thickness`/`height`, opening `height`/`sill`, every
  value in `defaults`, fixture `size` and `elevation`, `edgeWall.thickness/height`.
- Areas (`labelledArea`, `labelledTotalArea`, `labelledLivingArea`) are always m².
- `px` needs a scale: `source.mmPerPx` (+ `mmPerPxY` if anisotropic) or `source.calibration`.
  The conversion is `mm = (px − originPx) · mmPerPx`. With px, coordinates round to `snap.gridMm`
  (default 10 mm). `pnpm dp spec normalize` turns a px spec into a clean mm spec.
- Axes: x to the right, y **down** (as in the image).

## Top level
```ts
{ version: 1, units, name?, source?, defaults?, snap?, walls?, rooms, openings, fixtures?, furniture?, notes? }
```
- `rooms` and `openings` are required; they may be empty arrays.
- `furniture` is an alias list of `fixtures`.
- `notes` is a list of strings: assumptions, shown to the user.

## source
| field | meaning |
|---|---|
| `image` | the prepped image the px coordinates refer to; a path relative to the spec file. Used as the underlay by `spec build`. |
| `size` | `[w, h]` px of `image` |
| `kind` | free text: `bti`, `developer`, `sketch`, `photo`, `other` |
| `mmPerPx`, `mmPerPxY` | the scale; `mmPerPxY` only when anisotropic |
| `originPx` | px position of mm (0,0); default `[0,0]`. In an mm spec this places the underlay. |
| `calibration` | `[{ p1:[x,y], p2:[x,y], mm, label? }]`, a printed dimension between two px points. `pnpm dp spec scale --ref … --spec f` appends it. |
| `labelledTotalArea`, `labelledLivingArea` | m² as printed, used for checks |
| `areaNote` | why the computed total / living area legitimately differs from the printed one; turns a `TOTAL_AREA_MISMATCH` error into a warning |
| `toScale` | false for sketches whose drawing is not proportional, so only the numbers count |

## defaults (mm)
`ceilingHeight` (2700), `wallHeight`, `exteriorThickness` (alias `outerThickness`),
`loadBearingThickness`, `partitionThickness` (alias `innerThickness`), `doorHeight`, `windowSill`,
`windowHeight`, `railingHeight`, `railingThickness`.

## snap
| field | default | effect |
|---|---|---|
| `orthogonal` | true | snaps near-orthogonal edges |
| `orthoToleranceDeg` | | snap tolerance for near-orthogonal edges |
| `gridMm` | 10 for px | rounding grid |
| `mergeMm` | max(thickness)/2 + 50 | collinear bridge / T-join distance |
| `standardThickness` | true | snaps thicknesses within ±15 mm to 80, 100, 120, 150, 160, 180, 200, 250, 300, 380, 400, 510, 640 |

## Two authoring modes
### Rooms-mode (recommended)
- Each room is a **clear interior** `rect: [x, y, w, h]` or a `polygon` (any winding).
- No `walls`: the compiler finds the gap between facing room edges and builds a wall in it:

| gap | wall |
|---|---|
| < 40 mm | `separator`: an invisible room boundary for open-plan zones; also gives `TINY_GAP` |
| 40–159 mm | `partition` |
| ≥ 160 mm | `loadBearing` |
| edge on the building outline | `exterior`, thickness = `defaults.exteriorThickness` |
| between an indoor room and a balcony/loggia | `exterior` |
| > 700 mm | not a wall: the edges count as unrelated |

- The wall centre line is the middle of the gap. So a door between two rooms has its `at` in the
  middle of the gap.
- Room edges facing nothing (no neighbour and no building) get the room's `edgeWall`. Example:
  balcony railing `{kind:"railing", thickness:100, height:1100}`. A glazed loggia uses `glazed: true`,
  which makes the edge wall `glass`.

### Walls-mode
- `walls: [{ id, path:[[x,y],…], closed?, align?, thickness?, kind?, height?, confidence? }]`.
- The path is the centre line. With `closed: true`, `align: "inner" | "outer"` means the path is the
  inner or outer **face** of the loop instead (`WALL_ALIGN_OPEN` if it is used on an open path).
- Rooms are then just labels: `{ id, name, type, at:[x,y], labelledArea }`, a point inside each
  enclosed face. Faces with no label give `FACE_UNLABELLED`.
- Mixing is allowed: explicit walls plus rect rooms.

### Wall kinds
`exterior`, `loadBearing`, `partition`, `parapet`, `railing`, `glass`, `separator`.

## rooms
```ts
{ id, name?, type?, number?, rect? | polygon? | at?, labelledArea?, labelledAreaCoef?, areaNote?, cutouts?,
  ceilingHeight?, edgeWall?, balcony?, glazed?, technical?, confidence? }
```
- `labelledArea`: m² as printed.
- `labelledAreaCoef`: the printed area is clear area × this, in (0, 1]: BTI loggia `0.5`, balcony /
  terrace `0.3`. The check compares clear × k with the label; the project keeps the clear-area
  equivalent (label ÷ k). Real depth of such a room = label ÷ k ÷ length.
- `areaNote`: why the computed area legitimately differs from the label (the plan contradicts itself,
  a digit is illegible…). An explained `AREA_MISMATCH` is a warning, not an error. Do not use it to
  hide a missing cutout or step. A blank note (spaces only) explains nothing: the error stays.
- `cutouts`: shafts, boxes and columns that are not floor:
  ```ts
  { rect: [x, y, w, h], kind?: "shaft" | "box" | "column", wall?: mm, name? }
  ```
  - `rect` in plan coordinates (spec units), inside the room's rect/polygon: the **outer** footprint
    as seen from the room, shaft walls included.
  - The floor is the room minus its cutouts (that is the area checked). Cutouts touching the outline
    make a notch; free-standing ones make a hole.
  - A side within 30 mm of the room outline (or of an earlier cutout) is snapped onto it
    (`CUTOUT_SNAPPED`, info), so a rect read a few mm off still makes a clean notch; this includes
    the line of a reflex (inner) corner of an L-room. After snapping the rect must lie inside the
    room: `CUTOUT_OUTSIDE` has no further tolerance.
  - No side may cross the line of a reflex corner (part of it on the outline, part along the floor):
    `CUTOUT_AT_CORNER`. Keep the cutout on one side of the corner line.
  - Cutouts must not overlap (`CUTOUT_OVERLAP`). An L-shaped shaft is two rectangles side by side,
    touching, not overlapping; each becomes its own void with a wall between them.
  - The compiler builds the cutout walls: sides facing the floor are `wall` thick (default
    `defaults.partitionThickness`; thinned if the cutout is too small); sides on the room outline
    continue the room's own wall, and so does a side in line with the outline wall at a reflex
    corner (a cutout against the inner corner of an L-room). If a neighbouring room faces that outline
    edge at the corner, the side continues the wall shared with it instead, of the thickness the gap
    gives (a partition, a load-bearing wall, an outer wall to a balcony); a gap under 40 mm is no wall
    and the side gets the cutout wall. A shaft / box side against a column gets its wall on the
    shaft's side (the column stays solid to its rect). A cutout on an edge shared with a neighbour
    keeps that shared wall along its whole side. Cutouts touching only at a corner point stay two
    holes; cutouts sharing part of a side are one hole of the checked floor. The result does not
    depend on how the plan is turned or mirrored (the tests build every case in 8 orientations). The
    void inside is a technical room (`technical: true`, type other) named `name` (default Шахта /
    Короб / Колонна), however small: whatever its size it is not floor, so it is left out of the room,
    total and living areas (in the check, in `dp spec validate` and in the app). `kind: "column"` is
    solid (the walls fill it). A project with technical voids is saved as file format 4 (doplan
    0.14 and older refuse to open it rather than drop the flag).
  - Rooms must be orthogonal (rect or axis-aligned polygon) to have cutouts.
  - Errors: `CUTOUT_OUTSIDE` (the rect leaves the room), `CUTOUT_OVERLAP`, `CUTOUT_SPLITS_ROOM` (cuts
    the room in two), `CUTOUT_AT_CORNER` (a side crosses a reflex corner line),
    `BUILT_SHAPE_MISMATCH` (the built walls do not give the checked floor).
- `technical`: a technical void (shaft / box / column void, type other or storage): not floor, out of
  every total whatever its size; it carries no `labelledArea`. `dp doc spec` writes it for the voids of
  cutouts; do not put it on a real room (a storeroom marked so would drop out of the totals).
- `type`: `living`, `bedroom`, `kitchen`, `kitchenLiving`, `bathroom`, `toilet`, `hallway`,
  `corridor`, `balcony`, `loggia`, `wardrobe`, `office`, `kids`, `storage`, `other`.
- `type` aliases:

| alias | becomes |
|---|---|
| `study` | `office` |
| `dining` | `kitchenLiving` |
| `hall` | `hallway` |
| `combinedBathroom` | `bathroom` |
| `laundry`, `utility` | `storage` |
| `terrace` | `balcony` |

- Outdoor rooms are `balcony`, `loggia`, `terrace`, or any room with `balcony: true`.
- Living rooms (for the living-area check) are `living`, `bedroom`, `kids`, `study`, `office`.
- A window is expected in living rooms, `kitchen` and `kitchenLiving`; a missing one gives `NO_WINDOW`
  (info).

## openings
```ts
{ id?, type, width, at? | wall+offset? | room+side|edge+offset?, height?, sill?, between?, opensInto?, hinge?, hingeEnd?, swingSide?, sashes?, slide?, style?, confidence? }
```
- `type`:
  - door-like: `door`, `doubleDoor`, `slidingDoor`, `entranceDoor`, `arch`, `opening`, `balconyDoor`,
    `balconyBlock` (balcony door + window), `frenchWindow`;
  - window: `window`;
  - aliases: `pocketDoor` becomes `slidingDoor` with `slide: "pocket"` (the leaf slides into the wall),
    `foldingDoor` becomes `slidingDoor` with `slide: "folding"` (accordion, no swing arc), `passage`
    becomes `opening`, `panoramicWindow` becomes `frenchWindow`.
- `slide` (`slidingDoor` only): `surface` (default, leaf on the wall face), `pocket`, `barn` (a wide leaf
  on an exposed rail), `folding`.
- `style` (door leaves): `flush`, `panel`, `glazed`, `insert` (царговая), `glass`. Optional; without it
  the look follows the leaf material.
- Position, three ways:
  1. `at: [x,y]`, the centre on or near a wall centre line. The simplest.
  2. `wall: "<wallId>"` + `offset`: distance from the path start to the opening **centre**.
  3. `room: "<roomId>"` + `side: top|right|bottom|left` (or `edge: <polygon edge index>`) + `offset`:
     from the left end (top/bottom) or the top end (left/right) of that side to the centre.
- `width` is the clear width in spec units. `height` and `sill` are mm; defaults come from `defaults`.
- `between: [roomA, roomB | "outside"]` is a check: the door must actually connect these rooms
  (`DOOR_BETWEEN_MISMATCH`).
- `opensInto`: a room id or `"outside"`, the side the leaf swings into.
- `hinge: "left" | "right"` is seen **from the room it opens into, facing the door**.
- `hingeEnd: "a" | "b"` and `swingSide` are exact values from a round-trip (`doc spec`). They
  override `opensInto`/`hinge`; do not hand-write them.
- `sashes`: number of window sashes.

## fixtures / furniture
```ts
{ type, rect?:[x,y,w,h] | at?:[x,y], size?:[w,d,h] mm, rotation?: deg clockwise, assetId?, name?, elevation?: mm }
```
- Structural (become columns): `riser`, `ventShaft`, `chimney`, `column`.
- Sanitary: `bathtub`/`bath`, `shower`, `toilet`, `washbasin`.
- Kitchen: `sink`/`kitchenSink`, `stove`/`hob`, `oven`, `hood`, `fridge`, `dishwasher`.
- Utility: `washer`, `boiler`, `electricPanel`.
- Furniture: `sofa`, `bed`, `table`, `chair`, `wardrobe`.
- Any library asset category also works. An unknown type gives `FIXTURE_UNKNOWN`; neither `rect`
  nor `at` gives `FIXTURE_NO_POSITION`.

## Issue codes
Issues have the shape `{severity, code, message, path?, ids?}`. Errors block `spec build`.

| code | meaning / typical fix |
|---|---|
| SCHEMA | wrong field type or name: read the `path` |
| DUPLICATE_ID | ids must be unique across rooms, walls and openings |
| NO_ROOMS | empty `rooms` |
| SCALE_MISSING | px without `mmPerPx`/`calibration`: run `spec scale` |
| SCALE_INCONSISTENT | calibration refs disagree: a ref spans other faces than you think |
| DIMENSION_PRIOR | a size is implausible (e.g. a 6 m door): units mix-up |
| ROOM_NO_GEOMETRY | a room has no rect, polygon or at |
| ROOM_OPEN | the room label is not inside a closed face (walls-mode; in rooms-mode the walls around a cutout did not close — move or split the cutout) |
| ROOM_MERGED | two room labels in one face: a separating gap or wall is missing |
| ROOM_OVERLAP | rects overlap: a coordinate typo |
| FACE_UNLABELLED | an enclosed face without a room |
| AREA_MISMATCH | computed (× `labelledAreaCoef`) differs from `labelledArea`: missing cutout / step, BTI coefficient, misread number (diagnosis: SKILL.md step 7); `areaNote` downgrades it to a warning |
| TOTAL_AREA_MISMATCH | the sum differs from `labelledTotalArea` (balconies may be counted ×0.3/×0.5 in the label); `source.areaNote` downgrades it |
| CUTOUT_OUTSIDE | a cutout rect is (partly) outside its room after snapping, or covers the whole room |
| CUTOUT_OVERLAP | two cutouts overlap: an L-shaped shaft is two touching rectangles |
| CUTOUT_AT_CORNER | a cutout side runs partly on the outline and partly along the floor (it crosses the line of a reflex corner): move or trim the cutout so each side is wholly on the outline or wholly inside |
| CUTOUT_SNAPPED | info: a cutout side within 30 mm of the outline or another cutout was moved onto it |
| BUILT_SHAPE_MISMATCH | the built plan's floor (from the synthesized walls) differs from the checked shape: a wall end poking into the floor, a cutout that did not become a notch / hole, a floor strip swallowed by a wall. Error when the area differs by ≥ 0.05 m², a hole is missing or the outline is off by ≥ 300 mm; a smaller corner notch is a warning. Fix: make a cutout touch the outline exactly or keep it at least a wall thickness away from the outline and other cutouts, split an awkward one into rectangles, simplify the corner. If it persists, it is a compiler limitation: tell the user, `--force` only with their consent |
| CUTOUT_SPLITS_ROOM | cutouts cut the room into separate parts |
| CUTOUT_UNSUPPORTED | cutouts on a non-orthogonal polygon (ignored) or on a room without rect/polygon |
| CUTOUT_THIN | info: a cutout smaller than two walls; its walls were thinned |
| NON_ORTHO | a non-orthogonal edge left after snapping |
| TINY_GAP | a < 40 mm gap became an invisible separator; intended only for open-plan zones |
| WALL_THICKNESS_ODD | a thickness is far from the standard set |
| DANGLING_WALL | a wall end touches nothing |
| WALL_ALIGN_OPEN | inner/outer align used on an open path |
| OPENING_NO_POSITION | an opening without `at`, `wall` or `room` |
| OPENING_BAD_REF | unknown wall or room id |
| OPENING_OFF_WALL | `at` is too far from any wall: put it on the gap centre |
| OPENING_TOO_WIDE | wider than its wall |
| OPENING_NEAR_CORNER | too close to a wall end |
| OPENING_OVERLAP | two openings overlap |
| DOOR_BETWEEN_MISMATCH | the door connects other rooms than `between` says |
| NO_ENTRANCE | no `entranceDoor` (or door to `"outside"`) |
| ROOM_UNREACHABLE | a room that no door chain reaches from the entrance |
| NO_WINDOW | a living room or kitchen without a window (info) |
| FIXTURE_UNKNOWN | unknown fixture type |
| FIXTURE_NO_POSITION | a fixture without `rect` or `at` |
| COMPILE_FAILED | an internal error: simplify the offending geometry |

The CLI adds its own area checks (on the built plan's rooms):
- `ROOM_NOT_FOUND`, `ROOMS_SHARE_FACE`, `UNLABELLED_FACE`;
- `TECHNICAL_FACE` (info): shaft / box / column voids (any size, `technical`) and other < 1 m² niches
  without a room — expected, and out of the totals;
- `AREA_MISMATCH`: warning above max(0.15 m², 2 %), error above max(0.4 m², 5 %); an `areaNote` turns
  the error into a warning;
- `TOTAL_AREA_MISMATCH`, `LIVING_AREA_MISMATCH`.

## Build gate
`spec validate` / `spec check` end with `build gate: open` or `build gate: CLOSED`. `spec build`
refuses (exit 1, no file) while it is closed, i.e. while there is any error — unexplained area
mismatches above the error threshold included. `--force` builds anyway (tell the user the plan is known
to be off); `--strict` also refuses on warnings.
