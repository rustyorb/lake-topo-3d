/**
 * Fishing structure detection on the terrain grid.
 *
 * Pure grid math shared by the browser (markers, panel) and the verification script.
 * Everything here derives from `depths`, `elevations` and `waterMask`; nothing is guessed.
 *
 *  - hole      local depth maximum with prominence over the surrounding bottom
 *  - hump      isolated shallow top surrounded by deeper water, away from shore
 *  - drop-off  connected run of steep bottom (breakline)
 *  - point     land protruding into the lake, with the depth it runs out to
 *  - flat      broad, gently sloping shelf at fishable depth
 *  - saddle    shallowest crossing between two holes
 */
import { TerrainGridData } from '../types.js';
import { sampleBilinear } from './contours.js';

export type StructureKind = 'hole' | 'hump' | 'drop-off' | 'point' | 'flat' | 'saddle';

export interface StructureFeature {
  id: string;
  kind: StructureKind;
  /** Grid position (row 0 = north, col 0 = west); fractional allowed. */
  row: number;
  col: number;
  lat: number;
  lon: number;
  /** Depth at the marker, feet. */
  depthFt: number;
  /** Depth range covered by the feature, feet (min, max). */
  depthRangeFt: [number, number];
  label: string;
  detail: string;
  score: number;
  cells: number;
  slopeDeg?: number;
}

export const STRUCTURE_STYLE: Record<StructureKind, { name: string; plural: string; color: string; hex: number; glyph: string }> = {
  hole: { name: 'Hole', plural: 'Holes', color: '#3b82f6', hex: 0x3b82f6, glyph: '◎' },
  hump: { name: 'Hump', plural: 'Humps', color: '#f59e0b', hex: 0xf59e0b, glyph: '▲' },
  'drop-off': { name: 'Drop-off', plural: 'Drop-offs', color: '#ef4444', hex: 0xef4444, glyph: '⟋' },
  point: { name: 'Point', plural: 'Points', color: '#22c55e', hex: 0x22c55e, glyph: '➤' },
  flat: { name: 'Flat', plural: 'Flats', color: '#a3e635', hex: 0xa3e635, glyph: '▭' },
  saddle: { name: 'Saddle', plural: 'Saddles', color: '#a855f7', hex: 0xa855f7, glyph: '⌣' },
};

export const STRUCTURE_KINDS: StructureKind[] = ['hole', 'hump', 'drop-off', 'point', 'flat', 'saddle'];

const FT_PER_M = 3.28084;
const ACRE_M2 = 4046.856;

export function gridToLatLon(data: TerrainGridData, row: number, col: number): { lat: number; lon: number } {
  const b = data.metadata.bounds;
  const n = data.gridSize;
  return {
    lat: b.maxLat - (row / (n - 1)) * (b.maxLat - b.minLat),
    lon: b.minLon + (col / (n - 1)) * (b.maxLon - b.minLon),
  };
}

export function latLonToGrid(data: TerrainGridData, lat: number, lon: number): { row: number; col: number } {
  const b = data.metadata.bounds;
  const n = data.gridSize;
  return {
    row: ((b.maxLat - lat) / Math.max(1e-12, b.maxLat - b.minLat)) * (n - 1),
    col: ((lon - b.minLon) / Math.max(1e-12, b.maxLon - b.minLon)) * (n - 1),
  };
}

/** Cell pitch in metres (east-west, north-south). */
export function cellSizeM(data: TerrainGridData): { w: number; h: number } {
  const n = Math.max(2, data.gridSize);
  return {
    w: Math.max(0.5, ((data.physicalWidthKm || 1) * 1000) / (n - 1)),
    h: Math.max(0.5, ((data.physicalHeightKm || 1) * 1000) / (n - 1)),
  };
}

/** Bed slope in degrees from central differences on the elevation grid. */
export function slopeDegrees(data: TerrainGridData): number[][] {
  const { gridSize: n, elevations } = data;
  const { w, h } = cellSizeM(data);
  const out: number[][] = [];
  for (let r = 0; r < n; r++) {
    out[r] = new Array(n).fill(0);
    for (let c = 0; c < n; c++) {
      const c0 = Math.max(0, c - 1), c1 = Math.min(n - 1, c + 1);
      const r0 = Math.max(0, r - 1), r1 = Math.min(n - 1, r + 1);
      const dzdx = (elevations[r][c1] - elevations[r][c0]) / ((c1 - c0) * w);
      const dzdy = (elevations[r1][c] - elevations[r0][c]) / ((r1 - r0) * h);
      out[r][c] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

/** Distance in cells from the nearest land cell, for water cells (0 on land). */
export function waterDistanceToShoreCells(waterMask: boolean[][]): number[][] {
  const n = waterMask.length;
  const dist: number[][] = [];
  const qr: number[] = [];
  const qc: number[] = [];
  for (let r = 0; r < n; r++) {
    dist[r] = new Array(n).fill(Infinity);
    for (let c = 0; c < n; c++) {
      if (!waterMask[r][c]) { dist[r][c] = 0; qr.push(r); qc.push(c); }
    }
  }
  let head = 0;
  while (head < qr.length) {
    const r = qr[head], c = qc[head];
    head++;
    const d = dist[r][c] + 1;
    const nb: Array<[number, number]> = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    for (const [rr, cc] of nb) {
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      if (dist[rr][cc] > d) { dist[rr][cc] = d; qr.push(rr); qc.push(cc); }
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!Number.isFinite(dist[r][c])) dist[r][c] = 0;
  return dist;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function ft(m: number, digits = 0): number {
  const f = m * FT_PER_M;
  const k = Math.pow(10, digits);
  return Math.round(f * k) / k;
}

/** Connected components over a boolean grid (4- or 8-connectivity). */
function components(mask: boolean[][], eight: boolean): Array<Array<[number, number]>> {
  const n = mask.length;
  const seen: boolean[][] = mask.map((row) => row.map(() => false));
  const comps: Array<Array<[number, number]>> = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!mask[r][c] || seen[r][c]) continue;
      const comp: Array<[number, number]> = [];
      const stack: Array<[number, number]> = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop()!;
        comp.push([cr, cc]);
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (!eight && dr !== 0 && dc !== 0) continue;
            const rr = cr + dr, c2 = cc + dc;
            if (rr < 0 || c2 < 0 || rr >= n || c2 >= n) continue;
            if (mask[rr][c2] && !seen[rr][c2]) { seen[rr][c2] = true; stack.push([rr, c2]); }
          }
        }
      }
      comps.push(comp);
    }
  }
  return comps;
}

function centroidCell(comp: Array<[number, number]>): [number, number] {
  let sr = 0, sc = 0;
  for (const [r, c] of comp) { sr += r; sc += c; }
  const cr = sr / comp.length, cc = sc / comp.length;
  let best = comp[0], bestD = Infinity;
  for (const cell of comp) {
    const d = Math.hypot(cell[0] - cr, cell[1] - cc);
    if (d < bestD) { bestD = d; best = cell; }
  }
  return best;
}

/** Keeps the strongest candidates, dropping any within `radius` cells of a stronger one. */
function suppress<T extends { row: number; col: number; score: number }>(items: T[], radius: number, max: number): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const it of sorted) {
    if (kept.some((k) => Math.hypot(k.row - it.row, k.col - it.col) < radius)) continue;
    kept.push(it);
    if (kept.length >= max) break;
  }
  return kept;
}

export interface StructureOptions {
  maxHoles?: number;
  maxHumps?: number;
  maxDropOffs?: number;
  maxPoints?: number;
  maxFlats?: number;
  maxSaddles?: number;
}

export function analyzeStructure(data: TerrainGridData, opts: StructureOptions = {}): StructureFeature[] {
  const { gridSize: n, depths, waterMask } = data;
  if (!n || n < 8) return [];
  const slope = slopeDegrees(data);
  const shoreDist = waterDistanceToShoreCells(waterMask);
  const { w: cellW, h: cellH } = cellSizeM(data);
  const cellDiagM = Math.hypot(cellW, cellH);
  const maxDepthM = Math.max(0.3, data.maxDepth);
  const out: StructureFeature[] = [];

  const make = (kind: StructureKind, row: number, col: number, depthM: number, range: [number, number], label: string, detail: string, score: number, cells: number, slopeDeg?: number): StructureFeature => {
    const { lat, lon } = gridToLatLon(data, row, col);
    return { id: `${kind}-${Math.round(row)}-${Math.round(col)}`, kind, row, col, lat, lon, depthFt: ft(depthM, 1), depthRangeFt: [ft(range[0]), ft(range[1])], label, detail, score, cells, slopeDeg };
  };

  const ringStats = (r0: number, c0: number, inner: number, outer: number) => {
    let sum = 0, cnt = 0, min = Infinity, max = -Infinity;
    for (let dr = -outer; dr <= outer; dr++) {
      for (let dc = -outer; dc <= outer; dc++) {
        const d = Math.hypot(dr, dc);
        if (d < inner || d > outer) continue;
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= n || c >= n || !waterMask[r][c]) continue;
        const v = depths[r][c];
        sum += v; cnt++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return { mean: cnt ? sum / cnt : 0, min: cnt ? min : 0, max: cnt ? max : 0, cnt };
  };

  const windowExtreme = (r0: number, c0: number, rad: number, wantMax: boolean): boolean => {
    const v = depths[r0][c0];
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (!dr && !dc) continue;
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= n || c >= n || !waterMask[r][c]) continue;
        if (wantMax ? depths[r][c] > v : depths[r][c] < v) return false;
      }
    }
    return true;
  };

  // ---- holes
  {
    const cands: Array<StructureFeature> = [];
    for (let r = 1; r < n - 1; r++) {
      for (let c = 1; c < n - 1; c++) {
        if (!waterMask[r][c]) continue;
        const d = depths[r][c];
        if (d < Math.max(0.9, maxDepthM * 0.2)) continue;
        if (!windowExtreme(r, c, 2, true)) continue;
        const ring = ringStats(r, c, 4, 7);
        if (ring.cnt < 12) continue;
        const prom = d - ring.mean;
        if (prom < 0.45) continue;
        cands.push(make('hole', r, c, d, [ring.mean, d], 'Hole', `${ft(d)} ft hole, ${ft(prom)} ft below the surrounding ${ft(ring.mean)} ft bottom`, prom * d, 1));
      }
    }
    const kept = suppress(cands, 7, opts.maxHoles ?? 6);
    if (kept.length) {
      const deepest = kept.reduce((a, b) => (b.depthFt > a.depthFt ? b : a));
      deepest.label = 'Deepest hole';
    }
    out.push(...kept);
  }

  // ---- humps
  {
    const cands: Array<StructureFeature> = [];
    for (let r = 1; r < n - 1; r++) {
      for (let c = 1; c < n - 1; c++) {
        if (!waterMask[r][c] || shoreDist[r][c] < 3) continue;
        const d = depths[r][c];
        if (!windowExtreme(r, c, 2, false)) continue;
        const ring = ringStats(r, c, 4, 6);
        if (ring.cnt < 12) continue;
        if (ring.min < d + 0.3) continue;          // must be surrounded by deeper water
        const rise = ring.mean - d;
        if (rise < 0.6) continue;
        cands.push(make('hump', r, c, d, [d, ring.mean], 'Hump', `Tops out at ${ft(d)} ft, rises ${ft(rise)} ft off a ${ft(ring.mean)} ft bottom`, rise, 1));
      }
    }
    out.push(...suppress(cands, 6, opts.maxHumps ?? 6));
  }

  // ---- drop-offs / breaklines
  {
    const waterSlopes: number[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (waterMask[r][c] && shoreDist[r][c] >= 1) waterSlopes.push(slope[r][c]);
    const thr = Math.max(4, percentile(waterSlopes, 0.8));
    const steep = waterMask.map((row, r) => row.map((w, c) => w && shoreDist[r][c] >= 1 && slope[r][c] >= thr));
    const minCells = Math.max(5, Math.round(n / 20));
    const feats: StructureFeature[] = [];
    for (const comp of components(steep, true)) {
      if (comp.length < minCells) continue;
      let sSum = 0, dMin = Infinity, dMax = -Infinity, rMin = n, rMax = 0, cMin = n, cMax = 0;
      for (const [r, c] of comp) {
        sSum += slope[r][c];
        const d = depths[r][c];
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (c < cMin) cMin = c; if (c > cMax) cMax = c;
      }
      if (dMax < 0.9 || dMax - dMin < 0.6) continue; // a wet fringe or a canal edge, not a break
      const meanSlope = sSum / comp.length;
      const [r, c] = centroidCell(comp);
      const lengthM = Math.hypot((rMax - rMin) * cellH, (cMax - cMin) * cellW) + cellDiagM;
      feats.push(make('drop-off', r, c, depths[r][c], [dMin, dMax], 'Drop-off', `${ft(dMin)}→${ft(dMax)} ft break, avg ${Math.round(meanSlope)}°, ~${Math.round(lengthM * FT_PER_M)} ft long`, comp.length * meanSlope, comp.length, Math.round(meanSlope * 10) / 10));
    }
    out.push(...suppress(feats, 4, opts.maxDropOffs ?? 8));
  }

  // ---- points
  {
    const R = Math.max(3, Math.round(n / 24));
    const shoreLand: boolean[][] = waterMask.map((row, r) => row.map((w, c) => {
      if (w) return false;
      const nb: Array<[number, number]> = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      return nb.some(([rr, cc]) => rr >= 0 && cc >= 0 && rr < n && cc < n && waterMask[rr][cc]);
    }));
    const frac: number[][] = [];
    const dirR: number[][] = [];
    const dirC: number[][] = [];
    for (let r = 0; r < n; r++) {
      frac[r] = new Array(n).fill(0); dirR[r] = new Array(n).fill(0); dirC[r] = new Array(n).fill(0);
      for (let c = 0; c < n; c++) {
        if (!shoreLand[r][c]) continue;
        let water = 0, total = 0, sr = 0, sc = 0;
        for (let dr = -R; dr <= R; dr++) {
          for (let dc = -R; dc <= R; dc++) {
            if (Math.hypot(dr, dc) > R) continue;
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
            total++;
            if (waterMask[rr][cc]) { water++; sr += dr; sc += dc; }
          }
        }
        frac[r][c] = total ? water / total : 0;
        const len = Math.hypot(sr, sc) || 1;
        dirR[r][c] = sr / len; dirC[r][c] = sc / len;
      }
    }
    const cands: StructureFeature[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!shoreLand[r][c] || frac[r][c] < 0.52) continue;
        let isMax = true;
        for (let dr = -R; dr <= R && isMax; dr++) {
          for (let dc = -R; dc <= R; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= n || cc >= n || !shoreLand[rr][cc]) continue;
            if (frac[rr][cc] > frac[r][c]) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        // Walk out along the water direction to see how far and deep the point runs.
        const dr = dirR[r][c], dc = dirC[r][c];
        let endDepth = 0, endDist = 0, markerRow = r + dr * 1.5, markerCol = c + dc * 1.5;
        let prev = 0;
        for (let s = 1; s <= 3 * R; s += 0.5) {
          const rr = r + dr * s, cc = c + dc * s;
          if (rr < 0 || cc < 0 || rr > n - 1 || cc > n - 1) break;
          if (!waterMask[Math.round(rr)][Math.round(cc)]) break;
          const d = sampleBilinear(depths, cc, rr);
          // The point "ends" where the bottom stops dropping (or starts rising again).
          if (s > R && d < prev - 0.15) break;
          prev = d; endDepth = d; endDist = s;
        }
        if (endDepth < 0.6 || endDist < 1) continue; // ran into a channel or another pond
        const distM = endDist * Math.hypot(dr * cellH, dc * cellW);
        const depthAtMarker = sampleBilinear(depths, markerCol, markerRow);
        cands.push({
          ...make('point', markerRow, markerCol, depthAtMarker, [depthAtMarker, endDepth], 'Point', `Runs out to ${ft(endDepth)} ft about ${Math.round(distM * FT_PER_M)} ft off the bank`, frac[r][c] + endDepth / (maxDepthM * 10), 1),
          id: `point-${r}-${c}`,
        });
      }
    }
    out.push(...suppress(cands, R * 1.5, opts.maxPoints ?? 8));
  }

  // ---- flats
  {
    const flatMask = waterMask.map((row, r) => row.map((w, c) => w && shoreDist[r][c] >= 2 && slope[r][c] < 2.5 && depths[r][c] >= 0.9 && depths[r][c] <= 4.6));
    const minCells = Math.max(20, Math.round((n * n) / 200));
    const feats: StructureFeature[] = [];
    for (const comp of components(flatMask, false)) {
      if (comp.length < minCells) continue;
      let sum = 0, dMin = Infinity, dMax = -Infinity;
      for (const [r, c] of comp) { const d = depths[r][c]; sum += d; if (d < dMin) dMin = d; if (d > dMax) dMax = d; }
      const mean = sum / comp.length;
      const [r, c] = centroidCell(comp);
      const acres = (comp.length * cellW * cellH) / ACRE_M2;
      feats.push(make('flat', r, c, depths[r][c], [dMin, dMax], 'Flat', `${ft(mean)} ft flat (${ft(dMin)}–${ft(dMax)} ft), about ${acres < 10 ? acres.toFixed(1) : Math.round(acres)} acres`, comp.length, comp.length));
    }
    out.push(...suppress(feats, 6, opts.maxFlats ?? 5));
  }

  // ---- saddles between holes
  {
    const holes = out.filter((f) => f.kind === 'hole');
    const cands: StructureFeature[] = [];
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const a = holes[i], b = holes[j];
        const dist = Math.hypot(a.row - b.row, a.col - b.col);
        if (dist < 4 || dist > n / 3) continue;
        let minD = Infinity, at = 0.5;
        let allWater = true;
        const steps = Math.max(8, Math.round(dist * 2));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const rr = a.row + (b.row - a.row) * t, cc = a.col + (b.col - a.col) * t;
          if (!waterMask[Math.round(rr)][Math.round(cc)]) { allWater = false; break; }
          const d = sampleBilinear(depths, cc, rr);
          if (d < minD) { minD = d; at = t; }
        }
        if (!allWater || !Number.isFinite(minD)) continue;
        const aD = a.depthFt / FT_PER_M, bD = b.depthFt / FT_PER_M;
        if (minD > Math.min(aD, bD) - 0.6 || minD < 0.6) continue;
        const rr = a.row + (b.row - a.row) * at, cc = a.col + (b.col - a.col) * at;
        cands.push({
          ...make('saddle', rr, cc, minD, [minD, Math.min(aD, bD)], 'Saddle', `${ft(minD)} ft saddle between ${Math.round(a.depthFt)} ft and ${Math.round(b.depthFt)} ft holes`, Math.min(aD, bD) - minD, 1),
          id: `saddle-${Math.round(rr)}-${Math.round(cc)}`,
        });
      }
    }
    out.push(...suppress(cands, 4, opts.maxSaddles ?? 4));
  }

  return out;
}

/** True when any part of the feature sits inside the depth band (feet). */
export function inDepthBand(f: StructureFeature, minFt: number, maxFt: number): boolean {
  const lo = Math.min(f.depthRangeFt[0], f.depthRangeFt[1], f.depthFt);
  const hi = Math.max(f.depthRangeFt[0], f.depthRangeFt[1], f.depthFt);
  return hi >= minFt && lo <= maxFt;
}
