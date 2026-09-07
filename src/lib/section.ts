/**
 * Cross-section sampling: the bottom (and bank) profile along a straight line between two grid points.
 */
import { TerrainGridData } from '../types.js';
import { sampleBilinear } from './contours.js';
import { cellSizeM, gridToLatLon, StructureFeature } from './structure.js';

const FT_PER_M = 3.28084;

export interface GridPoint { row: number; col: number }

export interface SectionSample {
  distanceM: number;
  /** Feet relative to the water surface: negative under water, positive on land. */
  relFt: number;
  isWater: boolean;
  lat: number;
  lon: number;
}

export interface SectionProfile {
  samples: SectionSample[];
  lengthM: number;
  minRelFt: number;
  maxRelFt: number;
}

export function sampleSection(data: TerrainGridData, a: GridPoint, b: GridPoint, n = 220): SectionProfile {
  const { w, h } = cellSizeM(data);
  const last = data.gridSize - 1;
  const clamp = (v: number) => Math.max(0, Math.min(last, v));
  const lengthM = Math.hypot((b.col - a.col) * w, (b.row - a.row) * h);
  const samples: SectionSample[] = [];
  let minRelFt = Infinity;
  let maxRelFt = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const col = clamp(a.col + (b.col - a.col) * t);
    const row = clamp(a.row + (b.row - a.row) * t);
    const elevM = sampleBilinear(data.elevations, col, row);
    const relFt = (elevM - data.waterElevation) * FT_PER_M;
    const isWater = data.waterMask[Math.round(row)][Math.round(col)];
    const { lat, lon } = gridToLatLon(data, row, col);
    samples.push({ distanceM: lengthM * t, relFt, isWater, lat, lon });
    if (relFt < minRelFt) minRelFt = relFt;
    if (relFt > maxRelFt) maxRelFt = relFt;
  }
  return { samples, lengthM, minRelFt, maxRelFt };
}

export interface NearFeature {
  feature: StructureFeature;
  /** Distance along the section from A, metres. */
  distanceM: number;
}

/** Structure features whose marker lies within `tolCells` of the A–B segment, projected onto it. */
export function featuresNearLine(data: TerrainGridData, features: StructureFeature[], a: GridPoint, b: GridPoint, tolCells = 2.5): NearFeature[] {
  const dx = b.col - a.col;
  const dy = b.row - a.row;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return [];
  const { w, h } = cellSizeM(data);
  const lengthM = Math.hypot(dx * w, dy * h);
  const out: NearFeature[] = [];
  for (const f of features) {
    const t = ((f.col - a.col) * dx + (f.row - a.row) * dy) / len2;
    if (t < 0 || t > 1) continue;
    const px = a.col + dx * t;
    const py = a.row + dy * t;
    if (Math.hypot(f.col - px, f.row - py) > tolCells) continue;
    out.push({ feature: f, distanceM: lengthM * t });
  }
  return out.sort((p, q) => p.distanceM - q.distanceM);
}
