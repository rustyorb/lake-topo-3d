/** Shared types for click modes and draped overlay lines, used by both viewers and App. */
export type PickMode = 'none' | 'pin' | 'section';

/** A polyline drawn on the 3D terrain and the 2D map, in fractional grid coordinates ([col, row]). */
export interface OverlayLine {
  id: string;
  points: Array<[number, number]>;
  /** CSS hex colour. */
  color: string;
  dashed?: boolean;
  /** Draw a dot at each end. */
  endpoints?: boolean;
}
