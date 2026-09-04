# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — `tsx server.ts`: one process serving the Express API and the Vite dev middleware (HMR). There is no separate frontend server. Default port 3000, probes upward if busy; set `PORT` in `.env`.
- `npm run lint` — `tsc --noEmit`. There is no ESLint/Prettier.
- `npm run verify` — `tsx scripts/verify-stl.ts`: the only automated test. It builds meshes from a synthetic grid and asserts the STL is a closed 2-manifold (every edge shared by exactly two opposite-direction triangles), has positive signed volume, and puts north at +Y. Run it after touching `src/utils/stlExporter.ts`.
- `npm run check` — lint + verify.
- `npm run build` — `vite build` for the SPA, then esbuild bundles the server to `dist/server.cjs` (`--packages=external`, so `node_modules` must exist at runtime). `npm start` serves it with `NODE_ENV=production`.
- Manual API smoke test against a running dev server: `curl "http://localhost:3000/api/lake-terrain?q=Deam%20Lake,%20Indiana&gridSize=96"`. Add `&offline=true` to skip every network lookup. Delete `.cache/` to force fresh lookups.
- `bun.lock` is the lockfile; `bun install` is the fastest way to install, `npm install` also works.

## Architecture

Single-process local app: browser SPA (React 19 + Three.js) → Express API in `server.ts` → public geodata services and, optionally, Gemini. The browser never talks to Gemini or OSM directly.

**Data pipeline (`server/lakeService.ts`, `generateLakeTerrainGrid`)** — the core of the app. Three independent axes, each with its own fallback chain, and the result carries a label for each (`geometrySource`, `demSource`, `bathymetrySource`, `generationMethod`, `depthIsEstimated`):

1. *Shoreline*: `server/geoData.ts` `lookupLakeOSM` (Nominatim, throttled to 1 req/s, disk-cached). Indiana fallback when the geocoder is down: `findIdnrOutlineByName`. Offline: hand-built Deam Lake SDF or a procedural blob.
2. *Elevation*: `server/dem3dep.ts` (USGS 3DEP ImageServer, float32 GeoTIFF decoded in-house, US only) → `server/geoData.ts` `sampleDem` (Terrarium tiles, worldwide). Lake surface elevation = median DEM inside the shoreline.
3. *Bathymetry*: `server/idnrBathymetry.ts` — IDNR sonar contours from the IndianaMap feature service, rasterised by `rasterizeContourDepths` (deepest enclosing closed contour = floor, linear interpolation to the next deeper line, exponential rise inside the innermost ring). Elsewhere: distance-to-shore bowl scaled to max depth (`buildRealTerrain`).

Max depth precedence: IDNR survey > curated `server/lakeData.ts` > Wikipedia infobox / Wikidata (`server/wikiData.ts`) > uploaded-chart reading > LLM recon > `estimateMaxDepthM(area)`. The optional LLM (`server/aiRecon.ts` over `server/llm.ts`) runs last and only fills gaps; sourced numbers are never overwritten. Curated/AI landmarks have no coordinates in the real frame, so they are kept with `normX/normY = NaN` (list only) and two computed markers (deepest cell, highest DEM cell) are added.

The IDNR contour layer has no reliable key to the outline layer (`gauge_adjusted_level` is null for most lakes); `fetchIdnrSurvey` queries contours by the outline's bounding box and keeps the ones whose `lake_name` matches the outline's GNIS name.

Grid conventions everywhere: square `gridSize×gridSize`, row 0 = north edge, col 0 = west edge, `elevations` in metres MSL, `depths` in metres below `waterElevation`. Cells are not necessarily square in metres; `physicalWidthKm/HeightKm` carry the frame size. The server bumps `gridSize` up to `MAX_GRID` (160) for large/branchy lakes regardless of what the client asked for. Results are cached in memory for an hour keyed by query+options; OSM, IDNR and Wikipedia lookups are cached on disk in `.cache/` (`server/diskCache.ts`).

**Shared math (`src/lib/contours.ts`)** — marching squares with edge interpolation plus segment joining, imported by both the server (SVG map) and the browser (3D contour lines). The scalar field used for contours is always "feet relative to the water surface" so the 0 level is the shoreline, positive levels are land, negative levels are depth.

**SVG map (`server/topoMapGenerator.ts`)** — generated server-side and returned as `svgTopoMap` in the terrain JSON. Everything in it is derived from the grid: a hypsometric PNG raster (encoded by `server/png.ts`, no image library) under real contour paths, real bounds in DMS, a scale bar from `physicalWidthKm`. Do not reintroduce hard-coded shapes.

**Scale contract** — vertical exaggeration means the same thing in the viewer and the STL: 1.0x = the same units-per-metre vertically as horizontally. `Lake3DViewer` maps the east-west frame to 100 scene units; `stlExporter` maps it to `targetWidthMm`. `suggestExaggeration` picks a value that gives ~14% of the width as relief because Midwestern lakes are nearly flat at true scale. STL frame: +X east, +Y north, +Z up, flat base at z=0.

**Frontend (`src/App.tsx`)** owns all state (query, view mode, viewer controls) and passes it down; `Lake3DViewer` splits work into separate effects (terrain+base+contours rebuild, water surface rebuild, wireframe toggle, water opacity) so slider changes only rebuild what they affect. The STL dialog is mounted only while open because it computes the full mesh in `useMemo`.

## Conventions & gotchas

- `@` import alias resolves to the project root, not `src/` (`vite.config.ts`). Server code imports browser-shared types/libs from `../src/...`.
- Do not modify the `DISABLE_HMR` handling in `vite.config.ts`.
- LLM access goes through `server/llm.ts` only: `LLM_PROVIDER` selects Anthropic (official SDK, `client.beta.messages` with server-side fallbacks), Gemini (`@google/genai`), or any OpenAI-compatible endpoint via `fetch`. Defaults per provider live in `DEFAULT_MODELS`; override with `LLM_MODEL`. A placeholder key (`MY_...`) counts as unset. Never call a provider SDK from anywhere else.
- Nominatim usage policy: keep the `User-Agent` set (`GEODATA_USER_AGENT`), never bypass `nominatimFetch` (serialised, 1.1 s spacing, one retry on 429), and keep the OpenStreetMap, USGS and Indiana DNR attribution in the UI footer and SVG.
- Public services used at runtime (all keyless): Nominatim, `elevation.nationalmap.gov` (3DEP), `s3.amazonaws.com/elevation-tiles-prod` (Terrarium), `gisdata.in.gov` (IDNR feature service), `in.gov/dnr` (depth-map PDF index), `en.wikipedia.org`, `wikidata.org`. The Indiana `maps.indiana.edu` / `imagery.gis.in.gov` servers reset connections from some networks; 3DEP carries the same LiDAR, so they are not used.
- `metadata.json` and `public/assets/aistudio/` are Google AI Studio hosting artifacts; leave them.
- The README's API Reference table lists every `/api` route; update it when adding one.
