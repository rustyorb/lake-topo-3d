/**
 * Marching-squares isolines over a regular scalar grid.
 *
 * Shared by the server (SVG topo map) and the browser (3D contour lines).
 * Coordinates are in grid units: x = column, y = row, with linear interpolation
 * along cell edges so lines are smooth rather than stair-stepped.
 */

export type Point = [number, number];
export type Polyline = Point[];

/** Row-major accessor so callers can pass number[][] or a flat typed array. */
export type FieldAccessor = (row: number, col: number) => number;

export function fieldFrom2D(grid: number[][]): FieldAccessor {
  return (r, c) => grid[r][c];
}

function lerpPoint(ax: number, ay: number, av: number, bx: number, by: number, bv: number, level: number): Point {
  const denom = bv - av;
  const t = Math.abs(denom) < 1e-12 ? 0.5 : (level - av) / denom;
  const tt = Math.max(0, Math.min(1, t));
  return [ax + (bx - ax) * tt, ay + (by - ay) * tt];
}

/**
 * Returns the raw line segments at `level` for a rows×cols field.
 * Each segment is [[x0,y0],[x1,y1]] in (col,row) units.
 */
export function isoSegments(field: FieldAccessor, rows: number, cols: number, level: number): Array<[Point, Point]> {
  const segs: Array<[Point, Point]> = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      // Corners: tl (r,c), tr (r,c+1), br (r+1,c+1), bl (r+1,c)
      const tl = field(r, c);
      const tr = field(r, c + 1);
      const br = field(r + 1, c + 1);
      const bl = field(r + 1, c);
      if (!Number.isFinite(tl) || !Number.isFinite(tr) || !Number.isFinite(br) || !Number.isFinite(bl)) continue;

      let idx = 0;
      if (tl >= level) idx |= 8;
      if (tr >= level) idx |= 4;
      if (br >= level) idx |= 2;
      if (bl >= level) idx |= 1;
      if (idx === 0 || idx === 15) continue;

      // Edge midpoints (interpolated): top, right, bottom, left
      const top = () => lerpPoint(c, r, tl, c + 1, r, tr, level);
      const right = () => lerpPoint(c + 1, r, tr, c + 1, r + 1, br, level);
      const bottom = () => lerpPoint(c, r + 1, bl, c + 1, r + 1, br, level);
      const left = () => lerpPoint(c, r, tl, c, r + 1, bl, level);

      switch (idx) {
        case 1: case 14: segs.push([left(), bottom()]); break;
        case 2: case 13: segs.push([bottom(), right()]); break;
        case 3: case 12: segs.push([left(), right()]); break;
        case 4: case 11: segs.push([top(), right()]); break;
        case 6: case 9: segs.push([top(), bottom()]); break;
        case 7: case 8: segs.push([left(), top()]); break;
        case 5: case 10: {
          // Saddle: disambiguate with the cell centre value
          const center = (tl + tr + br + bl) / 4;
          const centerHigh = center >= level;
          if ((idx === 5) === centerHigh) {
            segs.push([left(), top()]);
            segs.push([bottom(), right()]);
          } else {
            segs.push([left(), bottom()]);
            segs.push([top(), right()]);
          }
          break;
        }
      }
    }
  }
  return segs;
}

function key(p: Point): string {
  // Quantise so that shared edge intersections hash identically
  return `${Math.round(p[0] * 1e4)}_${Math.round(p[1] * 1e4)}`;
}

/**
 * Joins segments into polylines by matching endpoints. Closed rings end where they start.
 */
export function joinSegments(segs: Array<[Point, Point]>): Polyline[] {
  const remaining = new Set<number>();
  const byEnd = new Map<string, number[]>();
  segs.forEach((s, i) => {
    remaining.add(i);
    for (const p of s) {
      const k = key(p);
      const arr = byEnd.get(k);
      if (arr) arr.push(i); else byEnd.set(k, [i]);
    }
  });

  const takeNeighbor = (p: Point, exclude: number): number | null => {
    const arr = byEnd.get(key(p));
    if (!arr) return null;
    for (const i of arr) {
      if (i !== exclude && remaining.has(i)) return i;
    }
    return null;
  };

  const lines: Polyline[] = [];
  for (const start of Array.from(remaining)) {
    if (!remaining.has(start)) continue;
    remaining.delete(start);
    const line: Polyline = [segs[start][0], segs[start][1]];

    // Extend forward
    let last = start;
    for (;;) {
      const tail = line[line.length - 1];
      const n = takeNeighbor(tail, last);
      if (n === null) break;
      remaining.delete(n);
      const [a, b] = segs[n];
      line.push(key(a) === key(tail) ? b : a);
      last = n;
      if (key(line[line.length - 1]) === key(line[0])) break;
    }
    // Extend backward (only if not closed)
    if (key(line[line.length - 1]) !== key(line[0])) {
      last = start;
      for (;;) {
        const head = line[0];
        const n = takeNeighbor(head, last);
        if (n === null) break;
        remaining.delete(n);
        const [a, b] = segs[n];
        line.unshift(key(a) === key(head) ? b : a);
        last = n;
        if (key(line[line.length - 1]) === key(line[0])) break;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function isolines(field: FieldAccessor, rows: number, cols: number, level: number): Polyline[] {
  return joinSegments(isoSegments(field, rows, cols, level));
}

/** Levels from `start` stepping by `step` up to and including `end` (inclusive-ish with epsilon). */
export function levelRange(start: number, end: number, step: number): number[] {
  if (!(step > 0)) return [];
  const out: number[] = [];
  const first = Math.ceil(start / step) * step;
  for (let v = first; v <= end + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Bilinear sample of a row-major 2D grid at fractional (col,row). */
export function sampleBilinear(grid: number[][], x: number, y: number): number {
  const rows = grid.length;
  const cols = grid[0].length;
  const cx = Math.max(0, Math.min(cols - 1, x));
  const cy = Math.max(0, Math.min(rows - 1, y));
  const c0 = Math.floor(cx);
  const r0 = Math.floor(cy);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fx = cx - c0;
  const fy = cy - r0;
  const a = grid[r0][c0] * (1 - fx) + grid[r0][c1] * fx;
  const b = grid[r1][c0] * (1 - fx) + grid[r1][c1] * fx;
  return a * (1 - fy) + b * fy;
}
