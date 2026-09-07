/**
 * Sounding rasteriser sanity check: 300 random soundings of a known bowl-with-a-hole must come back
 * as a grid close to the truth, zero at the shore, never deeper than the deepest sounding.
 *
 *   npx tsx scripts/verify-soundings.ts
 */
import { rasterizeSoundings, hashSoundings, type Sounding } from '../server/soundings.js';

const N = 96;
const bounds = { minLat: 39.99, maxLat: 40.01, minLon: -86.012, maxLon: -85.988 };
const truth = (nx: number, ny: number): number => {
  const d = Math.hypot(nx / 0.8, ny / 0.6);
  if (d >= 1) return 0;
  return (1 - d) * 10 + (Math.hypot(nx + 0.3, ny) < 0.18 ? 4 * (1 - Math.hypot(nx + 0.3, ny) / 0.18) : 0);
};
const waterMask: boolean[][] = [];
for (let r = 0; r < N; r++) {
  waterMask[r] = [];
  for (let c = 0; c < N; c++) waterMask[r][c] = Math.hypot(((c / (N - 1)) * 2 - 1) / 0.8, ((r / (N - 1)) * 2 - 1) / 0.6) < 1;
}

// Deterministic LCG so the run is repeatable
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const points: Sounding[] = [];
while (points.length < 300) {
  const nx = rand() * 2 - 1, ny = rand() * 2 - 1;
  const d = truth(nx, ny);
  if (d <= 0) continue;
  points.push({ lat: bounds.maxLat - ((ny + 1) / 2) * (bounds.maxLat - bounds.minLat), lon: bounds.minLon + ((nx + 1) / 2) * (bounds.maxLon - bounds.minLon), depthM: d });
}
// A few junk points: on land, off the frame, NaN — all must be ignored
points.push({ lat: 40.5, lon: -86, depthM: 3 }, { lat: 40, lon: -85.99, depthM: NaN }, { lat: 39.9905, lon: -86.0115, depthM: 5 });

let failures = 0;
const expect = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok  ', msg); };

const t0 = Date.now();
const ras = rasterizeSoundings(points, waterMask, bounds);
const ms = Date.now() - t0;
expect(ras.used === 300, `used ${ras.used} of ${points.length} points (junk ignored)`);

let sq = 0, cnt = 0, shoreSum = 0, shoreCnt = 0;
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    if (!waterMask[r][c]) { expect(ras.depthsM[r][c] === 0 || failures > 5, 'land cells stay 0'); continue; }
    const nx = (c / (N - 1)) * 2 - 1, ny = (r / (N - 1)) * 2 - 1;
    const d = Math.hypot(nx / 0.8, ny / 0.6);
    const isShore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => !waterMask[r + dr]?.[c + dc]);
    if (isShore) { shoreSum += ras.depthsM[r][c]; shoreCnt++; continue; }
    if (d > 0.9) continue; // the fringe is dominated by the shore constraint by design
    sq += (ras.depthsM[r][c] - truth(nx, ny)) ** 2;
    cnt++;
  }
}
const rmse = Math.sqrt(sq / cnt);
const maxSample = Math.max(...points.filter((p) => Number.isFinite(p.depthM)).map((p) => p.depthM));
expect(rmse < 0.8, `interior RMSE ${rmse.toFixed(2)} m against the true bowl (${cnt} cells)`);
expect(shoreSum / shoreCnt < 0.8, `shore cells average ${(shoreSum / shoreCnt).toFixed(2)} m`);
expect(ras.maxDepthM <= maxSample + 0.01, `never deeper than the deepest sounding (${ras.maxDepthM.toFixed(2)} ≤ ${maxSample.toFixed(2)} m)`);
expect(ras.maxDepthM >= maxSample * 0.85, `deepest cell keeps most of the deepest sounding (${ras.maxDepthM.toFixed(2)} vs ${maxSample.toFixed(2)} m)`);
expect(ms < 2000, `rasterised ${N}² in ${ms} ms`);

const few = rasterizeSoundings(points.slice(0, 2), waterMask, bounds);
expect(few.used === 2 && few.maxDepthM === 0, 'fewer than 3 usable points yields an empty raster');
expect(hashSoundings(points) !== hashSoundings(points.slice(1)) && hashSoundings(points) === hashSoundings([...points]), 'hash is content-based');

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('soundings verification passed');
