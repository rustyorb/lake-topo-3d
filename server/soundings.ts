/**
 * User-supplied bathymetry: scattered depth soundings (from a sonar unit, a chart app or a notebook)
 * interpolated onto the terrain grid inside the shoreline.
 *
 * Every water cell takes an inverse-distance-squared average of its nearest samples, with the
 * shoreline itself added as zero-depth samples so the bed rises to meet the bank. Two light
 * smoothing passes soften the bullseyes that pure IDW leaves around isolated soundings.
 */

export interface Sounding {
  lat: number;
  lon: number;
  /** Depth below the surface, metres, positive down. */
  depthM: number;
}

export interface SoundingRaster {
  depthsM: number[][];
  maxDepthM: number;
  /** Soundings that landed inside (or within a cell of) the water mask. */
  used: number;
}

const K_NEAREST = 12;
const BUCKET = 3; // grid cells per spatial bucket
const MIN_WET_M = 0.1;

export function rasterizeSoundings(
  points: Sounding[],
  waterMask: boolean[][],
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }
): SoundingRaster {
  const rows = waterMask.length;
  const cols = waterMask[0].length;
  const gx = (lon: number) => ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (cols - 1);
  const gy = (lat: number) => ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (rows - 1);
  const water = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols && waterMask[r][c];
  const nearWater = (x: number, y: number) => {
    const r0 = Math.round(y), c0 = Math.round(x);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (water(r0 + dr, c0 + dc)) return true;
    return false;
  };

  const sx: number[] = [], sy: number[] = [], sd: number[] = [];
  let used = 0;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.depthM) || p.depthM < 0) continue;
    const x = gx(p.lon), y = gy(p.lat);
    if (x < -1 || y < -1 || x > cols || y > rows || !nearWater(x, y)) continue;
    sx.push(x); sy.push(y); sd.push(p.depthM);
    used++;
  }
  const empty = () => waterMask.map((row) => row.map(() => 0));
  if (used < 3) return { depthsM: empty(), maxDepthM: 0, used };

  // Shoreline as zero-depth samples: land cells touching water, and water cells on the frame edge.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (waterMask[r][c]) {
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) { sx.push(c); sy.push(r); sd.push(0); }
        continue;
      }
      if (water(r - 1, c) || water(r + 1, c) || water(r, c - 1) || water(r, c + 1)) { sx.push(c); sy.push(r); sd.push(0); }
    }
  }

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < sx.length; i++) {
    const k = `${Math.floor(sx[i] / BUCKET)},${Math.floor(sy[i] / BUCKET)}`;
    const b = buckets.get(k);
    if (b) b.push(i); else buckets.set(k, [i]);
  }
  const bestD = new Array<number>(K_NEAREST);
  const bestI = new Array<number>(K_NEAREST);
  const nearest = (x: number, y: number): number => {
    let found = 0;
    const bx = Math.floor(x / BUCKET), by = Math.floor(y / BUCKET);
    const maxRing = Math.ceil(Math.max(rows, cols) / BUCKET) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (found >= K_NEAREST && (ring - 1) * BUCKET > bestD[K_NEAREST - 1]) break;
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const b = buckets.get(`${bx + dx},${by + dy}`);
          if (!b) continue;
          for (const i of b) {
            const d = Math.hypot(sx[i] - x, sy[i] - y);
            if (found < K_NEAREST || d < bestD[found - 1]) {
              // insertion into the sorted best list
              let j = Math.min(found, K_NEAREST - 1);
              while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; j--; }
              bestD[j] = d; bestI[j] = i;
              if (found < K_NEAREST) found++;
            }
          }
        }
      }
    }
    return found;
  };

  const depths: number[][] = [];
  for (let r = 0; r < rows; r++) {
    depths[r] = new Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      if (!waterMask[r][c]) continue;
      const n = nearest(c, r);
      if (!n) continue;
      if (bestD[0] < 0.3) { depths[r][c] = sd[bestI[0]]; continue; }
      let wsum = 0, dsum = 0;
      for (let k = 0; k < n; k++) {
        const w = 1 / (bestD[k] * bestD[k] + 1e-6);
        wsum += w;
        dsum += w * sd[bestI[k]];
      }
      depths[r][c] = dsum / wsum;
    }
  }

  // Two 3×3 mean passes inside the water to soften bullseyes.
  for (let pass = 0; pass < 2; pass++) {
    const src = depths.map((row) => row.slice());
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!waterMask[r][c]) continue;
        let sum = 0, cnt = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (water(r + dr, c + dc)) { sum += src[r + dr][c + dc]; cnt++; }
        depths[r][c] = sum / cnt;
      }
    }
  }

  let maxDepthM = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!waterMask[r][c]) continue;
      depths[r][c] = Math.max(MIN_WET_M, Math.round(depths[r][c] * 100) / 100);
      if (depths[r][c] > maxDepthM) maxDepthM = depths[r][c];
    }
  }
  return { depthsM: depths, maxDepthM, used };
}

/** FNV-1a over the rounded sounding list, for cache keys. */
export function hashSoundings(points: Sounding[] | undefined): string {
  if (!points || !points.length) return '';
  let h = 0x811c9dc5;
  const s = points.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)},${p.depthM.toFixed(2)}`).join(';');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${points.length}-${h.toString(16)}`;
}
