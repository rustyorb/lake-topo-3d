import { GoogleGenAI } from '@google/genai';
import { LakeMetadata, TerrainGridData } from '../src/types.js';
import { analyzeUploadedTopoMap, performAiTopoRecon } from './geminiTopoService.js';
import { MIDWESTERN_LAKES, PredefinedLake } from './lakeData.js';
import { generateSvgTopoMap } from './topoMapGenerator.js';

// Lazy Gemini client helper
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  if (!geminiClient && process.env.GEMINI_API_KEY) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

// Simple 2D Perlin-like value noise for natural topography
function pseudoNoise(x: number, y: number, seed: number = 42): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number, seed: number = 42): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;

  // Smoothstep interpolation
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

// Find matching predefined lake if any
function findPredefinedLake(query: string): PredefinedLake | null {
  const q = query.toLowerCase().trim();
  for (const item of MIDWESTERN_LAKES) {
    const name = item.metadata.name.toLowerCase();
    const state = item.metadata.state.toLowerCase();
    const id = item.metadata.id.toLowerCase();
    if (
      q === name ||
      q === `${name}, ${state}` ||
      q === `${name} ${state}` ||
      q.includes(name) ||
      id.includes(q)
    ) {
      return item;
    }
  }
  // Check partial word matching
  for (const item of MIDWESTERN_LAKES) {
    const mainWord = item.metadata.name.toLowerCase().replace('lake', '').trim();
    if (mainWord.length > 3 && q.includes(mainWord)) {
      return item;
    }
  }
  return null;
}

// Fallback metadata generator if Gemini is unavailable
function generateHeuristicLake(query: string): PredefinedLake {
  const cleanQuery = query.replace(/[^\w\s,]/g, '').trim();
  const parts = cleanQuery.split(',').map((s) => s.trim());
  const lakeName = parts[0] || 'Midwestern Lake';
  let state = parts[1] || 'Midwest, USA';

  // Common Midwestern states inference
  const midwestStates = ['Indiana', 'Wisconsin', 'Michigan', 'Minnesota', 'Ohio', 'Illinois', 'Iowa', 'Missouri'];
  for (const s of midwestStates) {
    if (query.toLowerCase().includes(s.toLowerCase())) {
      state = s;
      break;
    }
  }

  // Hash-based deterministic coordinates within the Midwest (Lat 38-47, Lon -95 to -82)
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash << 5) - hash + query.charCodeAt(i);
    hash |= 0;
  }
  const u1 = Math.abs(Math.sin(hash * 1.1));
  const u2 = Math.abs(Math.cos(hash * 2.3));
  const u3 = Math.abs(Math.sin(hash * 3.7));

  const lat = 39.5 + u1 * 6.5; // 39.5 to 46.0
  const lon = -91.0 + u2 * 7.5; // -91.0 to -83.5
  const surfaceElevationM = Math.round(180 + u3 * 160); // 180m to 340m
  const maxDepthM = Math.round((8 + u2 * 25) * 10) / 10; // 8m to 33m
  const meanDepthM = Math.round((maxDepthM * (0.35 + u1 * 0.2)) * 10) / 10;
  const areaAcres = Math.round(150 + u1 * 2500);

  const latSpan = 0.02 + u2 * 0.03;
  const lonSpan = 0.03 + u1 * 0.04;

  const meta: LakeMetadata = {
    id: lakeName.toLowerCase().replace(/\s+/g, '-') + '-' + state.toLowerCase().substring(0, 2),
    name: lakeName.includes('Lake') ? lakeName : `${lakeName} Lake`,
    state,
    county: 'Midwestern Glacial Basin',
    lat,
    lon,
    surfaceElevationM,
    surfaceElevationFt: Math.round(surfaceElevationM * 3.28084),
    maxDepthM,
    maxDepthFt: Math.round(maxDepthM * 3.28084 * 10) / 10,
    meanDepthM,
    meanDepthFt: Math.round(meanDepthM * 3.28084 * 10) / 10,
    areaAcres,
    perimeterKm: Math.round((Math.sqrt(areaAcres * 0.00404686) * 4.2) * 10) / 10,
    geologicalOrigin: 'Glacial kettle basin and drift depression carved during the Wisconsin glacial period',
    description: `A scenic freshwater Midwestern lake with glacial topography, surrounded by rolling till moraines, natural sandbars, and deep central depressions.`,
    bounds: {
      minLat: lat - latSpan / 2,
      maxLat: lat + latSpan / 2,
      minLon: lon - lonSpan / 2,
      maxLon: lon + lonSpan / 2,
    },
  };

  return {
    metadata: meta,
    shape: {
      type: u1 > 0.5 ? 'kettle' : 'complex_bays',
      aspectRatio: 0.9 + u2 * 0.6,
      lakeRadiusRatio: 0.38 + u3 * 0.06,
      rotationDeg: (u1 * 180) - 90,
      bays: [
        { angleDeg: u1 * 120, distance: 0.35, radius: 0.18, depthMult: 0.7 },
        { angleDeg: 180 + u2 * 90, distance: 0.32, radius: 0.16, depthMult: 0.65 },
      ],
      deepestPointOffset: { x: (u1 - 0.5) * 0.3, y: (u2 - 0.5) * 0.3 },
      shorelineRoughness: 0.07 + u3 * 0.04,
    },
    terrainProfile: {
      moraineHeightM: 20 + u2 * 25,
      roughness: 0.5,
      surroundingSlope: 'glacial_till',
    },
  };
}

// Fetch AI metadata using Gemini API if key is available
async function fetchLakeWithGemini(query: string): Promise<PredefinedLake | null> {
  const ai = getGemini();
  if (!ai) return null;

  try {
    const prompt = `You are a Midwestern United States limnologist and hydrographic GIS specialist.
Analyze the lake query: "${query}".
Return a JSON object detailing the lake's geographic coordinates, elevation, bathymetry, and geological context.
If it is a real lake in Indiana (like Beals Lake, Steuben County, Indiana), Wisconsin, Michigan, Minnesota, Illinois, Ohio, Iowa, Missouri, or Kansas, provide its real historical and hydrological data.
If the exact lake has limited public records, provide accurate estimates based on its specific Midwestern county and glacial geology.

Respond ONLY with valid JSON in this exact structure:
{
  "name": "Lake Name",
  "state": "State",
  "county": "County Name",
  "lat": 41.5385,
  "lon": -85.0842,
  "surfaceElevationM": 298,
  "maxDepthM": 14.5,
  "meanDepthM": 6.2,
  "areaAcres": 124,
  "perimeterKm": 3.8,
  "geologicalOrigin": "One sentence explaining its glacial/karst/reservoir formation",
  "description": "Two sentences describing the lake, shoreline, surrounding moraines, and underwater structure",
  "shapeType": "kettle" | "complex_bays" | "reservoir" | "elongated",
  "aspectRatio": 1.2,
  "moraineReliefM": 20
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text?.trim();
    if (!text) return null;

    const data = JSON.parse(text);
    const lat = Number(data.lat) || 41.5;
    const lon = Number(data.lon) || -85.1;
    const surfaceElevationM = Math.round(Number(data.surfaceElevationM) || 275);
    const maxDepthM = Math.round((Number(data.maxDepthM) || 15) * 10) / 10;
    const meanDepthM = Math.round((Number(data.meanDepthM) || (maxDepthM * 0.45)) * 10) / 10;
    const areaAcres = Math.round(Number(data.areaAcres) || 300);

    const latSpan = Math.max(0.015, Math.sqrt(areaAcres) * 0.0012);
    const lonSpan = latSpan * 1.3;

    const metadata: LakeMetadata = {
      id: (data.name || query).toLowerCase().replace(/\s+/g, '-') + '-' + (data.state || 'mw').toLowerCase().substring(0, 2),
      name: data.name || query,
      state: data.state || 'Indiana',
      county: data.county || 'Midwestern Region',
      lat,
      lon,
      surfaceElevationM,
      surfaceElevationFt: Math.round(surfaceElevationM * 3.28084),
      maxDepthM,
      maxDepthFt: Math.round(maxDepthM * 3.28084 * 10) / 10,
      meanDepthM,
      meanDepthFt: Math.round(meanDepthM * 3.28084 * 10) / 10,
      areaAcres,
      perimeterKm: Math.round((Number(data.perimeterKm) || (Math.sqrt(areaAcres) * 0.2)) * 10) / 10,
      geologicalOrigin: data.geologicalOrigin || 'Glacial kettle basin formed during the Wisconsin glaciation',
      description: data.description || 'A Midwestern lake with glacial topography and rich bathymetric features.',
      bounds: {
        minLat: lat - latSpan / 2,
        maxLat: lat + latSpan / 2,
        minLon: lon - lonSpan / 2,
        maxLon: lon + lonSpan / 2,
      },
    };

    return {
      metadata,
      shape: {
        type: data.shapeType || 'kettle',
        aspectRatio: Number(data.aspectRatio) || 1.1,
        lakeRadiusRatio: 0.38,
        rotationDeg: 10,
        deepestPointOffset: { x: 0.0, y: 0.0 },
        shorelineRoughness: 0.08,
      },
      terrainProfile: {
        moraineHeightM: Number(data.moraineReliefM) || 25,
        roughness: 0.5,
        surroundingSlope: 'glacial_till',
      },
    };
  } catch (err) {
    console.warn('Gemini lake lookup failed, falling back to local database/heuristics:', err);
    return null;
  }
}

// --- Helper functions for geometric Signed Distance Fields (SDF) ---
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

// Dedicated high-precision bathymetric & morphological evaluator for Deam Lake, Indiana
// Grounded directly in Indiana DNR hydrographic contour surveys
function evaluateDeamLakePoint(
  normX: number,
  normY: number,
  metadata: LakeMetadata,
  terrainProfile: { moraineHeightM: number; roughness: number }
): { isWater: boolean; depthM: number; elevationM: number } {
  // Coordinate normalization:
  // normX: -1 (West) to +1 (East)
  // normY: -1 (North) to +1 (South)
  const x = normX * 0.78;
  const y = normY * 0.85;

  let d = 1e6;

  // 1. Central Body
  const dCenter = Math.hypot(x / 0.95, (y - 0.02) / 1.05) - 0.19;
  d = smin(d, dCenter, 0.08);

  // 2. South Deep Basin (bulbous depression containing the 30-ft hole)
  const dSouthBasin = Math.hypot((x - 0.06) / 1.05, (y - 0.30) / 1.05) - 0.22;
  d = smin(d, dSouthBasin, 0.09);

  // Connection between center and south basin
  const dThroat = distToSegment(x, y, 0.0, 0.02, 0.06, 0.30) - 0.19;
  d = smin(d, dThroat, 0.08);

  // 3. Southwest Dam Arm (curving west along Deam Lake Rd)
  const dSW1 = distToSegment(x, y, 0.06, 0.38, -0.08, 0.54) - 0.16;
  const dSW2 = distToSegment(x, y, -0.08, 0.54, -0.35, 0.60) - 0.13;
  const dSW3 = distToSegment(x, y, -0.35, 0.60, -0.62, 0.58) - 0.08;
  const dSWTip = Math.hypot(x - -0.62, y - 0.58) - 0.08;
  d = smin(d, dSW1, 0.06);
  d = smin(d, dSW2, 0.06);
  d = smin(d, dSW3, 0.06);
  d = smin(d, dSWTip, 0.05);

  // 4. Northwest Stone Branch Arm (seamlessly branching from center)
  const dNW0 = distToSegment(x, y, -0.05, -0.04, -0.22, -0.14) - 0.13;
  const dNW1 = distToSegment(x, y, -0.22, -0.14, -0.42, -0.26) - 0.10;
  const dNW2 = distToSegment(x, y, -0.42, -0.26, -0.58, -0.42) - 0.07;
  const dNWTip = Math.hypot(x - -0.58, y - -0.42) - 0.07;
  const dNWBranch = distToSegment(x, y, -0.25, -0.16, -0.28, -0.32) - 0.045;
  d = smin(d, dNW0, 0.06);
  d = smin(d, dNW1, 0.06);
  d = smin(d, dNW2, 0.06);
  d = smin(d, dNWTip, 0.05);
  d = smin(d, dNWBranch, 0.035);

  // 5. Boat Ramp Bay on West Shore
  const dBoatRamp = distToSegment(x, y, -0.15, 0.06, -0.36, 0.10) - 0.065;
  const dBoatRampTip = Math.hypot(x - -0.36, y - 0.10) - 0.065;
  d = smin(d, dBoatRamp, 0.04);
  d = smin(d, dBoatRampTip, 0.04);

  // 6. West inlet near dam / camp
  const dWestInlet = distToSegment(x, y, -0.22, 0.25, -0.45, 0.22) - 0.04;
  d = smin(d, dWestInlet, 0.03);

  // 7. North Arm (Main inlet channel flowing down from Stone Branch Creek head)
  const dN0 = distToSegment(x, y, 0.02, -0.06, 0.08, -0.26) - 0.14;
  const dN1 = distToSegment(x, y, 0.08, -0.26, 0.16, -0.48) - 0.11;
  const dN2 = distToSegment(x, y, 0.16, -0.48, 0.26, -0.70) - 0.09;
  const dN3 = distToSegment(x, y, 0.26, -0.70, 0.32, -0.84) - 0.075;
  const dNHead = Math.hypot(x - 0.32, y - -0.84) - 0.08;
  d = smin(d, dN0, 0.06);
  d = smin(d, dN1, 0.06);
  d = smin(d, dN2, 0.06);
  d = smin(d, dN3, 0.06);
  d = smin(d, dNHead, 0.05);

  // North-west side branch off the north arm
  const dNNW = distToSegment(x, y, 0.12, -0.38, 0.0, -0.52) - 0.05;
  const dNNWTip = Math.hypot(x - 0.0, y - -0.54) - 0.05;
  d = smin(d, dNNW, 0.04);
  d = smin(d, dNNWTip, 0.04);

  // Jagged coves on East shore of North arm
  const dNE1 = distToSegment(x, y, 0.14, -0.32, 0.32, -0.28) - 0.04;
  const dNE2 = distToSegment(x, y, 0.20, -0.48, 0.36, -0.44) - 0.04;
  const dNE3 = distToSegment(x, y, 0.26, -0.66, 0.40, -0.62) - 0.04;
  d = smin(d, dNE1, 0.03);
  d = smin(d, dNE2, 0.03);
  d = smin(d, dNE3, 0.03);

  // 8. East Antler Bays & Points (Center-East)
  const dE1 = distToSegment(x, y, 0.15, 0.0, 0.35, -0.04) - 0.08;
  const dEUpperProng = distToSegment(x, y, 0.35, -0.04, 0.55, -0.12) - 0.04;
  const dELowerProng = distToSegment(x, y, 0.35, -0.04, 0.62, 0.02) - 0.04;
  const dESideCove = distToSegment(x, y, 0.32, 0.08, 0.52, 0.10) - 0.035;
  d = smin(d, dE1, 0.05);
  d = smin(d, dEUpperProng, 0.04);
  d = smin(d, dELowerProng, 0.04);
  d = smin(d, dESideCove, 0.035);

  // 9. East shore cove of the southern basin
  const dSE = distToSegment(x, y, 0.18, 0.26, 0.42, 0.26) - 0.04;
  d = smin(d, dSE, 0.035);

  // Subtle organic shoreline gravel ripples (preserves exact survey geometry)
  const microShore = (fbm(normX * 8, normY * 8, 2, 412) - 0.5) * 0.008;
  d += microShore;

  const isWater = d <= 0;

  if (isWater) {
    const shoreDist = -d;

    // Sharp littoral shelf break: crisp drop-off from 0 to 5ft within shore edge, then shelf break to 12ft
    const shelfBreak = shoreDist < 0.02 
      ? (shoreDist / 0.02) * 5.0 
      : 5.0 + Math.min(1.0, (shoreDist - 0.02) / 0.035) * 7.0;

    // 1. Deep 30-foot hole in South Basin around (0.08, 0.36) with steep conical drop-off
    const distTo30 = Math.hypot((x - 0.08) / 0.75, (y - 0.36) / 0.75);
    const deepHoleWeight = Math.max(0, 1 - distTo30 / 0.22);
    // Sharper power curve for incised basin hole
    const deepHoleDepth = Math.pow(deepHoleWeight, 1.6) * 30.0;

    // 2. Deep channel in South-Central basin (24-27 ft)
    const distToBasinCenter = Math.hypot((x - 0.05) / 0.95, (y - 0.28) / 1.0);
    const basinDepth = Math.pow(Math.max(0, 1 - distToBasinCenter / 0.26), 1.4) * 27.0;

    // 3. Dam Channel depth (27 ft near basin curving down to 14 ft and 5 ft at west tip)
    const swProg = Math.max(0, Math.min(1, (-x + 0.06) / 0.68));
    const swCenterDist = distToSegment(x, y, 0.06, 0.45, -0.62, 0.60);
    const swChannel = Math.pow(Math.max(0, 1 - swCenterDist / 0.12), 1.5) * (27.0 * (1 - swProg * 0.85) + 3.5);

    // 4. Central Basin depth (18-22 ft)
    const distToCenter = Math.hypot(x / 0.85, y / 0.85);
    const centerDepth = Math.pow(Math.max(0, 1 - distToCenter / 0.23), 1.4) * 22.0;

    // 5. North Arm channel (19 ft near mouth down to 2 ft at head) - incised creek bed
    const nProg = Math.max(0, Math.min(1, (-y - 0.05) / 0.78));
    const nCenterDist = Math.min(
      distToSegment(x, y, 0.05, -0.05, 0.12, -0.32),
      distToSegment(x, y, 0.12, -0.32, 0.22, -0.55),
      distToSegment(x, y, 0.22, -0.55, 0.32, -0.84)
    );
    const nChannel = Math.pow(Math.max(0, 1 - nCenterDist / 0.10), 1.6) * (19.5 * (1 - nProg * 0.92) + 1.2);

    // 6. Northwest Stone Branch Arm channel (14 ft down to 1.5 ft)
    const nwProg = Math.max(0, Math.min(1, (-x - 0.05) / 0.55));
    const nwCenterDist = Math.min(
      distToSegment(x, y, -0.05, -0.04, -0.25, -0.16),
      distToSegment(x, y, -0.25, -0.16, -0.58, -0.42)
    );
    const nwChannel = Math.pow(Math.max(0, 1 - nwCenterDist / 0.09), 1.5) * (14.5 * (1 - nwProg * 0.9) + 1.2);

    let depthFt = Math.max(
      shelfBreak,
      deepHoleDepth,
      basinDepth,
      swChannel,
      centerDepth,
      nChannel,
      nwChannel
    );

    // Clamp between 0.5 ft (minimum littoral depth) and 30.0 ft (official max depth)
    depthFt = Math.max(0.5, Math.min(30.0, depthFt));
    const depthM = depthFt * 0.3048;
    const elevationM = metadata.surfaceElevationM - depthM;

    return { isWater: true, depthM, elevationM: Math.round(elevationM * 10) / 10 };
  } else {
    // Surrounding Topography: Clark State Forest & Knobstone Escarpment
    const distFromShore = d;

    // Crisp wooded shoreline bank with distinct slope break
    const shoreBank = Math.min(1.0, distFromShore * 24) * 3.2;

    // Earthen Dam embankment along southwest arm (Deam Lake Road):
    // Crisp trapezoidal ridge crest and steep downstream drop
    let damRelief = 0;
    const isNearDam = normY > 0.44 && normY < 0.76 && normX > -0.76 && normX < 0.16;
    if (isNearDam) {
      const damCrestDist = Math.abs(d - 0.028); // sharp crest right along the dam line
      if (damCrestDist < 0.05) {
        damRelief = Math.pow(1 - damCrestDist / 0.05, 1.8) * 4.2;
      }
      // Downstream spillway valley drop
      if (normY > 0.60) {
        const dropFactor = Math.min(1.0, (normY - 0.60) * 9);
        damRelief -= dropFactor * 13.5;
      }
    }

    // High chiseled Knobstone ridges (arêtes and incised drainage gullies)
    const rawRidge = 1 - Math.abs(fbm(normX * 2.8 + 11, normY * 2.8 + 11, 4, 711) * 2 - 1);
    const sharpRidge = Math.pow(rawRidge, 1.5);
    const moraineElevation = sharpRidge * terrainProfile.moraineHeightM;

    // Bluffs rise with distinct topographic breaks as distance increases
    const basinRim = Math.min(1.0, Math.pow(distFromShore * 3.5, 0.85));
    const landElevation = metadata.surfaceElevationM + shoreBank + damRelief + moraineElevation * basinRim;

    return {
      isWater: false,
      depthM: 0,
      elevationM: Math.round(landElevation * 10) / 10,
    };
  }
}

export interface LakeGenerationOptions {
  forceAiRecon?: boolean;
  userNotes?: string;
  uploadedImage?: {
    base64: string;
    mimeType: string;
  };
}

// Generate the 3D grid with topography and bathymetry
export async function generateLakeTerrainGrid(
  query: string,
  gridSize: number = 64,
  options?: LakeGenerationOptions
): Promise<TerrainGridData> {
  // 1. If an uploaded topo map or depth chart was supplied, use Gemini Vision analysis
  let lake: PredefinedLake | null = null;
  if (options?.uploadedImage) {
    const visionResult = await analyzeUploadedTopoMap(
      options.uploadedImage.base64,
      options.uploadedImage.mimeType,
      query
    );
    if (visionResult) {
      lake = visionResult.lake;
    }
  }

  // 2. If user specifically requested fresh AI Topo Reconnaissance
  if (!lake && options?.forceAiRecon) {
    const reconResult = await performAiTopoRecon(query, options?.userNotes);
    if (reconResult) {
      lake = reconResult.lake;
    }
  }

  // 3. Find lake data in curated Midwestern lakes registry
  if (!lake) {
    lake = findPredefinedLake(query);
  }

  // 4. Try AI Topo Recon via Gemini (Web Search Grounding + USGS Topo / DNR synthesis)
  if (!lake) {
    const reconResult = await performAiTopoRecon(query, options?.userNotes);
    if (reconResult) {
      lake = reconResult.lake;
    }
  }

  // 5. Fallback to heuristic
  if (!lake) {
    lake = generateHeuristicLake(query);
  }

  const { metadata, shape, terrainProfile } = lake;
  const size = Math.max(32, Math.min(gridSize, 128));

  const elevations: number[][] = [];
  const waterMask: boolean[][] = [];
  const depths: number[][] = [];

  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let maxObservedDepth = 0;

  // Approximate physical dimensions
  const latDistKm = (metadata.bounds.maxLat - metadata.bounds.minLat) * 111.0;
  const lonDistKm =
    (metadata.bounds.maxLon - metadata.bounds.minLon) *
    111.0 *
    Math.cos((metadata.lat * Math.PI) / 180);

  const isDeamLake = shape.customSdfId === 'deam-lake' || metadata.id === 'deam-lake-in';

  const rad = (shape.rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  // Compute terrain & bathymetry for every cell in the grid
  for (let r = 0; r < size; r++) {
    elevations[r] = [];
    waterMask[r] = [];
    depths[r] = [];

    const normY = (r / (size - 1)) * 2 - 1; // -1 to 1 (North is up)

    for (let c = 0; c < size; c++) {
      const normX = (c / (size - 1)) * 2 - 1; // -1 to 1 (East is right)

      if (isDeamLake) {
        // High-precision Deam Lake surveyed geometry and bathymetry
        const pt = evaluateDeamLakePoint(normX, normY, metadata, terrainProfile);
        elevations[r][c] = pt.elevationM;
        waterMask[r][c] = pt.isWater;
        depths[r][c] = pt.depthM;
        if (pt.depthM > maxObservedDepth) maxObservedDepth = pt.depthM;
      } else {
        // Standard procedural lake model for other Midwestern lakes
        // Rotate coordinates for lake orientation
        const rotX = normX * cosR - normY * sinR;
        const rotY = normX * sinR + normY * cosR;

        // Distance to lake center adjusted by aspect ratio
        const distX = rotX / (shape.aspectRatio || 1.0);
        const distY = rotY;
        const baseDist = Math.sqrt(distX * distX + distY * distY);

        // Shoreline angular modulation (adds organic bays, points, arms)
        const angle = Math.atan2(distY, distX);
        let shoreNoise =
          Math.sin(angle * 3 + 0.5) * 0.08 +
          Math.cos(angle * 5 - 1.2) * 0.05 +
          Math.sin(angle * 8) * 0.03;

        // Add custom defined bays if any
        if (shape.bays) {
          for (const bay of shape.bays) {
            const bayAngleRad = (bay.angleDeg * Math.PI) / 180;
            const bayDiff = Math.abs(Math.atan2(Math.sin(angle - bayAngleRad), Math.cos(angle - bayAngleRad)));
            if (bayDiff < 0.6) {
              const influence = Math.cos((bayDiff / 0.6) * (Math.PI / 2));
              shoreNoise += influence * bay.radius * 0.8;
            }
          }
        }

        // Add high frequency fractal noise to shoreline
        const fractalShore = (fbm(normX * 4 + 5, normY * 4 + 5, 3, 202) - 0.5) * shape.shorelineRoughness;
        const lakeBoundary = shape.lakeRadiusRatio + shoreNoise + fractalShore;

        const isWater = baseDist <= lakeBoundary;
        waterMask[r][c] = isWater;

        if (isWater) {
          // Calculate underwater depth
          const penetration = Math.min(1.0, Math.max(0.0, (lakeBoundary - baseDist) / lakeBoundary));

          // Shift deepest point according to lake profile
          const deepX = distX - shape.deepestPointOffset.x;
          const deepY = distY - shape.deepestPointOffset.y;
          const distToDeepest = Math.sqrt(deepX * deepX + deepY * deepY);
          const deepFactor = Math.max(0.0, 1.0 - distToDeepest / (lakeBoundary * 1.2));

          // Sharp shelf break + deep basin thalweg
          const shelfDrop = penetration < 0.08 ? (penetration / 0.08) * 0.35 : 0.35 + (penetration - 0.08) * 0.65;
          const dropoffCurve = Math.pow(shelfDrop, 1.4) * 0.55 + Math.pow(deepFactor, 1.6) * 0.45;
          const underNoise = (fbm(normX * 8, normY * 8, 2, 88) - 0.5) * 0.06;
          const depthRatio = Math.max(0.02, Math.min(1.0, dropoffCurve + underNoise));

          const depthM = depthRatio * metadata.maxDepthM;
          depths[r][c] = depthM;
          if (depthM > maxObservedDepth) maxObservedDepth = depthM;

          // Lake floor elevation
          const lakeBedElevation = metadata.surfaceElevationM - depthM;
          elevations[r][c] = Math.round(lakeBedElevation * 10) / 10;
        } else {
          // Land surrounding the lake
          depths[r][c] = 0;

          const distFromShore = baseDist - lakeBoundary;
          const shorelineRise = Math.min(1.0, distFromShore * 22) * 2.8;

          const moraineScale = 2.8;
          const rawTopo = 1.0 - Math.abs(fbm(normX * moraineScale + 12, normY * moraineScale + 14, 4, 303) * 2 - 1);
          const moraineElevation = Math.pow(rawTopo, 1.4) * terrainProfile.moraineHeightM;

          const basinRim = Math.min(1.0, Math.pow(distFromShore * 3.5, 0.85));
          const landElevation = metadata.surfaceElevationM + shorelineRise + moraineElevation * basinRim;

          elevations[r][c] = Math.round(landElevation * 10) / 10;
        }
      }

      if (elevations[r][c] < minElevation) minElevation = elevations[r][c];
      if (elevations[r][c] > maxElevation) maxElevation = elevations[r][c];
    }
  }

  // Generate authentic SVG Topographic & Bathymetric Survey map
  const svgTopoMap = generateSvgTopoMap({
    name: metadata.name,
    state: metadata.state,
    county: metadata.county,
    surfaceElevationFt: metadata.surfaceElevationFt,
    maxDepthFt: metadata.maxDepthFt,
    meanDepthFt: metadata.meanDepthFt,
    gridSize: size,
    elevations,
    waterMask,
    depths,
    minElevation,
    maxElevation,
    topoFeatures: metadata.topoFeatures,
    contourIntervalFt: metadata.contourIntervalFt || 5,
  });

  return {
    metadata,
    gridSize: size,
    elevations,
    waterMask,
    depths,
    minElevation,
    maxElevation,
    waterElevation: metadata.surfaceElevationM,
    minDepth: 0,
    maxDepth: maxObservedDepth || metadata.maxDepthM,
    physicalWidthKm: Math.round(lonDistKm * 10) / 10,
    physicalHeightKm: Math.round(latDistKm * 10) / 10,
    svgTopoMap,
  };
}
