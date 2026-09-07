import { BathymetrySource, DemSource, GenerationMethod, GeometrySource } from '../types.js';

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
    case 'idnr-survey': return 'Indiana DNR sonar survey';
    case 'wikipedia': return 'Wikipedia / Wikidata';
    case 'ai-search-grounded': return 'LLM + web search (cited)';
    case 'ai-synthesis': return 'LLM from memory (unverified)';
    case 'ai-topo-vision': return 'LLM vision (uploaded chart)';
    case 'curated-survey': return 'Curated survey record';
    case 'heuristic': return 'None (heuristic defaults)';
    default: return 'Unknown';
  }
}

export function describeBathymetry(b?: BathymetrySource): string {
  switch (b) {
    case 'idnr-sonar': return 'IDNR sonar contours';
    case 'distance-model': return 'Modelled (distance to shore)';
    case 'curated-sdf': return 'Hand-built survey model';
    case 'user-soundings': return 'Your soundings (interpolated)';
    case 'procedural': return 'Procedural';
    default: return 'Unknown';
  }
}

export function describeDem(d?: DemSource): string {
  switch (d) {
    case '3dep': return 'USGS 3DEP LiDAR';
    case 'terrarium': return 'Terrarium tiles (30 m)';
    case 'synthetic': return 'Synthetic';
    default: return 'Unknown';
  }
}
