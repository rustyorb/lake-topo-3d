/**
 * Windblown shore: the stretches of shoreline that face into the wind, where waves pile up bait.
 */
import { TerrainGridData } from '../types.js';
import { fieldFrom2D, isolines, sampleBilinear } from './contours.js';

/**
 * Shoreline runs whose land-side normal faces into a wind blowing from `fromDeg` (compass degrees),
 * as polylines in fractional grid coordinates ([col, row]).
 */
export function windblownShore(data: TerrainGridData, fromDeg: number, minDot = 0.35): Array<Array<[number, number]>> {
  const { gridSize: n, elevations, waterElevation, waterMask } = data;
  const rel = elevations.map((row) => row.map((e) => e - waterElevation));
  const shore = isolines(fieldFrom2D(rel), n, n, 0);
  // The wind blows toward fromDeg + 180. Grid axes: east = +col, north = -row.
  const to = ((fromDeg + 180) * Math.PI) / 180;
  const wx = Math.sin(to);
  const wy = -Math.cos(to);
  const inLake = (x: number, y: number) => {
    const r = Math.round(y), c = Math.round(x);
    return r >= 0 && c >= 0 && r < n && c < n && waterMask[r][c];
  };
  const out: Array<Array<[number, number]>> = [];
  for (const line of shore) {
    let run: Array<[number, number]> | null = null;
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      let nx = -dy / len, ny = dx / len;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      // Point the normal at the land (the side where the relative elevation is positive)
      if (sampleBilinear(rel, mx + nx * 0.8, my + ny * 0.8) < 0) { nx = -nx; ny = -ny; }
      // Only real lake shore counts, not a land depression that happens to dip below the pool
      if (!inLake(mx - nx * 1.2, my - ny * 1.2)) { run = null; continue; }
      if (nx * wx + ny * wy >= minDot) {
        if (!run) { run = [line[i - 1]]; out.push(run); }
        run.push(line[i]);
      } else run = null;
    }
  }
  return out.filter((r) => r.length >= 3);
}
