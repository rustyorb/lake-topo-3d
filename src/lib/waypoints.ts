/**
 * Waypoints live in localStorage, one list per lake id. No backend.
 */
import type { StructureKind } from './structure.js';

export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Depth at the pin, feet (0 on land). */
  depthFt: number;
  /** Bed / ground elevation at the pin, feet MSL. */
  elevFt: number;
  note?: string;
  createdAt: string;
  source: 'manual' | 'structure';
  kind?: StructureKind;
  /** Grid position when the pin was dropped (for drawing without re-projecting). */
  row: number;
  col: number;
}

const PREFIX = 'lake_topo_waypoints:';

export function loadWaypoints(lakeId: string): Waypoint[] {
  try {
    const raw = localStorage.getItem(PREFIX + lakeId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w) => w && Number.isFinite(w.lat) && Number.isFinite(w.lon)) : [];
  } catch {
    return [];
  }
}

export function saveWaypoints(lakeId: string, waypoints: Waypoint[]): void {
  try {
    localStorage.setItem(PREFIX + lakeId, JSON.stringify(waypoints));
  } catch {
    /* storage unavailable (private mode, quota) — keep the in-memory list */
  }
}

export function newWaypointId(): string {
  return `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Next unused "WP n" name. */
export function nextWaypointName(existing: Waypoint[]): string {
  let n = existing.length + 1;
  const names = new Set(existing.map((w) => w.name));
  while (names.has(`WP ${n}`)) n++;
  return `WP ${n}`;
}
