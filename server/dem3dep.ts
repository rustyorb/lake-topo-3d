/**
 * USGS 3DEP elevation via the National Map ImageServer.
 * Returns a float32 GeoTIFF already resampled to the requested grid, so no tile math is
 * needed. Where states have flown LiDAR (Indiana is fully covered) this is 1 m data.
 * US-only: cells outside coverage come back as NoData and the caller falls back.
 */
const SERVICE_URL =
  process.env.DEM_3DEP_URL || 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const NODATA = -999999;
const cache = new Map<string, Promise<number[][] | null>>();

export interface Bounds { minLat: number; maxLat: number; minLon: number; maxLon: number }

function readTags(buf: Buffer): { le: boolean; tags: Map<number, { type: number; count: number; raw: Buffer }> } {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, { type: number; count: number; raw: Buffer }>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), raw: buf.subarray(e + 8, e + 12) });
  }
  return { le, tags };
}

function tagValues(buf: Buffer, le: boolean, t: { type: number; count: number; raw: Buffer }): number[] {
  const size = t.type === 3 ? 2 : t.type === 4 ? 4 : t.type === 1 ? 1 : 0;
  if (!size) return [];
  const read = (o: number) => (size === 2 ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : size === 4 ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : buf[o]);
  const out: number[] = [];
  if (size * t.count <= 4) {
    for (let i = 0; i < t.count; i++) out.push(read(0 + i * size) === undefined ? 0 : (size === 2 ? (le ? t.raw.readUInt16LE(i * 2) : t.raw.readUInt16BE(i * 2)) : size === 4 ? (le ? t.raw.readUInt32LE(0) : t.raw.readUInt32BE(0)) : t.raw[i]));
    return out;
  }
  const off = le ? t.raw.readUInt32LE(0) : t.raw.readUInt32BE(0);
  for (let i = 0; i < t.count; i++) out.push(read(off + i * size));
  return out;
}

/** Decodes an uncompressed single-band float32 TIFF (tiled or stripped) into [row][col]. */
export function decodeFloat32Tiff(buf: Buffer): { width: number; height: number; data: Float32Array } {
  const { le, tags } = readTags(buf);
  const get = (id: number) => { const t = tags.get(id); return t ? tagValues(buf, le, t) : []; };
  const width = get(256)[0];
  const height = get(257)[0];
  const bits = get(258)[0] ?? 32;
  const compression = get(259)[0] ?? 1;
  const sampleFormat = get(339)[0] ?? 1;
  if (compression !== 1) throw new Error(`unsupported TIFF compression ${compression}`);
  if (bits !== 32 || sampleFormat !== 3) throw new Error(`expected float32 samples, got bits=${bits} format=${sampleFormat}`);
  const data = new Float32Array(width * height);
  const readF = (o: number) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));

  const tileW = get(322)[0];
  if (tileW) {
    const tileH = get(323)[0];
    const offsets = get(324);
    const across = Math.ceil(width / tileW);
    offsets.forEach((off, idx) => {
      const tx = idx % across;
      const ty = Math.floor(idx / across);
      for (let y = 0; y < tileH; y++) {
        const gy = ty * tileH + y;
        if (gy >= height) break;
        for (let x = 0; x < tileW; x++) {
          const gx = tx * tileW + x;
          if (gx >= width) continue;
          data[gy * width + gx] = readF(off + (y * tileW + x) * 4);
        }
      }
    });
  } else {
    const offsets = get(273);
    const rowsPerStrip = get(278)[0] ?? height;
    offsets.forEach((off, idx) => {
      for (let y = 0; y < rowsPerStrip; y++) {
        const gy = idx * rowsPerStrip + y;
        if (gy >= height) break;
        for (let x = 0; x < width; x++) data[gy * width + x] = readF(off + (y * width + x) * 4);
      }
    });
  }
  return { width, height, data };
}

/**
 * Elevation grid (metres, row 0 = north) for `bounds` at rows×cols, or null when the
 * service fails or more than 2% of cells are NoData (outside 3DEP coverage).
 */
export async function sampleDem3dep(bounds: Bounds, rows: number, cols: number): Promise<number[][] | null> {
  const key = `${bounds.minLon.toFixed(6)},${bounds.minLat.toFixed(6)},${bounds.maxLon.toFixed(6)},${bounds.maxLat.toFixed(6)}|${cols}x${rows}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const p = (async (): Promise<number[][] | null> => {
    const url = `${SERVICE_URL}?${new URLSearchParams({
      bbox: `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`,
      bboxSR: '4326',
      imageSR: '4326',
      size: `${cols},${rows}`,
      format: 'tiff',
      pixelType: 'F32',
      noData: String(NODATA),
      interpolation: 'RSP_BilinearInterpolation',
      f: 'image',
    }).toString()}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'lake-topo-3d/1.0' } });
      if (!res.ok) throw new Error(`3DEP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (!type.includes('tiff')) throw new Error(`3DEP returned ${type}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 84 + rows * cols * 2) throw new Error('response too small for the requested grid (outside 3DEP coverage?)');
      const img = decodeFloat32Tiff(buf);
      if (img.width !== cols || img.height !== rows) throw new Error(`3DEP size mismatch ${img.width}x${img.height}`);
      let nodata = 0;
      const out: number[][] = [];
      for (let r = 0; r < rows; r++) {
        const row = new Array<number>(cols);
        for (let c = 0; c < cols; c++) {
          const v = img.data[r * cols + c];
          if (!Number.isFinite(v) || v <= NODATA + 1 || v < -500) { nodata++; row[c] = NaN; } else row[c] = v;
        }
        out.push(row);
      }
      if (nodata > rows * cols * 0.02) {
        console.warn(`[3dep] ${nodata} NoData cells of ${rows * cols}; outside coverage`);
        return null;
      }
      // Fill the rare NoData pixel from neighbours
      if (nodata) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (Number.isNaN(out[r][c])) {
          const nb = [out[r - 1]?.[c], out[r + 1]?.[c], out[r][c - 1], out[r][c + 1]].filter((x) => Number.isFinite(x)) as number[];
          out[r][c] = nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : 0;
        }
      }
      return out;
    } finally {
      clearTimeout(t);
    }
  })().catch((err) => {
    console.warn('[3dep] elevation fetch failed:', err?.message || err);
    cache.delete(key);
    return null;
  });
  if (cache.size > 60) { const k = cache.keys().next().value; if (k !== undefined) cache.delete(k); }
  cache.set(key, p);
  return p;
}
