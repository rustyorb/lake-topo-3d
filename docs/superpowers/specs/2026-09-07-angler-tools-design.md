# Angler tools: five user-facing features

Date: 2026-09-07. Branch: `feature/angler-tools`. Approved by the user as a set ("AWESOME! YES!"); the design decisions below were made without a Q&A round, so any of them can be revisited.

## Goals

1. **Bring your own bathymetry** — import depth soundings (CSV/GPX) and rebuild the lake from them.
2. **Cross-section tool** — click two points, see the bottom profile between them.
3. **Contour-following routes** — pick a depth, get the contour loops as GPX tracks.
4. **Sun, shade and wind** — real shadows for a date/time, windblown shore highlighted.
5. **Laser-cut layer pack** — every contour level as closed polygons in SVG and DXF.

Non-goals: parsing binary sonar logs (.sl2/.sl3), persisting soundings between sessions, wind speed or fetch modelling, sunrise/sunset tables, DXF splines or arcs.

## Shared foundation

- **Pick mode.** `pinMode: boolean` becomes `pickMode: 'none' | 'pin' | 'section'` in `App.tsx`. Both viewers call `onPick(cell)` on a non-drag click when a mode is active; shift-click still drops a pin. `FishingPanel` and the viewer toolbars toggle it.
- **Overlay lines.** Both viewers take `overlays: OverlayLine[]` (`{ id, points: [col,row][], color, width?, dashed?, endpoints? }`). `Lake3DViewer` drapes each on the boosted surface as a `THREE.Line` (plus small spheres at endpoints); `TopoMapViewer` draws an SVG layer over the sheet using `gridToSvg`. Sections, routes and windblown shore all use this one mechanism.
- **Shadow camera.** The existing directional light's shadow camera is left at Three's default ±5-unit box, so shadows barely render. It is widened to cover the model. This is needed by feature 4 and improves the default view.

## 1. Bring your own bathymetry

- `src/lib/soundings.ts` (browser): `parseSoundings(text, filename, unit)` → `{ points: {lat, lon, depthM}[], skipped, unitUsed }`. CSV/TSV with header detection (`lat|latitude|y`, `lon|lng|long|longitude|x`, `depth|z|depth_ft|depth_m|depth (ft)`), unit from the header when it says ft/feet/m/metres, else the user's choice (default feet). GPX `<wpt>`: depth from `<ele>` (absolute value) or the first number in `<desc>`, `<cmt>` or `<name>`. Cap at 50,000 points.
- `server/soundings.ts`: `rasterizeSoundings(points, waterMask, bounds)` → `{ depthsM, maxDepthM, used }`. Points are mapped to fractional grid coordinates and kept when inside the water mask (or within one cell of it). Shoreline cells (land touching water, and water cells on the frame edge) are added as zero-depth samples. Each water cell takes an inverse-distance-squared weighted average of its 12 nearest samples via a bucket grid, then two 3×3 mean passes inside the water soften bullseyes. Minimum wet depth 0.1 m.
- Pipeline: `LakeGenerationOptions.soundings`. In `buildRealTerrain`, soundings win over the IDNR survey and the distance bowl; `bathymetrySource = 'user-soundings'` (new enum value, labelled "Your soundings"). Max depth from the raster; `depthIsEstimated = false`; a source entry "Your soundings (N points used)"; `surveyContours` is not set, so the map and viewer re-contour the grid. The cache key includes an FNV-1a hash of the sounding list.
- API: `POST /api/lake-terrain` body gains `soundings: [{lat, lon, depthM}]`. README route table updated.
- UI: a fourth `FishingPanel` tab, **Soundings**: file input (.csv .txt .tsv .gpx), unit toggle, parse summary, **Apply** (refetch via POST) and **Remove**. The frame toggle and re-fetches keep the soundings (held in a ref like `frameModeRef`).
- Test: `scripts/verify-soundings.ts` samples a known bowl-with-hole at 300 random points, rasterises, and asserts RMS error under 0.6 m, shore depth ≈ 0, and max depth within 10% of the truth. Added to `npm run verify`.

## 2. Cross-section tool

- `src/lib/section.ts`: `sampleSection(data, a, b, n = 220)` → samples along the line with `distanceM`, `relFt` (feet relative to the water surface, negative under water), `isWater`, lat/lon; `featuresNearLine(structure, a, b, tolCells)` projects structure features onto the line.
- `src/components/SectionChart.tsx`: SVG chart under the viewer. X = distance (ft, switching to mi over 5,280 ft), Y = feet relative to the surface. Water column filled blue from 0 down to the bed, land filled tan above 0, thermocline band shaded amber, nearby structure drawn as dots with labels, hover readout. Buttons: swap ends, PNG (SVG → canvas → `downloadBlob`), clear.
- Interaction: pick mode `section`; first click sets A, second sets B and exits the mode. The A–B line is an overlay (white, dashed, endpoints) in both viewers.

## 3. Contour-following routes

- `src/lib/routes.ts`: `contourRoutes(data, depthFt, useSurvey)` → `Route[]` (`{ id, depthFt, points, lengthM, closed }`). Uses the native survey vectors when one matches the depth exactly, else `isolines` on the relative-feet field at `-depthFt`. Length from `cellSizeM`; loops under 4 points dropped; sorted by length.
- `src/lib/gpx.ts`: `buildGpxTracks(lakeName, tracks)` writing `<trk><trkseg>` per route, depth in `<desc>`.
- UI: `FishingPanel` tab **Routes**: depth number input with quick buttons at the contour interval, list of loops with length and a checkbox, fly-to per loop, **Export GPX track** for the checked loops. Checked loops are amber overlays in both viewers.

## 4. Sun, shade and wind

- `src/lib/sun.ts`: `sunPosition(date, lat, lon)` → azimuth (degrees clockwise from north) and elevation, NOAA solar position (accurate to well under a degree, which is all shade lines need).
- `Lake3DViewer` props `sun?: { enabled, azimuthDeg, elevationDeg }` and `wind?: { enabled, fromDeg }`. Scene frame is +X east, −Z north. The sun light is placed at the azimuth with a corrected elevation `tan θ' = E · tan θ` where E is the vertical exaggeration, so shadow lengths on the stretched terrain match the real ground. Ambient light drops while sun mode is on; below the horizon the scene dims and the panel says so. A `THREE.ArrowHelper` at the north-west corner shows the wind.
- `src/lib/wind.ts`: `windblownShore(data, fromDeg)` walks the shoreline isoline (level 0 of the relative field), computes each segment's land-side normal by sampling the water mask, and returns runs of segments whose normal faces into the wind (dot > 0.35) as polylines. Drawn as orange overlays.
- `src/components/ConditionsPanel.tsx`: date input, time slider (0–24 h in the device's local time, stated in the UI), **Now** button, azimuth/elevation readout; wind direction slider with compass buttons.

## 5. Laser-cut layer pack

- `src/lib/layers.ts`: `buildLayerPack(data, { stepFt, widthMm, includeLand, marginMm })`. The relative-feet field is padded with a border of −1e9 so every isoline closes at the frame edge; layer for level L is the region `field ≥ L`, its rings are the padded isolines at L, mapped to mm (x east, y south). Layers in stacking order: base rectangle, deepest level up to 0 (shoreline), then land levels if requested. Each sheet gets a frame outline, four registration circles at the corners, and an engraved label. Sheets are tiled on one page, `ceil(sqrt(n))` per row.
- `src/lib/dxf.ts`: minimal ASCII DXF (HEADER with `$INSUNITS` = mm, ENTITIES with closed `LWPOLYLINE`s and `TEXT`), one DXF layer per sheet, cut and engrave on separate layers.
- UI: a **Laser-cut layer pack** section in `STLExportDialog`: step buttons (2/5/10 ft), sheet width (shares `targetWidthMm`), include land toggle, material thickness (mm) → layer count, stack height and the implied vertical exaggeration versus true scale. **Download SVG** and **Download DXF**.
- Test: `scripts/verify-layers.ts` asserts every ring is closed, the shoreline layer's kept area matches the land fraction within 5%, and every layer has at least the frame ring. Added to `npm run verify`.

## Error handling

Sounding parse failures show the reason in the panel and keep the current lake. Soundings that all fall outside the water mask are reported ("0 of N inside the lake") and not applied. Section and route tools degrade to empty results on a flat modelled bowl, like the structure detector.

## Implementation order

Foundation (pick mode, overlays, shadow camera) → routes → cross-section → sun/wind → laser pack → soundings (server + client + verify) → README and CLAUDE.md. `npm run check` after each step; a browser smoke test at the end.
