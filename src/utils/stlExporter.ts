import { STLOptions, TerrainGridData } from '../types.js';

export interface Point3D { x: number; y: number; z: number }
export interface Triangle { v1: Point3D; v2: Point3D; v3: Point3D }

export interface MeshStats {
  triangleCount: number;
  widthMm: number;
  lengthMm: number;
  heightMm: number;      // total model height including base
  reliefMm: number;      // terrain relief only (highest ridge to lowest lakebed)
  minZ: number;
  maxZ: number;
  mmPerMetreHorizontal: number;
  mmPerMetreVertical: number;
}

function sub(a: Point3D, b: Point3D): Point3D {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross(a: Point3D, b: Point3D): Point3D {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a: Point3D, b: Point3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function computeNormal(p1: Point3D, p2: Point3D, p3: Point3D): Point3D {
  const n = cross(sub(p2, p1), sub(p3, p1));
  const len = Math.hypot(n.x, n.y, n.z);
  if (len === 0) return { x: 0, y: 0, z: 1 };
  return { x: n.x / len, y: n.y / len, z: n.z / len };
}

/** Horizontal scale of the print: how many mm on the bed per metre of real ground. */
export function horizontalMmPerMetre(data: TerrainGridData, targetWidthMm: number): number {
  const widthM = Math.max(50, (data.physicalWidthKm || 1) * 1000);
  return targetWidthMm / widthM;
}

/**
 * Suggests a vertical exaggeration that gives the print a pleasing amount of relief
 * (roughly `targetReliefFraction` of the bed width). Midwestern lakes are subtle at 1x.
 */
export function suggestExaggeration(data: TerrainGridData, targetWidthMm: number, targetReliefFraction = 0.14): number {
  const span = Math.max(0.5, data.maxElevation - data.minElevation);
  const trueReliefMm = span * horizontalMmPerMetre(data, targetWidthMm);
  const want = targetWidthMm * targetReliefFraction;
  return Math.round(Math.max(1, Math.min(25, want / trueReliefMm)) * 10) / 10;
}

/**
 * Builds a watertight solid from the terrain grid: heightfield top, flat bottom plate and 4 walls.
 *
 * Coordinate frame (slicer-friendly, Z-up, north-up):
 *   +X = east, +Y = north, +Z = up.  Row 0 of the grid is the north edge, so it maps to y = length.
 *   Vertical scale is TRUE scale × verticalExaggeration (1.0x means the same mm/m as the horizontal axes).
 */
export function generateWatertightSTLMesh(
  data: TerrainGridData,
  options: STLOptions
): { triangles: Triangle[]; stats: MeshStats } {
  const { gridSize, elevations, minElevation } = data;
  const { baseThicknessMm, targetWidthMm, verticalExaggeration, includeWaterCap } = options;

  const aspect = (data.physicalHeightKm || 1) / (data.physicalWidthKm || 1);
  const targetLengthMm = targetWidthMm * aspect;

  const mmPerMetreH = horizontalMmPerMetre(data, targetWidthMm);
  const mmPerMetreV = mmPerMetreH * Math.max(0.1, verticalExaggeration);

  const triangles: Triangle[] = [];
  const topVerts: Point3D[][] = [];
  const bottomVerts: Point3D[][] = [];

  let lowestTopZ = Infinity;
  let highestTopZ = -Infinity;

  for (let r = 0; r < gridSize; r++) {
    topVerts[r] = [];
    bottomVerts[r] = [];
    const yMm = (1 - r / (gridSize - 1)) * targetLengthMm; // north (row 0) at +Y
    for (let c = 0; c < gridSize; c++) {
      const xMm = (c / (gridSize - 1)) * targetWidthMm;
      let elevM = elevations[r][c];
      if (includeWaterCap && data.waterMask[r][c]) elevM = Math.max(elevM, data.waterElevation);
      let reliefM = elevM - minElevation;
      if (options.terraceContours) {
        const stepM = (options.terraceStepFt || 5) * 0.3048;
        reliefM = Math.floor(reliefM / stepM) * stepM;
      }
      const zMm = baseThicknessMm + reliefM * mmPerMetreV;
      lowestTopZ = Math.min(lowestTopZ, zMm);
      highestTopZ = Math.max(highestTopZ, zMm);
      topVerts[r][c] = { x: xMm, y: yMm, z: zMm };
      bottomVerts[r][c] = { x: xMm, y: yMm, z: 0 };
    }
  }

  // Push a triangle, flipping its winding if its normal points against `outward`.
  const pushTri = (a: Point3D, b: Point3D, c: Point3D, outward: Point3D) => {
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, outward) < 0) triangles.push({ v1: a, v2: c, v3: b });
    else triangles.push({ v1: a, v2: b, v3: c });
  };

  const UP = { x: 0, y: 0, z: 1 };
  const DOWN = { x: 0, y: 0, z: -1 };

  // 1. Top heightfield (normals up) and 2. bottom plate (normals down)
  for (let r = 0; r < gridSize - 1; r++) {
    for (let c = 0; c < gridSize - 1; c++) {
      const t00 = topVerts[r][c], t01 = topVerts[r][c + 1], t10 = topVerts[r + 1][c], t11 = topVerts[r + 1][c + 1];
      pushTri(t00, t10, t11, UP);
      pushTri(t00, t11, t01, UP);
      const b00 = bottomVerts[r][c], b01 = bottomVerts[r][c + 1], b10 = bottomVerts[r + 1][c], b11 = bottomVerts[r + 1][c + 1];
      pushTri(b00, b10, b11, DOWN);
      pushTri(b00, b11, b01, DOWN);
    }
  }

  // 3. Walls. Each wall quad shares its top edge with the heightfield and its bottom edge with the plate.
  const lastR = gridSize - 1;
  const lastC = gridSize - 1;
  const NORTH = { x: 0, y: 1, z: 0 }, SOUTH = { x: 0, y: -1, z: 0 }, EAST = { x: 1, y: 0, z: 0 }, WEST = { x: -1, y: 0, z: 0 };
  for (let c = 0; c < gridSize - 1; c++) {
    // North wall (row 0)
    pushTri(topVerts[0][c], topVerts[0][c + 1], bottomVerts[0][c + 1], NORTH);
    pushTri(topVerts[0][c], bottomVerts[0][c + 1], bottomVerts[0][c], NORTH);
    // South wall (last row)
    pushTri(topVerts[lastR][c], topVerts[lastR][c + 1], bottomVerts[lastR][c + 1], SOUTH);
    pushTri(topVerts[lastR][c], bottomVerts[lastR][c + 1], bottomVerts[lastR][c], SOUTH);
  }
  for (let r = 0; r < gridSize - 1; r++) {
    // West wall (col 0)
    pushTri(topVerts[r][0], topVerts[r + 1][0], bottomVerts[r + 1][0], WEST);
    pushTri(topVerts[r][0], bottomVerts[r + 1][0], bottomVerts[r][0], WEST);
    // East wall (last col)
    pushTri(topVerts[r][lastC], topVerts[r + 1][lastC], bottomVerts[r + 1][lastC], EAST);
    pushTri(topVerts[r][lastC], bottomVerts[r + 1][lastC], bottomVerts[r][lastC], EAST);
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    triangles,
    stats: {
      triangleCount: triangles.length,
      widthMm: round1(targetWidthMm),
      lengthMm: round1(targetLengthMm),
      heightMm: round1(highestTopZ),
      reliefMm: round1(highestTopZ - lowestTopZ),
      minZ: 0,
      maxZ: round1(highestTopZ),
      mmPerMetreHorizontal: mmPerMetreH,
      mmPerMetreVertical: mmPerMetreV,
    },
  };
}

/** Encodes triangles as binary STL (little-endian, 80-byte header). */
export function exportToBinarySTL(triangles: Triangle[], lakeName: string): Blob {
  return new Blob([encodeBinarySTL(triangles, lakeName)], { type: 'model/stl' });
}

export function encodeBinarySTL(triangles: Triangle[], lakeName: string): ArrayBuffer {
  const triangleCount = triangles.length;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = `lake-topo-3d: ${lakeName}`.slice(0, 79);
  for (let i = 0; i < 80; i++) view.setUint8(i, i < header.length ? header.charCodeAt(i) & 0x7f : 0x20);
  view.setUint32(80, triangleCount, true);
  let off = 84;
  for (const tri of triangles) {
    const n = computeNormal(tri.v1, tri.v2, tri.v3);
    const vals = [n.x, n.y, n.z, tri.v1.x, tri.v1.y, tri.v1.z, tri.v2.x, tri.v2.y, tri.v2.z, tri.v3.x, tri.v3.y, tri.v3.z];
    for (let i = 0; i < 12; i++) view.setFloat32(off + i * 4, vals[i], true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return buffer;
}

export function exportToAsciiSTL(triangles: Triangle[], lakeName: string): Blob {
  return new Blob([encodeAsciiSTL(triangles, lakeName)], { type: 'text/plain' });
}

export function encodeAsciiSTL(triangles: Triangle[], lakeName: string): string {
  const safeName = lakeName.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = [`solid ${safeName}`];
  for (const tri of triangles) {
    const n = computeNormal(tri.v1, tri.v2, tri.v3);
    lines.push(`  facet normal ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}`);
    lines.push('    outer loop');
    for (const v of [tri.v1, tri.v2, tri.v3]) lines.push(`      vertex ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${safeName}`);
  return lines.join('\n');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
