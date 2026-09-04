/**
 * Indiana DNR Division of Fish & Wildlife lake bathymetry.
 *
 *  - Feature service "IDNR Lake Bathymetry" on IndianaMap: sonar-surveyed depth contours
 *    (polylines, feet below the surface) plus NHD lake outlines. Credit: Indiana DNR.
 *  - The Fish & Wildlife "Lake Depth Maps" page: an index of the published PDF depth maps.
 *
 * Contours are turned into a depth raster by interpolating between the nearest shallower
 * and deeper contour lines (see `rasterizeContourDepths`).
 */
import { LonLat, Ring, pointInLake } from './geoData.js';
import { cacheGet, cacheSet } from './diskCache.js';

const DISK_TTL = 30 * 24 * 3600 * 1000;

const FS = process.env.IDNR_BATHYMETRY_URL || 'https://gisdata.in.gov/server/rest/services/Hosted/Lake_Bathymetry_RO/FeatureServer';
const DEPTH_MAPS_PAGE = 'https://www.in.gov/dnr/fish-and-wildlife/fishing/lake-depth-maps/';
const UA = 'lake-topo-3d/1.0 (https://github.com/rustyorb/lake-topo-3d)';

export interface IdnrOutline {
  permanentId: string;
  name: string;
  elevationFt: number | null;
  areaKm2: number;
  polygons: Ring[][];
}

export interface IdnrContourLine {
  depthFt: number;
  coords: LonLat[];
}

export interface IdnrSurvey {
  outline: IdnrOutline;
  contours: IdnrContourLine[];
  lakeName: string;
  county: string | null;
  surveyDate: string | null;
  lakeAcres: number | null;
  lakeMaxDepthFt: number | null;
  intervalFt: number;
  maxContourFt: number;
}

export function idnrEnabled(): boolean {
  return process.env.IDNR_DISABLED !== 'true' && process.env.GEODATA_DISABLED !== 'true';
}

async function getJson(url: string, ms = 60_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
    const j = await res.json();
    if (j?.error) throw new Error(`ArcGIS error ${j.error.code}: ${j.error.message}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

function toRings(geom: any): Ring[][] {
  const ring = (coords: number[][]): Ring => coords.map(([lon, lat]) => ({ lon, lat }));
  if (geom.type === 'Polygon') return [geom.coordinates.map(ring)];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p: number[][][]) => p.map(ring));
  return [];
}

const outlineCache = new Map<string, Promise<IdnrOutline | null>>();
const surveyCache = new Map<string, Promise<IdnrSurvey | null>>();

/** NHD lake outline under a point (the OSM centroid), from the bathymetry service. */
export async function findIdnrOutline(lon: number, lat: number): Promise<IdnrOutline | null> {
  if (!idnrEnabled()) return null;
  const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const disk = cacheGet<IdnrOutline | null>('idnr-outline', key, DISK_TTL);
  if (disk !== undefined) { const p = Promise.resolve(disk); outlineCache.set(key, p); return p; }
  const p = (async (): Promise<IdnrOutline | null> => {
    const url = `${FS}/1/query?${new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'permanent_identifier,gnis_name,elevation,areasqkm',
      outSR: '4326',
      f: 'geojson',
    }).toString()}`;
    const j = await getJson(url);
    const f = j.features?.[0];
    const out = f ? outlineFromFeature(f) : null;
    cacheSet('idnr-outline', key, out);
    return out;
  })().catch((err) => {
    console.warn('[idnr] outline lookup failed:', err?.message || err);
    outlineCache.delete(key);
    return null;
  });
  outlineCache.set(key, p);
  return p;
}

function outlineFromFeature(f: any): IdnrOutline {
  return {
    permanentId: String(f.properties.permanent_identifier),
    name: f.properties.gnis_name || '',
    elevationFt: f.properties.elevation ?? null,
    areaKm2: Number(f.properties.areasqkm) || 0,
    polygons: toRings(f.geometry),
  };
}

const byNameCache = new Map<string, Promise<IdnrOutline | null>>();

/**
 * Finds a surveyed Indiana lake by name (no geocoder needed): contour layer → permanent id → NHD outline.
 * Used when Nominatim is unavailable or rate-limited.
 */
export async function findIdnrOutlineByName(lakeName: string, county?: string | null): Promise<IdnrOutline | null> {
  if (!idnrEnabled()) return null;
  const clean = lakeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 3) return null;
  const key = `${clean.toLowerCase()}|${(county || '').toLowerCase()}`;
  const hit = byNameCache.get(key);
  if (hit) return hit;
  const disk = cacheGet<IdnrOutline | null>('idnr-byname', key, DISK_TTL);
  if (disk !== undefined) { const p = Promise.resolve(disk); byNameCache.set(key, p); return p; }
  const p = (async (): Promise<IdnrOutline | null> => {
    const stem = clean.replace(/\b(lake|reservoir)\b/gi, '').trim().toUpperCase().replace(/'/g, "''");
    if (!stem) return null;
    const where = `upper(lake_name) LIKE '%${stem}%'${county ? ` AND upper(county1_name) = '${county.replace(/county/i, '').trim().toUpperCase().replace(/'/g, "''")}'` : ''}`;
    const j = await getJson(`${FS}/0/query?${new URLSearchParams({ where, outFields: 'lake_name,county1_name', returnDistinctValues: 'true', returnGeometry: 'false', f: 'json' }).toString()}`);
    const rows: any[] = (j.features || []).map((f: any) => f.attributes);
    if (!rows.length) { cacheSet('idnr-byname', key, null); return null; }
    // Prefer an exact stem match ("Lemon" vs "Little Lemon")
    const exact = rows.find((r) => String(r.lake_name || '').toUpperCase().replace(/\b(LAKE|RESERVOIR)\b/g, '').trim() === stem);
    const pick = exact || rows[0];
    const name = String(pick.lake_name || '').replace(/'/g, "''");
    // Outline layer is NHD: match on GNIS name, choosing the largest polygon with that name
    const o = await getJson(`${FS}/1/query?${new URLSearchParams({ where: `upper(gnis_name) = '${name.toUpperCase()}'`, outFields: 'permanent_identifier,gnis_name,elevation,areasqkm', orderByFields: 'areasqkm DESC', resultRecordCount: '1', outSR: '4326', f: 'geojson' }).toString()}`);
    const f = o.features?.[0];
    const out = f ? outlineFromFeature(f) : null;
    if (out && !out.name) out.name = String(pick.lake_name || '');
    cacheSet('idnr-byname', key, out);
    return out;
  })().catch((err) => {
    console.warn('[idnr] name lookup failed:', err?.message || err);
    byNameCache.delete(key);
    return null;
  });
  byNameCache.set(key, p);
  return p;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\b(lake|reservoir|pond)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * All sonar contours for a lake. The contour layer has no reliable key to the outline layer,
 * so contours are fetched by the outline's bounding box and kept when their lake_name matches
 * the outline's GNIS name (or, failing that, when the line starts inside the outline).
 */
export async function fetchIdnrSurvey(outline: IdnrOutline): Promise<IdnrSurvey | null> {
  if (!idnrEnabled()) return null;
  const key = outline.permanentId;
  const hit = surveyCache.get(key);
  if (hit) return hit;
  const disk = cacheGet<IdnrSurvey | null>('idnr-survey', key, DISK_TTL);
  if (disk !== undefined) { const p = Promise.resolve(disk); surveyCache.set(key, p); return p; }
  const p = (async (): Promise<IdnrSurvey | null> => {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const poly of outline.polygons) for (const pt of poly[0]) {
      minLat = Math.min(minLat, pt.lat); maxLat = Math.max(maxLat, pt.lat);
      minLon = Math.min(minLon, pt.lon); maxLon = Math.max(maxLon, pt.lon);
    }
    const raw: Array<{ depthFt: number; name: string; props: any; lines: number[][][] }> = [];
    let offset = 0;
    for (let page = 0; page < 30; page++) {
      const url = `${FS}/0/query?${new URLSearchParams({
        geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'contour,lake_name,county1_name,survey_date,lake_acres,lake_max_depth,line_type',
        outSR: '4326',
        resultOffset: String(offset),
        resultRecordCount: '1000',
        f: 'geojson',
      }).toString()}`;
      const j = await getJson(url);
      const feats: any[] = j.features || [];
      for (const f of feats) {
        const depthFt = Number(f.properties.contour);
        if (!Number.isFinite(depthFt)) continue;
        const lines: number[][][] = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : [];
        raw.push({ depthFt, name: String(f.properties.lake_name || ''), props: f.properties, lines });
      }
      offset += feats.length;
      const more = j.exceededTransferLimit || j.properties?.exceededTransferLimit;
      if (!more || !feats.length) break;
    }
    if (!raw.length) { cacheSet('idnr-survey', key, null); return null; }

    const target = normName(outline.name || '');
    let picked = target ? raw.filter((r) => normName(r.name) === target) : [];
    if (!picked.length) {
      // No name match: keep lines that start inside this outline
      picked = raw.filter((r) => r.lines.some((l) => l.length && pointInLake(l[0][0], l[0][1], outline.polygons)));
      if (picked.length) {
        // and restrict to the most common lake_name among them, so a neighbouring lake's lines don't leak in
        const counts = new Map<string, number>();
        for (const r of picked) counts.set(r.name, (counts.get(r.name) || 0) + 1);
        const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        picked = picked.filter((r) => r.name === best);
      }
    }
    if (!picked.length) { cacheSet('idnr-survey', key, null); return null; }

    const contours: IdnrContourLine[] = [];
    for (const r of picked) for (const line of r.lines) contours.push({ depthFt: r.depthFt, coords: line.map(([lon, lat]) => ({ lon, lat })) });
    const meta = picked[0].props;
    const levels = Array.from(new Set(contours.map((c) => c.depthFt))).filter((d) => d > 0).sort((a, b) => a - b);
    let intervalFt = levels.length > 1 ? Math.min(...levels.slice(1).map((v, i) => v - levels[i])) : levels[0] || 5;
    if (!(intervalFt > 0)) intervalFt = 5;
    const survey: IdnrSurvey = {
      outline,
      contours,
      lakeName: meta?.lake_name || outline.name,
      county: meta?.county1_name ? titleCase(String(meta.county1_name)) : null,
      surveyDate: meta?.survey_date ? new Date(Number(meta.survey_date)).toISOString().slice(0, 10) : null,
      lakeAcres: meta?.lake_acres ?? null,
      lakeMaxDepthFt: meta?.lake_max_depth ?? null,
      intervalFt,
      maxContourFt: levels[levels.length - 1] || 0,
    };
    cacheSet('idnr-survey', key, survey);
    return survey;
  })().catch((err) => {
    console.warn('[idnr] contour fetch failed:', err?.message || err);
    surveyCache.delete(key);
    return null;
  });
  surveyCache.set(key, p);
  return p;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

// ------------------------------------------------------------------ contour → raster

/** Bucketed nearest-point index over grid-space samples. */
class NearestIndex {
  private buckets = new Map<string, number[]>();
  private xs: number[] = [];
  private ys: number[] = [];
  constructor(private cell = 1) {}
  add(x: number, y: number) {
    const i = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    const k = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    const b = this.buckets.get(k);
    if (b) b.push(i); else this.buckets.set(k, [i]);
  }
  get size() { return this.xs.length; }
  /** Distance (grid units) to the nearest sample, or Infinity if none within `maxRadius` buckets. */
  nearest(x: number, y: number, maxRadius = 64): number {
    if (!this.xs.length) return Infinity;
    const bx = Math.floor(x / this.cell);
    const by = Math.floor(y / this.cell);
    let best = Infinity;
    for (let r = 0; r <= maxRadius; r++) {
      // once the ring's inner edge is farther than the best hit, stop
      if (best < Infinity && (r - 1) * this.cell > best) break;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const b = this.buckets.get(`${bx + dx},${by + dy}`);
          if (!b) continue;
          for (const i of b) {
            const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
            if (d < best) best = d;
          }
        }
      }
    }
    return best;
  }
}

export interface DepthRasterResult {
  depthsFt: number[][];
  maxDepthFt: number;
}

/**
 * Builds a depth grid (feet) from contour polylines.
 *
 * For each water cell: `floor` = deepest closed contour containing the cell (0 = shoreline),
 * `next` = the next deeper contour level. Depth is interpolated linearly between the distance
 * to the floor line (or shore) and the distance to the next line. Inside the deepest contour
 * the depth rises toward `maxDepthFt` (survey max if known, else half an interval deeper).
 */
export function rasterizeContourDepths(
  survey: IdnrSurvey,
  waterMask: boolean[][],
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  maxDepthHintFt?: number
): DepthRasterResult {
  const rows = waterMask.length;
  const cols = waterMask[0].length;
  const gx = (lon: number) => ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (cols - 1);
  const gy = (lat: number) => ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (rows - 1);

  const levels = Array.from(new Set(survey.contours.map((c) => c.depthFt))).filter((d) => d > 0).sort((a, b) => a - b);
  const byLevel = new Map<number, NearestIndex>();
  const rings: Array<{ level: number; pts: Array<[number, number]> }> = [];

  for (const line of survey.contours) {
    if (line.depthFt <= 0 || line.coords.length < 2) continue;
    let idx = byLevel.get(line.depthFt);
    if (!idx) { idx = new NearestIndex(1); byLevel.set(line.depthFt, idx); }
    const pts: Array<[number, number]> = line.coords.map((p) => [gx(p.lon), gy(p.lat)]);
    // densify to ≤ 0.5 cell spacing
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(len / 0.5));
      for (let s = 0; s < steps; s++) idx.add(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    }
    idx.add(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (pts.length >= 4 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.75) rings.push({ level: line.depthFt, pts });
  }
  rings.sort((a, b) => b.level - a.level); // deepest first

  const inRing = (x: number, y: number, pts: Array<[number, number]>): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Shoreline index: land cells adjacent to water (grid border counts as shore)
  const shore = new NearestIndex(1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (waterMask[r][c]) {
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) shore.add(c, r);
        continue;
      }
      const touches = (r > 0 && waterMask[r - 1][c]) || (r < rows - 1 && waterMask[r + 1][c]) || (c > 0 && waterMask[r][c - 1]) || (c < cols - 1 && waterMask[r][c + 1]);
      if (touches) shore.add(c, r);
    }
  }

  const surveyMax = survey.lakeMaxDepthFt && survey.lakeMaxDepthFt > survey.maxContourFt ? survey.lakeMaxDepthFt : null;
  const maxDepthFt = surveyMax ?? (maxDepthHintFt && maxDepthHintFt > survey.maxContourFt ? maxDepthHintFt : survey.maxContourFt + survey.intervalFt * 0.5);

  const depthsFt: number[][] = [];
  const spacings: number[] = [];
  const pending: Array<[number, number, number, number]> = []; // r, c, floor, dIn for innermost cells
  for (let r = 0; r < rows; r++) {
    depthsFt[r] = new Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      if (!waterMask[r][c]) continue;
      let floor = 0;
      for (const ring of rings) {
        if (inRing(c, r, ring.pts)) { floor = ring.level; break; }
      }
      const next = levels.find((l) => l > floor);
      const dIn = floor === 0 ? shore.nearest(c, r) : (byLevel.get(floor)?.nearest(c, r) ?? Infinity);
      const dOut = next !== undefined ? (byLevel.get(next)?.nearest(c, r) ?? Infinity) : Infinity;
      if (next !== undefined && Number.isFinite(dOut) && Number.isFinite(dIn)) {
        const t = dIn / (dIn + dOut);
        depthsFt[r][c] = floor + (next - floor) * t;
        spacings.push(dIn + dOut);
      } else {
        pending.push([r, c, floor, Number.isFinite(dIn) ? dIn : 0]);
      }
    }
  }
  const typicalSpacing = spacings.length ? spacings.sort((a, b) => a - b)[Math.floor(spacings.length / 2)] : 3;
  for (const [r, c, floor, dIn] of pending) {
    const cap = Math.max(0, maxDepthFt - floor);
    const k = 1 - Math.exp(-dIn / Math.max(1, typicalSpacing));
    depthsFt[r][c] = floor + cap * k;
  }
  // Minimum wet depth so the shoreline reads as water in the mesh
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (waterMask[r][c]) depthsFt[r][c] = Math.max(0.3, depthsFt[r][c]);

  let observedMax = 0;
  for (const row of depthsFt) for (const v of row) if (v > observedMax) observedMax = v;
  return { depthsFt, maxDepthFt: Math.max(observedMax, survey.maxContourFt) };
}

// ------------------------------------------------------------------ PDF depth-map index

export interface IdnrPdfMap { name: string; county: string; url: string; month: string; year: number }

let pdfIndex: Promise<IdnrPdfMap[]> | null = null;
let pdfIndexAt = 0;

export async function loadIdnrPdfIndex(): Promise<IdnrPdfMap[]> {
  if (!idnrEnabled()) return [];
  if (pdfIndex && Date.now() - pdfIndexAt < 24 * 3600 * 1000) return pdfIndex;
  pdfIndexAt = Date.now();
  pdfIndex = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(DEPTH_MAPS_PAGE, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lake-topo-3d/1.0)' } });
      if (!res.ok) throw new Error(`${res.status}`);
      const html = await res.text();
      const out: IdnrPdfMap[] = [];
      const rowRe = /<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*><a href="([^"]+\.pdf)"[^>]*>[^<]*<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html))) {
        out.push({ name: m[1].trim(), county: m[2].trim(), url: m[3].startsWith('http') ? m[3] : `https://www.in.gov${m[3]}`, month: m[4].trim(), year: parseInt(m[5], 10) || 0 });
      }
      return out;
    } finally {
      clearTimeout(t);
    }
  })().catch((err) => {
    console.warn('[idnr] depth-map index failed:', err?.message || err);
    pdfIndex = null;
    return [];
  });
  return pdfIndex;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\b(lake|reservoir|pond)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Newest PDF depth map whose name matches; county narrows same-name lakes. */
export async function findIdnrPdf(lakeName: string, county?: string | null): Promise<IdnrPdfMap | null> {
  const index = await loadIdnrPdfIndex();
  const n = norm(lakeName);
  if (!n) return null;
  const c = county ? norm(county.replace(/county/i, '')) : '';
  const matches = index.filter((m) => norm(m.name) === n && (!c || norm(m.county) === c));
  if (!matches.length) return null;
  return matches.sort((a, b) => b.year - a.year)[0];
}

export { pointInLake };
