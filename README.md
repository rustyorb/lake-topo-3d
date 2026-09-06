# Lake Topo 3D

Type the name of a lake. Get its **real shoreline**, **real terrain**, the best **bathymetry on record**, an interactive 3D view, a vector topographic/bathymetric map, a **fishing layer** (structure, thermocline band, waypoints, GPX), and a **watertight STL / 3MF** for the printer.

No API keys needed for any of the map data. An LLM is optional and only fills gaps.

## Quick start

```bash
bun install          # or npm install
cp .env.example .env # optional
npm run dev          # http://localhost:3000
```

`npm run check` runs the type check plus the STL manifold test and the structure-detection test. `npm run build && npm start` serves the production bundle.

## Where the data comes from

| Layer | Source | Coverage |
| --- | --- | --- |
| Shoreline | OpenStreetMap via Nominatim (`polygon_geojson`), islands and multipolygons honoured | worldwide |
| Elevation | USGS 3DEP image service, float32 GeoTIFF resampled to the grid. 1 m where states have flown LiDAR (all of Indiana) | United States |
| Elevation fallback | Terrarium terrain tiles (AWS Open Data / Mapzen) | worldwide |
| Bathymetry | **Indiana DNR Fish & Wildlife sonar contours** (IndianaMap feature service, 150+ lakes), interpolated between contour lines | Indiana |
| Bathymetry fallback | Distance-to-shore bowl scaled to the max depth on record | everywhere else |
| Depth / facts | Curated table → Wikipedia infobox / Wikidata → optional LLM → estimate from area | worldwide |
| Depth-map PDFs | Indiana DNR "Lake Depth Maps" index, linked when the lake has one | Indiana |

Every result says which of these it used (`geometrySource`, `demSource`, `bathymetrySource`, `generationMethod`, `depthIsEstimated`) in the UI, the JSON and the SVG map footer. Lookups are cached on disk under `.cache/`.

Offline (`GEODATA_DISABLED=true` or `?offline=true`) falls back to a hand-built Deam Lake model or a procedural placeholder, labelled as such.

## Optional LLM

Set `LLM_PROVIDER` (or just an API key) to enable AI recon and chart-image reading. Supported: Anthropic (official SDK), OpenAI, OpenRouter, Venice, Ollama, LM Studio, any OpenAI-compatible endpoint (`custom` + `LLM_BASE_URL`), Gemini. The model only receives the sourced facts and is asked to fill what's missing; its answers are labelled "LLM from memory (unverified)" unless the provider returned web citations (Anthropic web search, Gemini grounding). Sourced numbers are never overwritten by the model.

## Fishing layer

Everything below is computed from the depth grid in the browser (`src/lib/structure.ts`), so it is only as good as the bathymetry underneath: on an Indiana DNR-surveyed lake it is real structure, on a modelled bowl it is mostly the bowl.

- **Structure**: holes (local depth maxima with prominence), humps (isolated tops surrounded by deeper water), drop-offs (connected steep bottom, with depth range and average slope), points (land running into the lake, with the depth it runs out to), flats (broad 3–15 ft shelves), saddles (shallowest crossing between two holes). Markers on the 3D model and the 2D map; click one in the list to fly to it.
- **Thermocline band**: shade every bit of bottom between two depths, with presets for early / mid / late summer. The panel lists which structure touches the band. The presets are starting points, not measurements.
- **Cursor readout**: depth or elevation plus lat/lon under the pointer, in both views.
- **Waypoints**: shift-click (or "Drop pin" then click) on the model or the map. Stored in the browser per lake. Any structure feature can be saved as a waypoint. Export **GPX 1.1** (waypoints, or waypoints + structure) for Humminbird, Lowrance, Garmin and Navionics; depth goes in the description.
- **Native DNR lines**: on surveyed lakes the DNR contour vectors themselves are draped on the 3D bed and drawn on the 2D map with their "24-foot" style labels, instead of re-contoured grid lines. Land spot heights come from the DEM.
- **Fishing chart palette**: 5 ft depth bands.

## STL / 3MF

Heightfield + flat base + walls, verified closed manifold (`npm run verify`). +X east, +Y north, +Z up. Vertical exaggeration is a multiple of true scale (1.0x = same mm/m as the horizontal axes); "auto-fit" picks a printable relief. Midwestern lakes are nearly flat at 1x, so 3x–8x is typical.

**Multi-material**: "Land + lake STLs" writes two mating solids in the same frame (every grid cell inside the shoreline, cut vertically from the bed to the base, is the lake part). Import both into Bambu Studio / PrusaSlicer as one object with multiple parts and give the lake part its own filament. "3MF, 2 parts" writes one object with a land component and a lake component, each with a base-material colour hint. The verify script checks that both parts are closed and that their volumes sum to the single solid's.

## Environment

See `.env.example`. Highlights: `PORT`, `LLM_PROVIDER` / `LLM_MODEL` / `LLM_BASE_URL`, `DEM_SOURCE` (`auto|3dep|terrarium`), `IDNR_DISABLED`, `WIKI_DISABLED`, `GEODATA_DISABLED`, `GEODATA_USER_AGENT` (Nominatim asks for a contact), `LAKE_CACHE_DIR`.

## API reference

| Route | Method | Description |
| --- | --- | --- |
| `/api/health` | GET | Status, LLM provider/model in use, geodata enabled |
| `/api/lakes` | GET | Curated lake registry (metadata only) |
| `/api/lookup?q=` | GET | Shoreline lookup only: name, centroid, area, OSM id |
| `/api/lake-terrain?q=&gridSize=&forceAiRecon=&userNotes=&offline=` | GET | Full terrain grid + SVG map |
| `/api/lake-terrain` | POST | Same as GET; JSON body may include `uploadedImage {base64, mimeType}` |
| `/api/analyze-topo-image` | POST | Vision read of an uploaded chart (`imageBase64`, `mimeType`, `query`, `gridSize`); needs an LLM |
| `/api/ai-topo-recon` | POST | LLM recon (`query`, `userNotes`, `gridSize`); needs an LLM |
| `/api/cache/clear` | POST | Drop the in-memory terrain cache |

Terrain response: `metadata` (name, location, depths, sources, `topoFeatures`, the source labels above, `dnrPdfUrl`, `wikipediaUrl`, `surveyDate`), `gridSize`, `elevations[row][col]` (m MSL, row 0 = north), `waterMask`, `depths` (m), `physicalWidthKm/HeightKm`, `svgTopoMap`, `surveyContours` (native survey polylines in fractional grid coordinates, surveyed lakes only), `spotElevations` (land spot heights).

## Attribution

Shoreline data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. Elevation from [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) and the [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset (Mapzen / Tilezen). Bathymetry and depth maps © Indiana Department of Natural Resources, Division of Fish & Wildlife, reproduced with credit as their terms require. Lake facts from Wikipedia (CC BY-SA) and Wikidata (CC0).
