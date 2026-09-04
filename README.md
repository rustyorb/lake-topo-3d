# Lake Topo 3D

Type the name of a lake. Get its **real shoreline**, **real terrain**, the best **bathymetry on record**, an interactive 3D view, a vector topographic/bathymetric map, and a **watertight STL** for the printer.

No API keys needed for any of the map data. An LLM is optional and only fills gaps.

## Quick start

```bash
bun install          # or npm install
cp .env.example .env # optional
npm run dev          # http://localhost:3000
```

`npm run check` runs the type check plus the STL manifold test. `npm run build && npm start` serves the production bundle.

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

## STL

Heightfield + flat base + four walls, verified closed manifold (`npm run verify`). +X east, +Y north, +Z up. Vertical exaggeration is a multiple of true scale (1.0x = same mm/m as the horizontal axes); "auto-fit" picks a printable relief. Midwestern lakes are nearly flat at 1x, so 3x–8x is typical.

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

Terrain response: `metadata` (name, location, depths, sources, `topoFeatures`, the source labels above, `dnrPdfUrl`, `wikipediaUrl`, `surveyDate`), `gridSize`, `elevations[row][col]` (m MSL, row 0 = north), `waterMask`, `depths` (m), `physicalWidthKm/HeightKm`, `svgTopoMap`.

## Attribution

Shoreline data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. Elevation from [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) and the [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset (Mapzen / Tilezen). Bathymetry and depth maps © Indiana Department of Natural Resources, Division of Fish & Wildlife, reproduced with credit as their terms require. Lake facts from Wikipedia (CC BY-SA) and Wikidata (CC0).
