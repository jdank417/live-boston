import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { Color } from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
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
import { TrainLayer, type Car } from './trains3d';

const POLL_MS = 12_000;
const PANEL_REFRESH_MS = 20_000;
const TOUR_MS = 25_000;
/** Reports this old are trains the MBTA has lost track of; leave them off. */
const STALE_MS = 10 * 60_000;

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
  { id: 'CR', label: 'Commuter Rail', match: (r) => r.type === 2 },
];
const groupOf = (r: Route) => GROUPS.find((g) => g.match(r))?.id ?? r.id;

/** Brand colors, with the two darkest brightened so they hold up on a dark map. */
const ON_DARK: Record<string, string> = {
  '#003DA5': '#2f78ff', // Blue Line
  '#80276C': '#b545a3', // Commuter Rail
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
const GAP = 1.2;

/** The consist to draw, and whether its size is a typical one rather than reported. */
function consist(route: Route, reported: number | null): { cars: CarSpec[]; estimated: boolean } {
  if (route.type === 2) {
    // Commuter rail doesn't report its consist; draw a typical push-pull set.
    return { cars: [LOCOMOTIVE, ...Array(6).fill(BILEVEL)], estimated: true };
  }
  const spec = CARS[groupOf(route)] ?? CARS.Red;
  const n = reported ?? spec.usual;
  return { cars: Array(n).fill(spec), estimated: reported == null };
}

// ---------------------------------------------------------------------------
// Map

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  bounds: [
    [-71.13, 42.31],
    [-71.0, 42.4],
  ],
  maxPitch: 78,
  attributionControl: { compact: true, customAttribution: 'Live data © MBTA' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
// The style asks for a few pattern images it doesn't ship; stand in a blank one.
map.on('styleimagemissing', (e) => {
  if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

const trainLayer = new TrainLayer();

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
  length: number;
  bodies: Color[];
  accent: Color;
  /** Along-track glide from one report to the next. */
  from: number;
  to: number;
  start: number;
  dur: number;
  d: number;
  /** Fallback when a train is off its shape: a straight glide and the reported bearing. */
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  speed: number | null;
  /** How far the last report was from the track, in meters. */
  off: number;
  /** Filled in each frame. */
  x: number;
  y: number;
  heading: number;
}

const trains = new Map<string, Train>();
if (import.meta.env.DEV) Object.assign(window, { map, trains });
let lastUpdate = 0;
let pausedUntil = 0;
const colorCache = new Map<string, Color>();
const color = (hex: string) => {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new Color(hex)));
  return c;
};

type Selection = { kind: 'train'; id: string } | { kind: 'station'; id: string } | null;
let selection: Selection = null;
type CameraMode = 'free' | 'follow' | 'ride';
let cameraMode: CameraMode = 'free';
let rideBearing = 0;
let touring = false;
let tourNext = 0;

// ---------------------------------------------------------------------------
// Style

function restyleBasemap() {
  const paint: Record<string, [string, unknown]> = {
    background: ['background-color', '#090c13'],
    water: ['fill-color', '#0a1a2f'],
    waterway: ['line-color', '#0d2038'],
    landuse_park: ['fill-color', '#0c1612'],
    landcover_wood: ['fill-color', '#0c1612'],
    landuse_residential: ['fill-color', '#0b0f17'],
    building: ['fill-color', '#0e131c'],
    highway_minor: ['line-color', '#151b26'],
    highway_major_inner: ['line-color', '#121925'],
    highway_major_casing: ['line-color', 'rgba(70,88,120,0.45)'],
    highway_major_subtle: ['line-color', '#1b2331'],
    highway_motorway_casing: ['line-color', 'rgba(90,110,150,0.5)'],
    highway_motorway_subtle: ['line-color', '#1a2230'],
  };
  for (const [id, [prop, value]] of Object.entries(paint)) {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  }
  map.setSky({
    'sky-color': '#0a1324',
    'horizon-color': '#1c2d4d',
    'fog-color': '#090c13',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.85,
  });
  map.setLight({ anchor: 'viewport', color: '#c9d6ff', intensity: 0.32 });
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
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 0],
          0,
          '#141b28',
          60,
          '#1e2a3e',
          200,
          '#2d3f5e',
        ],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.88,
      },
    },
    firstLabel,
  );

  map.addSource('lines', { type: 'geojson', data: empty() });
  for (const kind of ['rail', 'subway'] as const) {
    const wide = kind === 'subway';
    map.addLayer({
      id: `${kind}-glow`,
      type: 'line',
      source: 'lines',
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, wide ? 5 : 3, 16, wide ? 26 : 16],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 4, 16, 14],
        'line-opacity': wide ? 0.3 : 0.18,
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
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, wide ? 1.4 : 0.9, 16, wide ? 4.5 : 3],
        'line-opacity': wide ? 0.95 : 0.75,
      },
    });
  }

  map.addSource('stations', { type: 'geojson', data: empty() });
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
        ['case', ['get', 'rail'], 1.5, 2],
        16,
        ['case', ['get', 'rail'], 5, 6],
      ],
      'circle-color': '#090c13',
      'circle-stroke-color': ['case', ['get', 'rail'], '#c78bbd', '#eef2f7'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2.5],
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
    paint: { 'text-color': '#c9d4e3', 'text-halo-color': '#090c13', 'text-halo-width': 1.6 },
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
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['get', 'rail'], 0.5, 0.6], 14, 0.95],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': ['case', ['get', 'selected'], '#ffffff', 'rgba(255,255,255,0.75)'],
      'icon-halo-width': ['case', ['get', 'selected'], 2.5, 1],
      // The 3D trains take over as you zoom in.
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 14, 1, 15, 0],
    },
  });
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

function drawLines() {
  if (!network) return;
  const features: GeoJSON.Feature[] = [];
  for (const [routeId, shapeIds] of network.routeShapes) {
    const route = network.routes.get(routeId)!;
    if (hidden.has(groupOf(route))) continue;
    for (const id of shapeIds) {
      features.push({
        type: 'Feature',
        properties: { color: displayColor(route.color), kind: route.type === 2 ? 'rail' : 'subway' },
        geometry: { type: 'LineString', coordinates: network.shapes.get(id)! },
      });
    }
  }
  source('lines')?.setData({ type: 'FeatureCollection', features });
}

function drawStations() {
  source('stations')?.setData({
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, rail: s.rail },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    })),
  });
}

// ---------------------------------------------------------------------------
// Trains: each report is snapped onto the trip's own shape, and the train
// glides along the track (not in a straight line) to its new position.

function trackFor(v: Vehicle, route: Route): Track | undefined {
  if (!network) return;
  const ids = v.shapeId && network.shapes.has(v.shapeId) ? [v.shapeId] : (network.routeShapes.get(route.id) ?? []);
  let best: Track | undefined;
  let bestOff = Infinity;
  const [x, y] = toLocal(v.lng, v.lat);
  for (const id of ids) {
    let t = tracks.get(id);
    if (!t) tracks.set(id, (t = new Track(network.shapes.get(id)!)));
    const off = t.project(x, y).off;
    if (off < bestOff) [best, bestOff] = [t, off];
  }
  // More than this far from the rails means a yard move or a bad fix.
  return bestOff < 250 ? best : undefined;
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
  const snapped = track?.project(x, y, sameTrip ? existing.to : undefined);

  if (!existing || !sameTrip || existing.track !== track) {
    const { cars, estimated } = consist(route, v.carriages);
    const accent = color(displayColor(route.color));
    const d = snapped?.d ?? 0;
    // Face along the track from the first report; commuter rail has no bearing.
    let heading = ((90 - (v.bearing ?? 0)) * Math.PI) / 180;
    if (track) {
      const a = track.at(d + 10);
      const b = track.at(d - 10);
      heading = Math.atan2(a.y - b.y, a.x - b.x);
    }
    trains.set(v.id, {
      v,
      route,
      group: groupOf(route),
      track,
      cars,
      estimated,
      length: cars.reduce((sum, c) => sum + c.length + GAP, -GAP),
      bodies: cars.map((c) => color(c.body)),
      accent,
      from: d,
      to: d,
      start: now,
      dur: 1,
      d,
      fx: existing?.x ?? x,
      fy: existing?.y ?? y,
      tx: x,
      ty: y,
      speed: v.speed,
      off: snapped?.off ?? Infinity,
      x,
      y,
      heading,
    });
    return;
  }

  const t = existing;
  const interval = v.updatedAt - t.v.updatedAt;
  if (snapped) {
    const moved = snapped.d - t.to;
    // Speed from the MBTA when it has one, otherwise from distance along the track.
    t.speed = v.speed ?? (interval > 3000 && interval < 120_000 ? Math.max(0, moved) / (interval / 1000) : t.speed);
    if (moved > -40 || moved < -1500) {
      t.from = t.d;
      t.to = snapped.d;
      t.start = now;
      t.dur = Math.min(15_000, Math.max(4000, interval || POLL_MS));
    }
    // A small step backwards is position noise; hold rather than reverse.
  } else {
    t.fx = t.x;
    t.fy = t.y;
    t.tx = x;
    t.ty = y;
    t.start = now;
    t.dur = POLL_MS;
  }
  t.off = snapped?.off ?? Infinity;
  t.v = v;
}

async function poll() {
  if (!network || document.hidden || Date.now() < pausedUntil) return;
  try {
    const vehicles = await loadVehicles();
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
    if (selection?.kind === 'train') renderPanel();
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
// Each frame: lay the cars out along the track and drive the camera.

const frameCars: Car[] = [];
const carOwners: string[] = [];
let frameCount = 0;

/**
 * Real scale vanishes when zoomed out (a six-car train is a few pixels at
 * zoom 14), so cars are drawn wider and longer the further out you are,
 * reaching true size at zoom 17.5.
 */
function exaggeration(zoom: number) {
  const k = Math.max(0, 17.5 - zoom);
  return { width: Math.min(10, 2 ** k), length: Math.min(3, 2 ** (k / 2)), height: Math.min(3.2, 2 ** (k / 2)) };
}

function layout(train: Train, s: ReturnType<typeof exaggeration>, selected: boolean) {
  const front = { x: 0, y: 0 };
  const back = { x: 0, y: 0 };
  const half = (train.length * s.length) / 2;
  let offset = 0;
  let sumX = 0;
  let sumY = 0;
  let angle = train.heading;

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
    });
    carOwners.push(train.v.id);
    offset += len + GAP * s.length;
  });
  train.x = sumX / train.cars.length;
  train.y = sumY / train.cars.length;
}

function frame() {
  const now = performance.now();
  const zoom = map.getZoom();
  const s = exaggeration(zoom);
  frameCars.length = 0;
  carOwners.length = 0;
  const selectedId = selection?.kind === 'train' ? selection.id : null;

  for (const t of trains.values()) {
    const k = Math.min(1, (now - t.start) / t.dur);
    if (t.track) {
      t.d = t.from + (t.to - t.from) * k;
    } else {
      t.x = t.fx + (t.tx - t.fx) * k;
      t.y = t.fy + (t.ty - t.fy) * k;
      if (t.v.bearing != null) t.heading = ((90 - t.v.bearing) * Math.PI) / 180;
    }
    if (hidden.has(t.group)) continue;
    layout(t, s, t.v.id === selectedId);
  }

  trainLayer.setCars(zoom >= 12.5 ? frameCars : []);
  // The icons only show when zoomed out; skip rebuilding them otherwise.
  if (zoom < 15.6 || frameCount % 30 === 0) drawIcons(selectedId);
  driveCamera(now);
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
        rail: t.route.type === 2,
      },
      geometry: { type: 'Point', coordinates: toLngLat(t.x, t.y) },
    });
  }
  source('vehicles')?.setData({ type: 'FeatureCollection', features });
}

let lastCameraFrame = 0;

function driveCamera(now: number) {
  const dt = Math.min(0.25, (now - (lastCameraFrame || now)) / 1000);
  lastCameraFrame = now;
  if (touring && now > tourNext) nextTourStop();
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
  // Ease toward the track's heading over about a second, whatever the frame rate.
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
      pitch: 72,
      bearing: rideBearing,
      duration: 2200,
      essential: true,
    });
  } else if (t && mode === 'follow') {
    map.easeTo({ center: toLngLat(t.x, t.y), zoom: Math.max(map.getZoom(), 15.5), pitch: 55, duration: 1500 });
  }
  renderPanel();
}

// Tour: ride a random moving train for a while, then hop to another.
function nextTourStop() {
  const moving = [...trains.values()].filter(
    (t) => !hidden.has(t.group) && t.v.status !== 'STOPPED_AT' && (t.speed ?? 1) > 2 && t.track,
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

map.on('click', (e) => {
  const train = trainAt(e.point);
  if (train) {
    setTouring(false);
    select({ kind: 'train', id: train });
    return;
  }
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [e.point.x - 8, e.point.y - 8],
    [e.point.x + 8, e.point.y + 8],
  ];
  const station = map.queryRenderedFeatures(box, { layers: ['stations'] })[0];
  if (station) {
    setTouring(false);
    select({ kind: 'station', id: String(station.properties.id) });
    return;
  }
  select(null);
});

// Hit-testing every car is too much for every mouse event; once a frame is plenty.
let hoverQueued = false;
map.on('mousemove', (e) => {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    hover(e.point);
  });
});

function hover(point: maplibregl.Point) {
  const e = { point };
  const hit =
    trainAt(e.point) ||
    map.queryRenderedFeatures(
      [
        [e.point.x - 8, e.point.y - 8],
        [e.point.x + 8, e.point.y + 8],
      ],
      { layers: ['stations'] },
    ).length;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
}

// Dragging hands the camera back.
map.on('dragstart', () => {
  setTouring(false);
  if (cameraMode !== 'free') setCameraMode('free');
});

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
  const secs = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
  $('#summary').innerHTML = !lastUpdate
    ? 'Connecting to the MBTA…'
    : `<strong>${all.length - rail}</strong> subway · <strong>${rail}</strong> commuter rail <span class="dim">· ${secs! < 2 ? 'just now' : `${secs}s ago`}</span>`;

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

function renderDock() {
  const counts = new Map<string, number>();
  for (const t of trains.values()) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  dockEl.innerHTML = GROUPS.map((g) => {
    const route = network && [...network.routes.values()].find(g.match);
    const c = route ? displayColor(route.color) : '#888';
    const off = hidden.has(g.id);
    return `<button class="chip${off ? ' off' : ''}" data-group="${g.id}" aria-pressed="${!off}" style="--c:${c}">
      <span class="dot"></span><span class="name">${g.label}</span><span class="count">${counts.get(g.id) ?? 0}</span>
    </button>`;
  }).join('');
}

dockEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-group]');
  if (!btn) return;
  const g = btn.dataset.group!;
  if (hidden.has(g)) hidden.delete(g);
  else hidden.add(g);
  drawLines();
  renderDock();
});

// Selection and the side panel ---------------------------------------------

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
  if (cameraMode !== 'free' && !keepTour) cameraMode = 'free';
  history.replaceState(null, '', next ? `#${next.kind}=${encodeURIComponent(next.id)}` : location.pathname);
  panelEl.hidden = !next;
  updatePadding();
  if (!next) return;
  renderPanel();
  refreshPanelData();
  refreshTimer = window.setInterval(refreshPanelData, PANEL_REFRESH_MS);
  if (next.kind === 'station') {
    const s = stations.find((st) => st.id === next.id);
    if (s) map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15), duration: 1200 });
  }
}

async function refreshPanelData() {
  if (document.hidden || !selection) return;
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
  else renderStationPanel(selection.id);
  if (matchMedia('(max-width: 720px)').matches) updatePadding();
}

function renderTrainPanel(id: string) {
  const t = trains.get(id);
  if (!t) return;
  const v = t.v;
  const rail = t.route.type === 2;
  const color = `#${t.accent.getHexString()}`;
  const branch = v.routeId.startsWith('Green-') ? ` · ${v.routeId.slice(-1)} branch` : '';
  const destination = v.headsign ?? t.route.destinations[v.directionId] ?? '';
  const number = rail && v.tripName ? `Train ${v.tripName}` : `Car ${v.label}`;
  const mph = t.speed != null && v.status !== 'STOPPED_AT' ? Math.round(t.speed * 2.237) : null;

  const carsHtml = t.cars
    .map((c, i) => `<span class="car${c === LOCOMOTIVE ? ' loco' : ''}${i === 0 ? ' lead' : ''}" style="flex:${c.length}"></span>`)
    .join('');

  let stopsHtml = '<p class="muted">Loading arrival times…</p>';
  if (upcoming && !upcoming.length) stopsHtml = '<p class="muted">No arrival times for this train right now.</p>';
  else if (upcoming)
    stopsHtml = `<ol class="timeline">${upcoming
      .slice(0, 7)
      .map((s) => `<li><span class="stop">${escape(s.name)}</span><time data-at="${s.at}">${countdown(s.at)}</time></li>`)
      .join('')}</ol>`;

  panelEl.style.setProperty('--c', color);
  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">${escape(t.route.name)}${branch}</p>
        <h2><span class="to">to</span> ${escape(destination)}</h2>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    <div class="facts">
      <div><span class="k">${STATUS_TEXT[v.status] ?? 'Now'}</span><span class="v">${escape(v.stopName ?? '—')}</span></div>
      <div><span class="k">Speed</span><span class="v">${v.status === 'STOPPED_AT' ? 'Stopped' : mph != null ? `${mph} mph` : '—'}</span></div>
      <div><span class="k">${escape(number)}</span><span class="v">${t.cars.length} cars${t.estimated ? '*' : ''}</span></div>
    </div>
    <div class="consist" aria-hidden="true">${carsHtml}</div>
    <div class="actions">
      <button class="primary" data-action="ride" aria-pressed="${cameraMode === 'ride'}">${cameraMode === 'ride' ? 'Riding along' : 'Ride along'}</button>
      <button data-action="follow" aria-pressed="${cameraMode === 'follow'}">Follow</button>
    </div>
    <h3>Next stops</h3>
    ${stopsHtml}
    <p class="fine">Position reported <span data-ago="${v.updatedAt}">${ago(v.updatedAt)}</span>${
      t.estimated ? ` · *${rail ? 'commuter rail doesn’t report its consist; typical shown' : 'consist not reported; typical shown'}` : ''
    }${t.track ? '' : ' · off its usual track'}</p>
  `;
}

function renderStationPanel(id: string) {
  const s = stations.find((st) => st.id === id);
  if (!s || !network) return;
  panelEl.style.setProperty('--c', s.rail ? displayColor('#80276C') : '#e6edf3');

  let body = '<p class="muted">Loading departures…</p>';
  if (departures && !departures.length) body = '<p class="muted">No trains predicted here right now.</p>';
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
    body = `<ul class="board">${[...groups.values()]
      .slice(0, 10)
      .map((g) => {
        const first = g.deps[0];
        const live = first.vehicleId && trains.has(first.vehicleId);
        return `<li style="--c:${displayColor(g.route.color)}">
          <button ${live ? `data-train="${escape(first.vehicleId!)}"` : 'disabled'}>
            <span class="bar"></span>
            <span class="dest"><small>${escape(g.route.type === 2 ? g.route.name : g.route.name.replace(' Line', ''))}</small>${escape(g.headsign)}</span>
            <span class="times"><time data-at="${first.at}">${countdown(first.at)}</time>${g.deps
              .slice(1, 3)
              .map((d) => `<small data-at="${d.at}">${countdown(d.at)}</small>`)
              .join('')}</span>
          </button>
        </li>`;
      })
      .join('')}</ul>`;
  }

  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">${s.rail ? 'Commuter rail station' : 'Station'}</p>
        <h2>${escape(s.name)}</h2>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    <h3>Departures</h3>
    ${body}
    <p class="fine">Live MBTA predictions · tap a train to jump to it</p>
  `;
}

panelEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-train]');
  if (!el) return;
  if (el.dataset.train) {
    select({ kind: 'train', id: el.dataset.train });
    setCameraMode('follow');
    return;
  }
  const action = el.dataset.action;
  if (action === 'close') select(null);
  if (action === 'ride') setCameraMode(cameraMode === 'ride' ? 'free' : 'ride');
  if (action === 'follow') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
});

$('#tour').addEventListener('click', () => setTouring(!touring));
$('#overview').addEventListener('click', () => {
  setTouring(false);
  select(null);
  cameraMode = 'free';
  map.fitBounds(
    [
      [-71.13, 42.31],
      [-71.0, 42.4],
    ],
    { pitch: 50, bearing: -18, duration: 2000, padding: 40 },
  );
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

// ---------------------------------------------------------------------------
// Start

map.on('load', async () => {
  restyleBasemap();
  addLayers();
  requestAnimationFrame(frame);
  // Credits start folded into the ⓘ button so they don't sit under the dock.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  if (!location.hash) map.easeTo({ pitch: 52, bearing: -18, duration: 3000 });
  renderDock();

  try {
    [network, stations] = await Promise.all([loadNetwork(), loadStations()]);
  } catch (err) {
    handleError(err, 'Couldn’t load the map of the T. Reload to try again.');
    return;
  }
  drawLines();
  drawStations();
  await poll();
  setInterval(poll, POLL_MS);

  const hash = new URLSearchParams(location.hash.slice(1));
  const trainId = hash.get('train');
  const stationId = hash.get('station');
  if (trainId && trains.has(trainId)) {
    select({ kind: 'train', id: trainId });
    setCameraMode('ride');
  } else if (stationId && stations.some((s) => s.id === stationId)) {
    select({ kind: 'station', id: stationId });
  }
});

setInterval(tick, 1000);
tick();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastUpdate > POLL_MS) poll();
});
