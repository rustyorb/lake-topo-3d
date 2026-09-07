/**
 * Solar position (NOAA's simplified algorithm): azimuth clockwise from north and elevation above the
 * horizon for a moment and a place. Good to a fraction of a degree, which is all shade lines need.
 */

export interface SunPosition {
  azimuthDeg: number;
  elevationDeg: number;
}

const RAD = Math.PI / 180;

export function sunPosition(date: Date, latDeg: number, lonDeg: number): SunPosition {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (((utcMin + eqTimeMin + 4 * lonDeg) % 1440) + 1440) % 1440;
  const haDeg = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const ha = haDeg * RAD;
  const lat = latDeg * RAD;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const denom = Math.cos(lat) * Math.sin(zen);
  let azimuthDeg = 0;
  if (Math.abs(denom) > 1e-9) {
    const azRad = Math.acos(Math.max(-1, Math.min(1, (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / denom)));
    azimuthDeg = haDeg > 0 ? (azRad / RAD + 180) % 360 : (540 - azRad / RAD) % 360;
  }
  return { azimuthDeg, elevationDeg: 90 - zen / RAD };
}

/** A local-time Date from a "YYYY-MM-DD" string and minutes since midnight (this device's time zone). */
export function localDateTime(isoDate: string, minutes: number): Date {
  const [y, m, d] = isoDate.split('-').map((v) => parseInt(v, 10));
  return new Date(y || 2000, (m || 1) - 1, d || 1, 0, minutes, 0, 0);
}

export function localIsoDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compassName(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
