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
{ id, name?, type?, number?, rect? | polygon? | at?, labelledArea?, ceilingHeight?, edgeWall?, balcony?, glazed?, confidence? }
```
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
| ROOM_OPEN | the room label is not inside a closed face (walls-mode) |
| ROOM_MERGED | two room labels in one face: a separating gap or wall is missing |
| ROOM_OVERLAP | rects overlap: a coordinate typo |
| FACE_UNLABELLED | an enclosed face without a room |
| AREA_MISMATCH | computed area differs from `labelledArea`: re-check the dimensions |
| TOTAL_AREA_MISMATCH | the sum differs from `labelledTotalArea` (balconies may be counted ×0.3/×0.5 in the label) |
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

The CLI adds its own area checks:
- `ROOM_NOT_FOUND`, `ROOMS_SHARE_FACE`, `UNLABELLED_FACE`;
- `AREA_MISMATCH`: warning above max(0.15 m², 2 %), error above max(0.4 m², 5 %);
- `TOTAL_AREA_MISMATCH`, `LIVING_AREA_MISMATCH`.
