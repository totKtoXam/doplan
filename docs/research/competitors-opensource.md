# doplan: competitors and open-source prior art

Date: 2026-11-12. Items marked (V) were verified against the repo page today; (M) are from prior knowledge and not re-verified (check before relying on them). We write our own code; only ideas are reused.

## 1. Commercial / desktop tools (ideas only, all closed or copyleft)

| Tool | Licence | What to steal | What to avoid |
|---|---|---|---|
| Sweet Home 3D (M) | GPL-2+ (Java) | Wall graph with explicit start/end points and per-wall thickness/height/left+right side materials; rooms are explicit polygons (double-click inside closed walls auto-creates a room from the wall loop); doors/windows are furniture items that "cut" the wall (boolean on wall mesh); furniture catalog with properties (model, size, elevation, colour/texture/material override); levels; plugin system; XML+zip `.sh3d` (Home.xml + assets). Strong constraint: GPL, so no code copying. | 3D view is old-school (Java3D); photo render is via Sunflow/yafaray plugin; weak PBR. |
| SketchUp (M) | proprietary | Push/pull inference, snapping inference engine (endpoint, midpoint, on-edge, axis lock), component instances with shared definitions, groups, layers/tags. | Mesh-first modelling leads to non-parametric walls; do not copy. |
| Chief Architect / Home Designer (M) | proprietary | Parametric wall types (layered assemblies), auto roof, auto-dimensions, auto-framing, catalog browser, cabinet configurators, materials per surface, 2D/3D linked live. This is the feature bar for "configurable everything". | Huge scope; do not chase BIM depth. |
| Blender + Archipack / Bonsai (BlenderBIM) (M) | GPL-3 | Bonsai uses IFC as the native data model (IfcWall, IfcOpeningElement/IfcRelVoidsElement for openings, IfcRelFillsElement for doors in openings, IfcSpace for rooms, IfcRelAggregates for storeys); Archipack: parametric objects with modifiers. Good reference for wall-join and opening-void semantics. | GPL; Blender is its own app. |
| FreeCAD Arch/BIM (M) | LGPL-2+ | Wall = base line + width/height/alignment (left/center/right); openings as subtraction children (Window "hosted" in wall); IFC export. | OpenCASCADE B-rep booleans are too heavy for the web; not applicable. |

## 2. Open-source three.js / web projects

| Project | Licence | Data model | 3D meshing | Notes |
|---|---|---|---|---|
| blueprint3d (furnishup) (V licence) | MIT, (c) 2015 FurnishUp | Classic corner/wall graph: `Corner{x,y}`, `Wall{start,end,thickness,height}`, `Room` derived by detecting closed cycles in the graph (rooms are NOT stored). Items (`Item` subclasses: floor, wall, in-wall, on-floor, roof) with `{type, model url, position, rotation, scale}`. | Each wall extruded as a ShapeGeometry-like box with texture; doors cut out via item "in wall" snapping; floors = ShapeGeometry from room cycle. | Repo structure: core / floorplanner / items / model / three. README itself lists "better serialization format" as a TODO, i.e. no formal schema (V). Largely dormant, 2015-era TS; the many forks are unmaintained. Good as a reference for room-from-cycles and item-wall snapping (item has `boundToFloor`, `obstructFloor`, `obstructWall` flags and `wallitem` snaps to wall plane). |
| react-planner (cvdlab) (V licence) | MIT | Normalised, Immutable.js state: `layers -> {vertices, lines, holes, areas, items, groups}`. Lines = walls referencing 2 vertices; holes = openings placed on a line with `offset` in 0..1; areas = rooms derived from lines, holding vertex ids. Catalog of elements with property schemas. Redux + Immutable. | Per-element 2D and 3D renderers declared in the catalog (plugin-like). | Undo = history stack of states (structural sharing via Immutable). Offset-as-ratio for openings is a good idea (survives wall resize). Heavy Immutable/Redux; stale. |
| openPlan3D (laanlabs) (V) | MIT | Walls, doors, windows, stairs, rooms, furniture, annotations, layers. Project JSON + ZIP package + versioned interchange JSON; exports SVG, DXF, PDF, PNG. SvelteKit + three.js + jsPDF + dxf-writer. Active 2026. | n/a (not inspected) | Most relevant recent product: confirms export stack (dxf-writer, jsPDF) and the versioned-handoff-format idea. Inspect its docs for schema ideas. |
| Pascal Editor (pascalorg/editor) (V) | MIT | Scene graph: sites -> buildings -> levels -> walls, slabs, roofs, openings, rooms, furniture; IFC import converts to native nodes; SQLite persistence. R3F + WebGPU, Bun/Turbo. 25.5k stars. 3D-first (no real 2D drafting per search summary, M). | R3F/WebGPU node components. | Good hierarchy model (site/building/level). Because it is MIT we may read it, but its WebGPU path is risky on Intel Arc/Electron; we want WebGL2 first. |
| OpenFPC (socialtables) (M) | archived 2023 | 2D CAD on React + three + Immutable | | Do not use. |
| house-planner (egmalt) (M, MIT) | MIT | Konva 2D + R3F 3D; walls as axis line + thickness + height | | Simple reference for Konva 2D. |
| homemaker (opening-design), arcada | not verified (repo URLs I tried returned 404) | homemaker (M): grammar-based generation of building shapes from a topological graph (nested cells, faces, edges); arcada: unverified. | | Skip; revisit only if auto-generation is wanted. |
| That Open Company: web-ifc (V) | MPL-2.0 | WASM IFC reader/writer, SIMD builds | | Use as optional IFC import/export engine; MPL is file-level copyleft so dynamic use as a dependency is fine. |
| That Open: @thatopen/fragments (V) | MIT | FlatBuffers binary BIM format + three viewer | | Overkill for houses; only if we do large IFC. |

## 3. Cross-cutting lessons

1. Everyone who survived uses a wall graph (vertices/corners + edges with thickness/height) with openings hosted on walls by parametric offset, rooms as polygons detected from closed loops. Pure mesh editing (SketchUp style) gives no live 2D/3D link.
2. Derived rooms (blueprint3d) are fragile: any gap of 1 cm breaks detection and the room silently vanishes; room metadata (name, floor material) is lost on re-detection. Fix: derive the geometry but persist rooms as entities keyed by a stable set of wall ids; re-match on change.
3. Wall joins are the hard part. Mitre at corners needs the left/right offset polylines of each wall intersected with neighbours; T-junctions and 3+ wall corners need sorting edges by angle around the vertex. Most simple tools just extrude boxes and overlap, which z-fights and breaks textures.
4. Openings: subtract rectangles from the wall's side faces. Do it in 2D on the wall elevation (wall = polygon in (u,v) with holes) then triangulate (earcut) rather than 3D CSG; this is fast, robust, and gives UVs for free. Add reveal/jamb faces explicitly.
5. Snapping: items carry a snap type (floor / wall-face / ceiling / on-item) and a local anchor; wall-hosted items store `{wallId, u, elevation, side}`, not world coordinates, so they follow wall edits.
6. Undo: command/patch based (Immer patches or per-op inverse), not full snapshots, once scenes hold imported assets by reference.
7. File format: versioned JSON (schemaVersion + migrations) in a ZIP with assets, as Sweet Home 3D and openPlan3D do. IFC as export only.
8. Licence rules: GPL tools (Sweet Home 3D, Blender, Bonsai) must not be copied or linked; MIT repos (blueprint3d, react-planner, openPlan3D, Pascal) may be read, and short snippets copied with attribution, but we implement independently.

## 4. Recommended doplan data model

Units: SI metres as float64 in memory and file; display in mm/cm/m/ft-in by preference. Y-up in 3D; plan coordinates (x, y) map to 3D (x, -z). Snap grid defaults 1 cm for geometry; round on write to 1 mm to avoid drift.

IDs: ULID-like strings (time-sortable) generated locally, prefixed by type (`w_`, `v_`). Never indices.

Store: normalised maps `{[id]: entity}` per type plus ordered child lists; derived data (meshes, room polygons, bounding boxes) never persisted.

Entities:
- Project: `{schemaVersion, units, meta, levels[], materials{}, assets{}}`.
- Level: `{id, name, elevation, height, slabThickness}`. Everything below belongs to one level (`levelId`).
- Vertex: `{id, levelId, x, y}`. Shared by walls so joins are topological.
- Wall: `{id, levelId, a: vertexId, b: vertexId, thickness, height, alignment: left|center|right, curve?: bulge, leftMat, rightMat, topMat, baseboard?, type: wallTypeId}` (wall types = layered assemblies, optional later).
- Opening (door/window/arch/niche): `{id, wallId, u (distance from a, metres), sill, width, height, assetId, flip, hinge, props}`. Store `u` in metres plus a flag for "anchored to a or b" (react-planner uses a ratio; metres are more predictable for users and we re-clamp on wall resize).
- Room: `{id, levelId, name, wallIds[] (set that defines the loop), holes?, floorMat, ceilingMat, floorHeightOffset, ceiling: {type, height, mat}, tags}`. Polygon derived from the wall loop; re-matched by wall-id overlap after edits. Also allow free "zone" polygons not tied to walls (balcony, terrace).
- Slab/Ceiling: derived from room by default, overridable with explicit polygon.
- Item (furniture/appliance/decor/curtain/light): `{id, levelId, assetId, transform: {pos, rotY, scale}, host: {kind: floor|wall|ceiling|item, id, u, v, side}, overrides: {materialSlot -> materialId}, params}`.
- Stairs, Roof, Column: parametric nodes with own params (phase 2).
- Material: `{id, kind: pbr, color, maps: {albedo, normal, rough, metal, ao}, tiling: {worldSizeM: [w,h], rotation, offset}, tile: {pattern, groutWidth, groutColor}}`. Tile and floor patterns are parameters of the material applied by UV in world units, not texture baking.
- Asset: `{id, name, category, source, licence, glb path/hash, footprint, snapType, anchor, materialSlots, thumbnails}`. Assets are content-addressed (sha256) in the project ZIP.
- Annotation: dimensions, text, labels (2D only).

Relations: Level 1-n {Vertex, Wall, Room, Item}; Wall 2-1 Vertex; Opening n-1 Wall; Room n-m Wall; Item n-1 host.

Operations: all edits are commands producing Immer patches + inverse patches; history is a bounded patch stack; autosave appends; project file = ZIP{project.json, assets/<sha>.glb, textures, thumbs}. Migrations are pure functions `vN -> vN+1` tested on fixtures.

## 5. Pitfalls to avoid

- Floating-point vertex matching: use a spatial hash with epsilon 1 mm and snap-to-existing-vertex rather than comparing coordinates.
- Rooms stored only as derived data (lose materials on edit) or only as explicit polygons (desync from walls). Use the hybrid above.
- Wall-hosted items in world coordinates.
- 3D CSG for openings; per-frame regeneration of all wall geometry. Rebuild only dirty walls/rooms, keep geometry in per-level merged buffers, instance repeated assets.
- Mixed units and Y/Z flipping bugs: fix the convention once and test it.
- Overlapping coplanar faces (z-fighting) at wall joins and wall/floor intersections.
- Coupling the data model to React state or to three.js objects; keep a pure TS core package (no DOM) usable in worker for meshing, export and tests.
- Immutable.js/Redux-scale ceremony (react-planner); WebGPU as the only renderer (Pascal) on an Intel Arc target; unversioned save format (blueprint3d).
- Copying GPL code from Sweet Home 3D / Bonsai.
- Importing arbitrary GLB without budget: validate triangle count, texture size, convert to KTX2/meshopt at import.

## Sources checked today
- github.com/pascalorg/editor (MIT, 25.5k stars)
- github.com/furnishup/blueprint3d (MIT, 2015 FurnishUp)
- github.com/cvdlab/react-planner (MIT)
- github.com/laanlabs/openPlan3D (MIT)
- github.com/ThatOpen/engine_web-ifc (MPL-2.0), engine_fragment (MIT)
- Web search for other 2024-2026 planners (OpenFPC archived 2023; house-planner)
