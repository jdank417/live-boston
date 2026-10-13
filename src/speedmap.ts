import type { Track } from './geo';

// How fast trains actually move over each stretch of track, measured from
// their own reports: slow zones show up as red. Readings are kept per line
// in ~60 m cells (so the Orange Line and the commuter rail beside it don't
// mix) and saved on this device, so the map is already filled in next time.

const CELL = 60;
const STORAGE_KEY = 'live-boston:speeds';
/** Readings older than this fade out, so the map reflects current conditions. */
const MAX_AGE_MS = 6 * 60 * 60_000;

interface Cell {
  /** Running average speed, m/s. */
  speed: number;
  /** How many readings, capped so new ones keep moving the average. */
  n: number;
  at: number;
}

/** mph thresholds and their colors, slow to fast. */
export const SPEED_SCALE: [mph: number, color: string][] = [
  [0, '#ef4444'],
  [10, '#f97316'],
  [20, '#facc15'],
  [30, '#a3e635'],
  [40, '#22c55e'],
];

export function speedColor(mps: number) {
  const mph = mps * 2.237;
  let c = SPEED_SCALE[0][1];
  for (const [min, color] of SPEED_SCALE) if (mph >= min) c = color;
  return c;
}

export class SpeedMap {
  private cells = new Map<string, Cell>();
  private dirty = false;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const now = Date.now();
      if (raw) {
        for (const [k, speed, n, at] of JSON.parse(raw) as [string, number, number, number][]) {
          if (now - at < MAX_AGE_MS) this.cells.set(k, { speed, n, at });
        }
      }
    } catch {
      // Starts empty without storage; it fills in as trains move.
    }
  }

  private key(group: string, x: number, y: number) {
    return `${group}|${Math.round(x / CELL)}|${Math.round(y / CELL)}`;
  }

  private record(group: string, x: number, y: number, speed: number) {
    const k = this.key(group, x, y);
    const c = this.cells.get(k);
    if (!c) this.cells.set(k, { speed, n: 1, at: Date.now() });
    else {
      c.n = Math.min(c.n + 1, 8);
      c.speed += (speed - c.speed) / c.n;
      c.at = Date.now();
    }
    this.dirty = true;
  }

  /** A train covered `from`–`to` along its track at an average `speed` (m/s). */
  addRun(group: string, track: Track, from: number, to: number, speed: number) {
    if (!(to > from) || to - from > 5000 || speed > 60) return;
    const p = { x: 0, y: 0 };
    for (let d = from; d <= to; d += CELL / 2) {
      track.at(d, p);
      this.record(group, p.x, p.y, speed);
    }
  }

  /** An instantaneous reading where the train is. */
  addPoint(group: string, x: number, y: number, speed: number) {
    if (speed >= 0 && speed < 60) this.record(group, x, y, speed);
  }

  speedAt(group: string, x: number, y: number): number | null {
    return this.cells.get(this.key(group, x, y))?.speed ?? null;
  }

  get size() {
    return this.cells.size;
  }

  /** Colored stretches along one drawn track: runs of the same color become one line. */
  segments(group: string, track: Track, toLngLat: (x: number, y: number) => [number, number]) {
    type Stretch = { color: string; coords: [number, number][] };
    const out: Stretch[] = [];
    const p = { x: 0, y: 0 };
    let current = null as Stretch | null;
    for (let d = 0; d <= track.length; d += CELL / 2) {
      track.at(d, p);
      const speed = this.speedAt(group, p.x, p.y);
      const color = speed == null ? null : speedColor(speed);
      const point = toLngLat(p.x, p.y);
      if (color && current?.color === color) current.coords.push(point);
      else {
        // Close the last stretch at this point so neighbors meet without gaps.
        current?.coords.push(point);
        current = color ? { color, coords: [point] } : null;
        if (current) out.push(current);
      }
    }
    return out.filter((s) => s.coords.length > 1);
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const now = Date.now();
      const rows = [...this.cells].filter(([, c]) => now - c.at < MAX_AGE_MS).map(([k, c]) => [k, +c.speed.toFixed(2), c.n, c.at]);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {
      // Not saved; this visit still has it.
    }
  }
}
