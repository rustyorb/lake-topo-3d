/**
 * Vertical shaping shared by the 3D viewer and the STL/3MF exporter.
 *
 * `depthBoost` exaggerates the lake bed on top of the global vertical exaggeration
 * without touching the land. Both are anchored at the water surface, so the
 * shoreline stays continuous: land rises at 1×, the bed drops at `depthBoost`×.
 * Deam Lake has ~40 ft of depth inside ~200 ft of surrounding relief; at one
 * global scale the bed you fish is a sliver, so this is what makes it readable.
 */
import type { TerrainGridData } from '../types.js';

/** Elevation with the bed pushed down by `depthBoost` (metres MSL, relative to the same datum). */
export function boostedElevation(elevM: number, waterElevM: number, isWater: boolean, depthBoost: number): number {
  const b = Math.max(1, depthBoost || 1);
  return isWater ? waterElevM - (waterElevM - elevM) * b : elevM;
}

/** Lowest boosted elevation in the grid: the datum the base plate sits under. */
export function boostedMinElevation(data: TerrainGridData, depthBoost: number): number {
  const b = Math.max(1, depthBoost || 1);
  return Math.min(data.minElevation, data.waterElevation - data.maxDepth * b);
}

/** Total boosted relief span, metres. */
export function boostedSpan(data: TerrainGridData, depthBoost: number): number {
  return Math.max(0.5, data.maxElevation - boostedMinElevation(data, depthBoost));
}

/**
 * A boost that makes the lake bed as tall as the land is high, capped to a sane range.
 * Flat-country lakes with little land relief get 1×; hilly reservoirs get a big lift.
 */
export function suggestDepthBoost(data: TerrainGridData): number {
  const landRelief = Math.max(0, data.maxElevation - data.waterElevation);
  const depth = Math.max(0.3, data.maxDepth);
  return Math.round(Math.max(1, Math.min(8, landRelief / depth)) * 10) / 10;
}
