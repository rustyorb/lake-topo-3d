import { GroundingSource, LakeMetadata, SpotElevation, SurveyContourLine, TerrainGridData, TopoFeature } from '../src/types.js';
import { performAiRecon, readChartImage, llmAvailable, llmDescription } from './aiRecon.js';
import { MIDWESTERN_LAKES, PredefinedLake } from './lakeData.js';
import { generateSvgTopoMap } from './topoMapGenerator.js';
import {
  OsmLake,
  Ring,
  distanceToShoreMetres,
  landDistanceToWaterCells,
  lookupLakeOSM,
  metresPerDegree,
  pointInLake,
  sampleDem,
} from './geoData.js';
import { sampleDem3dep } from './dem3dep.js';
import { IdnrOutline, IdnrSurvey, fetchIdnrSurvey, findIdnrOutline, findIdnrOutlineByName, findIdnrPdf, rasterizeContourDepths } from './idnrBathymetry.js';
import { lookupWikiFacts, WikiFacts } from './wikiData.js';

const FT_PER_M = 3.28084;
const ACRES_PER_KM2 = 247.105;

// ------------------------------------------------------------------ noise

function pseudoNoise(x: number, y: number, seed: number = 42): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number, seed: number = 42): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = pseudoNoise(i, j, seed);
  const n10 = pseudoNoise(i + 1, j, seed);
  const n01 = pseudoNoise(i, j + 1, seed);
  const n11 = pseudoNoise(i + 1, j + 1, seed);
  const nx0 = n00 * (1 - sx) + n10 * sx;
  const nx1 = n01 * (1 - sx) + n11 * sx;
  return nx0 * (1 - sy) + nx1 * sy;
}

function fbm(x: number, y: number, octaves: number = 4, seed: number = 101): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let o = 0; o < octaves; o++) {
    val += smoothNoise(x * freq, y * freq, seed + o * 13) * amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return val;
}

// ------------------------------------------------------------------ curated lookup

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findPredefinedLake(query: string): PredefinedLake | null {
  const q = normalise(query);
  if (q.length < 3) return null;
  for (const item of MIDWESTERN_LAKES) {
    const name = normalise(item.metadata.name);
    const state = normalise(item.metadata.state);
    if (q === name || q === `${name} ${state}` || q.startsWith(`${name} `) || q === `${name}`) return item;
  }
  // Distinctive word match ("monroe" → Lake Monroe) but never on generic words
  for (const item of MIDWESTERN_LAKES) {
    const words = normalise(item.metadata.name).split(' ').filter((w) => w.length > 3 && w !== 'lake');
    if (words.length && words.every((w) => q.split(' ').includes(w))) return item;
  }
  return null;
}

// ------------------------------------------------------------------ heuristic fallback

/**
 * Rough max-depth guess from surface area, used only when no survey / AI value exists.
 * Tuned to typical Midwestern natural lakes and reservoirs (kettles run deeper, flood-control
 * reservoirs shallower); always flagged as `depthIsEstimated` downstream.
 */
export function estimateMaxDepthM(areaAcres: number): number {
  return Math.round(Math.max(3, Math.min(22, 3 + Math.sqrt(Math.max(1, areaAcres)) * 0.2)) * 10) / 10;
}

function generateHeuristicLake(query: string): PredefinedLake {
  const cleanQuery = query.replace(/[^\w\s,]/g, '').trim();
  const parts = cleanQuery.split(',').map((s) => s.trim());
  const lakeName = parts[0] || 'Unnamed Lake';
  let state = parts[1] || 'Midwest, USA';

  const midwestStates = ['Indiana', 'Wisconsin', 'Michigan', 'Minnesota', 'Ohio', 'Illinois', 'Iowa', 'Missouri', 'Kentucky', 'Kansas', 'Nebraska'];
  for (const s of midwestStates) {
    if (query.toLowerCase().includes(s.toLowerCase())) { state = s; break; }
  }

  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash << 5) - hash + query.charCodeAt(i);
    hash |= 0;
  }
  const u1 = Math.abs(Math.sin(hash * 1.1));
  const u2 = Math.abs(Math.cos(hash * 2.3));
  const u3 = Math.abs(Math.sin(hash * 3.7));

  const lat = 39.5 + u1 * 6.5;
  const lon = -91.0 + u2 * 7.5;
  const surfaceElevationM = Math.round(180 + u3 * 160);
  const areaAcres = Math.round(150 + u1 * 2500);
  const maxDepthM = estimateMaxDepthM(areaAcres);
  const meanDepthM = Math.round(maxDepthM * (0.35 + u1 * 0.2) * 10) / 10;

  const latSpan = 0.02 + u2 * 0.03;
  const lonSpan = 0.03 + u1 * 0.04;

  const meta: LakeMetadata = {
    id: normalise(lakeName).replace(/\s+/g, '-') + '-' + state.toLowerCase().substring(0, 2),
    name: /lake|reservoir|pond/i.test(lakeName) ? lakeName : `${lakeName} Lake`,
    state,
    county: undefined,
    lat,
    lon,
    surfaceElevationM,
    surfaceElevationFt: Math.round(surfaceElevationM * FT_PER_M),
    maxDepthM,
    maxDepthFt: Math.round(maxDepthM * FT_PER_M * 10) / 10,
    meanDepthM,
    meanDepthFt: Math.round(meanDepthM * FT_PER_M * 10) / 10,
    areaAcres,
    perimeterKm: Math.round(Math.sqrt(areaAcres * 0.00404686) * 4.2 * 10) / 10,
    geologicalOrigin: 'Unknown — no survey record found; terrain below is a procedural placeholder.',
    description: 'No shoreline polygon or survey record could be found for this query, so this model is a generic procedural lake. Try a more specific name ("Patoka Lake, Indiana").',
    bounds: { minLat: lat - latSpan / 2, maxLat: lat + latSpan / 2, minLon: lon - lonSpan / 2, maxLon: lon + lonSpan / 2 },
    generationMethod: 'heuristic',
    depthIsEstimated: true,
    contourIntervalFt: 5,
    sources: [],
  };

  return {
    metadata: meta,
    shape: {
      type: u1 > 0.5 ? 'kettle' : 'complex_bays',
      aspectRatio: 0.9 + u2 * 0.6,
      lakeRadiusRatio: 0.38 + u3 * 0.06,
      rotationDeg: u1 * 180 - 90,
      bays: [
        { angleDeg: u1 * 120, distance: 0.35, radius: 0.18, depthMult: 0.7 },
        { angleDeg: 180 + u2 * 90, distance: 0.32, radius: 0.16, depthMult: 0.65 },
      ],
      deepestPointOffset: { x: (u1 - 0.5) * 0.3, y: (u2 - 0.5) * 0.3 },
      shorelineRoughness: 0.07 + u3 * 0.04,
    },
    terrainProfile: { moraineHeightM: 20 + u2 * 25, roughness: 0.5, surroundingSlope: 'glacial_till' },
  };
}

// ------------------------------------------------------------------ Deam Lake hand-built SDF (offline fallback)

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function smin(a: number, b: number, k = 0.05): number {
  const h = Math.max(k - Math.abs(a - b), 0.0) / k;
  return Math.min(a, b) - h * h * k * (1.0 / 4.0);
}

/**
 * Hand-built Deam Lake model (Clark County, IN) approximating the Indiana DNR bathymetric survey.
 * Used only when the live OpenStreetMap/DEM path is unavailable.
 */
function evaluateDeamLakePoint(
  normX: number,
  normY: number,
  metadata: LakeMetadata,
  terrainProfile: { moraineHeightM: number; roughness: number }
): { isWater: boolean; depthM: number; elevationM: number } {
  const x = normX * 0.78;
  const y = normY * 0.85;

  let d = 1e6;
  const dCenter = Math.hypot(x / 0.95, (y - 0.02) / 1.05) - 0.19;
  d = smin(d, dCenter, 0.08);
  const dSouthBasin = Math.hypot((x - 0.06) / 1.05, (y - 0.30) / 1.05) - 0.22;
  d = smin(d, dSouthBasin, 0.09);
  const dThroat = distToSegment(x, y, 0.0, 0.02, 0.06, 0.30) - 0.19;
  d = smin(d, dThroat, 0.08);
  d = smin(d, distToSegment(x, y, 0.06, 0.38, -0.08, 0.54) - 0.16, 0.06);
  d = smin(d, distToSegment(x, y, -0.08, 0.54, -0.35, 0.60) - 0.13, 0.06);
  d = smin(d, distToSegment(x, y, -0.35, 0.60, -0.62, 0.58) - 0.08, 0.06);
  d = smin(d, Math.hypot(x - -0.62, y - 0.58) - 0.08, 0.05);
  d = smin(d, distToSegment(x, y, -0.05, -0.04, -0.22, -0.14) - 0.13, 0.06);
  d = smin(d, distToSegment(x, y, -0.22, -0.14, -0.42, -0.26) - 0.10, 0.06);
  d = smin(d, distToSegment(x, y, -0.42, -0.26, -0.58, -0.42) - 0.07, 0.06);
  d = smin(d, Math.hypot(x - -0.58, y - -0.42) - 0.07, 0.05);
  d = smin(d, distToSegment(x, y, -0.25, -0.16, -0.28, -0.32) - 0.045, 0.035);
  d = smin(d, distToSegment(x, y, -0.15, 0.06, -0.36, 0.10) - 0.065, 0.04);
  d = smin(d, Math.hypot(x - -0.36, y - 0.10) - 0.065, 0.04);
  d = smin(d, distToSegment(x, y, -0.22, 0.25, -0.45, 0.22) - 0.04, 0.03);
  d = smin(d, distToSegment(x, y, 0.02, -0.06, 0.08, -0.26) - 0.14, 0.06);
  d = smin(d, distToSegment(x, y, 0.08, -0.26, 0.16, -0.48) - 0.11, 0.06);
  d = smin(d, distToSegment(x, y, 0.16, -0.48, 0.26, -0.70) - 0.09, 0.06);
  d = smin(d, distToSegment(x, y, 0.26, -0.70, 0.32, -0.84) - 0.075, 0.06);
  d = smin(d, Math.hypot(x - 0.32, y - -0.84) - 0.08, 0.05);
  d = smin(d, distToSegment(x, y, 0.12, -0.38, 0.0, -0.52) - 0.05, 0.04);
  d = smin(d, Math.hypot(x - 0.0, y - -0.54) - 0.05, 0.04);
  d = smin(d, distToSegment(x, y, 0.14, -0.32, 0.32, -0.28) - 0.04, 0.03);
  d = smin(d, distToSegment(x, y, 0.20, -0.48, 0.36, -0.44) - 0.04, 0.03);
  d = smin(d, distToSegment(x, y, 0.26, -0.66, 0.40, -0.62) - 0.04, 0.03);
  d = smin(d, distToSegment(x, y, 0.15, 0.0, 0.35, -0.04) - 0.08, 0.05);
  d = smin(d, distToSegment(x, y, 0.35, -0.04, 0.55, -0.12) - 0.04, 0.04);
  d = smin(d, distToSegment(x, y, 0.35, -0.04, 0.62, 0.02) - 0.04, 0.04);
  d = smin(d, distToSegment(x, y, 0.32, 0.08, 0.52, 0.10) - 0.035, 0.035);
  d = smin(d, distToSegment(x, y, 0.18, 0.26, 0.42, 0.26) - 0.04, 0.035);
  d += (fbm(normX * 8, normY * 8, 2, 412) - 0.5) * 0.008;

  if (d <= 0) {
    const shoreDist = -d;
    const shelfBreak = shoreDist < 0.02 ? (shoreDist / 0.02) * 5.0 : 5.0 + Math.min(1.0, (shoreDist - 0.02) / 0.035) * 7.0;
    const deepHoleDepth = Math.pow(Math.max(0, 1 - Math.hypot((x - 0.08) / 0.75, (y - 0.36) / 0.75) / 0.22), 1.6) * 30.0;
    const basinDepth = Math.pow(Math.max(0, 1 - Math.hypot((x - 0.05) / 0.95, (y - 0.28) / 1.0) / 0.26), 1.4) * 27.0;
    const swProg = Math.max(0, Math.min(1, (-x + 0.06) / 0.68));
    const swChannel = Math.pow(Math.max(0, 1 - distToSegment(x, y, 0.06, 0.45, -0.62, 0.60) / 0.12), 1.5) * (27.0 * (1 - swProg * 0.85) + 3.5);
    const centerDepth = Math.pow(Math.max(0, 1 - Math.hypot(x / 0.85, y / 0.85) / 0.23), 1.4) * 22.0;
    const nProg = Math.max(0, Math.min(1, (-y - 0.05) / 0.78));
    const nCenterDist = Math.min(
      distToSegment(x, y, 0.05, -0.05, 0.12, -0.32),
      distToSegment(x, y, 0.12, -0.32, 0.22, -0.55),
      distToSegment(x, y, 0.22, -0.55, 0.32, -0.84)
    );
    const nChannel = Math.pow(Math.max(0, 1 - nCenterDist / 0.10), 1.6) * (19.5 * (1 - nProg * 0.92) + 1.2);
    const nwProg = Math.max(0, Math.min(1, (-x - 0.05) / 0.55));
    const nwCenterDist = Math.min(distToSegment(x, y, -0.05, -0.04, -0.25, -0.16), distToSegment(x, y, -0.25, -0.16, -0.58, -0.42));
    const nwChannel = Math.pow(Math.max(0, 1 - nwCenterDist / 0.09), 1.5) * (14.5 * (1 - nwProg * 0.9) + 1.2);

    let depthFt = Math.max(shelfBreak, deepHoleDepth, basinDepth, swChannel, centerDepth, nChannel, nwChannel);
    depthFt = Math.max(0.5, Math.min(30.0, depthFt));
    const depthM = depthFt * 0.3048;
    return { isWater: true, depthM, elevationM: Math.round((metadata.surfaceElevationM - depthM) * 10) / 10 };
  }

  const distFromShore = d;
  const shoreBank = Math.min(1.0, distFromShore * 24) * 3.2;
  let damRelief = 0;
  if (normY > 0.44 && normY < 0.76 && normX > -0.76 && normX < 0.16) {
    const damCrestDist = Math.abs(d - 0.028);
    if (damCrestDist < 0.05) damRelief = Math.pow(1 - damCrestDist / 0.05, 1.8) * 4.2;
    if (normY > 0.60) damRelief -= Math.min(1.0, (normY - 0.60) * 9) * 13.5;
  }
  const rawRidge = 1 - Math.abs(fbm(normX * 2.8 + 11, normY * 2.8 + 11, 4, 711) * 2 - 1);
  const moraineElevation = Math.pow(rawRidge, 1.5) * terrainProfile.moraineHeightM;
  const basinRim = Math.min(1.0, Math.pow(distFromShore * 3.5, 0.85));
  const landElevation = metadata.surfaceElevationM + shoreBank + damRelief + moraineElevation * basinRim;
  return { isWater: false, depthM: 0, elevationM: Math.round(landElevation * 10) / 10 };
}

// ------------------------------------------------------------------ pipeline

export interface LakeGenerationOptions {
  forceAiRecon?: boolean;
  userNotes?: string;
  uploadedImage?: { base64: string; mimeType: string };
  /** Frame padding around the lake as a fraction of its longer side (default 0.28; ~0.06 for a lake-only frame). */
  framePad?: number;
  /** Skip every live lookup (OSM, DEM, IDNR, Wikipedia, LLM). */
  skipGeodata?: boolean;
}

interface Grid {
  elevations: number[][];
  waterMask: boolean[][];
  depths: number[][];
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bboxOfRings(polygons: Ring[][]): LakeMetadata['bounds'] {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const poly of polygons) for (const p of poly[0]) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Pads a shoreline bbox so surrounding terrain shows, and keeps the box from being extremely elongated. */
function frameBounds(bbox: LakeMetadata['bounds'], padFraction = 0.28): LakeMetadata['bounds'] {
  const cLat = (bbox.minLat + bbox.maxLat) / 2;
  const cLon = (bbox.minLon + bbox.maxLon) / 2;
  const m = metresPerDegree(cLat);
  let wM = (bbox.maxLon - bbox.minLon) * m.lon;
  let hM = (bbox.maxLat - bbox.minLat) * m.lat;
  const frac = Math.max(0.03, Math.min(0.6, padFraction));
  const pad = Math.max(frac < 0.15 ? 60 : 250, Math.max(wM, hM) * frac);
  wM += pad * 2;
  hM += pad * 2;
  if (wM / hM > 1.75) hM = wM / 1.75;
  if (hM / wM > 1.75) wM = hM / 1.75;
  return {
    minLat: cLat - hM / 2 / m.lat,
    maxLat: cLat + hM / 2 / m.lat,
    minLon: cLon - wM / 2 / m.lon,
    maxLon: cLon + wM / 2 / m.lon,
  };
}

function regionOf(osm: OsmLake): { county?: string; state?: string } {
  // US-style: "Clark County, Indiana"; elsewhere fall back to the country as the region label
  return { county: osm.county, state: osm.state || osm.country };
}

function inIndiana(lat: number, lon: number): boolean {
  return lat > 37.7 && lat < 41.8 && lon > -88.15 && lon < -84.75;
}

const IDNR_ATTRIBUTION = 'Indiana Department of Natural Resources, Division of Fish & Wildlife';

interface RealTerrain extends Grid {
  surfaceElevationM: number;
  demSource: '3dep' | 'terrarium';
  bathymetrySource: 'idnr-sonar' | 'distance-model';
  maxDepthM: number;
  survey: IdnrSurvey | null;
}

/**
 * Builds the terrain grid from a real shoreline polygon and a real DEM. Bathymetry comes from
 * IDNR sonar contours when the lake is in the Indiana survey; otherwise a distance-to-shore bowl
 * scaled to maxDepth.
 */
async function buildRealTerrain(
  polygons: Ring[][],
  size: number,
  bounds: LakeMetadata['bounds'],
  maxDepthM: number,
  survey: IdnrSurvey | null,
  demPreference: 'auto' | '3dep' | 'terrarium'
): Promise<RealTerrain | null> {
  let demElev: number[][] | null = null;
  let demSource: '3dep' | 'terrarium' = 'terrarium';
  if (demPreference !== 'terrarium') {
    demElev = await sampleDem3dep(bounds, size, size);
    if (demElev) demSource = '3dep';
  }
  if (!demElev && demPreference !== '3dep') {
    const dem = await sampleDem(bounds, size, size);
    if (dem) { demElev = dem.elevations; demSource = 'terrarium'; }
  }
  if (!demElev) return null;

  const waterMask: boolean[][] = [];
  const surfaceSamples: number[] = [];
  for (let r = 0; r < size; r++) {
    waterMask[r] = [];
    const lat = bounds.maxLat - (r / (size - 1)) * (bounds.maxLat - bounds.minLat);
    for (let c = 0; c < size; c++) {
      const lon = bounds.minLon + (c / (size - 1)) * (bounds.maxLon - bounds.minLon);
      const w = pointInLake(lon, lat, polygons);
      waterMask[r][c] = w;
      if (w) surfaceSamples.push(demElev[r][c]);
    }
  }
  if (surfaceSamples.length < 6) return null;
  const surfaceElevationM = Math.round(median(surfaceSamples) * 10) / 10;

  const m = metresPerDegree((bounds.minLat + bounds.maxLat) / 2);
  const cellW = ((bounds.maxLon - bounds.minLon) * m.lon) / (size - 1);
  const cellH = ((bounds.maxLat - bounds.minLat) * m.lat) / (size - 1);

  const depths: number[][] = [];
  let bathymetrySource: RealTerrain['bathymetrySource'] = 'distance-model';
  let observedMaxM = 0;
  if (survey) {
    const raster = rasterizeContourDepths(survey, waterMask, bounds, maxDepthM > 0 ? maxDepthM * FT_PER_M : undefined);
    for (let r = 0; r < size; r++) depths[r] = raster.depthsFt[r].map((ft) => Math.round(ft * 0.3048 * 100) / 100);
    bathymetrySource = 'idnr-sonar';
    observedMaxM = raster.maxDepthFt * 0.3048;
  } else {
    const shoreDist = distanceToShoreMetres(waterMask, cellW, cellH);
    let dMax = 1;
    for (const row of shoreDist) for (const v of row) if (v > dMax) dMax = v;
    for (let r = 0; r < size; r++) {
      depths[r] = [];
      for (let c = 0; c < size; c++) {
        if (!waterMask[r][c]) { depths[r][c] = 0; continue; }
        const t = shoreDist[r][c] / dMax;
        const noise = (fbm((c / size) * 9 + 3, (r / size) * 9 + 7, 2, 88) - 0.5) * 0.08;
        const ratio = Math.max(0.03, Math.min(1, Math.pow(t, 0.85) + noise * t));
        depths[r][c] = Math.round(ratio * maxDepthM * 100) / 100;
        if (depths[r][c] > observedMaxM) observedMaxM = depths[r][c];
      }
    }
  }

  const nearShore = landDistanceToWaterCells(waterMask, 2);
  const elevations: number[][] = [];
  for (let r = 0; r < size; r++) {
    elevations[r] = [];
    for (let c = 0; c < size; c++) {
      if (waterMask[r][c]) {
        elevations[r][c] = Math.round((surfaceElevationM - depths[r][c]) * 100) / 100;
      } else {
        let e = demElev[r][c];
        // DEM pixels straddling the shoreline read the water surface; keep the bank just above it.
        if (nearShore[r][c] <= 2 && e < surfaceElevationM + 0.3) e = surfaceElevationM + 0.3 + (2 - nearShore[r][c]) * 0.2;
        elevations[r][c] = Math.round(e * 100) / 100;
      }
    }
  }
  return { elevations, waterMask, depths, surfaceElevationM, demSource, bathymetrySource, maxDepthM: observedMaxM, survey };
}

function buildProceduralTerrain(lake: PredefinedLake, size: number): Grid {
  const { metadata, shape, terrainProfile } = lake;
  const isDeam = shape.customSdfId === 'deam-lake';
  const rad = (shape.rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const elevations: number[][] = [];
  const waterMask: boolean[][] = [];
  const depths: number[][] = [];

  for (let r = 0; r < size; r++) {
    elevations[r] = [];
    waterMask[r] = [];
    depths[r] = [];
    const normY = (r / (size - 1)) * 2 - 1;
    for (let c = 0; c < size; c++) {
      const normX = (c / (size - 1)) * 2 - 1;
      if (isDeam) {
        const pt = evaluateDeamLakePoint(normX, normY, metadata, terrainProfile);
        elevations[r][c] = pt.elevationM;
        waterMask[r][c] = pt.isWater;
        depths[r][c] = pt.depthM;
        continue;
      }
      const rotX = normX * cosR - normY * sinR;
      const rotY = normX * sinR + normY * cosR;
      const distX = rotX / (shape.aspectRatio || 1.0);
      const distY = rotY;
      const baseDist = Math.sqrt(distX * distX + distY * distY);
      const angle = Math.atan2(distY, distX);
      let shoreNoise = Math.sin(angle * 3 + 0.5) * 0.08 + Math.cos(angle * 5 - 1.2) * 0.05 + Math.sin(angle * 8) * 0.03;
      if (shape.bays) {
        for (const bay of shape.bays) {
          const bayAngleRad = (bay.angleDeg * Math.PI) / 180;
          const bayDiff = Math.abs(Math.atan2(Math.sin(angle - bayAngleRad), Math.cos(angle - bayAngleRad)));
          if (bayDiff < 0.6) shoreNoise += Math.cos((bayDiff / 0.6) * (Math.PI / 2)) * bay.radius * 0.8;
        }
      }
      const fractalShore = (fbm(normX * 4 + 5, normY * 4 + 5, 3, 202) - 0.5) * shape.shorelineRoughness;
      const lakeBoundary = shape.lakeRadiusRatio + shoreNoise + fractalShore;
      let isWater = baseDist <= lakeBoundary;
      if (isWater && shape.islands) {
        for (const isl of shape.islands) {
          if (Math.hypot(distX - isl.x, distY - isl.y) < isl.radius) { isWater = false; break; }
        }
      }
      waterMask[r][c] = isWater;

      if (isWater) {
        const penetration = Math.min(1.0, Math.max(0.0, (lakeBoundary - baseDist) / lakeBoundary));
        const deepX = distX - shape.deepestPointOffset.x;
        const deepY = distY - shape.deepestPointOffset.y;
        const deepFactor = Math.max(0.0, 1.0 - Math.hypot(deepX, deepY) / (lakeBoundary * 1.2));
        const shelfDrop = penetration < 0.08 ? (penetration / 0.08) * 0.35 : 0.35 + (penetration - 0.08) * 0.65;
        const dropoffCurve = Math.pow(shelfDrop, 1.4) * 0.55 + Math.pow(deepFactor, 1.6) * 0.45;
        const underNoise = (fbm(normX * 8, normY * 8, 2, 88) - 0.5) * 0.06;
        const depthRatio = Math.max(0.02, Math.min(1.0, dropoffCurve + underNoise));
        const depthM = depthRatio * metadata.maxDepthM;
        depths[r][c] = depthM;
        elevations[r][c] = Math.round((metadata.surfaceElevationM - depthM) * 10) / 10;
      } else {
        depths[r][c] = 0;
        const distFromShore = baseDist - lakeBoundary;
        const shorelineRise = Math.min(1.0, distFromShore * 22) * 2.8;
        const rawTopo = 1.0 - Math.abs(fbm(normX * 2.8 + 12, normY * 2.8 + 14, 4, 303) * 2 - 1);
        const moraineElevation = Math.pow(rawTopo, 1.4) * terrainProfile.moraineHeightM;
        const basinRim = Math.min(1.0, Math.pow(distFromShore * 3.5, 0.85));
        elevations[r][c] = Math.round((metadata.surfaceElevationM + shorelineRise + moraineElevation * basinRim) * 10) / 10;
      }
    }
  }
  return { elevations, waterMask, depths };
}

// ------------------------------------------------------------------ cache

const resultCache = new Map<string, { at: number; data: TerrainGridData }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 40;
export const MAX_GRID = 160;

/**
 * Native survey contour polylines re-expressed in fractional grid coordinates so the SVG map
 * and the 3D viewer can draw the surveyed lines themselves rather than a re-contoured grid.
 * Points outside the frame are dropped and the line is split there.
 */
function surveyContoursToGrid(survey: IdnrSurvey, bounds: LakeMetadata['bounds'], size: number): SurveyContourLine[] {
  const out: SurveyContourLine[] = [];
  const lonSpan = Math.max(1e-12, bounds.maxLon - bounds.minLon);
  const latSpan = Math.max(1e-12, bounds.maxLat - bounds.minLat);
  for (const line of survey.contours) {
    if (!(line.depthFt > 0) || line.coords.length < 2) continue;
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length >= 2) out.push({ depthFt: line.depthFt, points: run });
      run = [];
    };
    for (const p of line.coords) {
      const col = ((p.lon - bounds.minLon) / lonSpan) * (size - 1);
      const row = ((bounds.maxLat - p.lat) / latSpan) * (size - 1);
      if (col < -0.5 || row < -0.5 || col > size - 0.5 || row > size - 0.5) { flush(); continue; }
      run.push([Math.round(col * 100) / 100, Math.round(row * 100) / 100]);
    }
    flush();
  }
  return out;
}

/** Local DEM maxima on land, spaced out, like the spot heights printed on a paper topo. */
function computeSpotElevations(elevations: number[][], waterMask: boolean[][], size: number, waterElevationM: number, max = 6): SpotElevation[] {
  const rad = Math.max(3, Math.round(size / 16));
  const cands: Array<{ row: number; col: number; elev: number }> = [];
  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      if (waterMask[r][c]) continue;
      const e = elevations[r][c];
      if (e < waterElevationM + 3) continue; // ignore the bank itself
      let isMax = true;
      for (let dr = -rad; dr <= rad && isMax; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size || (!dr && !dc)) continue;
          if (elevations[rr][cc] > e) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ row: r, col: c, elev: e });
    }
  }
  cands.sort((a, b) => b.elev - a.elev);
  const kept: SpotElevation[] = [];
  for (const k of cands) {
    if (kept.some((x) => Math.hypot(x.row - k.row, x.col - k.col) < rad * 2)) continue;
    kept.push({ row: k.row, col: k.col, elevFt: Math.round(k.elev * FT_PER_M) });
    if (kept.length >= max) break;
  }
  return kept;
}

export function clearTerrainCache(): void {
  resultCache.clear();
}

function setDepth(metadata: LakeMetadata, maxM: number, meanM?: number) {
  metadata.maxDepthM = Math.round(maxM * 100) / 100;
  metadata.maxDepthFt = Math.round(maxM * FT_PER_M * 10) / 10;
  const mean = meanM && meanM > 0 && meanM < maxM ? meanM : maxM * 0.42;
  metadata.meanDepthM = Math.round(mean * 100) / 100;
  metadata.meanDepthFt = Math.round(mean * FT_PER_M * 10) / 10;
}

export async function generateLakeTerrainGrid(
  query: string,
  gridSize: number = 64,
  options?: LakeGenerationOptions
): Promise<TerrainGridData> {
  const requestedSize = Math.max(32, Math.min(Math.round(gridSize) || 64, MAX_GRID));
  const cacheKey = options?.uploadedImage
    ? null
    : JSON.stringify([query.trim().toLowerCase(), requestedSize, !!options?.forceAiRecon, options?.userNotes || '', !!options?.skipGeodata, options?.framePad ?? 0.28]);
  if (cacheKey) {
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  }
  const live = !options?.skipGeodata;

  // ---- 0. an uploaded chart may tell us the lake's name and printed depths
  let chart: Awaited<ReturnType<typeof readChartImage>> = null;
  let lookupQuery = query;
  if (options?.uploadedImage && live) {
    chart = await readChartImage(options.uploadedImage.base64, options.uploadedImage.mimeType, query);
    if (chart?.name) lookupQuery = [chart.name, chart.county, chart.state].filter(Boolean).join(', ');
  }

  // ---- 1. base metadata: curated → heuristic (real sources layer on top below)
  const curated = findPredefinedLake(lookupQuery) || (chart?.name ? findPredefinedLake(chart.name) : null);
  const base: PredefinedLake = curated || generateHeuristicLake(lookupQuery);
  const metadata: LakeMetadata = JSON.parse(JSON.stringify(base.metadata));
  metadata.generationMethod = curated ? 'curated-survey' : 'heuristic';
  metadata.depthIsEstimated = !curated;
  metadata.sources = metadata.sources || [];
  const notes: string[] = [];

  // ---- 2. shoreline + survey + facts
  let osm: OsmLake | null = null;
  let survey: IdnrSurvey | null = null;
  let wiki: WikiFacts | null = null;
  let polygons: Ring[][] | null = null;
  let shorelineName = '';

  let idnrOnly: IdnrOutline | null = null; // Indiana fallback when the geocoder is unavailable
  if (live) {
    osm = await lookupLakeOSM(lookupQuery);
    if (osm && curated) {
      const far = Math.abs(osm.lat - curated.metadata.lat) > 0.5 || Math.abs(osm.lon - curated.metadata.lon) > 0.5;
      if (far) { console.warn('[geodata] OSM match is far from curated coordinates, ignoring:', osm.displayName); osm = null; }
    }
    if (!osm && /\b(indiana|,\s*in)\b/i.test(lookupQuery) || (!osm && curated?.metadata.state === 'Indiana')) {
      const parts = lookupQuery.split(',').map((x) => x.trim());
      idnrOnly = await findIdnrOutlineByName(parts[0], parts.find((x) => /county/i.test(x)));
      if (idnrOnly) {
        survey = await fetchIdnrSurvey(idnrOnly);
        polygons = idnrOnly.polygons;
        shorelineName = idnrOnly.name;
        const bb = bboxOfRings(polygons);
        metadata.lat = (bb.minLat + bb.maxLat) / 2;
        metadata.lon = (bb.minLon + bb.maxLon) / 2;
        metadata.state = 'Indiana';
        if (!curated && idnrOnly.name) metadata.name = idnrOnly.name;
        if (survey?.county) metadata.county = `${survey.county} County`;
        const [wikiFacts, pdf] = await Promise.all([
          lookupWikiFacts({ name: metadata.name, lat: metadata.lat, lon: metadata.lon, region: 'Indiana' }),
          findIdnrPdf(metadata.name, survey?.county),
        ]);
        wiki = wikiFacts;
        if (pdf) metadata.dnrPdfUrl = pdf.url;
        notes.push('Geocoder unavailable; lake located through the Indiana DNR survey service.');
      }
    }
    if (osm) {
      polygons = osm.polygons;
      shorelineName = osm.name;
      const [idnrOutline, wikiFacts, pdf] = await Promise.all([
        inIndiana(osm.lat, osm.lon) ? findIdnrOutline(osm.lon, osm.lat) : Promise.resolve(null),
        lookupWikiFacts({ name: osm.name || lookupQuery, wikidataId: osm.wikidataId, lat: osm.lat, lon: osm.lon, region: regionOf(osm).state }),
        inIndiana(osm.lat, osm.lon) ? findIdnrPdf(osm.name || lookupQuery, regionOf(osm).county) : Promise.resolve(null),
      ]);
      wiki = wikiFacts;
      if (idnrOutline) {
        survey = await fetchIdnrSurvey(idnrOutline);
        if (survey) {
          // The DNR contours were digitised against this NHD outline; use it so contours stay inside the shore
          polygons = idnrOutline.polygons;
          shorelineName = idnrOutline.name || shorelineName;
        }
      }
      if (pdf) metadata.dnrPdfUrl = pdf.url;
    }
  }

  // ---- 3. depth precedence: IDNR survey > curated > Wikipedia > chart > (AI later) > estimate
  const dn = osm ? regionOf(osm) : {};
  if (osm) {
    metadata.lat = osm.lat;
    metadata.lon = osm.lon;
    metadata.osmId = `${osm.osmType}/${osm.osmId}`;
    metadata.wikidataId = osm.wikidataId || wiki?.wikidataId;
    if (!curated) {
      metadata.name = shorelineName || osm.name || metadata.name;
      if (dn.state) metadata.state = dn.state;
    }
    if (dn.county && (!metadata.county || !curated)) metadata.county = dn.county;
  }
  if (survey?.county && !metadata.county) metadata.county = `${survey.county} County`;

  let depthKnown = !!curated;
  if (!depthKnown && wiki?.maxDepthM) {
    setDepth(metadata, wiki.maxDepthM, wiki.meanDepthM);
    depthKnown = true;
    metadata.generationMethod = 'wikipedia';
    metadata.depthIsEstimated = false;
  } else if (curated && wiki?.meanDepthM && !(metadata.meanDepthM > 0)) {
    setDepth(metadata, metadata.maxDepthM, wiki.meanDepthM);
  }
  if (!depthKnown && chart?.maxDepthFt) {
    setDepth(metadata, chart.maxDepthFt * 0.3048, chart.meanDepthFt ? chart.meanDepthFt * 0.3048 : undefined);
    depthKnown = true;
    metadata.generationMethod = 'ai-topo-vision';
    metadata.depthIsEstimated = false;
  }
  if (wiki) {
    if (wiki.url) metadata.wikipediaUrl = wiki.url;
    if (!curated && wiki.extract) metadata.description = wiki.extract;
    if (!curated && wiki.lakeType) metadata.geologicalOrigin = `${wiki.lakeType}${wiki.inflows ? `; inflow ${wiki.inflows}` : ''}${wiki.outflows ? `; outflow ${wiki.outflows}` : ''} (Wikipedia infobox).`;
    metadata.sources.push({
      title: wiki.title ? `Wikipedia: ${wiki.title}` : `Wikidata ${wiki.wikidataId}`,
      uri: wiki.url || (wiki.wikidataId ? `https://www.wikidata.org/wiki/${wiki.wikidataId}` : undefined),
      sourceType: 'wikipedia',
      snippet: [wiki.maxDepthM ? `max depth ${Math.round(wiki.maxDepthM * FT_PER_M)} ft` : null, wiki.meanDepthM ? `mean ${Math.round(wiki.meanDepthM * FT_PER_M)} ft` : null, wiki.surfaceElevationM ? `elevation ${Math.round(wiki.surfaceElevationM * FT_PER_M)} ft` : null, wiki.areaKm2 ? `${Math.round(wiki.areaKm2 * ACRES_PER_KM2)} ac` : null].filter(Boolean).join(', ') || wiki.shortDescription,
    });
  }

  // ---- 4. optional LLM: fills remaining gaps, never overrides sourced numbers
  if (live && llmAvailable() && (options?.forceAiRecon || !depthKnown || !curated)) {
    const recon = await performAiRecon({
      name: metadata.name,
      region: metadata.state,
      county: metadata.county,
      lat: metadata.lat,
      lon: metadata.lon,
      knownFacts: {
        'max depth (ft)': depthKnown ? metadata.maxDepthFt : undefined,
        'surface area (acres)': osm ? Math.round(osm.areaKm2 * ACRES_PER_KM2) : undefined,
        'shoreline (km)': osm ? Math.round(osm.perimeterKm * 10) / 10 : undefined,
        'IDNR sonar survey': survey ? `${survey.surveyDate}, ${survey.intervalFt} ft contours to ${survey.maxContourFt} ft` : undefined,
        'lake type': wiki?.lakeType,
      },
      wikipediaExtract: wiki?.extract,
      userNotes: options?.userNotes,
    });
    if (recon) {
      metadata.llmProvider = `${recon.provider}/${recon.model}`;
      if (!depthKnown && recon.maxDepthFt) {
        setDepth(metadata, recon.maxDepthFt * 0.3048, recon.meanDepthFt ? recon.meanDepthFt * 0.3048 : undefined);
        depthKnown = true;
        metadata.depthIsEstimated = !recon.searchGrounded;
        metadata.generationMethod = recon.searchGrounded ? 'ai-search-grounded' : 'ai-synthesis';
      } else if (depthKnown && recon.meanDepthFt && metadata.meanDepthM === Math.round(metadata.maxDepthM * 0.42 * 100) / 100) {
        setDepth(metadata, metadata.maxDepthM, recon.meanDepthFt * 0.3048);
      }
      if (!curated) {
        if (recon.geologicalOrigin) metadata.geologicalOrigin = recon.geologicalOrigin;
        if (recon.description && !wiki?.extract) metadata.description = recon.description;
        if (recon.county && !metadata.county) metadata.county = recon.county;
      }
      if (recon.features.length) metadata.topoFeatures = [...(metadata.topoFeatures || []), ...recon.features];
      for (const s of recon.sources) if (!metadata.sources.some((x) => x.uri && x.uri === s.uri)) metadata.sources.push(s);
      notes.push(`${recon.searchGrounded ? 'Web-grounded' : 'Unverified'} LLM recon (${recon.provider}/${recon.model})${recon.notes ? `: ${recon.notes}` : ''}`);
    }
  }

  // ---- 5. geometry + DEM
  let size = requestedSize;
  let grid: Grid | null = null;
  let real: RealTerrain | null = null;
  if (polygons) {
    const bbox = bboxOfRings(polygons);
    const bounds = frameBounds(bbox, options?.framePad);
    const areaKm2 = osm?.areaKm2 || idnrOnly?.areaKm2 || 0;
    const perimKm = osm?.perimeterKm || 0;
    if (areaKm2 > 60 || perimKm > 150) size = Math.max(size, MAX_GRID);
    else if (areaKm2 > 12 || perimKm > 50) size = Math.max(size, Math.min(MAX_GRID, 128));
    let maxDepthM = metadata.maxDepthM;
    if (!depthKnown || !(maxDepthM > 0)) {
      maxDepthM = estimateMaxDepthM(Math.round(areaKm2 * ACRES_PER_KM2));
      setDepth(metadata, maxDepthM);
      metadata.depthIsEstimated = true;
    }
    const demPref = (process.env.DEM_SOURCE as 'auto' | '3dep' | 'terrarium') || 'auto';
    real = await buildRealTerrain(polygons, size, bounds, maxDepthM, survey, demPref);
    if (real) {
      grid = real;
      metadata.bounds = bounds;
      metadata.geometrySource = 'osm-dem';
      metadata.demSource = real.demSource;
      metadata.bathymetrySource = real.bathymetrySource;
      metadata.surfaceElevationM = real.surfaceElevationM;
      metadata.surfaceElevationFt = Math.round(real.surfaceElevationM * FT_PER_M);
      if (osm) {
        metadata.areaAcres = Math.round(osm.areaKm2 * ACRES_PER_KM2);
        metadata.perimeterKm = Math.round(osm.perimeterKm * 10) / 10;
      } else if (idnrOnly) {
        metadata.areaAcres = Math.round(idnrOnly.areaKm2 * ACRES_PER_KM2);
      }
      metadata.id = `${normalise(metadata.name).replace(/\s+/g, '-')}-${(metadata.osmId || 'osm').replace('/', '-')}`;
      if (survey) {
        // Survey wins over every other depth source
        setDepth(metadata, real.maxDepthM, metadata.depthIsEstimated ? undefined : metadata.meanDepthM);
        metadata.depthIsEstimated = false;
        metadata.generationMethod = curated ? 'curated-survey' : 'idnr-survey';
        metadata.surveyDate = survey.surveyDate || undefined;
        metadata.contourIntervalFt = Math.max(2, survey.intervalFt);
        if (survey.lakeAcres) metadata.areaAcres = survey.lakeAcres;
        if (!curated) metadata.geologicalOrigin = metadata.geologicalOrigin || 'See Indiana DNR survey notes.';
        metadata.sources.unshift({
          title: `${IDNR_ATTRIBUTION} — sonar bathymetric survey${survey.surveyDate ? ` (${survey.surveyDate})` : ''}`,
          uri: 'https://www.indianamap.org/maps/bea7752105a840afbbee1256f9b7a19b',
          sourceType: 'dnr_survey',
          snippet: `${survey.contours.length} contour lines at ${survey.intervalFt} ft intervals, deepest contour ${survey.maxContourFt} ft. Depth grid interpolated between contours. Credit: Indiana DNR.`,
        });
        notes.push(`Bathymetry interpolated from ${survey.contours.length} IDNR sonar contours (${survey.intervalFt} ft interval, survey ${survey.surveyDate || 'date unknown'}).`);
      } else {
        notes.push(`Bathymetry modelled from distance to shore and scaled to ${metadata.maxDepthFt} ft (${metadata.depthIsEstimated ? 'estimated' : 'on record'}).`);
      }
      if (metadata.dnrPdfUrl) {
        metadata.sources.push({ title: 'Indiana DNR published lake depth map (PDF)', uri: metadata.dnrPdfUrl, sourceType: 'dnr_survey', snippet: 'Official Fish & Wildlife depth map. Credit: Indiana DNR.' });
      }
      if (osm) {
        metadata.sources.push({
          title: `OpenStreetMap ${osm.osmType} ${osm.osmId} — ${osm.displayName}`,
          uri: `https://www.openstreetmap.org/${osm.osmType}/${osm.osmId}`,
          sourceType: 'osm',
          snippet: `Shoreline polygon${survey ? ' (frame); IDNR/NHD outline used for the water mask' : ''}. ${osm.licence}`,
        });
      }
      metadata.sources.push(
        real.demSource === '3dep'
          ? { title: 'USGS 3D Elevation Program (3DEP) — LiDAR-derived DEM', uri: 'https://www.usgs.gov/3d-elevation-program', sourceType: 'dem', snippet: `Ground elevation from the National Map 3DEP image service (1 m where LiDAR exists; Indiana is fully covered). Lake surface = median DEM inside the shoreline.` }
          : { title: 'Terrarium terrain tiles (AWS Open Data / Mapzen)', uri: 'https://registry.opendata.aws/terrain-tiles/', sourceType: 'dem', snippet: 'Ground elevation from public terrain tiles (SRTM / NED composite). Lake surface = median tile elevation inside the polygon.' }
      );
      if (metadata.generationMethod === 'heuristic') {
        metadata.description = `${metadata.name} — shoreline from OpenStreetMap, terrain from ${real.demSource === '3dep' ? 'USGS 3DEP LiDAR' : 'Terrarium tiles'}. No Wikipedia record with a depth was found; depth profile is estimated.`;
      }
    }
  }

  if (!grid) {
    grid = buildProceduralTerrain(base, size);
    metadata.geometrySource = base.shape.customSdfId === 'deam-lake' ? 'curated-sdf' : 'procedural';
    metadata.bathymetrySource = base.shape.customSdfId === 'deam-lake' ? 'curated-sdf' : 'procedural';
    metadata.demSource = 'synthetic';
    if (!metadata.generationMethod) metadata.generationMethod = 'heuristic';
  }

  // ---- 6. statistics, computed features, SVG map
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let maxObservedDepth = 0;
  let deepest: [number, number] = [0, 0];
  let highest: [number, number] = [0, 0];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const e = grid.elevations[r][c];
      if (e < minElevation) minElevation = e;
      if (e > maxElevation) { maxElevation = e; highest = [r, c]; }
      if (grid.depths[r][c] > maxObservedDepth) { maxObservedDepth = grid.depths[r][c]; deepest = [r, c]; }
    }
  }

  if (metadata.geometrySource === 'osm-dem') {
    // Curated/AI landmark positions are in their own frame; keep them as unplaced notes and add computed markers.
    const toNorm = (rc: [number, number]) => ({ normX: (rc[1] / (size - 1)) * 2 - 1, normY: (rc[0] / (size - 1)) * 2 - 1 });
    const unplaced = (metadata.topoFeatures || []).filter((f) => f.label !== 'Highest ground in frame' && !/deepest|max depth/i.test(f.label)).map((f) => ({ ...f, normX: NaN, normY: NaN }));
    const computed: TopoFeature[] = [
      {
        label: survey ? `Deepest point (IDNR survey)` : metadata.depthIsEstimated ? 'Modelled deepest point' : 'Max depth (on record), modelled position',
        type: 'deep_hole', ...toNorm(deepest),
        depthOrElevFt: Math.round(maxObservedDepth * FT_PER_M * 10) / 10,
        description: survey ? 'Deepest cell of the contour-interpolated survey grid' : 'Deepest cell of the distance-to-shore model',
      },
      { label: 'Highest ground in frame', type: 'ridge', ...toNorm(highest), depthOrElevFt: Math.round(maxElevation * FT_PER_M), description: 'Highest DEM sample inside the map frame' },
    ];
    metadata.topoFeatures = [...computed, ...unplaced];
  }

  const latDistKm = (metadata.bounds.maxLat - metadata.bounds.minLat) * (metresPerDegree(metadata.lat).lat / 1000);
  const lonDistKm = (metadata.bounds.maxLon - metadata.bounds.minLon) * (metresPerDegree(metadata.lat).lon / 1000);
  if (chart?.notes) notes.unshift(`Chart reading (${chart.provider}/${chart.model}): ${chart.notes}`);
  if (notes.length) metadata.topoAnalysisNotes = notes.join(' ');
  if (!metadata.contourIntervalFt) metadata.contourIntervalFt = 5;

  const partial: TerrainGridData = {
    metadata,
    gridSize: size,
    elevations: grid.elevations,
    waterMask: grid.waterMask,
    depths: grid.depths,
    minElevation,
    maxElevation,
    waterElevation: metadata.surfaceElevationM,
    minDepth: 0,
    maxDepth: maxObservedDepth || metadata.maxDepthM,
    physicalWidthKm: Math.round(lonDistKm * 100) / 100,
    physicalHeightKm: Math.round(latDistKm * 100) / 100,
  };
  if (survey && metadata.geometrySource === 'osm-dem' && metadata.bathymetrySource === 'idnr-sonar') {
    partial.surveyContours = surveyContoursToGrid(survey, metadata.bounds, size);
  }
  if (metadata.geometrySource === 'osm-dem') {
    partial.spotElevations = computeSpotElevations(grid.elevations, grid.waterMask, size, metadata.surfaceElevationM);
  }
  partial.svgTopoMap = generateSvgTopoMap(partial);

  if (cacheKey) {
    if (resultCache.size >= CACHE_MAX) {
      const oldest = resultCache.keys().next().value;
      if (oldest !== undefined) resultCache.delete(oldest);
    }
    resultCache.set(cacheKey, { at: Date.now(), data: partial });
  }
  return partial;
}

export { llmAvailable, llmDescription };
