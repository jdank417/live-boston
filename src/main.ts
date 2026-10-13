import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  loadLines,
  loadStations,
  loadUpcomingStops,
  loadVehicles,
  RateLimited,
  type Line,
  type UpcomingStop,
  type Vehicle,
} from './mbta';

const POLL_MS = 12_000;
const PREDICTIONS_MS = 20_000;

// The legend groups the four Green Line branches into one entry.
const GROUPS = [
  { id: 'Red', label: 'Red', routes: ['Red'] },
  { id: 'Orange', label: 'Orange', routes: ['Orange'] },
  { id: 'Blue', label: 'Blue', routes: ['Blue'] },
  { id: 'Green', label: 'Green', routes: ['Green-B', 'Green-C', 'Green-D', 'Green-E'] },
  { id: 'Mattapan', label: 'Mattapan', routes: ['Mattapan'] },
];
const groupOf = (routeId: string) => GROUPS.find((g) => g.routes.includes(routeId))?.id ?? routeId;

const STATUS_TEXT: Record<Vehicle['status'], string> = {
  IN_TRANSIT_TO: 'Heading to',
  INCOMING_AT: 'Arriving at',
  STOPPED_AT: 'Stopped at',
};

// ---------------------------------------------------------------------------
// Map

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  // Downtown and the inner ends of every line; the intro then tilts into 3D.
  bounds: [
    [-71.13, 42.31],
    [-71.0, 42.4],
  ],
  maxPitch: 75,
  attributionControl: { compact: true, customAttribution: 'Live data © MBTA' },
});
if (import.meta.env.DEV) Object.assign(window, { map });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
// The style asks for a few pattern images it doesn't ship; stand in a blank one.
map.on('styleimagemissing', (e) => {
  if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

// ---------------------------------------------------------------------------
// State

let lines: Line[] = [];
const lineById = new Map<string, Line>();
const hidden = new Set<string>();

interface Animated {
  vehicle: Vehicle;
  from: [number, number];
  to: [number, number];
  /** When the glide from `from` to `to` started. */
  start: number;
  shown: [number, number];
}
const fleet = new Map<string, Animated>();
let selectedId: string | null = null;
let following = false;
let lastUpdate = 0;
let pausedUntil = 0;

// ---------------------------------------------------------------------------
// Layers

/** A teardrop that points up (north), drawn as an SDF so each line can tint it. */
function vehicleIcon(): ImageData {
  const size = 64;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = ctx.canvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(32, 38, 17, 0, Math.PI * 2);
  ctx.moveTo(32, 4);
  ctx.lineTo(49, 32);
  ctx.lineTo(15, 32);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function addLayers() {
  // The dark style ships flat buildings; raise them into 3D.
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#1b2230', 120, '#2c3a52'],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.8,
      },
    },
    firstLabel,
  );

  map.addSource('lines', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'lines-glow',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 18],
      'line-blur': 8,
      'line-opacity': 0.35,
    },
  });
  map.addLayer({
    id: 'lines',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 5],
    },
  });

  map.addSource('stations', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 5],
      'circle-color': '#0d1117',
      'circle-stroke-color': '#e6edf3',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 2],
    },
  });
  map.addLayer({
    id: 'station-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#c9d1d9', 'text-halo-color': '#0d1117', 'text-halo-width': 1.5 },
  });

  map.addImage('vehicle', vehicleIcon(), { sdf: true, pixelRatio: 2 });
  map.addSource('vehicles', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'vehicle-selected',
    type: 'circle',
    source: 'vehicles',
    filter: ['==', ['get', 'selected'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 22],
      'circle-color': 'transparent',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'vehicles',
    type: 'symbol',
    source: 'vehicles',
    layout: {
      'icon-image': 'vehicle',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 1.1],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': '#ffffff',
      'icon-halo-width': 1.25,
    },
  });

  map.on('click', 'vehicles', (e) => {
    const f = e.features?.[0] as MapGeoJSONFeature | undefined;
    if (f) select(String(f.properties.id));
  });
  map.on('click', (e) => {
    if (!map.queryRenderedFeatures(e.point, { layers: ['vehicles'] }).length) select(null);
  });
  map.on('mouseenter', 'vehicles', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'vehicles', () => (map.getCanvas().style.cursor = ''));
  // Dragging the map hands the camera back to the person.
  map.on('dragstart', () => setFollowing(false));
}

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function source(id: string) {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function drawLines() {
  source('lines')?.setData({
    type: 'FeatureCollection',
    features: lines
      .filter((l) => !hidden.has(groupOf(l.id)))
      .flatMap((l) =>
        l.paths.map((coordinates) => ({
          type: 'Feature' as const,
          properties: { color: l.color },
          geometry: { type: 'LineString' as const, coordinates },
        })),
      ),
  });
}

// ---------------------------------------------------------------------------
// Vehicles: poll, then glide each one to its new position over one poll
// interval so the trains move continuously instead of hopping.

async function poll() {
  if (document.hidden || Date.now() < pausedUntil) return;
  try {
    const vehicles = await loadVehicles();
    const now = performance.now();
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      const to: [number, number] = [v.lng, v.lat];
      const a = fleet.get(v.id);
      if (a) {
        a.from = a.shown;
        a.to = to;
        a.start = now;
        a.vehicle = v;
      } else {
        fleet.set(v.id, { vehicle: v, from: to, to, start: now, shown: to });
      }
    }
    for (const id of fleet.keys()) if (!seen.has(id)) fleet.delete(id);
    if (selectedId && !fleet.has(selectedId)) select(null);
    lastUpdate = Date.now();
    setStatus(null);
    renderLegend();
    if (selectedId) renderPanel();
  } catch (err) {
    if (err instanceof RateLimited) {
      pausedUntil = err.retryAt;
      setStatus('MBTA rate limit reached, pausing for a moment');
    } else {
      console.error(err);
      setStatus('Can’t reach the MBTA right now, retrying');
    }
  }
}

function frame() {
  const now = performance.now();
  const features: GeoJSON.Feature[] = [];
  for (const a of fleet.values()) {
    const t = Math.min(1, (now - a.start) / POLL_MS);
    a.shown = [a.from[0] + (a.to[0] - a.from[0]) * t, a.from[1] + (a.to[1] - a.from[1]) * t];
    const v = a.vehicle;
    if (hidden.has(groupOf(v.routeId))) continue;
    features.push({
      type: 'Feature',
      properties: {
        id: v.id,
        color: lineById.get(v.routeId)?.color ?? '#ffffff',
        bearing: v.bearing,
        selected: v.id === selectedId,
      },
      geometry: { type: 'Point', coordinates: a.shown },
    });
  }
  source('vehicles')?.setData({ type: 'FeatureCollection', features });

  // Track the followed train, but let the fly-in to it finish first.
  if (following && selectedId && !map.isEasing()) {
    const a = fleet.get(selectedId);
    if (a) map.setCenter(a.shown);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// UI

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const legendEl = $('#legend');
const statusEl = $('#status');
const panelEl = $('#panel');
let statusMessage: string | null = null;

function setStatus(message: string | null) {
  statusMessage = message;
  renderStatus();
}

function renderStatus() {
  if (statusMessage) {
    statusEl.textContent = statusMessage;
    statusEl.classList.add('warn');
    return;
  }
  statusEl.classList.remove('warn');
  if (!lastUpdate) {
    statusEl.textContent = 'Connecting…';
    return;
  }
  const secs = Math.round((Date.now() - lastUpdate) / 1000);
  statusEl.textContent = `${fleet.size} trains live · updated ${secs < 2 ? 'just now' : `${secs}s ago`}`;
}

function renderLegend() {
  const counts = new Map<string, number>();
  for (const a of fleet.values()) {
    const g = groupOf(a.vehicle.routeId);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  legendEl.innerHTML = GROUPS.map((g) => {
    const color = lineById.get(g.routes[0])?.color ?? '#888';
    const off = hidden.has(g.id);
    return `<button class="line${off ? ' off' : ''}" data-group="${g.id}" aria-pressed="${!off}">
      <span class="swatch" style="background:${color}"></span>
      <span class="name">${g.label}</span>
      <span class="count">${counts.get(g.id) ?? 0}</span>
    </button>`;
  }).join('');
}

legendEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-group]');
  if (!btn) return;
  const g = btn.dataset.group!;
  if (hidden.has(g)) hidden.delete(g);
  else hidden.add(g);
  drawLines();
  renderLegend();
});

// Selected train ---------------------------------------------------------------

let upcoming: UpcomingStop[] | null = null;
let predictionsTimer: number | undefined;

function select(id: string | null) {
  if (id === selectedId) return;
  selectedId = id;
  upcoming = null;
  clearInterval(predictionsTimer);
  setFollowing(false);
  history.replaceState(null, '', id ? `#train=${encodeURIComponent(id)}` : location.pathname);
  if (!id) {
    panelEl.hidden = true;
    updatePadding();
    return;
  }
  panelEl.hidden = false;
  renderPanel();
  updatePadding();
  refreshPredictions();
  predictionsTimer = window.setInterval(refreshPredictions, PREDICTIONS_MS);
}

async function refreshPredictions() {
  const tripId = selectedId && fleet.get(selectedId)?.vehicle.tripId;
  if (!tripId || document.hidden) return;
  try {
    const stops = await loadUpcomingStops(tripId);
    if (fleet.get(selectedId!)?.vehicle.tripId === tripId) {
      upcoming = stops;
      renderPanel();
    }
  } catch (err) {
    if (err instanceof RateLimited) pausedUntil = err.retryAt;
    else console.error(err);
  }
}

function setFollowing(on: boolean) {
  following = on;
  $('#follow')?.setAttribute('aria-pressed', String(on));
  if (on && selectedId) {
    const a = fleet.get(selectedId);
    if (a) map.easeTo({ center: a.shown, zoom: Math.max(map.getZoom(), 15), pitch: 60, duration: 1200 });
  }
}

/** Keeps the map's center clear of the panel, so a followed train stays in view. */
function updatePadding() {
  const phone = matchMedia('(max-width: 640px)').matches;
  const open = !panelEl.hidden;
  const right = open && !phone ? panelEl.offsetWidth + 16 : 0;
  const bottom = open && phone ? panelEl.offsetHeight + 36 : 0;
  const now = map.getPadding();
  if (now.right === right && now.bottom === bottom) return;
  // Setting padding stops any camera animation, so wait for the fly-in to land.
  if (map.isEasing()) map.once('moveend', updatePadding);
  else map.setPadding({ top: 0, left: 0, right, bottom });
}

function minutesUntil(at: number) {
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return `${mins} min`;
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderPanel() {
  const a = selectedId ? fleet.get(selectedId) : undefined;
  if (!a) return;
  const v = a.vehicle;
  const line = lineById.get(v.routeId);
  const branch = v.routeId.startsWith('Green-') ? ` · ${v.routeId.slice(-1)} branch` : '';
  const destination = v.headsign ?? line?.destinations[v.directionId] ?? '';

  let stopsHtml = '<p class="muted">Loading arrival times…</p>';
  if (upcoming && upcoming.length === 0) stopsHtml = '<p class="muted">No arrival times for this train right now.</p>';
  else if (upcoming)
    stopsHtml = `<ol class="stops">${upcoming
      .slice(0, 6)
      .map((s) => `<li><span>${escape(s.name)}</span><time>${minutesUntil(s.at)}</time></li>`)
      .join('')}</ol>`;

  panelEl.style.setProperty('--line', line?.color ?? '#888');
  panelEl.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">${escape(line?.name ?? v.routeId)}${branch}</p>
        <h2>to ${escape(destination)}</h2>
      </div>
      <button class="close" aria-label="Close">×</button>
    </header>
    <p class="now">${STATUS_TEXT[v.status] ?? ''} <strong>${escape(v.stopName ?? '…')}</strong></p>
    <p class="muted">Train ${escape(v.label)}${v.carriages ? ` · ${v.carriages} cars` : ''}</p>
    <h3>Next stops</h3>
    ${stopsHtml}
    <button id="follow" class="follow" aria-pressed="${following}">Follow this train</button>
  `;
  panelEl.querySelector('.close')!.addEventListener('click', () => select(null));
  panelEl.querySelector('#follow')!.addEventListener('click', () => setFollowing(!following));
  if (matchMedia('(max-width: 640px)').matches) updatePadding();
}

// ---------------------------------------------------------------------------
// Start

map.on('load', async () => {
  addLayers();
  requestAnimationFrame(frame);
  // Compact credits open themselves on load; on a phone, start them folded
  // into the ⓘ button so they don't cover the map.
  if (matchMedia('(max-width: 640px)').matches)
    document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  if (!location.hash) map.easeTo({ pitch: 50, bearing: -18, duration: 2500 });

  try {
    const [loadedLines, stations] = await Promise.all([loadLines(), loadStations()]);
    lines = loadedLines;
    for (const l of lines) lineById.set(l.id, l);
    drawLines();
    source('stations')?.setData({
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature',
        properties: { name: s.name },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  } catch (err) {
    console.error(err);
    setStatus('Couldn’t load the T map, retrying shortly');
  }

  renderLegend();
  await poll();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('train');
  if (fromHash && fleet.has(fromHash)) {
    select(fromHash);
    setFollowing(true);
  }
  setInterval(poll, POLL_MS);
  setInterval(renderStatus, 1000);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastUpdate > POLL_MS) poll();
});
