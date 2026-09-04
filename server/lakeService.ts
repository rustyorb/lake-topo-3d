import { GroundingSource, LakeMetadata, TerrainGridData, TopoFeature } from '../src/types.js';
import { analyzeUploadedTopoMap, performAiTopoRecon, geminiAvailable } from './geminiTopoService.js';
import { MIDWESTERN_LAKES, PredefinedLake } from './lakeData.js';
import { generateSvgTopoMap } from './topoMapGenerator.js';
import {
  OsmLake,
  distanceToShoreMetres,
  landDistanceToWaterCells,
  lookupLakeOSM,
  metresPerDegree,
  pointInLake,
  sampleDem,
} from './geoData.js';

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
  /** Skip the live OpenStreetMap / DEM lookup (offline / testing). */
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

/** Pads the OSM bounding box so surrounding terrain shows, and keeps the box from being extremely elongated. */
function frameBounds(osm: OsmLake): LakeMetadata['bounds'] {
  const m = metresPerDegree(osm.lat);
  let wM = (osm.bbox.maxLon - osm.bbox.minLon) * m.lon;
  let hM = (osm.bbox.maxLat - osm.bbox.minLat) * m.lat;
  const pad = Math.max(250, Math.max(wM, hM) * 0.28);
  wM += pad * 2;
  hM += pad * 2;
  // limit aspect ratio so grid cells stay roughly square
  if (wM / hM > 1.75) hM = wM / 1.75;
  if (hM / wM > 1.75) wM = hM / 1.75;
  const cLat = (osm.bbox.minLat + osm.bbox.maxLat) / 2;
  const cLon = (osm.bbox.minLon + osm.bbox.maxLon) / 2;
  return {
    minLat: cLat - hM / 2 / m.lat,
    maxLat: cLat + hM / 2 / m.lat,
    minLon: cLon - wM / 2 / m.lon,
    maxLon: cLon + wM / 2 / m.lon,
  };
}

function parseDisplayName(displayName: string): { county?: string; state?: string } {
  const parts = displayName.split(',').map((s) => s.trim());
  const county = parts.find((p) => /county|parish/i.test(p));
  // "..., Clark County, Indiana, United States" → state is the part before the country
  const state = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return { county, state: state && !/^\d/.test(state) ? state : undefined };
}

/**
 * Builds the terrain grid from a real shoreline polygon and real DEM. Bathymetry is modelled
 * from distance-to-shore (no free public bathymetry exists for most lakes) and scaled to maxDepth.
 */
async function buildRealTerrain(
  osm: OsmLake,
  size: number,
  bounds: LakeMetadata['bounds'],
  maxDepthM: number
): Promise<(Grid & { surfaceElevationM: number; demZoom: number }) | null> {
  const dem = await sampleDem(bounds, size, size);
  if (!dem) return null;

  const waterMask: boolean[][] = [];
  const surfaceSamples: number[] = [];
  for (let r = 0; r < size; r++) {
    waterMask[r] = [];
    const lat = bounds.maxLat - (r / (size - 1)) * (bounds.maxLat - bounds.minLat);
    for (let c = 0; c < size; c++) {
      const lon = bounds.minLon + (c / (size - 1)) * (bounds.maxLon - bounds.minLon);
      const w = pointInLake(lon, lat, osm.polygons);
      waterMask[r][c] = w;
      if (w) surfaceSamples.push(dem.elevations[r][c]);
    }
  }
  if (surfaceSamples.length < 6) return null; // polygon too small for this grid

  const surfaceElevationM = Math.round(median(surfaceSamples) * 10) / 10;

  const m = metresPerDegree((bounds.minLat + bounds.maxLat) / 2);
  const cellW = ((bounds.maxLon - bounds.minLon) * m.lon) / (size - 1);
  const cellH = ((bounds.maxLat - bounds.minLat) * m.lat) / (size - 1);
  const shoreDist = distanceToShoreMetres(waterMask, cellW, cellH);
  let dMax = 0;
  for (const row of shoreDist) for (const v of row) if (v > dMax) dMax = v;
  dMax = Math.max(dMax, 1);

  const nearShore = landDistanceToWaterCells(waterMask, 2);

  const elevations: number[][] = [];
  const depths: number[][] = [];
  for (let r = 0; r < size; r++) {
    elevations[r] = [];
    depths[r] = [];
    for (let c = 0; c < size; c++) {
      if (waterMask[r][c]) {
        // Bowl profile: gentle littoral shelf, steeper toward the thalweg, small organic variation.
        const t = shoreDist[r][c] / dMax;
        const profile = Math.pow(t, 0.85);
        const noise = (fbm(c / size * 9 + 3, r / size * 9 + 7, 2, 88) - 0.5) * 0.08;
        const ratio = Math.max(0.03, Math.min(1, profile + noise * t));
        const depthM = Math.round(ratio * maxDepthM * 100) / 100;
        depths[r][c] = depthM;
        elevations[r][c] = Math.round((surfaceElevationM - depthM) * 100) / 100;
      } else {
        depths[r][c] = 0;
        let e = dem.elevations[r][c];
        // DEM pixels straddling the shoreline read the water surface; keep the bank just above it.
        if (nearShore[r][c] <= 2 && e < surfaceElevationM + 0.3) e = surfaceElevationM + 0.3 + (2 - nearShore[r][c]) * 0.2;
        elevations[r][c] = Math.round(e * 100) / 100;
      }
    }
  }
  return { elevations, waterMask, depths, surfaceElevationM, demZoom: dem.zoom };
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
export const MAX_GRID = 160;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 40;

export function clearTerrainCache(): void {
  resultCache.clear();
}

export async function generateLakeTerrainGrid(
  query: string,
  gridSize: number = 64,
  options?: LakeGenerationOptions
): Promise<TerrainGridData> {
  const requestedSize = Math.max(32, Math.min(Math.round(gridSize) || 64, MAX_GRID));
  const cacheKey = options?.uploadedImage
    ? null
    : JSON.stringify([query.trim().toLowerCase(), requestedSize, !!options?.forceAiRecon, options?.userNotes || '', !!options?.skipGeodata]);
  if (cacheKey) {
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  }

  // ---- 1. metadata source: uploaded chart → AI recon → curated → heuristic
  let lake: PredefinedLake | null = null;
  let aiNotes: string | undefined;

  if (options?.uploadedImage) {
    const vision = await analyzeUploadedTopoMap(options.uploadedImage.base64, options.uploadedImage.mimeType, query);
    if (vision) { lake = vision.lake; aiNotes = vision.analysisNotes; }
  }

  const curated = findPredefinedLake(query);
  if (!lake && (options?.forceAiRecon || (!curated && geminiAvailable()))) {
    const recon = await performAiTopoRecon(query, options?.userNotes);
    if (recon) { lake = recon.lake; aiNotes = recon.analysisNotes; }
  }
  if (!lake) lake = curated;
  if (!lake) lake = generateHeuristicLake(query);

  // Deep-clone metadata so cache entries and the curated table never share mutable objects
  const metadata: LakeMetadata = JSON.parse(JSON.stringify(lake.metadata));
  if (!metadata.generationMethod) metadata.generationMethod = curated && lake === curated ? 'curated-survey' : 'heuristic';
  if (metadata.depthIsEstimated === undefined) metadata.depthIsEstimated = metadata.generationMethod === 'heuristic';
  metadata.sources = metadata.sources || [];

  // ---- 2. geometry source: real OSM polygon + DEM when available
  let grid: Grid | null = null;
  let osm: OsmLake | null = null;
  if (!options?.skipGeodata) {
    const osmQuery = options?.uploadedImage && metadata.name ? `${metadata.name}, ${metadata.state}` : query;
    osm = await lookupLakeOSM(osmQuery);
    // Guard against Nominatim matching a different lake than a curated entry (e.g. "Devils Lake" exists in many states)
    if (osm && curated && lake === curated) {
      const dLat = Math.abs(osm.lat - curated.metadata.lat);
      const dLon = Math.abs(osm.lon - curated.metadata.lon);
      if (dLat > 0.5 || dLon > 0.5) {
        console.warn('[geodata] OSM match is far from curated coordinates, ignoring:', osm.displayName);
        osm = null;
      }
    }
  }

  // Big, branchy lakes need more cells or narrow arms vanish; bump the grid for them.
  let size = requestedSize;
  if (osm) {
    if (osm.areaKm2 > 60 || osm.perimeterKm > 150) size = Math.max(size, MAX_GRID);
    else if (osm.areaKm2 > 12 || osm.perimeterKm > 50) size = Math.max(size, Math.min(MAX_GRID, 128));
  }

  if (osm) {
    const bounds = frameBounds(osm);
    const areaAcres = Math.round(osm.areaKm2 * ACRES_PER_KM2);
    // Curated / AI depth wins; otherwise estimate from the real surface area
    let maxDepthM = metadata.maxDepthM;
    if (metadata.generationMethod === 'heuristic' || !(maxDepthM > 0)) {
      maxDepthM = estimateMaxDepthM(areaAcres);
      metadata.depthIsEstimated = true;
    }
    const real = await buildRealTerrain(osm, size, bounds, maxDepthM);
    if (real) {
      grid = real;
      const dn = parseDisplayName(osm.displayName);
      metadata.name = curated && lake === curated ? metadata.name : osm.name || metadata.name;
      metadata.lat = osm.lat;
      metadata.lon = osm.lon;
      metadata.bounds = bounds;
      metadata.areaAcres = areaAcres;
      metadata.perimeterKm = Math.round(osm.perimeterKm * 10) / 10;
      metadata.surfaceElevationM = real.surfaceElevationM;
      metadata.surfaceElevationFt = Math.round(real.surfaceElevationM * FT_PER_M);
      metadata.maxDepthM = maxDepthM;
      metadata.maxDepthFt = Math.round(maxDepthM * FT_PER_M * 10) / 10;
      if (metadata.depthIsEstimated || !(metadata.meanDepthM > 0)) {
        metadata.meanDepthM = Math.round(maxDepthM * 0.42 * 10) / 10;
        metadata.meanDepthFt = Math.round(metadata.meanDepthM * FT_PER_M * 10) / 10;
      }
      if (dn.county && (!metadata.county || metadata.generationMethod === 'heuristic')) metadata.county = dn.county;
      if (dn.state && metadata.generationMethod === 'heuristic') metadata.state = dn.state;
      metadata.osmId = `${osm.osmType}/${osm.osmId}`;
      metadata.geometrySource = 'osm-dem';
      metadata.id = `${normalise(metadata.name).replace(/\s+/g, '-')}-${metadata.osmId.replace('/', '-')}`;
      if (metadata.generationMethod === 'heuristic') {
        metadata.description = `${metadata.name} — shoreline from OpenStreetMap, surrounding terrain from the Terrarium elevation tiles (DEM zoom ${real.demZoom}). Depth profile is estimated from distance to shore; no public bathymetric survey was used.`;
        metadata.geologicalOrigin = 'Not determined (no AI or curated record). Add a GEMINI_API_KEY to enable limnological synthesis.';
      }
      const osmSource: GroundingSource = {
        title: `OpenStreetMap ${osm.osmType} ${osm.osmId} — ${osm.displayName}`,
        uri: `https://www.openstreetmap.org/${osm.osmType}/${osm.osmId}`,
        sourceType: 'osm',
        snippet: `Shoreline polygon (${osm.polygons.length} ring set${osm.polygons.length === 1 ? '' : 's'}), ${areaAcres.toLocaleString()} acres by planimetric area. ${osm.licence}`,
      };
      const demSource: GroundingSource = {
        title: `Terrarium DEM tiles (AWS Open Data / Mapzen), zoom ${real.demZoom}`,
        uri: 'https://registry.opendata.aws/terrain-tiles/',
        sourceType: 'dem',
        snippet: 'Ground elevation sampled bilinearly from public terrain tiles (SRTM / NED / 3DEP composite). Lake surface elevation = median tile elevation inside the polygon.',
      };
      metadata.sources = [osmSource, demSource, ...metadata.sources.filter((s) => s.sourceType !== 'osm' && s.sourceType !== 'dem')];
    }
  }

  if (!grid) {
    grid = buildProceduralTerrain(lake, size);
    metadata.geometrySource = lake.shape.customSdfId === 'deam-lake' ? 'curated-sdf' : 'procedural';
  }

  // ---- 3. statistics, computed features, SVG map
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
    // Positional features from curated/AI records are in their own coordinate frame; replace with computed ones.
    const toNorm = (rc: [number, number]) => ({ normX: (rc[1] / (size - 1)) * 2 - 1, normY: (rc[0] / (size - 1)) * 2 - 1 });
    const features: TopoFeature[] = [
      { label: metadata.depthIsEstimated ? 'Modelled deepest point' : 'Max depth (surveyed value, modelled position)', type: 'deep_hole', ...toNorm(deepest), depthOrElevFt: Math.round(maxObservedDepth * FT_PER_M * 10) / 10, description: 'Deepest cell of the distance-to-shore bathymetry model' },
      { label: 'Highest ground in frame', type: 'ridge', ...toNorm(highest), depthOrElevFt: Math.round(maxElevation * FT_PER_M), description: 'Highest DEM sample inside the map frame' },
    ];
    metadata.topoFeatures = features;
  }

  const latDistKm = (metadata.bounds.maxLat - metadata.bounds.minLat) * (metresPerDegree(metadata.lat).lat / 1000);
  const lonDistKm = (metadata.bounds.maxLon - metadata.bounds.minLon) * (metresPerDegree(metadata.lat).lon / 1000);

  if (aiNotes && !metadata.topoAnalysisNotes) metadata.topoAnalysisNotes = aiNotes;
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
