/**
 * Sourced facts about a lake from Wikidata + English Wikipedia (CC BY-SA).
 * Used before any LLM so numbers like max depth come from a citable page, not a model.
 */
import { cacheGet, cacheSet } from './diskCache.js';

const UA = 'lake-topo-3d/1.0 (https://github.com/rustyorb/lake-topo-3d)';
const DISK_TTL = 14 * 24 * 3600 * 1000;

export interface WikiFacts {
  wikidataId?: string;
  title?: string;
  url?: string;
  shortDescription?: string;
  extract?: string;
  maxDepthM?: number;
  meanDepthM?: number;
  surfaceElevationM?: number;
  areaKm2?: number;
  lakeType?: string;
  inflows?: string;
  outflows?: string;
  lat?: number;
  lon?: number;
}

const cache = new Map<string, Promise<WikiFacts | null>>();

async function getJson(url: string, ms = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// Wikidata quantity units → metres / km²
const LENGTH_UNITS: Record<string, number> = { Q11573: 1, Q3710: 0.3048, Q828224: 1000, Q482798: 0.9144 };
const AREA_UNITS: Record<string, number> = { Q712226: 1, Q35852: 0.01, Q81292: 0.00404686, Q232291: 2.58999, Q25343: 1e-6 };

function quantity(claims: any, prop: string, units: Record<string, number>): number | undefined {
  const c = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
  if (!c || c.amount === undefined) return undefined;
  const unit = String(c.unit || '').split('/').pop() || '';
  const f = units[unit];
  if (f === undefined) return undefined;
  const v = parseFloat(c.amount) * f;
  return Number.isFinite(v) ? v : undefined;
}

/** Parses "{{convert|30|ft|m}}", "30 ft (9.1 m)", "9.1 m", "77 feet" → metres. */
export function parseLengthToMetres(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/<ref[^>]*>.*?<\/ref>/gis, '').replace(/<ref[^>]*\/>/gi, '');
  const conv = s.match(/\{\{\s*convert\s*\|\s*([\d.,]+)\s*(?:\|\s*(?:to|-|–)\s*\|\s*[\d.,]+\s*)?\|\s*(ft|feet|foot|m|metres?|meters?|km|mi)\b/i);
  const plain = s.match(/([\d.,]+)\s*(ft|feet|foot|m|metres?|meters?|km|mi)\b/i);
  const m = conv || plain;
  if (!m) return undefined;
  const v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return undefined;
  const u = m[2].toLowerCase();
  if (u.startsWith('f')) return v * 0.3048;
  if (u === 'km') return v * 1000;
  if (u === 'mi') return v * 1609.34;
  return v;
}

export function parseAreaToKm2(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/<ref[^>]*>.*?<\/ref>/gis, '');
  const m = s.match(/\{\{\s*convert\s*\|\s*([\d.,]+)\s*\|\s*(acres?|ha|km2|sqmi|mi2|m2)\b/i) || s.match(/([\d.,]+)\s*(acres?|ha|km2|km²|sq\s*mi|mi2|m2)\b/i);
  if (!m) return undefined;
  const v = parseFloat(m[1].replace(/,/g, ''));
  const u = m[2].toLowerCase().replace(/\s/g, '');
  if (!Number.isFinite(v)) return undefined;
  if (u.startsWith('acre')) return v * 0.00404686;
  if (u === 'ha') return v * 0.01;
  if (u === 'sqmi' || u === 'mi2') return v * 2.58999;
  if (u === 'm2') return v * 1e-6;
  return v;
}

function infoboxField(wikitext: string, ...names: string[]): string | undefined {
  for (const n of names) {
    // value = templates {{...}} and links [[...]] as units, else any non-pipe char on the line
    const re = new RegExp(`\\|\\s*${n.replace(/[-_]/g, '[-_]')}\\s*=\\s*((?:\\{\\{[^{}]*\\}\\}|\\[\\[[^\\]]*\\]\\]|[^\\n|])*)`, 'i');
    const m = wikitext.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return undefined;
}

function stripWiki(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<ref[^>]*>.*?<\/ref>/gis, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

async function wikipediaByTitle(title: string): Promise<Partial<WikiFacts>> {
  const out: Partial<WikiFacts> = {};
  const summary = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (summary && summary.type !== 'disambiguation') {
    out.title = summary.title;
    out.url = summary.content_urls?.desktop?.page;
    out.shortDescription = summary.description;
    out.extract = summary.extract;
    if (summary.coordinates) { out.lat = summary.coordinates.lat; out.lon = summary.coordinates.lon; }
  }
  const raw = await getJson(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title, format: 'json', formatversion: '2' }).toString()}`);
  const text: string | undefined = raw?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
  if (text) {
    out.maxDepthM = parseLengthToMetres(infoboxField(text, 'max-depth', 'max_depth', 'maxdepth'));
    out.meanDepthM = parseLengthToMetres(infoboxField(text, 'depth', 'mean_depth', 'mean-depth', 'average_depth'));
    out.surfaceElevationM = parseLengthToMetres(infoboxField(text, 'elevation', 'surface_elevation'));
    out.areaKm2 = parseAreaToKm2(infoboxField(text, 'area', 'surface_area'));
    out.lakeType = stripWiki(infoboxField(text, 'lake_type', 'type'));
    out.inflows = stripWiki(infoboxField(text, 'inflow', 'inflows'));
    out.outflows = stripWiki(infoboxField(text, 'outflow', 'outflows'));
  }
  return out;
}

/**
 * Looks up facts by Wikidata id (from OSM tags) or by name near a coordinate.
 * The coordinate guard (≈40 km) stops "Devils Lake" resolving to the wrong state.
 */
export async function lookupWikiFacts(opts: { name: string; wikidataId?: string; lat: number; lon: number; region?: string }): Promise<WikiFacts | null> {
  if (process.env.WIKI_DISABLED === 'true') return null;
  const key = `${opts.wikidataId || ''}|${opts.name.toLowerCase()}|${opts.lat.toFixed(2)},${opts.lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const disk = cacheGet<WikiFacts | null>('wiki', key, DISK_TTL);
  if (disk !== undefined) { const p = Promise.resolve(disk); cache.set(key, p); return p; }
  const p = (async (): Promise<WikiFacts | null> => {
    let qid = opts.wikidataId;
    let entity: any = null;
    const near = (lat?: number, lon?: number) => lat !== undefined && lon !== undefined && Math.hypot(lat - opts.lat, (lon - opts.lon) * Math.cos((opts.lat * Math.PI) / 180)) < 0.4;

    if (!qid) {
      const search = await getJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbsearchentities', search: opts.name, language: 'en', format: 'json', limit: '8', type: 'item' }).toString()}`);
      const candidates: string[] = (search?.search || []).map((s: any) => s.id);
      for (const cid of candidates) {
        const e = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${cid}.json`);
        const ent = e?.entities?.[cid];
        const coord = ent?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
        if (coord && near(coord.latitude, coord.longitude)) { qid = cid; entity = ent; break; }
      }
    } else {
      const e = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
      entity = e?.entities?.[qid] || null;
    }

    const facts: WikiFacts = {};
    let title: string | undefined;
    if (entity) {
      facts.wikidataId = qid;
      const claims = entity.claims || {};
      facts.maxDepthM = quantity(claims, 'P4511', LENGTH_UNITS);
      facts.surfaceElevationM = quantity(claims, 'P2044', LENGTH_UNITS);
      facts.areaKm2 = quantity(claims, 'P2046', AREA_UNITS);
      title = entity.sitelinks?.enwiki?.title;
      const coord = claims.P625?.[0]?.mainsnak?.datavalue?.value;
      if (coord) { facts.lat = coord.latitude; facts.lon = coord.longitude; }
    }

    if (!title) {
      // Search Wikipedia directly; accept only pages whose coordinates are near the lake
      const q = `${opts.name} ${opts.region || ''} lake`.trim();
      const s = await getJson(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: q, format: 'json', srlimit: '5' }).toString()}`);
      for (const hitTitle of (s?.query?.search || []).map((r: any) => r.title as string)) {
        const summary = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hitTitle.replace(/ /g, '_'))}`);
        if (summary?.coordinates && near(summary.coordinates.lat, summary.coordinates.lon)) { title = hitTitle; break; }
      }
    }

    if (title) {
      const wp = await wikipediaByTitle(title);
      for (const [k, v] of Object.entries(wp)) if (v !== undefined && (facts as any)[k] === undefined) (facts as any)[k] = v;
    }
    const hasAnything = facts.title || facts.wikidataId;
    const out = hasAnything ? facts : null;
    cacheSet('wiki', key, out);
    return out;
  })().catch((err) => {
    console.warn('[wiki] lookup failed:', err?.message || err);
    cache.delete(key);
    return null;
  });
  cache.set(key, p);
  return p;
}
