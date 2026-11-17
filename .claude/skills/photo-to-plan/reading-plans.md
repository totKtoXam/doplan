# Reading Russian floor plans

## Kinds of source
| kind | look | dimensions | areas | pitfalls |
|---|---|---|---|---|
| **БТИ / техпаспорт / поэтажный план** | thin black lines, walls hatched or filled, rooms numbered (1, 2, 3… or 1а), экспликация table | clear interior sizes in **metres with a comma** (`3,25`) or mm, written inside rooms along the walls | in the room: `15,2` or in a circle/fraction `5 / 15,2` (number / area) | old scans are skewed and stretched; the numbering continues across the floor; hand-written corrections |
| **Застройщик (developer brochure)** | coloured fills, furniture, a compass, "ЖК …" logo | often none, or overall/axis dimensions in mm (`5700`) | `Кухня 12,4 м²` | proportions are approximate; furniture hides walls; sometimes mirrored versions |
| **Sketch / hand drawing** | not to scale | numbers only | maybe | geometry comes only from the numbers (`source.toScale: false`) |
| **Phone photo of a sheet** | perspective, shadow, curved paper | as the original | as the original | use `--contrast --deskew`; trapezoidal → `--perspective` on 4 corners of the outer walls / sheet frame |
| **Architectural / project drawing** | axes with letters and numbers (А–Г, 1–5) in circles, dimension chains in mm | axis-to-axis and wall-face chains | in the room or the table | dimensions to axes: subtract half-walls |

## Abbreviations
| abbreviation | room | PlanSpec `type` |
|---|---|---|
| Ж / жил. | жилая (living area) | — |
| К / Кух. | кухня | `kitchen` |
| Кух.-гост., К-Г, кухня-столовая | kitchen-living | `kitchenLiving` |
| Комн., Ж.к. | жилая комната | `living` or `bedroom` (name as printed) |
| Спальня / Детская / Кабинет | | `bedroom` / `kids` / `office` |
| Пр. / Прих. / Холл | прихожая | `hallway` (`hall`) |
| Кор. | коридор | `corridor` |
| С/у, Сов. с/у | combined bathroom | `bathroom` |
| Ван. / В. | ванная | `bathroom` |
| Т / Туал. / WC | туалет | `toilet` |
| Гард. / Гардер. / Г.к. | гардероб | `wardrobe` |
| Кл. / Кладов. / Хоз. / Пост. | кладовая, хоз. помещение | `storage` |
| Лодж. / Л | лоджия | `loggia` |
| Балк. / Б | балкон | `balcony` |
| Терр. | терраса | `terrace` |
| Тамб. | тамбур | `hallway` |

Marks drawn in the plan, which are not rooms:
- **в/ш, вент., ВК** — вентшахта. Cut it out of the room it stands in (`cutouts`, `kind: "shaft"`);
  a `ventShaft` fixture alone does not reduce the room area.
- **ст., стояк, Ст1** — riser. A thin riser in a box: `cutouts` with `kind: "box"`; a pipe with no
  box: fixture `riser`.
- **h=2,70 / Н=2,70** — ceiling height in m. Put it in `defaults.ceilingHeight` (mm).
- **М 1:100 / 1:50** — paper scale. It is useless for a photo; calibrate with a dimension instead.

## Экспликация (BTI room table)
Columns are usually:
1. № помещения (flat/room number);
2. наименование;
3. площадь общая;
4. в т.ч. жилая (Ж);
5. подсобная (П);
6. лоджий/балконов, sometimes with the coefficient;
7. высота.

Take each room's area from the table, matching by the number written in the room. Totals:
- **общая площадь** (total);
- **жилая** (living, the sum of Ж);
- **с учётом летних помещений**: balcony ×0.3, loggia ×0.5, terrace ×0.3.

Put the total *without* summer rooms in `labelledTotalArea` if the table gives it; otherwise the
printed total with a note. Numbers use a decimal comma: `15,2` means 15.2.

## Loggia and balcony areas: the coefficient
BTI often prints the area of a loggia/balcony **already multiplied** by the summer coefficient:

| room | coefficient | a 1.2 × 2.2 m (2.64 m²) room is printed as |
|---|---|---|
| лоджия | 0.5 | `1,3` |
| балкон, терраса | 0.3 | `0,8` |

How to tell: the printed area is much smaller than the room's drawn size (about ½ or ⅓ of it); the
экспликация puts it in a "лоджий/балконов" column, sometimes with "(к=0,5)" / "с коэф."; the total
"с учётом летних помещений" adds exactly these reduced numbers.

What to write:
- `labelledArea`: the number **as printed** (1.3);
- `labelledAreaCoef`: 0.5 for a loggia, 0.3 for a balcony / terrace. The check then compares
  clear area × k with the label; the project keeps the clear area (2.6 m²).

**Recovering the real depth.** The drawn depth of a loggia is the least reliable size on a plan (thin
lines, the parapet drawn over the slab edge). When one side is printed or clearly bounded by the
neighbouring rooms (the length along the facade), take the other from the label:
`depth = labelled ÷ k ÷ length`, e.g. 1.3 ÷ 0.5 ÷ 2.2 = 1.18 m → 1180 mm. Note it in `notes`
("глубина лоджии из площади 1,3 с к=0,5"). Mind the rounding: a label of 1.3 means 1.25–1.35, so the
depth is only known to ±4 %.

If the printed area matches the clear area (no coefficient), leave `labelledAreaCoef` out. The
validator suggests the coefficient when an outdoor room is ≈ 2× or ≈ 3.3× its label.

## BTI marks that are not dimensions
- A number at the entrance door or in the stairwell (`171`, `кв. 45`) is the **flat number**.
- A number in a door gap is the door width; a number in a window opening is the window width.
- Short ticks across a wall line mark where a dimension starts/ends; read which faces they touch.
- Room sizes are written along the inner side of the walls they measure; a size written next to a
  short wall segment (`1,65`) belongs to that segment (e.g. the side of an L-shaped room), not to
  the whole room.

## Shafts, boxes, columns and steps
A room's printed area is its **clear floor**: shafts, ventilation boxes and columns inside it are
excluded. They are drawn as small hatched or filled rectangles in a corner or at a wall, often with
"в/ш". Model each one as a cutout of the room (`cutouts` in `planspec-reference.md`): its `rect` is
the outer footprint seen from the room, including its walls. A shaft against a wall gets the wall's
coordinate exactly (a few mm off is snapped); an L-shaped shaft is two touching rectangles. A large
shaft (over 1 m²) is still a void, not a room: it never counts in the areas.

A wall that changes thickness along its length (a step: a pilaster, a thicker part next to a shaft)
makes the room an L-shape: use a `polygon` with the step. Signs: the wall line jumps; the clear sizes
printed on opposite sides of the room differ; the area is smaller than width × depth.

When the area of a room does not match: subtract what the plan shows first (cutouts, steps), then
check the coefficient (outdoor rooms), and only then doubt a printed number.

## Wall thickness conventions (mm)
| wall | typical |
|---|---|
| monolith/panel exterior (with insulation) | 300–510 (300, 380, 400, 510); brick 510 or 640 |
| panel/monolith load-bearing interior | 160–200 (panel 140–180, monolith 200–250) |
| partition (gypsum/foam block) | 80–120 (gypsum 80, block 100–120) |
| brick partition | 120 (half brick) |
| bathroom partition | 80–120 |
| inter-apartment | 200–250 |

How to read thickness on the drawing:
- **Hatched or black filled** walls are load-bearing or exterior.
- **Thin double lines or a single line** are partitions.
- Measure thick walls with `img lines`; pick the standard value nearest to px·mmPerPx.
- BTI room dimensions are clear interior, so walls are what is left between them. Check:
  Σ room widths + Σ wall thicknesses = overall dimension.

## Symbols
- **Door:** a gap in the wall with a quarter arc. The arc shows the swing.
  - `opensInto` = the room containing the arc.
  - `hinge` = the end of the opening where the arc's centre is, as seen from inside that room,
    facing the door.
  - Two arcs = `doubleDoor`. Parallel offset lines and no arc = `slidingDoor`. A gap with no leaf =
    `opening`/`arch`.
  - BTI rarely draws arcs; then omit swing and note it.
- **Entrance:** often a heavier door, an arrow, or "вход". Use `entranceDoor` to `outside`.
- **Window:** 2–3 thin parallel lines across an exterior wall, sometimes with a sill line.
  `frenchWindow` = floor to ceiling. A door + window to a balcony is `balconyBlock`, or a
  `balconyDoor` + a `window` next to it.
- **Balcony vs loggia:**
  - балкон sticks out of the facade; it is bordered by a thin railing line on three sides.
  - лоджия is recessed, bounded by walls on three sides and glazing or a railing on one.
  - Both are outdoor rooms: use `edgeWall` (`railing` or `parapet`), or `glazed: true` for a glazed
    loggia.
- **Plumbing:** bathtub rectangle with rounded inner, toilet oval, sink, square shower tray with a
  cross. Kitchen: stove with 4 circles, sink.
- **Columns / shafts:** small filled squares or rectangles (often hatched) inside or at walls. Cut them
  out of the room (`cutouts`), see "Shafts, boxes, columns and steps".
- **Dimension lines:** a line with ticks or arrows and the number above it. Check which faces the
  ticks touch: inner faces, outer faces, or axes.

## Numbering
- BTI numbers rooms clockwise from the entrance, 1…n, inside a circle or as a fraction
  `номер / площадь`. Keep it in `room.number`.
- Developer plans number rooms by a legend (1 — Кухня, 2 — …): match the numbers to the legend.
- Rooms on a flat/floor sheet may be numbered across several apartments. Take only the target flat.
