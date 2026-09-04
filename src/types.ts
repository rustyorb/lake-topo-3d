export interface TopoFeature {
  label: string;
  type: 'dam' | 'inlet' | 'deep_hole' | 'boat_ramp' | 'cove' | 'ridge' | 'beach';
  normX: number; // -1 to 1 normalized
  normY: number; // -1 to 1 normalized
  depthOrElevFt?: number;
  description?: string;
}

export interface GroundingSource {
  title: string;
  uri?: string;
  snippet?: string;
  sourceType?: 'dnr_survey' | 'usgs_topo' | 'web_search' | 'hydrographic_database';
}

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
  generationMethod?: 'ai-search-grounded' | 'ai-topo-vision' | 'curated-survey' | 'heuristic';
  topoAnalysisNotes?: string;
}

export interface TerrainGridData {
  metadata: LakeMetadata;
  gridSize: number;
  // Elevations in meters relative to sea level
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
  physicalWidthKm: number;
  physicalHeightKm: number;
  svgTopoMap?: string; // High-res SVG topographic contour map
}

export interface STLOptions {
  baseThicknessMm: number; // thickness of flat base pedestal in mm
  targetWidthMm: number;   // size of the model on the 3D print bed (X dimension)
  verticalExaggeration: number; // e.g. 1.0 to 4.0
  includeWaterCap: boolean; // if true, creates a flat top water surface instead of hollowed bathymetry
  format: 'binary' | 'ascii';
  terraceContours?: boolean; // if true, exports stepped contour layers (architectural / laser-cut topo look)
  terraceStepFt?: number;    // e.g. 5, 10, or 20 ft contour steps
}

export type TerrainShadingStyle = 
  | 'stepped-terraces' // Stepped contour terraces (like physical laser-cut wood topo maps)
  | 'faceted-topo'     // Sharp crisp polygon facets with flat shading (authentic topo quad map)
  | 'chiseled-ridges'  // High-contrast sharp ridgelines, steep banks and incised channels
  | 'smooth';          // Blended smooth normals

export type ColorSchemeMode = 
  | 'hypsometric'   // Deep navy blue lake, cyan shoreline, emerald land, amber ridges
  | 'bathymetric'   // Intense high-contrast blue gradient for underwater depths
  | 'topographic'   // USGS style contour bands (terracotta, buff, olive, blue)
  | 'satellite'     // Earth natural tones (forest, sand, deep water)
  | 'print-resin'   // Sleek matte white/grey PLA 3D-print simulation
  | 'slate';        // Dark architectural stone theme
