// A thin client for the MBTA V3 API (https://api-v3.mbta.com).
//
// The API works without a key at 20 requests a minute per visitor. A key
// raises that to 1,000; set VITE_MBTA_API_KEY at build time to use one.
// It goes in the query string rather than a header so requests stay
// "simple" and skip the CORS preflight.

const BASE = 'https://api-v3.mbta.com';
const KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;

/** 0 light rail (Green, Mattapan), 1 heavy rail (Red, Orange, Blue), 2 commuter rail. */
export const ROUTE_TYPES = '0,1,2';

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
  /** 0 light rail, 1 heavy rail, 2 commuter rail. */
  type: number;
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
  const routeDoc = await get('/routes', {
    'filter[type]': ROUTE_TYPES,
    'fields[route]': 'color,long_name,type,direction_destinations',
  });
  const routes = new Map<string, Route>(
    routeDoc.data.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.attributes.long_name,
        type: r.attributes.type,
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
}

async function stationsOf(routeTypes: string, rail: boolean): Promise<Station[]> {
  // Filtering by route type returns platforms; their parents are the stations.
  const doc = await get('/stops', {
    'filter[route_type]': routeTypes,
    include: 'parent_station',
    'fields[stop]': 'name,latitude,longitude',
  });
  const parents = index(doc, 'stop');
  const stations = new Map<string, Station>();
  for (const platform of doc.data) {
    const s = parents.get(rel(platform, 'parent_station') ?? '') ?? platform;
    stations.set(s.id, {
      id: s.id,
      name: s.attributes.name,
      lng: s.attributes.longitude,
      lat: s.attributes.latitude,
      rail,
    });
  }
  return [...stations.values()];
}

export async function loadStations(): Promise<Station[]> {
  const [subway, rail] = await Promise.all([stationsOf('0,1', false), stationsOf('2', true)]);
  // Stations served by both (South Station, Back Bay, …) count as subway.
  const ids = new Set(subway.map((s) => s.id));
  return [...subway, ...rail.filter((s) => !ids.has(s.id))];
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
  /** Cars in the consist, when reported. */
  carriages: number | null;
  /** Epoch ms of this position report. */
  updatedAt: number;
}

export async function loadVehicles(): Promise<Vehicle[]> {
  const doc = await get('/vehicles', {
    'filter[route_type]': ROUTE_TYPES,
    include: 'trip,stop',
    'fields[vehicle]':
      'label,latitude,longitude,bearing,speed,current_status,direction_id,carriages,updated_at',
    'fields[trip]': 'headsign,name,shape',
    'fields[stop]': 'name',
  });
  const trips = index(doc, 'trip');
  const stops = index(doc, 'stop');
  return doc.data
    .filter((v) => v.attributes.latitude != null && rel(v, 'route'))
    .map((v) => {
      const a = v.attributes;
      const tripId = rel(v, 'trip');
      const trip = tripId ? trips.get(tripId) : undefined;
      return {
        id: v.id,
        label: a.label,
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
        stopName: stops.get(rel(v, 'stop') ?? '')?.attributes.name,
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
    'filter[route_type]': ROUTE_TYPES,
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
