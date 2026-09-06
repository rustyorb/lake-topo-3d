/**
 * Structure detection sanity check: a synthetic lake with a known hole, hump, point,
 * drop-off and flat must be found at (about) the right cells.
 *
 *   npx tsx scripts/verify-structure.ts
 */
import { analyzeStructure, gridToLatLon, latLonToGrid } from '../src/lib/structure.js';
import type { TerrainGridData } from '../src/types.js';

const N = 96;
function synthetic(): TerrainGridData {
  const elevations: number[][] = [];
  const waterMask: boolean[][] = [];
  const depths: number[][] = [];
  const water = 200;
  for (let r = 0; r < N; r++) {
    elevations[r] = []; waterMask[r] = []; depths[r] = [];
    for (let c = 0; c < N; c++) {
      const nx = (c / (N - 1)) * 2 - 1;
      const ny = (r / (N - 1)) * 2 - 1;
      // Lake body: ellipse, with a land point poking in from the west at ny≈0.
      let inLake = (nx * nx) / 0.7 + (ny * ny) / 0.45 < 1;
      const point = nx < -0.25 && Math.abs(ny) < 0.06 - (nx + 0.85) * 0.08;
      if (point) inLake = false;
      if (!inLake) {
        waterMask[r][c] = false; depths[r][c] = 0;
        elevations[r][c] = water + 2 + Math.max(0, Math.hypot(nx, ny) - 0.8) * 60;
        continue;
      }
      // Base bowl: shallow flat on the east half, steep drop into a basin on the west.
      let d = nx > 0.1 ? 2.0 : 2.0 + Math.min(1, (0.1 - nx) / 0.25) * 8; // 2 m flat → 10 m basin over a breakline
      // Hole in the basin
      const hole = Math.exp(-(((nx + 0.35) ** 2) + ((ny - 0.34) ** 2)) / 0.01) * 6;
      // Second hole to make a saddle
      const hole2 = Math.exp(-(((nx + 0.35) ** 2) + ((ny - 0.08) ** 2)) / 0.01) * 5;
      // Hump in the basin, isolated
      const hump = Math.exp(-(((nx + 0.15) ** 2) + ((ny + 0.05) ** 2)) / 0.004) * 7;
      d = d + hole + hole2 - hump;
      d = Math.max(0.5, d);
      waterMask[r][c] = true; depths[r][c] = d; elevations[r][c] = water - d;
    }
  }
  return {
    metadata: { id: 'synthetic', name: 'Synthetic', state: 'IN', lat: 41.4, lon: -85.7, surfaceElevationM: water, surfaceElevationFt: 656, maxDepthM: 16, maxDepthFt: 52, meanDepthM: 5, meanDepthFt: 16, areaAcres: 400, perimeterKm: 6, geologicalOrigin: '', description: '', bounds: { minLat: 41.39, maxLat: 41.41, minLon: -85.72, maxLon: -85.68 } },
    gridSize: N, elevations, waterMask, depths,
    minElevation: water - 16, maxElevation: water + 20, waterElevation: water, minDepth: 0, maxDepth: 16,
    physicalWidthKm: 3.3, physicalHeightKm: 2.2,
  };
}

const data = synthetic();
const feats = analyzeStructure(data);
const byKind = (k: string) => feats.filter((f) => f.kind === k);
const expect = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  ', msg); };

const cellOf = (nx: number, ny: number) => ({ col: ((nx + 1) / 2) * (N - 1), row: ((ny + 1) / 2) * (N - 1) });
const near = (f: { row: number; col: number } | undefined, nx: number, ny: number, tol: number) => {
  if (!f) return false;
  const c = cellOf(nx, ny);
  return Math.hypot(f.row - c.row, f.col - c.col) <= tol;
};

const holes = byKind('hole');
expect(holes.length >= 2, `found ${holes.length} holes (expected ≥ 2)`);
expect(holes.some((h) => near(h, -0.35, 0.34, 4)), 'hole A at the planted position');
expect(holes.some((h) => near(h, -0.35, 0.08, 4)), 'hole B at the planted position');
expect(holes.find((h) => h.label === 'Deepest hole') !== undefined, 'deepest hole is labelled');

const humps = byKind('hump');
expect(humps.length >= 1 && near(humps[0], -0.15, -0.05, 4), `hump found at the planted position (${humps.length} humps)`);

const drops = byKind('drop-off');
expect(drops.length >= 1, `found ${drops.length} drop-offs`);
expect(drops.some((d) => Math.abs(d.col - cellOf(-0.05, 0).col) < 10), 'a drop-off sits on the planted breakline');

const points = byKind('point');
expect(points.length >= 1, `found ${points.length} points`);
expect(points.some((p) => near(p, -0.25, 0, 8)), 'point marker near the tip of the land point');

const flats = byKind('flat');
expect(flats.length >= 1 && flats[0].col > cellOf(0.1, 0).col, `flat found on the east shelf (${flats.length} flats)`);

const saddles = byKind('saddle');
expect(saddles.length >= 1 && near(saddles[0], -0.35, 0.21, 5), `saddle between the two holes (${saddles.length} saddles)`);

// Coordinate round-trip
const ll = gridToLatLon(data, 10.5, 70.25);
const rc = latLonToGrid(data, ll.lat, ll.lon);
expect(Math.abs(rc.row - 10.5) < 1e-6 && Math.abs(rc.col - 70.25) < 1e-6, 'grid ↔ lat/lon round-trip');

for (const f of feats) console.log(`   ${f.kind.padEnd(9)} r${f.row.toFixed(0).padStart(3)} c${f.col.toFixed(0).padStart(3)}  ${f.depthFt} ft  ${f.detail}`);
if (process.exitCode) { console.error('structure verification FAILED'); } else console.log('structure verification passed');
