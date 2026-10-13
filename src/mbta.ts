// A thin client for the MBTA V3 API (https://api-v3.mbta.com).
//
// The API works without a key at 20 requests a minute per visitor. A key
// raises that to 1,000; set VITE_MBTA_API_KEY at build time to use one.
// It goes in the query string rather than a header so requests stay
// "simple" and skip the CORS preflight.

const BASE = 'https://api-v3.mbta.com';
const KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;

/** Subway and light rail: 0 is light rail (Green, Mattapan), 1 is heavy rail. */
export const RAPID_TRANSIT = '0,1';

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
  return r.relationships?.[name]?.data?.id;
}

function index(doc: Document, type: string): Map<string, Resource> {
  return new Map((doc.included ?? []).filter((r) => r.type === type).map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Lines

export interface Line {
  id: string;
  name: string;
  color: string;
  /** Destinations for direction 0 and 1, e.g. ["Ashmont/Braintree", "Alewife"]. */
  destinations: string[];
  /** One [lng, lat] path per canonical branch. */
  paths: [number, number][][];
}

export async function loadLines(): Promise<Line[]> {
  const routes = await get('/routes', {
    'filter[type]': RAPID_TRANSIT,
    'fields[route]': 'color,long_name,direction_destinations',
  });
  // Route patterns can't be filtered by route type, only by route.
  const patterns = await get('/route_patterns', {
    'filter[route]': routes.data.map((r) => r.id).join(','),
    'filter[canonical]': 'true',
    'filter[direction_id]': '0',
    include: 'representative_trip.shape',
    'fields[route_pattern]': 'name',
    'fields[shape]': 'polyline',
  });

  const trips = index(patterns, 'trip');
  const shapes = index(patterns, 'shape');
  const paths = new Map<string, [number, number][][]>();
  for (const p of patterns.data) {
    const route = rel(p, 'route');
    const trip = trips.get(rel(p, 'representative_trip') ?? '');
    const shape = trip && shapes.get(rel(trip, 'shape') ?? '');
    if (!route || !shape) continue;
    const list = paths.get(route) ?? [];
    list.push(decodePolyline(shape.attributes.polyline));
    paths.set(route, list);
  }

  return routes.data.map((r) => ({
    id: r.id,
    name: r.attributes.long_name,
    color: `#${r.attributes.color}`,
    destinations: r.attributes.direction_destinations ?? [],
    paths: paths.get(r.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Stations

export interface Station {
  id: string;
  name: string;
  lng: number;
  lat: number;
}

export async function loadStations(): Promise<Station[]> {
  // Filtering by route type returns platforms; their parents are the stations.
  const doc = await get('/stops', {
    'filter[route_type]': RAPID_TRANSIT,
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
    });
  }
  return [...stations.values()];
}

// ---------------------------------------------------------------------------
// Vehicles

export type VehicleStatus = 'IN_TRANSIT_TO' | 'INCOMING_AT' | 'STOPPED_AT';

export interface Vehicle {
  id: string;
  label: string;
  routeId: string;
  tripId?: string;
  headsign?: string;
  directionId: number;
  lng: number;
  lat: number;
  bearing: number;
  status: VehicleStatus;
  stopName?: string;
  carriages: number;
  updatedAt: string;
}

export async function loadVehicles(): Promise<Vehicle[]> {
  const doc = await get('/vehicles', {
    'filter[route_type]': RAPID_TRANSIT,
    include: 'trip,stop',
    'fields[vehicle]': 'label,latitude,longitude,bearing,current_status,direction_id,carriages,updated_at',
    'fields[trip]': 'headsign',
    'fields[stop]': 'name',
  });
  const trips = index(doc, 'trip');
  const stops = index(doc, 'stop');
  return doc.data
    .filter((v) => v.attributes.latitude != null && rel(v, 'route'))
    .map((v) => {
      const a = v.attributes;
      const tripId = rel(v, 'trip');
      return {
        id: v.id,
        label: a.label,
        routeId: rel(v, 'route')!,
        tripId,
        headsign: tripId ? trips.get(tripId)?.attributes.headsign : undefined,
        directionId: a.direction_id,
        lng: a.longitude,
        lat: a.latitude,
        bearing: a.bearing ?? 0,
        status: a.current_status,
        stopName: stops.get(rel(v, 'stop') ?? '')?.attributes.name,
        carriages: a.carriages?.length ?? 0,
        updatedAt: a.updated_at,
      };
    });
}

// ---------------------------------------------------------------------------
// Predictions for one trip: the stops it has left to make.

export interface UpcomingStop {
  name: string;
  /** Epoch ms of arrival (or departure, at the first stop). */
  at: number;
}

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
    .map((p) => {
      const time = p.attributes.arrival_time ?? p.attributes.departure_time;
      return {
        name: stops.get(rel(p, 'stop') ?? '')?.attributes.name ?? 'Unknown stop',
        at: time ? Date.parse(time) : NaN,
      };
    })
    .filter((s) => s.at > now - 30_000);
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
