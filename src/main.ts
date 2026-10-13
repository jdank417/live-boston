import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { Color } from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
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
import { BASEMAP, blend, BUILDINGS, SKY, skyAt, type SkyState } from './sky';
import { SPEED_SCALE, SpeedMap } from './speedmap';
import { TrainLayer, type Car, type Glow } from './trains3d';
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
  { id: 'Red', label: 'Red', match: (r) => r.id === 'Red' },
  { id: 'Orange', label: 'Orange', match: (r) => r.id === 'Orange' },
  { id: 'Blue', label: 'Blue', match: (r) => r.id === 'Blue' },
  { id: 'Green', label: 'Green', match: (r) => r.id.startsWith('Green-') },
  { id: 'Mattapan', label: 'Mattapan', match: (r) => r.id === 'Mattapan' },
  { id: 'SL', label: 'Silver Line', match: (r) => r.type === 3 },
  { id: 'CR', label: 'Commuter Rail', match: (r) => r.type === 2 },
];
const groupOf = (r: Route) => GROUPS.find((g) => g.match(r))?.id ?? r.id;
const kindOf = (r: Route) => (r.type === 2 ? 'rail' : r.type === 3 ? 'bus' : 'subway');

/** Brand colors, with the darkest brightened so they hold up on a dark map. */
const ON_DARK: Record<string, string> = {
  '#003DA5': '#2f78ff', // Blue Line
  '#80276C': '#b545a3', // Commuter Rail
  '#7C878E': '#aab5be', // Silver Line
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
const STAINLESS = '#d7dce4';
const CARS: Record<string, CarSpec & { usual: number }> = {
  Red: { length: 21.5, width: 3.05, height: 3.7, body: STAINLESS, usual: 6 },
  Orange: { length: 19.8, width: 3.0, height: 3.66, body: STAINLESS, usual: 6 },
  Blue: { length: 14.8, width: 2.85, height: 3.6, body: STAINLESS, usual: 6 },
  Green: { length: 22.7, width: 2.65, height: 3.5, body: '#e3e6ea', usual: 2 },
  Mattapan: { length: 14.2, width: 2.6, height: 3.2, body: '#e9e2cf', usual: 1 },
};
const LOCOMOTIVE: CarSpec = { length: 20.7, width: 3.2, height: 4.4, body: '#2b2030' };
const BILEVEL: CarSpec = { length: 25.9, width: 3.2, height: 4.9, body: '#c9ced6' };
// An 18 m articulated bus, as its two sections.
const BUS_FRONT: CarSpec = { length: 11, width: 2.6, height: 3.3, body: '#cfd4da' };
const BUS_REAR: CarSpec = { length: 7, width: 2.6, height: 3.3, body: '#cfd4da' };

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

// ---------------------------------------------------------------------------
// Map

const flatAtStart = (() => {
  try {
    return JSON.parse(localStorage.getItem('live-boston:view') ?? '""') === '2d';
  } catch {
    return false;
  }
})();
const deepLink = !!location.hash;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  // The intro flies in from over the harbor; deep links and 2D start in place.
  ...(deepLink || flatAtStart
    ? { bounds: OVERVIEW }
    : { center: [-70.94, 42.3] as [number, number], zoom: 10.4, pitch: 10, bearing: 40 }),
  maxPitch: 78,
  attributionControl: { compact: true, customAttribution: 'Live data © MBTA · Bluebikes · Open-Meteo' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
// The style asks for a few pattern images it doesn't ship; stand in a blank one.
map.on('styleimagemissing', (e) => {
  if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

const trainLayer = new TrainLayer();
const precipitation = new Precipitation(document.querySelector<HTMLCanvasElement>('#weather-fx')!);
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
if (import.meta.env.DEV) Object.assign(window, { map, trains, speeds, debugJumps });
let lastUpdate = 0;
let pausedUntil = 0;
const colorCache = new Map<string, Color>();
const color = (hex: string) => {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new Color(hex)));
  return c;
};

type Selection =
  | { kind: 'train'; id: string }
  | { kind: 'station'; id: string }
  | { kind: 'dock'; id: string }
  | { kind: 'following'; id?: undefined }
  | null;
let selection: Selection = null;
type CameraMode = 'free' | 'follow' | 'ride';
let cameraMode: CameraMode = 'free';
let rideBearing = 0;
let touring = false;
let tourNext = 0;
/** Opened a train from the Following tab, so its card offers a way back. */
let backToFollowing = false;
let lastInteraction = performance.now();

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

/** A train you follow, with enough to describe it while it's out of service. */
interface Followed {
  id: string;
  routeId: string;
  label: string;
}
const FOLLOWING_KEY = 'live-boston:following';
let followed: Followed[] = load(FOLLOWING_KEY, []);
const isFollowed = (id: string) => followed.some((f) => f.id === id);

type ViewMode = '2d' | '3d';
const VIEW_KEY = 'live-boston:view';
let viewMode: ViewMode = flatAtStart ? '2d' : '3d';
const flat = () => viewMode === '2d';

const LAYERS_KEY = 'live-boston:layers';
const layers = load(LAYERS_KEY, { speed: false, bikes: false });

let docks: Dock[] = [];
let docksAt = 0;
let weather: Weather = CLEAR;
let sky: SkyState = skyAt(new Date());

// ---------------------------------------------------------------------------
// Style

/** `?hour=21.5` previews the city at another time of day (Boston time). */
function skyTime() {
  const hour = Number(new URLSearchParams(location.search).get('hour'));
  if (!new URLSearchParams(location.search).has('hour') || !Number.isFinite(hour)) return new Date();
  const now = new Date();
  const boston = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offset = now.getTime() - boston.getTime();
  boston.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return new Date(boston.getTime() + offset);
}

/** Recolors the city for the time of day and the weather. Cheap enough to run every minute. */
function applySky() {
  const s = skyAt(skyTime());
  // Clouds and rain take the edge off daylight.
  const gloom = weather.cloud * 0.3 + (weather.kind === 'rain' || weather.kind === 'storm' ? 0.15 : 0);
  sky = { ...s, day: s.day * (1 - gloom) };
  for (const [id, [prop, colors]] of Object.entries(BASEMAP)) {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, blend(colors, sky));
  }
  const foggy = weather.kind === 'fog' ? 1 : weather.kind === 'rain' || weather.kind === 'snow' ? 0.5 : 0;
  map.setSky({
    'sky-color': blend(SKY['sky-color'], sky),
    'horizon-color': blend(SKY['horizon-color'], sky),
    'fog-color': blend(SKY['fog-color'], sky),
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7 - foggy * 0.4,
    'fog-ground-blend': 0.85 - foggy * 0.55,
  });
  // Light the buildings from where the sun is; at night, a soft cool fill.
  map.setLight({
    anchor: 'map',
    position: [1.5, sky.azimuthDeg, sky.altitudeDeg > 0 ? 90 - Math.max(15, sky.altitudeDeg) : 40],
    color: sky.day > 0.5 ? '#fff3df' : '#b9c8ff',
    intensity: 0.22 + 0.28 * sky.day,
  });

  const h = ['coalesce', ['get', 'render_height'], 0];
  if (map.getLayer('buildings-3d')) {
    map.setPaintProperty('buildings-3d', 'fill-extrusion-color', [
      'case',
      // About one building in five has its lights on after dark. Height makes
      // a stable pseudo-random pick, since the tiles carry no ids.
      ['==', ['%', ['round', ['*', h, 7.3]], 5], 0],
      ['interpolate', ['linear'], h, 0, blend(BUILDINGS.lit, sky), 200, blend(['#9a7448', '#6a5552', BUILDINGS.tall[2]], sky)],
      ['interpolate', ['linear'], h, 0, blend(BUILDINGS.low, sky), 200, blend(BUILDINGS.tall, sky)],
    ]);
  }
  for (const id of ['subway-glow', 'rail-glow', 'bus-glow']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', (id === 'subway-glow' ? 0.32 : 0.18) * (1 - 0.5 * sky.day));
  }

  const night = 1 - sky.day;
  const up = s.altitudeDeg > 0;
  trainLayer.setLighting({
    // Below the horizon, light the trains from above like moonlight instead.
    sun: up ? sky.sun : [0.3, -0.4, 0.86],
    sunIntensity: up ? 0.7 + 1.6 * sky.day : 0.55,
    skyIntensity: 1.5 + 1.5 * sky.day,
    night,
  });
  document.body.dataset.weather = weather.kind;
}

function addLayers() {
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      layout: { visibility: flat() ? 'none' : 'visible' },
      paint: {
        'fill-extrusion-color': '#1e2a3e',
        // Buildings rise out of the ground as you zoom in.
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    firstLabel,
  );

  map.addSource('lines', { type: 'geojson', data: empty() });
  for (const kind of ['bus', 'rail', 'subway'] as const) {
    const width = { subway: [1.4, 4.5], rail: [0.9, 3], bus: [0.8, 2.6] }[kind];
    map.addLayer({
      id: `${kind}-glow`,
      type: 'line',
      source: 'lines',
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, width[0] * 3.5, 16, width[1] * 5.5],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 4, 16, 14],
        'line-opacity': kind === 'subway' ? 0.3 : 0.18,
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
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, width[0], 16, width[1]],
        'line-opacity': kind === 'subway' ? 0.95 : 0.75,
        // The Silver Line runs on streets: dashed, like a bus route.
        ...(kind === 'bus' ? { 'line-dasharray': [2, 1.5] } : {}),
      },
    });
  }

  // The speed map paints over the lines when it's on.
  map.addSource('speed', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'speed-glow',
    type: 'line',
    source: 'speed',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 6, 16, 30],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 4, 16, 16],
      'line-opacity': 0.35,
    },
  });
  map.addLayer({
    id: 'speed-lines',
    type: 'line',
    source: 'speed',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 2.2, 16, 7],
    },
  });

  map.addSource('bikes', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'bikes',
    type: 'circle',
    source: 'bikes',
    minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 4, 17, 10],
      'circle-color': ['case', ['==', ['get', 'total'], 0], '#ef4444', ['<=', ['get', 'total'], 2], '#f59e0b', '#38bdf8'],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 0.9],
      'circle-stroke-color': '#06111c',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 17, 2],
    },
  });
  map.addLayer({
    id: 'bike-counts',
    type: 'symbol',
    source: 'bikes',
    minzoom: 15.5,
    layout: {
      'text-field': ['to-string', ['get', 'total']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#06111c' },
  });

  map.addSource('stations', { type: 'geojson', data: empty() });
  // Silver Line stops only appear once you're close in.
  const busFade = (on: number) => ['interpolate', ['linear'], ['zoom'], 13, ['case', ['get', 'bus'], 0, on], 14, on];
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['case', ['any', ['get', 'rail'], ['get', 'bus']], 1.5, 2],
        16,
        ['case', ['any', ['get', 'rail'], ['get', 'bus']], 4.5, 6],
      ],
      'circle-color': '#090c13',
      'circle-stroke-color': ['case', ['get', 'rail'], '#c78bbd', ['get', 'bus'], '#aab5be', '#eef2f7'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2.5],
      'circle-opacity': busFade(1) as any,
      'circle-stroke-opacity': busFade(1) as any,
    },
  });

  // A ring that ripples out from a station as a train pulls in.
  map.addSource('arrivals', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'arrivals',
    type: 'circle',
    source: 'arrivals',
    paint: {
      'circle-radius': ['*', ['get', 't'], ['interpolate', ['linear'], ['zoom'], 11, 18, 16, 60]],
      'circle-color': 'transparent',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['*', ['-', 1, ['get', 't']], 3],
      'circle-stroke-opacity': ['-', 1, ['get', 't']],
      'circle-pitch-alignment': 'map',
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
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 16, 13],
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#c9d4e3',
      'text-halo-color': '#090c13',
      'text-halo-width': 1.6,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, ['case', ['get', 'bus'], 0, 1], 15.5, 1],
    },
  });

  map.addImage('vehicle', vehicleIcon(), { sdf: true, pixelRatio: 2 });
  map.addSource('vehicles', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'vehicles',
    type: 'symbol',
    source: 'vehicles',
    maxzoom: 15.5,
    layout: {
      'icon-image': 'vehicle',
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['any', ['get', 'rail'], ['get', 'bus']], 0.5, 0.6],
        14,
        0.95,
      ],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': [
        'case',
        ['get', 'selected'],
        '#ffffff',
        ['get', 'followed'],
        '#ffd166',
        'rgba(255,255,255,0.75)',
      ],
      'icon-halo-width': ['case', ['any', ['get', 'selected'], ['get', 'followed']], 2.5, 1],
      // The 3D trains take over as you zoom in.
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 14, 1, 15, 0],
    },
  });
  applyLayerToggles();
}

/** A teardrop that points up (north), drawn as an SDF so each line can tint it. */
function vehicleIcon(): ImageData {
  const size = 64;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = ctx.canvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(32, 38, 15, 0, Math.PI * 2);
  ctx.moveTo(32, 8);
  ctx.lineTo(47, 32);
  ctx.lineTo(17, 32);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
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
      properties: { id: s.id, name: s.name, rail: s.rail, bus: s.bus },
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
    renderDock();
    if (selection?.kind === 'dock') renderPanel();
  } catch (err) {
    console.error(err);
  }
}

/** Shows or hides the optional layers, and dims the lines under the speed map. */
function applyLayerToggles() {
  if (!map.getLayer('speed-lines')) return;
  const vis = (on: boolean) => (on ? 'visible' : 'none');
  for (const id of ['speed-lines', 'speed-glow']) map.setLayoutProperty(id, 'visibility', vis(layers.speed));
  for (const id of ['bikes', 'bike-counts']) map.setLayoutProperty(id, 'visibility', vis(layers.bikes));
  for (const kind of ['bus', 'rail', 'subway']) {
    map.setPaintProperty(`${kind}-lines`, 'line-opacity', layers.speed ? 0.18 : kind === 'subway' ? 0.95 : 0.75);
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
    if (v.speed != null) t.speed = v.speed;
    else if (interval > 3000 && interval < 120_000) {
      const measured = Math.max(0, moved) / (interval / 1000);
      t.speed = t.speed == null ? measured : t.speed * 0.4 + measured * 0.6;
    }
    // Feed the speed map with runs between two moving reports.
    if (track && wasMoving && v.status !== 'STOPPED_AT' && interval > 5000 && interval < 120_000 && moved > 0) {
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
  const run = (speed * Math.min(ms, 90_000)) / 1000;
  return run >= limit - t.base ? { d: limit, vel: 0 } : { d: t.base + run, vel: speed };
}

/**
 * Moves the drawn train toward its estimate like a train would: a critically
 * damped follow with capped acceleration and braking, matched to the
 * estimate's own speed so it doesn't lag behind a moving target.
 */
function step(t: Train, now: number, dt: number) {
  const target = estimate(t, now);
  const err = target.d - t.d;
  if (err > 2500 || err < -800) {
    t.d = target.d;
    t.vel = target.vel;
    return;
  }
  const w = 1.2;
  const acc = Math.max(-3.5, Math.min(2.5, w * w * err + 2 * w * (target.vel - t.vel)));
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
    renderDock();
    if (layers.speed) drawSpeedMap();
    if (selection?.kind === 'train' || selection?.kind === 'following') renderPanel();
  } catch (err) {
    handleError(err, 'Can’t reach the MBTA right now, retrying');
  }
}

function handleError(err: unknown, message: string) {
  if (err instanceof RateLimited) {
    pausedUntil = err.retryAt;
    setNotice('MBTA rate limit reached, pausing for a moment');
  } else {
    console.error(err);
    setNotice(message);
  }
}

// ---------------------------------------------------------------------------
// Each frame: move the trains, lay out their cars and lights, drive the camera.

const frameCars: Car[] = [];
const carOwners: string[] = [];
const trailGlows: Glow[] = [];
const beamGlows: Glow[] = [];
const glowPool: Glow[] = [];
let frameCount = 0;
let lastFrame = performance.now();
const HEADLIGHT = new Color('#ffe2b0');

function glow(i: number) {
  return (glowPool[i] ??= { x: 0, y: 0, angle: 0, length: 0, width: 0, color: new Color() });
}

/**
 * Real scale vanishes when zoomed out (a six-car train is a few pixels at
 * zoom 14), so cars are drawn wider and longer the further out you are,
 * reaching true size at zoom 17.5.
 */
function exaggeration(zoom: number) {
  const k = Math.max(0, 17.5 - zoom);
  return { width: Math.min(10, 2 ** k), length: Math.min(3, 2 ** (k / 2)), height: Math.min(3.2, 2 ** (k / 2)) };
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
  const sway = 0.018 * Math.min(1, train.vel / 15);

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
      front: i === 0,
      rear: i === train.cars.length - 1,
      selected,
      followed: starred,
      roll: sway * Math.sin(now / 480 + train.phase + i * 0.8),
    });
    carOwners.push(train.v.id);
    offset += len + train.gap * s.length;
  });
  train.x = sumX / train.cars.length;
  train.y = sumY / train.cars.length;

  const width = (train.cars[0]?.width ?? 3) * s.width;
  // Headlights throw a pool of light ahead, brighter after dark.
  const night = 1 - sky.day;
  if (night > 0.05) {
    const g = glow(trailGlows.length + beamGlows.length);
    const reach = 34 * s.length;
    const fx = train.x + Math.cos(train.heading) * (half + reach / 2);
    const fy = train.y + Math.sin(train.heading) * (half + reach / 2);
    Object.assign(g, { x: fx, y: fy, angle: train.heading, length: reach, width: width * 2.4 });
    g.color.copy(HEADLIGHT).multiplyScalar(0.55 * night * (0.5 + 0.5 * Math.min(1, train.vel / 4 + 0.4)));
    beamGlows.push(g);
  }
  // A light trail along the track behind moving trains.
  if (train.track && train.vel > 1.5) {
    const strength = Math.min(1, train.vel / 14) * (0.55 + 0.45 * night);
    const tail = train.d - half;
    const spacing = 9 * s.length;
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    for (let j = 1; j <= 8; j++) {
      const dd = tail - j * spacing;
      train.track.at(dd, p);
      train.track.at(dd + spacing, q);
      const g = glow(trailGlows.length + beamGlows.length);
      Object.assign(g, {
        x: (p.x + q.x) / 2,
        y: (p.y + q.y) / 2,
        angle: Math.atan2(q.y - p.y, q.x - p.x),
        length: spacing * 1.8,
        width: width * (2.6 - j * 0.15),
      });
      g.color.copy(train.accent).multiplyScalar(0.5 * strength * (1 - j / 9));
      trailGlows.push(g);
    }
  }
}

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const zoom = map.getZoom();
  const s = exaggeration(zoom);
  frameCars.length = 0;
  carOwners.length = 0;
  trailGlows.length = 0;
  beamGlows.length = 0;
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

  const show3d = zoom >= 12.5;
  trainLayer.setCars(show3d ? frameCars : []);
  trainLayer.setGlows(show3d ? trailGlows : [], show3d ? beamGlows : []);
  // The icons only show when zoomed out; skip rebuilding them otherwise.
  if (zoom < 15.6 || frameCount % 30 === 0) drawIcons(selectedId);
  drawArrivals(now);
  driveCamera(now, dt);
  precipitation.frame(dt, map.getBearing(), now);
  map.triggerRepaint();
  frameCount++;
  requestAnimationFrame(frame);
}

function drawIcons(selectedId: string | null) {
  const features: GeoJSON.Feature[] = [];
  for (const t of trains.values()) {
    if (hidden.has(t.group)) continue;
    features.push({
      type: 'Feature',
      properties: {
        color: `#${t.accent.getHexString()}`,
        bearing: compass(t.heading),
        selected: t.v.id === selectedId,
        followed: isFollowed(t.v.id),
        rail: t.route.type === 2,
        bus: t.route.type === 3,
      },
      geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) },
    });
  }
  source('vehicles')?.setData({ type: 'FeatureCollection', features });
}

let arrivalsShown = false;
function drawArrivals(now: number) {
  const RIPPLE_MS = 2600;
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

function driveCamera(now: number, dt: number) {
  if (touring && now > tourNext) nextTourStop();
  // Left alone, the overview slowly circles the city.
  if (cameraMode === 'free' && !touring && !flat() && now - lastInteraction > IDLE_ORBIT_MS && !map.isEasing()) {
    map.setBearing(map.getBearing() + 1.6 * dt);
  }
  if (cameraMode === 'free' || selection?.kind !== 'train' || map.isEasing()) return;
  const t = trains.get(selection.id);
  if (!t) return;
  if (cameraMode === 'follow') {
    map.setCenter(toLngLat(t.x, t.y));
    return;
  }
  // Ride along: sit behind the train and turn with the track, smoothly.
  const target = compass(t.heading);
  const delta = ((target - rideBearing + 540) % 360) - 180;
  rideBearing = (rideBearing + delta * (1 - Math.exp(-dt / 0.8)) + 360) % 360;
  // Aim past the train so it sits in the lower part of the view.
  const ahead = 45;
  map.jumpTo({
    center: toLngLat(t.x + Math.cos(t.heading) * ahead, t.y + Math.sin(t.heading) * ahead),
    bearing: rideBearing,
  });
}

function setCameraMode(mode: CameraMode) {
  cameraMode = mode;
  const t = selection?.kind === 'train' ? trains.get(selection.id) : undefined;
  if (t && mode === 'ride') {
    rideBearing = compass(t.heading);
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
      zoom: Math.max(map.getZoom(), 15.5),
      pitch: flat() ? 0 : 55,
      duration: 1500,
    });
  }
  renderPanel();
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
  touring = on;
  $('#tour').setAttribute('aria-pressed', String(on));
  $('#tour .label').textContent = on ? 'Touring' : 'Tour';
  if (on) nextTourStop();
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
  setTouring(false);
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

// Dragging hands the camera back.
map.on('dragstart', () => {
  setTouring(false);
  if (cameraMode !== 'free') setCameraMode('free');
});
for (const type of ['mousedown', 'touchstart', 'wheel', 'keydown'] as const) {
  addEventListener(type, () => (lastInteraction = performance.now()), { passive: true });
}

// ---------------------------------------------------------------------------
// UI

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const panelEl = $('#panel');
const dockEl = $('#dock');
let notice: string | null = null;

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function setNotice(message: string | null) {
  notice = message;
  const el = $('#notice');
  el.hidden = !message;
  el.textContent = message ?? '';
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

function tick() {
  const parts = clockFmt.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  $('#clock').innerHTML = `${get('hour')}:${get('minute')}<span class="sec">:${get('second')}</span> <span class="ampm">${get('dayPeriod')}</span>`;

  const all = [...trains.values()];
  const rail = all.filter((t) => t.route.type === 2).length;
  const buses = all.filter((t) => t.route.type === 3).length;
  const secs = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
  $('#summary').innerHTML = !lastUpdate
    ? 'Connecting to the MBTA…'
    : `<strong>${all.length - rail - buses}</strong> subway · <strong>${rail}</strong> rail · <strong>${buses}</strong> SL <span class="dim">· ${
        secs! < 2 ? 'just now' : `${secs}s ago`
      }</span>`;

  // Live countdowns in the open panel.
  panelEl.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => {
    el.textContent = countdown(Number(el.dataset.at));
  });
  panelEl.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => {
    el.textContent = ago(Number(el.dataset.ago));
  });
  if (notice === null) $('#notice').hidden = true;
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
  const el = $('#conditions');
  const parts = [weather.tempF != null ? `${Math.round(weather.tempF)}°F` : '', weather.label].filter(Boolean);
  el.textContent = parts.join(' · ');
  el.hidden = !parts.length;
}

const BIKE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="11" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="11" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 11 6.5 6h4L12 11M6.5 6 8 11h0M9.5 4h2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GAUGE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 11a5.5 5.5 0 1 1 11 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 11 11 6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function renderDock() {
  const counts = new Map<string, number>();
  for (const t of trains.values()) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  const groups = GROUPS.map((g) => {
    const route = network && [...network.routes.values()].find(g.match);
    const c = route ? displayColor(route.color) : '#888';
    const off = hidden.has(g.id);
    return `<button class="chip${off ? ' off' : ''}" data-group="${g.id}" aria-pressed="${!off}" style="--c:${c}">
      <span class="dot"></span><span class="name">${g.label}</span><span class="count">${counts.get(g.id) ?? 0}</span>
    </button>`;
  }).join('');
  const bikes = docks.reduce((n, d) => n + d.bikes + d.ebikes, 0);
  dockEl.innerHTML = `${groups}<span class="divider" aria-hidden="true"></span>
    <button class="chip toggle${layers.speed ? ' on' : ''}" data-layer="speed" aria-pressed="${layers.speed}">${GAUGE_ICON}<span class="name">Speed map</span></button>
    <button class="chip toggle${layers.bikes ? ' on' : ''}" data-layer="bikes" aria-pressed="${layers.bikes}">${BIKE_ICON}<span class="name">Bluebikes</span>${
      layers.bikes && docks.length ? `<span class="count">${bikes}</span>` : ''
    }</button>`;
}

dockEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-group],[data-layer]');
  if (!btn) return;
  if (btn.dataset.layer) {
    const key = btn.dataset.layer as keyof typeof layers;
    layers[key] = !layers[key];
    save(LAYERS_KEY, layers);
    applyLayerToggles();
  } else {
    const g = btn.dataset.group!;
    if (hidden.has(g)) hidden.delete(g);
    else hidden.add(g);
    drawLines();
  }
  renderDock();
});

function renderSpeedLegend() {
  $('#speed-legend').innerHTML = `
    <span class="title">Measured speed</span>
    ${SPEED_SCALE.map(([mph, c], i) => {
      const next = SPEED_SCALE[i + 1]?.[0];
      return `<span class="step" style="--c:${c}">${next ? `${mph}–${next}` : `${mph}+`}</span>`;
    }).join('')}
    <span class="unit">mph</span>`;
}

// Selection and the side panel ---------------------------------------------

let upcoming: UpcomingStop[] | null = null;
let departures: Departure[] | null = null;
let refreshTimer: number | undefined;

function select(next: Selection, keepTour = false) {
  if (!keepTour) setTouring(false);
  if (next?.kind === selection?.kind && next?.id === selection?.id) return;
  backToFollowing = selection?.kind === 'following' && next?.kind === 'train';
  selection = next;
  upcoming = null;
  departures = null;
  clearInterval(refreshTimer);
  if (cameraMode !== 'free' && !keepTour) cameraMode = 'free';
  const hash = !next
    ? ''
    : next.kind === 'following'
      ? '#following'
      : next.kind === 'dock'
        ? ''
        : `#${next.kind}=${encodeURIComponent(next.id)}`;
  history.replaceState(null, '', hash || location.pathname + location.search);
  panelEl.hidden = !next;
  renderFollowingButton();
  updatePadding();
  if (!next) return;
  renderPanel();
  refreshPanelData();
  refreshTimer = window.setInterval(refreshPanelData, PANEL_REFRESH_MS);
  const place =
    next.kind === 'station'
      ? stations.find((st) => st.id === next.id)
      : next.kind === 'dock'
        ? docks.find((d) => d.id === next.id)
        : undefined;
  if (place) map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 15), duration: 1200 });
}

async function refreshPanelData() {
  if (document.hidden || !selection || selection.kind === 'following' || selection.kind === 'dock') return;
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
    if (selection === sel) renderPanel();
  } catch (err) {
    handleError(err, 'Couldn’t load arrival times');
  }
}

/** Keeps the map's center clear of the panel, so a followed train stays in view. */
function updatePadding() {
  const phone = matchMedia('(max-width: 720px)').matches;
  const open = !panelEl.hidden;
  const right = open && !phone ? panelEl.offsetWidth + 24 : 0;
  const bottom = open && phone ? panelEl.offsetHeight + 24 : 0;
  const now = map.getPadding();
  if (now.right === right && now.bottom === bottom) return;
  // Setting padding stops any camera animation, so wait for it to land.
  if (map.isEasing()) map.once('moveend', updatePadding);
  else map.setPadding({ top: 0, left: 0, right, bottom });
}

const STATUS_TEXT: Record<Vehicle['status'], string> = {
  IN_TRANSIT_TO: 'Next stop',
  INCOMING_AT: 'Arriving at',
  STOPPED_AT: 'Stopped at',
};

function renderPanel() {
  if (!selection) return;
  if (selection.kind === 'train') renderTrainPanel(selection.id);
  else if (selection.kind === 'station') renderStationPanel(selection.id);
  else if (selection.kind === 'dock') renderDockPanel(selection.id);
  else renderFollowingPanel();
  if (matchMedia('(max-width: 720px)').matches) updatePadding();
}

function vehicleLabel(t: Train) {
  if (t.route.type === 2 && t.v.tripName) return `Train ${t.v.tripName}`;
  return `${t.route.type === 3 ? 'Bus' : 'Car'} ${t.v.label}`;
}

function renderTrainPanel(id: string) {
  const t = trains.get(id);
  if (!t) return;
  const v = t.v;
  const rail = t.route.type === 2;
  const bus = t.route.type === 3;
  const color = `#${t.accent.getHexString()}`;
  const branch = v.routeId.startsWith('Green-') ? ` · ${v.routeId.slice(-1)} branch` : '';
  const destination = v.headsign ?? t.route.destinations[v.directionId] ?? '';
  const mph = t.speed != null && v.status !== 'STOPPED_AT' ? Math.round(t.speed * 2.237) : null;

  const carsHtml = t.cars
    .map((c, i) => `<span class="car${c === LOCOMOTIVE ? ' loco' : ''}${i === 0 ? ' lead' : ''}" style="flex:${c.length}"></span>`)
    .join('');

  let stopsHtml = '<p class="muted">Loading arrival times…</p>';
  if (upcoming && !upcoming.length) stopsHtml = '<p class="muted">No arrival times for this one right now.</p>';
  else if (upcoming)
    stopsHtml = `<ol class="timeline">${upcoming
      .slice(0, 7)
      .map((s) => `<li><span class="stop">${escape(s.name)}</span><time data-at="${s.at}">${countdown(s.at)}</time></li>`)
      .join('')}</ol>`;

  const starred = isFollowed(id);
  panelEl.style.setProperty('--c', color);
  // Light line colors (the Silver Line) need dark text on their buttons.
  const { r, g, b } = t.accent;
  panelEl.style.setProperty('--on-c', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0b0f17' : '#ffffff');
  panelEl.innerHTML = `
    ${backToFollowing ? '<button class="back" data-action="following">‹ Following</button>' : ''}
    <header>
      <div>
        <p class="eyebrow">${escape(t.route.name)}${branch}</p>
        <h2><span class="to">to</span> ${escape(destination)}</h2>
      </div>
      <div class="header-actions">
        <button class="star-btn" data-action="star" aria-pressed="${starred}" aria-label="${
          starred ? 'Stop following' : 'Follow'
        }" title="${starred ? 'Following: tap to stop' : 'Follow: saves it to your Following tab'}">${starred ? '★' : '☆'}</button>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </div>
    </header>
    <div class="facts">
      <div><span class="k">${STATUS_TEXT[v.status] ?? 'Now'}</span><span class="v">${escape(v.stopName ?? '—')}</span></div>
      <div><span class="k">Speed</span><span class="v">${v.status === 'STOPPED_AT' ? 'Stopped' : mph != null ? `${mph} mph` : '—'}</span></div>
      <div><span class="k">${escape(vehicleLabel(t))}</span><span class="v">${
        bus ? 'Articulated' : `${t.cars.length} cars${t.estimated ? '*' : ''}`
      }</span></div>
    </div>
    <div class="consist" aria-hidden="true">${carsHtml}</div>
    <div class="actions">
      <button class="primary" data-action="ride" aria-pressed="${cameraMode === 'ride'}">${cameraMode === 'ride' ? 'Riding along' : 'Ride along'}</button>
      <button data-action="follow" aria-pressed="${cameraMode === 'follow'}">Keep in view</button>
    </div>
    <h3>Next stops</h3>
    ${stopsHtml}
    <p class="fine">Position reported <span data-ago="${v.updatedAt}">${ago(v.updatedAt)}</span>${
      t.estimated ? ` · *${rail ? 'commuter rail doesn’t report its consist; typical shown' : 'consist not reported; typical shown'}` : ''
    }${t.track ? '' : ' · off its usual route'}</p>
  `;
}

function renderStationPanel(id: string) {
  const s = stations.find((st) => st.id === id);
  if (!s || !network) return;
  panelEl.style.setProperty('--c', s.rail ? displayColor('#80276C') : s.bus ? displayColor('#7C878E') : '#e6edf3');

  let body = '<p class="muted">Loading departures…</p>';
  if (departures && !departures.length) body = '<p class="muted">Nothing predicted here right now.</p>';
  else if (departures) {
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
      ? `<ul class="board">${[...groups.values()]
          .slice(0, 10)
          .map((g) => {
            const first = g.deps[0];
            const live = first.vehicleId && trains.has(first.vehicleId);
            const line = g.route.type === 2 ? g.route.name : g.route.type === 3 ? g.route.short : g.route.name.replace(' Line', '');
            return `<li style="--c:${displayColor(g.route.color)}">
          <button ${live ? `data-train="${escape(first.vehicleId!)}"` : 'disabled'}>
            <span class="bar"></span>
            <span class="dest"><small>${escape(line)}</small>${escape(g.headsign)}</span>
            <span class="times"><time data-at="${first.at}">${countdown(first.at)}</time>${g.deps
              .slice(1, 3)
              .map((d) => `<small data-at="${d.at}">${countdown(d.at)}</small>`)
              .join('')}</span>
          </button>
        </li>`;
          })
          .join('')}</ul>`
      : '<p class="muted">Nothing predicted here right now.</p>';
  }

  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">${s.rail ? 'Commuter rail station' : s.bus ? 'Silver Line stop' : 'Station'}</p>
        <h2>${escape(s.name)}</h2>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    <h3>Departures</h3>
    ${body}
    <p class="fine">Live MBTA predictions · tap a train to jump to it</p>
  `;
}

function renderDockPanel(id: string) {
  const d = docks.find((x) => x.id === id);
  if (!d) return;
  panelEl.style.setProperty('--c', '#38bdf8');
  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">Bluebikes</p>
        <h2>${escape(d.name)}</h2>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    <div class="bike-stats">
      <div><span class="n">${d.bikes}</span><span class="k">Classic bikes</span></div>
      <div><span class="n">${d.ebikes}</span><span class="k">E-bikes</span></div>
      <div><span class="n">${d.docks}</span><span class="k">Open docks</span></div>
    </div>
    ${d.renting ? '' : '<p class="muted">Not renting right now.</p>'}
    <p class="fine">${d.capacity} docks · reported <span data-ago="${d.reportedAt}">${ago(d.reportedAt)}</span> · updates every minute</p>
  `;
}

function describeStatus(t: Train) {
  const v = t.v;
  const where = escape(v.stopName ?? 'its next stop');
  if (v.status === 'STOPPED_AT') return `Stopped at ${where}`;
  if (v.status === 'INCOMING_AT') return `Arriving at ${where}`;
  return `Heading to ${where}`;
}

function renderFollowingPanel() {
  panelEl.style.setProperty('--c', '#ffd166');
  const rows = followed.map((f) => {
    const t = trains.get(f.id);
    const route = network?.routes.get(t?.v.routeId ?? f.routeId);
    const c = route ? displayColor(route.color) : '#888';
    const lineName = escape(route?.name ?? f.routeId);
    if (!t) {
      return `<li style="--c:${c}">
        <button disabled>
          <span class="bar"></span>
          <span class="dest"><small>${lineName} · ${escape(f.label)}</small>Not running right now<span class="sub">It'll show up here when it's back in service</span></span>
        </button>
        <button class="unfollow" data-unfollow="${escape(f.id)}" aria-label="Stop following">✕</button>
      </li>`;
    }
    const mph = t.speed != null && t.v.status !== 'STOPPED_AT' ? `${Math.round(t.speed * 2.237)} mph` : '';
    return `<li style="--c:${c}">
      <button data-train="${escape(f.id)}">
        <span class="bar"></span>
        <span class="dest"><small>${lineName} · ${escape(vehicleLabel(t))}</small>to ${escape(
          t.v.headsign ?? t.route.destinations[t.v.directionId] ?? '',
        )}<span class="sub">${describeStatus(t)}</span></span>
        <span class="times"><time>${mph || (t.v.status === 'STOPPED_AT' ? 'Stopped' : '')}</time><small data-ago="${t.v.updatedAt}">${ago(
          t.v.updatedAt,
        )}</small></span>
      </button>
      <button class="unfollow" data-unfollow="${escape(f.id)}" aria-label="Stop following">✕</button>
    </li>`;
  });

  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">Your trains</p>
        <h2>Following</h2>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    ${
      rows.length
        ? `<ul class="board following">${rows.join('')}</ul>`
        : '<p class="muted empty">Tap the <strong>☆</strong> on any train and it’ll live here, with where it is right now. Followed trains glow gold on the map.</p>'
    }
    <p class="fine">Saved on this device</p>
  `;
}

function toggleFollow(id: string) {
  if (isFollowed(id)) followed = followed.filter((f) => f.id !== id);
  else {
    const t = trains.get(id);
    if (!t) return;
    followed = [...followed, { id, routeId: t.v.routeId, label: vehicleLabel(t) }];
  }
  save(FOLLOWING_KEY, followed);
  renderFollowingButton();
  renderPanel();
}

function renderFollowingButton() {
  const badge = $('#following-btn .badge');
  badge.textContent = String(followed.length);
  badge.hidden = !followed.length;
  $('#following-btn').setAttribute('aria-pressed', String(selection?.kind === 'following'));
}

panelEl.addEventListener('click', (e) => {
  const unfollow = (e.target as HTMLElement).closest<HTMLElement>('[data-unfollow]');
  if (unfollow) {
    toggleFollow(unfollow.dataset.unfollow!);
    return;
  }
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-train]');
  if (!el) return;
  if (el.dataset.train) {
    select({ kind: 'train', id: el.dataset.train });
    setCameraMode('follow');
    return;
  }
  const action = el.dataset.action;
  if (action === 'close') select(null);
  if (action === 'star' && selection?.kind === 'train') toggleFollow(selection.id);
  if (action === 'following') select({ kind: 'following' });
  if (action === 'ride') setCameraMode(cameraMode === 'ride' ? 'free' : 'ride');
  if (action === 'follow') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
});

$('#tour').addEventListener('click', () => setTouring(!touring));
$('#following-btn').addEventListener('click', () =>
  select(selection?.kind === 'following' ? null : { kind: 'following' }),
);

function applyViewMode(animate: boolean) {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === viewMode));
  });
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

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.view === viewMode) return;
    viewMode = b.dataset.view as ViewMode;
    save(VIEW_KEY, viewMode);
    applyViewMode(true);
  }),
);

$('#overview').addEventListener('click', () => {
  setTouring(false);
  select(null);
  cameraMode = 'free';
  map.fitBounds(OVERVIEW, { pitch: flat() ? 0 : 50, bearing: flat() ? 0 : -18, duration: 2000, padding: 40 });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

// ---------------------------------------------------------------------------
// Start

async function refreshWeather() {
  const forced = weatherOverride();
  try {
    weather = forced ?? (await loadWeather());
  } catch (err) {
    // Weather is a nicety; without it the city is simply clear.
    console.warn(err);
  }
  precipitation.set(weather);
  renderConditions();
  applySky();
}

map.on('load', async () => {
  addLayers();
  applySky();
  requestAnimationFrame(frame);
  // Credits start folded into the ⓘ button so they don't sit under the dock.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  if (flat()) applyViewMode(false);
  else if (!deepLink) {
    // The intro: sweep in from over the harbor to the whole system, tilting into 3D.
    const cam = map.cameraForBounds(OVERVIEW, { padding: 40 });
    if (cam) map.flyTo({ ...cam, pitch: 52, bearing: -18, duration: 6000, curve: 1.25, essential: true });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === viewMode));
  });
  renderDock();
  renderFollowingButton();
  renderSpeedLegend();
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
      handleError(err, 'Couldn’t load the map of the T, retrying');
      const wait = err instanceof RateLimited ? err.retryAt - Date.now() : 2000 * 2 ** Math.min(attempt, 4);
      await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
    }
  }
  drawLines();
  drawStations();
  renderDock();
  await poll();
  setInterval(poll, POLL_MS);

  openFromHash();
  // A link pasted into an open tab only changes the hash; follow it too.
  window.addEventListener('hashchange', openFromHash);
});

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
    select({ kind: 'following' });
  }
}

setInterval(tick, 1000);
tick();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastUpdate > POLL_MS) poll();
});
