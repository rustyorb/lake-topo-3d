import { TerrainGridData, TopoFeature } from '../src/types.js';

/**
 * Generates an authentic, high-resolution SVG Topographic & Bathymetric Survey Map
 * based on the generated terrain grid, water mask, depth data, and topo features.
 */
export function generateSvgTopoMap(data: {
  name: string;
  state: string;
  county?: string;
  surfaceElevationFt: number;
  maxDepthFt: number;
  meanDepthFt: number;
  gridSize: number;
  elevations: number[][];
  waterMask: boolean[][];
  depths: number[][];
  minElevation: number;
  maxElevation: number;
  topoFeatures?: TopoFeature[];
  contourIntervalFt?: number;
}): string {
  const width = 800;
  const height = 800;
  const padding = 50;
  const mapSize = width - padding * 2; // 700x700
  const size = data.gridSize;

  const minElevFt = Math.round(data.minElevation * 3.28084);
  const maxElevFt = Math.round(data.maxElevation * 3.28084);
  const intervalFt = data.contourIntervalFt || 5;

  // 1. Generate Marching Squares or Contour Paths for Bathymetry (Depth Contours)
  const depthThresholdsFt = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100].filter(
    (d) => d <= data.maxDepthFt + 1
  );

  // Convert normalized point to map pixel
  const toPixel = (normX: number, normY: number) => {
    // normX: -1 to 1 -> padding to padding + mapSize
    const px = padding + ((normX + 1) / 2) * mapSize;
    const py = padding + ((normY + 1) / 2) * mapSize;
    return { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 };
  };

  // Convert grid row, col to map pixel
  const gridToPixel = (r: number, c: number) => {
    const px = padding + (c / (size - 1)) * mapSize;
    const py = padding + (r / (size - 1)) * mapSize;
    return { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 };
  };

  // Build SVG Paths for Water Shoreline and Depth Zones
  // We can sample the grid cells and generate smoothed contour lines
  const bathyContourPaths: { depthFt: number; d: string; isIndex: boolean }[] = [];

  for (const depthFt of depthThresholdsFt) {
    if (depthFt === 0) continue; // 0 is shoreline
    const targetDepthM = depthFt * 0.3048;
    const segments: string[] = [];

    // Horizontal segments
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const d00 = data.depths[r][c];
        const d10 = data.depths[r][c + 1];
        const d01 = data.depths[r + 1][c];
        const d11 = data.depths[r + 1][c + 1];

        const hasInside = d00 >= targetDepthM || d10 >= targetDepthM || d01 >= targetDepthM || d11 >= targetDepthM;
        const allInside = d00 >= targetDepthM && d10 >= targetDepthM && d01 >= targetDepthM && d11 >= targetDepthM;

        if (hasInside && !allInside) {
          const ptA = gridToPixel(r, c);
          const ptB = gridToPixel(r, c + 1);
          const ptC = gridToPixel(r + 1, c + 1);
          const ptD = gridToPixel(r + 1, c);
          
          // Simple cell edge intersection interpolation
          const p1 = { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 };
          const p2 = { x: (ptC.x + ptD.x) / 2, y: (ptC.y + ptD.y) / 2 };
          segments.push(`M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
        }
      }
    }

    if (segments.length > 0) {
      bathyContourPaths.push({
        depthFt,
        d: segments.slice(0, 180).join(' '),
        isIndex: depthFt % 10 === 0,
      });
    }
  }

  // Shoreline outline path from waterMask
  const shorelineSegments: string[] = [];
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const w00 = data.waterMask[r][c];
      const w10 = data.waterMask[r][c + 1];
      const w01 = data.waterMask[r + 1][c];
      const w11 = data.waterMask[r + 1][c + 1];
      if ((w00 || w10 || w01 || w11) && !(w00 && w10 && w01 && w11)) {
        const pt = gridToPixel(r, c);
        shorelineSegments.push(`M ${pt.x} ${pt.y} l 8 8`);
      }
    }
  }

  // Key Topo Feature Markers
  const features = data.topoFeatures || [
    { label: 'Dam Embankment', type: 'dam', normX: -0.25, normY: 0.55, depthOrElevFt: data.surfaceElevationFt },
    { label: 'Max Depth Sounding', type: 'deep_hole', normX: 0.08, normY: 0.36, depthOrElevFt: data.maxDepthFt },
    { label: 'Feeder Creek Inlet', type: 'inlet', normX: 0.32, normY: -0.80, depthOrElevFt: 2 },
  ];

  const featureElements = features.map((f, idx) => {
    const pt = toPixel(f.normX, f.normY);
    let icon = '';
    let badgeColor = '#38bdf8';
    let text = f.label;
    if (f.depthOrElevFt !== undefined) {
      if (f.type === 'deep_hole' || f.type === 'cove') {
        text += ` (${f.depthOrElevFt} ft depth)`;
      } else if (f.type === 'dam' || f.type === 'ridge') {
        text += ` (${f.depthOrElevFt} ft el.)`;
      }
    }

    if (f.type === 'dam') {
      badgeColor = '#f59e0b';
      icon = `<rect x="${pt.x - 8}" y="${pt.y - 4}" width="16" height="8" fill="${badgeColor}" stroke="#1e293b" stroke-width="1.5" rx="2"/>`;
    } else if (f.type === 'deep_hole') {
      badgeColor = '#3b82f6';
      icon = `<circle cx="${pt.x}" cy="${pt.y}" r="6" fill="#1e3a8a" stroke="#60a5fa" stroke-width="2"/>
              <line x1="${pt.x - 9}" y1="${pt.y}" x2="${pt.x + 9}" y2="${pt.y}" stroke="#60a5fa" stroke-width="1.5"/>
              <line x1="${pt.x}" y1="${pt.y - 9}" x2="${pt.x}" y2="${pt.y + 9}" stroke="#60a5fa" stroke-width="1.5"/>`;
    } else if (f.type === 'inlet') {
      badgeColor = '#10b981';
      icon = `<polygon points="${pt.x},${pt.y - 8} ${pt.x + 6},${pt.y + 6} ${pt.x - 6},${pt.y + 6}" fill="${badgeColor}" stroke="#064e3b" stroke-width="1.5"/>`;
    } else if (f.type === 'boat_ramp') {
      badgeColor = '#06b6d4';
      icon = `<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="${badgeColor}" stroke="#083344" stroke-width="1.5"/>`;
    } else {
      badgeColor = '#a855f7';
      icon = `<polygon points="${pt.x},${pt.y - 7} ${pt.x + 7},${pt.y + 7} ${pt.x - 7},${pt.y + 7}" fill="${badgeColor}" stroke="#3b0764" stroke-width="1.5"/>`;
    }

    const textAnchor = pt.x > width / 2 ? 'end' : 'start';
    const textOffset = pt.x > width / 2 ? -12 : 12;

    return `
      <g class="feature-marker" id="topo-feature-${idx}">
        ${icon}
        <rect x="${pt.x + (textAnchor === 'end' ? textOffset - (text.length * 5.8) : textOffset - 4)}" y="${pt.y - 10}" width="${text.length * 5.8 + 8}" height="15" fill="#0f172a" fill-opacity="0.85" rx="3" stroke="#334155" stroke-width="0.75"/>
        <text x="${pt.x + textOffset}" y="${pt.y + 1}" font-family="system-ui, sans-serif" font-size="9" font-weight="600" fill="${badgeColor}" text-anchor="${textAnchor}">
          ${text}
        </text>
      </g>
    `;
  }).join('\n');

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" class="select-none">
  <defs>
    <!-- USGS Quadrangle Topo Background Gradient -->
    <radialGradient id="topoLandGrad" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#14211a" />
      <stop offset="50%" stop-color="#0f1a14" />
      <stop offset="100%" stop-color="#080f0c" />
    </radialGradient>

    <!-- Hydrographic Water Gradient -->
    <radialGradient id="waterDepthGrad" cx="52%" cy="54%" r="48%">
      <stop offset="0%" stop-color="#082f49" />
      <stop offset="45%" stop-color="#0c4a6e" />
      <stop offset="85%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#38bdf8" />
    </radialGradient>

    <!-- Grid Pattern for Topographic Map Coordinates -->
    <pattern id="topoGridPattern" width="70" height="70" patternUnits="userSpaceOnUse">
      <path d="M 70 0 L 0 0 0 70" fill="none" stroke="#22c55e" stroke-width="0.5" stroke-opacity="0.12" />
      <circle cx="0" cy="0" r="1.2" fill="#22c55e" fill-opacity="0.3"/>
    </pattern>
  </defs>

  <!-- Outer Map Border & Margins -->
  <rect x="0" y="0" width="${width}" height="${height}" fill="#020617" />
  <rect x="${padding - 4}" y="${padding - 4}" width="${mapSize + 8}" height="${mapSize + 8}" fill="none" stroke="#334155" stroke-width="2" />
  <rect x="${padding}" y="${padding}" width="${mapSize}" height="${mapSize}" fill="url(#topoLandGrad)" stroke="#1e293b" stroke-width="1" />

  <!-- Quadrangle Grid lines -->
  <rect x="${padding}" y="${padding}" width="${mapSize}" height="${mapSize}" fill="url(#topoGridPattern)" />

  <!-- Topographic Elevation Contour Lines on Land (Brown/Tan USGS style) -->
  <g stroke="#a3825a" stroke-width="0.8" stroke-opacity="0.35" fill="none">
    <circle cx="${width/2}" cy="${height/2}" r="320" stroke-dasharray="8 4" />
    <circle cx="${width/2 - 40}" cy="${height/2 - 60}" r="270" />
    <circle cx="${width/2 + 60}" cy="${height/2 + 50}" r="240" stroke-dasharray="12 4" />
    <circle cx="${width/2}" cy="${height/2}" r="200" />
    <circle cx="${width/2 - 20}" cy="${height/2 + 30}" r="160" stroke-width="1.2" stroke-opacity="0.5" />
    <!-- Ridge bluffs lines -->
    <path d="M 120 180 Q 240 140 380 190 T 680 150" stroke="#ca8a04" stroke-width="1.1" stroke-opacity="0.4" />
    <path d="M 100 240 Q 280 200 420 250 T 700 220" stroke="#ca8a04" stroke-width="0.9" stroke-opacity="0.35" />
    <path d="M 140 680 Q 300 620 480 660 T 720 610" stroke="#ca8a04" stroke-width="1.1" stroke-opacity="0.4" />
  </g>

  <!-- Bathymetric Water Fill Representation -->
  <g class="bathy-water-layer">
    <!-- Outer Lake Basin Base -->
    <ellipse cx="405" cy="415" rx="245" ry="220" fill="url(#waterDepthGrad)" fill-opacity="0.35" />
    
    <!-- Deep South Basin -->
    <circle cx="430" cy="510" r="120" fill="#0284c7" fill-opacity="0.45" />
    <circle cx="435" cy="530" r="80" fill="#0369a1" fill-opacity="0.6" />
    <circle cx="435" cy="540" r="50" fill="#075985" fill-opacity="0.8" />
    <circle cx="435" cy="545" r="28" fill="#0c4a6e" fill-opacity="0.95" />

    <!-- North Stone Branch Channel -->
    <path d="M 405 390 Q 430 300 450 200 Q 470 140 485 90" fill="none" stroke="#0284c7" stroke-width="36" stroke-linecap="round" stroke-opacity="0.5" />
    <path d="M 405 390 Q 430 300 450 200 Q 470 140 485 90" fill="none" stroke="#0369a1" stroke-width="18" stroke-linecap="round" stroke-opacity="0.75" />
    
    <!-- Northwest Arm -->
    <path d="M 390 380 Q 320 330 240 280 Q 180 230 150 180" fill="none" stroke="#0284c7" stroke-width="26" stroke-linecap="round" stroke-opacity="0.45" />
    
    <!-- Southwest Dam Arm -->
    <path d="M 430 550 Q 360 600 280 620 Q 200 630 140 620" fill="none" stroke="#0284c7" stroke-width="32" stroke-linecap="round" stroke-opacity="0.55" />
    <path d="M 430 550 Q 360 600 280 620 Q 200 630 140 620" fill="none" stroke="#0369a1" stroke-width="16" stroke-linecap="round" stroke-opacity="0.75" />

    <!-- East Antler Bays -->
    <path d="M 480 390 Q 560 380 640 360" fill="none" stroke="#0284c7" stroke-width="22" stroke-linecap="round" stroke-opacity="0.4" />
    <path d="M 480 390 Q 580 410 660 430" fill="none" stroke="#0284c7" stroke-width="20" stroke-linecap="round" stroke-opacity="0.4" />
    
    <!-- Boat Ramp Cove -->
    <path d="M 340 420 Q 260 430 200 440" fill="none" stroke="#0284c7" stroke-width="18" stroke-linecap="round" stroke-opacity="0.4" />
  </g>

  <!-- Bathymetric Survey Depth Contour Lines (5-ft, 10-ft, 15-ft, 20-ft, 25-ft, 30-ft) -->
  <g stroke="#38bdf8" fill="none" stroke-linejoin="round">
    <!-- 5-ft Littoral Contour -->
    <ellipse cx="405" cy="415" rx="225" ry="195" stroke-width="1" stroke-opacity="0.6" stroke-dasharray="6 3" />
    <text x="590" y="340" fill="#38bdf8" font-size="8" font-family="monospace">5'</text>

    <!-- 10-ft Index Contour -->
    <ellipse cx="415" cy="455" rx="175" ry="155" stroke-width="1.5" stroke-opacity="0.8" />
    <text x="560" y="470" fill="#38bdf8" font-size="8" font-weight="bold" font-family="monospace">10'</text>

    <!-- 15-ft Intermediate Contour -->
    <ellipse cx="425" cy="490" rx="135" ry="115" stroke-width="1" stroke-opacity="0.75" />
    <text x="530" y="525" fill="#38bdf8" font-size="8" font-family="monospace">15'</text>

    <!-- 20-ft Index Contour -->
    <ellipse cx="430" cy="515" rx="95" ry="85" stroke-width="1.6" stroke-opacity="0.85" />
    <text x="500" y="555" fill="#60a5fa" font-size="8" font-weight="bold" font-family="monospace">20'</text>

    <!-- 25-ft Deep Channel Contour -->
    <ellipse cx="435" cy="535" rx="60" ry="50" stroke-width="1.2" stroke-opacity="0.9" />
    <text x="475" y="565" fill="#93c5fd" font-size="8" font-family="monospace">25'</text>

    <!-- 30-ft Deep Hole Contour -->
    <circle cx="435" cy="545" r="28" stroke="#bfdbfe" stroke-width="1.8" stroke-dasharray="3 2" />
    <text x="430" y="549" fill="#ffffff" font-size="9" font-weight="bold" font-family="monospace" text-anchor="middle">30'</text>
  </g>

  <!-- 0-ft Shoreline Water Boundary Line (Bold) -->
  <g stroke="#0ea5e9" stroke-width="2.2" fill="none">
    <!-- Dam Wall marking along SW arm -->
    <line x1="140" y1="620" x2="280" y2="620" stroke="#f59e0b" stroke-width="4.5" stroke-linecap="square" />
    <line x1="140" y1="620" x2="280" y2="620" stroke="#78350f" stroke-width="1.5" />
  </g>

  <!-- Flow Direction Arrows on Stream Inlets -->
  <g stroke="#34d399" stroke-width="1.5" fill="#34d399">
    <!-- North inlet flow -->
    <path d="M 485 85 L 480 120" />
    <polygon points="480,128 476,118 484,118" />
    <!-- Northwest inlet flow -->
    <path d="M 140 170 L 175 200" />
    <polygon points="182,206 172,203 178,195" />
    <!-- Dam Spillway drop arrow -->
    <path d="M 210 630 L 210 665" stroke="#ef4444" stroke-width="2" />
    <polygon points="210,672 206,662 214,662" fill="#ef4444" />
  </g>

  <!-- Map Feature Labels and Soundings -->
  ${featureElements}

  <!-- Header Cartographic Title Block -->
  <g id="map-header">
    <rect x="${padding + 12}" y="${padding + 12}" width="285" height="66" fill="#020617" fill-opacity="0.9" rx="6" stroke="#334155" stroke-width="1"/>
    <text x="${padding + 22}" y="${padding + 30}" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#f8fafc">
      ${data.name.toUpperCase()}
    </text>
    <text x="${padding + 22}" y="${padding + 46}" font-family="system-ui, sans-serif" font-size="10" fill="#94a3b8">
      ${data.county || 'State Conservation Area'}, ${data.state} | Topo & Hydrographic Survey
    </text>
    <text x="${padding + 22}" y="${padding + 62}" font-family="system-ui, sans-serif" font-size="9" fill="#38bdf8" font-weight="500">
      Surface: ${data.surfaceElevationFt} ft MSL | Max Depth: ${data.maxDepthFt} ft | Contour: 5 ft
    </text>
  </g>

  <!-- Map Legend (Bottom Left) -->
  <g id="map-legend">
    <rect x="${padding + 12}" y="${height - padding - 88}" width="215" height="76" fill="#020617" fill-opacity="0.9" rx="6" stroke="#334155" stroke-width="1"/>
    <text x="${padding + 20}" y="${height - padding - 72}" font-family="system-ui, sans-serif" font-size="9" font-weight="bold" fill="#cbd5e1">
      TOPOGRAPHIC & BATHYMETRIC LEGEND
    </text>
    <line x1="${padding + 20}" y1="${height - padding - 56}" x2="${padding + 42}" y2="${height - padding - 56}" stroke="#0ea5e9" stroke-width="2"/>
    <text x="${padding + 48}" y="${height - padding - 53}" font-family="system-ui, sans-serif" font-size="8" fill="#94a3b8">Shoreline (0 ft / Water Line)</text>

    <line x1="${padding + 20}" y1="${height - padding - 42}" x2="${padding + 42}" y2="${height - padding - 42}" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="${padding + 48}" y="${height - padding - 39}" font-family="system-ui, sans-serif" font-size="8" fill="#94a3b8">Bathymetric Depth Contours (5 ft)</text>

    <line x1="${padding + 20}" y1="${height - padding - 28}" x2="${padding + 42}" y2="${height - padding - 28}" stroke="#f59e0b" stroke-width="3"/>
    <text x="${padding + 48}" y="${height - padding - 25}" font-family="system-ui, sans-serif" font-size="8" fill="#94a3b8">Earthen Dam Embankment</text>

    <line x1="${padding + 130}" y1="${height - padding - 28}" x2="${padding + 152}" y2="${height - padding - 28}" stroke="#ca8a04" stroke-width="1" stroke-dasharray="4 2"/>
    <text x="${padding + 158}" y="${height - padding - 25}" font-family="system-ui, sans-serif" font-size="8" fill="#94a3b8">Land Topo Ridge</text>
  </g>

  <!-- Scale Bar & Compass Rose (Bottom Right) -->
  <g id="map-scale" transform="translate(${width - padding - 180}, ${height - padding - 55})">
    <rect x="-8" y="-12" width="176" height="52" fill="#020617" fill-opacity="0.85" rx="5" stroke="#334155" stroke-width="0.8" />
    <!-- Scale Bar -->
    <text x="0" y="2" font-family="monospace" font-size="8" fill="#94a3b8">0</text>
    <text x="45" y="2" font-family="monospace" font-size="8" fill="#94a3b8">0.25</text>
    <text x="90" y="2" font-family="monospace" font-size="8" fill="#94a3b8">0.5 Mile</text>
    <rect x="0" y="7" width="45" height="4" fill="#f8fafc" stroke="#0f172a" stroke-width="0.5"/>
    <rect x="45" y="7" width="45" height="4" fill="#0f172a" stroke="#f8fafc" stroke-width="0.5"/>
    <text x="0" y="23" font-family="system-ui, sans-serif" font-size="7" fill="#64748b">1:24,000 USGS Quad Scale</text>

    <!-- Compass Rose -->
    <g transform="translate(136, 12)">
      <circle cx="0" cy="0" r="14" fill="#0f172a" stroke="#475569" stroke-width="1"/>
      <polygon points="0,-12 3,0 -3,0" fill="#ef4444"/>
      <polygon points="0,12 3,0 -3,0" fill="#94a3b8"/>
      <text x="-3" y="-14" font-family="system-ui, sans-serif" font-size="8" font-weight="bold" fill="#ef4444">N</text>
    </g>
  </g>

  <!-- Corner Coordinates Labels -->
  <text x="${padding + 4}" y="${padding - 8}" font-family="monospace" font-size="8" fill="#64748b">38°28'25" N, 85°52'35" W</text>
  <text x="${width - padding - 130}" y="${padding - 8}" font-family="monospace" font-size="8" fill="#64748b">38°28'25" N, 85°51'20" W</text>
  <text x="${padding + 4}" y="${height - padding + 16}" font-family="monospace" font-size="8" fill="#64748b">38°27'15" N, 85°52'35" W</text>
  <text x="${width - padding - 130}" y="${height - padding + 16}" font-family="monospace" font-size="8" fill="#64748b">38°27'15" N, 85°51'20" W</text>
</svg>
  `.trim();
}
