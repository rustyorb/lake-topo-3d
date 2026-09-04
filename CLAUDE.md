# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — `tsx server.ts`: one process serving the Express API and the Vite dev middleware (HMR). There is no separate frontend server. Default port 3000, probes upward if busy; set `PORT` in `.env`.
- `npm run lint` — `tsc --noEmit`. There is no ESLint/Prettier.
- `npm run verify` — `tsx scripts/verify-stl.ts`: the only automated test. It builds meshes from a synthetic grid and asserts the STL is a closed 2-manifold (every edge shared by exactly two opposite-direction triangles), has positive signed volume, and puts north at +Y. Run it after touching `src/utils/stlExporter.ts`.
- `npm run check` — lint + verify.
- `npm run build` — `vite build` for the SPA, then esbuild bundles the server to `dist/server.cjs` (`--packages=external`, so `node_modules` must exist at runtime). `npm start` serves it with `NODE_ENV=production`.
- Manual API smoke test against a running dev server: `curl "http://localhost:3000/api/lake-terrain?q=Deam%20Lake,%20Indiana&gridSize=96"`. Add `&offline=true` to skip the network geodata path.
- `bun.lock` is the lockfile; `bun install` is the fastest way to install, `npm install` also works.

## Architecture

Single-process local app: browser SPA (React 19 + Three.js) → Express API in `server.ts` → public geodata services and, optionally, Gemini. The browser never talks to Gemini or OSM directly.

**Data pipeline (`server/lakeService.ts`, `generateLakeTerrainGrid`)** — the core of the app. Two independent axes, each with its own fallback chain, and the result carries both labels:

1. *Metadata* (`metadata.generationMethod`): uploaded chart via Gemini Vision → Gemini search-grounded recon (only when `forceAiRecon` or the lake isn't curated and a key exists) → curated entry in `server/lakeData.ts` → deterministic heuristic. `depthIsEstimated` says whether max depth is a guess.
2. *Geometry* (`metadata.geometrySource`): `server/geoData.ts` looks the query up on Nominatim (real shoreline polygon, incl. holes/multipolygons) and samples Terrarium DEM tiles for ground elevation → `osm-dem`. If that fails: the hand-built Deam Lake signed-distance model (`curated-sdf`) or a parametric blob (`procedural`).

When real geometry is available it overrides lat/lon, bounds, area, perimeter and surface elevation (median DEM inside the polygon) from the metadata source; curated/AI max depth is kept. Bathymetry is always modelled — there is no free public bathymetry — as a distance-to-shore bowl scaled to max depth (`buildRealTerrain`). Curated/AI landmark positions live in their own coordinate frame, so with `osm-dem` geometry they are replaced by two computed markers (deepest cell, highest DEM cell).

Grid conventions everywhere: square `gridSize×gridSize`, row 0 = north edge, col 0 = west edge, `elevations` in metres MSL, `depths` in metres below `waterElevation`. Cells are not necessarily square in metres; `physicalWidthKm/HeightKm` carry the frame size. The server bumps `gridSize` up to `MAX_GRID` (160) for large/branchy lakes regardless of what the client asked for. Results are cached in memory for an hour keyed by query+options; tiles and OSM lookups are cached separately.

**Shared math (`src/lib/contours.ts`)** — marching squares with edge interpolation plus segment joining, imported by both the server (SVG map) and the browser (3D contour lines). The scalar field used for contours is always "feet relative to the water surface" so the 0 level is the shoreline, positive levels are land, negative levels are depth.

**SVG map (`server/topoMapGenerator.ts`)** — generated server-side and returned as `svgTopoMap` in the terrain JSON. Everything in it is derived from the grid: a hypsometric PNG raster (encoded by `server/png.ts`, no image library) under real contour paths, real bounds in DMS, a scale bar from `physicalWidthKm`. Do not reintroduce hard-coded shapes.

**Scale contract** — vertical exaggeration means the same thing in the viewer and the STL: 1.0x = the same units-per-metre vertically as horizontally. `Lake3DViewer` maps the east-west frame to 100 scene units; `stlExporter` maps it to `targetWidthMm`. `suggestExaggeration` picks a value that gives ~14% of the width as relief because Midwestern lakes are nearly flat at true scale. STL frame: +X east, +Y north, +Z up, flat base at z=0.

**Frontend (`src/App.tsx`)** owns all state (query, view mode, viewer controls) and passes it down; `Lake3DViewer` splits work into separate effects (terrain+base+contours rebuild, water surface rebuild, wireframe toggle, water opacity) so slider changes only rebuild what they affect. The STL dialog is mounted only while open because it computes the full mesh in `useMemo`.

## Conventions & gotchas

- `@` import alias resolves to the project root, not `src/` (`vite.config.ts`). Server code imports browser-shared types/libs from `../src/...`.
- Do not modify the `DISABLE_HMR` handling in `vite.config.ts`.
- Gemini model IDs are read from `GEMINI_MODEL` / `GEMINI_LITE_MODEL` with defaults in `server/geminiTopoService.ts`; Google rotates IDs, so fix them via env before touching code. `geminiAvailable()` is false when the key is unset or still the AI Studio placeholder.
- Nominatim usage policy: keep the `User-Agent` set (`GEODATA_USER_AGENT`), stay well under 1 req/s (lookups are cached and single-flighted), and keep the OpenStreetMap attribution in the UI footer and SVG.
- `metadata.json` and `public/assets/aistudio/` are Google AI Studio hosting artifacts; leave them.
- The README's API Reference table lists every `/api` route; update it when adding one.
