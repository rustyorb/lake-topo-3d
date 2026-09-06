/**
 * Mesh sanity check for the STL exporter: every edge must be shared by exactly two
 * triangles with opposite direction (closed 2-manifold), the signed volume must be
 * positive (consistent outward normals), and north must map to +Y.
 *
 *   npx tsx scripts/verify-stl.ts
 */
import { generateWatertightSTLMesh, computeNormal, encodeBinarySTL, type Triangle } from '../src/utils/stlExporter.js';
import type { TerrainGridData } from '../src/types.js';

function fakeGrid(size: number): TerrainGridData {
  const elevations: number[][] = [];
  const waterMask: boolean[][] = [];
  const depths: number[][] = [];
  for (let r = 0; r < size; r++) {
    elevations[r] = []; waterMask[r] = []; depths[r] = [];
    for (let c = 0; c < size; c++) {
      const nx = (c / (size - 1)) * 2 - 1, ny = (r / (size - 1)) * 2 - 1;
      const d = Math.hypot(nx, ny);
      const water = d < 0.5;
      const depth = water ? (0.5 - d) * 20 : 0;
      // A north-south ramp so we can detect mirroring: north edge (row 0) is highest.
      const land = 160 + (1 - (r / (size - 1))) * 30 + Math.sin(nx * 6) * 2;
      elevations[r][c] = water ? 160 - depth : land;
      waterMask[r][c] = water;
      depths[r][c] = depth;
    }
  }
  return {
    metadata: { id: 't', name: 'Test', state: 'IN', lat: 0, lon: 0, surfaceElevationM: 160, surfaceElevationFt: 525, maxDepthM: 10, maxDepthFt: 33, meanDepthM: 5, meanDepthFt: 16, areaAcres: 1, perimeterKm: 1, geologicalOrigin: '', description: '', bounds: { minLat: 0, maxLat: 0.02, minLon: 0, maxLon: 0.02 } },
    gridSize: size,
    elevations, waterMask, depths,
    minElevation: 150, maxElevation: 192, waterElevation: 160, minDepth: 0, maxDepth: 10,
    physicalWidthKm: 2.0, physicalHeightKm: 1.5,
  };
}

function check(triangles: Triangle[]) {
  const edges = new Map<string, number>();
  const k = (p: { x: number; y: number; z: number }) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
  let volume = 0;
  for (const t of triangles) {
    const vs = [t.v1, t.v2, t.v3];
    for (let i = 0; i < 3; i++) {
      const a = vs[i], b = vs[(i + 1) % 3];
      const e = `${k(a)}|${k(b)}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
    // signed volume of tetrahedron with origin
    const { v1: a, v2: b, v3: c } = t;
    volume += (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
  }
  let bad = 0;
  for (const [e, count] of edges) {
    const [a, b] = e.split('|');
    const rev = edges.get(`${b}|${a}`) || 0;
    if (count !== 1 || rev !== 1) bad++;
  }
  return { volume, badEdges: bad, edgeCount: edges.size };
}

const grid = fakeGrid(24);
let failures = 0;
for (const terrace of [false, true]) {
  for (const cap of [false, true]) {
    const { triangles, stats } = generateWatertightSTLMesh(grid, {
      baseThicknessMm: 4, targetWidthMm: 120, verticalExaggeration: 3, includeWaterCap: cap, format: 'binary', terraceContours: terrace, terraceStepFt: 5,
    });
    const res = check(triangles);
    const ok = res.badEdges === 0 && res.volume > 0;
    console.log(`terrace=${terrace} cap=${cap}: tris=${stats.triangleCount} edges=${res.edgeCount} badEdges=${res.badEdges} volume=${res.volume.toFixed(1)}mm³ relief=${stats.reliefMm}mm ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures++;

    // orientation: highest top vertices (north ramp) must be at max Y
    const top = triangles.filter((t) => computeNormal(t.v1, t.v2, t.v3).z > 0.5);
    let bestZ = -Infinity, bestY = 0;
    for (const t of top) for (const v of [t.v1, t.v2, t.v3]) if (v.z > bestZ) { bestZ = v.z; bestY = v.y; }
    if (!(bestY > stats.lengthMm * 0.8)) { console.log('  FAIL: north edge is not at +Y (mirrored)'); failures++; }
  }
}
const bin = encodeBinarySTL(generateWatertightSTLMesh(grid, { baseThicknessMm: 4, targetWidthMm: 120, verticalExaggeration: 3, includeWaterCap: false, format: 'binary' }).triangles, 'Test');
console.log('binary STL bytes', bin.byteLength);
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all STL checks passed');
