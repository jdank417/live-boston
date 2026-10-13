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
