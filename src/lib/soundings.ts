/**
 * Parses depth soundings the user brings in: a CSV/TSV export from a sonar unit or chart app
 * (lat, lon, depth) or a GPX file of waypoints/track points carrying a depth.
 */

export interface Sounding {
  lat: number;
  lon: number;
  /** Metres, positive down. */
  depthM: number;
}

export type DepthUnit = 'ft' | 'm';

export interface ParsedSoundings {
  points: Sounding[];
  skipped: number;
  unitUsed: DepthUnit;
  note: string;
}

export const MAX_SOUNDINGS = 50_000;
const FT_PER_M = 3.28084;

export function parseSoundings(text: string, filename: string, unit: DepthUnit): ParsedSoundings {
  const head = text.slice(0, 4000);
  if (/\.gpx$/i.test(filename) || /<gpx[\s>]/i.test(head)) return parseGpx(text, unit);
  return parseCsv(text, unit);
}

function toMetres(v: number, unit: DepthUnit): number {
  return unit === 'ft' ? v / FT_PER_M : v;
}

function unitFromText(s: string): DepthUnit | null {
  if (/\b(ft|feet|foot)\b|\(ft\)|_ft\b/i.test(s)) return 'ft';
  if (/\b(m|meters?|metres?)\b|\(m\)|_m\b/i.test(s)) return 'm';
  return null;
}

function parseCsv(text: string, unit: DepthUnit): ParsedSoundings {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { points: [], skipped: 0, unitUsed: unit, note: 'The file is empty.' };
  const first = lines[0];
  const delim = [',', '\t', ';'].reduce((best, d) => (first.split(d).length > first.split(best).length ? d : best), ',');
  const split = (l: string) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
  const firstCells = split(first);
  const hasHeader = firstCells.some((c) => /[a-z]/i.test(c));
  let latCol = 0, lonCol = 1, depthCol = 2;
  let unitUsed = unit;
  let note = '';
  if (hasHeader) {
    const norm = firstCells.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    const find = (re: RegExp) => norm.findIndex((c) => re.test(c));
    const la = find(/^(lat|latitude|y)$|^lat\b/);
    const lo = find(/^(lon|lng|long|longitude|x)$|^lon\b|^lng\b/);
    const de = find(/depth|^z$|^z\b/);
    if (la < 0 || lo < 0 || de < 0) {
      return { points: [], skipped: lines.length, unitUsed, note: `Could not find latitude, longitude and depth columns in the header: ${firstCells.join(', ')}` };
    }
    latCol = la; lonCol = lo; depthCol = de;
    const hinted = unitFromText(firstCells[de]);
    if (hinted) { unitUsed = hinted; note = `Depth unit read from the header ("${firstCells[de]}").`; }
    lines.shift();
  } else {
    // No header: lat, lon, depth — unless the first column looks like a longitude.
    const probe = firstCells.map(Number);
    if (Math.abs(probe[0]) > 90 && Math.abs(probe[1]) <= 90) { latCol = 1; lonCol = 0; note = 'Columns read as lon, lat, depth.'; }
    else note = 'Columns read as lat, lon, depth.';
  }
  const points: Sounding[] = [];
  let skipped = 0;
  for (const l of lines) {
    const cells = split(l);
    const lat = Number(cells[latCol]);
    const lon = Number(cells[lonCol]);
    const depth = Math.abs(Number(cells[depthCol]));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(depth) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; continue; }
    points.push({ lat, lon, depthM: toMetres(depth, unitUsed) });
    if (points.length >= MAX_SOUNDINGS) { note += ` Stopped at ${MAX_SOUNDINGS.toLocaleString()} points.`; break; }
  }
  return { points, skipped, unitUsed, note: note.trim() };
}

function parseGpx(text: string, unit: DepthUnit): ParsedSoundings {
  const points: Sounding[] = [];
  let skipped = 0;
  let unitUsed = unit;
  let fromDepthTag = 0, fromEle = 0, fromText = 0;
  const re = /<(wpt|trkpt|rtept)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = m[2];
    const body = m[3];
    const lat = Number(/\blat="([^"]+)"/.exec(attrs)?.[1]);
    const lon = Number(/\blon="([^"]+)"/.exec(attrs)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skipped++; continue; }
    let depth: number | null = null;
    const tag = /<(?:\w+:)?depth>\s*([-\d.]+)/i.exec(body);
    const ele = /<ele>\s*([-\d.]+)/i.exec(body);
    if (tag) { depth = Math.abs(Number(tag[1])); fromDepthTag++; }
    else if (ele) { depth = Math.abs(Number(ele[1])); fromEle++; }
    else {
      const txt = [/<desc>([\s\S]*?)<\/desc>/i, /<cmt>([\s\S]*?)<\/cmt>/i, /<name>([\s\S]*?)<\/name>/i].map((r) => r.exec(body)?.[1] || '').join(' ');
      const num = /(-?\d+(?:\.\d+)?)\s*(ft|feet|m|metres?|meters?)?/i.exec(txt);
      if (num) {
        depth = Math.abs(Number(num[1]));
        const u = num[2] ? unitFromText(num[2]) : null;
        if (u) unitUsed = u;
        fromText++;
      }
    }
    if (depth === null || !Number.isFinite(depth)) { skipped++; continue; }
    points.push({ lat, lon, depthM: toMetres(depth, unitUsed) });
    if (points.length >= MAX_SOUNDINGS) break;
  }
  const parts = [fromDepthTag && `${fromDepthTag} from <depth> tags`, fromEle && `${fromEle} from <ele>`, fromText && `${fromText} from names/descriptions`].filter(Boolean);
  return { points, skipped, unitUsed, note: parts.length ? `Depths: ${parts.join(', ')}.` : 'No points with a depth were found.' };
}
