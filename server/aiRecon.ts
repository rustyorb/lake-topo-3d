/**
 * Optional LLM enrichment. Runs after every sourced fact has been gathered and is only
 * allowed to fill gaps (geology sentence, landmarks, missing depths). Provider-neutral via ./llm.
 */
import { GroundingSource, TopoFeature } from '../src/types.js';
import { complete, extractJson, llmAvailable, llmDescription } from './llm.js';

export interface ReconContext {
  name: string;
  region?: string;
  county?: string;
  lat: number;
  lon: number;
  knownFacts: Record<string, string | number | undefined>;
  wikipediaExtract?: string;
  userNotes?: string;
}

export interface ReconResult {
  maxDepthFt?: number;
  meanDepthFt?: number;
  surfaceElevationFt?: number;
  geologicalOrigin?: string;
  description?: string;
  county?: string;
  state?: string;
  features: TopoFeature[];
  sources: GroundingSource[];
  searchGrounded: boolean;
  provider: string;
  model: string;
  notes?: string;
}

const SYSTEM = `You are a limnologist and hydrographer helping build a 3D bathymetric model of a lake.
Answer with a single JSON object and nothing else. Use null for anything you do not actually know.
Never invent numeric depths: if the known facts already give a value, repeat it; if not and you are not confident, return null.`;

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function performAiRecon(ctx: ReconContext): Promise<ReconResult | null> {
  if (!llmAvailable()) return null;
  const facts = Object.entries(ctx.knownFacts).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const prompt = `Lake: "${ctx.name}"${ctx.county ? `, ${ctx.county}` : ''}${ctx.region ? `, ${ctx.region}` : ''} (lat ${ctx.lat.toFixed(4)}, lon ${ctx.lon.toFixed(4)}).
Known facts from map data and Wikipedia (authoritative, do not contradict):
${facts || '- none'}
${ctx.wikipediaExtract ? `\nWikipedia summary: ${ctx.wikipediaExtract}\n` : ''}${ctx.userNotes ? `\nUser notes: ${ctx.userNotes}\n` : ''}
Return JSON:
{
  "maxDepthFt": number|null,
  "meanDepthFt": number|null,
  "surfaceElevationFt": number|null,
  "county": string|null,
  "state": string|null,
  "geologicalOrigin": "one sentence on how the basin formed (reservoir impoundment, glacial kettle, karst, etc.)",
  "description": "two sentences: shoreline character, surrounding relief, notable underwater structure",
  "features": [ { "label": "Dam / main inlet / deepest basin / boat ramp ...", "type": "dam|inlet|deep_hole|boat_ramp|cove|ridge|beach", "description": "short", "depthOrElevFt": number|null } ],
  "sources": [ { "title": "...", "uri": "https://..." } ],
  "notes": "how you know this (survey, DNR, USGS, Wikipedia, memory)"
}`;

  try {
    const res = await complete({ system: SYSTEM, prompt, json: true, webSearch: true, maxTokens: 4000 });
    const data = extractJson(res.text);
    if (!data) return null;
    const sources: GroundingSource[] = res.sources.map((s) => ({ title: s.title, uri: s.uri, sourceType: 'web_search' as const }));
    for (const s of Array.isArray(data.sources) ? data.sources : []) {
      if (s?.uri && !sources.some((x) => x.uri === s.uri)) sources.push({ title: String(s.title || s.uri), uri: String(s.uri), sourceType: 'llm' });
    }
    const features: TopoFeature[] = (Array.isArray(data.features) ? data.features : []).slice(0, 12).map((f: any) => ({
      label: String(f.label || 'Landmark'),
      type: (['dam', 'inlet', 'deep_hole', 'boat_ramp', 'cove', 'ridge', 'beach'].includes(f.type) ? f.type : 'cove') as TopoFeature['type'],
      normX: 0,
      normY: 0,
      depthOrElevFt: num(f.depthOrElevFt),
      description: f.description ? String(f.description) : undefined,
    }));
    return {
      maxDepthFt: num(data.maxDepthFt),
      meanDepthFt: num(data.meanDepthFt),
      surfaceElevationFt: num(data.surfaceElevationFt),
      geologicalOrigin: data.geologicalOrigin ? String(data.geologicalOrigin) : undefined,
      description: data.description ? String(data.description) : undefined,
      county: data.county ? String(data.county) : undefined,
      state: data.state ? String(data.state) : undefined,
      features,
      sources,
      searchGrounded: res.searchGrounded,
      provider: res.provider,
      model: res.model,
      notes: data.notes ? String(data.notes) : undefined,
    };
  } catch (err: any) {
    console.warn('[ai] recon failed:', err?.message || err);
    return null;
  }
}

export interface ChartReading {
  name?: string;
  state?: string;
  county?: string;
  surfaceElevationFt?: number;
  maxDepthFt?: number;
  meanDepthFt?: number;
  contourIntervalFt?: number;
  notes?: string;
  provider: string;
  model: string;
}

/** Reads an uploaded depth chart / topo image for its labelled facts. */
export async function readChartImage(base64: string, mimeType: string, hintName?: string): Promise<ChartReading | null> {
  if (!llmAvailable()) return null;
  const clean = base64.replace(/^data:[^;]+;base64,/, '');
  const prompt = `This is a lake depth chart or topographic map${hintName ? ` (possibly ${hintName})` : ''}.
Read the printed text and legend. Return JSON:
{ "name": string|null, "state": string|null, "county": string|null, "surfaceElevationFt": number|null, "maxDepthFt": number|null, "meanDepthFt": number|null, "contourIntervalFt": number|null, "notes": "what the chart shows and its survey date/source if printed" }
Only report numbers that are printed on the chart.`;
  try {
    const res = await complete({ system: SYSTEM, prompt, images: [{ base64: clean, mimeType: mimeType || 'image/png' }], json: true, maxTokens: 1500 });
    const data = extractJson(res.text);
    if (!data) return null;
    return {
      name: data.name ? String(data.name) : undefined,
      state: data.state ? String(data.state) : undefined,
      county: data.county ? String(data.county) : undefined,
      surfaceElevationFt: num(data.surfaceElevationFt),
      maxDepthFt: num(data.maxDepthFt),
      meanDepthFt: num(data.meanDepthFt),
      contourIntervalFt: num(data.contourIntervalFt),
      notes: data.notes ? String(data.notes) : undefined,
      provider: res.provider,
      model: res.model,
    };
  } catch (err: any) {
    console.warn('[ai] chart reading failed:', err?.message || err);
    return null;
  }
}

export { llmAvailable, llmDescription };
