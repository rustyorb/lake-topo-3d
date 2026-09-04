import { STLOptions, TerrainGridData } from '../types.js';

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface Triangle {
  v1: Point3D;
  v2: Point3D;
  v3: Point3D;
}

// Compute normal of triangle with right-hand rule
function computeNormal(p1: Point3D, p2: Point3D, p3: Point3D): Point3D {
  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;
  const az = p2.z - p1.z;

  const bx = p3.x - p1.x;
  const by = p3.y - p1.y;
  const bz = p3.z - p1.z;

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Builds a watertight solid 3D mesh from the topographic grid
 * including top terrain/bathymetry, bottom flat base plate, and 4 vertical border walls.
 */
export function generateWatertightSTLMesh(
  data: TerrainGridData,
  options: STLOptions
): { triangles: Triangle[]; stats: { triangleCount: number; widthMm: number; lengthMm: number; heightMm: number; minZ: number; maxZ: number } } {
  const { gridSize, elevations, minElevation, maxElevation } = data;
  const { baseThicknessMm, targetWidthMm, verticalExaggeration, includeWaterCap } = options;

  // Aspect ratio of physical lake bounds
  const aspect = (data.physicalHeightKm || 1) / (data.physicalWidthKm || 1);
  const targetLengthMm = targetWidthMm * aspect;

  // Elevation range
  const elevationSpan = Math.max(1, maxElevation - minElevation);
  // Scale Z so that terrain relief is proportionally aesthetic and printable
  // Average Midwestern relief spans 15-60m; a standard 120mm model with 2x exaggeration gets ~15-30mm relief
  const zScaleMmPerMeter = (targetWidthMm / 800) * verticalExaggeration;

  const triangles: Triangle[] = [];

  // 3D coordinates array for top vertices [row][col]
  const topVerts: Point3D[][] = [];
  const bottomVerts: Point3D[][] = [];

  const baseZMm = 0; // Flat bottom at Z = 0
  let lowestTopZMm = Infinity;
  let highestTopZMm = -Infinity;

  for (let r = 0; r < gridSize; r++) {
    topVerts[r] = [];
    bottomVerts[r] = [];

    // Y coordinate in mm (0 to targetLengthMm)
    const yMm = (r / (gridSize - 1)) * targetLengthMm;

    for (let c = 0; c < gridSize; c++) {
      // X coordinate in mm (0 to targetWidthMm)
      const xMm = (c / (gridSize - 1)) * targetWidthMm;

      let elevM = elevations[r][c];
      if (includeWaterCap && data.waterMask[r][c]) {
        elevM = Math.max(elevM, data.waterElevation);
      }

      // Height above minimum elevation, scaled, plus the base pedestal thickness
      let reliefM = elevM - minElevation;
      if (options.terraceContours) {
        const stepM = (options.terraceStepFt || 5) * 0.3048;
        reliefM = Math.floor(reliefM / stepM) * stepM;
      }
      const zMm = baseThicknessMm + reliefM * zScaleMmPerMeter;

      if (zMm < lowestTopZMm) lowestTopZMm = zMm;
      if (zMm > highestTopZMm) highestTopZMm = zMm;

      topVerts[r][c] = { x: xMm, y: yMm, z: zMm };
      bottomVerts[r][c] = { x: xMm, y: yMm, z: baseZMm };
    }
  }

  // 1. TOP SURFACE TRIANGLES (Facing UP)
  for (let r = 0; r < gridSize - 1; r++) {
    for (let c = 0; c < gridSize - 1; c++) {
      const p00 = topVerts[r][c];
      const p10 = topVerts[r + 1][c];
      const p01 = topVerts[r][c + 1];
      const p11 = topVerts[r + 1][c + 1];

      // Quad split into two triangles: CCW order for upward normals
      triangles.push({ v1: p00, v2: p10, v3: p11 });
      triangles.push({ v1: p00, v2: p11, v3: p01 });
    }
  }

  // 2. BOTTOM BASE TRIANGLES (Facing DOWN)
  for (let r = 0; r < gridSize - 1; r++) {
    for (let c = 0; c < gridSize - 1; c++) {
      const b00 = bottomVerts[r][c];
      const b10 = bottomVerts[r + 1][c];
      const b01 = bottomVerts[r][c + 1];
      const b11 = bottomVerts[r + 1][c + 1];

      // Inverted winding order so normal points DOWN (negative Z)
      triangles.push({ v1: b00, v2: b11, v3: b10 });
      triangles.push({ v1: b00, v2: b01, v3: b11 });
    }
  }

  // 3. FOUR VERTICAL WALLS (Watertight manifold sides)
  // South Wall (row 0, y = 0)
  for (let c = 0; c < gridSize - 1; c++) {
    const t0 = topVerts[0][c];
    const t1 = topVerts[0][c + 1];
    const b0 = bottomVerts[0][c];
    const b1 = bottomVerts[0][c + 1];

    // Outward facing (facing -Y)
    triangles.push({ v1: t0, v2: b0, v3: b1 });
    triangles.push({ v1: t0, v2: b1, v3: t1 });
  }

  // North Wall (row gridSize - 1, y = targetLengthMm)
  const lastR = gridSize - 1;
  for (let c = 0; c < gridSize - 1; c++) {
    const t0 = topVerts[lastR][c];
    const t1 = topVerts[lastR][c + 1];
    const b0 = bottomVerts[lastR][c];
    const b1 = bottomVerts[lastR][c + 1];

    // Outward facing (facing +Y)
    triangles.push({ v1: t0, v2: b1, v3: b0 });
    triangles.push({ v1: t0, v2: t1, v3: b1 });
  }

  // West Wall (col 0, x = 0)
  for (let r = 0; r < gridSize - 1; r++) {
    const t0 = topVerts[r][0];
    const t1 = topVerts[r + 1][0];
    const b0 = bottomVerts[r][0];
    const b1 = bottomVerts[r + 1][0];

    // Outward facing (facing -X)
    triangles.push({ v1: t0, v2: b1, v3: b0 });
    triangles.push({ v1: t0, v2: t1, v3: b1 });
  }

  // East Wall (col gridSize - 1, x = targetWidthMm)
  const lastC = gridSize - 1;
  for (let r = 0; r < gridSize - 1; r++) {
    const t0 = topVerts[r][lastC];
    const t1 = topVerts[r + 1][lastC];
    const b0 = bottomVerts[r][lastC];
    const b1 = bottomVerts[r + 1][lastC];

    // Outward facing (facing +X)
    triangles.push({ v1: t0, v2: b0, v3: b1 });
    triangles.push({ v1: t0, v2: b1, v3: t1 });
  }

  return {
    triangles,
    stats: {
      triangleCount: triangles.length,
      widthMm: Math.round(targetWidthMm * 10) / 10,
      lengthMm: Math.round(targetLengthMm * 10) / 10,
      heightMm: Math.round((highestTopZMm - baseZMm) * 10) / 10,
      minZ: baseZMm,
      maxZ: Math.round(highestTopZMm * 10) / 10,
    },
  };
}

/**
 * Encodes triangles into a standard Binary STL format ArrayBuffer
 */
export function exportToBinarySTL(triangles: Triangle[], lakeName: string): Blob {
  const triangleCount = triangles.length;
  // Header: 80 bytes, Count: 4 bytes, Triangles: 50 bytes each
  const bufferSize = 84 + triangleCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const dataView = new DataView(buffer);

  // Write 80-byte header
  const headerStr = `Midwestern Lake Topo 3D: ${lakeName.substring(0, 50)}`;
  for (let i = 0; i < 80; i++) {
    dataView.setUint8(i, i < headerStr.length ? headerStr.charCodeAt(i) : 0x20);
  }

  // Write number of triangles (uint32 little endian)
  dataView.setUint32(80, triangleCount, true);

  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    const tri = triangles[i];
    const normal = computeNormal(tri.v1, tri.v2, tri.v3);

    // Normal vector (3 x float32)
    dataView.setFloat32(offset, normal.x, true);
    dataView.setFloat32(offset + 4, normal.y, true);
    dataView.setFloat32(offset + 8, normal.z, true);

    // Vertex 1
    dataView.setFloat32(offset + 12, tri.v1.x, true);
    dataView.setFloat32(offset + 16, tri.v1.y, true);
    dataView.setFloat32(offset + 20, tri.v1.z, true);

    // Vertex 2
    dataView.setFloat32(offset + 24, tri.v2.x, true);
    dataView.setFloat32(offset + 28, tri.v2.y, true);
    dataView.setFloat32(offset + 32, tri.v2.z, true);

    // Vertex 3
    dataView.setFloat32(offset + 36, tri.v3.x, true);
    dataView.setFloat32(offset + 40, tri.v3.y, true);
    dataView.setFloat32(offset + 44, tri.v3.z, true);

    // 2-byte attribute byte count
    dataView.setUint16(offset + 48, 0, true);

    offset += 50;
  }

  return new Blob([buffer], { type: 'model/stl' });
}

/**
 * Encodes triangles into ASCII STL format
 */
export function exportToAsciiSTL(triangles: Triangle[], lakeName: string): Blob {
  const safeName = lakeName.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = [`solid ${safeName}`];

  for (const tri of triangles) {
    const n = computeNormal(tri.v1, tri.v2, tri.v3);
    lines.push(`  facet normal ${n.x.toFixed(5)} ${n.y.toFixed(5)} ${n.z.toFixed(5)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${tri.v1.x.toFixed(4)} ${tri.v1.y.toFixed(4)} ${tri.v1.z.toFixed(4)}`);
    lines.push(`      vertex ${tri.v2.x.toFixed(4)} ${tri.v2.y.toFixed(4)} ${tri.v2.z.toFixed(4)}`);
    lines.push(`      vertex ${tri.v3.x.toFixed(4)} ${tri.v3.y.toFixed(4)} ${tri.v3.z.toFixed(4)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }

  lines.push(`endsolid ${safeName}`);
  return new Blob([lines.join('\n')], { type: 'text/plain' });
}

/**
 * Triggers browser download of the generated STL file
 */
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
