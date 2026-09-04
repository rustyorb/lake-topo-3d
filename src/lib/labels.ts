import { GenerationMethod, GeometrySource } from '../types.js';

export function describeGeometry(src?: GeometrySource): string {
  switch (src) {
    case 'osm-dem': return 'Real shoreline + DEM';
    case 'curated-sdf': return 'Hand-built survey model';
    case 'procedural': return 'Procedural placeholder';
    default: return 'Unknown';
  }
}

export function describeMethod(m?: GenerationMethod): string {
  switch (m) {
    case 'ai-search-grounded': return 'Gemini + Google Search';
    case 'ai-synthesis': return 'Gemini (no search — unverified)';
    case 'ai-topo-vision': return 'Gemini Vision (uploaded chart)';
    case 'curated-survey': return 'Curated survey record';
    case 'heuristic': return 'None (heuristic defaults)';
    default: return 'Unknown';
  }
}
