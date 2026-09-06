/**
 * Real-world geodata for any named lake:
 *  - Shoreline polygon from OpenStreetMap via Nominatim (ODbL, © OpenStreetMap contributors)
 *  - Ground elevation from the Terrarium DEM tiles on AWS Open Data (Mapzen / Tilezen, SRTM+NED+...)
 *
 * Nothing here calls an LLM. Everything is cached in memory and degrades to null on
 * network failure so the caller can fall back to curated / procedural geometry.
 */
import { PNG } from 'pngjs';
import { cacheGet, cacheSet } from './diskCache.js';

export interface LonLat { lon: number; lat: number }
export type Ring = LonLat[];

export interface OsmLake {
  osmType: string;
  osmId: string;
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** Each polygon: [outerRing, ...holes] */
  polygons: Ring[][];
  areaKm2: number;
  perimeterKm: number;
  licence: string;
  wikidataId?: string;
  /** OSM `ele` tag (metres) when mapped */
  elevationM?: number;
  county?: string;
  state?: string;
  country?: string;
}

const NOMINATIM_BASE = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const TERRAIN_TILE_URL =
  process.env.TERRAIN_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const USER_AGENT = process.env.GEODATA_USER_AGENT || 'lake-topo-3d/1.0 (https://github.com/rustyorb/lake-topo-3d)';
const MAX_TILE_ZOOM = 14;
const TILE_CACHE_LIMIT = 120;

export function geodataEnabled(): boolean {
  return process.env.GEODATA_DISABLED !== 'true';
}

// ------------------------------------------------------------------ helpers

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Metres per degree at a latitude (equirectangular, good enough for a lake-sized box). */
export function metresPerDegree(lat: number): { lat: number; lon: number } {
  return { lat: 111_132, lon: 111_320 * Math.cos((lat * Math.PI) / 180) };
}

function ringAreaM2(ring: Ring, refLat: number): number {
  const m = metresPerDegree(refLat);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.lon * m.lon * q.lat * m.lat - q.lon * m.lon * p.lat * m.lat;
  }
  return Math.abs(a) / 2;
}

function ringLengthM(ring: Ring, refLat: number): number {
  const m = metresPerDegree(refLat);
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    len += Math.hypot((q.lon - p.lon) * m.lon, (q.lat - p.lat) * m.lat);
  }
  return len;
}

function toRing(coords: number[][]): Ring {
  return coords.map(([lon, lat]) => ({ lon, lat }));
}

// ------------------------------------------------------------------ Nominatim

const lakeCache = new Map<string, Promise<OsmLake | null>>();
const OSM_DISK_TTL = 30 * 24 * 3600 * 1000;

// Nominatim usage policy: at most one request per second. Serialize and space calls.
let nominatimChain: Promise<void> = Promise.resolve();
let lastNominatimAt = 0;
async function nominatimFetch(url: string): Promise<Response> {
  const run = async () => {
    const wait = Math.max(0, lastNominatimAt + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    let res = await fetchWithTimeout(url, 20_000, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 2500));
      lastNominatimAt = Date.now();
      res = await fetchWithTimeout(url, 20_000, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    }
    return res;
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.then(() => undefined, () => undefined);
  return p;
}

const WATER_TYPES = new Set(['lake', 'reservoir', 'water', 'pond', 'lagoon', 'basin', 'oxbow']);

/**
 * Looks a lake up by free-text query and returns its shoreline polygon(s).
 * Nominatim policy: identify yourself and stay under 1 request/second; results are cached.
 */
export async function lookupLakeOSM(query: string): Promise<OsmLake | null> {
  if (!geodataEnabled()) return null;
  const k = query.trim().toLowerCase();
  if (!k) return null;
  const cached = lakeCache.get(k);
  if (cached) return cached;
  const disk = cacheGet<OsmLake | null>('osm', k, OSM_DISK_TTL);
  if (disk !== undefined) {
    const p = Promise.resolve(disk);
    lakeCache.set(k, p);
    return p;
  }

  const p = (async (): Promise<OsmLake | null> => {
    const url = `${NOMINATIM_BASE}/search?${new URLSearchParams({
      q: query,
      format: 'jsonv2',
      polygon_geojson: '1',
      limit: '6',
      addressdetails: '1',
      extratags: '1',
      namedetails: '1',
    }).toString()}`;
    const res = await nominatimFetch(url);
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const rows = (await res.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) { cacheSet('osm', k, null); return null; }

    // Prefer water features with polygon geometry; fall back to any polygon whose type looks watery.
    const isWater = (r: any) =>
      r.category === 'water' || r.class === 'water' || r.category === 'natural' && r.type === 'water' ||
      WATER_TYPES.has(String(r.type || '').toLowerCase());
    const hasPoly = (r: any) => r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon');
    const pick = rows.find((r) => isWater(r) && hasPoly(r)) ?? rows.find((r) => hasPoly(r) && WATER_TYPES.has(String(r.addresstype || '').toLowerCase()));
    if (!pick) { cacheSet('osm', k, null); return null; }

    const polygons: Ring[][] =
      pick.geojson.type === 'Polygon'
        ? [pick.geojson.coordinates.map(toRing)]
        : pick.geojson.coordinates.map((poly: number[][][]) => poly.map(toRing));

    const [minLat, maxLat, minLon, maxLon] = pick.boundingbox.map(Number);
    const lat = Number(pick.lat);
    let areaM2 = 0;
    let perimM = 0;
    for (const poly of polygons) {
      areaM2 += ringAreaM2(poly[0], lat);
      perimM += ringLengthM(poly[0], lat);
      for (let i = 1; i < poly.length; i++) {
        areaM2 -= ringAreaM2(poly[i], lat);
        perimM += ringLengthM(poly[i], lat);
      }
    }

    const lake: OsmLake = {
      osmType: String(pick.osm_type),
      osmId: String(pick.osm_id),
      name: String(pick.namedetails?.['name:en'] || pick.name || pick.display_name.split(',')[0]),
      displayName: String(pick.display_name),
      lat,
      lon: Number(pick.lon),
      bbox: { minLat, maxLat, minLon, maxLon },
      polygons,
      areaKm2: areaM2 / 1e6,
      perimeterKm: perimM / 1000,
      licence: String(pick.licence || 'Data © OpenStreetMap contributors, ODbL 1.0'),
      wikidataId: pick.extratags?.wikidata ? String(pick.extratags.wikidata) : undefined,
      county: pick.address?.county ? String(pick.address.county) : undefined,
      state: pick.address?.state ? String(pick.address.state) : pick.address?.region ? String(pick.address.region) : undefined,
      country: pick.address?.country ? String(pick.address.country) : undefined,
      elevationM: pick.extratags?.ele && Number.isFinite(Number(pick.extratags.ele)) ? Number(pick.extratags.ele) : undefined,
    };
    cacheSet('osm', k, lake);
    return lake;
  })().catch((err) => {
    console.warn('[geodata] OSM lookup failed for', JSON.stringify(query), '-', err?.message || err);
    lakeCache.delete(k); // allow retry later
    return null;
  });

  lakeCache.set(k, p);
  return p;
}

/** Ray-casting point-in-polygon with holes and multipolygons. */
export function pointInLake(lon: number, lat: number, polygons: Ring[][]): boolean {
  const inRing = (ring: Ring): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lon, yi = ring[i].lat;
      const xj = ring[j].lon, yj = ring[j].lat;
      const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };
  for (const poly of polygons) {
    if (!inRing(poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (inRing(poly[i])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// ------------------------------------------------------------------ Terrarium DEM

interface Tile { z: number; x: number; y: number; elev: Float32Array; size: number }

const tileCache = new Map<string, Promise<Tile | null>>();

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

async function fetchTile(z: number, x: number, y: number): Promise<Tile | null> {
  const k = `${z}/${x}/${y}`;
  const cached = tileCache.get(k);
  if (cached) return cached;
  const p = (async (): Promise<Tile | null> => {
    const url = TERRAIN_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetchWithTimeout(url, 20_000, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`tile ${k} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const png = PNG.sync.read(buf);
    const size = png.width;
    const elev = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
      elev[i] = r * 256 + g + b / 256 - 32768;
    }
    return { z, x, y, elev, size };
  })().catch((err) => {
    console.warn('[geodata] DEM tile fetch failed', k, '-', err?.message || err);
    tileCache.delete(k);
    return null;
  });
  if (tileCache.size >= TILE_CACHE_LIMIT) {
    const first = tileCache.keys().next().value;
    if (first !== undefined) tileCache.delete(first);
  }
  tileCache.set(k, p);
  return p;
}

export interface DemSample {
  /** [row][col], metres above sea level */
  elevations: number[][];
  zoom: number;
  metresPerPixel: number;
}

/**
 * Samples ground elevation for a rows×cols grid covering `bounds` (row 0 = north, col 0 = west).
 * Chooses the DEM zoom so tile pixels are at least as fine as the grid cells (capped at MAX_TILE_ZOOM).
 */
export async function sampleDem(
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  rows: number,
  cols: number
): Promise<DemSample | null> {
  if (!geodataEnabled()) return null;
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const widthM = (bounds.maxLon - bounds.minLon) * metresPerDegree(midLat).lon;
  const cellM = widthM / cols;
  const mppAtZ0 = 156_543.03 * Math.cos((midLat * Math.PI) / 180);
  let zoom = Math.ceil(Math.log2(mppAtZ0 / Math.max(1, cellM)));
  zoom = Math.max(8, Math.min(MAX_TILE_ZOOM, zoom));
  const metresPerPixel = mppAtZ0 / Math.pow(2, zoom);

  const n = Math.pow(2, zoom);
  const x0 = Math.floor(lonToTileX(bounds.minLon, zoom));
  const x1 = Math.floor(lonToTileX(bounds.maxLon, zoom));
  const y0 = Math.floor(latToTileY(bounds.maxLat, zoom));
  const y1 = Math.floor(latToTileY(bounds.minLat, zoom));
  const tileCount = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (tileCount > 36) {
    console.warn('[geodata] DEM request too large, tiles =', tileCount);
    return null;
  }

  const tiles = new Map<string, Tile>();
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      jobs.push(
        fetchTile(zoom, wx, ty).then((t) => {
          if (t) tiles.set(`${tx}/${ty}`, t);
        })
      );
    }
  }
  await Promise.all(jobs);
  if (tiles.size !== tileCount) return null;

  const sampleAt = (lon: number, lat: number): number => {
    const px = lonToTileX(lon, zoom) * 256;
    const py = latToTileY(lat, zoom) * 256;
    const read = (gx: number, gy: number): number => {
      const tx = Math.floor(gx / 256);
      const ty = Math.floor(gy / 256);
      const t = tiles.get(`${tx}/${ty}`);
      if (!t) return NaN;
      const ix = Math.min(255, Math.max(0, gx - tx * 256));
      const iy = Math.min(255, Math.max(0, gy - ty * 256));
      return t.elev[iy * t.size + ix];
    };
    const fx = Math.floor(px), fy = Math.floor(py);
    const ax = px - fx, ay = py - fy;
    const v00 = read(fx, fy), v10 = read(fx + 1, fy), v01 = read(fx, fy + 1), v11 = read(fx + 1, fy + 1);
    const fix = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
    const a = fix(v00, fix(v10, 0)) * (1 - ax) + fix(v10, fix(v00, 0)) * ax;
    const b = fix(v01, fix(v11, 0)) * (1 - ax) + fix(v11, fix(v01, 0)) * ax;
    return a * (1 - ay) + b * ay;
  };

  const elevations: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const lat = bounds.maxLat - (r / (rows - 1)) * (bounds.maxLat - bounds.minLat);
    const row: number[] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const lon = bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon);
      row[c] = sampleAt(lon, lat);
    }
    elevations.push(row);
  }
  return { elevations, zoom, metresPerPixel };
}

/**
 * For every water cell, the straight-line distance in metres to the nearest land cell
 * (grid edges count as land so a lake clipped by the box still shelves). Land cells get 0.
 * Brute force over shoreline cells only: O(water × shore), fast for grids up to 128².
 */
export function distanceToShoreMetres(waterMask: boolean[][], cellWidthM: number, cellHeightM: number): number[][] {
  const rows = waterMask.length;
  const cols = waterMask[0].length;
  const shore: Array<[number, number]> = [];
  const isLand = (r: number, c: number) => r < 0 || c < 0 || r >= rows || c >= cols || !waterMask[r][c];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (waterMask[r][c]) continue;
      // land cell that touches water
      if (!isLand(r - 1, c) || !isLand(r + 1, c) || !isLand(r, c - 1) || !isLand(r, c + 1)) shore.push([r, c]);
    }
  }
  // Grid border acts as shore
  for (let r = 0; r < rows; r++) { if (waterMask[r][0]) shore.push([r, -1]); if (waterMask[r][cols - 1]) shore.push([r, cols]); }
  for (let c = 0; c < cols; c++) { if (waterMask[0][c]) shore.push([-1, c]); if (waterMask[rows - 1][c]) shore.push([rows, c]); }

  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    out[r] = new Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      if (!waterMask[r][c]) continue;
      let best = Infinity;
      for (const [sr, sc] of shore) {
        const dy = (sr - r) * cellHeightM;
        const dx = (sc - c) * cellWidthM;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      out[r][c] = Number.isFinite(best) ? Math.sqrt(best) : 0;
    }
  }
  return out;
}

/** Distance in cells from each land cell to the nearest water cell (capped at `maxCells`). */
export function landDistanceToWaterCells(waterMask: boolean[][], maxCells: number): number[][] {
  const rows = waterMask.length;
  const cols = waterMask[0].length;
  const out: number[][] = waterMask.map((row) => row.map((w) => (w ? 0 : maxCells + 1)));
  for (let pass = 1; pass <= maxCells; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (out[r][c] !== maxCells + 1) continue;
        const near =
          (r > 0 && out[r - 1][c] === pass - 1) || (r < rows - 1 && out[r + 1][c] === pass - 1) ||
          (c > 0 && out[r][c - 1] === pass - 1) || (c < cols - 1 && out[r][c + 1] === pass - 1);
        if (near) out[r][c] = pass;
      }
    }
  }
  return out;
}

export function formatDms(value: number, isLat: boolean): string {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minF = (abs - deg) * 60;
  const min = Math.floor(minF);
  const sec = Math.round((minF - min) * 60);
  return `${deg}°${String(min).padStart(2, '0')}'${String(sec).padStart(2, '0')}" ${hemi}`;
}
