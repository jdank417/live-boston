import type { FilterSpecification, StyleSpecification } from 'maplibre-gl';

// A deliberately quiet basemap: the city as a dark, low-contrast backdrop so
// the transit network is the brightest thing on screen. No street names, POIs,
// one-way arrows or OSM railways; just water, parks, roads, buildings, and a
// few place names. Built on OpenFreeMap's OpenMapTiles vector tiles.

export const PALETTE = {
  background: '#0a0c10',
  water: '#0b1521',
  park: '#0c1310',
  airport: '#0d1015',
  runway: '#13171e',
  motorway: '#1b2029',
  primary: '#171b23',
  secondary: '#14171e',
  minor: '#111419',
  building: '#0f1217',
  label: '#4c5460',
  neighborhood: '#3e4652',
  waterLabel: '#2c4766',
};

const roads = (classes: string[]): FilterSpecification => [
  'all',
  ['in', ['get', 'class'], ['literal', classes]],
  ['!=', ['get', 'brunnel'], 'tunnel'],
];

export function basemap(): StyleSpecification {
  const p = PALETTE;
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'park',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        minzoom: 9,
        paint: { 'fill-color': p.park },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': p.water },
      },
      {
        id: 'airport',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        filter: ['==', ['geometry-type'], 'Polygon'],
        minzoom: 11,
        paint: { 'fill-color': p.airport },
      },
      {
        id: 'runway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['in', ['get', 'class'], ['literal', ['runway', 'taxiway']]]],
        minzoom: 11,
        paint: {
          'line-color': p.runway,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1, 16, ['match', ['get', 'class'], 'runway', 30, 6]],
        },
      },
      {
        id: 'building-2d',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13.5,
        // Fades into the 3D buildings as they rise.
        paint: { 'fill-color': p.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 1] },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roads(['minor', 'service']),
        minzoom: 13.5,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.minor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13.5, 0.5, 18, 10],
        },
      },
      {
        id: 'road-secondary',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roads(['secondary', 'tertiary']),
        minzoom: 11,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.secondary,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.5, 18, 14],
        },
      },
      {
        id: 'road-primary',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roads(['primary', 'trunk']),
        minzoom: 9,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.primary,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 0.5, 18, 18],
        },
      },
      {
        id: 'road-motorway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roads(['motorway']),
        minzoom: 7,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.motorway,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 7, 0.6, 18, 22],
        },
      },
      // Harbor and pond names sit at a point; river names run along the river.
      ...(['Point', 'LineString'] as const).map((geom) => ({
        id: geom === 'Point' ? 'water-name' : 'water-name-line',
        type: 'symbol' as const,
        source: 'openmaptiles',
        'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], geom] as FilterSpecification,
        minzoom: 11,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']] as any,
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-letter-spacing': 0.08,
          'symbol-placement': geom === 'Point' ? ('point' as const) : ('line' as const),
        },
        paint: { 'text-color': p.waterLabel },
      })),
      {
        id: 'neighborhood',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
        minzoom: 13.5,
        maxzoom: 16,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': 10,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.14,
          'text-max-width': 8,
        },
        paint: { 'text-color': p.neighborhood, 'text-halo-color': p.background, 'text-halo-width': 1 },
      },
      {
        id: 'town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        minzoom: 8,
        maxzoom: 13,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['match', ['get', 'class'], 'city', 13, 11],
          'text-letter-spacing': 0.04,
        },
        paint: { 'text-color': p.label, 'text-halo-color': p.background, 'text-halo-width': 1.2 },
      },
    ],
  };
}
