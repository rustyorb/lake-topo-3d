/**
 * Contour-following routes: the loops of one depth contour, ready to drape on the viewers and
 * to export as GPX tracks for a sonar unit ("follow the 12-foot line").
 */
import { TerrainGridData } from '../types.js';
import { fieldFrom2D, isolines } from './contours.js';
import { cellSizeM, gridToLatLon } from './structure.js';

const FT_PER_M = 3.28084;

export interface Route {
  id: string;
  depthFt: number;
  /** Fractional grid coordinates ([col, row]). */
  points: Array<[number, number]>;
  lengthM: number;
  closed: boolean;
  /** Native DNR survey vector or a grid-derived isoline. */
  source: 'survey' | 'grid';
}

export function polylineLengthM(data: TerrainGridData, pts: Array<[number, number]>): number {
  const { w, h } = cellSizeM(data);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot((pts[i][0] - pts[i - 1][0]) * w, (pts[i][1] - pts[i - 1][1]) * h);
  return len;
}

/**
 * Loops of the `depthFt` contour, longest first. Uses the native survey vectors when the survey has
 * that exact depth, else the marching-squares isoline of the grid.
 */
export function contourRoutes(data: TerrainGridData, depthFt: number, useSurvey = true): Route[] {
  if (!(depthFt > 0)) return [];
  let lines: Array<{ pts: Array<[number, number]>; source: Route['source'] }>;
  const survey = useSurvey ? data.surveyContours?.filter((l) => Math.abs(l.depthFt - depthFt) < 0.01) : undefined;
  if (survey && survey.length) {
    lines = survey.map((l) => ({ pts: l.points, source: 'survey' as const }));
  } else {
    const { gridSize: n, elevations, waterElevation } = data;
    const rel = elevations.map((row) => row.map((e) => (e - waterElevation) * FT_PER_M));
    lines = isolines(fieldFrom2D(rel), n, n, -depthFt).map((pts) => ({ pts, source: 'grid' as const }));
  }
  const routes = lines
    .filter((l) => l.pts.length >= 4)
    .map((l) => {
      const first = l.pts[0];
      const last = l.pts[l.pts.length - 1];
      const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.01;
      return { depthFt, points: l.pts, lengthM: polylineLengthM(data, l.pts), closed, source: l.source };
    })
    .sort((a, b) => b.lengthM - a.lengthM);
  return routes.map((r, i) => ({ id: `route-${depthFt}-${i}`, ...r }));
}

export function routeLatLon(data: TerrainGridData, route: Route): Array<{ lat: number; lon: number }> {
  return route.points.map(([col, row]) => gridToLatLon(data, row, col));
}

/** "2,340 ft" under a mile, "1.24 mi" above it. */
export function formatLength(m: number): string {
  const ft = m * FT_PER_M;
  return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString()} ft`;
}
