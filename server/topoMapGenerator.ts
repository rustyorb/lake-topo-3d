import { TerrainGridData, TopoFeature } from '../src/types.js';
import { fieldFrom2D, isolines, levelRange, Polyline } from '../src/lib/contours.js';
import { formatDms } from './geoData.js';
import { pngDataUri } from './png.js';

const FT_PER_M = 3.28084;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function ramp(stops: Array<[number, string]>, t: number): [number, number, number] {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return lerpRgb(hexToRgb(c0), hexToRgb(c1), (t - t0) / Math.max(1e-9, t1 - t0));
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// Paper-map palettes
const LAND_RAMP: Array<[number, string]> = [
  [0, '#e9f0d6'],
  [0.25, '#d9dfb6'],
  [0.5, '#d2c48f'],
  [0.75, '#b89a6b'],
  [1, '#8f6c4d'],
];
const WATER_RAMP: Array<[number, string]> = [
  [0, '#cfe9f7'],
  [0.2, '#9fd0ee'],
  [0.5, '#5aa7d9'],
  [0.8, '#2f6fae'],
  [1, '#1c3f6e'],
];

/** Picks a scale bar length that fits 60–220 px. */
function pickScaleBar(pxPerMetre: number): { label: string; px: number } {
  const options: Array<[number, string]> = [
    [100, '100 m'], [250, '250 m'], [402, '¼ mile'], [804, '½ mile'], [1609, '1 mile'], [3219, '2 miles'], [8047, '5 miles'], [16093, '10 miles'], [32187, '20 miles'],
  ];
  let best = options[0];
  for (const o of options) {
    const px = o[0] * pxPerMetre;
    if (px >= 60 && px <= 220) { best = o; break; }
    if (px < 60) best = o;
  }
  return { label: best[1], px: best[0] * pxPerMetre };
}

/**
 * Renders a vector topographic + bathymetric map from the terrain grid.
 * Everything drawn comes from the grid: hypsometric raster, marching-squares contours,
 * shoreline, computed feature markers, real bounds, real scale.
 */
export function generateSvgTopoMap(data: TerrainGridData): string {
  const { metadata, gridSize: n, elevations, waterMask, depths, waterElevation } = data;
  const W = 800;
  const H = 800;
  const pad = 52;
  const inner = W - pad * 2;

  // Map box with true physical aspect
  const aspect = (data.physicalHeightKm || 1) / (data.physicalWidthKm || 1);
  const mapW = aspect <= 1 ? inner : inner / aspect;
  const mapH = aspect <= 1 ? inner * aspect : inner;
  const mapX = pad + (inner - mapW) / 2;
  const mapY = pad + (inner - mapH) / 2;
  const gx = (col: number) => mapX + (col / (n - 1)) * mapW;
  const gy = (row: number) => mapY + (row / (n - 1)) * mapH;
  const toPixel = (normX: number, normY: number) => ({ x: mapX + ((normX + 1) / 2) * mapW, y: mapY + ((normY + 1) / 2) * mapH });

  // ---- raster underlay
  const landSpan = Math.max(0.5, data.maxElevation - waterElevation);
  const maxDepth = Math.max(0.1, data.maxDepth);
  const rgb = new Uint8Array(n * n * 3);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const col = waterMask[r][c]
        ? ramp(WATER_RAMP, depths[r][c] / maxDepth)
        : ramp(LAND_RAMP, (elevations[r][c] - waterElevation) / landSpan);
      const i = (r * n + c) * 3;
      rgb[i] = Math.round(col[0]);
      rgb[i + 1] = Math.round(col[1]);
      rgb[i + 2] = Math.round(col[2]);
    }
  }
  const raster = pngDataUri(n, n, rgb);

  // ---- contours (feet relative to the water surface: negative = depth)
  const relFt: number[][] = elevations.map((row) => row.map((e) => (e - waterElevation) * FT_PER_M));
  const field = fieldFrom2D(relFt);
  const bathyInt = metadata.contourIntervalFt || 5;
  const maxLandFt = (data.maxElevation - waterElevation) * FT_PER_M;
  const landInt = maxLandFt > 600 ? 40 : maxLandFt > 250 ? 20 : 10;
  const maxDepthFt = maxDepth * FT_PER_M;

  const pathFor = (lines: Polyline[]) =>
    lines
      .filter((l) => l.length > 1)
      .map((l) => 'M' + l.map(([x, y]) => `${gx(x).toFixed(1)} ${gy(y).toFixed(1)}`).join(' L '))
      .join(' ');

  const lineLengthPx = (l: Polyline) => {
    let len = 0;
    for (let i = 1; i < l.length; i++) len += Math.hypot(gx(l[i][0]) - gx(l[i - 1][0]), gy(l[i][1]) - gy(l[i - 1][1]));
    return len;
  };

  const labelFor = (lines: Polyline[], text: string, fill: string, minLen = 70): string => {
    let best: Polyline | null = null;
    let bestLen = 0;
    for (const l of lines) {
      const len = lineLengthPx(l);
      if (len > bestLen) { bestLen = len; best = l; }
    }
    if (!best || bestLen < minLen) return '';
    const mid = best[Math.floor(best.length / 2)];
    const prev = best[Math.max(0, Math.floor(best.length / 2) - 2)];
    let angle = (Math.atan2(gy(mid[1]) - gy(prev[1]), gx(mid[0]) - gx(prev[0])) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return `<text x="${gx(mid[0]).toFixed(1)}" y="${gy(mid[1]).toFixed(1)}" transform="rotate(${angle.toFixed(0)} ${gx(mid[0]).toFixed(1)} ${gy(mid[1]).toFixed(1)})" font-family="ui-monospace, monospace" font-size="8.5" font-weight="600" fill="${fill}" text-anchor="middle" dominant-baseline="middle" paint-order="stroke" stroke="#f7f3ea" stroke-width="3" stroke-linejoin="round">${text}</text>`;
  };

  const landPaths: string[] = [];
  const landLabels: string[] = [];
  for (const lvl of levelRange(landInt, maxLandFt, landInt)) {
    const lines = isolines(field, n, n, lvl);
    if (!lines.length) continue;
    const isIndex = Math.round(lvl / landInt) % 5 === 0;
    landPaths.push(`<path d="${pathFor(lines)}" stroke="#9a6b3c" stroke-width="${isIndex ? 1.3 : 0.6}" stroke-opacity="${isIndex ? 0.95 : 0.7}" fill="none"/>`);
    if (isIndex) landLabels.push(labelFor(lines, `${Math.round(metadata.surfaceElevationFt + lvl)} ft`, '#6b4423'));
  }

  const bathyPaths: string[] = [];
  const bathyLabels: string[] = [];
  for (const d of levelRange(bathyInt, maxDepthFt, bathyInt)) {
    const lines = isolines(field, n, n, -d);
    if (!lines.length) continue;
    const isIndex = Math.round(d / bathyInt) % 2 === 0;
    bathyPaths.push(`<path d="${pathFor(lines)}" stroke="#1d4ed8" stroke-width="${isIndex ? 1.2 : 0.7}" stroke-opacity="${isIndex ? 0.9 : 0.7}" fill="none"/>`);
    bathyLabels.push(labelFor(lines, `${d}'`, '#1e3a8a', isIndex ? 50 : 90));
  }

  const shoreline = isolines(field, n, n, 0.01);
  const shorePath = `<path d="${pathFor(shoreline)}" stroke="#0c4a6e" stroke-width="1.8" fill="none" stroke-linejoin="round"/>`;

  // ---- feature markers
  const features: TopoFeature[] = (metadata.topoFeatures || []).filter((f) => Number.isFinite(f.normX) && Number.isFinite(f.normY));
  const featureElements = features
    .map((f, idx) => {
      const pt = toPixel(f.normX, f.normY);
      let icon = '';
      let color = '#0369a1';
      let text = f.label;
      if (f.depthOrElevFt !== undefined) {
        text += f.type === 'deep_hole' || f.type === 'cove' || f.type === 'inlet' || f.type === 'boat_ramp' ? ` (${f.depthOrElevFt} ft)` : ` (${f.depthOrElevFt} ft el.)`;
      }
      switch (f.type) {
        case 'dam':
          color = '#b45309';
          icon = `<rect x="${pt.x - 8}" y="${pt.y - 4}" width="16" height="8" fill="${color}" stroke="#1e293b" stroke-width="1.2" rx="1.5"/>`;
          break;
        case 'deep_hole':
          color = '#1e3a8a';
          icon = `<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="none" stroke="${color}" stroke-width="2"/><line x1="${pt.x - 8}" y1="${pt.y}" x2="${pt.x + 8}" y2="${pt.y}" stroke="${color}" stroke-width="1.3"/><line x1="${pt.x}" y1="${pt.y - 8}" x2="${pt.x}" y2="${pt.y + 8}" stroke="${color}" stroke-width="1.3"/>`;
          break;
        case 'inlet':
          color = '#047857';
          icon = `<polygon points="${pt.x},${pt.y - 7} ${pt.x + 6},${pt.y + 5} ${pt.x - 6},${pt.y + 5}" fill="${color}" stroke="#022c22" stroke-width="1.2"/>`;
          break;
        case 'boat_ramp':
          color = '#0e7490';
          icon = `<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="${color}" stroke="#083344" stroke-width="1.2"/>`;
          break;
        case 'ridge':
          color = '#7c2d12';
          icon = `<polygon points="${pt.x},${pt.y - 7} ${pt.x + 7},${pt.y + 6} ${pt.x - 7},${pt.y + 6}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
          break;
        default:
          color = '#6d28d9';
          icon = `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="${color}"/>`;
      }
      const anchorEnd = pt.x > W / 2;
      const dx = anchorEnd ? -12 : 12;
      const dy = idx % 2 === 0 ? -6 : 12; // stagger neighbouring labels so they don't overprint
      return `<g id="topo-feature-${idx}">${icon}<text x="${(pt.x + dx).toFixed(1)}" y="${(pt.y + dy).toFixed(1)}" font-family="system-ui, sans-serif" font-size="9" font-weight="600" fill="${color}" text-anchor="${anchorEnd ? 'end' : 'start'}" paint-order="stroke" stroke="#f7f3ea" stroke-width="3" stroke-linejoin="round">${esc(text)}</text></g>`;
    })
    .join('\n');

  // ---- scale bar, coordinates, attribution
  const widthM = Math.max(1, (data.physicalWidthKm || 1) * 1000);
  const scale = pickScaleBar(mapW / widthM);
  const b = metadata.bounds;
  const demLabel = metadata.demSource === '3dep' ? 'Elevation: USGS 3DEP LiDAR DEM' : 'Elevation: Terrarium tiles (Mapzen / AWS Open Data)';
  const geometryLabel =
    metadata.geometrySource === 'osm-dem'
      ? `Shoreline © OpenStreetMap contributors (ODbL)${metadata.bathymetrySource === 'idnr-sonar' ? ' · Bathymetry: Indiana DNR Division of Fish & Wildlife' : ''} · ${demLabel}`
      : metadata.geometrySource === 'curated-sdf'
      ? 'Hand-built survey approximation (offline model)'
      : 'Procedural placeholder geometry — no survey data';
  const depthLabel =
    metadata.bathymetrySource === 'idnr-sonar'
      ? `Depths: IDNR sonar survey${metadata.surveyDate ? ` ${metadata.surveyDate}` : ''}, ${metadata.contourIntervalFt || 5} ft contours, interpolated`
      : metadata.depthIsEstimated
      ? 'Depths: estimated (distance-to-shore model)'
      : `Max depth ${metadata.maxDepthFt} ft on record (${metadata.generationMethod === 'wikipedia' ? 'Wikipedia' : metadata.generationMethod === 'curated-survey' ? 'survey record' : 'LLM recon'}); contour shape modelled`;

  const title = esc(metadata.name.toUpperCase());
  const subtitle = esc([metadata.county, metadata.state].filter(Boolean).join(', '));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#f7f3ea"/>
  <rect x="${pad - 6}" y="${pad - 6}" width="${inner + 12}" height="${inner + 12}" fill="none" stroke="#3f3a32" stroke-width="1.5"/>
  <clipPath id="mapClip"><rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}"/></clipPath>
  <g clip-path="url(#mapClip)">
    <image href="${raster}" x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" preserveAspectRatio="none" style="image-rendering:auto"/>
    <g id="land-contours">${landPaths.join('')}</g>
    <g id="bathy-contours">${bathyPaths.join('')}</g>
    ${shorePath}
    <g id="contour-labels">${landLabels.join('')}${bathyLabels.join('')}</g>
    <g id="features">${featureElements}</g>
  </g>
  <rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" fill="none" stroke="#3f3a32" stroke-width="1"/>

  <g id="title-block">
    <rect x="${pad + 8}" y="${pad + 8}" width="300" height="64" fill="#f7f3ea" fill-opacity="0.92" stroke="#3f3a32" stroke-width="0.8"/>
    <text x="${pad + 18}" y="${pad + 28}" font-family="Georgia, serif" font-size="15" font-weight="bold" fill="#1f1b16">${title}</text>
    <text x="${pad + 18}" y="${pad + 44}" font-family="system-ui, sans-serif" font-size="9.5" fill="#3f3a32">${subtitle} · Topographic &amp; bathymetric map</text>
    <text x="${pad + 18}" y="${pad + 60}" font-family="ui-monospace, monospace" font-size="8.5" fill="#1e3a8a">Pool ${metadata.surfaceElevationFt} ft · Max depth ${metadata.maxDepthFt} ft · Land ${landInt} ft / water ${bathyInt} ft contours</text>
  </g>

  <g id="legend">
    <rect x="${pad + 8}" y="${H - pad - 96}" width="232" height="88" fill="#f7f3ea" fill-opacity="0.92" stroke="#3f3a32" stroke-width="0.8"/>
    <text x="${pad + 16}" y="${H - pad - 80}" font-family="system-ui, sans-serif" font-size="9" font-weight="bold" fill="#1f1b16">LEGEND</text>
    <line x1="${pad + 16}" y1="${H - pad - 66}" x2="${pad + 40}" y2="${H - pad - 66}" stroke="#0c4a6e" stroke-width="1.8"/>
    <text x="${pad + 46}" y="${H - pad - 63}" font-family="system-ui, sans-serif" font-size="8" fill="#3f3a32">Shoreline (normal pool)</text>
    <line x1="${pad + 16}" y1="${H - pad - 52}" x2="${pad + 40}" y2="${H - pad - 52}" stroke="#1d4ed8" stroke-width="1"/>
    <text x="${pad + 46}" y="${H - pad - 49}" font-family="system-ui, sans-serif" font-size="8" fill="#3f3a32">Depth contours, ${bathyInt} ft (index every ${bathyInt * 2} ft)</text>
    <line x1="${pad + 16}" y1="${H - pad - 38}" x2="${pad + 40}" y2="${H - pad - 38}" stroke="#9a6b3c" stroke-width="1"/>
    <text x="${pad + 46}" y="${H - pad - 35}" font-family="system-ui, sans-serif" font-size="8" fill="#3f3a32">Land contours, ${landInt} ft (index every ${landInt * 5} ft)</text>
    <text x="${pad + 16}" y="${H - pad - 20}" font-family="system-ui, sans-serif" font-size="7.5" fill="#6b4423">${esc(depthLabel)}</text>
  </g>

  <g id="scale" transform="translate(${W - pad - 200}, ${H - pad - 58})">
    <rect x="-8" y="-14" width="200" height="54" fill="#f7f3ea" fill-opacity="0.92" stroke="#3f3a32" stroke-width="0.8"/>
    <rect x="0" y="0" width="${(scale.px / 2).toFixed(1)}" height="5" fill="#1f1b16"/>
    <rect x="${(scale.px / 2).toFixed(1)}" y="0" width="${(scale.px / 2).toFixed(1)}" height="5" fill="#f7f3ea" stroke="#1f1b16" stroke-width="0.6"/>
    <text x="0" y="-3" font-family="ui-monospace, monospace" font-size="8" fill="#1f1b16">0</text>
    <text x="${scale.px.toFixed(1)}" y="-3" font-family="ui-monospace, monospace" font-size="8" fill="#1f1b16" text-anchor="end">${scale.label}</text>
    <text x="0" y="18" font-family="system-ui, sans-serif" font-size="7.5" fill="#3f3a32">Frame ${(data.physicalWidthKm || 0).toFixed(2)} × ${(data.physicalHeightKm || 0).toFixed(2)} km · grid ${n}×${n}</text>
    <text x="0" y="30" font-family="system-ui, sans-serif" font-size="7.5" fill="#3f3a32">Area ${metadata.areaAcres.toLocaleString()} ac · shoreline ${metadata.perimeterKm} km</text>
    <g transform="translate(172, 10)">
      <circle cx="0" cy="0" r="12" fill="#f7f3ea" stroke="#3f3a32" stroke-width="0.8"/>
      <polygon points="0,-10 3,0 -3,0" fill="#b91c1c"/>
      <polygon points="0,10 3,0 -3,0" fill="#3f3a32"/>
      <text x="0" y="-13" font-family="system-ui, sans-serif" font-size="7" font-weight="bold" fill="#b91c1c" text-anchor="middle">N</text>
    </g>
  </g>

  <text x="${pad}" y="${pad - 12}" font-family="ui-monospace, monospace" font-size="8" fill="#3f3a32">${formatDms(b.maxLat, true)}, ${formatDms(b.minLon, false)}</text>
  <text x="${W - pad}" y="${pad - 12}" font-family="ui-monospace, monospace" font-size="8" fill="#3f3a32" text-anchor="end">${formatDms(b.maxLat, true)}, ${formatDms(b.maxLon, false)}</text>
  <text x="${pad}" y="${H - pad + 18}" font-family="ui-monospace, monospace" font-size="8" fill="#3f3a32">${formatDms(b.minLat, true)}, ${formatDms(b.minLon, false)}</text>
  <text x="${W - pad}" y="${H - pad + 18}" font-family="ui-monospace, monospace" font-size="8" fill="#3f3a32" text-anchor="end">${formatDms(b.minLat, true)}, ${formatDms(b.maxLon, false)}</text>
  <text x="${W / 2}" y="${H - 14}" font-family="system-ui, sans-serif" font-size="7.5" fill="#6b6459" text-anchor="middle">${esc(geometryLabel)}</text>
</svg>`;
}
