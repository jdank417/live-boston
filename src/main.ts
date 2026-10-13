import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { Color } from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { basemap, PALETTE } from './basemap';
import { loadDocks, type Dock } from './bikes';
import { compass, toLngLat, toLocal, Track } from './geo';
import {
  loadDepartures,
  loadNetwork,
  loadStations,
  loadUpcomingStops,
  loadVehicles,
  RateLimited,
  type Departure,
  type Network,
  type Route,
  type Station,
  type UpcomingStop,
  type Vehicle,
} from './mbta';
import { isPhone, Sheet } from './sheet';
import { blend, SKY, skyAt, sunTimes, type SkyState } from './sky';
import { SPEED_SCALE, SpeedMap } from './speedmap';
import { TrainLayer, type Car } from './trains3d';
import { CLEAR, loadWeather, Precipitation, weatherOverride, type Weather } from './weather';

const POLL_MS = 12_000;
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
}

const GROUPS: Group[] = [
  { id: 'Red', label: 'Red Line', match: (r) => r.id === 'Red' },
  { id: 'Orange', label: 'Orange Line', match: (r) => r.id === 'Orange' },
  { id: 'Blue', label: 'Blue Line', match: (r) => r.id === 'Blue' },
  { id: 'Green', label: 'Green Line', match: (r) => r.id.startsWith('Green-') },
  { id: 'Mattapan', label: 'Mattapan Trolley', match: (r) => r.id === 'Mattapan' },
  { id: 'SL', label: 'Silver Line', match: (r) => r.type === 3 },
  { id: 'CR', label: 'Commuter Rail', match: (r) => r.type === 2 },
];
const groupOf = (r: Route) => GROUPS.find((g) => g.match(r))?.id ?? r.id;
const kindOf = (r: Route) => (r.type === 2 ? 'rail' : r.type === 3 ? 'bus' : 'subway');

/** Brand colors, with the darkest brightened so they hold up on a dark map. */
const ON_DARK: Record<string, string> = {
  '#003DA5': '#3b82f6', // Blue Line
  '#80276C': '#c050ad', // Commuter Rail
  '#7C878E': '#b4bec6', // Silver Line
  '#00843D': '#16a34a', // Green Line
};
function displayColor(hex: string) {
  return ON_DARK[hex.toUpperCase()] ?? hex;
}

interface CarSpec {
  length: number;
  width: number;
  height: number;
  body: string;
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

/** The consist to draw, and whether its size is a typical one rather than reported. */
function consist(route: Route, reported: number | null): { cars: CarSpec[]; estimated: boolean; gap: number } {
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
const layers = { speed: false, bikes: false, weather: true, ...load(LAYERS_KEY, {}) };

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
const tracks = new Map<string, Track>();
let stations: Station[] = [];
const hidden = new Set<string>();

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
if (import.meta.env.DEV) Object.assign(window, { map, trains, speeds, debugJumps, toLngLat, estimate });
let lastUpdate = 0;
let pausedUntil = 0;
const colorCache = new Map<string, Color>();
const color = (hex: string) => {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new Color(hex)));
  return c;
};

type Tab = 'lines' | 'following' | 'map';
let tab: Tab = 'lines';
type Selection = { kind: 'train' | 'station' | 'dock'; id: string } | null;
let selection: Selection = null;
type CameraMode = 'free' | 'follow' | 'ride';
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
  map.addSource('lines', { type: 'geojson', data: empty() });
  const widths = { subway: [1.6, 6], rail: [1, 3.6], bus: [0.8, 3] } as const;
  for (const kind of ['bus', 'rail', 'subway'] as const) {
    const [lo, hi] = widths[kind];
    map.addLayer({
      id: `${kind}-casing`,
      type: 'line',
      source: 'lines',
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': PALETTE.background,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, lo + 2, 17, hi + 4],
      },
    });
    map.addLayer({
      id: `${kind}-lines`,
      type: 'line',
      source: 'lines',
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, lo, 17, hi],
        'line-opacity': kind === 'subway' ? 1 : 0.85,
        // The Silver Line runs on streets: dashed, like a bus route.
        ...(kind === 'bus' ? { 'line-dasharray': [1.6, 1.2] } : {}),
      },
    });
  }

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
      'circle-stroke-color': ['case', ['get', 'rail'], '#e3a6d8', ['get', 'bus'], '#b4bec6', '#ffffff'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 2.5],
      'circle-opacity': show(14.5) as any,
      'circle-stroke-opacity': show(14.5) as any,
    },
  });

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
    filter: ['any', ['get', 'selected'], ['get', 'followed']],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 12],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#ffc94d'],
      'circle-stroke-width': 2,
      'circle-stroke-opacity': fadeOut(1) as any,
    },
  });
  map.addLayer({
    id: 'vehicles',
    type: 'circle',
    source: 'vehicles',
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
      'circle-color': ['get', 'color'],
      'circle-stroke-color': PALETTE.background,
      'circle-stroke-width': 1.5,
      'circle-opacity': fadeOut(1) as any,
      'circle-stroke-opacity': fadeOut(1) as any,
    },
  });

  // Trains draw above the lines and stations, below the labels.
  map.addLayer(trainLayer);

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
      'text-color': ['case', ['get', 'major'], '#e6e9ef', '#a3abb8'],
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
      properties: { id: s.id, name: s.name, rail: s.rail, bus: s.bus, major: !s.rail && !s.bus },
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
  map.setLayoutProperty('speed-lines', 'visibility', vis(layers.speed));
  for (const id of ['bikes', 'bike-counts']) map.setLayoutProperty(id, 'visibility', vis(layers.bikes));
  for (const kind of ['bus', 'rail', 'subway']) {
    map.setPaintProperty(`${kind}-lines`, 'line-opacity', layers.speed ? 0.15 : kind === 'subway' ? 1 : 0.85);
  }
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

function trackFor(v: Vehicle, route: Route): Track | undefined {
  if (!network) return;
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
  return Math.min(45_000, Math.max(0, Date.now() - v.updatedAt));
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
  const track = sameTrip && existing.track ? existing.track : trackFor(v, route);
  const snapped = track?.project(x, y, sameTrip ? existing.base : undefined);
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
    t.fx = t.x;
    t.fy = t.y;
    t.tx = x;
    t.ty = y;
    t.start = now;
    t.dur = POLL_MS;
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
  let limit = t.base + 800;
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
    const vehicles = await loadVehicles([...network.routes.keys()]);
    const now = performance.now();
    const seen = new Set<string>();
    for (const v of vehicles) {
      if (Date.now() - v.updatedAt > STALE_MS) continue;
      seen.add(v.id);
      applyReport(v, now);
    }
    for (const id of trains.keys()) if (!seen.has(id)) trains.delete(id);
    if (selection?.kind === 'train' && !trains.has(selection.id)) select(null);
    lastUpdate = Date.now();
    setNotice(null);
    if (layers.speed) drawSpeedMap();
    refreshCounts();
    if (tab === 'following') renderMain();
    if (selection?.kind === 'train') renderDetail();
    renderHud();
  } catch (err) {
    handleError(err, 'Can’t reach the MBTA, retrying');
  }
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
      body: train.bodies[i],
      accent: train.accent,
      selected,
      followed: starred,
      roll: sway * Math.sin(now / 480 + train.phase + i * 0.8),
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
        small: t.route.type >= 2,
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
  // Never steer while someone has their hands on the map: moving the camera
  // resets MapLibre's gesture handlers, so a pinch or twist could never start.
  const busy = handsOn(now);
  if (wasBusy && !busy && cameraMode === 'ride') {
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
  if (cameraMode === 'ride') {
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
  if (cameraMode === 'ride') {
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

function setCameraMode(mode: CameraMode) {
  cameraMode = mode;
  document.body.classList.toggle('cinematic', mode === 'ride');
  const t = selection?.kind === 'train' ? trains.get(selection.id) : undefined;
  updatePadding(true);
  if (t && mode === 'ride') {
    rideBearing = compass(t.heading);
    rideLook = 0;
    map.easeTo({
      center: toLngLat(t.x, t.y),
      zoom: t.route.type === 2 ? 17.4 : 18,
      pitch: flat() ? 0 : 72,
      bearing: rideBearing,
      duration: 2200,
      essential: true,
    });
  } else if (t && mode === 'follow') {
    map.easeTo({
      center: toLngLat(t.x, t.y),
      zoom: Math.max(map.getZoom(), 15.8),
      pitch: flat() ? 0 : 55,
      duration: 1500,
    });
  }
  if (mode !== 'ride' && touring) setTouring(false);
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
  if (cameraMode === 'ride') return;
  const train = trainAt(e.point);
  if (train) return select({ kind: 'train', id: train });
  const station = featureAt(e.point, ['stations']);
  if (station) return select({ kind: 'station', id: String(station.properties.id) });
  const dock = featureAt(e.point, ['bikes']);
  if (dock) return select({ kind: 'dock', id: String(dock.properties.id) });
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
const hudEl = $('#hud');
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
}

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

function countdown(at: number) {
  const s = Math.round((at - Date.now()) / 1000);
  if (s <= 30) return 'Now';
  if (s < 90) return '1 min';
  return `${Math.round(s / 60)} min`;
}

function renderConditions() {
  const parts = [weather.tempF != null ? `${Math.round(weather.tempF)}°` : '', weather.label].filter(Boolean);
  $('#conditions').textContent = parts.join(' ');
}

function groupColor(g: Group) {
  const route = network && [...network.routes.values()].find(g.match);
  return route ? displayColor(route.color) : '#777';
}

function groupRoutes(g: Group) {
  return network ? [...network.routes.values()].filter(g.match) : [];
}

function groupSubtitle(g: Group) {
  const routes = groupRoutes(g);
  if (g.id === 'Green') return 'B · C · D · E branches';
  if (g.id === 'SL') return routes.map((r) => r.short).join(' · ');
  if (g.id === 'CR') return routes.length ? `${routes.length} lines from North & South Station` : '';
  const [to0, to1] = routes[0]?.destinations ?? [];
  return to0 && to1 ? `${to1} ↔ ${to0}` : '';
}

// Tabs -------------------------------------------------------------------------

function setTab(next: Tab) {
  tab = next;
  sheetEl.dataset.tab = next;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === next)));
  if (selection) select(null);
  renderMain(true);
  sheet.reveal();
}

function renderMain(enter = false) {
  mainEl.classList.toggle('enter', enter);
  if (tab === 'lines') renderLines();
  else if (tab === 'following') renderFollowing();
  else renderMapTab();
  renderFollowingBadge();
}

function renderLines() {
  const counts = new Map<string, number>();
  for (const t of trains.values()) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  mainEl.innerHTML = `
    <ul class="lines">
      ${GROUPS.map((g, i) => {
        const on = !hidden.has(g.id);
        return `<li class="line${on ? '' : ' off'}" style="--c:${groupColor(g)};--i:${i}">
          <button class="line-main" data-focus="${g.id}" title="Show the ${g.label} on the map">
            <span class="line-swatch"></span>
            <span class="line-text"><strong>${g.label}</strong><small>${escape(groupSubtitle(g))}</small></span>
            <span class="line-count"><b data-count="${g.id}">${counts.get(g.id) ?? 0}</b><small>${g.id === 'SL' ? 'buses' : 'trains'}</small></span>
          </button>
          <button class="switch" role="switch" aria-checked="${on}" aria-label="Show ${g.label}" data-toggle="${g.id}"></button>
        </li>`;
      }).join('')}
    </ul>
    <button class="cta" data-action="tour" style="--i:${GROUPS.length}">
      <span class="cta-icon">${ICON.play}</span>
      <span><strong>Take the tour</strong><small>Ride along with trains across the city</small></span>
    </button>`;
}

/** Updates the live numbers in place, without redrawing the list. */
function refreshCounts() {
  const counts = new Map<string, number>();
  for (const t of trains.values()) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    el.textContent = String(counts.get(el.dataset.count!) ?? 0);
  });
  renderStatus();
}

function vehicleLabel(t: Train) {
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

function renderMapTab() {
  const { rise, set } = sunTimes(skyTime());
  const bikes = docks.reduce((n, d) => n + d.bikes + d.ebikes, 0);
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
    <section class="group" style="--i:2">
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
            ]
        )
          .map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`)
          .join('')}
      </ul>
    </section>
    <section class="group" style="--i:3">
      <h3>Sky over Boston</h3>
      <div class="sky">
        <div><small>Now</small><strong>${sunPhase()}</strong></div>
        <div><small>Sunrise</small><strong>${rise ? clockFmt.format(rise) : '—'}</strong></div>
        <div><small>Sunset</small><strong>${set ? clockFmt.format(set) : '—'}</strong></div>
      </div>
    </section>
    <p class="credits" style="--i:4">Live data from the MBTA, Bluebikes and Open-Meteo. Map data © OpenStreetMap contributors, OpenMapTiles.</p>`;
}

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
  selection = next;
  upcoming = null;
  departures = null;
  clearInterval(refreshTimer);
  if (cameraMode !== 'free' && !keepTour) setCameraMode('free');
  const hash = next && next.kind !== 'dock' ? `#${next.kind}=${encodeURIComponent(next.id)}` : '';
  history.replaceState(null, '', hash || location.pathname + location.search);
  sheetEl.classList.toggle('has-detail', !!next);
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
  const cinematic = cameraMode === 'ride';
  const phone = isPhone();
  // Layout position, not the on-screen one: the sidebar may be mid-slide.
  const left = !cinematic && !phone ? Math.max(0, sheetEl.offsetLeft + sheetEl.offsetWidth) : 0;
  const bottom = !cinematic && phone ? Math.min(sheet.height, innerHeight * 0.6) : 0;
  const now = map.getPadding();
  if (Math.abs((now.left ?? 0) - left) < 1 && Math.abs((now.bottom ?? 0) - bottom) < 1) return;
  // Setting padding stops any camera animation, so wait for it to land.
  if (map.isEasing() && !immediate) map.once('moveend', () => updatePadding());
  else map.setPadding({ top: 0, right: 0, left, bottom });
}
addEventListener('resize', () => updatePadding());

function detailNav(starredId?: string) {
  const label = { lines: 'Lines', following: 'Following', map: 'Map' }[tab];
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
  else renderDock(selection.id);
}

function renderTrain(id: string) {
  const t = trains.get(id);
  if (!t) return;
  const v = t.v;
  const bus = t.route.type === 3;
  const c = `#${t.accent.getHexString()}`;
  const branch = v.routeId.startsWith('Green-') ? ` · ${v.routeId.slice(-1)} branch` : '';
  const speed = mph(t);
  const next = upcoming?.[0];
  const { r, g, b } = t.accent;
  const onAccent = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0a0c10' : '#ffffff';

  const consistHtml = t.cars
    .map((car, i) => `<span class="car${car === LOCOMOTIVE ? ' loco' : ''}${i === 0 ? ' lead' : ''}" style="flex:${car.length}"></span>`)
    .join('');
  let stops = '<p class="muted">Loading arrival times…</p>';
  if (upcoming && !upcoming.length) stops = '<p class="muted">No arrival times for this one right now.</p>';
  else if (upcoming)
    stops = `<ol class="timeline">${upcoming
      .slice(0, 8)
      .map((s) => `<li><span>${escape(s.name)}</span><time data-at="${s.at}">${countdown(s.at)}</time></li>`)
      .join('')}</ol>`;
  const statusLabel = { STOPPED_AT: 'Stopped at', INCOMING_AT: 'Arriving at', IN_TRANSIT_TO: 'Next stop' }[v.status] ?? 'Next stop';

  detailEl.style.setProperty('--c', c);
  detailEl.style.setProperty('--on-c', onAccent);
  detailEl.innerHTML = `
    ${detailNav(id)}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>${escape(t.route.name)}${branch}</p>
      <h2><small>To</small>${escape(destination(t))}</h2>
    </div>
    <div class="status">
      <div><small>${statusLabel}</small><strong>${escape(v.stopName ?? '—')}</strong></div>
      ${next ? `<time class="eta" data-at="${next.at}">${countdown(next.at)}</time>` : ''}
    </div>
    <dl class="metrics">
      <div><dt>Speed</dt><dd>${v.status === 'STOPPED_AT' ? '0<small>mph</small>' : speed != null ? `${speed}<small>mph</small>` : '—'}</dd></div>
      <div><dt>${bus ? 'Type' : 'Cars'}</dt><dd>${bus ? 'Artic' : `${t.cars.length}${t.estimated ? '*' : ''}`}</dd></div>
      <div><dt>${t.route.type === 2 && v.tripName ? 'Train' : bus ? 'Bus' : 'Car'}</dt><dd>${escape(t.route.type === 2 && v.tripName ? v.tripName : v.label)}</dd></div>
    </dl>
    <div class="consist" aria-hidden="true">${consistHtml}</div>
    <div class="actions">
      <button class="btn primary" data-action="ride">${ICON.play}Ride along</button>
      <button class="btn" data-action="follow" aria-pressed="${cameraMode === 'follow'}">${cameraMode === 'follow' ? 'Tracking' : 'Keep in view'}</button>
    </div>
    <h3>Upcoming</h3>
    ${stops}
    <p class="fine">Position reported <span data-ago="${v.updatedAt}">${ago(v.updatedAt)}</span>${
      t.estimated ? ` · *${t.route.type === 2 ? 'Commuter rail doesn’t report its cars; a typical set is shown' : 'Consist not reported; typical shown'}` : ''
    }</p>`;
}

function renderStation(id: string) {
  const s = stations.find((st) => st.id === id);
  if (!s || !network) return;
  const c = s.rail ? displayColor('#80276C') : s.bus ? displayColor('#7C878E') : '#ffffff';
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

  detailEl.innerHTML = `
    ${detailNav()}
    <div class="hero">
      <p class="eyebrow"><span class="dot"></span>${s.rail ? 'Commuter rail station' : s.bus ? 'Silver Line stop' : 'Station'}</p>
      <h2>${escape(s.name)}</h2>
    </div>
    <h3>Departures</h3>
    ${body}
    <p class="fine">Live MBTA predictions. Tap one to jump to it.</p>`;
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

/** The caption bar while riding along: line, destination, next stop, speed. */
function renderHud() {
  const t = selection?.kind === 'train' && cameraMode === 'ride' ? trains.get(selection.id) : undefined;
  hudEl.hidden = !t;
  if (!t) return;
  const next = upcoming?.[0];
  const speed = mph(t);
  hudEl.style.setProperty('--c', `#${t.accent.getHexString()}`);
  hudEl.innerHTML = `
    <div class="hud-id">
      <span class="dot"></span>
      <div><small>${escape(t.route.name)}</small><strong>To ${escape(destination(t))}</strong></div>
    </div>
    <div class="hud-cell"><small>${t.v.status === 'STOPPED_AT' ? 'Stopped at' : 'Next stop'}</small><strong>${escape(t.v.stopName ?? '—')}</strong></div>
    ${next ? `<div class="hud-cell"><small>Arrives</small><strong data-at="${next.at}">${countdown(next.at)}</strong></div>` : ''}
    <div class="hud-cell"><small>Speed</small><strong>${
      t.v.status === 'STOPPED_AT' ? '0 <em>mph</em>' : speed != null ? `${speed} <em>mph</em>` : '—'
    }</strong></div>
    <div class="hud-tools">
      ${touring ? `<button class="hud-btn" data-action="skip">Next train <span data-tour-left></span></button>` : ''}
      <button class="hud-btn exit" data-action="exit-ride">${ICON.close}<span>Exit</span></button>
    </div>`;
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

/** Fits the map to a line, leaving room for the sidebar. */
function focusGroup(id: string) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g || !network) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const r of groupRoutes(g)) for (const s of network.routeShapes.get(r.id) ?? []) for (const p of network.shapes.get(s) ?? []) bounds.extend(p);
  if (bounds.isEmpty()) return;
  if (hidden.delete(id)) {
    drawLines();
    renderLines();
  }
  map.fitBounds(bounds, { padding: 48, pitch: flat() ? 0 : 40, bearing: flat() ? 0 : map.getBearing(), duration: 1600 });
}

sheetEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(
    '[data-tab],[data-toggle],[data-focus],[data-layer],[data-view],[data-action],[data-train],[data-unfollow]',
  );
  if (!el) return;
  const d = el.dataset;
  if (d.tab) setTab(d.tab as Tab);
  else if (d.toggle) {
    if (hidden.has(d.toggle)) hidden.delete(d.toggle);
    else hidden.add(d.toggle);
    drawLines();
    renderLines();
    renderStatus();
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
  } else if (d.action === 'back') select(null);
  else if (d.action === 'star' && selection?.kind === 'train') toggleFollow(selection.id);
  else if (d.action === 'ride') setCameraMode('ride');
  else if (d.action === 'follow') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
  else if (d.action === 'tour') setTouring(true);
});

hudEl.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'skip') nextTourStop();
  if (action === 'exit-ride') exitRide();
});

function exitRide() {
  setTouring(false);
  setCameraMode('free');
  map.easeTo({ pitch: flat() ? 0 : 55, zoom: Math.min(map.getZoom(), 16), duration: 1200 });
}

function setViewMode(next: ViewMode) {
  if (next === viewMode) return;
  viewMode = next;
  save(VIEW_KEY, viewMode);
  applyViewMode(true);
  if (tab === 'map') renderMain();
}

function applyViewMode(animate: boolean) {
  if (map.getLayer('buildings-3d')) map.setLayoutProperty('buildings-3d', 'visibility', flat() ? 'none' : 'visible');
  if (flat()) {
    // Lock the tilt only once the camera has flattened, or it snaps.
    map.easeTo({ pitch: 0, bearing: cameraMode === 'ride' ? map.getBearing() : 0, duration: animate ? 900 : 0 });
    map.once('moveend', () => flat() && map.setMaxPitch(0));
  } else {
    map.setMaxPitch(78);
    map.easeTo({ pitch: cameraMode === 'ride' ? 72 : 52, duration: animate ? 900 : 0 });
  }
}

// Map controls
$('#zoom-in').addEventListener('click', () => map.zoomIn());
$('#zoom-out').addEventListener('click', () => map.zoomOut());
$('#compass').addEventListener('click', () => {
  // Riding along, "north" means back to looking ahead of the train.
  if (cameraMode === 'ride') rideLook = 0;
  else map.easeTo({ bearing: 0, pitch: flat() ? 0 : map.getPitch(), duration: 700 });
});
$('#overview').addEventListener('click', () => {
  select(null);
  if (cameraMode !== 'free') setCameraMode('free');
  map.fitBounds(OVERVIEW, { pitch: flat() ? 0 : 50, bearing: flat() ? 0 : -18, duration: 1800, padding: 40 });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (cameraMode === 'ride') exitRide();
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
  drawLines();
  drawStations();
  renderMain();
  await poll();
  setInterval(poll, POLL_MS);

  openFromHash();
  if (!deepLink) setTimeout(showSpinTip, 6500);
  // A link pasted into an open tab only changes the hash; follow it too.
  window.addEventListener('hashchange', openFromHash);
});

/** Phones and tablets: a touchscreen is the main way in. */
const touchFirst = matchMedia('(pointer: coarse)').matches;

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
    if ((e as AnimationEvent).animationName === 'tip-out') tip.hidden = true;
  });
}

function openFromHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const trainId = hash.get('train');
  const stationId = hash.get('station');
  if (trainId && trains.has(trainId)) {
    select({ kind: 'train', id: trainId });
    setCameraMode('ride');
  } else if (stationId && stations.some((s) => s.id === stationId)) {
    select({ kind: 'station', id: stationId });
  } else if (hash.has('following')) {
    setTab('following');
  }
}

renderMain(true);
setInterval(tick, 1000);
tick();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) catchUp();
  if (!document.hidden && Date.now() - lastUpdate > POLL_MS) poll();
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
