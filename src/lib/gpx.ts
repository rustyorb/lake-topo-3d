/**
 * GPX 1.1 writer. Humminbird, Lowrance, Garmin and Navionics all import <wpt> records.
 */
import type { Waypoint } from './waypoints.js';
import type { StructureFeature } from './structure.js';

const FT_PER_M = 3.28084;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wpt(lat: number, lon: number, elevM: number | null, name: string, desc: string, sym: string, type: string, time?: string): string {
  return [
    `  <wpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`,
    elevM !== null ? `    <ele>${elevM.toFixed(2)}</ele>` : '',
    time ? `    <time>${time}</time>` : '',
    `    <name>${esc(name)}</name>`,
    desc ? `    <desc>${esc(desc)}</desc>` : '',
    `    <sym>${esc(sym)}</sym>`,
    `    <type>${esc(type)}</type>`,
    `  </wpt>`,
  ].filter(Boolean).join('\n');
}

export interface GpxOptions {
  lakeName: string;
  waypoints: Waypoint[];
  structure?: StructureFeature[];
  /** Bed elevation lookup for structure features (metres MSL). */
  bedElevationM?: (f: StructureFeature) => number | null;
}

export function buildGpx(opts: GpxOptions): string {
  const created = new Date().toISOString();
  const parts: string[] = [];
  for (const w of opts.waypoints) {
    const desc = [w.depthFt > 0 ? `Depth ${w.depthFt} ft` : `Land ${w.elevFt} ft`, w.note].filter(Boolean).join(' · ');
    parts.push(wpt(w.lat, w.lon, w.elevFt / FT_PER_M, w.name, desc, w.depthFt > 0 ? 'Fishing Area' : 'Flag, Blue', w.kind || 'waypoint', w.createdAt));
  }
  for (const f of opts.structure || []) {
    parts.push(wpt(f.lat, f.lon, opts.bedElevationM ? opts.bedElevationM(f) : null, `${f.label} ${f.depthFt} ft`, f.detail, 'Fishing Area', f.kind));
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Lake Topo 3D" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
    `  <metadata><name>${esc(opts.lakeName)}</name><time>${created}</time></metadata>`,
    ...parts,
    `</gpx>`,
    '',
  ].join('\n');
}

export function downloadText(filename: string, text: string, mime = 'application/gpx+xml'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
