'use strict';

// ── Shades custom Mapbox GL style ─────────────────────────────────────────────
// Returns a complete style JSON object for mapboxgl.Map({ style: ... }).
// Using a custom style (rather than the Standard basemap URL) gives us full
// color control while still supporting map.setLights() for directional sun
// shadows and map.setFog() for depth.
//
// Building grow animation: fill-extrusion-height interpolates from 0→actual
// between zoom 15 and 15.05 — buildings visually rise as you zoom in.
//
// DO NOT set fill-extrusion-ambient-occlusion-* here — those are
// Standard-pipeline-only properties and will cause style validation failure.

function buildShadeStyle() {
  return {
    version: 8,
    name: 'Shades',
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}',
    sources: {
      composite: {
        type: 'vector',
        url: 'mapbox://mapbox.mapbox-streets-v8',
      },
    },
    layers: [

      // ── Background ─────────────────────────────────────────────────────────
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#B8AFA3' },
      },

      // ── Water ──────────────────────────────────────────────────────────────
      {
        id: 'water',
        type: 'fill',
        source: 'composite',
        'source-layer': 'water',
        paint: { 'fill-color': '#9CBDE7', 'fill-opacity': 0.55 },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'composite',
        'source-layer': 'waterway',
        paint: {
          'line-color': '#9CBDE7',
          'line-opacity': 0.45,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 2],
        },
      },

      // ── Landuse ────────────────────────────────────────────────────────────
      {
        id: 'landuse-green',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['match', ['get', 'class'],
          ['park', 'national_park', 'nature_reserve', 'grass', 'pitch', 'golf_course'], true, false],
        paint: { 'fill-color': '#9EA890' },
      },
      {
        id: 'landuse-wood',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['match', ['get', 'class'], ['wood', 'forest', 'scrub'], true, false],
        paint: { 'fill-color': '#96A088' },
      },
      {
        id: 'landuse-other',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['match', ['get', 'class'],
          ['cemetery', 'sand', 'rock', 'snow', 'farmland'], true, false],
        paint: { 'fill-color': '#AEA79C' },
      },
      {
        id: 'landuse-pedestrian',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['match', ['get', 'class'], ['pedestrian', 'plaza'], true, false],
        paint: { 'fill-color': '#C8BFB3' },
      },

      // ── Roads ──────────────────────────────────────────────────────────────
      {
        id: 'road-motorway',
        type: 'line',
        source: 'composite',
        'source-layer': 'road',
        filter: ['match', ['get', 'class'], ['motorway', 'trunk'], true, false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#7A726A',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 7],
        },
      },
      {
        id: 'road-primary',
        type: 'line',
        source: 'composite',
        'source-layer': 'road',
        filter: ['==', ['get', 'class'], 'primary'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#82796E',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 5],
        },
      },
      {
        id: 'road-secondary',
        type: 'line',
        source: 'composite',
        'source-layer': 'road',
        filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#8A8278',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 4],
        },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'composite',
        'source-layer': 'road',
        filter: ['match', ['get', 'class'],
          ['street', 'street_limited', 'service', 'track', 'path',
           'pedestrian', 'steps', 'cycleway',
           'motorway_link', 'trunk_link', 'primary_link',
           'secondary_link', 'tertiary_link'], true, false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#9A9288',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 2.5],
        },
      },

      // ── Buildings — 3D extrusion with grow animation ────────────────────────
      // minzoom: 15 prevents flat footprint rendering below the grow range.
      // fill-extrusion-height interpolates 0→actual-height over a full zoom
      // level (15→16) so tall landmarks rise smoothly instead of popping.
      // Opacity also fades in over the same range to avoid abrupt appearance.
      {
        id: 'building',
        type: 'fill-extrusion',
        source: 'composite',
        'source-layer': 'building',
        minzoom: 15,
        filter: ['==', ['get', 'extrude'], 'true'],
        paint: {
          'fill-extrusion-color': '#F0E8DA',
          'fill-extrusion-height': [
            'interpolate', ['linear'], ['zoom'],
            15, 0,
            16, ['get', 'height'],
          ],
          'fill-extrusion-base': [
            'interpolate', ['linear'], ['zoom'],
            15, 0,
            16, ['coalesce', ['get', 'min_height'], 0],
          ],
          'fill-extrusion-opacity': [
            'interpolate', ['linear'], ['zoom'],
            15, 0,
            15.5, 1,
          ],
        },
      },

      // ── Place labels — subdued, no road/POI labels ──────────────────────────
      {
        id: 'place-label',
        type: 'symbol',
        source: 'composite',
        'source-layer': 'place_label',
        filter: ['match', ['get', 'type'],
          ['city', 'town', 'village', 'suburb', 'neighbourhood'], true, false],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 15],
          'text-max-width': 8,
          'symbol-sort-key': ['get', 'symbolrank'],
          'icon-image': '',
        },
        paint: {
          'text-color': '#7A7268',
          'text-opacity': 0.55,
          'text-halo-color': '#B8AFA3',
          'text-halo-width': 1.5,
        },
      },

    ],
  };
}
