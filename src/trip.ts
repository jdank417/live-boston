// Getting somewhere: from where you are (or any place) to a station or an
// address, on foot and by T.
//
// Routes are found on a timetable-free model of the network (how long each
// ride and walk usually takes, and a typical wait for each kind of service),
// which is quick and good at picking sensible ways to go. Then each way is
// timed with the MBTA's live predictions, leg by leg: the walk to the first
// station decides which train you can make, that train's arrival decides the
// next one, and so on.

import { Track, toLngLat, toLocal } from './geo';
import { loadRuns, type Network, type Pattern, type Route, type Run, type Station } from './mbta';

export interface Place {
  name: string;
  /** A street and town, for addresses. */
  detail?: string;
  lng: number;
  lat: number;
  /** When the place is a station. */
  stationId?: string;
}

export interface WalkLeg {
  kind: 'walk';
  from: Place;
  to: Place;
  meters: number;
  seconds: number;
  /** The way on foot, when the walking router answered; otherwise straight. */
  path: [number, number][];
  routed: boolean;
}

export interface RideLeg {
  kind: 'ride';
  board: Station;
  alight: Station;
  /** The pattern the plan was found on, for its shape and stop count. */
  pattern: Pattern;
  /** Every route with a trip from board to alight (Green branches, commuter rail lines sharing track). */
  routes: string[];
  stops: number;
  /** The stations it passes on the way, between boarding and getting off. */
  via: Station[];
  /** Typical ride time, before live times are known. */
  seconds: number;
  path: [number, number][];
}

export type Leg = WalkLeg | RideLeg;

export interface Itinerary {
  legs: Leg[];
  /** Typical door-to-door time in seconds, from the model. */
  typical: number;
  /** Found assuming a boat or train leaves soon; only real times can say. */
  hopeful?: boolean;
}

/** An itinerary with real times. */
export interface Timed {
  itin: Itinerary;
  /** When to set off, and when you'd get there (epoch ms). */
  leave: number;
  arrive: number;
  /** Per leg: its start and end, and for rides the trip you'd take and the ones after. */
  legs: { start: number; end: number; run?: Run; later?: Run[]; guessed?: boolean }[];
  /** A ride with no trips coming in the hours looked at (a ferry's midday gap, late at night). */
  unavailable?: boolean;
}

// ---------------------------------------------------------------------------
// The model

const WALK_SPEED = 1.3; // m/s, an easy city pace
/** Streets aren't straight lines. */
const DETOUR = 1.3;
const MAX_ACCESS = 2400; // meters as the crow flies, ~40 min on foot
const FOOTPATH = 450; // walking between nearby stations to change
const DWELL = 25; // seconds at each stop
const MAX_RIDES = 4;

/** Average running speed between stops (m/s) by route type, and the usual wait. */
const RUN_SPEED: Record<number, number> = { 0: 7.5, 1: 13, 2: 21, 3: 6, 4: 9 };
const WAIT: Record<number, number> = { 0: 240, 1: 240, 2: 1200, 3: 360, 4: 1500 };
/** The cost of changing, beyond the walk and the wait: people would rather not. */
const TRANSFER = 150;
/** Walking feels longer than riding. */
const WALK_WEIGHT = 1.25;

const walkSeconds = (meters: number) => (meters * DETOUR) / WALK_SPEED;

interface Seq {
  pattern: Pattern;
  route: Route;
  stations: Station[];
  /** Seconds from the first station to each one. */
  at: number[];
  /** Distance along the shape to each station, and the shape, for drawing. */
  d: number[];
  track?: Track;
}

export class TransitGraph {
  private seqs: Seq[] = [];
  /** Which sequences call at each station, and where in them. */
  private calls = new Map<string, { seq: Seq; i: number }[]>();
  private foot = new Map<string, { to: Station; s: number }[]>();
  private xy = new Map<string, [number, number]>();
  private byId: Map<string, Station>;

  constructor(
    network: Network,
    private stations: Station[],
    patterns: Pattern[],
    stationByStop: Map<string, Station>,
    trackOf: (shapeId: string) => Track | undefined,
  ) {
    this.byId = new Map(stations.map((s) => [s.id, s]));
    for (const s of stations) this.xy.set(s.id, toLocal(s.lng, s.lat));
    for (const p of patterns) {
      const route = network.routes.get(p.routeId);
      if (!route) continue;
      const list: Station[] = [];
      for (const stop of p.stops) {
        const s = stationByStop.get(stop);
        if (s && list[list.length - 1] !== s) list.push(s);
      }
      if (list.length < 2) continue;
      const track = p.shapeId ? trackOf(p.shapeId) : undefined;
      const d: number[] = [];
      let hint: number | undefined;
      for (const s of list) {
        const [x, y] = this.xy.get(s.id)!;
        const pr = track?.project(x, y, hint);
        d.push(pr && pr.off < 300 ? pr.d : NaN);
        if (pr) hint = pr.d;
      }
      const speed = RUN_SPEED[route.type] ?? 8;
      const at = [0];
      for (let i = 1; i < list.length; i++) {
        const [ax, ay] = this.xy.get(list[i - 1].id)!;
        const [bx, by] = this.xy.get(list[i].id)!;
        const along = d[i] - d[i - 1];
        const meters = along > 0 ? along : Math.hypot(bx - ax, by - ay) * 1.15;
        at.push(at[i - 1] + meters / speed + DWELL);
      }
      const seq: Seq = { pattern: p, route, stations: list, at, d, track };
      this.seqs.push(seq);
      list.forEach((s, i) => {
        const c = this.calls.get(s.id) ?? [];
        c.push({ seq, i });
        this.calls.set(s.id, c);
      });
    }
    // Changing between stations a short walk apart (Downtown Crossing and Park
    // Street are one station underground, but two on the map).
    const served = stations.filter((s) => this.calls.has(s.id));
    for (const a of served) {
      const [ax, ay] = this.xy.get(a.id)!;
      for (const b of served) {
        if (a === b) continue;
        const [bx, by] = this.xy.get(b.id)!;
        const m = Math.hypot(bx - ax, by - ay);
        if (m > FOOTPATH) continue;
        const list = this.foot.get(a.id) ?? [];
        list.push({ to: b, s: walkSeconds(m) });
        this.foot.set(a.id, list);
      }
    }
  }

  get ready() {
    return this.seqs.length > 0;
  }

  private near(lng: number, lat: number, stationId?: string) {
    const [x, y] = toLocal(lng, lat);
    const out: { s: Station; meters: number }[] = [];
    for (const s of this.stations) {
      if (!this.calls.has(s.id)) continue;
      const [sx, sy] = this.xy.get(s.id)!;
      const m = s.id === stationId ? 0 : Math.hypot(sx - x, sy - y);
      if (m <= MAX_ACCESS) out.push({ s, meters: m });
    }
    return out;
  }

  /**
   * Good ways from one place to another: the fastest, and faster-to-explain
   * ones with fewer changes, and one that avoids the best one's first line.
   */
  plan(from: Place, to: Place): Itinerary[] {
    const out: Itinerary[] = [];
    const seen = new Map<string, number>();
    const add = (it: Itinerary | null) => {
      if (!it) return;
      const key = it.legs.map((l) => (l.kind === 'ride' ? `${l.board.id}>${l.alight.id}` : 'w')).join('|');
      const i = seen.get(key);
      // The same way found twice: keep the hopeful estimate, so it gets timed.
      if (i !== undefined) {
        if (it.typical < out[i].typical) out[i] = it;
        return;
      }
      seen.set(key, out.length);
      out.push(it);
    };
    const first = this.search(from, to);
    first.forEach(add);
    const lead = out[0]?.legs.find((l): l is RideLeg => l.kind === 'ride');
    if (lead) this.search(from, to, new Set(lead.routes)).forEach(add);
    // A genuinely different way: none of the best one's lines.
    const used = new Set(out[0]?.legs.flatMap((l) => (l.kind === 'ride' ? l.routes : [])) ?? []);
    if (used.size) this.search(from, to, used).forEach(add);
    // Boats and commuter rail run every half hour or more, so on paper they
    // lose to the subway. But when one is about to leave it can be the best
    // way by far: try them as if one were, and let the real times decide.
    this.search(from, to, undefined, true).forEach((it) => {
      // Only ways that ride one of them are worth the hope.
      if (it.legs.some((l) => l.kind === 'ride' && /^(CR-|Boat-)/.test(l.pattern.routeId))) add({ ...it, hopeful: true });
    });

    // Close enough to walk.
    const [fx, fy] = toLocal(from.lng, from.lat);
    const [tx, ty] = toLocal(to.lng, to.lat);
    const direct = Math.hypot(tx - fx, ty - fy);
    if (direct < 3200) {
      const walk = this.walk(from, to, direct);
      const best = out[0]?.typical ?? Infinity;
      // Worth showing when it's not much slower than riding.
      if (walk.seconds < best * 1.6 || walk.seconds < 900) add({ legs: [walk], typical: walk.seconds });
    }
    // Alternatives that take far longer only get in the way. Hopeful ones
    // don't set the bar; the best of them rides along second, to be timed.
    const sure = out.filter((o) => !o.hopeful).sort((a, b) => a.typical - b.typical);
    const fastest = sure[0]?.typical ?? Infinity;
    const hope = out.filter((o) => o.hopeful && o.typical < fastest).sort((a, b) => a.typical - b.typical)[0];
    const kept = sure.filter((o) => o.typical <= fastest * 1.35 + 120);
    if (!kept.length) return hope ? [hope] : [];
    return [kept[0], ...(hope ? [hope] : []), ...kept.slice(1)].slice(0, 4);
  }

  private walk(from: Place, to: Place, crow?: number): WalkLeg {
    const [fx, fy] = toLocal(from.lng, from.lat);
    const [tx, ty] = toLocal(to.lng, to.lat);
    const m = crow ?? Math.hypot(tx - fx, ty - fy);
    return {
      kind: 'walk',
      from,
      to,
      meters: m * DETOUR,
      seconds: walkSeconds(m),
      path: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
      routed: false,
    };
  }

  /** Round-based search (RAPTOR): round k is the best you can do with k rides. */
  private search(from: Place, to: Place, avoid?: Set<string>, hopeful = false): Itinerary[] {
    type Label =
      | { t: number; how: 'access'; meters: number }
      | { t: number; how: 'ride'; seq: Seq; b: number; a: number }
      | { t: number; how: 'foot'; from: Station };
    const access = this.near(from.lng, from.lat, from.stationId);
    const egress = new Map(this.near(to.lng, to.lat, to.stationId).map((e) => [e.s.id, e.meters]));
    if (!access.length || !egress.size) return [];

    // Per round, labels reached by riding and by walking over to change are
    // kept apart, so a walk always leads back to a ride.
    const rides: Map<string, Label>[] = [new Map()];
    const walks: Map<string, Label>[] = [new Map()];
    const label = (r: number, id: string) => {
      const a = rides[r].get(id);
      const b = walks[r].get(id);
      return a && b ? (a.t <= b.t ? a : b) : (a ?? b);
    };
    const best = new Map<string, number>();
    for (const { s, meters } of access) {
      const t = walkSeconds(meters) * WALK_WEIGHT;
      rides[0].set(s.id, { t, how: 'access', meters });
      best.set(s.id, t);
    }
    let marked = new Set(rides[0].keys());
    const results: { k: number; station: string; t: number }[] = [];
    let bestDest = Infinity;

    for (let k = 1; k <= MAX_RIDES && marked.size; k++) {
      const ride = new Map<string, Label>();
      const walk = new Map<string, Label>();
      rides.push(ride);
      walks.push(walk);
      // Each sequence once, from the earliest marked station on it.
      const queue = new Map<Seq, number>();
      for (const id of marked) {
        for (const { seq, i } of this.calls.get(id) ?? []) {
          if (avoid?.has(seq.route.id)) continue;
          const q = queue.get(seq);
          if (q === undefined || i < q) queue.set(seq, i);
        }
      }
      const improved = new Set<string>();
      for (const [seq, start] of queue) {
        let board = -1;
        let boardT = Infinity;
        const usual = WAIT[seq.route.type] ?? 600;
        const wait = (hopeful && (seq.route.type === 2 || seq.route.type === 4) ? 300 : usual) + (k > 1 ? TRANSFER : 0);
        for (let i = start; i < seq.stations.length; i++) {
          const id = seq.stations[i].id;
          if (board >= 0) {
            const t = boardT + seq.at[i] - seq.at[board];
            if (t < (best.get(id) ?? Infinity) && t < bestDest) {
              ride.set(id, { t, how: 'ride', seq, b: board, a: i });
              best.set(id, t);
              improved.add(id);
            }
          }
          const p = label(k - 1, id);
          if (p && (board < 0 || p.t + wait < boardT + seq.at[i] - seq.at[board])) {
            board = i;
            boardT = p.t + wait;
          }
        }
      }
      // Then a short walk to change stations.
      for (const id of [...improved]) {
        const l = ride.get(id);
        if (!l) continue;
        for (const { to: s, s: secs } of this.foot.get(id) ?? []) {
          const t = l.t + secs * WALK_WEIGHT;
          if (t < (best.get(s.id) ?? Infinity) && t < bestDest) {
            walk.set(s.id, { t, how: 'foot', from: this.byId.get(id)! });
            best.set(s.id, t);
            improved.add(s.id);
          }
        }
      }
      // The best way to finish this round.
      let roundBest: { station: string; t: number } | null = null;
      for (const id of improved) {
        const m = egress.get(id);
        if (m === undefined) continue;
        const t = label(k, id)!.t + walkSeconds(m) * WALK_WEIGHT;
        if (!roundBest || t < roundBest.t) roundBest = { station: id, t };
      }
      if (roundBest && roundBest.t < bestDest) {
        bestDest = roundBest.t;
        results.push({ k, ...roundBest });
      }
      marked = improved;
    }

    return results.map(({ k, station, t }) => {
      const legs: Leg[] = [];
      let id = station;
      for (let r = k; r >= 0; r--) {
        let l = label(r, id)!;
        if (l.how === 'foot') {
          legs.unshift(this.walk(placeOf(l.from), placeOf(this.byId.get(id)!)));
          id = l.from.id;
          l = rides[r].get(id)!;
        }
        if (l.how === 'access') {
          if (l.meters > 30) legs.unshift(this.walk(from, placeOf(this.byId.get(id)!)));
          break;
        }
        if (l.how === 'ride') {
          legs.unshift(this.ride(l.seq, l.b, l.a));
          id = l.seq.stations[l.b].id;
        }
      }
      if ((egress.get(station) ?? 0) > 30) legs.push(this.walk(placeOf(this.byId.get(station)!), to));
      return { legs, typical: t };
    });
  }

  private ride(seq: Seq, b: number, a: number): RideLeg {
    const board = seq.stations[b];
    const alight = seq.stations[a];
    // Every route of the same kind that runs from here to there, so any of
    // their trains will do (the Green Line's branches, commuter rail lines
    // sharing track). The Red Line and the Old Colony lines both run Quincy
    // to South Station, but that's a different ride.
    const routes = new Set<string>([seq.route.id]);
    for (const { seq: other, i } of this.calls.get(board.id) ?? []) {
      if (other.route.type !== seq.route.type) continue;
      const j = other.stations.indexOf(alight, i + 1);
      if (j > i) routes.add(other.route.id);
    }
    let path: [number, number][] = [];
    const lo = seq.d[b];
    const hi = seq.d[a];
    if (seq.track && hi > lo) path = slice(seq.track, lo, hi);
    else path = seq.stations.slice(b, a + 1).map((s) => [s.lng, s.lat]);
    return {
      kind: 'ride',
      board,
      alight,
      pattern: seq.pattern,
      routes: [...routes],
      stops: a - b,
      via: seq.stations.slice(b + 1, a),
      seconds: seq.at[a] - seq.at[b],
      path,
    };
  }
}

function placeOf(s: Station): Place {
  return { name: s.name, lng: s.lng, lat: s.lat, stationId: s.id };
}

/** Part of a track as map coordinates, following its curves. */
function slice(track: Track, lo: number, hi: number): [number, number][] {
  const pts: [number, number][] = [];
  const push = (x: number, y: number) => pts.push(toLngLat(x, y));
  const a = track.at(lo);
  push(a.x, a.y);
  for (let i = 0; i < track.cum.length; i++) if (track.cum[i] > lo && track.cum[i] < hi) push(track.x[i], track.y[i]);
  const b = track.at(hi);
  push(b.x, b.y);
  return pts;
}

// ---------------------------------------------------------------------------
// Live times

/** A short cache, so the same leg asked twice in a few seconds is one request. */
const runCache = new Map<string, { at: number; runs: Promise<Run[]> }>();

/**
 * Trips for a ride, soonest first. With a window (planning ahead), the
 * timetable for then; otherwise live predictions from now.
 */
export function runsFor(leg: RideLeg, maxAge = 20_000, window?: { start: number; end: number }): Promise<Run[]> {
  const span = window ? `@${Math.round(window.start / 600_000)}-${Math.round(window.end / 600_000)}` : '';
  const key = `${leg.board.id}>${leg.alight.id}:${leg.routes.join(',')}${span}`;
  const hit = runCache.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.runs;
  // Commuter rail and ferries only predict their next few trips; the timetable fills in.
  const sparse = leg.routes.some((id) => /^(CR-|Boat-)/.test(id));
  const runs = loadRuns([leg.board.id, ...leg.board.children], [leg.alight.id, ...leg.alight.children], leg.routes, sparse, window);
  runCache.set(key, { at: Date.now(), runs });
  runs.catch(() => runCache.delete(key));
  return runs;
}

/** A minute to get from the street to the platform, or across one to change. */
const PLATFORM = 60_000;

/** Times an itinerary: which trains you'd make, starting out at `start` at the earliest. */
export function schedule(itin: Itinerary, runs: (Run[] | null)[], start: number): Timed {
  let t = start;
  const legs: Timed['legs'] = [];
  let firstBoard: number | null = null;
  let walkBefore = 0;
  let unavailable = false;
  itin.legs.forEach((leg, i) => {
    if (leg.kind === 'walk') {
      const end = t + leg.seconds * 1000;
      legs.push({ start: t, end });
      if (firstBoard === null) walkBefore += leg.seconds * 1000;
      t = end;
      return;
    }
    const ready = t + (i > 0 || walkBefore ? PLATFORM : 0);
    const options = (runs[i] ?? []).filter((r) => r.board >= ready - 20_000);
    const run = options[0];
    if (run) {
      const alight = Number.isNaN(run.alight) ? run.board + leg.seconds * 1000 : run.alight;
      legs.push({ start: run.board, end: alight, run, later: options.slice(1, 3) });
      if (firstBoard === null) firstBoard = run.board;
      t = alight;
    } else {
      // The MBTA answered, and nothing runs: this way isn't on.
      if (runs[i]) unavailable = true;
      // No trip known: allow the usual wait and ride.
      const board = ready + 4 * 60_000;
      legs.push({ start: board, end: board + leg.seconds * 1000, guessed: true });
      if (firstBoard === null) firstBoard = board;
      t = board + leg.seconds * 1000;
    }
  });
  // Set off just in time for the first train, with a minute to reach the platform.
  const leave = firstBoard !== null ? Math.max(start, firstBoard - walkBefore - (walkBefore ? PLATFORM : 0)) : start;
  // Shift the opening walk to end just before the first train.
  if (firstBoard !== null && legs.length && itin.legs[0].kind === 'walk') {
    const shift = leave - legs[0].start;
    legs[0] = { start: legs[0].start + shift, end: legs[0].end + shift };
  }
  return { itin, leave, arrive: t, legs, unavailable };
}

/** Times an itinerary to arrive by `deadline`: the latest trains that still make it. */
export function scheduleBy(itin: Itinerary, runs: (Run[] | null)[], deadline: number): Timed {
  const first = itin.legs.findIndex((l) => l.kind === 'ride');
  if (first < 0) return schedule(itin, runs, deadline - itin.legs.reduce((a, l) => a + l.seconds, 0) * 1000);
  const before = itin.legs.slice(0, first).reduce((a, l) => a + l.seconds * 1000, 0) + (first > 0 ? PLATFORM : 0);
  const options = (runs[first] ?? []).filter((r) => r.board <= deadline).sort((a, b) => b.board - a.board);
  for (const r of options) {
    const t = schedule(itin, runs, r.board - before);
    if (t.arrive <= deadline) return t;
  }
  // No timetable that makes it: the usual time, ending at the deadline.
  return schedule(itin, runs, deadline - itin.typical * 1000);
}

// ---------------------------------------------------------------------------
// The way on foot: Valhalla, the open-source router behind OpenStreetMap's
// own directions. If it's busy or down, the walk is drawn straight.

const walkCache = new Map<string, Promise<{ path: [number, number][]; meters: number; seconds: number } | null>>();

export function walkingRoute(from: Place, to: Place) {
  const key = [from.lng, from.lat, to.lng, to.lat].map((n) => n.toFixed(4)).join(',');
  let hit = walkCache.get(key);
  if (!hit) {
    hit = fetchWalk(from, to);
    walkCache.set(key, hit);
  }
  return hit;
}

async function fetchWalk(from: Place, to: Place) {
  const body = {
    locations: [
      { lat: from.lat, lon: from.lng },
      { lat: to.lat, lon: to.lng },
    ],
    costing: 'pedestrian',
    directions_type: 'none',
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    // A GET keeps it a "simple" request, without a CORS preflight.
    const res = await fetch(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(body))}`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const leg = json.trip?.legs?.[0];
    if (!leg?.shape) return null;
    return { path: decode6(leg.shape), meters: leg.summary.length * 1000, seconds: leg.summary.time };
  } catch {
    return null;
  }
}

/** Valhalla's polylines carry six decimal places. */
function decode6(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

/** Fills in the real walking routes, in place. */
export async function routeWalks(itin: Itinerary) {
  await Promise.all(
    itin.legs.map(async (leg) => {
      if (leg.kind !== 'walk' || leg.routed) return;
      const r = await walkingRoute(leg.from, leg.to);
      if (!r) return;
      leg.path = r.path;
      leg.meters = r.meters;
      leg.seconds = r.seconds;
      leg.routed = true;
    }),
  );
}

// ---------------------------------------------------------------------------
// Addresses and places, kept to eastern Massachusetts and nearby. Photon
// (OpenStreetMap search built for search-as-you-type) answers while typing.
// It's a free public service and sometimes down; then Nominatim,
// OpenStreetMap's own search, answers instead, but only when asked outright
// (its rules don't allow as-you-type).

const BBOX = [-71.95, 41.6, -70.55, 42.95];
let photonDownUntil = 0;

/** Whether search-as-you-type is working; if not, addresses need Enter. */
export const typeaheadUp = () => Date.now() > photonDownUntil;

export async function searchPlaces(q: string, signal?: AbortSignal, submitted = false): Promise<Place[]> {
  if (typeaheadUp()) {
    try {
      return rank(q, await photon(q, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      photonDownUntil = Date.now() + 5 * 60_000;
    }
  }
  if (!submitted) return [];
  return rank(q, await nominatim(q, signal));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter(Boolean);

/** Places named with every word typed first ("fenway park" is Fenway Park, not a park on Fenway Street). */
function rank(q: string, places: Place[]) {
  const want = words(q);
  const score = (p: Place) => {
    const name = words(p.name);
    const all = words(`${p.name} ${p.detail ?? ''}`);
    return want.every((w) => name.some((n) => n.startsWith(w))) ? 2 : want.every((w) => all.some((n) => n.startsWith(w))) ? 1 : 0;
  };
  // A stable sort keeps the service's own order within each tier.
  return places.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
}

async function photon(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('lat', '42.3601');
  url.searchParams.set('lon', '-71.0589');
  url.searchParams.set('bbox', BBOX.join(','));
  url.searchParams.set('limit', '7');
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 3500);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Photon ${res.status}`);
    const json = await res.json();
    return dedupe(
      (json.features ?? []).map((f: any) => {
        const p = f.properties ?? {};
        const [lng, lat] = f.geometry?.coordinates ?? [];
        const street = [p.housenumber, p.street].filter(Boolean).join(' ');
        return {
          name: p.name ?? street ?? p.city,
          detail: [p.name ? street : '', p.district && p.district !== p.city ? p.district : '', p.city ?? p.county].filter(Boolean).join(', '),
          lng,
          lat,
        };
      }),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function nominatim(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '7');
  url.searchParams.set('viewbox', `${BBOX[0]},${BBOX[3]},${BBOX[2]},${BBOX[1]}`);
  url.searchParams.set('bounded', '1');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const json: any[] = await res.json();
  return dedupe(
    json.map((r) => {
      const a = r.address ?? {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const town = a.city ?? a.town ?? a.village ?? a.county;
      return {
        name: r.name || street || town || r.display_name,
        detail: [r.name ? street : '', a.suburb && a.suburb !== town ? a.suburb : '', town].filter(Boolean).join(', '),
        lng: Number(r.lon),
        lat: Number(r.lat),
      };
    }),
  );
}

function dedupe(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    if (!p.name || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return false;
    const key = `${p.name}|${p.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
