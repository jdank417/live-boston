import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { Color } from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { basemap, PALETTE } from './basemap';
import { loadDocks, type Dock } from './bikes';
import { causeLabel, effectLabel, EXTERNAL, isDisruptive, kindOf as alertKind } from './alerts';
import { loadAmtrak, type AmtrakTrain } from './amtrak';
import { compass, toLngLat, toLocal, Track } from './geo';
import {
  loadAlerts,
  loadDepartures,
  loadNetwork,
  loadPatterns,
  loadStations,
  loadUpcomingStops,
  loadVehicles,
  RateLimited,
  type Alert,
  type Departure,
  type Network,
  type Route,
  type Run,
  type Station,
  type UpcomingStop,
  type Vehicle,
} from './mbta';
import { install, installMode, onInstallChange, registerServiceWorker } from './pwa';
import { search, type SearchItem } from './search';
import { isPhone, Sheet } from './sheet';
import { blend, SKY, skyAt, sunTimes, type SkyState } from './sky';
import { SPEED_SCALE, SpeedMap } from './speedmap';
import { TrainLayer, type Car } from './trains3d';
import {
  routeWalks,
  runsFor,
  schedule,
  scheduleBy,
  searchPlaces,
  TransitGraph,
  typeaheadUp,
  type Itinerary,
  type Place,
  type RideLeg,
  type Timed,
} from './trip';
import { CLEAR, loadWeather, Precipitation, weatherOverride, type Weather } from './weather';

const POLL_MS = 12_000;
const AMTRAK_MS = 60_000;
const ALERTS_MS = 90_000;
const COMMUTE_MS = 30_000;
const PANEL_REFRESH_MS = 20_000;
const TOUR_MS = 25_000;
const BIKES_MS = 60_000;
const WEATHER_MS = 15 * 60_000;
/** After this long without a touch, the overview slowly circles the city. */
const IDLE_ORBIT_MS = 30_000;
/** Reports this old are trains the MBTA has lost track of; leave them off. */
const STALE_MS = 10 * 60_000;
const OVERVIEW: [[number, number], [number, number]] = [
  [-71.13, 42.31],
  [-71.0, 42.4],
];

// ---------------------------------------------------------------------------
// Lines and their trains

interface Group {
  id: string;
  label: string;
  match: (r: Route) => boolean;
  /** What its vehicles are called in counts. */
  unit: string;
  /** For groups whose routes only appear once their vehicles do. */
  color?: string;
}

/** Amtrak's stand-in route type; the MBTA's run 0–4. */
const AMTRAK_TYPE = 99;
const AMTRAK_COLOR = '#8b9cff';

const GROUPS: Group[] = [
  { id: 'Red', label: 'Red Line', unit: 'trains', match: (r) => r.id === 'Red' },
  { id: 'Orange', label: 'Orange Line', unit: 'trains', match: (r) => r.id === 'Orange' },
  { id: 'Blue', label: 'Blue Line', unit: 'trains', match: (r) => r.id === 'Blue' },
  { id: 'Green', label: 'Green Line', unit: 'trains', match: (r) => r.id.startsWith('Green-') },
  { id: 'Mattapan', label: 'Mattapan Trolley', unit: 'trolleys', match: (r) => r.id === 'Mattapan' },
  { id: 'SL', label: 'Silver Line', unit: 'buses', match: (r) => r.type === 3 },
  { id: 'CR', label: 'Commuter Rail', unit: 'trains', match: (r) => r.type === 2 },
  { id: 'Ferry', label: 'Ferries', unit: 'boats', match: (r) => r.type === 4 },
  // Not the MBTA, but on its tracks: the Providence and Worcester lines, and
  // North and South Station.
  { id: 'Amtrak', label: 'Amtrak', unit: 'trains', color: AMTRAK_COLOR, match: (r) => r.type === AMTRAK_TYPE },
];
const groupOf = (r: Route) => GROUPS.find((g) => g.match(r))?.id ?? r.id;
const kindOf = (r: Route) => (r.type === 2 ? 'rail' : r.type === 3 ? 'bus' : r.type === 4 ? 'ferry' : 'subway');
const isAmtrak = (id: string) => id.startsWith('amtrak-');

/** Brand colors, with the darkest brightened so they hold up on a dark map. */
const ON_DARK: Record<string, string> = {
  '#003DA5': '#3b82f6', // Blue Line
  '#80276C': '#c050ad', // Commuter Rail
  '#7C878E': '#b4bec6', // Silver Line
  '#00843D': '#16a34a', // Green Line
  '#008EAA': '#22b8cf', // Ferries
};
function displayColor(hex: string) {
  return ON_DARK[hex.toUpperCase()] ?? hex;
}

interface CarSpec {
  length: number;
  width: number;
  height: number;
  body: string;
  boat?: boolean;
}

// Real car dimensions in meters (length over couplers, width, height to roof).
const STAINLESS = '#d9dee6';
const CARS: Record<string, CarSpec & { usual: number }> = {
  Red: { length: 21.5, width: 3.05, height: 3.7, body: STAINLESS, usual: 6 },
  Orange: { length: 19.8, width: 3.0, height: 3.66, body: STAINLESS, usual: 6 },
  Blue: { length: 14.8, width: 2.85, height: 3.6, body: STAINLESS, usual: 6 },
  Green: { length: 22.7, width: 2.65, height: 3.5, body: '#e6e9ed', usual: 2 },
  Mattapan: { length: 14.2, width: 2.6, height: 3.2, body: '#ece6d4', usual: 1 },
};
const LOCOMOTIVE: CarSpec = { length: 20.7, width: 3.2, height: 4.4, body: '#2c2230' };
const BILEVEL: CarSpec = { length: 25.9, width: 3.2, height: 4.9, body: '#ccd1d9' };
// An 18 m articulated bus, as its two sections.
const BUS_FRONT: CarSpec = { length: 11, width: 2.6, height: 3.3, body: '#d3d8de' };
const BUS_REAR: CarSpec = { length: 7, width: 2.6, height: 3.3, body: '#d3d8de' };

// MBTA harbor ferries are 25–35 m catamarans.
const FERRY: CarSpec = { length: 30, width: 9.5, height: 6.5, body: '#e7ebef', boat: true };
// Amtrak: Acela trainsets, and a locomotive with Amfleet coaches for the rest.
const ACELA_POWER: CarSpec = { length: 21, width: 3.2, height: 4.3, body: '#eef1f4' };
const ACELA_COACH: CarSpec = { length: 26.5, width: 3.2, height: 4.1, body: '#f3f5f7' };
const AMTRAK_LOCO: CarSpec = { length: 20.5, width: 3.1, height: 4.4, body: '#aeb6c1' };
const AMFLEET: CarSpec = { length: 25.9, width: 3.2, height: 3.9, body: '#d3d8de' };

/** The consist to draw, and whether its size is a typical one rather than reported. */
function consist(route: Route, reported: number | null): { cars: CarSpec[]; estimated: boolean; gap: number } {
  if (route.type === 4) return { cars: [FERRY], estimated: false, gap: 0 };
  if (route.type === AMTRAK_TYPE) {
    // Amtrak doesn't report consists either; these are the usual sets.
    if (route.short === 'Acela') return { cars: [ACELA_POWER, ...Array(6).fill(ACELA_COACH), ACELA_POWER], estimated: true, gap: 0.8 };
    const coaches = route.short === 'Downeaster' ? 5 : 7;
    return { cars: [AMTRAK_LOCO, ...Array(coaches).fill(AMFLEET)], estimated: true, gap: 1 };
  }
  if (route.type === 3) return { cars: [BUS_FRONT, BUS_REAR], estimated: false, gap: 0.35 };
  if (route.type === 2) {
    // Commuter rail doesn't report its consist; draw a typical push-pull set.
    return { cars: [LOCOMOTIVE, ...Array(6).fill(BILEVEL)], estimated: true, gap: 1.2 };
  }
  const spec = CARS[groupOf(route)] ?? CARS.Red;
  const n = reported ?? spec.usual;
  return { cars: Array(n).fill(spec), estimated: reported == null, gap: 1.2 };
}

/** Running speeds between stations (m/s), for a train before its speed is measured. */
const TYPICAL_SPEED: Record<string, number> = {
  Red: 11,
  Orange: 11,
  Blue: 10,
  Green: 6,
  Mattapan: 6,
  SL: 6,
  CR: 20,
  Ferry: 9,
  Amtrak: 30,
};

/**
 * The most a drawn train may reach (m/s), about each line's real top speed.
 * Faster "measured" speeds are position jumps, not motion.
 */
const MAX_SPEED: Record<string, number> = {
  Red: 25,
  Orange: 25,
  Blue: 22,
  Green: 20,
  Mattapan: 13,
  SL: 22,
  CR: 36,
  Ferry: 15,
  Amtrak: 67,
};
const maxSpeed = (group: string) => MAX_SPEED[group] ?? 25;
/** Service braking (m/s²): drawn trains slow for a stop the way real ones do. */
const BRAKE = 1.1;

// ---------------------------------------------------------------------------
// Saved per device. Storage can be unavailable (private mode), so every
// access is guarded and the app works without it.

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saved; it still works for this visit.
  }
}

type ViewMode = '2d' | '3d';
const VIEW_KEY = 'live-boston:view';
let viewMode: ViewMode = load<ViewMode>(VIEW_KEY, '3d') === '2d' ? '2d' : '3d';
const flat = () => viewMode === '2d';

const LAYERS_KEY = 'live-boston:layers';
const layers = { speed: false, bikes: false, weather: true, alerts: true, ...load(LAYERS_KEY, {}) };

const LINE_KINDS = ['ferry', 'bus', 'rail', 'subway'] as const;
const LINE_OPACITY = { ferry: 0.75, bus: 0.85, rail: 0.85, subway: 1 };
/** Disruptions: suspended stretches, closed stations, bunched trains. */
const AMBER = '#fbbf24';
const STATION_STROKE = ['case', ['get', 'ferry'], '#22b8cf', ['get', 'rail'], '#e3a6d8', ['get', 'bus'], '#b4bec6', '#ffffff'] as any;
const STATION_LABEL = ['case', ['get', 'major'], '#e6e9ef', '#a3abb8'] as any;
/** Everything that isn't your trip, while directions are shown. */
const MUTED = '#3b4049';
const MUTED_BODY = new Color('#4a4f58');
const MUTED_ACCENT = new Color('#5a606a');

/** A train you follow, with enough to describe it while it's out of service. */
interface Followed {
  id: string;
  routeId: string;
  label: string;
}
const FOLLOWING_KEY = 'live-boston:following';
let followed: Followed[] = load(FOLLOWING_KEY, []);
const isFollowed = (id: string) => followed.some((f) => f.id === id);

// ---------------------------------------------------------------------------
// Map

const deepLink = !!location.hash;
const map = new maplibregl.Map({
  container: 'map',
  style: basemap(),
  // The intro flies in from over the harbor; deep links and 2D start in place.
  ...(deepLink || flat()
    ? { bounds: OVERVIEW }
    : { center: [-70.94, 42.3] as [number, number], zoom: 10.4, pitch: 10, bearing: 40 }),
  maxPitch: 78,
  // Smooth edges on the 3D trains and buildings; MapLibre leaves this off by default.
  canvasContextAttributes: { antialias: true },
  attributionControl: { compact: true, customAttribution: 'Live data © MBTA · Bluebikes · Open-Meteo' },
});

const trainLayer = new TrainLayer();
const precipitation = new Precipitation(document.querySelector<HTMLCanvasElement>('#weather-fx')!);
precipitation.enabled = layers.weather;
const speeds = new SpeedMap();

// ---------------------------------------------------------------------------
// State

let network: Network | null = null;
/** The MBTA's own routes, before Amtrak's stand-ins join the network. */
let mbtaRouteIds: string[] = [];
const tracks = new Map<string, Track>();
let stations: Station[] = [];
/** A station by its own id or any of its platforms'. */
const stationByStop = new Map<string, Station>();
const hidden = new Set<string>();
/** The latest from Amtrak for each of its trains on the map: stops and lateness. */
const amtrakInfo = new Map<string, AmtrakTrain>();
let alerts: Alert[] = [];

interface Train {
  v: Vehicle;
  route: Route;
  group: string;
  track?: Track;
  cars: CarSpec[];
  estimated: boolean;
  gap: number;
  length: number;
  bodies: Color[];
  accent: Color;
  /** Along-track distance at the last accepted report, and when (performance clock) it was there. */
  base: number;
  baseAt: number;
  /** Drawn distance along the track and drawn speed (m/s): a smooth follower of the estimate. */
  d: number;
  vel: number;
  /** Fallback when a train is off its shape: a straight glide and the reported bearing. */
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  start: number;
  dur: number;
  /** Measured speed (m/s), from the MBTA or from distance between reports. */
  speed: number | null;
  /** Along-track distance of the stop it's at or heading to, if it's on the track. */
  stopD: number | null;
  /** How far the last report was from the track, in meters. */
  off: number;
  /** A per-train phase so the fleet doesn't sway in step. */
  phase: number;
  /** Filled in each frame. */
  x: number;
  y: number;
  heading: number;
}

const trains = new Map<string, Train>();
const debugJumps: number[] = [];
if (import.meta.env.DEV) Object.assign(window, { map, trains, speeds, debugJumps, toLngLat, gps: () => ({ me, alongside: [...alongside] }) });
let lastUpdate = 0;
let pausedUntil = 0;
const colorCache = new Map<string, Color>();
const color = (hex: string) => {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new Color(hex)));
  return c;
};

type Tab = 'lines' | 'alerts' | 'following' | 'map';
let tab: Tab = 'lines';
type Selection = { kind: 'train' | 'station' | 'dock' | 'trip'; id: string } | null;
let selection: Selection = null;
/** Ride along behind the train, or from the driver's seat. */
type CameraMode = 'free' | 'follow' | 'ride' | 'cab';
const riding = () => cameraMode === 'ride' || cameraMode === 'cab';
let cameraMode: CameraMode = 'free';
let rideBearing = 0;
/** Degrees the rider has turned to look around while riding along. */
let rideLook = 0;
let lookedAt = 0;
let touring = false;
let tourNext = 0;
let lastInteraction = performance.now();

let docks: Dock[] = [];
let docksAt = 0;
let weather: Weather = CLEAR;
let sky: SkyState = skyAt(new Date());
let notice: string | null = null;

// ---------------------------------------------------------------------------
// Layers

/** `?hour=21.5` previews the city at another time of day (Boston time). */
function skyTime() {
  const params = new URLSearchParams(location.search);
  const hour = Number(params.get('hour'));
  if (!params.has('hour') || !Number.isFinite(hour)) return new Date();
  const now = new Date();
  const boston = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offset = now.getTime() - boston.getTime();
  boston.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return new Date(boston.getTime() + offset);
}

/** The sky and the light on buildings and trains follow the real sun. */
function applySky() {
  sky = skyAt(skyTime());
  const foggy = weather.kind === 'fog' ? 1 : weather.kind === 'rain' || weather.kind === 'snow' ? 0.4 : 0;
  map.setSky({
    'sky-color': blend(SKY['sky-color'], sky),
    'horizon-color': blend(SKY['horizon-color'], sky),
    'fog-color': blend(SKY['fog-color'], sky),
    'sky-horizon-blend': 0.55,
    'horizon-fog-blend': 0.6 - foggy * 0.3,
    'fog-ground-blend': 0.8 - foggy * 0.45,
  });
  const up = sky.altitudeDeg > 0;
  // One neutral light around the clock, so the city keeps its color; it just
  // comes from wherever the sun is, and is a touch softer at night.
  map.setLight({
    anchor: 'map',
    position: [1.5, up ? sky.azimuthDeg : 210, up ? 90 - Math.max(25, sky.altitudeDeg) : 45],
    color: '#ffffff',
    intensity: 0.32 + 0.1 * sky.day,
  });
  trainLayer.setLighting({
    // Below the horizon, light the trains from above like moonlight.
    sun: up ? sky.sun : [0.3, -0.4, 0.86],
    sunIntensity: up ? 0.8 + 1.3 * sky.day : 0.6,
    skyIntensity: 1.7 + 1.1 * sky.day,
    night: 1 - sky.day,
  });
  document.body.dataset.weather = layers.weather ? weather.kind : 'clear';
}

function addLayers() {
  map.addLayer(
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      layout: { visibility: flat() ? 'none' : 'visible' },
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 0],
          0,
          '#15181e',
          40,
          '#1a1e25',
          150,
          '#232832',
        ],
        // Buildings rise out of the ground as you zoom in.
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-vertical-gradient': true,
      },
    },
    'water-name',
  );

  // Lines: a dark casing under each so crossings stay crisp, then the line.
  // Past zoom 17 they widen to about a real track bed, for the cab view.
  map.addSource('lines', { type: 'geojson', data: empty() });
  const widths = { ferry: [0.8, 2.4], subway: [1.6, 6], rail: [1, 3.6], bus: [0.8, 3] } as const;
  const width = (lo: number, hi: number, pad = 0) =>
    ['interpolate', ['exponential', 1.5], ['zoom'], 9, lo + pad / 2, 17, hi + pad, 18, hi * 1.4 + pad, 20, hi * 3.5 + pad, 22, hi * 11 + pad] as any;
  for (const kind of LINE_KINDS) {
    const [lo, hi] = widths[kind];
    // Ferries cross open water, where a casing would only darken it.
    if (kind !== 'ferry') {
      map.addLayer({
        id: `${kind}-casing`,
        type: 'line',
        source: 'lines',
        filter: ['==', ['get', 'kind'], kind],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PALETTE.background, 'line-width': width(lo, hi, 4) },
      });
    }
    map.addLayer({
      id: `${kind}-lines`,
      type: 'line',
      source: 'lines',
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': width(lo, hi),
        'line-opacity': LINE_OPACITY[kind],
        // The Silver Line runs on streets and ferries on water: dashed.
        ...(kind === 'bus' ? { 'line-dasharray': [1.6, 1.2] } : kind === 'ferry' ? { 'line-dasharray': [2, 2.4] } : {}),
      },
    });
  }

  // Where service is suspended or replaced by shuttles: an amber stripe over the line.
  map.addSource('alert-lines', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'alert-lines',
    type: 'line',
    source: 'alert-lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': AMBER,
      'line-width': width(2.2, 7),
      'line-opacity': 0.9,
      'line-dasharray': [0.6, 1.4],
    },
  });

  // The speed map paints over the lines when it's on.
  map.addSource('speed', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'speed-lines',
    type: 'line',
    source: 'speed',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 2.4, 17, 8],
    },
  });

  map.addSource('bikes', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'bikes',
    type: 'circle',
    source: 'bikes',
    minzoom: 12,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 15, 5, 18, 11],
      'circle-color': ['case', ['==', ['get', 'total'], 0], '#f87171', ['<=', ['get', 'total'], 2], '#fbbf24', '#38bdf8'],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1],
      'circle-stroke-color': PALETTE.background,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 18, 2],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1],
    },
  });
  map.addLayer({
    id: 'bike-counts',
    type: 'symbol',
    source: 'bikes',
    minzoom: 15.5,
    layout: {
      'text-field': ['to-string', ['get', 'total']],
      'text-font': ['Noto Sans Bold'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': PALETTE.background },
  });

  // Stations: rings. Silver Line stops only once you're close in.
  map.addSource('stations', { type: 'geojson', data: empty() });
  const show = (busFrom: number) => [
    'interpolate',
    ['linear'],
    ['zoom'],
    busFrom - 0.5,
    ['case', ['get', 'bus'], 0, 1],
    busFrom,
    1,
  ];
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    minzoom: 10,
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['case', ['get', 'major'], 2, 1.2],
        14,
        ['case', ['get', 'major'], 4, 3],
        17,
        ['case', ['get', 'major'], 7, 5],
      ],
      'circle-color': PALETTE.background,
      'circle-stroke-color': STATION_STROKE,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 2.5],
      'circle-opacity': show(14.5) as any,
      'circle-stroke-opacity': show(14.5) as any,
    },
  });

  // Stations with a closure or on a suspended stretch: an amber halo.
  map.addSource('alert-stations', { type: 'geojson', data: empty() });
  map.addLayer(
    {
      id: 'alert-stations',
      type: 'circle',
      source: 'alert-stations',
      minzoom: 10,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 8, 17, 13],
        'circle-color': 'rgba(251, 191, 36, 0.14)',
        'circle-stroke-color': AMBER,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 2],
        'circle-stroke-opacity': 0.9,
      },
    },
    'stations',
  );

  // A ring that ripples out from a station as a train pulls in.
  map.addSource('arrivals', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'arrivals',
    type: 'circle',
    source: 'arrivals',
    paint: {
      // Zoom has to lead the expression, so the ring's growth goes inside each stop.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 't'], 16], 17, ['*', ['get', 't'], 56]],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['*', ['-', 1, ['get', 't']], 2.5],
      'circle-stroke-opacity': ['-', 1, ['get', 't']],
      'circle-pitch-alignment': 'map',
    },
  });

  // Zoomed out, each train is a crisp dot in its line's color; the 3D trains
  // take over as you zoom in.
  map.addSource('vehicles', { type: 'geojson', data: empty() });
  const fadeOut = (v: number) => ['interpolate', ['linear'], ['zoom'], 15, v, 16, 0];
  map.addLayer({
    id: 'vehicle-rings',
    type: 'circle',
    source: 'vehicles',
    filter: ['any', ['get', 'selected'], ['get', 'mine'], ['all', ['!', ['get', 'dim']], ['any', ['get', 'followed'], ['get', 'bunched']]]],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 12],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['case', ['any', ['get', 'selected'], ['get', 'mine']], '#ffffff', ['get', 'followed'], '#ffc94d', AMBER],
      'circle-stroke-width': 2,
      'circle-stroke-opacity': fadeOut(1) as any,
    },
  });
  map.addLayer({
    id: 'vehicles',
    type: 'circle',
    source: 'vehicles',
    // Your trip's trains draw over the greyed-out rest.
    layout: { 'circle-sort-key': ['case', ['get', 'dim'], 0, 1] },
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['get', 'small'], 2.6, 3.4],
        13,
        ['case', ['get', 'small'], 4, 5.5],
        15,
        ['case', ['get', 'small'], 5, 7],
      ],
      'circle-color': ['case', ['get', 'dim'], MUTED, ['get', 'color']],
      'circle-stroke-color': PALETTE.background,
      'circle-stroke-width': 1.5,
      'circle-opacity': fadeOut(1) as any,
      'circle-stroke-opacity': fadeOut(1) as any,
    },
  });

  // Directions: the ride in its line's color over a soft glow, the walking
  // in dots, under the trains so yours can be seen running along it.
  map.addSource('trip', { type: 'geojson', data: empty() });
  map.addSource('trip-points', { type: 'geojson', data: empty() });
  const tripWidth = (lo: number, hi: number) => ['interpolate', ['exponential', 1.5], ['zoom'], 10, lo, 17, hi] as any;
  map.addLayer({
    id: 'trip-glow',
    type: 'line',
    source: 'trip',
    filter: ['==', ['get', 'kind'], 'ride'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': tripWidth(10, 26), 'line-opacity': 0.22, 'line-blur': 6 },
  });
  map.addLayer({
    id: 'trip-casing',
    type: 'line',
    source: 'trip',
    filter: ['==', ['get', 'kind'], 'ride'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PALETTE.background, 'line-width': tripWidth(6.5, 13) },
  });
  map.addLayer({
    id: 'trip-ride',
    type: 'line',
    source: 'trip',
    filter: ['==', ['get', 'kind'], 'ride'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': tripWidth(4, 9) },
  });
  map.addLayer({
    id: 'trip-walk',
    type: 'line',
    source: 'trip',
    filter: ['==', ['get', 'kind'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e6e9ef', 'line-width': tripWidth(3, 6), 'line-dasharray': [0.1, 2] },
  });

  // Trains draw above the lines and stations, below the labels.
  map.addLayer(trainLayer);

  // You, when you've asked to be located: a blue dot in a circle as wide as
  // the fix is uncertain. The circle's radius is in meters, so it scales
  // with the zoom (×2 per level), from its size at zoom 0.
  map.addSource('me', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'me-accuracy',
    type: 'circle',
    source: 'me',
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'r0'], 24, ['*', ['get', 'r0'], 2 ** 24]],
      'circle-color': 'rgba(59, 130, 246, 0.12)',
      'circle-stroke-color': 'rgba(59, 130, 246, 0.4)',
      'circle-stroke-width': 1,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: {
      'circle-radius': 7,
      'circle-color': '#3b82f6',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });

  map.addLayer({
    id: 'trip-stops',
    type: 'circle',
    source: 'trip-points',
    paint: {
      'circle-radius': ['match', ['get', 'role'], 'to', 9, 'from', 7, 'pass', ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 4.5], 6],
      'circle-color': ['match', ['get', 'role'], ['stop', 'pass'], '#ffffff', ['get', 'color']],
      'circle-stroke-color': ['match', ['get', 'role'], ['stop', 'pass'], ['get', 'color'], '#ffffff'],
      'circle-stroke-width': ['match', ['get', 'role'], 'stop', 3.5, 'pass', 2, 2.5],
      'circle-pitch-alignment': 'viewport',
    },
  });
  map.addLayer({
    id: 'trip-labels',
    type: 'symbol',
    source: 'trip-points',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['match', ['get', 'role'], 'pass', 10.5, 12.5],
      'text-offset': ['match', ['get', 'role'], 'pass', ['literal', [0.9, 0]], ['literal', [0, -1.4]]],
      'text-anchor': ['match', ['get', 'role'], 'pass', 'left', 'bottom'],
      'text-max-width': 12,
      'text-allow-overlap': false,
      'symbol-sort-key': ['match', ['get', 'role'], 'to', 0, 'stop', 1, 'from', 2, 3],
    },
    paint: {
      'text-color': ['match', ['get', 'role'], 'pass', '#c3c9d3', '#f3f5f8'],
      'text-halo-color': PALETTE.background,
      'text-halo-width': 2,
    },
  });

  map.addLayer({
    id: 'station-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 12.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 17, 13],
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
      'text-max-width': 9,
      'symbol-sort-key': ['case', ['get', 'major'], 0, 1],
    },
    paint: {
      'text-color': STATION_LABEL,
      'text-halo-color': PALETTE.background,
      'text-halo-width': 1.6,
      'text-opacity': show(15.5) as any,
    },
  });
  applyLayerToggles();
}

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function source(id: string) {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function trackOf(shapeId: string) {
  let t = tracks.get(shapeId);
  if (!t && network?.shapes.has(shapeId)) tracks.set(shapeId, (t = new Track(network.shapes.get(shapeId)!)));
  return t;
}

function drawLines() {
  if (!network) return;
  const features: GeoJSON.Feature[] = [];
  for (const [routeId, shapeIds] of network.routeShapes) {
    const route = network.routes.get(routeId)!;
    if (hidden.has(groupOf(route))) continue;
    for (const id of shapeIds) {
      features.push({
        type: 'Feature',
        properties: { color: displayColor(route.color), kind: kindOf(route) },
        geometry: { type: 'LineString', coordinates: network.shapes.get(id)! },
      });
    }
  }
  source('lines')?.setData({ type: 'FeatureCollection', features });
  if (layers.speed) drawSpeedMap();
}

function drawStations() {
  source('stations')?.setData({
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, rail: s.rail, bus: s.bus, ferry: s.ferry, major: !s.rail && !s.bus && !s.ferry },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    })),
  });
}

function drawSpeedMap() {
  if (!network) return;
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const [routeId, shapeIds] of network.routeShapes) {
    const route = network.routes.get(routeId)!;
    const group = groupOf(route);
    if (hidden.has(group)) continue;
    for (const id of shapeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const track = trackOf(id);
      if (!track) continue;
      for (const seg of speeds.segments(group, track, toLngLat)) {
        features.push({ type: 'Feature', properties: { color: seg.color }, geometry: { type: 'LineString', coordinates: seg.coords } });
      }
    }
  }
  source('speed')?.setData({ type: 'FeatureCollection', features });
}

function drawDocks() {
  source('bikes')?.setData({
    type: 'FeatureCollection',
    features: docks.map((d) => ({
      type: 'Feature',
      properties: { id: d.id, total: d.bikes + d.ebikes },
      geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
    })),
  });
}

async function refreshDocks() {
  if (!layers.bikes || document.hidden) return;
  try {
    docks = await loadDocks();
    docksAt = Date.now();
    drawDocks();
    if (tab === 'map') renderMain();
    if (selection?.kind === 'dock') renderDetail();
  } catch (err) {
    console.error(err);
  }
}

/** Shows or hides the optional layers, and dims the lines under the speed map. */
function applyLayerToggles() {
  precipitation.enabled = layers.weather;
  document.body.dataset.weather = layers.weather ? weather.kind : 'clear';
  if (!map.getLayer('speed-lines')) return;
  const vis = (on: boolean) => (on ? 'visible' : 'none');
  // Directions shown: everything but the trip greys out or steps aside, so
  // the way you're going is unmistakable.
  const focus = !!tripFocus;
  map.setLayoutProperty('speed-lines', 'visibility', vis(layers.speed && !focus));
  for (const id of ['bikes', 'bike-counts']) map.setLayoutProperty(id, 'visibility', vis(layers.bikes && !focus));
  map.setLayoutProperty('arrivals', 'visibility', vis(!focus));
  // Lines step back behind the speed map, and go grey behind a trip.
  for (const kind of LINE_KINDS) {
    map.setPaintProperty(`${kind}-lines`, 'line-color', focus ? MUTED : ['get', 'color']);
    map.setPaintProperty(`${kind}-lines`, 'line-opacity', focus ? 0.7 : layers.speed ? 0.15 : LINE_OPACITY[kind]);
  }
  map.setPaintProperty('stations', 'circle-stroke-color', focus ? MUTED : STATION_STROKE);
  map.setPaintProperty('station-labels', 'text-color', focus ? '#565c66' : STATION_LABEL);
  map.setFilter('station-labels', focus && tripStations.length ? ['!', ['in', ['get', 'id'], ['literal', tripStations]]] : null);
  for (const id of ['alert-lines', 'alert-stations']) map.setLayoutProperty(id, 'visibility', vis(layers.alerts && !focus));
  $('#speed-legend').hidden = !layers.speed;
  if (layers.speed) drawSpeedMap();
  if (layers.bikes && Date.now() - docksAt > BIKES_MS) refreshDocks();
}

// ---------------------------------------------------------------------------
// Trains: where each one probably is right now.
//
// A report is snapped onto the exact shape its trip runs, and placed at the
// moment it was reported (reports are ~20 s old on arrival). From there the
// train is assumed to keep rolling at its measured speed, never past the stop
// it's heading to and not at all while stopped. The drawn train follows that
// estimate with realistic acceleration and braking, and never reverses.

/** A shape run backwards, for a train going the other way along it. */
function reversed(shapeId: string) {
  const key = `${shapeId}:reversed`;
  let t = tracks.get(key);
  if (!t && network?.shapes.has(shapeId)) tracks.set(key, (t = new Track([...network.shapes.get(shapeId)!].reverse())));
  return t;
}

/**
 * Amtrak has no MBTA shapes of its own, but where it runs on MBTA track it's
 * on a commuter rail shape. Find the nearest, and run it the way the train
 * is heading (Amtrak only reports the nearest eighth of a turn, plenty to
 * tell the two directions apart).
 */
function amtrakTrack(v: Vehicle): Track | undefined {
  if (!network) return;
  const [x, y] = toLocal(v.lng, v.lat);
  const near: { id: string; d: number; off: number; length: number }[] = [];
  for (const [routeId, shapeIds] of network.routeShapes) {
    if (network.routes.get(routeId)?.type !== 2) continue;
    for (const id of shapeIds) {
      const t = trackOf(id);
      const p = t?.project(x, y);
      if (t && p && p.off < 150) near.push({ id, ...p, length: t.length });
    }
  }
  if (!near.length) return;
  // Where shapes share track (the Providence and Stoughton lines to Canton
  // Junction), take the one that runs furthest, which is the main line.
  const closest = Math.min(...near.map((n) => n.off));
  const best = near.filter((n) => n.off < closest + 30).sort((a, b) => b.length - a.length)[0];
  const t = trackOf(best.id)!;
  const a = t.at(best.d + 20);
  const b = t.at(best.d - 20);
  const along = compass(Math.atan2(a.y - b.y, a.x - b.x));
  const diff = Math.abs((((v.bearing ?? along) - along + 540) % 360) - 180);
  return diff > 90 ? reversed(best.id) : t;
}

function trackFor(v: Vehicle, route: Route): Track | undefined {
  if (!network) return;
  // Boats go where the water takes them; they glide between reports.
  if (route.type === 4) return;
  if (route.type === AMTRAK_TYPE) return amtrakTrack(v);
  const ids = v.shapeId && network.shapes.has(v.shapeId) ? [v.shapeId] : (network.routeShapes.get(route.id) ?? []);
  let best: Track | undefined;
  let bestOff = Infinity;
  const [x, y] = toLocal(v.lng, v.lat);
  for (const id of ids) {
    const t = trackOf(id);
    if (!t) continue;
    const off = t.project(x, y).off;
    if (off < bestOff) [best, bestOff] = [t, off];
  }
  // More than this far from the route means a yard move or a bad fix.
  return bestOff < (route.type === 3 ? 120 : 250) ? best : undefined;
}

/** How far the report is behind the present, capped so a stale one can't fling a train. */
function reportAge(v: Vehicle) {
  // Amtrak's fixes come about once a minute, so allow more catching up.
  const cap = v.id.startsWith('amtrak-') ? 120_000 : 45_000;
  return Math.min(cap, Math.max(0, Date.now() - v.updatedAt));
}

function applyReport(v: Vehicle, now: number) {
  const route = network?.routes.get(v.routeId);
  if (!route) return;
  const existing = trains.get(v.id);
  if (existing && existing.v.updatedAt === v.updatedAt && existing.v.tripId === v.tripId) {
    existing.v = v;
    return;
  }

  const [x, y] = toLocal(v.lng, v.lat);
  const sameTrip = existing && existing.v.tripId === v.tripId;
  let track = sameTrip ? existing.track : undefined;
  let snapped = track?.project(x, y, existing!.base);
  // Amtrak's track is a guess from commuter rail shapes; if it has run off
  // the one it was on (onto a branch, or off MBTA track), guess again.
  if (track && route.type === AMTRAK_TYPE && snapped!.off > 100) track = undefined;
  if (!track) {
    track = trackFor(v, route);
    snapped = track?.project(x, y);
  }
  const group = groupOf(route);

  if (!existing || !sameTrip || existing.track !== track) {
    const { cars, estimated, gap } = consist(route, v.carriages);
    const d = snapped?.d ?? 0;
    // Face along the track from the first report; commuter rail has no bearing.
    let heading = ((90 - (v.bearing ?? 0)) * Math.PI) / 180;
    if (track) {
      const a = track.at(d + 10);
      const b = track.at(d - 10);
      heading = Math.atan2(a.y - b.y, a.x - b.x);
    }
    const t: Train = {
      v,
      route,
      group,
      track,
      cars,
      estimated,
      gap,
      length: cars.reduce((sum, c) => sum + c.length + gap, -gap),
      bodies: cars.map((c) => color(c.body)),
      accent: color(displayColor(route.color)),
      base: d,
      baseAt: now - reportAge(v),
      d,
      vel: 0,
      fx: existing?.x ?? x,
      fy: existing?.y ?? y,
      tx: x,
      ty: y,
      start: now,
      dur: 1,
      speed: v.speed,
      stopD: null,
      off: snapped?.off ?? Infinity,
      phase: Math.random() * 10,
      x,
      y,
      heading,
    };
    trains.set(v.id, t);
    locateStop(t);
    // Start where it probably is now, already moving if it is.
    const est = estimate(t, now);
    t.d = est.d;
    t.vel = est.vel;
    return;
  }

  const t = existing;
  const interval = v.updatedAt - t.v.updatedAt;
  const wasMoving = t.v.status !== 'STOPPED_AT';
  if (snapped) {
    const moved = snapped.d - t.base;
    // Speed from the MBTA when it has one, otherwise from distance along the
    // track, smoothed so one short hop doesn't swing it.
    const measured = interval > 3000 && interval < 120_000 ? Math.max(0, moved) / (interval / 1000) : null;
    // A "speed" past the line's top speed is the position jumping, not the train moving.
    const believable = measured != null && measured <= maxSpeed(group) * 1.15;
    if (v.speed != null) t.speed = Math.min(v.speed, maxSpeed(group));
    else if (believable) t.speed = t.speed == null ? measured : t.speed * 0.4 + measured * 0.6;
    // Feed the speed map with runs between two moving reports.
    if (track && believable && wasMoving && v.status !== 'STOPPED_AT' && interval > 5000 && moved > 0) {
      speeds.addRun(group, track, t.base, snapped.d, moved / (interval / 1000));
    }
    if (v.speed != null && v.status !== 'STOPPED_AT' && track) {
      const p = track.at(snapped.d);
      speeds.addPoint(group, p.x, p.y, v.speed);
    }
    // A small step backwards is position noise: keep the last report.
    if (moved > -40 || moved < -1500) {
      const before = import.meta.env.DEV ? estimate(t, now).d : 0;
      t.base = snapped.d;
      t.baseAt = now - reportAge(v);
      if (moved < -1500) t.d = t.base;
      // How far each new report moves our estimate of where the train is now.
      if (import.meta.env.DEV) debugJumps.push(estimate(t, now).d - before);
    }
  } else {
    // Off any track (boats, and Amtrak beyond the T): speed from how far it
    // went since the last report.
    if (v.speed != null) t.speed = v.speed;
    else if (interval > 3000 && interval < 180_000) {
      const measured = Math.hypot(x - t.tx, y - t.ty) / (interval / 1000);
      t.speed = t.speed == null ? measured : t.speed * 0.4 + measured * 0.6;
    }
    t.fx = t.x;
    t.fy = t.y;
    t.tx = x;
    t.ty = y;
    t.start = now;
    t.dur = isAmtrak(v.id) ? AMTRAK_MS : POLL_MS;
  }
  if (wasMoving && v.status === 'STOPPED_AT') arrive(t, v);
  t.off = snapped?.off ?? Infinity;
  t.v = v;
  locateStop(t);
}

/** Finds the train's current or next stop on its track, to cap dead reckoning there. */
function locateStop(t: Train) {
  t.stopD = null;
  if (!t.track || t.v.stopLng == null || t.v.stopLat == null) return;
  const [sx, sy] = toLocal(t.v.stopLng, t.v.stopLat);
  const p = t.track.project(sx, sy, t.base);
  if (p.off < 150) t.stopD = p.d;
}

/** Where the train probably is now, and how fast it's going there. */
function estimate(t: Train, now: number): { d: number; vel: number } {
  const ms = now - t.baseAt;
  const speed = t.speed ?? TYPICAL_SPEED[t.group] ?? 8;
  if (ms <= 0 || t.v.status === 'STOPPED_AT' || speed < 0.5) return { d: t.base, vel: 0 };
  // No stop to cap at for Amtrak (its stations aren't MBTA stops), so allow
  // a longer run at its higher speeds.
  let limit = t.base + (t.group === 'Amtrak' ? 4000 : 800);
  if (t.stopD != null && t.stopD > t.base) limit = Math.min(limit, t.stopD);
  else if (t.stopD != null) return { d: t.base, vel: 0 }; // At or past its stop already.
  // Nor past the end of the line on a guess (only a report can put it there).
  if (t.track) limit = Math.min(limit, Math.max(t.base, t.track.length));
  if (limit <= t.base) return { d: t.base, vel: 0 };
  const run = (speed * Math.min(ms, 90_000)) / 1000;
  return run >= limit - t.base ? { d: limit, vel: 0 } : { d: t.base + run, vel: speed };
}

/**
 * Moves the drawn train toward its estimate like a train would. It runs at
 * the estimate's own speed, plus just enough to close any gap, and never
 * faster than the line allows or faster than it could brake from in time,
 * so it eases into a stop instead of sailing past it.
 */
function step(t: Train, now: number, dt: number) {
  const target = estimate(t, now);
  const err = target.d - t.d;
  // Too far behind to drive there believably (back from a hidden tab, or a
  // big correction), or stuck well past a train that's standing still: put
  // it where it is.
  if (err > (target.vel > 0 ? 500 : 250) || err < -800 || (err < -150 && target.vel === 0)) {
    t.d = target.d;
    t.vel = target.vel;
    return;
  }
  const gap = Math.abs(err);
  // Close the gap gently when it's small, and never faster than braking at
  // BRAKE could undo by the time it arrives.
  const closing = Math.min(0.5 * gap, Math.sqrt(2 * BRAKE * gap));
  const want = Math.max(0, Math.min(maxSpeed(t.group), target.vel + Math.sign(err) * closing));
  const acc = Math.max(-3, Math.min(1.5, (want - t.vel) / 0.5));
  t.vel = Math.max(0, t.vel + acc * dt);
  t.d += t.vel * dt;
}

const arrivals: { lng: number; lat: number; color: string; start: number }[] = [];

function arrive(t: Train, v: Vehicle) {
  if (v.stopLng == null || v.stopLat == null || hidden.has(t.group)) return;
  arrivals.push({ lng: v.stopLng, lat: v.stopLat, color: `#${t.accent.getHexString()}`, start: performance.now() });
}

async function poll() {
  if (!network || document.hidden || Date.now() < pausedUntil) return;
  try {
    const vehicles = await loadVehicles(mbtaRouteIds);
    const now = performance.now();
    const seen = new Set<string>();
    for (const v of vehicles) {
      if (Date.now() - v.updatedAt > STALE_MS) continue;
      seen.add(v.id);
      applyReport(v, now);
    }
    for (const id of trains.keys()) if (!seen.has(id) && !isAmtrak(id)) trains.delete(id);
    lastUpdate = Date.now();
    setNotice(null);
    afterPoll();
  } catch (err) {
    handleError(err, 'Can’t reach the MBTA, retrying');
  }
}

/** Amtrak trains near Boston, from their own feed, about once a minute. */
async function pollAmtrak() {
  if (!network || document.hidden) return;
  let list: AmtrakTrain[];
  try {
    list = await loadAmtrak();
  } catch (err) {
    // Amtrak is a bonus; the T carries on without it.
    console.warn(err);
    return;
  }
  const now = performance.now();
  const seen = new Set<string>();
  for (const a of list) {
    if (Date.now() - a.updatedAt > STALE_MS) continue;
    const routeId = `Amtrak-${a.service}`;
    if (!network.routes.has(routeId)) {
      network.routes.set(routeId, {
        id: routeId,
        name: `Amtrak ${a.service}`,
        type: AMTRAK_TYPE,
        short: a.service,
        color: AMTRAK_COLOR,
        destinations: [],
      });
    }
    seen.add(a.id);
    amtrakInfo.set(a.id, a);
    applyReport(
      {
        id: a.id,
        label: a.number,
        routeId,
        tripId: a.id,
        tripName: a.number,
        headsign: a.destination,
        directionId: 0,
        lng: a.lng,
        lat: a.lat,
        bearing: a.bearing,
        speed: a.speed,
        status: a.speed < 0.5 ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
        stopName: a.upcoming[0]?.name,
        carriages: null,
        updatedAt: a.updatedAt,
      },
      now,
    );
  }
  for (const id of trains.keys()) {
    if (isAmtrak(id) && !seen.has(id)) {
      trains.delete(id);
      amtrakInfo.delete(id);
    }
  }
  afterPoll();
  if (tab === 'alerts') renderMain();
}

/** Brings everything that shows vehicles up to date after new reports. */
function afterPoll() {
  if (selection?.kind === 'train' && !trains.has(selection.id)) select(null);
  if (layers.speed) drawSpeedMap();
  findBunching();
  refreshCounts();
  if (tab === 'following') renderMain();
  if (selection?.kind === 'train') {
    if (isAmtrak(selection.id)) upcoming = amtrakStops(selection.id);
    renderDetail();
  }
  renderHud();
}

function amtrakStops(id: string): UpcomingStop[] {
  return (amtrakInfo.get(id)?.upcoming ?? []).filter((s) => Number.isFinite(s.at)).map((s) => ({ name: s.name, at: s.at }));
}

// ---------------------------------------------------------------------------
// Disruptions: the MBTA's service alerts, and trains running bunched up.

async function refreshAlerts() {
  if (!network || document.hidden || Date.now() < pausedUntil) return;
  try {
    alerts = (await loadAlerts(mbtaRouteIds)).sort((a, b) => b.severity - a.severity || b.updatedAt - a.updatedAt);
  } catch (err) {
    if (err instanceof RateLimited) handleError(err, '');
    else console.warn(err);
    return;
  }
  drawAlerts();
  renderAlertsBadge();
  if (tab === 'alerts' || tab === 'lines') renderMain();
  if (selection && selection.kind !== 'dock') renderDetail();
}

const serviceAlerts = () => alerts.filter((a) => alertKind(a) === 'service');

/** The stations an alert names, by their own ids or their platforms'. */
function alertStations(a: Alert) {
  return [...new Set(a.stops.map((id) => stationByStop.get(id)).filter((s): s is Station => !!s))];
}

/** Effects that take a stretch of line out of service. */
const OUT_OF_SERVICE = new Set(['SUSPENSION', 'SHUTTLE', 'NO_SERVICE']);
const CLOSED = new Set(['STATION_CLOSURE', 'STOP_CLOSURE', 'DOCK_CLOSURE']);

/** The stretch of each route between the first and last stations an alert names. */
function alertStretches(a: Alert): [number, number][][] {
  if (!network || !OUT_OF_SERVICE.has(a.effect) || a.trips.length) return [];
  const points = alertStations(a).map((s) => toLocal(s.lng, s.lat));
  if (points.length < 2) return [];
  const out: [number, number][][] = [];
  for (const routeId of a.routes) {
    let best: { track: Track; lo: number; hi: number; n: number } | null = null;
    for (const id of network.routeShapes.get(routeId) ?? []) {
      const track = trackOf(id);
      if (!track) continue;
      const ds = points.map(([x, y]) => track.project(x, y)).filter((p) => p.off < 200).map((p) => p.d);
      if (ds.length < 2) continue;
      const lo = Math.min(...ds);
      const hi = Math.max(...ds);
      if (!best || ds.length > best.n || (ds.length === best.n && hi - lo > best.hi - best.lo)) best = { track, lo, hi, n: ds.length };
    }
    if (best) out.push(stretch(best.track, best.lo, best.hi));
  }
  return out;
}

/** Part of a track as map coordinates, following its curves. */
function stretch(track: Track, lo: number, hi: number): [number, number][] {
  const coords = [toLngLat(track.at(lo).x, track.at(lo).y)];
  for (let i = 0; i < track.cum.length; i++) {
    if (track.cum[i] > lo && track.cum[i] < hi) coords.push(toLngLat(track.x[i], track.y[i]));
  }
  coords.push(toLngLat(track.at(hi).x, track.at(hi).y));
  return coords;
}

function drawAlerts() {
  const lines: GeoJSON.Feature[] = [];
  const marked = new Set<Station>();
  for (const a of serviceAlerts()) {
    const routes = a.routes.map((id) => network?.routes.get(id)).filter((r): r is Route => !!r);
    if (routes.length && routes.every((r) => hidden.has(groupOf(r)))) continue;
    const stretches = alertStretches(a);
    for (const coords of stretches) lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
    if (stretches.length || CLOSED.has(a.effect)) for (const s of alertStations(a)) marked.add(s);
  }
  source('alert-lines')?.setData({ type: 'FeatureCollection', features: lines });
  source('alert-stations')?.setData({
    type: 'FeatureCollection',
    features: [...marked].map((s) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })),
  });
}

/** The lines an alert is about, as riders name them. */
function alertLines(a: Alert) {
  const names: string[] = [];
  let color = AMBER;
  for (const id of a.routes) {
    const route = network?.routes.get(id);
    if (!route) continue;
    const group = GROUPS.find((g) => g.match(route));
    // Branches and Silver Line routes read better by their own names.
    const name = group && ['Red', 'Orange', 'Blue', 'Green', 'Mattapan'].includes(group.id) ? group.label : route.name;
    if (!names.length) color = displayColor(route.color);
    if (!names.includes(name)) names.push(name);
  }
  return { names, color };
}

/** Service alerts that touch a group, worst first. */
function groupAlerts(g: Group) {
  return serviceAlerts().filter((a) => isDisruptive(a) && !a.trips.length && a.routes.some((id) => {
    const r = network?.routes.get(id);
    return r && g.match(r);
  }));
}

/** Alerts that bear on one train: its trip, its whole route, or the stop it's heading to. */
function trainAlerts(t: Train) {
  const next = t.v.stopName;
  return serviceAlerts().filter(
    (a) =>
      (t.v.tripId && a.trips.includes(t.v.tripId)) ||
      (a.routes.includes(t.v.routeId) && !a.trips.length && (!a.stops.length || alertStations(a).some((s) => s.name === next))),
  );
}

/** Alerts at a station: closures, elevators, and anything on a stretch through it. */
function stationAlerts(s: Station) {
  const ids = new Set([s.id, ...s.children]);
  return alerts.filter((a) => a.stops.some((id) => ids.has(id)));
}

// Bunching: two trains on the same line and direction running nose to tail,
// which leaves a long wait behind them. The closest gap, between the back of
// one and the front of the next, that counts as bunched:
const BUNCH_GAP: Record<string, number> = { Red: 400, Orange: 400, Blue: 300, Green: 150, Mattapan: 150, SL: 150 };

interface Bunch {
  behind: Train;
  ahead: Train;
  gap: number;
}
let bunches: Bunch[] = [];
const bunched = new Set<string>();

function findBunching() {
  const byRoute = new Map<string, Train[]>();
  for (const t of trains.values()) {
    if (!BUNCH_GAP[t.group] || !t.track || t.off > 60) continue;
    const key = `${t.v.routeId}|${t.v.directionId}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), t]);
  }
  const out: Bunch[] = [];
  const pos = { x: 0, y: 0 };
  for (const list of byRoute.values()) {
    for (const a of list) {
      const track = a.track!;
      // Trains wait their turn at either end of the line; that's not bunching.
      if (a.d < 600 || a.d > track.length - 600) continue;
      let next: { t: Train; gap: number } | null = null;
      for (const b of list) {
        if (b === a) continue;
        b.track!.at(b.d, pos);
        const p = track.project(pos.x, pos.y, a.d);
        if (p.off > 40 || p.d > track.length - 600) continue;
        const gap = p.d - a.d - (a.length + b.length) / 2;
        if (p.d > a.d && (!next || gap < next.gap)) next = { t: b, gap };
      }
      if (next && next.gap < BUNCH_GAP[a.group]) out.push({ behind: a, ahead: next.t, gap: Math.max(0, next.gap) });
    }
  }
  bunches = out;
  bunched.clear();
  for (const b of out) bunched.add(b.behind.v.id).add(b.ahead.v.id);
  if (tab === 'alerts') renderMain();
}

function handleError(err: unknown, message: string) {
  if (err instanceof RateLimited) {
    pausedUntil = err.retryAt;
    setNotice('MBTA rate limit reached, pausing briefly');
  } else {
    console.error(err);
    setNotice(message);
  }
}

// ---------------------------------------------------------------------------
// Each frame: move the trains, lay out their cars, drive the camera.

const frameCars: Car[] = [];
const carOwners: string[] = [];
let frameCount = 0;
let lastFrame = performance.now();

/**
 * Real scale vanishes when zoomed out, so cars are drawn a little wider and
 * longer below zoom 17.5, where they reach true size. Further out than the
 * 3D range, trains are dots instead.
 */
function exaggeration(zoom: number) {
  const k = Math.max(0, 17.5 - zoom);
  return { width: Math.min(5, 2 ** (k * 0.85)), length: Math.min(2, 2 ** (k * 0.4)), height: Math.min(2.4, 2 ** (k * 0.45)) };
}

function layout(train: Train, s: ReturnType<typeof exaggeration>, now: number, selected: boolean, starred: boolean) {
  // Directions shown: trains you won't ride go grey.
  const dim = !!tripFocus && !tripFocus.has(train.v.id) && !selected;
  const front = { x: 0, y: 0 };
  const back = { x: 0, y: 0 };
  const half = (train.length * s.length) / 2;
  let offset = 0;
  let sumX = 0;
  let sumY = 0;
  let angle = train.heading;
  // A little sway, more the faster it goes.
  const sway = 0.014 * Math.min(1, train.vel / 15);

  train.cars.forEach((spec, i) => {
    const len = spec.length * s.length;
    if (train.track) {
      train.track.at(train.d + half - offset, front);
      train.track.at(train.d + half - offset - len, back);
      if (front.x !== back.x || front.y !== back.y) angle = Math.atan2(front.y - back.y, front.x - back.x);
    } else {
      const ux = Math.cos(train.heading);
      const uy = Math.sin(train.heading);
      front.x = train.x + ux * (half - offset);
      front.y = train.y + uy * (half - offset);
      back.x = front.x - ux * len;
      back.y = front.y - uy * len;
    }
    const x = (front.x + back.x) / 2;
    const y = (front.y + back.y) / 2;
    if (i === 0) train.heading = angle;
    sumX += x;
    sumY += y;
    frameCars.push({
      x,
      y,
      angle,
      length: len,
      width: spec.width * s.width,
      height: spec.height * s.height,
      body: dim ? MUTED_BODY : train.bodies[i],
      accent: dim ? MUTED_ACCENT : train.accent,
      selected,
      followed: starred && !dim,
      // Boats rock gently even at rest.
      roll: spec.boat ? 0.02 * Math.sin(now / 900 + train.phase) : sway * Math.sin(now / 480 + train.phase + i * 0.8),
      boat: spec.boat,
    });
    carOwners.push(train.v.id);
    offset += len + train.gap * s.length;
  });
  train.x = sumX / train.cars.length;
  train.y = sumY / train.cars.length;
}

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const zoom = map.getZoom();
  const s = exaggeration(zoom);
  frameCars.length = 0;
  carOwners.length = 0;
  const selectedId = selection?.kind === 'train' ? selection.id : null;

  for (const t of trains.values()) {
    if (t.track) step(t, now, dt);
    else {
      const k = Math.min(1, (now - t.start) / t.dur);
      t.x = t.fx + (t.tx - t.fx) * k;
      t.y = t.fy + (t.ty - t.fy) * k;
      if (t.v.bearing != null) t.heading = ((90 - t.v.bearing) * Math.PI) / 180;
    }
    if (hidden.has(t.group)) continue;
    layout(t, s, now, t.v.id === selectedId, isFollowed(t.v.id));
  }

  trainLayer.setCars(zoom >= 14.6 ? frameCars : []);
  // The dots only show when zoomed out; skip rebuilding them otherwise.
  if (zoom < 16.1 || frameCount % 30 === 0) drawDots(selectedId);
  drawArrivals(now);
  driveCamera(now);
  precipitation.frame(dt, map.getBearing(), now);
  map.triggerRepaint();
  frameCount++;
  requestAnimationFrame(frame);
}

function drawDots(selectedId: string | null) {
  const features: GeoJSON.Feature[] = [];
  for (const t of trains.values()) {
    if (hidden.has(t.group)) continue;
    features.push({
      type: 'Feature',
      properties: {
        color: `#${t.accent.getHexString()}`,
        selected: t.v.id === selectedId,
        followed: isFollowed(t.v.id),
        bunched: bunched.has(t.v.id),
        small: t.route.type >= 2,
        mine: !!tripFocus?.has(t.v.id),
        dim: !!tripFocus && !tripFocus.has(t.v.id) && t.v.id !== selectedId,
      },
      geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) },
    });
  }
  source('vehicles')?.setData({ type: 'FeatureCollection', features });
}

let arrivalsShown = false;
function drawArrivals(now: number) {
  const RIPPLE_MS = 2400;
  while (arrivals.length && now - arrivals[0].start > RIPPLE_MS) arrivals.shift();
  if (!arrivals.length && !arrivalsShown) return;
  arrivalsShown = arrivals.length > 0;
  source('arrivals')?.setData({
    type: 'FeatureCollection',
    features: arrivals.map((a) => ({
      type: 'Feature',
      properties: { color: a.color, t: 1 - (1 - (now - a.start) / RIPPLE_MS) ** 2 },
      geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
    })),
  });
}

let lastCamera = performance.now();

function driveCamera(now: number) {
  // The camera eases by real time, so it settles at the same pace on a slow
  // device as on a fast one.
  const dt = Math.min(0.5, (now - lastCamera) / 1000);
  lastCamera = now;
  if (touring && now > tourNext) nextTourStop();
  if (previewing) return;
  // Never steer while someone has their hands on the map: moving the camera
  // resets MapLibre's gesture handlers, so a pinch or twist could never start.
  // In the cab, dragging looks around (handled below), so the camera keeps riding.
  const busy = cameraMode === 'cab' ? false : handsOn(now);
  if (wasBusy && !busy && riding()) {
    // They turned to look around; keep that view for a moment.
    rideLook = (((map.getBearing() - rideBearing + 540) % 360) - 180);
    lookedAt = now;
  }
  wasBusy = busy;
  if (busy || map.isEasing()) return;
  // Left alone, the overview slowly circles the city.
  if (cameraMode === 'free' && !flat() && now - lastInteraction > IDLE_ORBIT_MS) {
    map.setBearing(map.getBearing() + 1.4 * dt);
  }
  if (cameraMode === 'free' || selection?.kind !== 'train') return;
  const t = trains.get(selection.id);
  if (!t) return;
  if (cameraMode === 'follow') {
    map.setCenter(toLngLat(t.x, t.y));
    return;
  }
  if (cameraMode === 'cab') {
    driveCab(t, now, dt);
    return;
  }
  // Ride along: sit behind the train and turn with the track, smoothly.
  const target = compass(t.heading);
  const delta = ((target - rideBearing + 540) % 360) - 180;
  rideBearing = (rideBearing + delta * (1 - Math.exp(-dt / 0.9)) + 360) % 360;
  // A few seconds after looking around, swing back to behind the train.
  if (now - lookedAt > 4000) rideLook *= Math.exp(-dt / 1.2);
  // Aim past the train so it sits in the lower part of the view.
  const ahead = 45;
  map.jumpTo({
    center: toLngLat(t.x + Math.cos(t.heading) * ahead, t.y + Math.sin(t.heading) * ahead),
    bearing: rideBearing + rideLook,
  });
}

/** Looking ahead from the cab: just under level, so the horizon sits high in the view. */
const CAB_PITCH = 82;
/** Where the camera eased from on entering the cab, to blend into the moving view. */
let cabFrom: { center: maplibregl.LngLat; zoom: number; pitch: number; bearing: number; at: number } | null = null;

/** The driver's view: from the front of the lead car at eye height, looking down the line. */
function driveCab(t: Train, now: number, dt: number) {
  const lead = t.cars[0];
  const half = t.length / 2;
  const eye = { x: 0, y: 0 };
  const ahead = { x: 0, y: 0 };
  if (t.track) {
    t.track.at(t.d + half + 0.5, eye);
    // Face where the track goes next, so curves come into view as they do from a cab.
    t.track.at(t.d + half + 45, ahead);
  } else {
    const ux = Math.cos(t.heading);
    const uy = Math.sin(t.heading);
    eye.x = t.x + ux * (half + 0.5);
    eye.y = t.y + uy * (half + 0.5);
    ahead.x = eye.x + ux;
    ahead.y = eye.y + uy;
  }
  const target = compass(Math.atan2(ahead.y - eye.y, ahead.x - eye.x));
  const delta = ((target - rideBearing + 540) % 360) - 180;
  rideBearing = (rideBearing + delta * (1 - Math.exp(-dt / 0.45)) + 360) % 360;
  // Where you've looked stays put until "Look ahead" eases it back.
  if (lookingAhead) {
    const k = Math.exp(-dt / 0.25);
    rideLook *= k;
    cabTilt *= k;
    if (Math.abs(rideLook) < 0.3 && Math.abs(cabTilt) < 0.3) {
      rideLook = cabTilt = 0;
      lookingAhead = false;
    }
    showLooking();
  }
  const pitch = CAB_PITCH + cabTilt;
  // A driver's eyes sit about three quarters of the way up the cab; a ferry's bridge is up top.
  const height = lead.boat ? lead.height * 1.15 : lead.height * 0.78;
  const cam = map.calculateCameraOptionsFromCameraLngLatAltRotation(toLngLat(eye.x, eye.y), height, rideBearing + rideLook, pitch);
  if (cabFrom) {
    // Glide in from wherever the camera was, rather than cutting.
    const k = Math.min(1, (now - cabFrom.at) / 1800);
    const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
    const to = maplibregl.LngLat.convert(cam.center!);
    const turn = ((cam.bearing! - cabFrom.bearing + 540) % 360) - 180;
    cam.center = [cabFrom.center.lng + (to.lng - cabFrom.center.lng) * e, cabFrom.center.lat + (to.lat - cabFrom.center.lat) * e];
    cam.zoom = cabFrom.zoom + (cam.zoom! - cabFrom.zoom) * e;
    cam.pitch = cabFrom.pitch + (pitch - cabFrom.pitch) * e;
    cam.bearing = cabFrom.bearing + turn * e;
    if (k >= 1) cabFrom = null;
  }
  // Spell out every field: a `roll: undefined` from the helper is read as a
  // real value, and MapLibre's matrix math then throws.
  map.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch, roll: 0 });
}

// ---------------------------------------------------------------------------
// Spinning and other hands-on moves.
//
// MapLibre turns a two-finger twist on a touchscreen into a spin, and a
// right-drag or Ctrl-drag with a mouse. Trackpads are the gap: Chrome, Edge and
// Firefox never tell a web page about a trackpad twist, and Safari does (as
// gesture events) but MapLibre doesn't listen. So here a sideways two-finger
// swipe spins the map in every browser, and in Safari a real twist does too.
// Up and down still zooms, as before.

const mapEl = document.getElementById('map')!;
const pointers = new Set<number>();
let lastWheel = 0;
let wasBusy = false;

if (import.meta.env.DEV)
  Object.assign(window, {
    cameraDebug: () => ({
      pointers: pointers.size,
      sinceWheel: Math.round(performance.now() - lastWheel),
      moving: map.isMoving(),
      easing: map.isEasing(),
      rideLook: Math.round(rideLook),
      sinceLook: Math.round(performance.now() - lookedAt),
      cameraMode,
    }),
  });

function handsOn(now: number) {
  return pointers.size > 0 || now - lastWheel < 350 || map.isMoving();
}

mapEl.addEventListener('pointerdown', (e) => pointers.add(e.pointerId), { capture: true });
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  addEventListener(type, (e) => pointers.delete((e as PointerEvent).pointerId), { capture: true });
}

/** Turns the view by `degrees`, or looks around if riding along. */
function spin(degrees: number) {
  const now = performance.now();
  lastInteraction = now;
  if (cameraMode === 'cab') lookAround(degrees, 0);
  else if (riding()) {
    rideLook = (((rideLook + degrees + 540) % 360) - 180);
    lookedAt = now;
    map.setBearing(rideBearing + rideLook);
  } else {
    map.setBearing(map.getBearing() + degrees);
  }
}

// Each swipe is either a spin or a zoom, decided at its start, so a slightly
// diagonal swipe doesn't flicker between the two.
let wheelAxis: 'spin' | 'zoom' = 'zoom';
let lastPinchWheel = 0;
mapEl.addEventListener(
  'wheel',
  (e) => {
    const now = performance.now();
    if (e.ctrlKey) {
      // A trackpad pinch arrives as Ctrl+wheel; that's MapLibre's zoom.
      lastPinchWheel = now;
      lastWheel = now;
      return;
    }
    if (now - lastWheel > 250) wheelAxis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 'spin' : 'zoom';
    lastWheel = now;
    if (wheelAxis !== 'spin') return;
    e.preventDefault();
    e.stopPropagation();
    const px = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    // Swiping left pulls the near side of the city left, like grabbing it.
    spin(-px * 0.25);
  },
  { capture: true, passive: false },
);

// Safari's trackpad twist and pinch. On iPhone and iPad these come alongside
// touch events MapLibre already handles, so they're ignored while touching.
interface SafariGesture extends UIEvent {
  rotation: number;
  scale: number;
}
let gestureFrom: { bearing: number; zoom: number; look: number } | null = null;
mapEl.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  if (pointers.size) return;
  gestureFrom = { bearing: map.getBearing(), zoom: map.getZoom(), look: rideLook };
});
mapEl.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (!gestureFrom || pointers.size) return;
  const g = e as SafariGesture;
  const now = performance.now();
  lastWheel = now;
  lastInteraction = now;
  if (riding()) {
    rideLook = gestureFrom.look - g.rotation;
    lookedAt = now;
    map.setBearing(rideBearing + rideLook);
  } else {
    map.setBearing(gestureFrom.bearing - g.rotation);
  }
  // Zoom too, unless Safari is also sending the pinch as Ctrl+wheel.
  if (now - lastPinchWheel > 300) map.setZoom(gestureFrom.zoom + Math.log2(g.scale));
});
mapEl.addEventListener('gestureend', (e) => {
  e.preventDefault();
  gestureFrom = null;
});

// Looking around from the cab: drag with a finger or the mouse to turn and
// to look up or down, or twist with two fingers. The map's own drag, twist and
// zoom would pull the camera off the train, so they're off while in the cab.

/** Degrees above (+) or below (−) the usual view from the cab. */
let cabTilt = 0;
let lookingAhead = false;
const cabTouches = new Map<number, { x: number; y: number }>();

function setCabControls(on: boolean) {
  for (const handler of [map.dragPan, map.dragRotate, map.touchZoomRotate, map.touchPitch, map.scrollZoom, map.doubleClickZoom, map.keyboard]) {
    if (on) handler.disable();
    else handler.enable();
  }
  cabTouches.clear();
}

/** Turn and tilt the view from the cab, in degrees. */
function lookAround(turn: number, tilt: number) {
  lookingAhead = false;
  rideLook = ((((rideLook + turn) % 360) + 540) % 360) - 180;
  // Up to just under level: past that MapLibre can't place the camera this close to the ground.
  cabTilt = Math.max(-26, Math.min(2, cabTilt + tilt));
  lookedAt = performance.now();
  showLooking();
}

function showLooking() {
  hudEl.classList.toggle('looking', cameraMode === 'cab' && (Math.abs(rideLook) > 4 || Math.abs(cabTilt) > 3));
}

const twist = (a: { x: number; y: number }, b: { x: number; y: number }) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

mapEl.addEventListener('pointerdown', (e) => {
  if (cameraMode !== 'cab') return;
  cabTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
addEventListener('pointermove', (e) => {
  const was = cabTouches.get(e.pointerId);
  if (cameraMode !== 'cab' || !was) return;
  const now = { x: e.clientX, y: e.clientY };
  if (cabTouches.size === 1) {
    // Grab the view: drag right to look left, drag down to look up.
    lookAround(-(now.x - was.x) * 0.3, (now.y - was.y) * 0.12);
  } else if (cabTouches.size === 2) {
    const other = [...cabTouches.entries()].find(([id]) => id !== e.pointerId)![1];
    const delta = ((twist(other, now) - twist(other, was) + 540) % 360) - 180;
    lookAround(-delta, 0);
  }
  cabTouches.set(e.pointerId, now);
});
for (const type of ['pointerup', 'pointercancel'] as const) addEventListener(type, (e) => cabTouches.delete(e.pointerId));


function setCameraMode(mode: CameraMode) {
  const was = cameraMode;
  cameraMode = mode;
  document.body.classList.toggle('cinematic', riding());
  document.body.classList.toggle('cab', mode === 'cab');
  const t = selection?.kind === 'train' ? trains.get(selection.id) : undefined;
  updatePadding(true);
  if (mode === 'cab') {
    // The cab view looks nearly level and sits a few meters off the ground.
    rideLook = 0;
    cabTilt = 0;
    lookingAhead = false;
    setCabControls(true);
    map.setMaxPitch(85);
    map.setMaxZoom(24);
    const c = map.getCenter();
    cabFrom = { center: c, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), at: performance.now() };
    if (t && was !== 'ride') rideBearing = compass(t.heading);
    map.stop();
  } else if (was === 'cab') {
    cabFrom = null;
    setCabControls(false);
    cabTilt = 0;
    hudEl.classList.remove('looking');
    // Lift out of the cab before putting the limits back, or the view snaps.
    map.once('moveend', () => {
      if (cameraMode === 'cab') return;
      map.setMaxZoom(22);
      map.setMaxPitch(flat() ? 0 : 78);
    });
  }
  if (t && mode === 'ride') {
    rideBearing = compass(t.heading);
    rideLook = 0;
    map.easeTo({
      center: toLngLat(t.x, t.y),
      zoom: t.route.type === 2 ? 17.4 : 18,
      pitch: flat() ? 0 : 72,
      bearing: rideBearing,
      duration: was === 'cab' ? 1400 : 2200,
      essential: true,
    });
  } else if (was === 'cab' && mode !== 'ride') {
    map.easeTo({ pitch: flat() ? 0 : 60, zoom: 16.5, duration: 1400 });
  } else if (t && mode === 'follow') {
    map.easeTo({
      center: toLngLat(t.x, t.y),
      zoom: Math.max(map.getZoom(), 15.8),
      pitch: flat() ? 0 : 55,
      duration: 1500,
    });
  }
  if (!riding() && touring) setTouring(false);
  renderDetail();
  renderHud();
}

// Tour: ride a random moving train for a while, then hop to another.
function nextTourStop() {
  const moving = [...trains.values()].filter(
    (t) => !hidden.has(t.group) && t.v.status !== 'STOPPED_AT' && t.vel > 2 && t.track,
  );
  const pool = moving.length ? moving : [...trains.values()];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  tourNext = performance.now() + TOUR_MS;
  if (pick) {
    select({ kind: 'train', id: pick.v.id }, true);
    setCameraMode('ride');
  }
}

function setTouring(on: boolean) {
  if (touring === on) return;
  touring = on;
  if (on) nextTourStop();
  else renderHud();
}

// ---------------------------------------------------------------------------
// Picking: trains are drawn by three.js, so hit-test their cars on screen.

function trainAt(point: maplibregl.Point): string | null {
  let best: string | null = null;
  let bestDist = 22;
  frameCars.forEach((c, i) => {
    const p = map.project(toLngLat(c.x, c.y));
    const dist = Math.hypot(p.x - point.x, p.y - point.y);
    if (dist < bestDist) [best, bestDist] = [carOwners[i], dist];
  });
  return best;
}

function featureAt(point: maplibregl.Point, layerIds: string[]) {
  const ids = layerIds.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  return map.queryRenderedFeatures(
    [
      [point.x - 8, point.y - 8],
      [point.x + 8, point.y + 8],
    ],
    { layers: ids },
  )[0];
}

map.on('click', (e) => {
  if (riding()) return;
  // Choosing a start or destination: the tapped spot is it.
  if (selection?.kind === 'trip' && trip.editing) return pickOnMap(e.lngLat.lng, e.lngLat.lat);
  const train = trainAt(e.point);
  if (train) return select({ kind: 'train', id: train });
  const station = featureAt(e.point, ['stations']);
  if (station) return select({ kind: 'station', id: String(station.properties.id) });
  const dock = featureAt(e.point, ['bikes']);
  if (dock) return select({ kind: 'dock', id: String(dock.properties.id) });
  // Directions stay up until they're closed.
  if (selection?.kind === 'trip') return;
  select(null);
});

// Hit-testing every car is too much for every mouse event; once a frame is plenty.
let hoverQueued = false;
map.on('mousemove', (e) => {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    const hit = trainAt(e.point) || featureAt(e.point, ['stations', 'bikes']);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  });
});

// Dragging with one finger or the mouse hands the camera back. Two fingers
// are a pinch or a twist, which work while following or riding along.
map.on('dragstart', () => {
  if (cameraMode !== 'free' && pointers.size < 2) setCameraMode('free');
});
for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
  addEventListener(type, () => (lastInteraction = performance.now()), { passive: true });
}
map.on('rotate', () => {
  $('#compass svg').style.transform = `rotate(${-map.getBearing()}deg)`;
});

// ---------------------------------------------------------------------------
// Interface

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const sheetEl = $('#sheet');
const mainEl = $('#view-main');
const detailEl = $('#view-detail');
const searchView = $('#view-search');
const searchEl = $<HTMLInputElement>('#search');
const commuteEl = $('#commute');
const hudEl = $('#hud');
const toastEl = $('#toast');
const sheet = new Sheet(sheetEl, [$('.grabber'), $('.top'), $('.tabs')], () => updatePadding());

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const ICON = {
  back: '<svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="m8 1.8 1.85 3.9 4.25.5-3.15 2.9.85 4.2L8 11.2l-3.8 2.1.85-4.2L1.9 6.2l4.25-.5z" fill="currentColor"/></svg>',
  starLine:
    '<svg viewBox="0 0 16 16"><path d="m8 1.8 1.85 3.9 4.25.5-3.15 2.9.85 4.2L8 11.2l-3.8 2.1.85-4.2L1.9 6.2l4.25-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6L13 8z" fill="currentColor"/></svg>',
  gauge:
    '<svg viewBox="0 0 20 20"><path d="M3.5 13.5a6.5 6.5 0 1 1 13 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 13.5 13.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bike: '<svg viewBox="0 0 20 20"><circle cx="5" cy="13" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="15" cy="13" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 13 8 7h4.5L15 13M8 7l2 6M11.5 5H14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rain: '<svg viewBox="0 0 20 20"><path d="M6 12.5a3.5 3.5 0 0 1 .4-7A4.5 4.5 0 0 1 15 7a3 3 0 0 1 0 5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m8 14-1 2.5M11.5 14l-1 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  alert:
    '<svg viewBox="0 0 20 20"><path d="M10 3.2 17.4 16H2.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.2v3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="13.9" r="1" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M8 14.5s4.5-4.2 4.5-7.8a4.5 4.5 0 0 0-9 0c0 3.6 4.5 7.8 4.5 7.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="6.6" r="1.6" fill="currentColor"/></svg>',
  pinOn:
    '<svg viewBox="0 0 16 16"><path d="M8 14.5s4.5-4.2 4.5-7.8a4.5 4.5 0 0 0-9 0c0 3.6 4.5 7.8 4.5 7.8z" fill="currentColor"/><circle cx="8" cy="6.6" r="1.7" fill="#0a0c10"/></svg>',
  chevron: '<svg viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cab: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 7.2h11M5 13.5l1.2-3M11 13.5l-1.2-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chase: '<svg viewBox="0 0 16 16"><path d="M3 12.5 8 3l5 9.5-5-2.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  bell: '<svg viewBox="0 0 20 20"><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.3 17a1.9 1.9 0 0 0 3.4 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  walk: '<svg viewBox="0 0 20 20"><circle cx="11" cy="3.8" r="1.6" fill="currentColor"/><path d="m7.5 18 2.2-5.2 2.3 2.2v3M9.7 12.8l.8-4.8-2.6 1.2-1 2.6M10.5 8l2 2.4 2.5.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  install:
    '<svg viewBox="0 0 20 20"><rect x="5" y="2.5" width="10" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6.5v6M7.5 10l2.5 2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  share:
    '<svg viewBox="0 0 16 16"><path d="M8 10V2M5 4.5 8 1.8l3 2.7M4.5 7H3.5v7h9V7h-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  train:
    '<svg viewBox="0 0 16 16"><rect x="3.5" y="1.8" width="9" height="10" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 7.2h9M5.5 14.5l1-2.5M10.5 14.5l-1-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  station: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  search:
    '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.5 10.5 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  locate:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 1.2v2.2M8 12.6v2.2M1.2 8h2.2M12.6 8h2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  swap: '<svg viewBox="0 0 16 16"><path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16"><path d="m6.5 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  directions:
    '<svg viewBox="0 0 16 16"><path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 10V7.5h4M8.5 6 10 7.5 8.5 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function setNotice(message: string | null) {
  notice = message;
  renderStatus();
}

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

function renderStatus() {
  const el = $('#status-text');
  $('#status').classList.toggle('warn', !!notice);
  if (notice) {
    el.textContent = notice;
    return;
  }
  if (!lastUpdate) {
    el.textContent = 'Connecting to the MBTA…';
    return;
  }
  const secs = Math.round((Date.now() - lastUpdate) / 1000);
  const shown = [...trains.values()].filter((t) => !hidden.has(t.group)).length;
  el.textContent = `${shown} vehicles live · ${secs < 3 ? 'now' : `${secs}s ago`}`;
}

function tick() {
  const parts = clockFmt.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  $('#clock').innerHTML = `${get('hour')}:${get('minute')}<span>${get('dayPeriod')}</span>`;
  renderStatus();
  // Live countdowns wherever they appear.
  document.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => {
    el.textContent = countdown(Number(el.dataset.at));
  });
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => {
    el.textContent = ago(Number(el.dataset.ago));
  });
  if (touring) {
    const left = Math.max(0, Math.ceil((tourNext - performance.now()) / 1000));
    const el = hudEl.querySelector('[data-tour-left]');
    if (el) el.textContent = `${left}s`;
  }
  document.querySelectorAll<HTMLElement>('[data-leave]').forEach((el) => {
    if (el.dataset.leave) el.textContent = leaveText(Number(el.dataset.leave));
  });
  renderCommute();
  remindIfTime();
}

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} hr ago`;
  const days = Math.round(s / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function countdown(at: number) {
  const s = Math.round((at - Date.now()) / 1000);
  if (s <= 30) return 'Now';
  if (s < 90) return '1 min';
  // An hour or more out, the time reads better than the wait.
  if (s >= 3600) return clockFmt.format(at);
  return `${Math.round(s / 60)} min`;
}

function renderConditions() {
  const parts = [weather.tempF != null ? `${Math.round(weather.tempF)}°` : '', weather.label].filter(Boolean);
  $('#conditions').textContent = parts.join(' ');
}

function groupColor(g: Group) {
  const route = network && [...network.routes.values()].find(g.match);
  return route ? displayColor(route.color) : (g.color ?? '#777');
}

function groupRoutes(g: Group) {
  return network ? [...network.routes.values()].filter(g.match) : [];
}

function groupSubtitle(g: Group) {
  const routes = groupRoutes(g);
  if (g.id === 'Green') return 'B · C · D · E branches';
  if (g.id === 'SL') return routes.map((r) => r.short).join(' · ');
  if (g.id === 'CR') return routes.length ? `${routes.length} lines from North & South Station` : '';
  if (g.id === 'Ferry') return routes.length ? `${routes.length} routes across the harbor` : 'Across the harbor';
  if (g.id === 'Amtrak') return 'On the T’s tracks into South & North Station';
  const [to0, to1] = routes[0]?.destinations ?? [];
  return to0 && to1 ? `${to1} ↔ ${to0}` : '';
}

function hex(t: Train) {
  return `#${t.accent.getHexString()}`;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Tabs -------------------------------------------------------------------------

function setTab(next: Tab) {
  tab = next;
  sheetEl.dataset.tab = next;
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === next)));
  if (selection) select(null);
  closeSearch();
  renderMain(true);
  sheet.reveal();
}

function renderMain(enter = false) {
  // Keep the reader's place when a list refreshes under them.
  const scroll = enter ? 0 : mainEl.scrollTop;
  mainEl.classList.toggle('enter', enter);
  if (tab === 'lines') renderLines();
  else if (tab === 'alerts') renderAlertsTab();
  else if (tab === 'following') renderFollowing();
  else renderMapTab();
  mainEl.scrollTop = scroll;
  renderFollowingBadge();
}

function groupCounts() {
  const counts = new Map<string, number>();
  for (const t of trains.values()) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  return counts;
}

function renderLines() {
  const counts = groupCounts();
  mainEl.innerHTML = `
    <ul class="lines">
      ${GROUPS.map((g, i) => {
        const on = !hidden.has(g.id);
        const issues = groupAlerts(g);
        const flag = issues.length
          ? `<em class="flag" data-show-alerts title="${escape(issues[0].header)}">${effectLabel(issues[0].effect)}${issues.length > 1 ? ` +${issues.length - 1}` : ''}</em>`
          : '';
        const divider = g.id === 'Amtrak' ? `<li class="lines-divider" style="--i:${i}"><span>Sharing the rails</span></li>` : '';
        return `${divider}<li class="line${on ? '' : ' off'}" style="--c:${groupColor(g)};--i:${i}">
          <button class="line-main" data-focus="${g.id}" title="Show the ${g.label} on the map">
            <span class="line-swatch"></span>
            <span class="line-text"><strong>${g.label}${flag}</strong><small>${escape(groupSubtitle(g))}</small></span>
            <span class="line-count"><b data-count="${g.id}">${counts.get(g.id) ?? 0}</b><small>${g.unit}</small></span>
          </button>
          <button class="switch" role="switch" aria-checked="${on}" aria-label="Show ${g.label}" data-toggle="${g.id}"></button>
        </li>`;
      }).join('')}
    </ul>
    <button class="cta" data-action="tour" style="--i:${GROUPS.length + 1}">
      <span class="cta-icon">${ICON.play}</span>
      <span><strong>Take the tour</strong><small>Ride along with trains across the city</small></span>
    </button>`;
}

/** Updates the live numbers in place, without redrawing the list. */
function refreshCounts() {
  const counts = groupCounts();
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    el.textContent = String(counts.get(el.dataset.count!) ?? 0);
  });
  renderStatus();
}

function vehicleLabel(t: Train) {
  if (t.route.type === AMTRAK_TYPE) return `Amtrak ${t.v.label}`;
  if (t.route.type === 4) return titleCase(t.v.label);
  if (t.route.type === 2 && t.v.tripName) return `Train ${t.v.tripName}`;
  return `${t.route.type === 3 ? 'Bus' : 'Car'} ${t.v.label}`;
}

function statusLine(t: Train) {
  const where = escape(t.v.stopName ?? 'its next stop');
  if (t.v.status === 'STOPPED_AT') return `At ${where}`;
  if (t.v.status === 'INCOMING_AT') return `Arriving at ${where}`;
  return `Next: ${where}`;
}

function destination(t: Train) {
  return t.v.headsign ?? t.route.destinations[t.v.directionId] ?? '';
}

function mph(t: Train) {
  return t.speed != null && t.v.status !== 'STOPPED_AT' ? Math.round(t.speed * 2.237) : null;
}

/** "On time", "12 min late" for Amtrak, which publishes how late it's running. */
function lateness(id: string) {
  const late = amtrakInfo.get(id)?.late;
  if (late == null) return null;
  return late >= 3 ? { text: `${late} min late`, late: true } : { text: 'On time', late: false };
}

function renderFollowing() {
  if (!followed.length) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON.starLine}</div>
        <strong>No trains yet</strong>
        <p>Open any train and tap the star. It’ll live here with where it is right now, and glow gold on the map.</p>
      </div>`;
    return;
  }
  mainEl.innerHTML = `<ul class="cards">${followed
    .map((f, i) => {
      const t = trains.get(f.id);
      const route = network?.routes.get(t?.v.routeId ?? f.routeId);
      const c = route ? displayColor(route.color) : '#777';
      const name = escape(route?.name ?? f.routeId);
      const speed = t ? mph(t) : null;
      return `<li style="--c:${c};--i:${i}">
        <button class="card" ${t ? `data-train="${escape(f.id)}"` : 'disabled'}>
          <span class="card-bar"></span>
          <span class="card-text">
            <small>${name} · ${escape(t ? vehicleLabel(t) : f.label)}</small>
            <strong>${t ? `To ${escape(destination(t))}` : 'Not running right now'}</strong>
            <span>${t ? statusLine(t) : 'Back here when it’s in service again'}</span>
          </span>
          ${t ? `<span class="card-side"><b>${speed != null ? `${speed}` : t.v.status === 'STOPPED_AT' ? '0' : '–'}</b><small>mph</small></span>` : ''}
        </button>
        <button class="icon-btn subtle" data-unfollow="${escape(f.id)}" aria-label="Stop following">${ICON.close}</button>
      </li>`;
    })
    .join('')}</ul>`;
}

// Alerts tab -------------------------------------------------------------------

/** Alert cards the reader has opened, kept open across refreshes. */
const openAlerts = new Set<string>();

function lineList(names: string[]) {
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function alertCard(a: Alert, i: number) {
  const { names, color } = alertLines(a);
  const cause = causeLabel(a.cause);
  const outside = EXTERNAL.has(a.cause);
  const canShow = alertStations(a).length > 0 || a.routes.some((id) => network?.routeShapes.has(id));
  return `<li style="--c:${color};--i:${i}">
    <details class="alert${isDisruptive(a) ? ' severe' : ''}" data-alert="${escape(a.id)}"${openAlerts.has(a.id) ? ' open' : ''}>
      <summary>
        <span class="card-bar"></span>
        <span class="alert-text">
          <small>${escape(lineList(names) || 'MBTA')} · ${escape(effectLabel(a.effect))}</small>
          <strong>${escape(a.header)}</strong>
          <span class="chips">${cause ? `<em class="chip${outside ? ' outside' : ''}">${escape(cause)}</em>` : ''}<span>Updated <span data-ago="${a.updatedAt}">${ago(a.updatedAt)}</span></span></span>
        </span>
        <span class="chev">${ICON.chevron}</span>
      </summary>
      <div class="alert-body">
        ${a.description ? `<p>${escape(a.description).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>` : ''}
        <div class="alert-actions">
          ${canShow ? `<button class="btn small" data-alert-map="${escape(a.id)}">Show on map</button>` : ''}
          ${a.url ? `<a class="btn small" href="${escape(a.url)}" target="_blank" rel="noopener">More on mbta.com</a>` : ''}
        </div>
      </div>
    </details>
  </li>`;
}

function feet(m: number) {
  return Math.max(10, Math.round((m * 3.281) / 10) * 10).toLocaleString();
}

function bunchCard(b: Bunch, i: number) {
  const t = b.behind;
  const branch = t.v.routeId.startsWith('Green-') ? ` · ${t.v.routeId.slice(-1)} branch` : '';
  return `<li style="--c:${hex(t)};--i:${i}">
    <button class="card" data-train="${escape(t.v.id)}">
      <span class="card-bar"></span>
      <span class="card-text">
        <small>${escape(t.route.name)}${branch}</small>
        <strong>To ${escape(destination(t))}</strong>
        <span>Near ${escape(b.ahead.v.stopName ?? b.behind.v.stopName ?? 'the next stop')}</span>
      </span>
      <span class="card-side"><b>${feet(b.gap)}</b><small>ft apart</small></span>
    </button>
  </li>`;
}

/** Things beyond the T that hold it up: Amtrak, freight, drawbridges, the harbor. */
function outsideHtml() {
  const amtrak = [...trains.values()].filter((t) => t.group === 'Amtrak');
  const late = amtrak
    .map((t) => ({ t, late: amtrakInfo.get(t.v.id)?.late ?? 0 }))
    .filter((x) => x.late >= 5)
    .sort((a, b) => b.late - a.late);
  const external = alerts.filter((a) => EXTERNAL.has(a.cause));
  const rows: string[] = [];
  rows.push(`<li style="--c:${AMTRAK_COLOR}">
    <button class="card" data-focus="Amtrak">
      <span class="card-bar"></span>
      <span class="card-text">
        <small>Amtrak</small>
        <strong>${amtrak.length ? `${amtrak.length} train${amtrak.length === 1 ? '' : 's'} near Boston` : 'No Amtrak trains near Boston'}</strong>
        <span>${
          !amtrak.length
            ? 'They share the Providence, Worcester and Haverhill lines'
            : late.length
              ? late.map((x) => `${escape(vehicleLabel(x.t))} ${x.late} min late`).slice(0, 2).join(' · ')
              : 'All running on time'
        }</span>
      </span>
      <span class="card-side"><b>${late.length}</b><small>late</small></span>
    </button>
  </li>`);
  for (const a of external) {
    const { names, color } = alertLines(a);
    rows.push(`<li style="--c:${color}">
      <button class="card" data-open-alert="${escape(a.id)}">
        <span class="card-bar"></span>
        <span class="card-text">
          <small>${escape(lineList(names))}</small>
          <strong>${escape(causeLabel(a.cause) ?? effectLabel(a.effect))}</strong>
          <span>${escape(a.summary || a.header)}</span>
        </span>
      </button>
    </li>`);
  }
  return `<ul class="cards">${rows.join('')}</ul>
    <p class="fine tight">${
      external.length ? '' : 'No freight, drawbridge or harbor holdups reported right now. '
    }Freight railroads don’t publish where their trains are, so a freight delay shows up here when the MBTA reports it.</p>`;
}

function renderAlertsTab() {
  if (!network) {
    mainEl.innerHTML = '<p class="muted">Loading…</p>';
    return;
  }
  const shown = (a: Alert) => {
    const routes = a.routes.map((id) => network!.routes.get(id)).filter((r): r is Route => !!r);
    return !routes.length || routes.some((r) => !hidden.has(groupOf(r)));
  };
  const service = serviceAlerts().filter(shown);
  const disruptive = service.filter(isDisruptive);
  const minor = service.filter((a) => !isDisruptive(a));
  const access = alerts.filter((a) => alertKind(a) === 'access' && shown(a));
  const notices = alerts.filter((a) => alertKind(a) === 'notice' && shown(a));
  const bunch = bunches.filter((b) => !hidden.has(b.behind.group));
  let i = 0;
  const cards = (list: Alert[]) => `<ul class="cards">${list.map((a) => alertCard(a, i++)).join('')}</ul>`;

  mainEl.innerHTML = `
    <div class="tally" style="--i:0">
      <div class="${disruptive.length ? 'bad' : 'good'}"><b>${disruptive.length}</b><small>${disruptive.length === 1 ? 'Disruption' : 'Disruptions'}</small></div>
      <div class="${bunch.length ? 'bad' : 'good'}"><b>${bunch.length}</b><small>Bunched</small></div>
      <div><b>${access.length}</b><small>Elevators & ramps</small></div>
    </div>
    <section class="group" style="--i:1">
      <h3>Service</h3>
      ${
        disruptive.length || minor.length
          ? cards([...disruptive, ...minor])
          : `<div class="all-good"><span class="pulse" aria-hidden="true"></span>Good service on every line</div>`
      }
    </section>
    ${
      bunch.length
        ? `<section class="group" style="--i:2">
            <h3>Bunched trains</h3>
            <ul class="cards">${bunch.map((b, k) => bunchCard(b, k)).join('')}</ul>
            <p class="fine tight">Trains running nose to tail, which usually means a long gap behind them.</p>
          </section>`
        : ''
    }
    <section class="group" style="--i:3">
      <h3>From outside the T</h3>
      ${outsideHtml()}
    </section>
    ${
      access.length
        ? `<section class="group" style="--i:4">
            <details class="fold"${openAlerts.has('fold:access') ? ' open' : ''} data-alert="fold:access">
              <summary><h3>Elevators & escalators <span>${access.length}</span></h3>${ICON.chevron}</summary>
              ${cards(access)}
            </details>
          </section>`
        : ''
    }
    ${
      notices.length
        ? `<section class="group" style="--i:5">
            <details class="fold"${openAlerts.has('fold:notices') ? ' open' : ''} data-alert="fold:notices">
              <summary><h3>Notices <span>${notices.length}</span></h3>${ICON.chevron}</summary>
              ${cards(notices)}
            </details>
          </section>`
        : ''
    }
    <p class="credits" style="--i:6">Alerts from the MBTA, refreshed every minute and a half. Bunching is worked out here from live train positions.</p>`;
}

mainEl.addEventListener(
  'toggle',
  (e) => {
    const el = e.target as HTMLDetailsElement;
    const id = el.dataset?.alert;
    if (!id) return;
    if (el.open) openAlerts.add(id);
    else openAlerts.delete(id);
  },
  true,
);

function renderAlertsBadge() {
  const badge = $('#alerts-count');
  const n = serviceAlerts().filter(isDisruptive).length;
  badge.textContent = String(n);
  badge.hidden = !n;
}

/** Frames everything an alert names: its stations, or failing that, its lines. */
function showAlert(id: string) {
  const a = alerts.find((x) => x.id === id);
  if (!a || !network) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const coords of alertStretches(a)) for (const p of coords) bounds.extend(p);
  for (const s of alertStations(a)) bounds.extend([s.lng, s.lat]);
  if (bounds.isEmpty()) for (const r of a.routes) for (const s of network.routeShapes.get(r) ?? []) for (const p of network.shapes.get(s) ?? []) bounds.extend(p);
  if (bounds.isEmpty()) return;
  if (!layers.alerts) {
    layers.alerts = true;
    save(LAYERS_KEY, layers);
    applyLayerToggles();
  }
  if (isPhone()) sheet.set('peek');
  map.fitBounds(bounds, { padding: 72, maxZoom: 15.5, pitch: flat() ? 0 : 45, bearing: flat() ? 0 : map.getBearing(), duration: 1500 });
}

// Map tab ----------------------------------------------------------------------

function sunPhase() {
  if (sky.day > 0.85) return 'Daylight';
  if (sky.dusk > 0.25 || sky.day > 0.1) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(skyTime()));
    return hour < 12 ? 'Sunrise' : 'Sunset';
  }
  return 'Night';
}

function setting(id: keyof typeof layers, icon: string, title: string, note: string) {
  return `<div class="setting">
    <span class="setting-icon">${icon}</span>
    <span class="setting-text"><strong>${title}</strong><small>${note}</small></span>
    <button class="switch" role="switch" aria-checked="${layers[id]}" aria-label="${title}" data-layer="${id}"></button>
  </div>`;
}

function legendHtml() {
  return `${SPEED_SCALE.map(([v, c], i) => `<span style="--c:${c}">${SPEED_SCALE[i + 1] ? v : `${v}+`}</span>`).join('')}<em>mph</em>`;
}

function installHtml() {
  const mode = installMode();
  if (mode === 'prompt')
    return `<div class="setting">
      <span class="setting-icon">${ICON.install}</span>
      <span class="setting-text"><strong>Get the app</strong><small>Install Live Boston on this device</small></span>
      <button class="btn small light" data-action="install">Install</button>
    </div>`;
  if (mode === 'ios')
    return `<div class="setting">
      <span class="setting-icon">${ICON.install}</span>
      <span class="setting-text"><strong>Get the app</strong><small>Tap Share <span class="inline-icon">${ICON.share}</span> then Add to Home Screen</small></span>
    </div>`;
  if (mode === 'installed')
    return `<div class="setting">
      <span class="setting-icon">${ICON.install}</span>
      <span class="setting-text"><strong>Installed</strong><small>You’re using the Live Boston app</small></span>
    </div>`;
  return '';
}

function renderMapTab() {
  const { rise, set } = sunTimes(skyTime());
  const bikes = docks.reduce((n, d) => n + d.bikes + d.ebikes, 0);
  const app = installHtml();
  mainEl.innerHTML = `
    <section class="group" style="--i:0">
      <h3>View</h3>
      <div class="seg" role="radiogroup" aria-label="Map view" data-value="${viewMode}">
        <button role="radio" data-view="2d" aria-checked="${viewMode === '2d'}">2D</button>
        <button role="radio" data-view="3d" aria-checked="${viewMode === '3d'}">3D</button>
      </div>
    </section>
    <section class="group" style="--i:1">
      <h3>Layers</h3>
      ${setting('alerts', ICON.alert, 'Disruptions', 'Suspended stretches and closed stations in amber')}
      ${setting('speed', ICON.gauge, 'Speed map', 'Track colored by how fast trains really move')}
      ${layers.speed ? `<div class="legend">${legendHtml()}</div>` : ''}
      ${setting(
        'bikes',
        ICON.bike,
        'Bluebikes',
        layers.bikes && docks.length ? `${bikes.toLocaleString()} bikes at ${docks.length} docks now` : 'Live bikes and open docks',
      )}
      ${setting('weather', ICON.rain, 'Weather', 'Live rain and snow over the city')}
    </section>
    ${app ? `<section class="group" style="--i:2"><h3>App</h3>${app}</section>` : ''}
    <section class="group" style="--i:3">
      <h3>Moving around</h3>
      <ul class="moves">
        ${(touchFirst
          ? [
              ['Spin', 'Twist with two fingers'],
              ['Tilt', 'Drag two fingers up or down'],
              ['Zoom', 'Pinch'],
            ]
          : [
              ['Spin', 'Swipe sideways with two fingers, or right-drag'],
              ['Tilt', 'Ctrl-drag, or right-drag up and down'],
              ['Zoom', 'Pinch, or scroll'],
              ['Find', 'Press / to search'],
            ]
        )
          .map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`)
          .join('')}
      </ul>
    </section>
    <section class="group" style="--i:4">
      <h3>Sky over Boston</h3>
      <div class="sky">
        <div><small>Now</small><strong>${sunPhase()}</strong></div>
        <div><small>Sunrise</small><strong>${rise ? clockFmt.format(rise) : '—'}</strong></div>
        <div><small>Sunset</small><strong>${set ? clockFmt.format(set) : '—'}</strong></div>
      </div>
    </section>
    <p class="credits" style="--i:5">Live data from the MBTA, Amtrak (via Amtraker), Bluebikes and Open-Meteo. Map data © OpenStreetMap contributors, OpenMapTiles.</p>`;
}

onInstallChange(() => tab === 'map' && renderMain());

function renderFollowingBadge() {
  const badge = $('#following-count');
  badge.textContent = String(followed.length);
  badge.hidden = !followed.length;
}

// Selection and details ---------------------------------------------------------

let upcoming: UpcomingStop[] | null = null;
let departures: Departure[] | null = null;
let refreshTimer: number | undefined;

function select(next: Selection, keepTour = false) {
  if (!keepTour) setTouring(false);
  if (next?.kind === selection?.kind && next?.id === selection?.id) return;
  // Closing (not stepping back to it) ends the directions too.
  if (!next && tripActive) closeTrip();
  selection = next;
  upcoming = null;
  departures = null;
  clearInterval(refreshTimer);
  if (cameraMode !== 'free' && !keepTour) setCameraMode('free');
  const hash = next && next.kind !== 'dock' && next.kind !== 'trip' ? `#${next.kind}=${encodeURIComponent(next.id)}` : '';
  history.replaceState(null, '', hash || location.pathname + location.search);
  sheetEl.classList.toggle('has-detail', !!next);
  // Directions open: the card that opens them steps aside.
  sheetEl.classList.toggle('has-trip', next?.kind === 'trip');
  renderDetail();
  if (!next) return;
  detailEl.scrollTop = 0;
  sheet.reveal();
  refreshPanelData();
  refreshTimer = window.setInterval(refreshPanelData, PANEL_REFRESH_MS);
  const place =
    next.kind === 'station' ? stations.find((s) => s.id === next.id) : next.kind === 'dock' ? docks.find((d) => d.id === next.id) : undefined;
  if (place) map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 15), duration: 1200 });
}

async function refreshPanelData() {
  if (document.hidden || !selection || selection.kind === 'dock') return;
  const sel = selection;
  if (sel.kind === 'trip') {
    refreshTrip();
    return;
  }
  // Amtrak's own feed already carries its stops.
  if (sel.kind === 'train' && isAmtrak(sel.id)) {
    upcoming = amtrakStops(sel.id);
    renderDetail();
    renderHud();
    return;
  }
  try {
    if (sel.kind === 'train') {
      const tripId = trains.get(sel.id)?.v.tripId;
      if (!tripId) return;
      const stops = await loadUpcomingStops(tripId);
      if (selection === sel) upcoming = stops;
    } else {
      const deps = await loadDepartures(sel.id);
      if (selection === sel) departures = deps;
    }
    if (selection === sel) {
      renderDetail();
      renderHud();
    }
  } catch (err) {
    handleError(err, 'Couldn’t load arrival times');
  }
}

/** Keeps the map's center clear of the sidebar or sheet, so centered things stay in view. */
function updatePadding(immediate = false) {
  const cinematic = riding();
  const phone = isPhone();
  // Layout position, not the on-screen one: the sidebar may be mid-slide.
  const left = !cinematic && !phone ? Math.max(0, sheetEl.offsetLeft + sheetEl.offsetWidth) : 0;
  const bottom = !cinematic && phone ? Math.min(sheet.height, innerHeight * 0.6) : 0;
  // Cards that float above the sheet on phones sit just over it.
  document.documentElement.style.setProperty('--peek', `${phone ? sheet.height : 0}px`);
  const now = map.getPadding();
  if (Math.abs((now.left ?? 0) - left) < 1 && Math.abs((now.bottom ?? 0) - bottom) < 1) return;
  // Setting padding stops any camera animation, so wait for it to land.
  if (map.isEasing() && !immediate) map.once('moveend', () => updatePadding());
  else map.setPadding({ top: 0, right: 0, left, bottom });
}
addEventListener('resize', () => updatePadding());

function detailNav(starredId?: string) {
  const label =
    tripActive && selection?.kind !== 'trip' ? 'Directions' : { lines: 'Lines', alerts: 'Alerts', following: 'Following', map: 'Map' }[tab];
  const on = starredId ? isFollowed(starredId) : false;
  const star = starredId
    ? `<button class="icon-btn${on ? ' starred' : ''}" data-action="star" aria-pressed="${on}" aria-label="${on ? 'Stop following' : 'Follow'}" title="${
        on ? 'Following' : 'Follow this train'
      }">${on ? ICON.star : ICON.starLine}</button>`
    : '';
  return `<div class="detail-nav">
    <button class="back" data-action="back">${ICON.back}<span>${label}</span></button>
    <div class="detail-tools">${star}<button class="icon-btn" data-action="back" aria-label="Close">${ICON.close}</button></div>
  </div>`;
}

function renderDetail() {
  if (!selection) {
    detailEl.innerHTML = '';
    return;
  }
  if (selection.kind === 'train') renderTrain(selection.id);
  else if (selection.kind === 'station') renderStation(selection.id);
  else if (selection.kind === 'trip') renderTrip();
  else renderDock(selection.id);
}

function banner(a: Alert) {
  const cause = causeLabel(a.cause);
  const outside = EXTERNAL.has(a.cause);
  return `<div class="banner${alertKind(a) === 'access' ? ' access' : ''}">
    <span class="banner-icon">${ICON.alert}</span>
    <div><strong>${escape(effectLabel(a.effect))}${cause ? ` <em class="chip${outside ? ' outside' : ''}">${escape(cause)}</em>` : ''}</strong><p>${escape(a.header)}</p></div>
  </div>`;
}

function bunchBanner(t: Train) {
  const b = bunches.find((x) => x.behind === t || x.ahead === t);
  if (!b) return '';
  const text =
    b.behind === t
      ? `Running ${feet(b.gap)} ft behind the train ahead. Expect it to be crowded.`
      : `Another train is ${feet(b.gap)} ft behind this one, so the wait after them will be long.`;
  return `<div class="banner"><span class="banner-icon">${ICON.alert}</span><div><strong>Bunched</strong><p>${text}</p></div></div>`;
}

function renderTrain(id: string) {
  const t = trains.get(id);
  if (!t) return;
  const v = t.v;
  const bus = t.route.type === 3;
  const boat = t.route.type === 4;
  const amtrak = t.route.type === AMTRAK_TYPE;
  const c = hex(t);
  const branch = v.routeId.startsWith('Green-') ? ` · ${v.routeId.slice(-1)} branch` : '';
  const speed = mph(t);
  const next = upcoming?.[0];
  const { r, g, b } = t.accent;
  const onAccent = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0a0c10' : '#ffffff';
  const late = amtrak ? lateness(id) : null;

  const consistHtml = t.cars
    .map((car, i) => `<span class="car${car === LOCOMOTIVE || car === AMTRAK_LOCO || car === ACELA_POWER ? ' loco' : ''}${i === 0 ? ' lead' : ''}" style="flex:${car.length}"></span>`)
    .join('');
  let stops = '<p class="muted">Loading arrival times…</p>';
  if (upcoming && !upcoming.length) stops = '<p class="muted">No arrival times for this one right now.</p>';
  else if (upcoming)
    stops = `<ol class="timeline">${upcoming
      .slice(0, 8)
      .map((s) => `<li><span>${escape(s.name)}</span><time data-at="${s.at}">${countdown(s.at)}</time></li>`)
      .join('')}</ol>`;
  const statusLabel = { STOPPED_AT: 'Stopped at', INCOMING_AT: 'Arriving at', IN_TRANSIT_TO: 'Next stop' }[v.status] ?? 'Next stop';
  const [idLabel, idValue] = amtrak
    ? ['Train', v.label]
    : boat
      ? ['Vessel', titleCase(v.label)]
      : t.route.type === 2 && v.tripName
        ? ['Train', v.tripName]
        : [bus ? 'Bus' : 'Car', v.label];
  const [sizeLabel, sizeValue] = boat ? ['Type', 'Ferry'] : bus ? ['Type', 'Artic'] : ['Cars', `${t.cars.length}${t.estimated ? '*' : ''}`];
  const notes = [bunchBanner(t), ...trainAlerts(t).slice(0, 2).map(banner)].join('');
  const fine = [
    `Position reported <span data-ago="${v.updatedAt}">${ago(v.updatedAt)}</span>${amtrak ? ' by Amtrak' : ''}`,
    t.estimated
      ? `*${amtrak ? 'Amtrak doesn’t publish its consists; a usual set is shown' : t.route.type === 2 ? 'Commuter rail doesn’t report its cars; a typical set is shown' : 'Consist not reported; typical shown'}`
      : '',
  ].filter(Boolean);

  detailEl.style.setProperty('--c', c);
  detailEl.style.setProperty('--on-c', onAccent);
  detailEl.innerHTML = `
    ${detailNav(id)}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>${escape(t.route.name)}${branch}${late ? `<span class="late${late.late ? ' is-late' : ''}">${late.text}</span>` : ''}</p>
      <h2><small>To</small>${escape(destination(t))}</h2>
    </div>
    ${notes}
    <div class="status">
      <div><small>${statusLabel}</small><strong>${escape(v.stopName ?? '—')}</strong></div>
      ${next ? `<time class="eta" data-at="${next.at}">${countdown(next.at)}</time>` : ''}
    </div>
    <dl class="metrics">
      <div><dt>Speed</dt><dd>${v.status === 'STOPPED_AT' ? '0<small>mph</small>' : speed != null ? `${speed}<small>mph</small>` : '—'}</dd></div>
      <div><dt>${sizeLabel}</dt><dd>${sizeValue}</dd></div>
      <div><dt>${idLabel}</dt><dd>${escape(idValue)}</dd></div>
    </dl>
    ${boat ? '' : `<div class="consist" aria-hidden="true">${consistHtml}</div>`}
    <div class="actions">
      <button class="btn primary" data-action="ride">${ICON.play}Ride along</button>
      ${flat() ? '' : `<button class="btn" data-action="cab">${ICON.cab}${boat ? 'From the bridge' : 'Cab view'}</button>`}
      <button class="btn wide" data-action="follow" aria-pressed="${cameraMode === 'follow'}">${cameraMode === 'follow' ? 'Keeping it in view' : 'Keep in view'}</button>
    </div>
    <h3>${amtrak ? 'Next stations' : 'Upcoming'}</h3>
    ${stops}
    <p class="fine">${fine.join(' · ')}</p>`;
}

function renderStation(id: string) {
  const s = stations.find((st) => st.id === id);
  if (!s || !network) return;
  const c = s.ferry ? displayColor('#008EAA') : s.rail ? displayColor('#80276C') : s.bus ? displayColor('#7C878E') : '#ffffff';
  detailEl.style.setProperty('--c', c);

  let body = '<p class="muted">Loading departures…</p>';
  if (departures) {
    const groups = new Map<string, { route: Route; headsign: string; deps: Departure[] }>();
    for (const d of departures) {
      const route = network.routes.get(d.routeId);
      if (!route || hidden.has(groupOf(route))) continue;
      const key = `${d.routeId}|${d.headsign}`;
      const g = groups.get(key) ?? { route, headsign: d.headsign, deps: [] };
      g.deps.push(d);
      groups.set(key, g);
    }
    body = groups.size
      ? `<ul class="cards">${[...groups.values()]
          .slice(0, 10)
          .map((g, i) => {
            const first = g.deps[0];
            const live = first.vehicleId && trains.has(first.vehicleId);
            const line = g.route.type === 3 ? g.route.short : g.route.name.replace(' Line', '');
            return `<li style="--c:${displayColor(g.route.color)};--i:${i}">
              <button class="card" ${live ? `data-train="${escape(first.vehicleId!)}"` : 'disabled'}>
                <span class="card-bar"></span>
                <span class="card-text"><small>${escape(line)}</small><strong>${escape(g.headsign)}</strong>${
                  g.deps.length > 1
                    ? `<span>Then ${g.deps
                        .slice(1, 3)
                        .map((d) => `<time data-at="${d.at}">${countdown(d.at)}</time>`)
                        .join(', ')}</span>`
                    : ''
                }</span>
                <span class="card-side"><time data-at="${first.at}">${countdown(first.at)}</time></span>
              </button>
            </li>`;
          })
          .join('')}</ul>`
      : '<p class="muted">Nothing predicted here right now.</p>';
  }

  const notes = stationAlerts(s)
    .sort((a, b) => Number(alertKind(b) === 'service') - Number(alertKind(a) === 'service'))
    .slice(0, 3)
    .map(banner)
    .join('');

  detailEl.innerHTML = `
    ${detailNav()}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>${s.ferry ? 'Ferry pier' : s.rail ? 'Commuter rail station' : s.bus ? 'Silver Line stop' : 'Station'}</p>
      <h2>${escape(s.name)}</h2>
    </div>
    <div class="actions"><button class="btn primary" data-action="directions">${ICON.directions}Directions here</button></div>
    ${notes}
    <h3>Departures</h3>
    ${body}
    <p class="fine">Live MBTA predictions. Tap one to jump to its train.</p>`;
}

function renderDock(id: string) {
  const d = docks.find((x) => x.id === id);
  if (!d) return;
  detailEl.style.setProperty('--c', '#38bdf8');
  detailEl.innerHTML = `
    ${detailNav()}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>Bluebikes</p>
      <h2>${escape(d.name)}</h2>
    </div>
    <dl class="metrics big">
      <div><dt>Bikes</dt><dd>${d.bikes}</dd></div>
      <div><dt>E-bikes</dt><dd>${d.ebikes}</dd></div>
      <div><dt>Open docks</dt><dd>${d.docks}</dd></div>
    </dl>
    ${d.renting ? '' : '<p class="muted">Not renting right now.</p>'}
    <p class="fine">${d.capacity} docks · reported <span data-ago="${d.reportedAt}">${ago(d.reportedAt)}</span></p>`;
}

/** Whether the ride-along panel shows the train's next stops. */
const HUD_KEY = 'live-boston:hud-open';
let hudOpen = load(HUD_KEY, false);

/** The panel while riding along: line, destination, next stop, speed, and on request the stops ahead. */
function renderHud() {
  const t = selection?.kind === 'train' && riding() ? trains.get(selection.id) : undefined;
  hudEl.hidden = !t;
  if (!t) return;
  const next = upcoming?.[0];
  const speed = mph(t);
  const cab = cameraMode === 'cab';
  const stopped = t.v.status === 'STOPPED_AT';
  const speedText = stopped ? '0' : speed != null ? `${speed}` : '—';
  const where = escape(t.v.stopName ?? '—');
  const stops = !hudOpen
    ? ''
    : upcoming?.length
      ? `<ol class="hud-stops">${upcoming
          .slice(0, 6)
          .map((s) => `<li><span>${escape(s.name)}</span><time data-at="${s.at}">${countdown(s.at)}</time></li>`)
          .join('')}</ol>`
      : `<p class="hud-stops empty">${upcoming ? 'No arrival times for this one right now.' : 'Loading the stops ahead…'}</p>`;
  hudEl.style.setProperty('--c', hex(t));
  hudEl.classList.toggle('open', hudOpen);
  hudEl.innerHTML = `
    ${stops}
    <div class="hud-main">
      <button class="hud-id" data-action="hud-toggle" aria-expanded="${hudOpen}" title="${hudOpen ? 'Hide' : 'Show'} the stops ahead">
        <span class="dot"></span>
        <span class="hud-name">
          <small>${escape(t.route.name)}</small>
          <strong>To ${escape(destination(t))}</strong>
          <span class="hud-sum">${stopped ? 'At' : 'Next'} ${where}${next ? ` · <span data-at="${next.at}">${countdown(next.at)}</span>` : ''} · ${speedText} mph</span>
        </span>
        <span class="hud-chev">${ICON.chevron}</span>
      </button>
      <div class="hud-cells">
        <div class="hud-cell"><small>${stopped ? 'Stopped at' : 'Next stop'}</small><strong>${where}</strong></div>
        ${next ? `<div class="hud-cell"><small>Arrives</small><strong data-at="${next.at}">${countdown(next.at)}</strong></div>` : ''}
        <div class="hud-cell"><small>Speed</small><strong>${speedText} <em>mph</em></strong></div>
      </div>
      <div class="hud-tools">
        ${cab ? `<button class="hud-btn look" data-action="look-ahead" title="Look down the line again">${ICON.chase}<span>Look ahead</span></button>` : ''}
        ${touring ? `<button class="hud-btn" data-action="skip">Next <span data-tour-left></span></button>` : ''}
        ${
          flat()
            ? ''
            : `<button class="hud-btn" data-action="${cab ? 'ride' : 'cab'}" title="${cab ? 'Watch from behind' : 'Look out from the front'}" aria-label="${
                cab ? 'Chase view' : 'Cab view'
              }">${cab ? ICON.chase : ICON.cab}<span>${cab ? 'Chase' : 'Cab'}</span></button>`
        }
        <button class="hud-btn exit" data-action="exit-ride" aria-label="Stop riding">${ICON.close}<span>Exit</span></button>
      </div>
    </div>`;
  showLooking();
}

function toggleFollow(id: string) {
  if (isFollowed(id)) followed = followed.filter((f) => f.id !== id);
  else {
    const t = trains.get(id);
    if (!t) return;
    followed = [...followed, { id, routeId: t.v.routeId, label: vehicleLabel(t) }];
  }
  save(FOLLOWING_KEY, followed);
  renderFollowingBadge();
  if (tab === 'following') renderMain();
  renderDetail();
}

/** Fits the map to some routes, or to their vehicles when they have no lines of their own (Amtrak). */
function focusRoutes(routes: Route[], groupId: string) {
  if (!network) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const r of routes) for (const s of network.routeShapes.get(r.id) ?? []) for (const p of network.shapes.get(s) ?? []) bounds.extend(p);
  if (bounds.isEmpty()) for (const t of trains.values()) if (routes.includes(t.route)) bounds.extend(toLngLat(t.x, t.y));
  if (bounds.isEmpty()) return;
  if (hidden.delete(groupId)) {
    drawLines();
    drawAlerts();
    if (tab === 'lines') renderLines();
  }
  if (isPhone()) sheet.set('peek');
  map.fitBounds(bounds, { padding: 48, maxZoom: 14, pitch: flat() ? 0 : 40, bearing: flat() ? 0 : map.getBearing(), duration: 1600 });
}

function focusGroup(id: string) {
  const g = GROUPS.find((x) => x.id === id);
  if (g) focusRoutes(groupRoutes(g), g.id);
}

sheetEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(
    '[data-tab],[data-toggle],[data-show-alerts],[data-focus],[data-layer],[data-view],[data-action],[data-train],[data-unfollow],[data-alert-map],[data-open-alert],[data-trip],[data-trip-pick],[data-trip-choose],[data-trip-when],[data-result]',
  );
  // The sheet carries its own data-tab; a click on nothing in particular isn't a tab.
  if (!el || el === sheetEl) return;
  const d = el.dataset;
  if (d.tab) setTab(d.tab as Tab);
  else if (d.toggle) {
    if (hidden.has(d.toggle)) hidden.delete(d.toggle);
    else hidden.add(d.toggle);
    drawLines();
    drawAlerts();
    findBunching();
    renderLines();
    renderStatus();
  } else if (d.showAlerts !== undefined) {
    e.stopPropagation();
    setTab('alerts');
  } else if (d.focus) focusGroup(d.focus);
  else if (d.layer) {
    const key = d.layer as keyof typeof layers;
    layers[key] = !layers[key];
    save(LAYERS_KEY, layers);
    applyLayerToggles();
    renderMain();
  } else if (d.view) setViewMode(d.view as ViewMode);
  else if (d.unfollow) toggleFollow(d.unfollow);
  else if (d.train) {
    select({ kind: 'train', id: d.train });
    setCameraMode('follow');
  } else if (d.alertMap) showAlert(d.alertMap);
  else if (d.openAlert) {
    openAlerts.add(d.openAlert);
    renderMain();
    mainEl.querySelector(`[data-alert="${CSS.escape(d.openAlert)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (d.tripWhen) setWhen(d.tripWhen as When['mode']);
  else if (d.trip) tripAction(d.trip, el);
  else if (d.tripPick) {
    const p = placeResults[Number(d.tripPick)];
    if (p) pickPlace(p.kind === 'here' ? null : { name: p.name, detail: p.detail, lng: p.lng, lat: p.lat, stationId: p.stationId });
  } else if (d.tripChoose) {
    trip.chosen = d.tripChoose;
    trip.picked = true;
    stopPreview();
    renderDetail();
    detailEl.scrollTop = 0;
    drawTrip();
    fitTrip();
  } else if (d.result) chooseResult(Number(d.result));
  else if (d.action === 'back') {
    // From a train or station looked at along the way, back to the directions.
    if (tripActive && selection?.kind !== 'trip') resumeTrip();
    else select(null);
  } else if (d.action === 'directions' && selection?.kind === 'station') {
    const st = stations.find((x) => x.id === selection!.id);
    if (st) openTrip(stationPlace(st));
  }
  else if (d.action === 'star' && selection?.kind === 'train') toggleFollow(selection.id);
  else if (d.action === 'ride') setCameraMode('ride');
  else if (d.action === 'cab') setCameraMode('cab');
  else if (d.action === 'follow') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
  else if (d.action === 'tour') setTouring(true);
  else if (d.action === 'install') install();
});

hudEl.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'skip') nextTourStop();
  if (action === 'hud-toggle') {
    hudOpen = !hudOpen;
    save(HUD_KEY, hudOpen);
    renderHud();
  }
  if (action === 'look-ahead') lookingAhead = true;
  if (action === 'cab') setCameraMode('cab');
  if (action === 'ride') setCameraMode('ride');
  if (action === 'exit-ride') exitRide();
});

function exitRide() {
  const wasCab = cameraMode === 'cab';
  setTouring(false);
  setCameraMode('free');
  if (!wasCab) map.easeTo({ pitch: flat() ? 0 : 55, zoom: Math.min(map.getZoom(), 16), duration: 1200 });
}

function setViewMode(next: ViewMode) {
  if (next === viewMode) return;
  viewMode = next;
  save(VIEW_KEY, viewMode);
  applyViewMode(true);
  if (tab === 'map') renderMain();
  renderDetail();
  renderHud();
}

function applyViewMode(animate: boolean) {
  if (map.getLayer('buildings-3d')) map.setLayoutProperty('buildings-3d', 'visibility', flat() ? 'none' : 'visible');
  if (flat()) {
    if (cameraMode === 'cab') setCameraMode('ride');
    // Lock the tilt only once the camera has flattened, or it snaps.
    map.easeTo({ pitch: 0, bearing: riding() ? map.getBearing() : 0, duration: animate ? 900 : 0 });
    map.once('moveend', () => flat() && map.setMaxPitch(0));
  } else {
    map.setMaxPitch(78);
    map.easeTo({ pitch: riding() ? 72 : 52, duration: animate ? 900 : 0 });
  }
}

// Search -------------------------------------------------------------------------
//
// One box for everything: stations, lines, any vehicle by number, name or
// destination, and Bluebikes docks. "/" jumps to it; arrows and Enter pick.

let results: SearchItem[] = [];
let activeResult = 0;

function searchItems(): SearchItem[] {
  const items: SearchItem[] = [];
  for (const g of GROUPS) {
    const routes = groupRoutes(g);
    items.push({
      kind: 'line',
      id: `group:${g.id}`,
      title: g.label,
      subtitle: groupSubtitle(g) || 'Line',
      color: groupColor(g),
      terms: [...routes.map((r) => `${r.name} ${r.short}`), { CR: 'commuter rail train', SL: 'silver bus brt', Ferry: 'boat harbor ferry', Amtrak: 'acela regional downeaster' }[g.id] ?? ''].join(' '),
      boost: 8,
    });
  }
  // Commuter rail lines, Silver Line routes and ferry routes by name too.
  for (const r of network?.routes.values() ?? []) {
    if (r.type < 2 || r.type === AMTRAK_TYPE) continue;
    items.push({
      kind: 'line',
      id: `route:${r.id}`,
      title: r.name,
      subtitle: r.type === 2 ? 'Commuter Rail' : r.type === 3 ? 'Silver Line' : 'Ferry',
      color: displayColor(r.color),
      terms: `${r.short} ${r.destinations.join(' ')}`,
      boost: 6,
    });
  }
  // Silver Line stops come in pairs, one per direction, with the same name; list each name once.
  const listed = new Set<string>();
  for (const s of stations) {
    const key = `${s.name}|${s.rail}|${s.bus}|${s.ferry}`;
    if (listed.has(key)) continue;
    listed.add(key);
    items.push({
      kind: 'station',
      id: s.id,
      title: s.name,
      subtitle: s.ferry ? 'Ferry pier' : s.rail ? 'Commuter rail station' : s.bus ? 'Silver Line stop' : 'Station',
      color: s.ferry ? displayColor('#008EAA') : s.rail ? displayColor('#80276C') : s.bus ? displayColor('#7C878E') : '#ffffff',
      terms: s.ferry ? 'pier wharf ferry' : '',
      boost: s.rail || s.bus || s.ferry ? 5 : 6,
    });
  }
  for (const t of trains.values()) {
    items.push({
      kind: 'vehicle',
      id: t.v.id,
      title: vehicleLabel(t),
      subtitle: `${t.route.name} · to ${destination(t)}`,
      color: hex(t),
      terms: `${t.v.label} ${t.v.tripName ?? ''} ${destination(t)} ${t.route.short} ${t.route.name}`,
      boost: 0,
    });
  }
  for (const d of docks) {
    items.push({ kind: 'dock', id: d.id, title: d.name, subtitle: `Bluebikes · ${d.bikes + d.ebikes} bikes`, color: '#38bdf8', terms: 'bluebikes bike dock', boost: -1 });
  }
  return items;
}

const KIND_LABEL = { line: 'Line', station: 'Station', vehicle: 'Live', dock: 'Bikes' };

function renderSearch() {
  const q = searchEl.value.trim();
  sheetEl.classList.toggle('searching', !!q);
  if (!q) {
    searchView.innerHTML = '';
    return;
  }
  results = search(searchItems(), q);
  activeResult = Math.min(activeResult, Math.max(0, results.length - 1));
  searchView.innerHTML = results.length
    ? `<ul class="results" role="listbox" aria-label="Results">${results
        .map(
          (r, i) => `<li><button class="result${i === activeResult ? ' active' : ''}" role="option" aria-selected="${i === activeResult}" data-result="${i}" style="--c:${r.color}">
            <span class="result-icon ${r.kind}">${r.kind === 'vehicle' ? ICON.train : r.kind === 'dock' ? ICON.bike : r.kind === 'station' ? ICON.station : ''}</span>
            <span class="result-text"><strong>${escape(r.title)}</strong><small>${escape(r.subtitle)}</small></span>
            <span class="result-kind">${r.kind === 'vehicle' && isAmtrak(r.id) ? 'Amtrak' : KIND_LABEL[r.kind]}</span>
          </button></li>`,
        )
        .join('')}</ul>`
    : `<div class="empty small"><strong>Nothing called “${escape(q)}”</strong><p>Try a station, a line, a train number like 508, or a ferry’s name.</p></div>`;
}

function closeSearch() {
  if (!searchEl.value && !sheetEl.classList.contains('searching')) return;
  searchEl.value = '';
  activeResult = 0;
  renderSearch();
}

function chooseResult(i: number) {
  const r = results[i];
  if (!r) return;
  closeSearch();
  searchEl.blur();
  if (r.kind === 'line') {
    const [kind, id] = r.id.split(/:(.*)/);
    if (kind === 'group') focusGroup(id);
    else {
      const route = network?.routes.get(id);
      if (route) focusRoutes([route], groupOf(route));
    }
  } else if (r.kind === 'station') select({ kind: 'station', id: r.id });
  else if (r.kind === 'vehicle' && trains.has(r.id)) {
    select({ kind: 'train', id: r.id });
    setCameraMode('follow');
  } else if (r.kind === 'dock') {
    if (!layers.bikes) {
      layers.bikes = true;
      save(LAYERS_KEY, layers);
      applyLayerToggles();
    }
    select({ kind: 'dock', id: r.id });
  }
}

searchEl.addEventListener('input', () => {
  activeResult = 0;
  if (selection && searchEl.value) select(null);
  renderSearch();
});
searchEl.addEventListener('focus', () => {
  // Make room above the keyboard for results.
  if (isPhone()) sheet.set('full');
  // Docks are searchable too; load them the first time someone looks.
  if (!docks.length) loadDocks().then((d) => (docks = d), console.warn);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderSearch();
    searchView.querySelector('.result.active')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    chooseResult(activeResult);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    closeSearch();
    searchEl.blur();
  }
});
$('.search').addEventListener('click', () => searchEl.focus());

// Getting there ------------------------------------------------------------------
//
// "Where to?": directions from where you are (by GPS) or any place, to a
// station or an address, by T and on foot. The trip is drawn on the map, the
// real way on foot and the real track, with live times for each train, and
// a preview flies the whole route. Save one as your commute and the top of
// the sidebar counts down to when to leave, and flips to the way back when
// you're at the other end.

let graph: TransitGraph | null = null;
let graphLoading: Promise<TransitGraph | null> | null = null;

/** The network as a graph of rides and walks, loaded the first time it's needed. */
function loadGraph(): Promise<TransitGraph | null> {
  if (graph) return Promise.resolve(graph);
  if (!network) return Promise.resolve(null);
  const net = network;
  graphLoading ??= loadPatterns(mbtaRouteIds)
    .then((patterns) => (graph = new TransitGraph(net, stations, patterns, stationByStop, trackOf)))
    .catch((err) => {
      graphLoading = null;
      handleError(err, 'Couldn’t load the network for directions');
      return null;
    });
  return graphLoading;
}

const HERE = 'Your location';

interface TripState {
  /** null: wherever you are, by GPS. */
  from: Place | null;
  to: Place | null;
  editing: 'from' | 'to' | null;
  /** Where the plan actually starts, once found. */
  origin: Place | null;
  plans: Itinerary[] | null;
  timed: Timed[] | null;
  /** The chosen way, by its key, so it stays chosen as times refresh. */
  chosen: string | null;
  status: string | null;
  busy: boolean;
  /** They chose a way themselves; times refreshing shouldn't switch it. */
  picked: boolean;
  /** Going now, or planning ahead: leaving at, or arriving by, a time. */
  when: When;
}

interface When {
  mode: 'now' | 'leave' | 'arrive';
  at: number;
}
const NOW: When = { mode: 'now', at: 0 };
let trip: TripState = blankTrip();
/** Directions are open, or set aside while looking at a train or station on the way. */
let tripActive = false;
let planSeq = 0;

function blankTrip(): TripState {
  return { from: null, to: null, editing: null, origin: null, plans: null, timed: null, chosen: null, status: null, busy: false, picked: false, when: NOW };
}

const planKey = (it: Itinerary) => it.legs.map((l) => (l.kind === 'ride' ? `${l.board.id}>${l.alight.id}` : 'w')).join('|');
const samePlace = (a: Place | null, b: Place | null) => !!a && !!b && Math.abs(a.lng - b.lng) < 1e-4 && Math.abs(a.lat - b.lat) < 1e-4;
function meters(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const [ax, ay] = toLocal(a.lng, a.lat);
  const [bx, by] = toLocal(b.lng, b.lat);
  return Math.hypot(bx - ax, by - ay);
}

function stationPlace(s: Station): Place {
  return { name: s.name, lng: s.lng, lat: s.lat, stationId: s.id };
}

function nearestStation(p: { lng: number; lat: number }) {
  let best: { s: Station; d: number } | null = null;
  for (const s of stations) {
    const d = meters(p, s);
    if (!best || d < best.d) best = { s, d };
  }
  return best;
}

/** Opens directions, to a place if one is given (otherwise it asks where to). */
function openTrip(to: Place | null = null, from: Place | null = null) {
  stopPreview();
  // Planning ahead carries over to the next search.
  trip = { ...blankTrip(), to, from, editing: to ? null : 'to', when: trip.when };
  tripActive = true;
  closeSearch();
  if (selection?.kind === 'trip') renderDetail();
  else select({ kind: 'trip', id: 'go' });
  if (isPhone()) sheet.set(to ? 'half' : 'full');
  if (to) planTrip();
  else focusTripInput();
}

/** Back to the trip that was open before looking at a train or station on it. */
function resumeTrip() {
  if (selection?.kind === 'trip') return;
  select({ kind: 'trip', id: 'go' });
  drawTrip();
}

function closeTrip() {
  tripActive = false;
  stopPreview();
  trip = blankTrip();
  drawTrip();
}

async function planTrip(keepView = false) {
  const seq = ++planSeq;
  const t = trip;
  if (!t.to) return;
  t.busy = true;
  t.status = t.from ? 'Finding the way…' : 'Finding you…';
  renderTripPanel();
  let origin = t.from;
  if (!origin) {
    const fix = await whereAmI();
    if (seq !== planSeq) return;
    if (!fix) {
      t.busy = false;
      t.status = locationDenied
        ? 'Location is off for this site. Choose where you’re starting from.'
        : 'Couldn’t find you yet. Choose where you’re starting from.';
      t.editing = 'from';
      renderTripPanel();
      focusTripInput();
      return;
    }
    origin = { name: HERE, lng: fix.lng, lat: fix.lat };
  }
  t.origin = origin;
  t.status = 'Finding the way…';
  renderTripPanel();
  const g = await loadGraph();
  if (seq !== planSeq) return;
  if (!g) {
    t.busy = false;
    t.status = 'Couldn’t load the T’s network. Try again in a moment.';
    renderTripPanel();
    return;
  }
  const plans = g.plan(origin, t.to);
  t.plans = plans;
  t.timed = null;
  altsTimedAt = 0;
  if (!plans.length) {
    t.busy = false;
    t.status = 'No way there by T from here. Is it within about 1½ miles of a station?';
    renderTripPanel();
    drawTrip();
    return;
  }
  if (!t.chosen || !plans.some((p) => planKey(p) === t.chosen)) t.chosen = planKey(plans[0]);
  t.status = null;
  drawTrip();
  if (!keepView) fitTrip();
  renderTripPanel();
  // The real way on foot, then the trains.
  await Promise.all(plans.map(routeWalks));
  if (seq !== planSeq) return;
  drawTrip();
  await timeTrip(seq);
}

/** Times one way, leg by leg; a leg the MBTA won't answer for gets a usual wait. */
async function timePlan(p: Itinerary, maxAge: number, when: When = NOW) {
  // Planning ahead: the timetable around then, which doesn't change by the minute.
  const span = p.typical * 1000;
  const window =
    when.mode === 'leave'
      ? { start: when.at, end: when.at + span + 3 * 3_600_000 }
      : when.mode === 'arrive'
        ? { start: when.at - span - 2.5 * 3_600_000, end: when.at }
        : undefined;
  const runs = await Promise.all(
    p.legs.map((l) =>
      l.kind === 'ride'
        ? runsFor(l, window ? 600_000 : maxAge, window).catch((err) => {
            if (err instanceof RateLimited) handleError(err, '');
            else console.warn(err);
            return null;
          })
        : null,
    ),
  );
  if (when.mode === 'arrive') return scheduleBy(p, runs, when.at);
  return schedule(p, runs, when.mode === 'leave' ? when.at : Date.now());
}

/** Best first: soonest there (or, arriving by a time, leaving latest); ways not running last. */
function byBest(when: When) {
  return (a: Timed, b: Timed) =>
    Number(!!a.unavailable) - Number(!!b.unavailable) || (when.mode === 'arrive' ? b.leave - a.leave || a.arrive - b.arrive : a.arrive - b.arrive);
}

let altsTimedAt = 0;

/**
 * Live times for the chosen way, then the others, soonest arrival first.
 * Without an API key the MBTA allows 20 requests a minute, shared with
 * everything else on the map, so the other ways are timed less often.
 */
async function timeTrip(seq = planSeq) {
  const t = trip;
  if (!t.plans?.length) return;
  t.busy = true;
  const chosen = chosenPlan(t) ?? t.plans[0];
  const when = t.when;
  const first = await timePlan(chosen, 25_000, when);
  if (seq !== planSeq) return;
  const others = t.plans.filter((p) => p !== chosen);
  const fresh = Date.now() - altsTimedAt > 90_000 || !t.timed || t.timed.length < t.plans.length;
  let rest: Timed[];
  if (fresh && Date.now() > pausedUntil) {
    rest = [];
    // One at a time, so a burst doesn't hit the limit.
    for (const p of others) {
      rest.push(await timePlan(p, 90_000, when));
      if (seq !== planSeq) return;
    }
    altsTimedAt = Date.now();
  } else rest = (t.timed ?? []).filter((x) => others.includes(x.itin));
  if (when !== t.when) return;
  // A way with nothing running drops out, unless nothing else does.
  const all = [first, ...rest].sort(byBest(when));
  t.timed = all.some((x) => !x.unavailable) ? all.filter((x) => !x.unavailable || planKey(x.itin) === t.chosen) : all;
  t.busy = false;
  // The first time, pick the best; after that, keep their choice.
  if (!t.picked || !t.timed.some((x) => planKey(x.itin) === t.chosen)) t.chosen = planKey(t.timed[0].itin);
  if (t === trip && selection?.kind === 'trip') {
    renderTripPanel();
    drawTrip();
  }
  if (when.mode === 'now' && commute && samePlace(t.to, commuteTarget()?.to ?? null) && !t.from) shareWithCommute(t);
}

function chosenTimed(t = trip) {
  return t.timed?.find((x) => planKey(x.itin) === t.chosen) ?? null;
}
function chosenPlan(t = trip) {
  return t.plans?.find((p) => planKey(p) === t.chosen) ?? null;
}

async function refreshTrip() {
  const t = trip;
  if (!t.to || !t.plans) return;
  // On the move: plan again from where you are now.
  if (!t.from && t.when.mode === 'now' && me && t.origin && meters(me, t.origin) > 150) {
    planTrip(true);
    return;
  }
  await timeTrip();
}

// Where you are, for directions ---------------------------------------------------

let locationDenied = false;
let quietLocate = false;
const fixWaiters: ((f: Fix | null) => void)[] = [];

/** A recent GPS fix, starting location quietly (no fly-to) if it's off. */
function whereAmI(timeout = 15_000): Promise<Fix | null> {
  if (me && Date.now() - me.at < 60_000) return Promise.resolve(me);
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  if (watchId == null) startLocate(true);
  return new Promise((resolve) => {
    fixWaiters.push(resolve);
    setTimeout(() => {
      const i = fixWaiters.indexOf(resolve);
      if (i >= 0) fixWaiters.splice(i, 1);
      resolve(me);
    }, timeout);
  });
}

function settleWaiters(fix: Fix | null) {
  for (const w of fixWaiters.splice(0)) w(fix);
}

/** Whether the site may already use location, so asking won't pop up a prompt. */
async function locationGranted() {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch {
    return false;
  }
}

// Choosing places ---------------------------------------------------------------

let placeResults: (Place & { kind: 'here' | 'station' | 'place' | 'saved' })[] = [];
let placeQuery = '';
let placeAbort: AbortController | null = null;
let placeTimer: number | undefined;

function focusTripInput() {
  requestAnimationFrame(() => detailEl.querySelector<HTMLInputElement>('#trip-input')?.focus());
}

function stationColor(s: Station) {
  return s.ferry ? displayColor('#008EAA') : s.rail ? displayColor('#80276C') : s.bus ? displayColor('#7C878E') : '#ffffff';
}

function suggestPlaces(q: string) {
  placeQuery = q;
  const list: typeof placeResults = [];
  if (trip.editing === 'from') list.push({ kind: 'here', name: HERE, lng: 0, lat: 0 });
  if (!q.trim()) {
    // Your commute's two ends, for a quick start.
    if (commute) {
      for (const p of [commute.to, commute.home]) if (!list.some((x) => samePlace(x, p))) list.push({ ...p, kind: 'saved' });
    }
    placeResults = list;
    renderPlaceResults();
    return;
  }
  const found = search(
    searchItems().filter((i) => i.kind === 'station'),
    q,
    4,
  );
  for (const r of found) {
    const s = stations.find((x) => x.id === r.id);
    if (s) list.push({ ...stationPlace(s), detail: r.subtitle, kind: 'station' });
  }
  placeResults = list;
  renderPlaceResults();
  // Addresses and places, once typing pauses.
  clearTimeout(placeTimer);
  placeAbort?.abort();
  if (q.trim().length < 3 || !typeaheadUp()) {
    renderPlaceResults();
    return;
  }
  placeTimer = window.setTimeout(() => lookUpAddresses(q, list), 280);
}

let lookingUp = false;
async function lookUpAddresses(q: string, list = placeResults.filter((p) => p.kind !== 'place'), submitted = false) {
  placeAbort?.abort();
  const ctrl = (placeAbort = new AbortController());
  lookingUp = true;
  renderPlaceResults(true);
  try {
    const places = await searchPlaces(q, ctrl.signal, submitted);
    if (placeQuery !== q) return;
    // A station already listed beats the same name as a place.
    const names = new Set(list.map((p) => p.name.toLowerCase()));
    placeResults = [...list, ...places.filter((p) => !names.has(p.name.toLowerCase())).map((p) => ({ ...p, kind: 'place' as const }))];
  } catch (err) {
    if (ctrl.signal.aborted) return;
    console.warn(err);
  } finally {
    if (placeAbort === ctrl) lookingUp = false;
  }
  if (placeQuery === q) renderPlaceResults();
}

function renderPlaceResults(searching = false) {
  const el = detailEl.querySelector('#trip-results');
  if (!el) return;
  const items = placeResults
    .map((p, i) => {
      const icon = p.kind === 'here' ? ICON.locate : p.kind === 'station' ? ICON.station : p.kind === 'saved' ? ICON.pinOn : ICON.pin;
      const color = p.kind === 'here' ? '#3b82f6' : p.kind === 'station' && p.stationId ? stationColor(stations.find((s) => s.id === p.stationId)!) : '#a3aab6';
      const sub = p.kind === 'here' ? 'By GPS' : p.kind === 'saved' ? (samePlace(p, commute?.home ?? null) ? 'Your commute’s start' : 'Your commute') : (p.detail ?? '');
      return `<li><button class="result${i === 0 && placeQuery ? ' active' : ''}" data-trip-pick="${i}" style="--c:${color}">
        <span class="result-icon">${icon}</span>
        <span class="result-text"><strong>${escape(p.name)}</strong>${sub ? `<small>${escape(sub)}</small>` : ''}</span>
      </button></li>`;
    })
    .join('');
  const q = placeQuery.trim();
  const hint = !q
    ? '<p class="fine tight">Type a station, an address or a place. Or tap the map.</p>'
    : searching || lookingUp
      ? '<p class="fine tight trip-status"><span class="spinner"></span>Looking up addresses…</p>'
      : q.length >= 3 && !placeResults.some((p) => p.kind === 'place')
        ? `<p class="fine tight">${placeResults.length ? 'Not it?' : `Nothing found for “${escape(q)}”.`} Press Enter to search addresses, or tap the map.</p>`
        : '';
  el.innerHTML = `${items ? `<ul class="results">${items}</ul>` : ''}${hint}`;
}

function pickPlace(p: Place | null) {
  const which = trip.editing;
  if (!which) return;
  if (which === 'from') trip.from = p;
  else trip.to = p;
  trip.editing = null;
  placeQuery = '';
  if (isPhone()) sheet.set('half');
  if (trip.to) planTrip();
  else {
    trip.editing = 'to';
    renderTripPanel();
    focusTripInput();
  }
}

/** A tapped spot on the map, while choosing a place. */
function pickOnMap(lng: number, lat: number) {
  const near = nearestStation({ lng, lat });
  const s = near && near.d < 60 ? near.s : null;
  pickPlace(s ? stationPlace(s) : { name: 'Dropped pin', detail: near ? `Near ${near.s.name}` : undefined, lng, lat });
}

// The trip panel -------------------------------------------------------------------

function fmtMins(seconds: number) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
}

function fmtDistance(m: number) {
  const ft = m * 3.281;
  return ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(m / 1609.34).toFixed(1)} mi`;
}

function legRoute(leg: RideLeg, run?: Run) {
  return network?.routes.get(run?.routeId ?? leg.pattern.routeId) ?? network?.routes.get(leg.routes[0]);
}

/** A short name for a line, for chips: "Red", "Green B", "SL1", "Ferry". */
function lineShort(r: Route | undefined) {
  if (!r) return 'T';
  if (r.type === 3) return r.short;
  if (r.type === 2) return 'Rail';
  if (r.type === 4) return 'Ferry';
  return r.name.replace(' Line', '');
}

/** The line as riders name it: "Red Line", "Green Line B", "Providence/Stoughton Line". */
function lineName(r: Route | undefined) {
  if (!r) return 'Train';
  return r.type === 2 ? `${r.name.replace(/ Line$/, '')} Line` : r.name;
}

/** "12:08", for times beside one that already says AM or PM. */
const shortClock = (at: number) => clockFmt.format(at).replace(/\s?[AP]M$/, '');

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
/** "Today", "Tomorrow" or "Thu, Oct 16". */
function dayLabel(at: number) {
  const d = dayKey.format(at);
  if (d === dayKey.format(Date.now())) return 'Today';
  if (d === dayKey.format(Date.now() + 86_400_000)) return 'Tomorrow';
  return dayFmt.format(at);
}

/** Two or three characters for a line, for its badge: RL, OL, GL·C, SL1, CR. */
function lineBadge(r: Route | undefined) {
  if (!r) return 'T';
  if (r.id.startsWith('Green-')) return `GL·${r.id.slice(6)}`;
  if (r.type === 3) return r.short;
  if (r.type === 2) return 'CR';
  if (r.type === 4) return r.short && r.short.length <= 3 ? r.short : 'F';
  return { Red: 'RL', Orange: 'OL', Blue: 'BL', Mattapan: 'M' }[r.id] ?? r.short.slice(0, 3);
}

function leaveText(at: number) {
  const s = (at - Date.now()) / 1000;
  if (s <= 60) return 'now';
  if (s >= 3600) return clockFmt.format(at);
  return `${Math.round(s / 60)} min`;
}

function journeyBar(it: Itinerary, tm: Timed | null) {
  const durs = it.legs.map((l, i) => {
    const x = tm?.legs[i];
    return Math.max(60, x ? (x.end - x.start) / 1000 : l.seconds);
  });
  const total = durs.reduce((a, b) => a + b, 0);
  return `<div class="journey" aria-hidden="true">${it.legs
    .map((l, i) => {
      const grow = Math.max(0.1, durs[i] / total);
      if (l.kind === 'walk') return `<span class="seg-walk" style="flex:${grow}">${ICON.walk}</span>`;
      const r = legRoute(l, tm?.legs[i].run);
      // The full name when there's room, the badge when there isn't.
      const name = grow > 0.24 ? lineShort(r) : lineBadge(r);
      return `<span class="seg-ride" style="flex:${grow};--c:${r ? displayColor(r.color) : '#777'}" title="${escape(lineName(r))}">${escape(name)}</span>`;
    })
    .join('')}</div>`;
}

/** Where your train is right now, if it's on the map. */
function liveTrainNote(run?: Run) {
  const t = run?.vehicleId ? trains.get(run.vehicleId) : undefined;
  if (!t) return '';
  return `<button class="live-train" data-trip="watch" data-vehicle="${escape(t.v.id)}"><span class="pulse-dot"></span><span class="live-where">${statusLine(t)} now</span><span class="link">Watch it</span></button>`;
}

function stepsHtml(it: Itinerary, tm: Timed | null) {
  const rows: string[] = [];
  it.legs.forEach((leg, i) => {
    const x = tm?.legs[i];
    if (leg.kind === 'walk') {
      const last = i === it.legs.length - 1;
      const toName = last ? trip.to?.name ?? leg.to.name : leg.to.name;
      rows.push(`<li class="step walk">
        <span class="step-icon">${ICON.walk}</span>
        <div class="step-text"><strong>Walk to ${escape(toName)}</strong><small>${fmtMins(leg.seconds)} · ${fmtDistance(leg.meters)}${leg.routed ? '' : ' as the crow flies'}</small></div>
        ${x ? `<time>${clockFmt.format(x.start)}</time>` : ''}
      </li>`);
      return;
    }
    const run = x?.run;
    const r = legRoute(leg, run);
    const color = r ? displayColor(r.color) : '#777';
    const toward = run?.headsign || leg.pattern.headsign;
    const ride = x ? (x.end - x.start) / 1000 : leg.seconds;
    let when = '';
    if (run) {
      const later = x?.later?.length ? `<small class="then">Then ${x.later.map((l) => shortClock(l.board)).join(', ')}</small>` : '';
      when = `<small class="when">Departs <b>${clockFmt.format(run.board)}</b>${run.live ? '<em class="live">live</em>' : '<em>scheduled</em>'}</small>${later}`;
    } else if (x?.guessed) {
      when = tm?.unavailable
        ? '<small class="when warn">None running in the hours looked at</small>'
        : '<small class="when">No times posted; allowing a usual wait</small>';
    } else when = '<small class="when">Checking times…</small>';
    const other = leg.routes.length > 1 && r?.type !== 2 ? `<small>Any ${escape(lineShort(r).split(' ')[0])} train toward ${escape(toward)} works</small>` : '';
    rows.push(`<li class="step ride" style="--c:${color}">
      <span class="step-icon line">${escape(lineBadge(r))}</span>
      <div class="step-text">
        <strong>${escape(lineName(r))} <span>to ${escape(toward)}</span></strong>
        <small>Board at ${escape(leg.board.name)}</small>
        ${when}
        ${trip.when.mode === 'now' ? liveTrainNote(run) : ''}
        ${other}
        <small class="ride-len">${leg.stops} stop${leg.stops === 1 ? '' : 's'} · ${fmtMins(ride)}</small>
        <small class="off">Get off at <b>${escape(leg.alight.name)}</b></small>
      </div>
      ${x ? `<time>${clockFmt.format(x.start)}</time>` : ''}
    </li>`);
  });
  rows.push(`<li class="step end">
    <span class="step-icon">${ICON.pinOn}</span>
    <div class="step-text"><strong>${escape(trip.to?.name ?? 'Arrive')}</strong>${trip.to?.detail ? `<small>${escape(trip.to.detail)}</small>` : ''}</div>
    ${tm ? `<time>${clockFmt.format(tm.arrive)}</time>` : ''}
  </li>`);
  return `<ol class="steps">${rows.join('')}</ol>`;
}

function odRow(which: 'from' | 'to') {
  const p = which === 'from' ? trip.from : trip.to;
  if (trip.editing === which) {
    return `<div class="od-row editing">
      <span class="od-dot ${which}"></span>
      <input id="trip-input" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"
        placeholder="${which === 'from' ? 'Starting from…' : 'Where to?'}" aria-label="${which === 'from' ? 'Starting point' : 'Destination'}" value="${escape(placeQuery)}" />
      ${(which === 'from' ? true : !!trip.to) ? `<button class="link" data-trip="cancel-edit">Cancel</button>` : ''}
    </div>`;
  }
  const name = which === 'from' ? (p?.name ?? HERE) : (p?.name ?? 'Choose a destination');
  return `<button class="od-row" data-trip="edit-${which}">
    <span class="od-dot ${which}${which === 'from' && !p ? ' here' : ''}"></span>
    <span class="od-text"><small>${which === 'from' ? 'From' : 'To'}</small><strong>${escape(name)}</strong></span>
  </button>`;
}

function renderTrip(target: HTMLElement = detailEl) {
  detailEl.style.setProperty('--c', '#3b82f6');
  const t = trip;
  const plan = chosenPlan();
  const tm = chosenTimed();
  const isCommute = !!commute && !!t.to && (samePlace(t.to, commute.to) || samePlace(t.to, commute.home));

  let body = '';
  if (t.editing) {
    body = '<div id="trip-results"></div>';
  } else if (t.status && !plan) {
    body = `<p class="muted trip-status">${t.busy ? '<span class="spinner"></span>' : ''}${escape(t.status)}</p>`;
  } else if (plan) {
    const walkOnly = plan.legs.length === 1 && plan.legs[0].kind === 'walk';
    const leave = tm ? tm.leave : null;
    const ahead = t.when.mode !== 'now';
    const soon = !ahead && leave !== null && leave - Date.now() <= 60_000;
    const length = tm ? fmtMins((tm.arrive - tm.leave) / 1000) : `about ${fmtMins(plan.typical)}`;
    // Planning ahead: clock times and the day. Going now: a countdown.
    const leaveBox = ahead
      ? `<small>Leave</small><b>${leave !== null ? clockFmt.format(leave) : '…'}</b><span>${leave !== null ? dayLabel(leave) : ''}</span>`
      : `<small>${walkOnly ? 'Walk' : 'Leave'}${leave !== null && !soon ? ' in' : ''}</small><b data-leave="${leave ?? ''}">${leave !== null ? leaveText(leave) : '…'}</b>`;
    const summary = `<div class="trip-sum${soon ? ' go' : ''}">
        <div class="trip-leave">${leaveBox}</div>
        <div class="trip-arrive"><small>Arrive</small><b>${tm ? clockFmt.format(tm.arrive) : '…'}</b><span>${length}</span></div>
      </div>`;
    const others = (t.timed ?? t.plans!.map((p) => ({ itin: p }) as Timed)).filter((x) => planKey(x.itin) !== t.chosen);
    const alt = others.length
      ? `<h3>Other ways</h3><ul class="cards alts">${others
          .map((o, i) => {
            const rides = o.itin.legs.filter((l): l is RideLeg => l.kind === 'ride');
            const via = rides.length ? rides.map((l) => lineShort(legRoute(l, o.legs?.[o.itin.legs.indexOf(l)]?.run))).join(' → ') : 'Walk all the way';
            return `<li style="--i:${i}"><button class="card alt" data-trip-choose="${escape(planKey(o.itin))}">
              <span class="card-text"><strong>${escape(via)}</strong>${journeyBar(o.itin, o.leave ? o : null)}</span>
              <span class="card-side">${
                o.arrive
                  ? `<b>${clockFmt.format(o.arrive)}</b><small>${
                      o.unavailable ? 'not running' : t.when.mode !== 'now' ? `leave ${clockFmt.format(o.leave)}` : leaveText(o.leave) === 'now' ? 'leave now' : `leave in ${leaveText(o.leave)}`
                    }</small>`
                  : `<b>${fmtMins(o.itin.typical)}</b>`
              }</span>
            </button></li>`;
          })
          .join('')}</ul>`
      : '';
    const commuteBox = isCommute
      ? `<section class="commute-settings">
          <div class="commute-head"><span>${ICON.pinOn}Your commute</span><button class="link" data-trip="unsave">Remove</button></div>
          <div class="setting">
            <span class="setting-icon">${ICON.bell}</span>
            <span class="setting-text"><strong>Remind me to leave</strong><small>${reminderNote()}</small></span>
            <button class="switch" role="switch" aria-checked="${commute!.remind}" aria-label="Remind me to leave" data-trip="remind"></button>
          </div>
        </section>`
      : '';
    body = `${summary}
      ${journeyBar(plan, tm)}
      <div class="actions trip-actions">
        <button class="btn primary" data-trip="preview">${ICON.play}<span class="wide-only">Preview the trip</span><span class="narrow-only">Preview</span></button>
        ${isCommute ? '' : `<button class="btn" data-trip="save">${ICON.pin}<span class="wide-only">Make it my commute</span><span class="narrow-only">Save commute</span></button>`}
      </div>
      ${commuteBox}
      ${stepsHtml(plan, tm)}
      ${alt}
      <p class="fine">${t.busy && !tm ? 'Getting live times… · ' : ''}Live MBTA predictions, or the timetable where there are none. Walking routes from OpenStreetMap.</p>`;
  }

  target.innerHTML = `
    ${detailNav()}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>Directions</p>
      <h2>${t.to && !t.editing ? escape(t.to.name) : 'Where to?'}</h2>
    </div>
    <div class="od">
      ${odRow('from')}
      ${odRow('to')}
      ${t.to && !t.editing ? `<button class="icon-btn subtle od-swap" data-trip="swap" aria-label="Swap start and destination" title="Swap">${ICON.swap}</button>` : ''}
    </div>
    ${t.editing ? '' : whenHtml()}
    <div id="trip-body">${body}</div>`;
  if (t.editing) {
    if (!placeResults.length && !placeQuery) suggestPlaces('');
    else renderPlaceResults();
  }
}

/** The datetime-local value for a moment, in this device's time zone. */
function localInput(at: number) {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Now, or planning ahead: leave at or arrive by a day and time. */
function whenHtml() {
  const w = trip.when;
  const opt = (mode: When['mode'], label: string) =>
    `<button role="radio" aria-checked="${w.mode === mode}" data-trip-when="${mode}">${label}</button>`;
  return `<div class="when-row">
    <div class="seg seg3" role="radiogroup" aria-label="When">${opt('now', 'Now')}${opt('leave', 'Leave at')}${opt('arrive', 'Arrive by')}</div>
    ${w.mode === 'now' ? '' : `<input id="trip-time" type="datetime-local" value="${localInput(w.at)}" min="${localInput(Date.now() - 3_600_000)}" aria-label="${w.mode === 'leave' ? 'Leave at' : 'Arrive by'}" />`}
  </div>`;
}

function setWhen(mode: When['mode'], at?: number) {
  const prev = trip.when;
  if (mode === 'now') trip.when = NOW;
  else {
    // A sensible start: the time already picked, else the next quarter hour (or an hour on, to arrive by).
    const base = at ?? (prev.mode !== 'now' ? prev.at : Date.now() + (mode === 'arrive' ? 3_600_000 : 900_000));
    trip.when = { mode, at: Math.round(base / 300_000) * 300_000 };
  }
  trip.picked = false;
  trip.timed = null;
  altsTimedAt = 0;
  renderTripPanel();
  if (trip.plans) timeTrip();
  else if (trip.to) planTrip();
}

detailEl.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id !== 'trip-time' || !el.value || trip.when.mode === 'now') return;
  const at = new Date(el.value).getTime();
  if (Number.isFinite(at)) setWhen(trip.when.mode, at);
});

/** Re-renders the trip panel unless someone is typing in it. */
function renderTripPanel() {
  if (selection?.kind !== 'trip') return;
  const input = detailEl.querySelector<HTMLInputElement>('#trip-input');
  if (trip.editing && input && document.activeElement === input) return;
  // While a time is being picked, only what's below the picker changes.
  if (document.activeElement?.id === 'trip-time') {
    const holder = document.createElement('div');
    renderTrip(holder);
    const fresh = holder.querySelector('#trip-body');
    const body = detailEl.querySelector('#trip-body');
    if (fresh && body) body.replaceWith(fresh);
    return;
  }
  const scroll = detailEl.scrollTop;
  renderDetail();
  detailEl.scrollTop = scroll;
}

function tripAction(action: string, el: HTMLElement) {
  const t = trip;
  if (action === 'edit-from' || action === 'edit-to') {
    stopPreview();
    t.editing = action === 'edit-from' ? 'from' : 'to';
    placeQuery = '';
    placeResults = [];
    renderDetail();
    if (isPhone()) sheet.set('full');
    focusTripInput();
  } else if (action === 'cancel-edit') {
    t.editing = null;
    placeQuery = '';
    renderDetail();
    if (isPhone()) sheet.set('half');
  } else if (action === 'swap') {
    // "Your location" can't be a destination; swapping it in uses where you are now.
    const from = t.from ?? (t.origin ? { ...t.origin, name: me ? 'Where you are now' : t.origin.name } : null);
    if (!from || !t.to) return;
    t.from = t.to;
    t.to = from;
    t.chosen = null;
    planTrip();
  } else if (action === 'preview') {
    const it = chosenPlan();
    if (it) previewTrip(it);
  } else if (action === 'save') saveCommute();
  else if (action === 'unsave') {
    commute = null;
    save(COMMUTE_KEY, null);
    commuteState = null;
    renderCommute();
    renderDetail();
  } else if (action === 'remind') {
    if (!commute) return;
    commute.remind = !commute.remind;
    save(COMMUTE_KEY, commute);
    if (commute.remind && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(() => renderTripPanel());
    }
    renderDetail();
  } else if (action === 'watch') {
    const id = el.dataset.vehicle;
    if (!id || !trains.has(id)) return;
    stopPreview();
    select({ kind: 'train', id });
    setCameraMode('follow');
  }
}

detailEl.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id === 'trip-input') suggestPlaces((e.target as HTMLInputElement).value);
});
detailEl.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).id !== 'trip-input') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = placeQuery.trim();
    const p = placeResults.find((x) => x.kind !== 'here' || !q);
    // Nothing yet but an address might be: look it up now.
    if (!p || (q.length >= 3 && p.kind === 'saved')) {
      if (q.length >= 3) lookUpAddresses(q, placeResults.filter((x) => x.kind === 'station'), true);
      return;
    }
    pickPlace(p.kind === 'here' ? null : p);
  } else if (e.key === 'Escape' && trip.to) {
    e.stopPropagation();
    tripAction('cancel-edit', e.target as HTMLElement);
  }
});

// On the map --------------------------------------------------------------------

/** While directions are shown: the trains you'd ride, which keep their color as the rest goes grey. */
let tripFocus: Set<string> | null = null;
/** Stations the trip labels itself, so the map's own labels for them step aside. */
let tripStations: string[] = [];

function drawTrip() {
  const it = tripActive ? chosenPlan() : null;
  const tm = tripActive ? chosenTimed() : null;
  tripFocus = it ? new Set((tm?.legs ?? []).map((l) => l.run?.vehicleId).filter((id): id is string => !!id)) : null;
  tripStations = (it?.legs ?? []).flatMap((l) => (l.kind === 'ride' ? [l.board, ...l.via, l.alight].map((s) => s.id) : []));
  const lines: GeoJSON.Feature[] = [];
  const points: GeoJSON.Feature[] = [];
  const pt = (coords: [number, number], role: string, name: string, color = '#ffffff') =>
    points.push({ type: 'Feature', properties: { role, name, color }, geometry: { type: 'Point', coordinates: coords } });
  if (it) {
    it.legs.forEach((leg, i) => {
      if (leg.kind === 'walk') {
        lines.push({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: leg.path } });
        return;
      }
      const r = legRoute(leg, tm?.legs[i].run);
      const color = r ? displayColor(r.color) : '#ffffff';
      lines.push({ type: 'Feature', properties: { kind: 'ride', color }, geometry: { type: 'LineString', coordinates: leg.path } });
      // Each stop on the way, to count them off.
      for (const v of leg.via) pt([v.lng, v.lat], 'pass', v.name, color);
      const first = i === 0 || it.legs[i - 1].kind === 'walk';
      pt([leg.board.lng, leg.board.lat], 'stop', first ? `Board ${lineShort(r)}` : `Change to ${lineShort(r)}`, color);
      pt([leg.alight.lng, leg.alight.lat], 'stop', `Get off · ${leg.alight.name}`, color);
    });
    const origin = trip.origin ?? trip.from;
    if (origin && origin.name !== HERE) pt([origin.lng, origin.lat], 'from', origin.name, '#3b82f6');
    if (trip.to) pt([trip.to.lng, trip.to.lat], 'to', trip.to.name, '#f43f5e');
  } else if (tripActive && trip.to) pt([trip.to.lng, trip.to.lat], 'to', trip.to.name, '#f43f5e');
  source('trip')?.setData({ type: 'FeatureCollection', features: lines });
  source('trip-points')?.setData({ type: 'FeatureCollection', features: points });
  applyLayerToggles();
}

function tripCoords(it: Itinerary) {
  return it.legs.flatMap((l) => l.path);
}

function fitTrip() {
  const it = chosenPlan();
  if (!it) return;
  const coords = tripCoords(it);
  if (trip.to) coords.push([trip.to.lng, trip.to.lat]);
  if (!coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) b.extend(c);
  if (cameraMode !== 'free') setCameraMode('free');
  map.fitBounds(b, { padding: 70, pitch: flat() ? 0 : 45, bearing: map.getBearing(), maxZoom: 16.5, duration: 1400 });
}

// Previewing the trip: the camera travels the whole way, walking legs low and
// slow, rides higher and quicker, while the panel says what's happening.

let previewing: { raf: number } | null = null;

function previewTrip(it: Itinerary) {
  stopPreview();
  // Each leg as local meters, with its distance along.
  const legs = it.legs
    .map((leg) => {
      const pts = leg.path.map(([lng, lat]) => toLocal(lng, lat));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const length = cum[cum.length - 1];
      const r = leg.kind === 'ride' ? legRoute(leg) : undefined;
      const label = leg.kind === 'walk' ? `Walk to ${leg.to.name === trip.to?.name ? 'the end' : leg.to.name}` : `${lineName(r)} to ${leg.alight.name}`;
      // On-screen seconds: walking reads at street level, rides cover ground.
      const secs = leg.kind === 'walk' ? 2.5 + length / 110 : 3 + length / 900;
      return { leg, pts, cum, length, label, secs, color: r ? displayColor(r.color) : '#e6e9ef' };
    })
    .filter((l) => l.length > 5);
  if (!legs.length) return;
  const total = legs.reduce((a, l) => a + l.secs, 0);
  const scale = Math.min(1, 36 / total);
  for (const l of legs) l.secs *= scale;
  const at = (l: (typeof legs)[number], d: number) => {
    d = Math.max(0, Math.min(l.length, d));
    let i = 1;
    while (i < l.cum.length - 1 && l.cum[i] < d) i++;
    const k = (d - l.cum[i - 1]) / (l.cum[i] - l.cum[i - 1] || 1);
    return [l.pts[i - 1][0] + (l.pts[i][0] - l.pts[i - 1][0]) * k, l.pts[i - 1][1] + (l.pts[i][1] - l.pts[i - 1][1]) * k];
  };
  if (cameraMode !== 'free') setCameraMode('free');
  let start = 0;
  let shown = -1;
  let bearing = map.getBearing();
  let zoom = map.getZoom();
  const step = (now: number) => {
    if (!previewing) return;
    if (!start) start = now;
    let t = (now - start) / 1000;
    let idx = 0;
    while (idx < legs.length - 1 && t > legs[idx].secs) t -= legs[idx++].secs;
    const l = legs[idx];
    const p = Math.min(1, t / l.secs);
    // Ease in and out of each leg, like a train between stations.
    const e = p * p * (3 - 2 * p);
    const d = e * l.length;
    const [x, y] = at(l, d);
    const walk = l.leg.kind === 'walk';
    const [ax, ay] = at(l, d + (walk ? 60 : 350));
    const [bx, by] = at(l, d - (walk ? 20 : 80));
    if (Math.hypot(ax - bx, ay - by) > 2) {
      const target = compass(Math.atan2(ay - by, ax - bx));
      const delta = ((target - bearing + 540) % 360) - 180;
      bearing = (bearing + delta * 0.06 + 360) % 360;
    }
    zoom += ((walk ? 17 : 15.2) - zoom) * 0.05;
    map.jumpTo({ center: toLngLat(x, y), bearing, zoom, pitch: flat() ? 0 : walk ? 62 : 55 });
    if (idx !== shown) {
      shown = idx;
      showMatch(`Preview · ${idx + 1} of ${legs.length}`, l.label, [{ label: 'Stop', primary: true, run: () => stopPreview() }], l.color);
    }
    if (idx === legs.length - 1 && p >= 1) {
      stopPreview();
      fitTrip();
      return;
    }
    previewing.raf = requestAnimationFrame(step);
  };
  previewing = { raf: requestAnimationFrame(step) };
  if (isPhone()) sheet.set('peek');
}

function stopPreview() {
  if (!previewing) return;
  cancelAnimationFrame(previewing.raf);
  previewing = null;
  hideMatch();
  // The sheet tucked away for the preview; bring the steps back.
  if (isPhone() && selection?.kind === 'trip' && sheet.snap === 'peek') sheet.set('half');
}

// Hands on the map stop a preview.
for (const ev of ['pointerdown', 'wheel'] as const) mapEl.addEventListener(ev, () => stopPreview(), { passive: true });

// My commute -----------------------------------------------------------------------
//
// One trip saved: where you go, and where from. It's timed from where you
// are now when location is on (otherwise from where you saved it), and when
// you're at the far end it turns around to take you back.

interface Commute {
  to: Place;
  /** Where it starts: a place you chose, or where you were when you saved it. */
  home: Place;
  remind: boolean;
}
const COMMUTE_KEY = 'live-boston:commute-trip';
let commute: Commute | null = load<Commute | null>(COMMUTE_KEY, null);
if (commute && !commute.to?.name) commute = null;
/** The live plan for the commute card. */
let commuteState: { to: Place; from: Place; back: boolean; plans: Itinerary[]; timed: Timed | null; at: number } | null = null;
let remindedAt = 0;

/** Which way the commute goes from here: out, or back if you're already at the far end. */
function commuteTarget(origin?: { lng: number; lat: number }) {
  if (!commute) return null;
  const back = !!origin && meters(origin, commute.to) < 500;
  return { to: back ? commute.home : commute.to, back };
}

function saveCommute() {
  const t = trip;
  if (!t.to) return;
  const origin = t.from ?? t.origin;
  if (!origin) return;
  const near = nearestStation(origin);
  const home: Place = t.from ? t.from : { name: 'Home', detail: near ? `Near ${near.s.name}` : undefined, lng: origin.lng, lat: origin.lat };
  commute = { to: t.to, home, remind: commute?.remind ?? false };
  save(COMMUTE_KEY, commute);
  commuteState = null;
  shareWithCommute(t);
  toast('Saved as your commute', `It counts down up top to when to leave. Near ${t.to.name}, it turns around for the trip back.`);
  renderCommute();
  renderDetail();
}

/** The open trip answers the commute card too, saving requests. */
function shareWithCommute(t: TripState) {
  if (!commute || !t.plans || !t.to || !t.origin) return;
  const timed = t.timed?.find((x) => !x.unavailable) ?? null;
  const back = samePlace(t.to, commute.home) && !samePlace(t.to, commute.to);
  commuteState = { to: t.to, from: t.origin, back, plans: t.plans, timed, at: Date.now() };
  renderCommute();
}

let commuteBusy = false;
async function refreshCommute() {
  if (!commute || document.hidden || Date.now() < pausedUntil || commuteBusy) return;
  // The open trip already keeps the same thing fresh.
  if (selection?.kind === 'trip' && trip.to && !trip.from && commuteState && samePlace(trip.to, commuteState.to)) return;
  commuteBusy = true;
  try {
    // From where you are, if location is already allowed; else from where it starts.
    let from: Place = commute.home;
    if (me && Date.now() - me.at < 120_000) from = { name: HERE, lng: me.lng, lat: me.lat };
    else if (await locationGranted()) {
      const fix = await whereAmI(10_000);
      if (fix) from = { name: HERE, lng: fix.lng, lat: fix.lat };
    }
    const target = commuteTarget(from)!;
    const g = await loadGraph();
    if (!g) return;
    let st = commuteState;
    // Plan again on a new start or end, or every ten minutes.
    if (!st || !samePlace(st.to, target.to) || meters(st.from, from) > 150 || Date.now() - st.at > 600_000) {
      const plans = g.plan(from, target.to);
      st = commuteState = { to: target.to, from, back: target.back, plans, timed: null, at: Date.now() };
      // The walking part counts for when to leave.
      await Promise.all(plans.slice(0, 2).map(routeWalks));
    }
    // The best two ways, timed (the second less often); the soonest arrival wins.
    const timed: Timed[] = [];
    for (const [i, p] of st.plans.slice(0, 2).entries()) timed.push(await timePlan(p, i ? 180_000 : 25_000));
    if (commuteState === st) st.timed = timed.sort(byBest(NOW))[0] ?? null;
  } catch (err) {
    if (err instanceof RateLimited) handleError(err, '');
    else console.warn(err);
  } finally {
    commuteBusy = false;
  }
  renderCommute();
}

let commuteHtml = '';
function renderCommute() {
  commuteEl.hidden = false;
  commuteEl.classList.toggle('where', !commute);
  sheetEl.classList.toggle('has-commute', !!commute);
  let html: string;
  let color = '#3b82f6';
  if (!commute) {
    html = `<span class="where-icon">${ICON.search}</span>
      <span class="commute-text"><strong>Where to?</strong><span>Directions by T and on foot</span></span>
      <span class="where-go">${ICON.chevronRight}</span>`;
  } else {
    const st = commuteState;
    const tm = st?.timed ?? null;
    const it = tm?.itin ?? st?.plans[0] ?? null;
    const firstRide = tm ? tm.itin.legs.findIndex((l) => l.kind === 'ride') : -1;
    const ride = firstRide >= 0 ? (tm!.itin.legs[firstRide] as RideLeg) : null;
    const run = ride ? tm!.legs[firstRide].run : undefined;
    const route = ride ? legRoute(ride, run) : undefined;
    if (route) color = displayColor(route.color);
    const to = st?.to ?? commute.to;
    const chips = it
      ? it.legs
          .map((l, i) =>
            l.kind === 'walk'
              ? `<i class="chip-walk">${ICON.walk}${Math.max(1, Math.round(l.seconds / 60))}</i>`
              : `<i class="chip-line" style="--c:${(() => {
                  const r = legRoute(l, tm?.legs[i].run);
                  return r ? displayColor(r.color) : '#777';
                })()}">${escape(lineShort(legRoute(l, tm?.legs[i].run)))}</i>`,
          )
          .join('<i class="chip-sep">›</i>')
      : '';
    let side = '<small>Leave in</small><b>…</b>';
    let state = '';
    let line = st && !st.plans.length ? 'No way by T from here' : 'Checking times…';
    if (tm) {
      const leaveIn = tm.leave - Date.now();
      if (leaveIn <= 60_000) {
        side = '<small>Leave</small><b>now</b>';
        state = ' go';
      } else {
        const m = Math.round(leaveIn / 60_000);
        side = `<small>Leave in</small><b>${leaveIn >= 3_600_000 ? clockFmt.format(tm.leave) : `${m}<i>min</i>`}</b>`;
        state = m <= 5 ? ' soon' : '';
      }
      line = `Arrive ${clockFmt.format(tm.arrive)}${run && ride ? ` · ${lineShort(route)} at ${shortClock(run.board)}` : ''}`;
    }
    html = `<span class="card-bar"></span>
      <span class="commute-text">
        <small>${ICON.pinOn}${st?.back ? 'Heading back' : 'My commute'} · to ${escape(to.name)}</small>
        <strong class="chips">${chips || escape(`To ${to.name}`)}</strong>
        <span>${escape(line)}</span>
      </span>
      <span class="commute-side${state}">${side}</span>`;
  }
  // Redrawn every second for the countdown; skip the DOM when nothing changed.
  if (html !== commuteHtml) {
    commuteHtml = html;
    commuteEl.innerHTML = html;
    commuteEl.style.setProperty('--c', color);
    commuteEl.setAttribute('aria-label', commute ? 'My commute' : 'Where to? Get directions');
  }
}

function reminderNote() {
  if (!('Notification' in window)) return 'A banner here when it’s time to go, while the app is open';
  if (Notification.permission === 'denied') return 'Notifications are blocked; you’ll get a banner here instead';
  return 'A notification when it’s time to go, while the app is open';
}

function remindIfTime() {
  const tm = commuteState?.timed;
  if (!commute?.remind || !tm) return;
  const leaveIn = tm.leave - Date.now();
  // Once per departure: a fresh reminder only after a few quiet minutes.
  if (leaveIn > 60_000 || leaveIn < -90_000 || Date.now() - remindedAt < 5 * 60_000) return;
  remindedAt = Date.now();
  const i = tm.itin.legs.findIndex((l) => l.kind === 'ride');
  const ride = i >= 0 ? (tm.itin.legs[i] as RideLeg) : null;
  const run = ride ? tm.legs[i].run : undefined;
  const title = `Time to leave for ${commuteState!.to.name}`;
  const body = ride
    ? `${lineName(legRoute(ride, run))} from ${ride.board.name} at ${clockFmt.format(tm.legs[i].start)}. You’ll arrive about ${clockFmt.format(tm.arrive)}.`
    : `You’ll arrive about ${clockFmt.format(tm.arrive)}.`;
  toast(title, body, true);
  notify(title, body);
}

async function notify(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, icon: `${import.meta.env.BASE_URL}icons/icon-192.png`, tag: 'commute' };
  try {
    // Android only shows notifications through the service worker.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch (err) {
    console.warn(err);
  }
}

commuteEl.addEventListener('click', () => {
  closeSearch();
  if (!commute) {
    openTrip();
    return;
  }
  const st = commuteState;
  const to = st?.to ?? commute.to;
  // From where you are when that's what it's timed from; otherwise from its start.
  const from = st && st.from.name !== HERE ? st.from : null;
  openTrip(to, from);
});

let toastTimer: number | undefined;
function toast(title: string, body: string, urgent = false) {
  toastEl.innerHTML = `<strong>${escape(title)}</strong><span>${escape(body)}</span>`;
  toastEl.classList.toggle('urgent', urgent);
  toastEl.hidden = false;
  toastEl.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('out'), urgent ? 12_000 : 5000);
}
toastEl.addEventListener('click', () => toastEl.classList.add('out'));
toastEl.addEventListener('animationend', (e) => {
  if ((e as AnimationEvent).animationName.startsWith('toast-out')) toastEl.hidden = true;
});

// Where you are ------------------------------------------------------------------
//
// The locate button follows your phone's position. Standing still, it shows
// the nearest station. On the move, it watches for a train that stays with
// you, fix after fix, heading your way, and offers to ride along with it.
// GPS drops out underground, so this works where the train runs in the open.

interface Fix {
  x: number;
  y: number;
  lng: number;
  lat: number;
  /** Meters, the radius the fix is good to. */
  accuracy: number;
  /** m/s and compass degrees, measured by the phone or from the last fix. */
  speed: number | null;
  heading: number | null;
  at: number;
}
let me: Fix | null = null;
/** The last several fixes, to measure speed and direction over a few seconds rather than one noisy hop. */
const trail: Fix[] = [];
let watchId: number | null = null;
let firstFix = true;
/** Trains close to you, and for how many fixes in a row. */
const alongside = new Map<string, number>();
const notMine = new Set<string>();
let offered: string | null = null;
const locateEl = $('#locate');
const matchEl = $('#match');

function toggleLocate() {
  // On quietly for directions: the button now asks to be shown, not to stop.
  if (watchId != null && quietLocate && me) {
    quietLocate = false;
    if (!riding()) map.easeTo({ center: [me.lng, me.lat], zoom: Math.max(map.getZoom(), 15), duration: 1400 });
    offerNearestStation();
    return;
  }
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    me = null;
    trail.length = 0;
    alongside.clear();
    source('me')?.setData(empty());
    locateEl.classList.remove('on', 'waiting');
    locateEl.setAttribute('aria-pressed', 'false');
    hideMatch();
    settleWaiters(null);
    return;
  }
  if (!('geolocation' in navigator)) {
    toast('Location isn’t available', 'This browser can’t share where you are.');
    return;
  }
  startLocate(false);
}

/** Starts following your position. Quietly (for directions), it doesn't fly the map to you. */
function startLocate(quiet: boolean) {
  if (watchId != null) return;
  quietLocate = quiet;
  firstFix = true;
  locateEl.classList.add('on', 'waiting');
  locateEl.setAttribute('aria-pressed', 'true');
  watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30_000 });
}

function onFixError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) {
    locationDenied = true;
    if (!quietLocate) toast('Location is off for this site', 'Allow location for Live Boston in your browser’s settings to see where you are.');
    toggleLocate();
  } else if (firstFix && !quietLocate) {
    toast('Still looking for you', 'No GPS fix yet. It works best outside or above ground.');
  }
}

function onFix(pos: GeolocationPosition) {
  const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
  const [x, y] = toLocal(lng, lat);
  const at = pos.timestamp;
  // Phones often leave out speed and heading; work them out from where you
  // were a few seconds ago, which rides out the jitter in each fix.
  while (trail.length && at - trail[0].at > 15_000) trail.shift();
  const from = [...trail].reverse().find((f) => at - f.at >= 3000) ?? trail[0];
  const dt = from ? (at - from.at) / 1000 : 0;
  const moved = from ? Math.hypot(x - from.x, y - from.y) : 0;
  const measured = from && dt > 0.5 && moved > accuracy ? moved / dt : from && dt >= 3 ? 0 : null;
  me = {
    x,
    y,
    lng,
    lat,
    accuracy,
    speed: speed != null && speed >= 0 ? speed : measured,
    heading:
      heading != null && !Number.isNaN(heading) && (speed ?? 0) > 1
        ? heading
        : measured && from
          ? compass(Math.atan2(y - from.y, x - from.x))
          : null,
    at,
  };
  trail.push(me);
  locateEl.classList.remove('waiting');
  // Circle radius at zoom 0, in pixels: meters over meters-per-pixel (512 px tiles).
  const r0 = (accuracy * 512) / (40_075_016.7 * Math.cos((lat * Math.PI) / 180));
  source('me')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { r0 }, geometry: { type: 'Point', coordinates: [lng, lat] } }] });
  locationDenied = false;
  if (firstFix) {
    firstFix = false;
    if (!quietLocate) {
      if (!riding()) map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15), duration: 1400 });
      offerNearestStation();
    }
  }
  settleWaiters(me);
  findMyTrain();
}

function offerNearestStation() {
  if (!me) return;
  const here = me;
  let best: { s: Station; d: number } | null = null;
  for (const s of stations) {
    const [sx, sy] = toLocal(s.lng, s.lat);
    const d = Math.hypot(sx - here.x, sy - here.y);
    if (!best || d < best.d) best = { s, d };
  }
  if (!best || best.d > 3000) {
    toast('Found you', 'You’re a way from the nearest station.');
    return;
  }
  const s = best.s;
  const minutes = Math.max(1, Math.round(best.d / 1.3 / 60));
  showMatch(
    'Nearest station',
    `${s.name} · ${minutes} min walk`,
    [
      { label: 'Departures', primary: true, run: () => select({ kind: 'station', id: s.id }) },
      { label: 'Close', run: () => {} },
    ],
    displayColor(s.rail ? '#80276C' : s.ferry ? '#008EAA' : '#ffffff'),
  );
}

/** Where a train is now, along its track or on its glide. */
function trainPoint(t: Train) {
  return t.track ? t.track.at(t.d) : { x: t.x, y: t.y };
}

function findMyTrain() {
  const here = me;
  if (!here) return;
  const moving = here.speed != null && here.speed > 3;
  // Close enough to be on board: the fix's uncertainty, plus half a train.
  let best: { t: Train; d: number; n: number } | null = null;
  for (const t of trains.values()) {
    const p = trainPoint(t);
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    const reach = Math.min(400, Math.max(60, here.accuracy * 1.5)) + t.length / 2;
    const facing = !moving || here.heading == null || Math.abs(((compass(t.heading) - here.heading + 540) % 360) - 180) < 60;
    if (d > reach || !facing) {
      alongside.delete(t.v.id);
      continue;
    }
    // Moving together counts; a pause at a station alongside it keeps the count.
    const n = (alongside.get(t.v.id) ?? 0) + (moving ? 1 : 0);
    if (!n) continue;
    alongside.set(t.v.id, n);
    if (!best || n > best.n || (n === best.n && d < best.d)) best = { t, d, n };
  }
  // A few moving fixes in a row together, and it's yours.
  if (!moving || !best || best.n < 3) return;
  const t = best.t;
  if (notMine.has(t.v.id) || offered === t.v.id) return;
  if (selection?.kind === 'train' && selection.id === t.v.id && riding()) return;
  offered = t.v.id;
  showMatch(
    `Looks like you’re on the ${t.route.name}`,
    `To ${destination(t)} · ${vehicleLabel(t)}`,
    [
      {
        label: 'Ride along',
        primary: true,
        run: () => {
          select({ kind: 'train', id: t.v.id });
          setCameraMode('ride');
        },
      },
      { label: 'Not this one', run: () => notMine.add(t.v.id) },
    ],
    hex(t),
  );
}

let matchActions: (() => void)[] = [];
function showMatch(title: string, body: string, actions: { label: string; primary?: boolean; run: () => void }[], color: string) {
  matchActions = actions.map((a) => a.run);
  matchEl.style.setProperty('--c', color);
  matchEl.innerHTML = `
    <span class="dot"></span>
    <div class="match-text"><strong>${escape(title)}</strong><span>${escape(body)}</span></div>
    <div class="match-actions">${actions
      .map((a, i) => `<button class="btn small${a.primary ? ' light' : ''}" data-match="${i}">${escape(a.label)}</button>`)
      .join('')}</div>`;
  matchEl.hidden = false;
  matchEl.classList.remove('out');
}

function hideMatch() {
  if (!matchEl.hidden) matchEl.classList.add('out');
}

matchEl.addEventListener('click', (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>('[data-match]')?.dataset.match;
  if (i == null) return;
  hideMatch();
  matchActions[Number(i)]?.();
});
matchEl.addEventListener('animationend', (e) => {
  if (/^(toast|tip)-out/.test((e as AnimationEvent).animationName)) matchEl.hidden = true;
});
locateEl.addEventListener('click', toggleLocate);

// Map controls
$('#zoom-in').addEventListener('click', () => map.zoomIn());
$('#zoom-out').addEventListener('click', () => map.zoomOut());
$('#compass').addEventListener('click', () => {
  // Riding along, "north" means back to looking ahead of the train.
  if (riding()) rideLook = 0;
  else map.easeTo({ bearing: 0, pitch: flat() ? 0 : map.getPitch(), duration: 700 });
});
$('#overview').addEventListener('click', () => {
  select(null);
  if (cameraMode !== 'free') setCameraMode('free');
  map.fitBounds(OVERVIEW, { pitch: flat() ? 0 : 50, bearing: flat() ? 0 : -18, duration: 1800, padding: 40 });
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (riding()) exitRide();
    searchEl.focus();
    return;
  }
  if (e.key !== 'Escape') return;
  if (riding()) exitRide();
  else select(null);
});

// ---------------------------------------------------------------------------
// Start

async function refreshWeather() {
  const forced = weatherOverride();
  try {
    weather = forced ?? (await loadWeather());
  } catch (err) {
    // Weather is a nicety; without it the sky is simply clear.
    console.warn(err);
  }
  precipitation.set(weather);
  renderConditions();
  applySky();
}

map.on('load', async () => {
  addLayers();
  applySky();
  updatePadding(true);
  requestAnimationFrame(frame);
  // Credits start folded into the ⓘ button.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  if (flat()) applyViewMode(false);
  else if (!deepLink) {
    // The intro: sweep in from over the harbor to the whole system, tilting into 3D.
    const cam = map.cameraForBounds(OVERVIEW, { padding: 40 });
    if (cam) map.flyTo({ ...cam, pitch: 52, bearing: -18, duration: 6000, curve: 1.25, essential: true });
  }
  $('#speed-legend').innerHTML = legendHtml();
  refreshWeather();
  setInterval(refreshWeather, WEATHER_MS);
  setInterval(applySky, 60_000);
  setInterval(refreshDocks, BIKES_MS);
  setInterval(() => speeds.save(), 60_000);
  addEventListener('pagehide', () => speeds.save());

  // Keep trying: a rate limit or a blip at startup shouldn't need a reload.
  for (let attempt = 0; !network; attempt++) {
    try {
      [network, stations] = await Promise.all([loadNetwork(), loadStations()]);
    } catch (err) {
      handleError(err, 'Couldn’t load the T, retrying');
      const wait = err instanceof RateLimited ? err.retryAt - Date.now() : 2000 * 2 ** Math.min(attempt, 4);
      await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
    }
  }
  mbtaRouteIds = [...network.routes.keys()];
  for (const s of stations) for (const id of [s.id, ...s.children]) stationByStop.set(id, s);
  drawLines();
  drawStations();
  renderMain();
  renderCommute();
  await poll();
  setInterval(poll, POLL_MS);
  pollAmtrak();
  setInterval(pollAmtrak, AMTRAK_MS);
  // Spread the rest out: the MBTA allows 20 requests a minute without a key.
  setTimeout(() => {
    refreshAlerts();
    setInterval(refreshAlerts, ALERTS_MS);
  }, 2500);
  setTimeout(() => {
    refreshCommute();
    setInterval(refreshCommute, COMMUTE_MS);
  }, 5000);

  openFromHash();
  if (!deepLink) setTimeout(showSpinTip, 6500);
  // A link pasted into an open tab only changes the hash; follow it too.
  window.addEventListener('hashchange', openFromHash);
});

/** Phones and tablets: a touchscreen is the main way in. */
const touchFirst = matchMedia('(pointer: coarse)').matches;
if (touchFirst) $('.search kbd').hidden = true;

/** A one-time hint on how to spin the city, shown after the intro. */
function showSpinTip() {
  const KEY = 'live-boston:tip-spin';
  if (load(KEY, false)) return;
  save(KEY, true);
  const tip = $('#tip');
  tip.querySelector('span')!.textContent = touchFirst
    ? 'Twist with two fingers to spin the city'
    : 'Swipe sideways with two fingers to spin the city';
  tip.hidden = false;
  const hide = () => tip.classList.add('out');
  tip.addEventListener('click', hide);
  setTimeout(hide, 7000);
  tip.addEventListener('animationend', (e) => {
    if (/^(tip|toast)-out/.test((e as AnimationEvent).animationName)) tip.hidden = true;
  });
}

function openFromHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const trainId = hash.get('train');
  const stationId = hash.get('station');
  if (trainId && trains.has(trainId)) {
    select({ kind: 'train', id: trainId });
    setCameraMode(hash.has('cab') && !flat() ? 'cab' : 'ride');
  } else if (stationId && stations.some((s) => s.id === stationId)) {
    select({ kind: 'station', id: stationId });
  } else if (hash.has('following')) {
    setTab('following');
  } else if (hash.has('alerts')) {
    setTab('alerts');
  }
}

registerServiceWorker();
renderMain(true);
renderCommute();
setInterval(tick, 1000);
tick();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) catchUp();
  if (document.hidden) return;
  if (Date.now() - lastUpdate > POLL_MS) poll();
  refreshCommute();
});

/** Puts every train straight at its estimate, after time the page didn't see. */
function catchUp() {
  const now = performance.now();
  for (const t of trains.values()) {
    if (t.track) {
      const e = estimate(t, now);
      t.d = e.d;
      t.vel = e.vel;
    } else t.start = now - t.dur;
  }
}
