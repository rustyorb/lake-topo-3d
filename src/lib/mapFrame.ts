/**
 * Layout of the server-rendered SVG topo map, shared with the browser so that
 * overlays (waypoints, structure markers, cursor readout) land on the right
 * pixel. Keep in sync with `server/topoMapGenerator.ts`, which imports this.
 */

export const SVG_MAP_SIZE = 800;
export const SVG_MAP_PAD = 52;

export interface SvgMapFrame {
  W: number;
  H: number;
  pad: number;
  inner: number;
  mapX: number;
  mapY: number;
  mapW: number;
  mapH: number;
}

/** Map box inside the SVG page, with the true physical aspect of the frame. */
export function svgMapFrame(physicalWidthKm: number, physicalHeightKm: number): SvgMapFrame {
  const W = SVG_MAP_SIZE;
  const H = SVG_MAP_SIZE;
  const pad = SVG_MAP_PAD;
  const inner = W - pad * 2;
  const aspect = (physicalHeightKm || 1) / (physicalWidthKm || 1);
  const mapW = aspect <= 1 ? inner : inner / aspect;
  const mapH = aspect <= 1 ? inner * aspect : inner;
  const mapX = pad + (inner - mapW) / 2;
  const mapY = pad + (inner - mapH) / 2;
  return { W, H, pad, inner, mapX, mapY, mapW, mapH };
}

/** Grid (col,row) → SVG page pixel. */
export function gridToSvg(frame: SvgMapFrame, gridSize: number, col: number, row: number): { x: number; y: number } {
  return {
    x: frame.mapX + (col / (gridSize - 1)) * frame.mapW,
    y: frame.mapY + (row / (gridSize - 1)) * frame.mapH,
  };
}

/** SVG page pixel → fractional grid (col,row); null when outside the map box. */
export function svgToGrid(frame: SvgMapFrame, gridSize: number, x: number, y: number): { col: number; row: number } | null {
  const u = (x - frame.mapX) / frame.mapW;
  const v = (y - frame.mapY) / frame.mapH;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { col: u * (gridSize - 1), row: v * (gridSize - 1) };
}
