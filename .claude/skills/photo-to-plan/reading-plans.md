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
- **в/ш, вент., ВК** — вентшахта. Use fixture `ventShaft`.
- **ст., стояк, Ст1** — riser. Use `riser`.
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
- **Columns / shafts:** small filled squares or rectangles (often hatched) inside or at walls.
- **Dimension lines:** a line with ticks or arrows and the number above it. Check which faces the
  ticks touch: inner faces, outer faces, or axes.

## Numbering
- BTI numbers rooms clockwise from the entrance, 1…n, inside a circle or as a fraction
  `номер / площадь`. Keep it in `room.number`.
- Developer plans number rooms by a legend (1 — Кухня, 2 — …): match the numbers to the legend.
- Rooms on a flat/floor sheet may be numbered across several apartments. Take only the target flat.
