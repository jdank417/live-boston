// The sun's position over Boston for a given moment, and the map's colors at
// that time of day: night, dusk/dawn and day blend continuously.

const RAD = Math.PI / 180;
const BOSTON = { lat: 42.3601, lng: -71.0589 };

/** Altitude above the horizon and azimuth (from north, clockwise), both in radians. */
export function sunPosition(date: Date, lat = BOSTON.lat, lng = BOSTON.lng) {
  // After Vladimir Agafonkin's SunCalc, accurate to well under a degree.
  const d = date.valueOf() / 86_400_000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) - RAD * -lng - ra;
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const fromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { altitude, azimuth: fromSouth + Math.PI };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface SkyState {
  /** 0 at night, 1 in full daylight; twilight in between. */
  day: number;
  /** Peaks around sunrise and sunset. */
  dusk: number;
  /** Unit vector toward the sun: x east, y north, z up. */
  sun: [number, number, number];
  /** Sun azimuth and altitude in degrees, for MapLibre's light. */
  azimuthDeg: number;
  altitudeDeg: number;
}

export function skyAt(date: Date): SkyState {
  const { altitude, azimuth } = sunPosition(date);
  const alt = altitude / RAD;
  return {
    // Civil twilight runs to 6° below the horizon.
    day: smooth(-7, 8, alt),
    dusk: smooth(-9, -1, alt) * (1 - smooth(4, 14, alt)),
    sun: [Math.cos(altitude) * Math.sin(azimuth), Math.cos(altitude) * Math.cos(azimuth), Math.sin(altitude)],
    azimuthDeg: azimuth / RAD,
    altitudeDeg: alt,
  };
}

/** Today's sunrise and sunset in Boston (the moments the sun's top edge crosses the horizon). */
export function sunTimes(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  let rise: Date | null = null;
  let set: Date | null = null;
  let prev = sunPosition(start).altitude;
  for (let m = 2; m <= 24 * 60; m += 2) {
    const t = new Date(start.getTime() + m * 60_000);
    const alt = sunPosition(t).altitude;
    const horizon = -0.833 * RAD;
    if (prev < horizon && alt >= horizon) rise = t;
    if (prev >= horizon && alt < horizon) set = t;
    prev = alt;
  }
  return { rise, set };
}

// The sky behind the city at night, at sunrise or sunset, and by day. The map
// itself stays dark at all hours so the lines always read; the sky and the
// light on the buildings are what change.

type Triple = [night: string, dusk: string, day: string];

export const SKY: Record<string, Triple> = {
  'sky-color': ['#070a12', '#1d2347', '#2d4f80'],
  'horizon-color': ['#141c30', '#c9714a', '#6f93bd'],
  'fog-color': ['#0a0c10', '#141218', '#10141b'],
};

/** "#rrggbb" as sRGB 0–255 channels. */
function parse(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Picks a color for this moment: night → dusk → day, blending as the sun moves. */
export function blend([night, dusk, day]: Triple, s: SkyState): string {
  const [r, g, b] = mix(mix(parse(night), parse(day), s.day), parse(dusk), s.dusk * 0.85).map(Math.round);
  return `rgb(${r},${g},${b})`;
}
