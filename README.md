# Lake Topo 3D

Type the name of a lake. Get its **real shoreline** (OpenStreetMap), **real surrounding terrain** (public DEM tiles), a modelled lake bed, an interactive 3D view, a vector topographic/bathymetric map, and a **watertight STL** you can drop into a slicer.

Works for any named lake worldwide, no API key required. An optional Gemini key adds surveyed max depths, geology notes and chart-image analysis.

## Quick start

```bash
bun install          # or npm install
cp .env.example .env # optional: PORT, GEMINI_API_KEY
npm run dev          # http://localhost:3000
```

`npm run check` runs the type check and the STL manifold test. `npm run build && npm start` serves the production bundle.

## How a lake becomes a model

1. **Shoreline** — Nominatim (OpenStreetMap) search with `polygon_geojson=1`. Multipolygons and islands (holes) are honoured.
2. **Elevation** — Terrarium terrain tiles from AWS Open Data (Mapzen; SRTM/NED/3DEP composite), bilinearly sampled onto the grid at a zoom chosen to match the cell size. The lake's surface elevation is the median tile value inside the polygon.
3. **Bathymetry** — there is no free public bathymetry for most lakes, so depth is modelled as a distance-to-shore bowl and scaled to the max depth on record. The max depth comes from the curated table (`server/lakeData.ts`), from Gemini recon, or is estimated from surface area. The UI and the SVG always say which.
4. **Map** — marching-squares contours (land and depth), hypsometric tint, real bounds and scale bar, rendered server-side as SVG.
5. **STL** — heightfield + flat base + four walls, verified closed manifold. +X east, +Y north, +Z up. Vertical exaggeration is a multiple of true scale (1.0x = same mm/m as horizontal); "auto-fit" picks a printable relief.

If the geodata services can't be reached, the app falls back to a hand-built Deam Lake model or a procedural placeholder and labels it as such.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default 3000, probes upward if busy) |
| `GEMINI_API_KEY` | Enables AI recon and chart upload analysis |
| `GEMINI_MODEL`, `GEMINI_LITE_MODEL` | Override model IDs (defaults `gemini-3.5-flash`, `gemini-3.1-flash-lite`) |
| `GEODATA_DISABLED=true` | Force offline models |
| `NOMINATIM_BASE_URL`, `TERRAIN_TILE_URL`, `GEODATA_USER_AGENT` | Point at your own Nominatim / tile mirror, identify yourself to Nominatim |

## API reference

| Route | Method | Description |
| --- | --- | --- |
| `/api/health` | GET | Status plus whether Gemini and geodata are enabled |
| `/api/lakes` | GET | Curated lake registry (metadata only) |
| `/api/lookup?q=` | GET | Shoreline lookup only: name, centroid, area, OSM id |
| `/api/lake-terrain?q=&gridSize=&forceAiRecon=&userNotes=&offline=` | GET | Full terrain grid + SVG map |
| `/api/lake-terrain` | POST | Same as GET; JSON body may include `uploadedImage {base64, mimeType}` |
| `/api/analyze-topo-image` | POST | Gemini Vision analysis of an uploaded chart (`imageBase64`, `mimeType`, `query`, `gridSize`) |
| `/api/ai-topo-recon` | POST | Gemini search-grounded recon (`query`, `userNotes`, `gridSize`) |
| `/api/cache/clear` | POST | Drop the in-memory terrain cache |

Terrain response: `metadata` (name, location, elevations, depths, `generationMethod`, `geometrySource`, `depthIsEstimated`, `sources`, `topoFeatures`), `gridSize`, `elevations[row][col]` (m MSL, row 0 = north), `waterMask`, `depths` (m), `physicalWidthKm/HeightKm`, `svgTopoMap`.

## Attribution

Shoreline data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. Elevation from the [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset on AWS Open Data (Mapzen / Tilezen). Keep both credits visible if you redistribute output.
