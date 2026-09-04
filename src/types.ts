export interface TopoFeature {
  label: string;
  type: 'dam' | 'inlet' | 'deep_hole' | 'boat_ramp' | 'cove' | 'ridge' | 'beach';
  normX: number; // -1 (west) to 1 (east)
  normY: number; // -1 (north) to 1 (south)
  depthOrElevFt?: number;
  description?: string;
}

export interface GroundingSource {
  title: string;
  uri?: string;
  snippet?: string;
  sourceType?: 'dnr_survey' | 'usgs_topo' | 'web_search' | 'hydrographic_database' | 'osm' | 'dem';
}

/** Where the descriptive metadata (depth, geology, description) came from. */
export type GenerationMethod =
  | 'ai-search-grounded' // Gemini with Google Search grounding succeeded
  | 'ai-synthesis'       // Gemini answered without search grounding (model memory only)
  | 'ai-topo-vision'     // Gemini Vision read an uploaded chart
  | 'curated-survey'     // hand-curated entry in server/lakeData.ts
  | 'heuristic';         // deterministic guess from the query string / lake size

/** Where the actual terrain geometry came from. */
export type GeometrySource =
  | 'osm-dem'    // real shoreline polygon (OpenStreetMap) + real elevation tiles (Terrarium DEM)
  | 'curated-sdf' // hand-built signed-distance-field model (Deam Lake)
  | 'procedural'; // parametric blob + noise

export interface LakeMetadata {
  id: string;
  name: string;
  state: string;
  county?: string;
  lat: number;
  lon: number;
  surfaceElevationM: number;
  surfaceElevationFt: number;
  maxDepthM: number;
  maxDepthFt: number;
  meanDepthM: number;
  meanDepthFt: number;
  areaAcres: number;
  perimeterKm: number;
  geologicalOrigin: string;
  description: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  sources?: GroundingSource[];
  topoFeatures?: TopoFeature[];
  contourIntervalFt?: number;
  generationMethod?: GenerationMethod;
  geometrySource?: GeometrySource;
  /** True when maxDepth / meanDepth are estimates rather than surveyed values. */
  depthIsEstimated?: boolean;
  topoAnalysisNotes?: string;
  osmId?: string;
}

export interface TerrainGridData {
  metadata: LakeMetadata;
  gridSize: number;
  // Elevations in meters relative to sea level, [row][col]; row 0 = north edge, col 0 = west edge
  elevations: number[][];
  // Water mask: true if cell is within the lake body
  waterMask: boolean[][];
  // Depth in meters below water surface (0 if land)
  depths: number[][];
  minElevation: number;
  maxElevation: number;
  waterElevation: number;
  minDepth: number;
  maxDepth: number;
  physicalWidthKm: number;  // east-west extent of the grid
  physicalHeightKm: number; // north-south extent of the grid
  svgTopoMap?: string; // vector topographic contour map, generated server-side
}

export interface STLOptions {
  baseThicknessMm: number; // thickness of flat base pedestal in mm (below the lowest point of the terrain)
  targetWidthMm: number;   // size of the model on the 3D print bed (X dimension)
  verticalExaggeration: number; // multiple of TRUE scale (1.0 = same mm/m vertically as horizontally)
  includeWaterCap: boolean; // if true, fills the lake to the water surface instead of hollowing the bathymetry
  format: 'binary' | 'ascii';
  terraceContours?: boolean; // if true, exports stepped contour layers (laser-cut topo look)
  terraceStepFt?: number;    // e.g. 5, 10, or 20 ft contour steps
}

export type TerrainShadingStyle =
  | 'stepped-terraces' // Stepped contour terraces (like physical laser-cut wood topo maps)
  | 'faceted-topo'     // Sharp crisp polygon facets with flat shading
  | 'chiseled-ridges'  // Exaggerated ridgelines, steep banks and incised channels
  | 'smooth';          // Blended smooth normals

export type ColorSchemeMode =
  | 'hypsometric'   // Deep navy blue lake, cyan shoreline, emerald land, amber ridges
  | 'bathymetric'   // Intense high-contrast blue gradient for underwater depths
  | 'topographic'   // USGS style contour bands (terracotta, buff, olive, blue)
  | 'satellite'     // Earth natural tones (forest, sand, deep water)
  | 'print-resin'   // Sleek matte white/grey PLA 3D-print simulation
  | 'slate';        // Dark architectural stone theme
