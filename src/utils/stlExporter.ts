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

export type MaterialPart = 'land' | 'water';

/**
 * Which material a grid quad (the cell between four grid vertices) belongs to.
 * A quad is lake bed when at least three of its corners are water, so the blue part
 * stays inside the shoreline and the two parts tile the frame exactly.
 */
export function quadMaterial(data: TerrainGridData, r: number, c: number): MaterialPart {
  const w = data.waterMask;
  const n = (w[r][c] ? 1 : 0) + (w[r][c + 1] ? 1 : 0) + (w[r + 1][c] ? 1 : 0) + (w[r + 1][c + 1] ? 1 : 0);
  return n >= 3 ? 'water' : 'land';
}

/**
 * Builds a watertight solid from the terrain grid: heightfield top, flat bottom plate and walls.
 * When `quadMask` is given only those quads are built and vertical walls close every edge where
 * the neighbouring quad is missing, so a masked region is itself a closed solid that mates
 * exactly with the solid built from the complementary mask.
 *
 * Coordinate frame (slicer-friendly, Z-up, north-up):
 *   +X = east, +Y = north, +Z = up.  Row 0 of the grid is the north edge, so it maps to y = length.
 *   Vertical scale is TRUE scale × verticalExaggeration (1.0x means the same mm/m as the horizontal axes).
 */
export function generateWatertightSTLMesh(
  data: TerrainGridData,
  options: STLOptions,
  quadMask?: (r: number, c: number) => boolean
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
  const NORTH = { x: 0, y: 1, z: 0 }, SOUTH = { x: 0, y: -1, z: 0 }, EAST = { x: 1, y: 0, z: 0 }, WEST = { x: -1, y: 0, z: 0 };
  const inMask = (r: number, c: number) => r >= 0 && c >= 0 && r < gridSize - 1 && c < gridSize - 1 && (!quadMask || quadMask(r, c));

  // A wall along the edge between grid vertices (ra,ca)-(rb,cb), from the plate up to the heightfield.
  const wall = (ra: number, ca: number, rb: number, cb: number, outward: Point3D) => {
    pushTri(topVerts[ra][ca], topVerts[rb][cb], bottomVerts[rb][cb], outward);
    pushTri(topVerts[ra][ca], bottomVerts[rb][cb], bottomVerts[ra][ca], outward);
  };

  for (let r = 0; r < gridSize - 1; r++) {
    for (let c = 0; c < gridSize - 1; c++) {
      if (!inMask(r, c)) continue;
      // 1. Top heightfield (normals up) and 2. bottom plate (normals down)
      const t00 = topVerts[r][c], t01 = topVerts[r][c + 1], t10 = topVerts[r + 1][c], t11 = topVerts[r + 1][c + 1];
      for (const v of [t00, t01, t10, t11]) { lowestTopZ = Math.min(lowestTopZ, v.z); highestTopZ = Math.max(highestTopZ, v.z); }
      pushTri(t00, t10, t11, UP);
      pushTri(t00, t11, t01, UP);
      const b00 = bottomVerts[r][c], b01 = bottomVerts[r][c + 1], b10 = bottomVerts[r + 1][c], b11 = bottomVerts[r + 1][c + 1];
      pushTri(b00, b10, b11, DOWN);
      pushTri(b00, b11, b01, DOWN);
      // 3. Walls wherever the neighbouring quad is absent (frame edge or the other material)
      if (!inMask(r - 1, c)) wall(r, c, r, c + 1, NORTH);
      if (!inMask(r + 1, c)) wall(r + 1, c, r + 1, c + 1, SOUTH);
      if (!inMask(r, c - 1)) wall(r, c, r + 1, c, WEST);
      if (!inMask(r, c + 1)) wall(r, c + 1, r + 1, c + 1, EAST);
    }
  }
  if (!triangles.length) { lowestTopZ = 0; highestTopZ = 0; }

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

/**
 * The same model as two mating solids: everything under land, and everything under the lake bed.
 * Import both into the slicer as parts of one object and give the lake part its own filament.
 */
export function generateSplitMeshes(data: TerrainGridData, options: STLOptions): { land: { triangles: Triangle[]; stats: MeshStats }; water: { triangles: Triangle[]; stats: MeshStats } } {
  return {
    land: generateWatertightSTLMesh(data, options, (r, c) => quadMaterial(data, r, c) === 'land'),
    water: generateWatertightSTLMesh(data, options, (r, c) => quadMaterial(data, r, c) === 'water'),
  };
}

// ------------------------------------------------------------------ 3MF (zip of XML)

export interface MfPart { name: string; triangles: Triangle[]; colorHex: string }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored, no compression) — enough for a 3MF container. */
function zipStore(files: Array<{ name: string; data: Uint8Array }>): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length + f.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30); local.set(f.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local); centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(end, p);
  return out.buffer;
}

/**
 * Encodes parts as one 3MF object with a component per part (a multi-part object in
 * Bambu Studio / PrusaSlicer / Cura), each part carrying a base material colour.
 */
export function encode3MF(parts: MfPart[], modelName: string): ArrayBuffer {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const objects: string[] = [];
  const components: string[] = [];
  const materials = parts.map((p, i) => `<base name="${esc(p.name)}" displaycolor="${p.colorHex.replace('#', '#').toUpperCase()}FF"/>`).join('');
  parts.forEach((part, i) => {
    const verts: string[] = [];
    const index = new Map<string, number>();
    const tris: string[] = [];
    const vid = (v: Point3D) => {
      const k = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      let id = index.get(k);
      if (id === undefined) { id = verts.length; index.set(k, id); verts.push(`<vertex x="${v.x.toFixed(4)}" y="${v.y.toFixed(4)}" z="${v.z.toFixed(4)}"/>`); }
      return id;
    };
    for (const t of part.triangles) tris.push(`<triangle v1="${vid(t.v1)}" v2="${vid(t.v2)}" v3="${vid(t.v3)}"/>`);
    const id = 2 + i;
    objects.push(`<object id="${id}" name="${esc(part.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    components.push(`<component objectid="${id}"/>`);
  });
  const rootId = 2 + parts.length;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(modelName)}</metadata><metadata name="Application">Lake Topo 3D</metadata>
<resources><basematerials id="1">${materials}</basematerials>${objects.join('')}<object id="${rootId}" name="${esc(modelName)}" type="model"><components>${components.join('')}</components></object></resources>
<build><item objectid="${rootId}"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}

export function exportTo3MF(parts: MfPart[], modelName: string): Blob {
  return new Blob([encode3MF(parts, modelName)], { type: 'model/3mf' });
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
