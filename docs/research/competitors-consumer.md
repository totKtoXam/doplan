# Consumer floor-plan / interior apps: competitor analysis for doplan

Date: 2026-11-12. Evidence level: web search snippets (aggregators, vendor help centers, Trustpilot pages). Pricing figures conflict across sources and are marked "unverified". Items from memory are marked (M). Verify pricing on vendor pages before any public positioning.

## Sources actually consulted
- Planner 5D help: upload floor plan / AI recognition (support.planner5d.com), B2B recognition page (tool.planner5d.com)
- Coohom help center: upload CAD/image floor plans; Coohom articles on AI 2D to 3D (self-promotional)
- Trustpilot Planner 5D pages and checkthat.ai/Kimola summaries (about 2.5/5, 816 reviews, July 2026)
- Live Home 3D store/tech-specs pages (livehome3d.com), App Store listings
- IKEA Kreativ help articles (room scan LiDAR-only in app; web version uses Room Builder)
- Roundups: spacedesigner3d, spotsaas, remodelai, itechguides, roomsketcher blog

## Per-app notes

**Planner 5D** (web, iOS, Android, desktop). Easiest 2D: draw walls/rooms, drag doors/windows, auto-furnish. Catalog about 8,000+ items (vendor-comparison figure). 3D is realtime with snapshot "HD renders" (cloud, credit/subscription gated). AI plan recognition: upload image, 1 floor per image, high contrast, crop whitespace; PRO only; human review on B2B channel. Free exports watermarked. Main complaint: billing (trial converts to annual, hard cancellation, refunds), then slow performance, overlapping walls, lost projects, recognition failures. Lesson: a local-first desktop app with no subscription trap is a real selling point.

**Homestyler** (Easyhome/Coohom family-adjacent). Strong catalog (vendor claims "10M+" items, unverified), good free render allowance, cloud renders, many branded/Chinese-market products. Quality of looks is highest among free tools. Complaints (M): clutter, paywalled HD render, upsell.

**Coohom**. Pro-oriented: cloud rendering (photo, panorama, video), huge catalog, DWG/PDF/image import with automatic wall/window recognition; its own docs admit photos and hand-drawn plans fail, original drawings preferred. Credit-based rendering.

**Floorplanner**. Accuracy-oriented 2D, clean UI, free tier of 5 projects; 2D/3D, 3D "Photo" cloud renders by credits. Good export of 2D (PNG/PDF); starting price about $4/month annual (unverified). Multi-floor supported. Weak at deep material configuration.

**RoomSketcher**. Polished 2D plans with dimensions, area labels, branded 2D/3D "Live 3D" and cloud 3D photos, 3D floor plans. Entry about $49/year (unverified). Strong at marketing-grade floor plan output (real estate). Image export is credit/plan-gated.

**Roomstyler**. Browser-based quick mockups, large user-made catalog, cloud render with free community. Dated UI, Flash heritage (M).

**HomeByMe** (Dassault). Style-focused, materials and photorealistic rendering, plan-gated renders, branded catalogs.

**IKEA Kreativ / Home Planner**. Free; IKEA catalog only; mobile app can LiDAR-scan a room and place furniture with removal of existing furniture (AI); web uses Room Builder with manual dimensions. Optimised for living/bedroom only.

**Planoplan**. Little verified data (no useful results). From memory: realtime 3D with a built-in renderer, VR, strong CIS-market presence, catalog of branded furniture. Treat as unverified.

**Remplanner**. Not verified (M: Russian-market planner for renovation with materials and cost estimation, 2D to 3D). Remplanner-style "estimate of materials" is a useful feature idea.

**Live Home 3D** (desktop; Mac/Windows). Closest model to doplan. Pro lifetime $129.99 to $149.99 (store, current sale), other listings show $14.99/month or $39.99/year (unverified). Offline ray-tracing via AMD ProRender or Cycles; Pro image export up to 16384x16384, video 4K60. Export: OBJ, USDZ, SCN, glTF, FBX, Collada, X3D, SKP, WRL; 2D to PDF/JPEG/TIFF/PNG/BMP. Material editor, light editor, 2D elevation view, terrain, custom roofs. Imports 3D models in many formats. Complaints (M): dated UI, ray tracer slow, Windows version lags Mac.

**magicplan**. Not verified by search. (M) Mobile-first: AR/LiDAR room capture, auto floor plan, photo annotation, estimates, DXF/PDF/JPG export, subscription for pro.

## Feature matrix

Legend: Y = yes, P = partial/gated, N = no, ? = unverified.

| Feature | Planner 5D | Homestyler | Coohom | Floorplanner | RoomSketcher | Roomstyler | HomeByMe | IKEA Kreativ | Live Home 3D | magicplan |
|---|---|---|---|---|---|---|---|---|---|---|
| Platform | web/mobile/desktop | web/mobile | web | web | web/app | web | web | web/app | desktop/iOS | mobile |
| Wall drawing + dims | Y | Y | Y | Y | Y | Y | Y | P (Room Builder) | Y | Y (capture) |
| Doors/windows library | Y | Y | Y | Y | Y | Y | Y | P | Y | Y |
| Multi-floor | Y | Y | Y | Y | Y | P | Y | N | Y | Y |
| Snapping/ortho/numeric input | Y | Y | Y | Y | Y | ? | ? | ? | Y | Y |
| Realtime 3D | Y | Y | Y | Y | Y | Y | Y | Y | Y | P |
| Offline/cloud photoreal render | cloud P | cloud P | cloud P | cloud P | cloud P | cloud | cloud P | N | local ray-trace Y | N |
| Material editor (tile, grout) | P | P | Y | P | P | P | Y | N | Y | N |
| Custom asset import | P (limited) | P | P | N/P | P | P | N | N | Y (many formats) | N |
| AI plan recognition from image | Y (PRO) | ? | Y | ? | P (paid drawing service, M) | N | ? | LiDAR scan | N | LiDAR/AR |
| 2D export | PNG/PDF (watermark free) | Y | Y | Y | Y | ? | Y | N | PDF/PNG/TIFF | DXF/PDF (M) |
| 3D export | limited | P | P | N | N | N | N | N | OBJ/glTF/FBX/USDZ/etc. | N |
| Offline use | desktop app P | N | N | N | N | N | N | N | Y | P |
| Pricing gate | sub | sub | sub/credits | sub | sub | free/sub | sub | free | one-time/sub | sub |

## Table stakes (must ship v1)
1. Wall tool with live length/angle labels, typed numeric input (Enter on a number during drag), ortho/angle snap, grid, snap to wall endpoints/midpoints, wall thickness and height per wall.
2. Auto room detection from closed wall loops, with area label and room type; per-room floor, ceiling, wall-side materials.
3. Doors, windows, openings, arches: drag onto wall, sill height, width, swing, resize, mirror.
4. Dimensions: auto dimension chains plus manual dimensions; units metric/imperial.
5. Multi-floor with floor copy and ghost overlay of the floor beneath.
6. Instant 2D/3D switch (same camera target), orbit/walk/first-person, top view, section-less dollhouse view.
7. Catalog browsing with categories, search, thumbnails, drag-and-drop, favorites; object inspector (size, rotation, elevation, material per mesh slot, color).
8. Undo/redo with deep history, autosave, crash recovery, copy/paste, groups, lock, hide, layers.
9. Background image underlay with calibration (two-point scale) to trace a plan.
10. Export: 2D PNG/PDF/SVG/DXF; 3D glTF/GLB/OBJ; rendered images. No watermarks.
11. Material presets: floors (wood, laminate, tile, carpet), wallpapers/paints with color picker, ceilings.

## Differentiators doplan can own
1. Local-first, no subscription: all data and rendering on user's machine (counter to the dominant billing complaint). One-time or free.
2. Progressive photoreal: realtime PBR with SSAO/IBL, then in-app path tracing (three-gpu-pathtracer) for final stills, with no credits. Competitors gate cloud renders by credits.
3. Real tile engine: layout patterns (straight, running bond, herringbone, diagonal, basketweave), grout width/color, start corner and offset, cut-waste estimate and tile count. Most competitors only apply a texture.
4. Open asset pipeline: import GLB/glTF, OBJ, FBX, USDZ plus PBR texture sets; auto-scale and slot mapping; local asset library with tags; bundled CC0 packs (Poly Haven, Kenney, ambientCG; licence check required per asset).
5. Photo to plan assistant: upload photo or scan, get editable plan with confidence overlay; hand-correct. Competitors admit hand-drawn/photographed input fails; a trace-assist with calibration and human-in-loop edit is more realistic than full automation.
6. Deep configurability: curtains (fold, rail, length), wallpaper (repeat, offset, rotation, pattern match), balcony objects, kitchen cabinet configurator with parametric units and countertops, ceilings (drop, coffered, spots, cove light).
7. Materials and estimate: bill of materials and cost estimate (Remplanner/magicplan idea).
8. Project is an open file (JSON + assets folder), diffable, scriptable.
9. Performance: no web-view jank; instanced rendering, LOD, texture compression (KTX2), lazy loading. Planner 5D reviewers cite slowness.

## UX patterns worth copying
- Toolbar: left vertical tool rail (Select, Wall, Room, Door, Window, Dimension, Text, Measure), top bar with floor tabs and 2D/3D/split toggle, right inspector, bottom status bar with snap toggles and cursor coordinates (Floorplanner/Live Home style).
- Inspector: context-sensitive; selecting a wall shows thickness/height/each side's material as swatches; selecting an object shows size lock ratio, elevation, rotation, material slots (Live Home 3D, HomeByMe).
- Catalog: left drawer with category tree plus search and "recently used", thumbnails with size badges, drag to canvas, double-click to place at view centre. Material browser separate from object browser, with texture swatches and a "apply to room / apply to all like" action.
- 2D/3D switching: keep selection and camera focus; split view with live sync is the strongest (RoomSketcher/Floorplanner); a small first-person "person" gizmo in 2D showing camera position.
- Measurement input: while dragging, typing digits opens an inline length box (CAD-style), Tab to cycle length/angle. Click a dimension label to edit and move the wall.
- Starter flow: wizard for "draw room by dimensions" and templates (IKEA Room Builder, Planner 5D) so novices produce a result in under a minute; auto-furnish optional.
- Rendering UX: render dialog with quality presets, progress with progressive refinement, camera bookmarks (scenes), time-of-day slider.
- Avoid: paywalled export, watermark, surprise conversion trials, cloud-only saves, losing projects, overlapping walls (validate topology on every edit).

## Implications for implementation
- Data model: walls as graph (nodes + edges with thickness), rooms derived from planar faces, openings parametric on edges, tiles/materials as per-surface UV layout descriptors.
- Build tile layout as a generator producing instanced meshes or a baked texture atlas plus grout mask; also output a count.
- Use glTF as the internal asset format; normalise imports to GLB with KTX2 textures.
- Plan-from-photo: ship as local tool (OpenCV/ONNX wall segmentation) with a calibration step and manual fix-up; keep optional.
- Do not depend on features lacking verification (Planoplan, Remplanner, magicplan details) when making decisions; re-research if needed.
