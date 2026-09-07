/**
 * Laser layer pack sanity check: every contour ring closes, the shoreline sheet keeps exactly the
 * land fraction of the frame, sheets shrink monotonically going up the stack, and the SVG and DXF
 * writers produce one entity per ring.
 *
 *   npx tsx scripts/verify-layers.ts
 */
import { buildLayerPack, layerPackSvg, layerPackDxf } from '../src/lib/layers.js';
import type { TerrainGridData } from '../src/types.js';

const N = 96;
function synthetic(): TerrainGridData {
  const elevations: number[][] = [];
  const waterMask: boolean[][] = [];
  const depths: number[][] = [];
  const water = 200;
  let landCells = 0;
  for (let r = 0; r < N; r++) {
    elevations[r] = []; waterMask[r] = []; depths[r] = [];
    for (let c = 0; c < N; c++) {
      const nx = (c / (N - 1)) * 2 - 1;
      const ny = (r / (N - 1)) * 2 - 1;
      const d = Math.hypot(nx / 0.8, ny / 0.6);
      const inLake = d < 1;
      waterMask[r][c] = inLake;
      if (inLake) {
        const depth = (1 - d) * 12 + (Math.hypot(nx + 0.3, ny) < 0.15 ? 4 : 0); // bowl with a hole
        depths[r][c] = depth;
        elevations[r][c] = water - depth;
      } else {
        landCells++;
        depths[r][c] = 0;
        elevations[r][c] = water + 0.5 + (d - 1) * 25 + Math.sin(nx * 5) * 1.5; // rising land
      }
    }
  }
  let maxE = -Infinity, minE = Infinity, maxD = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { maxE = Math.max(maxE, elevations[r][c]); minE = Math.min(minE, elevations[r][c]); maxD = Math.max(maxD, depths[r][c]); }
  return {
    metadata: { id: 't', name: 'Test', state: 'IN', lat: 40, lon: -86, surfaceElevationM: water, surfaceElevationFt: 656, maxDepthM: maxD, maxDepthFt: maxD * 3.28, meanDepthM: 5, meanDepthFt: 16, areaAcres: 1, perimeterKm: 1, geologicalOrigin: '', description: '', bounds: { minLat: 39.99, maxLat: 40.01, minLon: -86.01, maxLon: -85.99 } },
    gridSize: N, elevations, waterMask, depths, minElevation: minE, maxElevation: maxE, waterElevation: water, minDepth: 0, maxDepth: maxD,
    physicalWidthKm: 1.6, physicalHeightKm: 1.2,
    // stash for the assertions below
    svgTopoMap: String(landCells),
  };
}

let failures = 0;
const expect = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok  ', msg); };

const data = synthetic();
const landFrac = Number(data.svgTopoMap) / (N * N);
const pack = buildLayerPack(data, { stepFt: 10, widthMm: 120, includeLand: true });

expect(pack.openDropped === 0, `every isoline closed (dropped ${pack.openDropped})`);
expect(pack.layers.length >= 6, `stack has ${pack.layers.length} sheets`);
expect(pack.layers.every((l) => l.kind === 'base' || l.rings.length >= 1), 'every contour sheet has at least one ring');
expect(pack.layers.every((l) => l.rings.every((r) => r.length >= 3)), 'every ring has 3+ points');

const shore = pack.layers.find((l) => l.levelFt === 0)!;
const mapArea = pack.mapWmm * pack.mapHmm;
const shoreFrac = shore.areaMm2 / mapArea;
expect(Math.abs(shoreFrac - landFrac) < 0.05, `shoreline sheet keeps the land fraction (${shoreFrac.toFixed(3)} vs ${landFrac.toFixed(3)})`);

let monotonic = true;
for (let i = 1; i < pack.layers.length; i++) if (pack.layers[i].areaMm2 > pack.layers[i - 1].areaMm2 + 1e-6) monotonic = false;
expect(monotonic, 'sheets never grow going up the stack');
expect(pack.layers.some((l) => l.kind === 'land'), 'land sheets included');
const waterSheets = pack.layers.filter((l) => l.kind === 'water');
const expectedWater = Math.floor((data.maxDepth * 3.28084 - 0.01) / 10) + 1; // one per 10 ft step plus the shoreline sheet
expect(waterSheets.length === expectedWater, `${expectedWater} water sheets at 10 ft steps for a ${(data.maxDepth * 3.28084).toFixed(1)} ft lake: ${waterSheets.map((l) => l.levelFt).join(', ')}`);

const svg = layerPackSvg(pack, 'Test Lake');
const paths = (svg.match(/<path /g) || []).length;
expect(svg.startsWith('<?xml') && svg.includes('</svg>'), 'SVG document well-formed');
expect(paths === pack.layers.filter((l) => l.rings.length).length, `one <path> per sheet with rings (${paths})`);

const dxf = layerPackDxf(pack, 'Test Lake');
const polys = (dxf.match(/\nPOLYLINE\n/g) || []).length;
const ringCount = pack.layers.reduce((s, l) => s + l.rings.length, 0);
const outlineCount = pack.layers.filter((l) => l.kind !== 'land').length * 5; // sheet rectangle + 4 registration circles
expect(polys === ringCount + outlineCount, `DXF polylines = rings + outlines (${polys} = ${ringCount} + ${outlineCount})`);
expect(dxf.endsWith('EOF\n'), 'DXF ends with EOF');

for (const l of pack.layers) console.log(`   ${l.name.padEnd(10)} ${l.kind.padEnd(5)} rings=${String(l.rings.length).padStart(2)} area=${Math.round(l.areaMm2)} mm²`);
console.log(`   true-scale sheet thickness ${pack.trueThicknessMm.toFixed(2)} mm per ${pack.stepFt} ft step`);
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('layer pack verification passed');
