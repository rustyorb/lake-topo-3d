/**
 * Laser-cut layer pack: every contour level as closed polygons in millimetres, tiled on one page,
 * for stacked wood or acrylic topo maps.
 *
 * The sheet for level L is the material left where the field (feet relative to the water surface)
 * is ≥ L. Water sheets (L ≤ 0) are the full rectangle with the deeper water cut out as holes;
 * land sheets (L > 0) are the hills themselves, cut as positive pieces. Stacked from the base up,
 * the lake reads as a stepped basin and the hills rise above the shoreline sheet.
 */
import { TerrainGridData } from '../types.js';
import { isolines, levelRange } from './contours.js';
import { dxfDocument, dxfPolyline, dxfText } from './dxf.js';

const FT_PER_M = 3.28084;
const PAD_VALUE = -1e9;

export type Ring = Array<[number, number]>;

export interface Layer {
  /** Stacking index from the bottom, 1-based. */
  index: number;
  levelFt: number;
  kind: 'base' | 'water' | 'land';
  name: string;
  /** Closed rings in page mm (x east, y south), without the repeated closing point. */
  rings: Ring[];
  /** Material left on the sheet inside the map area, mm². */
  areaMm2: number;
}

export interface LayerPackOptions {
  stepFt: number;
  widthMm: number;
  includeLand: boolean;
  marginMm?: number;
}

export interface LayerPack {
  layers: Layer[];
  mapWmm: number;
  mapHmm: number;
  sheetWmm: number;
  sheetHmm: number;
  marginMm: number;
  stepFt: number;
  /** Sheet thickness that would make the stack true to scale, mm. */
  trueThicknessMm: number;
  /** Isolines that failed to close (expected 0; the verify script checks it). */
  openDropped: number;
}

function absArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

function contains(ring: Ring, [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd area of a ring set: rings nested at even depth add, odd depth subtract. Ignores winding. */
function evenOddArea(rings: Ring[]): number {
  let total = 0;
  rings.forEach((r, i) => {
    let depth = 0;
    for (let j = 0; j < rings.length; j++) if (j !== i && contains(rings[j], r[0])) depth++;
    total += (depth % 2 === 0 ? 1 : -1) * absArea(r);
  });
  return total;
}

export function buildLayerPack(data: TerrainGridData, opts: LayerPackOptions): LayerPack {
  const n = data.gridSize;
  const margin = opts.marginMm ?? 10;
  const mapW = opts.widthMm;
  const mapH = opts.widthMm * ((data.physicalHeightKm || 1) / (data.physicalWidthKm || 1));
  const rel = data.elevations.map((row) => row.map((e) => (e - data.waterElevation) * FT_PER_M));
  // Pad the field with a very low border so every isoline closes inside the frame.
  const P = n + 2;
  const field = (r: number, c: number) => (r <= 0 || c <= 0 || r >= P - 1 || c >= P - 1 ? PAD_VALUE : rel[r - 1][c - 1]);
  const toMm = (x: number, y: number): [number, number] => [
    margin + (Math.max(0, Math.min(n - 1, x - 1)) / (n - 1)) * mapW,
    margin + (Math.max(0, Math.min(n - 1, y - 1)) / (n - 1)) * mapH,
  ];
  const onFrame = ([x, y]: [number, number]) =>
    Math.abs(x - margin) < 1e-6 || Math.abs(x - margin - mapW) < 1e-6 || Math.abs(y - margin) < 1e-6 || Math.abs(y - margin - mapH) < 1e-6;

  const step = Math.max(0.5, opts.stepFt);
  const maxDepthFt = data.maxDepth * FT_PER_M;
  const maxLandFt = (data.maxElevation - data.waterElevation) * FT_PER_M;
  const waterLevels = levelRange(step, maxDepthFt - 0.01, step).map((d) => -d).reverse();
  const landLevels = opts.includeLand ? levelRange(step, maxLandFt, step) : [];
  const levels = [...waterLevels, 0, ...landLevels];

  let openDropped = 0;
  const ringsAt = (L: number): Ring[] => {
    const out: Ring[] = [];
    for (const line of isolines(field, P, P, L)) {
      const first = line[0];
      const last = line[line.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6) { openDropped++; continue; }
      const ring: Ring = line.slice(0, -1).map(([x, y]) => toMm(x, y));
      if (ring.length >= 3) out.push(ring);
    }
    return out;
  };

  const mapArea = mapW * mapH;
  const layers: Layer[] = [
    { index: 1, levelFt: -Infinity, kind: 'base', name: '01_base', rings: [], areaMm2: mapArea },
  ];
  for (const L of levels) {
    const kind: Layer['kind'] = L > 0 ? 'land' : 'water';
    let rings = ringsAt(L);
    // A water sheet is the whole rectangle; the ring that merely traces the map edge is not a cut.
    if (kind === 'water') rings = rings.filter((r) => !r.every(onFrame));
    const net = evenOddArea(rings);
    const areaMm2 = kind === 'water' ? Math.max(0, mapArea - net) : net;
    const index = layers.length + 1;
    const name = `${String(index).padStart(2, '0')}_${L < 0 ? '-' : L > 0 ? '+' : ''}${Math.abs(L)}ft`;
    layers.push({ index, levelFt: L, kind, name, rings, areaMm2 });
  }

  const mmPerMetre = mapW / Math.max(50, (data.physicalWidthKm || 1) * 1000);
  return {
    layers,
    mapWmm: mapW,
    mapHmm: mapH,
    sheetWmm: mapW + margin * 2,
    sheetHmm: mapH + margin * 2,
    marginMm: margin,
    stepFt: step,
    trueThicknessMm: (step / FT_PER_M) * mmPerMetre,
    openDropped,
  };
}

/** Where each sheet sits on the tiled page, in mm. */
function tile(pack: LayerPack, gapMm = 6): { cols: number; rows: number; pageW: number; pageH: number; at: (i: number) => [number, number] } {
  const N = pack.layers.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
  const rows = Math.ceil(N / cols);
  return {
    cols,
    rows,
    pageW: cols * pack.sheetWmm + (cols - 1) * gapMm,
    pageH: rows * pack.sheetHmm + (rows - 1) * gapMm,
    at: (i) => [(i % cols) * (pack.sheetWmm + gapMm), Math.floor(i / cols) * (pack.sheetHmm + gapMm)],
  };
}

const REG_R = 1.5;
function registrationMarks(pack: LayerPack): Array<[number, number]> {
  const m = pack.marginMm / 2;
  return [[m, m], [pack.sheetWmm - m, m], [m, pack.sheetHmm - m], [pack.sheetWmm - m, pack.sheetHmm - m]];
}

function layerLabel(layer: Layer): string {
  if (layer.kind === 'base') return `${layer.name}  solid base`;
  if (layer.levelFt === 0) return `${layer.name}  shoreline`;
  return `${layer.name}  ${layer.kind === 'water' ? `${-layer.levelFt} ft deep` : `+${layer.levelFt} ft`}`;
}

/** One SVG page, 1 user unit = 1 mm. Black strokes cut, blue text engraves. */
export function layerPackSvg(pack: LayerPack, lakeName: string): string {
  const t = tile(pack);
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const out: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(t.pageW)}mm" height="${f(t.pageH)}mm" viewBox="0 0 ${f(t.pageW)} ${f(t.pageH)}">`,
    `  <title>${esc(lakeName)} laser-cut layer pack, ${pack.stepFt} ft steps, ${pack.layers.length} sheets</title>`,
  ];
  pack.layers.forEach((layer, i) => {
    const [ox, oy] = t.at(i);
    out.push(`  <g id="${esc(layer.name)}" transform="translate(${f(ox)} ${f(oy)})" fill="none" stroke="#000" stroke-width="0.15">`);
    if (layer.kind !== 'land') {
      out.push(`    <rect x="0" y="0" width="${f(pack.sheetWmm)}" height="${f(pack.sheetHmm)}"/>`);
      for (const [cx, cy] of registrationMarks(pack)) out.push(`    <circle cx="${f(cx)}" cy="${f(cy)}" r="${REG_R}"/>`);
    }
    if (layer.rings.length) {
      const d = layer.rings.map((r) => r.map(([x, y], k) => `${k ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ') + ' Z').join(' ');
      out.push(`    <path d="${d}" fill-rule="evenodd"/>`);
    }
    out.push(`    <text x="${f(pack.marginMm)}" y="${f(pack.sheetHmm - pack.marginMm / 2 + 1.2)}" font-family="sans-serif" font-size="3.4" fill="#0000ff" stroke="none">${esc(layerLabel(layer))}  ·  ${esc(lakeName)}</text>`);
    out.push(`  </g>`);
  });
  out.push(`</svg>`, '');
  return out.join('\n');
}

/** DXF R12 in mm, y up (north up). Each sheet's cuts are on their own layer; labels on LABELS. */
export function layerPackDxf(pack: LayerPack, lakeName: string): string {
  const t = tile(pack);
  const entities: string[] = [];
  const flipY = (y: number) => t.pageH - y;
  pack.layers.forEach((layer, i) => {
    const [ox, oy] = t.at(i);
    const P = (x: number, y: number): [number, number] => [ox + x, flipY(oy + y)];
    if (layer.kind !== 'land') {
      entities.push(dxfPolyline(layer.name, [P(0, 0), P(pack.sheetWmm, 0), P(pack.sheetWmm, pack.sheetHmm), P(0, pack.sheetHmm)], true));
      for (const [cx, cy] of registrationMarks(pack)) {
        const circle: Array<[number, number]> = [];
        for (let k = 0; k < 24; k++) circle.push(P(cx + REG_R * Math.cos((k / 24) * 2 * Math.PI), cy + REG_R * Math.sin((k / 24) * 2 * Math.PI)));
        entities.push(dxfPolyline(layer.name, circle, true));
      }
    }
    for (const r of layer.rings) entities.push(dxfPolyline(layer.name, r.map(([x, y]) => P(x, y)), true));
    const [tx, ty] = P(pack.marginMm, pack.sheetHmm - pack.marginMm / 2 + 1.2);
    entities.push(dxfText('LABELS', tx, ty, 3, `${layerLabel(layer)} - ${lakeName}`));
  });
  return dxfDocument(entities);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
