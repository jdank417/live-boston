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

// Palettes ------------------------------------------------------------------

type Triple = [night: string, dusk: string, day: string];

/** Basemap layer colors through the day. Day stays moody rather than bright. */
export const BASEMAP: Record<string, [prop: string, colors: Triple]> = {
  background: ['background-color', ['#090c13', '#1a1724', '#3a4456']],
  water: ['fill-color', ['#0a1a2f', '#1d2440', '#2b6aa8']],
  waterway: ['line-color', ['#0d2038', '#232b48', '#3576b5']],
  landuse_park: ['fill-color', ['#0c1612', '#1a2120', '#35573f']],
  landcover_wood: ['fill-color', ['#0c1612', '#1a2120', '#35573f']],
  landuse_residential: ['fill-color', ['#0b0f17', '#1b1a26', '#414b5e']],
  building: ['fill-color', ['#0e131c', '#211e2b', '#4c566b']],
  highway_minor: ['line-color', ['#151b26', '#29283a', '#555f76']],
  highway_major_inner: ['line-color', ['#121925', '#2a2838', '#5d6882']],
  highway_major_casing: ['line-color', ['rgba(70,88,120,0.45)', 'rgba(120,100,120,0.5)', 'rgba(120,140,175,0.6)']],
  highway_major_subtle: ['line-color', ['#1b2331', '#2e2c3d', '#5d6882']],
  highway_motorway_casing: ['line-color', ['rgba(90,110,150,0.5)', 'rgba(140,110,120,0.55)', 'rgba(140,160,200,0.6)']],
  highway_motorway_subtle: ['line-color', ['#1a2230', '#302c3c', '#65708a']],
};

export const SKY: Record<string, Triple> = {
  'sky-color': ['#0a1324', '#2a2f5e', '#5c95d6'],
  'horizon-color': ['#1c2d4d', '#ff8c5a', '#a8c8ec'],
  'fog-color': ['#090c13', '#3a2c3c', '#7d93b3'],
};

/** Buildings: [low, tall] colors, and the warm glow of lit windows after dark. */
export const BUILDINGS = {
  low: ['#141b28', '#2a2533', '#66728a'] as Triple,
  tall: ['#2d3f5e', '#4a3f5a', '#aab6cc'] as Triple,
  lit: ['#5e4630', '#4a3a36', '#66728a'] as Triple,
};

/** "#rrggbb" or "rgba(r,g,b,a)" as sRGB 0–255 channels and alpha. */
function parse(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return [r, g, b, a];
  }
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Picks a color for this moment: night → dusk → day, blending as the sun moves. */
export function blend([night, dusk, day]: Triple, s: SkyState): string {
  const c = mix(mix(parse(night), parse(day), s.day), parse(dusk), s.dusk * 0.85);
  const [r, g, b] = c.slice(0, 3).map(Math.round);
  return c[3] >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${c[3].toFixed(2)})`;
}
