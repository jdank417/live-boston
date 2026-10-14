// A thin client for the MBTA V3 API (https://api-v3.mbta.com).
//
// The API works without a key at 20 requests a minute per visitor. A key
// raises that to 1,000; set VITE_MBTA_API_KEY at build time to use one.
// It goes in the query string rather than a header so requests stay
// "simple" and skip the CORS preflight.

const BASE = 'https://api-v3.mbta.com';
const KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;

/** 0 light rail (Green, Mattapan), 1 heavy rail (Red, Orange, Blue), 2 commuter rail, 4 ferry. */
export const ROUTE_TYPES = '0,1,2,4';
/** The Silver Line: bus rapid transit, so route type 3, picked out by route. */
export const SILVER_LINE = ['741', '742', '743', '751', '749', '746'];

interface Resource {
  id: string;
  type: string;
  attributes: Record<string, any>;
  relationships?: Record<string, { data: { id: string; type: string } | null }>;
}

interface Document {
  data: Resource[];
  included?: Resource[];
}

export class RateLimited extends Error {
  constructor(public retryAt: number) {
    super('MBTA rate limit reached');
  }
}

async function get(path: string, params: Record<string, string>): Promise<Document> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (KEY) url.searchParams.set('api_key', KEY);
  const res = await fetch(url);
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    throw new RateLimited(reset ? reset * 1000 : Date.now() + 60_000);
  }
  if (!res.ok) throw new Error(`MBTA ${res.status} for ${path}`);
  return res.json();
}

function rel(r: Resource, name: string): string | undefined {
  return r.relationships?.[name]?.data?.id ?? undefined;
}

function index(doc: Document, type: string): Map<string, Resource> {
  return new Map((doc.included ?? []).filter((r) => r.type === type).map((r) => [r.id, r]));
}

function time(s: string | null | undefined) {
  return s ? Date.parse(s) : NaN;
}

// ---------------------------------------------------------------------------
// The network: routes, every shape their trips run on, and which shapes to draw.

export interface Route {
  id: string;
  name: string;
  /** 0 light rail, 1 heavy rail, 2 commuter rail, 3 bus (Silver Line), 4 ferry; 99 for Amtrak (not MBTA). */
  type: number;
  /** Short name, e.g. "SL1". */
  short: string;
  color: string;
  destinations: string[];
}

export interface Network {
  routes: Map<string, Route>;
  /** Every shape a trip on these routes can run, as [lng, lat] points. */
  shapes: Map<string, [number, number][]>;
  /** Shapes of each route's regular service patterns, for drawing the map. */
  routeShapes: Map<string, string[]>;
}

export async function loadNetwork(): Promise<Network> {
  const fields = 'color,long_name,short_name,type,direction_destinations';
  const [rail, silver] = await Promise.all([
    get('/routes', { 'filter[type]': ROUTE_TYPES, 'fields[route]': fields }),
    get('/routes', { 'filter[id]': SILVER_LINE.join(','), 'fields[route]': fields }),
  ]);
  const routes = new Map<string, Route>(
    [...rail.data, ...silver.data].map((r) => [
      r.id,
      {
        id: r.id,
        // Silver Line long names are the full route ("Logan Airport Terminals - South Station").
        name: r.attributes.type === 3 ? `Silver Line ${r.attributes.short_name}` : r.attributes.long_name,
        type: r.attributes.type,
        short: r.attributes.short_name ?? '',
        color: `#${r.attributes.color}`,
        destinations: r.attributes.direction_destinations ?? [],
      },
    ]),
  );
  const ids = [...routes.keys()].join(',');

  // Shapes don't say which route they belong to; route patterns do, through
  // their representative trip.
  const [patterns, shapeDoc] = await Promise.all([
    get('/route_patterns', {
      'filter[route]': ids,
      include: 'representative_trip',
      'fields[route_pattern]': 'typicality',
      'fields[trip]': 'shape',
    }),
    get('/shapes', { 'filter[route]': ids, 'fields[shape]': 'polyline' }),
  ]);

  const shapes = new Map(shapeDoc.data.map((s) => [s.id, decodePolyline(s.attributes.polyline)]));
  const trips = index(patterns, 'trip');
  const routeShapes = new Map<string, string[]>();
  for (const p of patterns.data) {
    // Typicality 4 is a detour or shuttle pattern; leave those off the map.
    if (p.attributes.typicality === 4) continue;
    const route = rel(p, 'route');
    const trip = trips.get(rel(p, 'representative_trip') ?? '');
    const shape = trip && rel(trip, 'shape');
    if (!route || !shape || !routes.has(route) || !shapes.has(shape)) continue;
    const list = routeShapes.get(route) ?? [];
    if (!list.includes(shape)) list.push(shape);
    routeShapes.set(route, list);
  }
  return { routes, shapes, routeShapes };
}

// ---------------------------------------------------------------------------
// Stations

export interface Station {
  id: string;
  name: string;
  lng: number;
  lat: number;
  rail: boolean;
  /** A Silver Line stop that's not also a subway or rail station. */
  bus: boolean;
  /** A ferry pier. */
  ferry: boolean;
  /** Its platforms' stop ids; alerts often name a platform, not the station. */
  children: string[];
}

async function stationsOf(filter: Record<string, string>, rail: boolean, bus = false, ferry = false): Promise<Station[]> {
  // Filtering by route type returns platforms; their parents are the stations.
  const doc = await get('/stops', {
    ...filter,
    include: 'parent_station',
    'fields[stop]': 'name,latitude,longitude',
  });
  const parents = index(doc, 'stop');
  const stations = new Map<string, Station>();
  for (const platform of doc.data) {
    const s = parents.get(rel(platform, 'parent_station') ?? '') ?? platform;
    const station: Station = stations.get(s.id) ?? {
      id: s.id,
      name: s.attributes.name,
      lng: s.attributes.longitude,
      lat: s.attributes.latitude,
      rail,
      bus,
      ferry,
      children: [],
    };
    if (platform.id !== s.id) station.children.push(platform.id);
    stations.set(s.id, station);
  }
  return [...stations.values()];
}

export async function loadStations(): Promise<Station[]> {
  const [subway, rail, silver, piers] = await Promise.all([
    stationsOf({ 'filter[route_type]': '0,1' }, false),
    stationsOf({ 'filter[route_type]': '2' }, true),
    stationsOf({ 'filter[route]': SILVER_LINE.join(',') }, false, true),
    stationsOf({ 'filter[route_type]': '4' }, false, false, true),
  ]);
  // Stations served by several (South Station, Back Bay, …) count as subway.
  const out: Station[] = [];
  const ids = new Set<string>();
  for (const s of [...subway, ...rail, ...silver, ...piers]) {
    const seen = out.find((o) => o.id === s.id);
    if (seen) {
      // A station on several modes: keep every platform.
      for (const c of s.children) if (!seen.children.includes(c)) seen.children.push(c);
      continue;
    }
    ids.add(s.id);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vehicles

export type VehicleStatus = 'IN_TRANSIT_TO' | 'INCOMING_AT' | 'STOPPED_AT';

export interface Vehicle {
  id: string;
  label: string;
  routeId: string;
  tripId?: string;
  /** The public train number, for commuter rail (e.g. "1641"). */
  tripName?: string;
  shapeId?: string;
  headsign?: string;
  directionId: number;
  lng: number;
  lat: number;
  bearing: number | null;
  /** Meters per second, when the MBTA reports it. */
  speed: number | null;
  status: VehicleStatus;
  stopName?: string;
  /** Where the stop it's at or heading to is, for capping dead reckoning. */
  stopLng?: number;
  stopLat?: number;
  /** Cars in the consist, when reported. */
  carriages: number | null;
  /** Epoch ms of this position report. */
  updatedAt: number;
}

/** Every vehicle on these routes, in one request. */
export async function loadVehicles(routeIds: string[]): Promise<Vehicle[]> {
  const doc = await get('/vehicles', {
    'filter[route]': routeIds.join(','),
    include: 'trip,stop',
    'fields[vehicle]':
      'label,latitude,longitude,bearing,speed,current_status,direction_id,carriages,updated_at',
    'fields[trip]': 'headsign,name,shape',
    'fields[stop]': 'name,latitude,longitude',
  });
  const trips = index(doc, 'trip');
  const stops = index(doc, 'stop');
  return doc.data
    .filter((v) => v.attributes.latitude != null && rel(v, 'route'))
    .map((v) => {
      const a = v.attributes;
      const tripId = rel(v, 'trip');
      const trip = tripId ? trips.get(tripId) : undefined;
      const stop = stops.get(rel(v, 'stop') ?? '');
      return {
        id: v.id,
        // Ferries have no label; their id is the vessel's name.
        label: a.label ?? v.id,
        routeId: rel(v, 'route')!,
        tripId,
        tripName: trip?.attributes.name || undefined,
        shapeId: trip ? rel(trip, 'shape') : undefined,
        headsign: trip?.attributes.headsign,
        directionId: a.direction_id,
        lng: a.longitude,
        lat: a.latitude,
        bearing: a.bearing ?? null,
        speed: a.speed ?? null,
        status: a.current_status,
        stopName: stop?.attributes.name,
        stopLng: stop?.attributes.longitude,
        stopLat: stop?.attributes.latitude,
        carriages: a.carriages?.length || null,
        updatedAt: time(a.updated_at),
      };
    });
}

// ---------------------------------------------------------------------------
// Predictions

export interface UpcomingStop {
  name: string;
  /** Epoch ms of arrival (or departure, at the first stop). */
  at: number;
}

/** The stops one trip has left to make. */
export async function loadUpcomingStops(tripId: string): Promise<UpcomingStop[]> {
  const doc = await get('/predictions', {
    'filter[trip]': tripId,
    include: 'stop',
    sort: 'stop_sequence',
    'fields[prediction]': 'arrival_time,departure_time',
    'fields[stop]': 'name',
  });
  const stops = index(doc, 'stop');
  const now = Date.now();
  return doc.data
    .map((p) => ({
      name: stops.get(rel(p, 'stop') ?? '')?.attributes.name ?? 'Unknown stop',
      at: time(p.attributes.arrival_time ?? p.attributes.departure_time),
    }))
    .filter((s) => s.at > now - 30_000);
}

export interface Departure {
  routeId: string;
  headsign: string;
  directionId: number;
  at: number;
  vehicleId?: string;
}

/** Trains due at a station, soonest first. */
export async function loadDepartures(stationId: string): Promise<Departure[]> {
  const doc = await get('/predictions', {
    'filter[stop]': stationId,
    include: 'trip',
    'fields[prediction]': 'arrival_time,departure_time,direction_id',
    'fields[trip]': 'headsign',
  });
  const trips = index(doc, 'trip');
  const now = Date.now();
  return doc.data
    .map((p) => ({
      routeId: rel(p, 'route') ?? '',
      headsign: trips.get(rel(p, 'trip') ?? '')?.attributes.headsign ?? '',
      directionId: p.attributes.direction_id,
      // Departure is what matters to someone waiting; the last stop only has arrival.
      at: time(p.attributes.departure_time ?? p.attributes.arrival_time),
      vehicleId: rel(p, 'vehicle'),
    }))
    .filter((d) => d.at > now - 30_000)
    .sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------

/** Decodes a Google encoded polyline into [lng, lat] pairs. */
export function decodePolyline(encoded: string): [number, number][] {
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
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service alerts

export interface Alert {
  id: string;
  /** e.g. DELAY, SUSPENSION, SHUTTLE, STATION_CLOSURE, ELEVATOR_CLOSURE. */
  effect: string;
  /** e.g. FREIGHT_TRAIN_INTERFERENCE, DRAWBRIDGE_BEING_RAISED, ROUGH_SEAS. */
  cause: string;
  /** 0–10, the MBTA's own scale. */
  severity: number;
  header: string;
  /** A short summary, e.g. "Delays on Red Line". */
  summary: string;
  description: string;
  url: string | null;
  routes: string[];
  stops: string[];
  trips: string[];
  updatedAt: number;
}

/** Alerts in effect right now on these routes. */
export async function loadAlerts(routeIds: string[]): Promise<Alert[]> {
  const doc = await get('/alerts', {
    'filter[route]': routeIds.join(','),
    'filter[datetime]': 'NOW',
    'fields[alert]': 'effect,cause,severity,header,service_effect,short_header,description,url,informed_entity,updated_at',
  });
  return doc.data.map((a) => {
    const x = a.attributes;
    const entities: { route?: string; stop?: string; trip?: string }[] = x.informed_entity ?? [];
    const uniq = (k: 'route' | 'stop' | 'trip') => [...new Set(entities.map((e) => e[k]).filter((v): v is string => !!v))];
    return {
      id: a.id,
      effect: x.effect,
      cause: x.cause,
      severity: x.severity ?? 0,
      header: x.header ?? '',
      summary: x.service_effect || x.short_header || x.header || '',
      description: x.description ?? '',
      url: x.url ?? null,
      routes: uniq('route'),
      stops: uniq('stop'),
      trips: uniq('trip'),
      updatedAt: time(x.updated_at),
    };
  });
}

// ---------------------------------------------------------------------------
// Trip planning: the stops each service pattern makes, and when trips run
// between two stations.

export interface Pattern {
  id: string;
  routeId: string;
  directionId: number;
  headsign: string;
  shapeId?: string;
  /** Its stops in order, as platform ids. */
  stops: string[];
}

/** The regular service patterns of these routes, with their stops in order. */
export async function loadPatterns(routeIds: string[]): Promise<Pattern[]> {
  const doc = await get('/route_patterns', {
    'filter[route]': routeIds.join(','),
    include: 'representative_trip.stops',
    'fields[route_pattern]': 'typicality,direction_id',
    'fields[trip]': 'headsign,shape',
    'fields[stop]': 'name',
  });
  const trips = index(doc, 'trip');
  const out: Pattern[] = [];
  for (const p of doc.data) {
    // 1 typical, 2 a regular variant; the rest are rare, detours or diagrams.
    if (p.attributes.typicality > 2) continue;
    const trip = trips.get(rel(p, 'representative_trip') ?? '');
    const stops = (trip?.relationships?.stops?.data as unknown as { id: string }[] | undefined)?.map((s) => s.id);
    const routeId = rel(p, 'route');
    if (!trip || !routeId || !stops?.length) continue;
    out.push({
      id: p.id,
      routeId,
      directionId: p.attributes.direction_id,
      headsign: trip.attributes.headsign ?? '',
      shapeId: rel(trip, 'shape'),
      stops,
    });
  }
  return out;
}

/** One trip that stops at a station and later at another. */
export interface Run {
  tripId: string;
  routeId: string;
  headsign: string;
  /** Epoch ms it leaves the first station and reaches the second (NaN if unknown). */
  board: number;
  alight: number;
  vehicleId?: string;
  /** From a live prediction rather than the timetable. */
  live: boolean;
}

interface Call {
  trip: string;
  route: string;
  seq: number;
  dep: number;
  arr: number;
  vehicle?: string;
  live: boolean;
  headsign?: string;
}

function pairUp(calls: Call[], from: Set<string>, stopOf: Map<Call, string>): Run[] {
  const byTrip = new Map<string, Call[]>();
  for (const c of calls) byTrip.set(c.trip, [...(byTrip.get(c.trip) ?? []), c]);
  const runs: Run[] = [];
  for (const [trip, cs] of byTrip) {
    // Loops (the harbor ferries) can call at a stop twice: board at the
    // last call that still has the other stop after it, get off at the next.
    cs.sort((x, y) => x.seq - y.seq);
    let a: Call | undefined;
    let b: Call | undefined;
    for (const c of cs) {
      if (from.has(stopOf.get(c)!)) a = c;
      else if (a && !b) b = c;
    }
    if (a && b && b.seq < a.seq) b = undefined;
    if (!a || !b) {
      a = cs.find((c) => from.has(stopOf.get(c)!));
      b = a && cs.find((c) => !from.has(stopOf.get(c)!) && c.seq > a!.seq);
    }
    if (!a || !b) continue;
    const board = Number.isNaN(a.dep) ? a.arr : a.dep;
    if (Number.isNaN(board)) continue;
    runs.push({
      tripId: trip,
      routeId: a.route,
      headsign: a.headsign ?? b.headsign ?? '',
      board,
      alight: Number.isNaN(b.arr) ? b.dep : b.arr,
      vehicleId: a.vehicle ?? b.vehicle,
      live: a.live,
    });
  }
  return runs;
}

const bostonTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const bostonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The timetable's terms for a span of time: its date, and the times on it (past midnight runs on as 24:xx). */
function timetableSpan(start: number, end: number) {
  const date = bostonDate.format(start);
  const min = bostonTime.format(start);
  let max = bostonTime.format(end);
  if (bostonDate.format(end) !== date) max = `${String(Math.min(27, 24 + Number(max.slice(0, 2)))).padStart(2, '0')}${max.slice(2)}`;
  return { date, min, max };
}

/**
 * Trips on these routes from one station to another, soonest first: live
 * predictions, topped up from the timetable when asked (commuter rail and
 * ferries only predict the next few) or when nothing is predicted.
 */
export async function loadRuns(
  from: string[],
  to: string[],
  routeIds: string[],
  timetable: boolean,
  window?: { start: number; end: number },
): Promise<Run[]> {
  const fromSet = new Set(from);
  const stops = [...from, ...to].join(',');
  const routes = routeIds.join(',');
  const now = Date.now();
  // Planning ahead, past what predictions cover: the timetable alone.
  const ahead = !!window && window.start > now + 20 * 60_000;
  const since = window ? Math.max(window.start, ahead ? 0 : now - 30_000) : now - 30_000;
  const until = window?.end ?? now + 6 * 3_600_000;

  const pdoc = ahead ? { data: [], included: [] } : await get('/predictions', {
    'filter[stop]': stops,
    'filter[route]': routes,
    include: 'trip',
    'fields[prediction]': 'arrival_time,departure_time,stop_sequence,schedule_relationship',
    'fields[trip]': 'headsign',
  });
  const ptrips = index(pdoc, 'trip');
  const stopOf = new Map<Call, string>();
  const calls: Call[] = [];
  for (const p of pdoc.data) {
    if (p.attributes.schedule_relationship === 'SKIPPED' || p.attributes.schedule_relationship === 'CANCELLED') continue;
    const trip = rel(p, 'trip');
    if (!trip) continue;
    const c: Call = {
      trip,
      route: rel(p, 'route') ?? '',
      seq: p.attributes.stop_sequence,
      dep: time(p.attributes.departure_time),
      arr: time(p.attributes.arrival_time),
      vehicle: rel(p, 'vehicle'),
      live: true,
      headsign: ptrips.get(trip)?.attributes.headsign,
    };
    stopOf.set(c, rel(p, 'stop') ?? '');
    calls.push(c);
  }
  let runs = pairUp(calls, fromSet, stopOf).filter((r) => r.board > since);

  if (ahead || (timetable && runs.length < 3) || !runs.length) {
    // The timetable, for the next few hours (or the window asked about).
    // Arrivals can come well after the last departure asked about.
    const span = timetableSpan(since, until + 2 * 3_600_000);
    const sdoc = await get('/schedules', {
      'filter[stop]': stops,
      'filter[route]': routes,
      'filter[date]': span.date,
      'filter[min_time]': span.min,
      'filter[max_time]': span.max,
      include: 'trip',
      'fields[schedule]': 'arrival_time,departure_time,stop_sequence',
      'fields[trip]': 'headsign',
    });
    const strips = index(sdoc, 'trip');
    const scalls: Call[] = [];
    for (const s of sdoc.data) {
      const trip = rel(s, 'trip');
      if (!trip) continue;
      const c: Call = {
        trip,
        route: rel(s, 'route') ?? '',
        seq: s.attributes.stop_sequence,
        dep: time(s.attributes.departure_time),
        arr: time(s.attributes.arrival_time),
        live: false,
        headsign: strips.get(trip)?.attributes.headsign,
      };
      stopOf.set(c, rel(s, 'stop') ?? '');
      scalls.push(c);
    }
    const predicted = new Set(runs.map((r) => r.tripId));
    runs = runs.concat(pairUp(scalls, fromSet, stopOf).filter((r) => !predicted.has(r.tripId) && r.board > since && r.board <= until));
  }
  return runs.sort((a, b) => a.board - b.board);
}
