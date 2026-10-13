import { MercatorCoordinate } from 'maplibre-gl';

// Everything 3D works in local meters around downtown Boston: x east, y north.
// Over the commuter rail's ~60 km reach the Mercator scale drifts by well
// under 1%, which is invisible at train scale.

export const ORIGIN = MercatorCoordinate.fromLngLat([-71.0589, 42.3601], 0);
export const METER = ORIGIN.meterInMercatorCoordinateUnits();

export function toLocal(lng: number, lat: number): [number, number] {
  const m = MercatorCoordinate.fromLngLat([lng, lat], 0);
  return [(m.x - ORIGIN.x) / METER, -(m.y - ORIGIN.y) / METER];
}

export function toLngLat(x: number, y: number): [number, number] {
  const ll = new MercatorCoordinate(ORIGIN.x + x * METER, ORIGIN.y - y * METER, 0).toLngLat();
  return [ll.lng, ll.lat];
}

/** Compass bearing (0 = north, clockwise) from a local angle (0 = east, counterclockwise). */
export function compass(angle: number) {
  return (90 - (angle * 180) / Math.PI + 360) % 360;
}

/**
 * A route shape in local meters, measured by distance along it. Trips run in
 * the direction their shape is drawn, so a train's distance only grows.
 */
export class Track {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Distance from the start to each point. */
  readonly cum: Float64Array;
  readonly length: number;

  constructor(lngLats: [number, number][]) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [lng, lat] of lngLats) {
      const [x, y] = toLocal(lng, lat);
      const n = xs.length;
      if (n && Math.hypot(x - xs[n - 1], y - ys[n - 1]) < 0.01) continue;
      xs.push(x);
      ys.push(y);
    }
    this.x = Float64Array.from(xs);
    this.y = Float64Array.from(ys);
    this.cum = new Float64Array(xs.length);
    for (let i = 1; i < xs.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    this.length = this.cum[xs.length - 1] ?? 0;
  }

  /**
   * The point at distance `d`. Past either end the track carries on straight,
   * the way layover and yard tracks extend beyond where a route's shape stops.
   */
  at(d: number, out: { x: number; y: number } = { x: 0, y: 0 }) {
    const n = this.cum.length;
    if (n === 1) {
      out.x = this.x[0];
      out.y = this.y[0];
      return out;
    }
    if (d <= 0 || d >= this.length) {
      const [i, j, from] = d <= 0 ? [0, 1, 0] : [n - 2, n - 1, this.length];
      const seg = this.cum[j] - this.cum[i];
      const k = (d - from) / seg;
      const [bx, by] = d <= 0 ? [this.x[0], this.y[0]] : [this.x[n - 1], this.y[n - 1]];
      out.x = bx + (this.x[j] - this.x[i]) * k;
      out.y = by + (this.y[j] - this.y[i]) * k;
      return out;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const t = (d - this.cum[lo]) / (this.cum[hi] - this.cum[lo]);
    out.x = this.x[lo] + (this.x[hi] - this.x[lo]) * t;
    out.y = this.y[lo] + (this.y[hi] - this.y[lo]) * t;
    return out;
  }

  /**
   * Snaps a point onto the track. With a `hint` (the train's last distance),
   * a match near it wins over a slightly closer one elsewhere, so a train
   * doesn't jump to the far side of a loop or a parallel stretch.
   */
  project(px: number, py: number, hint?: number): { d: number; off: number } {
    let best = { d: 0, off: Infinity };
    let near = { d: 0, off: Infinity };
    const last = this.x.length - 2;
    for (let i = 0; i <= last; i++) {
      const ax = this.x[i];
      const ay = this.y[i];
      const dx = this.x[i + 1] - ax;
      const dy = this.y[i + 1] - ay;
      const len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      // The end segments may run on past the shape by up to 400 m (see `at`).
      const lo = i === 0 && len ? -400 / len : 0;
      const hi = i === last && len ? 1 + 400 / len : 1;
      const t = len2 ? Math.max(lo, Math.min(hi, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const off = Math.hypot(ax + dx * t - px, ay + dy * t - py);
      const d = this.cum[i] + len * t;
      if (off < best.off) best = { d, off };
      if (hint !== undefined && d > hint - 600 && d < hint + 4000 && off < near.off) near = { d, off };
    }
    return near.off <= best.off + 25 ? near : best;
  }
}
