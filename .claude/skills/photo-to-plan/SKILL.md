---
name: photo-to-plan
description: >-
  Turn a photo, scan, screenshot or PDF render of a FLOOR PLAN into an editable doplan project (.doplan).
  Use when the user sends/pastes an image of an apartment or house plan, a БТИ / техпаспорт / застройщик
  plan, a hand sketch with dimensions, or asks "нарисуй планировку по фото", "перенеси план БТИ в doplan",
  "сделай план по скану", "распознай планировку", "оцифруй план квартиры", "draw a plan from this image",
  "import this floor plan", "trace this layout", "convert this plan screenshot to doplan".
  Not for photos of real rooms or interiors (they are not plans).
argument-hint: "[path to plan image] [notes: e.g. ceiling height, which side is the entrance]"
allowed-tools: Bash(pnpm dp *), Bash(pnpm -s dp *), Read, Write, Edit, Glob
---

# Photo → plan (doplan)

You (Claude) read the plan with your own vision and write a **PlanSpec** JSON. The `pnpm dp` CLI does
everything else: image prep, coordinate grids, wall hints, validation, rendering, overlay against the
source and packing the `.doplan`. The CLI never "recognises" the plan for you: `img lines` gives
*hints* only. **Numbers printed on the plan beat anything you measure in pixels.**

Supporting files (read when needed, not upfront):
- `planspec-reference.md`: every PlanSpec field, how the compiler infers walls, all issue codes.
- `reading-plans.md`: how to read БТИ / developer plans, abbreviations, symbols, wall thicknesses.

All commands: `pnpm -s dp <group> <cmd> … [--json]`. Exit code 0 = ok, 1 = problems found, 2 = crash.
`pnpm -s dp help` lists everything. Coordinates are **pixels of the image you pass** (x right, y down).

## Procedure

Projects never go into the source repo. Everything lives in the projects folder `../dopan.projects/`
(a sibling of the repo; the paths below are relative to the repo root, so from a worktree use that
folder's absolute path): `.doplan` files in its root, incoming images in `inbox/`, work files in
`.work/<slug>/` (slug = short latin name, e.g. `kv-lenina-12`). Keep every intermediate file there;
numbered iterations make it easy to go back.

### 1. Get the file
- A path was given → use it. A file in `../dopan.projects/inbox/` → use it.
- The image was pasted into the chat (no path) → `pnpm -s dp img paste --out ../dopan.projects/inbox/` (Windows/macOS/Linux
  clipboard). If that fails, ask the user to save the image into `../dopan.projects/inbox/` and tell you the name.
- PDF / HEIC are not decoded: ask for a PNG/JPG export or a screenshot of the page.
- Several pages/images (plan + экспликация on another sheet) → process the plan image, read the
  table from the other image(s).
- `pnpm -s dp img info <file>`: size, EXIF orientation, token estimate. Do not rotate by EXIF yourself.

### 2. Prepare
```
pnpm -s dp img prep <file> --out ../dopan.projects/.work/<slug>/ [--perspective x1,y1,…,x4,y4 [--rect-mm W,H]] [--crop x,y,w,h] [--deskew] [--contrast]
```
- Always produces `work.png` (oriented, ≤ 2000 px long side, upscaled to ≥ 1000) + `prep.json`.
- `--deskew` for phone photos/scans that look tilted (auto-detects ±5°; or `--deskew 1.5`).
- `--contrast` for phone photos (uneven light, grey paper). `--gray` for colourful brochure plans.
- `--crop` to drop margins, stamps, legends and the second plan on the sheet (take crop coords from an
  `img grid` of the original). **From here on all px coordinates refer to `work.png`.**
- `--perspective x1,y1,x2,y2,x3,y3,x4,y4` when the photo was taken at an angle (trapezoid outline,
  parallel walls converge). Make an `img grid` of the ORIGINAL file and read the 4 corners of one big
  rectangle: the outer wall faces of a rectangular flat, or the frame of the sheet / drawing. Corners
  are px of the original (after EXIF orientation), any order; the warp runs before crop/deskew/resize.
  Add `--rect-mm W,H` if that rectangle's real size is printed (overall outer dimensions): the aspect
  becomes exact and `prep.json` → `perspective.workMmPerPx` gives mm per px of `work.png`. Without it the
  aspect is estimated from the photo. A 10 % margin around the rectangle is kept (dimension chains,
  balconies; `--pad 0.25` for more, `--pad 0` to crop to it); `perspective.workRectPx` says where the
  rectangle is in `work.png`. Check `work.png`: the chosen rectangle must now be square-cornered.
  Then calibrate as usual (`spec scale` from a printed dimension); the warp does not replace it.
- Perspective you cannot fix (no rectangle with 4 visible corners, strongly curved paper): ask for a
  straight-on photo or a scan; otherwise treat it as a sketch (see accuracy).

### 3. Look: grid and tiles
```
pnpm -s dp img grid  ../dopan.projects/.work/<slug>/work.png --out ../dopan.projects/.work/<slug>/grid.png
pnpm -s dp img tiles ../dopan.projects/.work/<slug>/work.png --out ../dopan.projects/.work/<slug>/tiles/ --n 2x2
```
- Read `grid.png` for the overall layout (labels on all four edges = px of work.png).
- Read every tile: they are zoomed but **labelled in work.png px**, so coordinates are directly usable.
  Large/dense plans: `--n 3x3`. Small text: `img zoom work.png --rect x,y,w,h --out z1.png`.
- Unsure whether a point is the corner you think → `img mark work.png --points "x,y;x,y" --out m.png`
  and look.
- Optional hints: `img lines work.png --out lines.json --overlay lines.png` gives axis-aligned wall bands
  with thickness in px and thickness clusters (exterior / load-bearing / partition). Use it to
  measure thicknesses and to snap your coordinates; ignore candidates that are furniture or text.

### 4. Read ALL text first (before any geometry)
Write a list in your notes (`../dopan.projects/.work/<slug>/reading.md`, short):
- every **dimension** with what it spans (`5 700: левая наружная грань → правая`, `3 200: ось A–Б`).
  Note whether a chain is outer faces, clear interior or axes;
- every **room**: number, name, area m² (from the plan or the экспликация table), Ж/П columns;
- total / living area, ceiling height (`h=2,70`, `Высота 2,7 м`), scale note (`М 1:100`);
- every **shaft, box, column, niche and step in a wall** you see (a small hatched/filled rectangle in
  a room corner, a wall that is thicker over part of its length): they make the room smaller than its
  bounding rectangle (step 6);
- which numbers are **not** dimensions: a flat number near the entrance (`171`), a door width written
  in the door gap, room numbers. A number with no dimension line or ticks is suspect;
- what is uncertain or illegible (say so instead of guessing digits).

Write the numbers **exactly as printed** (`1,75` → 1750 mm, `1,3` m² → 1.3). Never re-measure a
printed number from pixels and never round it to fit your geometry: if px and the number disagree, the
number wins and the disagreement goes to `notes`.

### 5. Calibrate the scale
Pick the **longest reliable printed dimension** (overall size is best) and its two end points in px:
```
pnpm -s dp spec scale --ref x1,y1,x2,y2 --mm 5700 --spec draft.json --label "общая ширина"
```
- Add 2–3 refs, at least one horizontal and one vertical. The command prints the mm/px, the residual of
  each ref and an anisotropy warning (photos often stretch x vs y differently; it then stores separate
  scales).
- Residual > 2 % on a ref → you picked the wrong end points or the dimension measures something else.
- No dimensions at all but room areas → draft in px, then `spec scale --from-areas draft.json`.
- Neither → ask for one known length (e.g. door = 800 mm is a last resort; write it into `notes`).

### 6. Draft the PlanSpec
Write `../dopan.projects/.work/<slug>/draft-01.json`. **Prefer rooms-mode, units `mm`, orthogonal**:
- Each room = clear interior `rect` `[x, y, w, h]` (or `polygon` for L-shapes), `labelledArea` from the
  plan, `number`, `name` as printed, `type`.
- **Walls are not written**; the compiler builds them from the gaps between rooms: gap
  ≥ 160 mm → load-bearing, 40–159 → partition, < 40 → invisible separator (open-plan zones), gap on the
  building outline → exterior (thickness from the gap or `defaults.exteriorThickness`).
  So **leave the real wall thickness as the gap** between neighbouring rects.
- Derive interior sizes from the printed numbers: BTI numbers are usually clear interior; developer
  numbers are often axis-to-axis or outer faces (subtract half/whole wall thicknesses).
- Prefer mm from dimensions. Where nothing is printed, measure px × mm/px and **round to 10 mm**.
  Alternatively draft directly in `units: "px"` with `source.calibration` and run
  `spec normalize draft.px.json --out draft-01.json` (converts to mm, snaps orthogonal, merges
  near-equal coordinates, rounds to the 10 mm grid, snaps thicknesses).
- **The room is not its bounding rectangle** when the plan shows a shaft/box/column in it, an
  L-shape or a step in a wall. Model it, or the area check will (rightly) fail:
  - shaft / vent box / column in the room → `cutouts: [{ "rect": [x, y, w, h], "kind": "shaft" | "box" | "column", "name"?: "Вентшахта" }]`
    on the room. `rect` is in plan coordinates, inside the room, the **outer** footprint of the shaft as
    seen from the room (its walls included). The compiler subtracts it from the floor, builds the shaft
    walls (`wall`, default `defaults.partitionThickness`; a `column` is solid) and leaves the void
    as a technical room, out of every total whatever its size. Cutouts touching the room outline
    become notches, free-standing ones holes; a side within 30 mm of the outline is snapped onto it.
    Cutouts must not overlap: an L-shaped shaft is two touching rects.
  - L-shapes and steps (a wall thicker over part of its length, a recess) → `polygon`. Steps are where
    two rooms' gaps differ along one wall: give each room its own true edge, the compiler builds a wall
    of the right thickness on each part and joins them.
  - Rooms on the same side of one straight wall share its line: give their edges the **same**
    coordinate (a hall and a storeroom both ending at x = 3020). A 20–40 mm difference read off the
    pixels makes two offset walls that do not meet, and the rooms behind them stay open.
  - Do not model a shaft as a `fixture` only: fixtures (`riser`, `ventShaft`) are drawn but do **not**
    reduce the room area.
- **Loggia / balcony areas** on BTI plans are often printed with the coefficient (loggia ×0.5, balcony
  ×0.3): a 1.2 × 2.2 m loggia is labelled `1,3`. Then set `labelledAreaCoef: 0.5` (0.3 for a balcony)
  and keep `labelledArea` as printed. **Recover the real depth from the label**: depth = labelled ÷ k ÷
  length (1.3 ÷ 0.5 ÷ 2.2 = 1.18 m), never from px. See `reading-plans.md`.
- Openings: put `at` on the wall centre line, `width` = clear opening; doors get `between`, `opensInto`
  and `hinge` (read the arc); windows get `sill`/`height` only if known (defaults otherwise).
  Entrance door: `entranceDoor`, `between: [room, "outside"]`.
- Fixtures that define the plan: risers (`riser`; shafts are `cutouts`, see above), bathtub, shower, toilet,
  washbasin, kitchen sink, stove. Skip decorative furniture unless the user wants it.
- `source`: `image` (relative to the spec file or absolute), `size` (work.png px), `mmPerPx` and
  `originPx` (px of the spec origin, so the underlay lines up), `labelledTotalArea`,
  `labelledLivingArea`, `kind` (`bti` | `developer` | `sketch` | `photo` | `other`).
- `notes`: every assumption (unlabelled wall thickness, guessed door swing, illegible digit).

### 7. Validate
```
pnpm -s dp spec validate ../dopan.projects/.work/<slug>/draft-01.json
```
Fix every **error** (exit 1). Warnings to take seriously: `AREA_MISMATCH` (room off by > 2–5 %),
`TOTAL_AREA_MISMATCH`, `ROOM_MERGED` (two rooms not separated: a wall gap is missing),
`OPENING_OFF_WALL`, `ROOM_UNREACHABLE`, `NO_ENTRANCE`, `TINY_GAP`, `SCALE_INCONSISTENT`.
Codes are explained in `planspec-reference.md`.

**An area mismatch means you misread the plan.** Do not tweak sizes until the number fits; find why:
1. computed > label by roughly a shaft/column (0.2–1.5 m²) → a cutout is missing (step 6);
2. computed > label along one side → a step in a wall, a thicker wall, an L-shape → `polygon`;
3. outdoor room computed ≈ 2× (or ≈ 3.3×) the label → the label carries the BTI coefficient →
   `labelledAreaCoef` (the validator suggests it);
4. one side was measured in px while a printed number exists → use the number;
5. the printed side lengths themselves multiply to a different area (the plan contradicts itself, a
   digit is illegible) → keep the printed numbers and explain it in the room's `areaNote`.
Only (5) — a difference you understand and cannot remove — goes into `areaNote` (`source.areaNote`
for the total). An explained mismatch is reported as a warning instead of an error.

`BUILT_SHAPE_MISMATCH` (error) means the walls the compiler synthesized do not give the floor you
checked (a cutout too close to the outline or to another cutout, an awkward corner): the .doplan
would show other areas. Move or split the cutout as the message says; never `areaNote` it.

`spec validate` ends with the **build gate** line: `spec build` refuses a spec with errors, including
unexplained area mismatches above max(0.4 m², 5 %). `--force` overrides it (say so to the user);
`--strict` also blocks on warnings.

### 8. Render + overlay, compare, fix (max 4 rounds)
```
pnpm -s dp spec check ../dopan.projects/.work/<slug>/draft-01.json --out-dir ../dopan.projects/.work/<slug>/ --image ../dopan.projects/.work/<slug>/work.png --iter 1
```
(= validate + `spec render` + `spec overlay`; files `render-01.png`, `overlay-01.png`, `check-01.json`.)
- **Look at `overlay-01.png`**: magenta = your walls, blue = doors/labels, green = windows over the
  source. Boxes `M1…` = source wall ink your plan misses, `E1…` = your walls where the source has none.
  `wall IoU` ≥ 0.6 is typical for a good match on a clean plan (photos/brochures score lower; judge
  visually).
- Look at `render-01.png` as an architect would: closed rooms, doors on the right walls, swing sides,
  windows on exterior walls, balcony outside the exterior wall.
- Fix → `draft-02.json` → `--iter 2` … Stop after 4 rounds; leave remaining doubts in `notes`.
- Need the overlay alone: `spec overlay draft.json --image work.png --out ov.png`; render alone:
  `spec render draft.json --out r.png [--frame source]`.

### 9. Build the project
```
pnpm -s dp spec build ../dopan.projects/.work/<slug>/draft-0N.json --out ../dopan.projects/<Name>.doplan --name "<Name>" [--open]
```
Refuses (exit 1, nothing written) while the build gate is closed: fix the errors or explain known area
differences in `areaNote`; `--force` only when the user agrees to a plan that is known to be off.
Packs `manifest.json + doc.json + assets/` and embeds the source image as a locked underlay (unless
`--no-underlay`). `--open` launches the installed app (or the dev build). `doc info <file>` prints
rooms/areas from the built project; `doc render` re-renders it. Save the `.doplan` in `../dopan.projects/`
unless the user named another place; never in the repo.

### 10. Report to the user (Russian if they wrote Russian)
Short: where the file is; rooms with computed vs labelled area; total; **what was assumed**
(everything in `notes`: thicknesses, door swings, illegible numbers, scale source); what to check in the
app (the underlay is on its own layer; walls can be dragged). Do not claim accuracy you did not verify.

## Accuracy rules
1. **Printed numbers win.** Dimensions > areas > measured px. Never "correct" a printed number to fit
   your geometry; if they conflict, re-check which faces the dimension spans, then note the conflict.
2. **Orthogonal by default.** Real flats are rectilinear; a 1–3° slant is a photo artefact. Use
   polygons with non-90° edges only when the plan clearly draws a bay/angled wall.
3. **Round**: coordinates and sizes to 10 mm; wall thicknesses to standard values (80, 100, 120, 150,
   160, 180, 200, 250, 300, 380, 400, 510, 640).
4. **Areas check geometry**: each room's computed area within ~2 % (min 0.15 m²) of the label. Bigger
   miss → a dimension is misread, a wall gap is wrong, a shaft/step is missing, or the label carries a
   BTI coefficient (diagnosis in step 7). Total area in BTI excludes balconies (or counts them ×0.3 /
   loggias ×0.5; see `reading-plans.md`). Never leave a mismatch silently: fix it or `areaNote` it.
5. **Consistency along chains**: room widths + wall thicknesses must sum to the overall dimension.
   Check every row and column of rooms this way before validating.
6. **Do not invent**: no doors/windows that are not drawn; no furniture by default. Unknown door swing
   → omit `hinge`/`opensInto` and note it.
7. **One plan per spec.** Multi-level houses: one spec per level (separate builds) unless told otherwise.
8. If the image is a photo of a real room (not a plan), a 3D render or an elevation, stop and explain;
   offer to draw the plan from dimensions the user dictates instead.

## Dimension provenance (`source`) — always fill it
The app shows the user where every clear dimension came from (italic grey `≈` = estimated, ✓ = measured)
and uses it for the area report, the «Обмер» checklist and furniture clearance warnings. So tell it:

| value | when | tolerance |
|---|---|---|
| `plan` | the side length is a number printed on the plan (БТИ/застройщик) | ±10 mm |
| `derived` | computed: area ÷ other side, or a chain of printed numbers minus walls | ±20 mm |
| `estimated` | not printed, read from photo pixels | ±50 mm |
| `measured` | the user gave a tape/laser value (add `date`) | ±2 mm |
| `drawn` | unknown (the default when omitted) | — |

- Room: `"source": "plan"` for all sides, or by side for a `rect`:
  `"source": { "top": "plan", "bottom": "plan", "left": "derived", "right": { "source": "estimated", "tol": 80 } }`
  (or an array `[top, right, bottom, left]`); for a `polygon` an array by edge (edge i = point i → i+1).
- Wall (walls-mode): `"source"` = one value or one per path segment; it applies to both faces.
- Top-level `"dimSource"`: default for every side without its own; for `units: "px"` the default is `estimated`.
- Object form `{ "source": "measured", "tol": 3, "date": "2026-11-01", "note": "лазер" }`.
- Be honest: a side the plan does not print is `derived` or `estimated`, never `plan`. Keep `labelledArea`
  and `source.labelledTotalArea`/`labelledLivingArea`: the app compares them with the geometry and flags
  plans whose printed numbers contradict each other.

## Worked example (2-room flat with a balcony, rooms-mode)
The repo contains it: `tools/dp/examples/two-room.planspec.json` (`pnpm exec tsx tools/dp/smoke.ts`
runs the whole chain on it). Abridged:

```json
{
  "version": 1, "units": "mm", "name": "2-комн. 57,4 м²",
  "source": { "image": "work.png", "size": [960, 1160], "kind": "bti", "mmPerPx": 10, "originPx": [100, 100],
              "labelledTotalArea": 57.4, "labelledLivingArea": 33.1 },
  "defaults": { "ceilingHeight": 2700, "exteriorThickness": 300, "partitionThickness": 100 },
  "rooms": [
    { "id": "bath",    "number": "1", "name": "С/у",      "type": "combinedBathroom", "rect": [0, 0, 1700, 2200],    "labelledArea": 3.7 },
    { "id": "ward",    "number": "2", "name": "Гардероб", "type": "wardrobe",         "rect": [0, 2300, 1700, 900],  "labelledArea": 1.5 },
    { "id": "hall",    "number": "3", "name": "Прихожая", "type": "hall",             "rect": [1800, 0, 3000, 3200], "labelledArea": 9.6 },
    { "id": "kitchen", "number": "4", "name": "Кухня",    "type": "kitchen",          "rect": [4900, 0, 2500, 3200], "labelledArea": 8.0 },
    { "id": "bed",     "number": "5", "name": "Спальня",  "type": "bedroom",          "rect": [0, 3400, 3300, 4600], "labelledArea": 15.2 },
    { "id": "living",  "number": "6", "name": "Гостиная", "type": "living",           "rect": [3500, 3400, 3900, 4600], "labelledArea": 17.9 },
    { "id": "balc",    "number": "7", "name": "Балкон",   "type": "balcony",          "rect": [3500, 8300, 3900, 1200], "labelledArea": 4.7,
      "edgeWall": { "kind": "railing", "thickness": 100, "height": 1100 } }
  ],
  "openings": [
    { "type": "entranceDoor", "at": [3050, -150], "width": 900, "between": ["hall", "outside"], "opensInto": "outside", "hinge": "left" },
    { "type": "door",  "at": [1750, 1000], "width": 700, "between": ["bath", "hall"], "opensInto": "hall", "hinge": "right" },
    { "type": "slidingDoor", "at": [1750, 2750], "width": 700, "between": ["ward", "hall"] },
    { "type": "door",  "at": [4850, 2400], "width": 800, "between": ["hall", "kitchen"], "opensInto": "kitchen", "hinge": "left" },
    { "type": "door",  "at": [2500, 3300], "width": 800, "between": ["hall", "bed"], "opensInto": "bed", "hinge": "right" },
    { "type": "door",  "at": [4100, 3300], "width": 800, "between": ["hall", "living"], "opensInto": "living", "hinge": "left" },
    { "type": "balconyDoor", "at": [4300, 8150], "width": 800, "between": ["living", "balc"], "opensInto": "living", "hinge": "left" },
    { "type": "window", "at": [7550, 1600], "width": 1200, "sill": 850, "height": 1500 },
    { "type": "window", "at": [1650, 8150], "width": 1500 },
    { "type": "window", "at": [5800, 8150], "width": 1800 }
  ],
  "fixtures": [
    { "type": "riser",   "rect": [1450, 1950, 250, 250] },
    { "type": "bathtub", "rect": [0, 0, 1700, 700] },
    { "type": "toilet",  "at": [300, 1500], "rotation": 90 },
    { "type": "stove",   "rect": [6800, 300, 600, 600] }
  ],
  "notes": ["Толщина наружной стены не подписана — принято 300 мм", "Ширина входной двери оценена ≈900 мм"]
}
```
How to read it: origin `[0,0]` = inner top-left corner of the bathroom. Gap 100 mm between `bath` and
`hall` (x 1700→1800) becomes a 100 mm partition; gap 200 mm between the hall row and the bedroom row
(y 3200→3400) becomes a load-bearing wall; the outline gets 300 mm exterior walls; the balcony sits
300 mm below the living room (y 8000→8300), so its wall is exterior and the railing closes the balcony's
free edges. The entrance door's `at` y = −150 is the centre line of the 300 mm top exterior wall.
Each door's `at` lies in the middle of the gap it pierces; `hinge` is seen from the room it opens into.
